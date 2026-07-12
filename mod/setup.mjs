// Auto Sailing
// Automates the Sailing mod's trade loop: collect loot the moment a ship returns,
// re-dispatch it immediately, and (optionally) keep it pointed at the best port.
//
// Hooks the real Sailing structures (confirmed at runtime, see probes/probe1.js):
//   game.sailing                  -> the Sailing skill instance
//   game.sailing.ships            -> NamespaceRegistry<Ship>, one per Dock
//   Ship.state                    -> 0 ReadyToSail | 1 OnTrip | 2 HasReturned
//   Ship.lockState                -> 0 Locked | 1 Unlocked   (has a public setter)
//   Ship.selectedPort             -> plain settable property; the port picker is cosmetic
//   Ship.setSail() / collectLoot(cb) / upgrade() / getUpgradeCosts() / getNextUpgrade()
//   Ship.registerOnUpdate(fn)     -> fires on every ship state change; our event hook
//   Ship.dock.getUnlockCosts()
//   Ship.sailTimer                -> Timer, ticked by Sailing.passiveTick(); Melvor runs that
//                                    same tick loop over offline time (see catch-up, below)
//
// Two things the Sailing mod does NOT do for us, so we do them here:
//   * setSail(), upgrade() and the lockState setter have NO guards — they neither check
//     levels nor consume costs. The validated flows live only inside the UI component
//     closures, so tryBuyShip()/tryUpgrade() below replicate them exactly.
//   * collectLoot() grants nothing directly: it opens a Swal modal and commits the rewards
//     in that modal's didDestroy. So we let it run and close the modal for you, which puts
//     the rewards through the game's own code path rather than reimplementing them.

const VERSION = "0.2.0";
const TAG = `[Auto Sailing v${VERSION}]`;
const MARK = "auto-sailing";

const STATE = { READY: 0, ON_TRIP: 1, RETURNED: 2 };
const LOCK = { LOCKED: 0, UNLOCKED: 1 };

// The literal string #sailing-loot-template renders. Used to tell the loot modal apart
// from every other Swal (level-ups, pet drops, real confirmations) so we never eat one.
const LOOT_SIGNATURE = "Sailing Skill XP";

const STORAGE_KEY = "settings";
const STORAGE_LIMIT = 8192; // Melvor's per-mod character-storage cap
const BACKSTOP_MS = 5_000;
const DISMISS_POLL_MS = 200;

// Offline catch-up. The game refuses to process an absence shorter than a minute or longer
// than a day (Game.MIN_OFFLINE_TIME / MAX_OFFLINE_TIME), and we hold to the same window.
const MIN_CATCHUP_MS = 60_000;
const DEFAULT_MAX_OFFLINE_MS = 86_400_000;
// A day at the shortest possible trip can't come near this. It's here so that a nonsense
// interval (a modifier bug, a port with interval 0 slipping through) can't spin forever.
const CATCHUP_MAX_VOYAGES = 500;
const CATCHUP_CAP_CHOICES = [1, 2, 4, 8, 12, 24];

const STRATEGIES = {
  manual: "Manual (leave port alone)",
  levelup: "Level up (highest port)",
  xprate: "Best XP rate",
  safe: "Safe (no pirate risk)",
  pinned: "Pinned port",
};

const DEFAULTS = {
  enabled: false,
  autoSail: true,
  autoCollect: true,
  autoUpgrade: false,
  autoBuy: false,
  offlineCatchup: false,
  offlineCapHours: 24,
  strategy: "manual",
  ships: {}, // localID -> { enabled, strategy: "inherit"|<mode>, pinnedPort: <port id|null> }

  savedAt: 0, // stamped on every write; the only honest proof a write survived a reload
};

let settings = structuredClone(DEFAULTS);
let storage = null; // ctx.characterStorage
let settingsLoaded = false;
let lastStatus = "idle";

// Ships mid-collect: added before we call collectLoot(), removed when its callback fires
// (i.e. once the modal is destroyed and the rewards are banked). It does double duty —
// it stops a backstop tick from firing a second collect on the same ship, and it arms the
// modal dismisser. A non-empty set means "a loot modal we asked for is on its way", so a
// loot modal you opened yourself is left for you to click.
const busy = new Set();

// ---------------------------------------------------------------------------
// Globals
//
// Melvor's `game`/`Swal` are lexically scoped inside its bundle, so they are NOT on
// globalThis. Reach them by bare name behind a typeof guard (same trick as
// requirement-filler), falling back to globalThis.
// ---------------------------------------------------------------------------

function getGame() {
  if (globalThis.game) return globalThis.game;
  if (typeof game !== "undefined" && game) return game;
  return undefined;
}

function getSailing() {
  return getGame()?.sailing;
}

function getSwal() {
  if (typeof Swal !== "undefined" && Swal) return Swal;
  return globalThis.Swal;
}

function ticksPerSecond() {
  if (typeof TICKS_PER_SECOND !== "undefined" && TICKS_PER_SECOND) return TICKS_PER_SECOND;
  return 20;
}

const log = (...args) => console.log(TAG, ...args);
const warn = (...args) => console.warn(TAG, ...args);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  if (!storage) {
    warn("no characterStorage; settings will not persist this session");
    return;
  }
  try {
    let saved = storage.getItem(STORAGE_KEY);
    // Tolerate a JSON string as well as an object — spreading a string would otherwise
    // silently produce a garbage object with numeric keys and leave every real setting
    // sitting at its default, which looks exactly like "settings didn't save".
    if (typeof saved === "string") saved = JSON.parse(saved);
    if (!saved || typeof saved !== "object") {
      log("no saved settings for this character; using defaults");
      settingsLoaded = true;
      return;
    }
    settings = { ...structuredClone(DEFAULTS), ...saved, ships: saved.ships ?? {} };
    settingsLoaded = true;

    // The one thing that actually proves persistence works: settings we wrote in an earlier
    // session came back. A canary round-trip can't tell you this — the store can work in memory
    // and still be dropped when the character save is written, which is exactly what happens to
    // a local mod that isn't linked to mod.io.
    const age = settings.savedAt ? Math.round((Date.now() - settings.savedAt) / 1000) : null;
    log(age === null ? "settings loaded" : `settings loaded (saved ${age}s ago)`, settings);
  } catch (err) {
    warn("could not load settings, using defaults", err);
  }
}

function saveSettings() {
  if (!storage) {
    warn("cannot save settings: no characterStorage (is a character loaded?)");
    return;
  }
  try {
    // Stamped so the next load can prove the write survived. See loadSettings().
    settings.savedAt = Date.now();

    // Round-trip through JSON so we can never hand characterStorage something
    // unserialisable, and so what we store is exactly what we'll read back.
    const payload = JSON.parse(JSON.stringify(settings));

    // Melvor gives each mod 8kb of character storage. Going over doesn't throw — it just
    // doesn't save — so check before writing rather than wondering later.
    const size = JSON.stringify(payload).length;
    if (size > STORAGE_LIMIT) {
      warn(`settings are ${size} bytes, over Melvor's ${STORAGE_LIMIT}-byte per-mod limit — not saved.`);
      return;
    }

    storage.setItem(STORAGE_KEY, payload);

    // characterStorage is only written into the save file when the game next saves. Without
    // this, changing a setting and then reloading (or closing the tab) before the next
    // autosave loses it — which is the whole "my settings don't persist" symptom.
    getGame()?.scheduleSave?.();
  } catch (err) {
    warn("could not save settings", err);
  }
}

// Melvor's wiki, on both Mod Settings and character storage:
//
//   "When loading your mod as a Local Mod via the Creator Toolkit, the mod must be linked to
//    mod.io and you must have subscribed to and installed the mod via mod.io in order for this
//    data to persist."
//
// So a local mod that isn't linked to mod.io silently saves nothing, which looks exactly like a
// bug in here. Round-trip a canary and say so plainly instead of leaving you to guess.
function checkStorage() {
  if (!storage?.setItem) {
    warn("characterStorage is unavailable — settings cannot be saved this session.");
    return false;
  }
  try {
    const canary = `canary-${Date.now()}`;
    storage.setItem("storage-check", canary);
    const readBack = storage.getItem("storage-check");
    storage.removeItem?.("storage-check");

    if (readBack !== canary) {
      warn(
        "characterStorage did not read back what we wrote — settings will not persist. " +
          "If this is a local mod, Melvor requires it to be linked to mod.io and installed from " +
          "there before any mod data is saved.",
      );
      return false;
    }
    return true;
  } catch (err) {
    warn("characterStorage threw; settings will not persist", err);
    return false;
  }
}

function shipConfig(ship) {
  const key = ship.localID ?? ship.id;
  if (!settings.ships[key]) {
    settings.ships[key] = { enabled: true, strategy: "inherit", pinnedPort: null };
  }
  return settings.ships[key];
}

// The mode actually in force for a ship: its own, or the global one it inherits.
function effectiveStrategy(ship) {
  const own = shipConfig(ship).strategy;
  return !own || own === "inherit" ? settings.strategy : own;
}

// ---------------------------------------------------------------------------
// Port strategy
// ---------------------------------------------------------------------------

function candidatePorts(sailing) {
  return sailing.ports.allObjects.filter((port) => {
    try {
      return port.isUnlocked() && port.hasLevelRequirements();
    } catch {
      return false;
    }
  });
}

// Chance the trip is NOT intercepted by pirates. A failed trip halves the entire reward
// bundle (XP included), so expected value carries a factor of 0.5 + 0.5 * chance.
function successChance(sailing, ship, port) {
  const required = port.sailingStats?.combat ?? 0;
  if (required <= 0) return 1;
  return Math.min(1, sailing.getCombatModifier(ship.dock) / required);
}

function expectedXpRate(sailing, ship, port) {
  const xp = sailing.modifyXP(port.baseExperience, ship.dock);
  const interval = sailing.modifyInterval(port.interval, ship.dock);
  if (!(interval > 0)) return 0;
  return (xp * (0.5 + 0.5 * successChance(sailing, ship, port))) / interval;
}

function maxBy(list, score) {
  let best;
  let bestScore = -Infinity;
  for (const item of list) {
    const value = score(item);
    if (value > bestScore) {
      bestScore = value;
      best = item;
    }
  }
  return best;
}

// Returns the port this ship should sail to, or undefined to leave `selectedPort` alone.
function choosePort(sailing, ship) {
  const mode = effectiveStrategy(ship);
  if (mode === "manual") return undefined;

  if (mode === "pinned") {
    const id = shipConfig(ship).pinnedPort;
    if (!id) return undefined;
    const port = sailing.ports.getObjectByID(id);
    // A pinned port can become invalid (e.g. a fresh character that hasn't found the
    // Navigation Chart yet). Fall back to leaving the current port alone.
    if (!port) return undefined;
    try {
      if (!port.isUnlocked() || !port.hasLevelRequirements()) return undefined;
    } catch {
      return undefined;
    }
    return port;
  }

  const ports = candidatePorts(sailing);
  if (!ports.length) return undefined;

  switch (mode) {
    // XP per hour is linear in distance (interval = distance*60s, baseXP = distance^2/8),
    // so the furthest reachable port is always the fastest to level on.
    case "levelup":
      return maxBy(ports, (port) => port.distance);
    case "safe": {
      const safe = ports.filter((port) => successChance(sailing, ship, port) >= 1);
      return maxBy(safe.length ? safe : ports, (port) => port.distance);
    }
    case "xprate":
      return maxBy(ports, (port) => expectedXpRate(sailing, ship, port));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function setStatus(text) {
  lastStatus = text;
  log(text);
  updatePanel();
}

function queueTick(ship) {
  setTimeout(() => tickShip(ship), 0);
}

function tickShip(ship) {
  const sailing = getSailing();
  if (!sailing || !settings.enabled) return;
  if (!shipConfig(ship).enabled) return;
  if (busy.has(ship.id)) return;

  try {
    if (ship.lockState === LOCK.LOCKED) {
      if (settings.autoBuy) tryBuyShip(sailing, ship);
      return;
    }

    if (settings.autoUpgrade) tryUpgrade(sailing, ship);

    if (ship.state === STATE.RETURNED && settings.autoCollect) {
      collect(sailing, ship);
    } else if (ship.state === STATE.READY && settings.autoSail) {
      sail(sailing, ship);
    }
  } catch (err) {
    console.error(`${TAG} tick failed for ${ship.id}`, err);
  }
}

function tickAll() {
  const sailing = getSailing();
  if (!sailing) return;
  sailing.ships.forEach((ship) => tickShip(ship));
}

function collect(sailing, ship) {
  busy.add(ship.id);

  const portName = ship.selectedPort?.name ?? "the sea";

  try {
    // No timeout here, deliberately. collectLoot() rolls the loot immediately but only
    // banks it when the modal is destroyed, and modals are a *queue* — ours can sit behind
    // an offline-progress popup, a level-up, a pet drop, for as long as it takes you to
    // click them. If we released `busy` on a timer the ship would still read HasReturned,
    // so the next tick would collect again: a second loot roll, a second modal, and both
    // would eventually grant. Duplicate rewards are far worse than a ship that idles until
    // you reload, so the ship stays busy until the modal actually resolves.
    ship.collectLoot(() => {
      busy.delete(ship.id);
      setStatus(`Collected from ${portName}`);
      // collectLoot() flips the ship back to ReadyToSail and fires its update callbacks
      // BEFORE invoking this one — so that event saw us still busy and did nothing.
      // Re-tick explicitly, or the ship would sit in port until the backstop.
      queueTick(ship);
    });
  } catch (err) {
    busy.delete(ship.id);
    console.error(`${TAG} collectLoot failed for ${ship.id}`, err);
  }
}

function sail(sailing, ship) {
  const port = choosePort(sailing, ship);
  if (port && port !== ship.selectedPort) ship.selectedPort = port;
  if (!ship.selectedPort) return;

  // setSail() has no guards of its own — it will happily restart a running timer.
  if (ship.state !== STATE.READY || ship.lockState !== LOCK.UNLOCKED) return;

  ship.setSail();
  setStatus(`${ship.name} set sail for ${ship.selectedPort.name}`);
  sailing.page?.update?.();
}

// Mirrors the Sailing UI's own unlockShip(): level + affordability check, then consume.
// Ship.lockState's setter does none of this itself.
function tryBuyShip(sailing, ship) {
  const dock = ship.dock;
  if (!dock || sailing.level < dock.level) return;
  if ((dock.abyssalLevel ?? 0) > 0 && (sailing.abyssalLevel ?? 0) < dock.abyssalLevel) return;

  const costs = dock.getUnlockCosts?.();
  if (!costs) return;
  costs.setSource(`Skill.${sailing.id}.UnlockShip`);
  if (!costs.checkIfOwned()) return;

  costs.consumeCosts();
  ship.lockState = LOCK.UNLOCKED;
  sailing.page?.update?.();
  setStatus(`Bought ${ship.name}`);
}

// Mirrors the Sailing UI's own upgradeShip(). Ship.upgrade() checks nothing and pays nothing.
function tryUpgrade(sailing, ship) {
  const next = ship.getNextUpgrade?.();
  if (!next || sailing.level < next.level) return;

  const costs = ship.getUpgradeCosts?.();
  if (!costs) return;
  costs.setSource(`Skill.${sailing.id}.UpgradeShip`);
  if (!costs.checkIfOwned()) return;

  costs.consumeCosts();
  ship.upgrade(); // recomputes stats and refreshes the page itself
  setStatus(`Upgraded ${ship.name} to ${ship.currentUpgrade?.name ?? next.localID}`);
}

// ---------------------------------------------------------------------------
// Offline catch-up
//
// Sailing is a PassiveAction: its passiveTick() ticks every ship's sailTimer, and Melvor runs
// that same tick loop over the time you were away (Game.MIN/MAX_OFFLINE_TIME, i.e. a minute to
// a day). So a voyage that was in flight when you closed the game really does finish while
// you're gone — the ship just parks at HasReturned forever, because collecting and
// re-dispatching are clicks and nobody was here to click them.
//
// The clicks are therefore the only thing missing, and the only thing we replay. For every
// voyage that would have fitted in the away window we call the game's own collectLoot(), so the
// loot rolls, the pirate check, the XP, the mastery, the pets and the relics are all decided by
// Sailing's code. We invent no rewards; we supply the clicks that were owed.
//
// The one liberty taken: the ship replays every voyage from the port it sailed from. A strategy
// that would have re-pointed it mid-absence (say, after an offline level-up opened a better
// port) doesn't get to. That under-credits rather than over-credits, which is the right way to
// be wrong.
// ---------------------------------------------------------------------------

// Captured at character load, before the game's offline loop has run. Null when there's
// nothing to catch up, which is the common case and the safe one.
let pendingCatchUp = null;

function ticksToMs(ticks) {
  return (ticks / ticksPerSecond()) * 1000;
}

function maxOfflineMs() {
  return getGame()?.MAX_OFFLINE_TIME ?? DEFAULT_MAX_OFFLINE_MS;
}

// Timer.ticksLeft is a getter over _ticksLeft, so resuming a part-finished voyage means
// starting the timer and then writing the remainder behind it.
function setTimerRemaining(timer, ms) {
  if (!timer) return;
  const ticks = Math.max(1, Math.round((ms / 1000) * ticksPerSecond()));
  if ("_ticksLeft" in timer) timer._ticksLeft = ticks;
  else timer.ticksLeft = ticks;
}

function tripMs(sailing, ship) {
  const port = ship.selectedPort;
  if (!port) return 0;
  return sailing.modifyInterval(port.interval, ship.dock);
}

// A ship only catches up if the loop we're replaying is one it was actually running: it has to
// be bought, switched on, and both halves of the loop have to be enabled.
function catchUpEligible(ship) {
  if (ship.lockState !== LOCK.UNLOCKED) return false;
  if (!shipConfig(ship).enabled) return false;
  return settings.autoSail && settings.autoCollect;
}

// Runs at character load, BEFORE the game's offline loop. Two jobs: read the away time while
// game.tickTimestamp still holds the last tick of the previous session, and take the eligible
// ships' timers off the game's hands, so its offline ticks can't advance a voyage we're about
// to account for ourselves. Marking them busy stops the engine touching them in the meantime;
// runCatchUp() always hands them back.
function snapshotForCatchUp() {
  pendingCatchUp = null;
  if (!settings.enabled || !settings.offlineCatchup) return;

  const game = getGame();
  const sailing = game?.sailing;
  if (!sailing) return;

  const lastTick = game.tickTimestamp || game.previousTickTime || 0;
  if (!lastTick) return;

  const awayMs = Date.now() - lastTick;
  if (!(awayMs >= MIN_CATCHUP_MS)) return;

  const capMs = Math.min(maxOfflineMs(), Math.max(0, settings.offlineCapHours) * 3_600_000);
  const creditedMs = Math.min(awayMs, capMs);
  if (!(creditedMs >= MIN_CATCHUP_MS)) return;

  const ships = new Map();
  sailing.ships.forEach((ship) => {
    if (!catchUpEligible(ship)) return;
    ships.set(ship.id, { state: ship.state, ticksLeft: ship.sailTimer?.ticksLeft ?? 0 });
    busy.add(ship.id);
    ship.sailTimer?.stop?.();
  });
  if (!ships.size) return;

  pendingCatchUp = { awayMs, creditedMs, ships };
  log(
    `away for ${formatEta(awayMs)}, crediting ${formatEta(creditedMs)} to ${ships.size} ship(s)`,
  );
}

// How many voyages the ship would have finished, and where it should be standing when we're
// done. `pending` is loot the ship was already holding when you quit — it isn't part of the
// absence, but it does have to be collected before the ship can sail again.
function planCatchUp(sailing, ship, snap, awayMs) {
  const trip = tripMs(sailing, ship);
  if (!(trip > 0)) return null;

  const pending = snap.state === STATE.RETURNED ? 1 : 0;
  const atSeaMs = snap.state === STATE.ON_TRIP ? ticksToMs(snap.ticksLeft) : 0;

  // Didn't even finish the voyage it was on: no loot, just put it back where the game's own
  // offline ticks would have left it.
  if (awayMs < atSeaMs) {
    return { collects: pending, remainingMs: atSeaMs - awayMs };
  }

  const spare = awayMs - atSeaMs;
  const completed = (snap.state === STATE.ON_TRIP ? 1 : 0) + Math.floor(spare / trip);

  return {
    collects: Math.min(pending + completed, CATCHUP_MAX_VOYAGES),
    remainingMs: trip - (spare % trip),
  };
}

function collectOnce(ship) {
  return new Promise((resolve, reject) => {
    try {
      ship.collectLoot(resolve);
    } catch (err) {
      reject(err);
    }
  });
}

async function runCatchUp(sailing) {
  const snapshot = pendingCatchUp;
  pendingCatchUp = null;
  if (!snapshot) return;

  let collected = 0;

  for (const ship of sailing.ships.allObjects) {
    const snap = snapshot.ships.get(ship.id);
    if (!snap) continue;

    try {
      const plan = planCatchUp(sailing, ship, snap, snapshot.creditedMs);
      if (!plan) continue;

      for (let i = 0; i < plan.collects; i += 1) {
        // Strictly one at a time. Each collect opens a loot modal, the rewards are only
        // banked when it's destroyed, and Melvor opens modals one at a time anyway — so
        // firing them off in parallel would just pile up a queue and roll loot for a ship
        // whose previous roll hadn't landed yet. Awaiting each one also means our modals
        // sit politely behind the game's own offline-progress popup until you dismiss it.
        setStatus(`Catching up ${ship.name}: voyage ${i + 1} of ${plan.collects}`);
        await collectOnce(ship);
        collected += 1;
      }

      ship.setSail();
      setTimerRemaining(ship.sailTimer, plan.remainingMs);
    } catch (err) {
      console.error(`${TAG} offline catch-up failed for ${ship.id}`, err);
    } finally {
      busy.delete(ship.id);
      // Whatever happened above, the ship must not be left at sea holding the timer we
      // stopped — that's a voyage that can never end. Start it over rather than strand it.
      if (ship.state === STATE.ON_TRIP && ship.sailTimer?.isActive === false) ship.setSail();
      queueTick(ship);
    }
  }

  sailing.page?.update?.();
  setStatus(
    collected
      ? `Offline catch-up: ${collected} voyage${collected === 1 ? "" : "s"} over ${formatEta(snapshot.creditedMs)}`
      : "idle",
  );
}

// ---------------------------------------------------------------------------
// Loot-modal dismisser
//
// generateLoot() commits rewards in the modal's didDestroy, not in its confirm handler,
// so closing the modal is enough to bank everything through the game's own path.
// ---------------------------------------------------------------------------

function tryDismissLootModal() {
  if (busy.size === 0) return; // no collect of ours is in flight — every popup is yours

  const swal = getSwal();
  if (!swal?.isVisible?.()) return;

  const popup = swal.getPopup?.();
  if (!popup?.textContent?.includes(LOOT_SIGNATURE)) return; // not a loot modal — leave it

  // Closing it is what banks the loot: generateLoot() commits rewards in didDestroy.
  swal.clickConfirm();
}

function installModalDismisser() {
  try {
    new MutationObserver(tryDismissLootModal).observe(document.body, { childList: true });
  } catch (err) {
    warn("could not observe modals; falling back to polling only", err);
  }
  setInterval(tryDismissLootModal, DISMISS_POLL_MS);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let panelEl = null;
const shipRows = new Map(); // localID -> { state, port, eta, enable, mode, pin }

function formatEta(ms) {
  if (!(ms > 0)) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function shipEtaMs(ship) {
  const ticks = ship.sailTimer?.ticksLeft ?? 0;
  return ticks > 0 ? (ticks / ticksPerSecond()) * 1000 : 0;
}

function stateLabel(ship) {
  if (ship.lockState === LOCK.LOCKED) return "Locked";
  switch (ship.state) {
    case STATE.ON_TRIP:
      return "On a trip";
    case STATE.RETURNED:
      return "Returned";
    default:
      return "Ready";
  }
}

function injectStyles() {
  if (document.getElementById(`${MARK}-styles`)) return;
  const style = document.createElement("style");
  style.id = `${MARK}-styles`;
  style.textContent = `
    .${MARK}-panel { margin-bottom: 1rem; }
    .${MARK}-opts { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; }
    .${MARK}-opts label { margin: 0; font-weight: 400; cursor: pointer; }
    .${MARK}-table { width: 100%; margin-top: .75rem; }
    .${MARK}-table th, .${MARK}-table td { padding: .35rem .5rem; vertical-align: middle; }
    .${MARK}-table select { max-width: 14rem; }
    .${MARK}-status { margin-top: .5rem; font-size: .875rem; opacity: .75; }
    .${MARK}-cost { opacity: .6; font-size: .8em; }
  `;
  document.head.append(style);
}

function checkbox(key, label, hint) {
  const wrap = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(settings[key]);
  input.addEventListener("change", () => {
    settings[key] = input.checked;
    saveSettings();
    tickAll();
    updatePanel();
  });
  wrap.append(input, document.createTextNode(` ${label}`));
  if (hint) {
    const small = document.createElement("span");
    small.className = `${MARK}-cost`;
    small.textContent = ` ${hint}`;
    wrap.append(small);
  }
  return wrap;
}

// How much of an absence catch-up is allowed to credit. The game itself never credits more
// than a day, so neither can we, whatever this says.
function capSelect() {
  const wrap = document.createElement("label");
  wrap.textContent = "Catch-up at most: ";
  const select = document.createElement("select");
  select.className = "form-control form-control-sm";
  for (const hours of CATCHUP_CAP_CHOICES) {
    const option = document.createElement("option");
    option.value = String(hours);
    option.textContent = hours === 1 ? "1 hour" : `${hours} hours`;
    select.append(option);
  }
  select.value = String(settings.offlineCapHours);
  select.addEventListener("change", () => {
    settings.offlineCapHours = Number(select.value);
    saveSettings();
    updatePanel();
  });
  wrap.append(select);
  return wrap;
}

function strategySelect(value, { includeInherit } = {}) {
  const select = document.createElement("select");
  select.className = "form-control form-control-sm";
  if (includeInherit) {
    const option = document.createElement("option");
    option.value = "inherit";
    option.textContent = "Use global";
    select.append(option);
  }
  for (const [key, label] of Object.entries(STRATEGIES)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  return select;
}

function buildPanel(sailing) {
  const panel = document.createElement("div");
  panel.className = `block block-rounded ${MARK}-panel`;

  const header = document.createElement("div");
  header.className = "block-header block-header-default";
  const title = document.createElement("h3");
  title.className = "block-title";
  title.textContent = "Auto Sailing";
  const master = checkbox("enabled", "Automation enabled");
  header.append(title, master);

  const content = document.createElement("div");
  content.className = "block-content";

  const opts = document.createElement("div");
  opts.className = `${MARK}-opts`;
  opts.append(
    checkbox("autoSail", "Auto set sail"),
    checkbox("autoCollect", "Auto collect loot"),
    checkbox("autoUpgrade", "Auto upgrade tier", "(spends up to 100M GP + materials)"),
    checkbox("autoBuy", "Auto buy ships", "(spends up to 50M GP)"),
    checkbox("offlineCatchup", "Offline catch-up", "(replays voyages missed while closed)"),
    capSelect(),
  );

  const strategyWrap = document.createElement("label");
  strategyWrap.textContent = "Port strategy: ";
  const strategy = strategySelect(settings.strategy);
  strategy.addEventListener("change", () => {
    settings.strategy = strategy.value;
    saveSettings();
    tickAll();
    updatePanel();
  });
  strategyWrap.append(strategy);
  opts.append(strategyWrap);

  const table = document.createElement("table");
  table.className = `table table-sm ${MARK}-table`;
  table.innerHTML = `<thead><tr>
    <th>On</th><th>Ship</th><th>Status</th><th>Port</th><th>Returns in</th><th>Strategy</th><th>Pinned port</th>
  </tr></thead>`;
  const body = document.createElement("tbody");
  table.append(body);

  sailing.ships.forEach((ship) => body.append(buildShipRow(sailing, ship)));

  const status = document.createElement("div");
  status.className = `${MARK}-status`;

  content.append(opts, table, status);
  panel.append(header, content);
  panel.__status = status;
  return panel;
}

function buildShipRow(sailing, ship) {
  const cfg = shipConfig(ship);
  const row = document.createElement("tr");

  const enableCell = document.createElement("td");
  const enable = document.createElement("input");
  enable.type = "checkbox";
  enable.checked = cfg.enabled;
  enable.addEventListener("change", () => {
    cfg.enabled = enable.checked;
    saveSettings();
    tickShip(ship);
    updatePanel();
  });
  enableCell.append(enable);

  const nameCell = document.createElement("td");
  const stateCell = document.createElement("td");
  const portCell = document.createElement("td");
  const etaCell = document.createElement("td");

  const modeCell = document.createElement("td");
  const mode = strategySelect(cfg.strategy ?? "inherit", { includeInherit: true });
  mode.addEventListener("change", () => {
    cfg.strategy = mode.value;
    saveSettings();
    tickShip(ship);
    updatePanel();
  });
  modeCell.append(mode);

  const pinCell = document.createElement("td");
  const pin = document.createElement("select");
  pin.className = "form-control form-control-sm";
  pin.addEventListener("change", () => {
    cfg.pinnedPort = pin.value || null;
    saveSettings();
    tickShip(ship);
  });
  pinCell.append(pin);

  row.append(enableCell, nameCell, stateCell, portCell, etaCell, modeCell, pinCell);
  shipRows.set(ship.localID ?? ship.id, {
    ship,
    enable,
    name: nameCell,
    state: stateCell,
    port: portCell,
    eta: etaCell,
    mode,
    pin,
    pinOptions: "",
  });
  return row;
}

// Refreshes only the volatile cells, so it can run on a timer without clobbering a
// dropdown the user is interacting with.
function updatePanel() {
  if (!panelEl) return;
  const sailing = getSailing();
  if (!sailing) return;

  const candidates = candidatePorts(sailing);
  const optionsKey = candidates.map((port) => port.id).join(",");

  for (const row of shipRows.values()) {
    const { ship } = row;
    const cfg = shipConfig(ship);

    row.enable.checked = cfg.enabled;
    row.name.textContent = `${ship.name} (${ship.currentUpgrade?.localID ?? "?"})`;
    row.state.textContent = stateLabel(ship);
    row.port.textContent = ship.selectedPort?.name ?? "—";
    row.eta.textContent = ship.state === STATE.ON_TRIP ? formatEta(shipEtaMs(ship)) : "—";

    // Rebuild the pinned-port list only when the set of reachable ports actually changes.
    if (row.pinOptions !== optionsKey) {
      row.pin.replaceChildren();
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "—";
      row.pin.append(none);
      for (const port of candidates) {
        const option = document.createElement("option");
        option.value = port.id;
        option.textContent = port.name;
        row.pin.append(option);
      }
      row.pinOptions = optionsKey;
    }
    row.pin.value = cfg.pinnedPort ?? "";
    row.pin.disabled = effectiveStrategy(ship) !== "pinned";
  }

  if (panelEl.__status) {
    panelEl.__status.textContent = settings.enabled ? `Status: ${lastStatus}` : "Automation is off.";
  }
}

function mountPanel(sailing) {
  const container = document.getElementById("sailing-container");
  if (!container) {
    warn("#sailing-container not found; the panel will not be shown.");
    return;
  }
  panelEl = buildPanel(sailing);

  // Sit directly under the skill header (the level/XP bars), above the info alert and the
  // Trade/Ships/Ports tabs. Fall back to the top of the page if that block ever moves.
  const skillInfo = container.querySelector(".skill-info");
  if (skillInfo) skillInfo.after(panelEl);
  else container.prepend(panelEl);

  updatePanel();
  setInterval(updatePanel, 1000);
}

// ---------------------------------------------------------------------------
// There is deliberately NO ctx.settings section.
//
// There used to be a "Automation enabled" switch mirrored into the Mod Manager. That made
// `enabled` live in two places at once: ctx.settings, which the mod loader persists
// account-wide and restores on its own schedule, and characterStorage, which is per
// character. The loader's restore fires the switch's onChange, which wrote its value
// straight back over ours — so a per-character `enabled` could be clobbered by the
// account-level default and then saved on top. Settings appeared not to persist.
//
// characterStorage is now the single source of truth, and the panel on the Sailing page is
// the only UI. If a Mod Manager switch is wanted again, it must read/write the same store
// rather than keep its own copy.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export function setup(ctx) {
  // A fallback handle, so a mod reloaded into an already-running game (which never gets
  // onCharacterLoaded) can still save. The real one comes from the lifecycle hook below: the
  // wiki is explicit that character storage isn't available until a character has loaded, and
  // every hook is handed the context to read it from.
  storage = ctx.characterStorage ?? null;

  ctx.onCharacterLoaded((loadedCtx) => {
    storage = loadedCtx?.characterStorage ?? storage;
    loadSettings();
    checkStorage();

    // Must happen here, not in onInterfaceReady: game.tickTimestamp still holds the last tick
    // of the previous session, and the game's offline loop hasn't run yet.
    snapshotForCatchUp();

    updatePanel();
  });

  ctx.onInterfaceReady(() => {
    const sailing = getSailing();
    if (!sailing) {
      warn("game.sailing not found — is the Sailing mod installed and enabled? Doing nothing.");
      return;
    }

    // A mod reloaded into a running game misses onCharacterLoaded, so settings would still
    // be at their defaults here. Load them if that hook never ran.
    if (!settingsLoaded) {
      storage = ctx.characterStorage ?? storage;
      loadSettings();
      checkStorage();
    }

    injectStyles();
    installModalDismisser();

    // Console handle for debugging persistence: autoSailing.dump() / .save() / .reset()
    globalThis.autoSailing = {
      get settings() { return settings; },
      stored: () => storage?.getItem?.(STORAGE_KEY),
      save: () => saveSettings(),
      check: () => checkStorage(),
      dump() {
        console.log({
          live: settings,
          stored: this.stored(),
          hasStorage: !!storage,
          storageWorks: checkStorage(),
          bytes: JSON.stringify(settings).length,
        });
      },
      reset() { settings = structuredClone(DEFAULTS); saveSettings(); updatePanel(); },
    };

    // The Sailing mod fires these on every ship state change, including onReturn(), so the
    // engine is event-driven. A ship can already be HasReturned from offline progress
    // before we get here, hence the sweep below; the interval is only a backstop.
    sailing.ships.forEach((ship) => ship.registerOnUpdate(() => queueTick(ship)));

    mountPanel(sailing);
    tickAll();
    setInterval(tickAll, BACKSTOP_MS);

    // Ships with a catch-up pending are already marked busy, so the sweep above left them
    // alone. This replays what they missed and hands them back to the engine.
    runCatchUp(sailing);

    log(`Loaded. ${sailing.ships.size} ships, ${sailing.ports.size} ports.`);
  });
}
