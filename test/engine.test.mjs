// Drives the real mod/setup.mjs against a fake Sailing skill that mimics the mod's
// actual semantics (including the awkward ones: collectLoot resolves only when the Swal
// modal is destroyed, and it fires callBackCallbacks BEFORE its own callback).

const results = [];
const check = (name, pass, extra = "") =>
  results.push({ name, pass, extra });

// ---- minimal DOM ----------------------------------------------------------
const mkEl = () => ({
  className: "", id: "", textContent: "", innerHTML: "", type: "", checked: false,
  value: "", disabled: false, style: {}, children: [],
  append(...c) { this.children.push(...c); },
  prepend(...c) { this.children.unshift(...c); },
  replaceChildren() { this.children = []; },
  addEventListener() {},
});
globalThis.document = {
  head: mkEl(), body: mkEl(),
  getElementById: () => null, // no #sailing-container -> panel is skipped
  createElement: mkEl,
};
// Real Swal appends .swal2-container as a direct child of <body>, which trips the mod's
// MutationObserver. Model that: opening a modal notifies the observers on the next tick.
const observers = [];
globalThis.MutationObserver = class {
  constructor(cb) { observers.push(cb); }
  observe() {}
};
globalThis.TICKS_PER_SECOND = 20;

// ---- fake Swal + modal queue ----------------------------------------------
// Melvor really does queue modals (confirmed by dumping addModalToQueue at runtime):
//   function addModalToQueue(modal) { modalQueue.push(modal); if (!modalQueuePaused) openNextModal(); }
// So a loot modal can sit behind an offline-progress popup or a level-up for as long as it
// takes the player to click them. Model that, or the tests can't see the bug it causes.
let openModal = null;
const modalQueue = [];

const openNextModal = () => {
  if (openModal || !modalQueue.length) return;
  openModal = modalQueue.shift();
  setTimeout(() => observers.forEach((cb) => cb()), 0); // the "DOM changed" signal
};
const showModal = (modal) => {
  modalQueue.push(modal);
  openNextModal();
};
const closeModal = () => {
  const m = openModal;
  openModal = null;
  m.didDestroy(); // SweetAlert2 fires didDestroy on close, however it was closed
  openNextModal();
};
const dismissByHand = closeModal; // what the player clicking the popup does

globalThis.Swal = {
  isVisible: () => openModal !== null,
  getPopup: () => (openModal ? { textContent: openModal.text } : null),
  clickConfirm: closeModal,
};

// ---- fake Sailing ---------------------------------------------------------
const STATE = { READY: 0, ON_TRIP: 1, RETURNED: 2 };
const LOCK = { LOCKED: 0, UNLOCKED: 1 };

let gp = 0;
const mkCosts = (amount) => ({
  setSource() {},
  checkIfOwned: () => gp >= amount,
  consumeCosts() { gp -= amount; },
});

const mkPort = (id, distance, combat) => ({
  id: `sailing:${id}`, name: id, distance,
  interval: 60 * distance * 1000,
  baseExperience: (distance * distance) / 8,
  sailingStats: { combat },
  isUnlocked: () => true,
  hasLevelRequirements() { return sailing.level >= this._level; },
  _level: 1,
});

const ports = [
  mkPort("tinyIsland", 60, 100),
  mkPort("piratesCove", 360, 4000),
  mkPort("kingsLanding", 1320, 15000),
];

class Ship {
  constructor(localID, dockLevel, unlockCost) {
    this.localID = localID;
    this.id = `sailing:${localID}`;
    this.name = localID;
    this.state = STATE.READY;
    this.lockState = LOCK.LOCKED;
    this.selectedPort = ports[0];
    this.currentUpgrade = { localID: "Cutter", name: "Cutter", level: 1 };
    this.sailTimer = { ticksLeft: 0 };
    this.dock = { level: dockLevel, getUnlockCosts: () => mkCosts(unlockCost) };
    this.cbs = [];
    this.sailCount = 0;
  }
  registerOnUpdate(fn) { this.cbs.push(fn); }
  fire() { this.cbs.forEach((f) => f()); }
  setSail() {
    this.state = STATE.ON_TRIP;
    this.sailTimer.ticksLeft = 100;
    this.sailCount += 1;
    this.fire();
  }
  arrive() { this.state = STATE.RETURNED; this.sailTimer.ticksLeft = 0; this.fire(); }
  getNextUpgrade() {
    return this.currentUpgrade.localID === "Cutter"
      ? { localID: "Frigate", name: "Frigate", level: 40 } : undefined;
  }
  getUpgradeCosts() { return this.getNextUpgrade() ? mkCosts(1_000_000) : undefined; }
  upgrade() { this.currentUpgrade = this.getNextUpgrade(); }
  // Faithful to the real one: opens a modal, and only on destroy does it reset state,
  // fire callbacks, and THEN invoke the caller's callback.
  collectLoot(cb) {
    showModal({
      text: "1000 Sailing Skill XP ... loot ...",
      didDestroy: () => {
        this.state = STATE.READY;
        this.fire();
        cb();
      },
    });
  }
}

const registry = (arr) => ({
  allObjects: arr,
  size: arr.length,
  forEach: (f) => arr.forEach(f),
  getObjectByID: (id) => arr.find((o) => o.id === id),
});

const ship1 = new Ship("Dock1", 1, 100_000);
const ship2 = new Ship("Dock2", 30, 1_000_000);

const sailing = {
  id: "sailing:Sailing",
  level: 1,
  ships: registry([ship1, ship2]),
  ports: registry(ports),
  page: { update() {} },
  modifyXP: (xp) => xp,
  modifyInterval: (i) => i,
  getCombatModifier: () => combatStat,
};
let combatStat = 100;
let saveCount = 0;
globalThis.game = { sailing, scheduleSave: () => { saveCount += 1; } };

// ---- fake mod ctx ---------------------------------------------------------
const store = new Map();
let charLoaded, ifaceReady;
const ctx = {
  settings: { section: () => ({ add() {}, set() {} }) },
  characterStorage: { getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v) },
  onCharacterLoaded: (f) => (charLoaded = f),
  onInterfaceReady: (f) => (ifaceReady = f),
};

const { setup } = await import("../mod/setup.mjs");
setup(ctx);
charLoaded();
ifaceReady();

const settle = () => new Promise((r) => setTimeout(r, 30));

// ===========================================================================
// 1. Nothing happens while automation is off (the safe default).
// ===========================================================================
ship1.lockState = LOCK.UNLOCKED;
ship1.state = STATE.READY;
ship1.fire();
await settle();
check("disabled by default: no ship is dispatched", ship1.sailCount === 0);

// Turn it on. Settings live in characterStorage; write them and re-enter via
// onCharacterLoaded so the module reloads them, which is what the panel effectively does.
const conf = {
  enabled: true, autoSail: true, autoCollect: true,
  autoUpgrade: false, autoBuy: false, strategy: "manual", ships: {},
};
const apply = (patch) => {
  Object.assign(conf, patch);
  store.set("settings", structuredClone(conf));
  charLoaded();
};
apply({});

// ===========================================================================
// 2. Core loop: ready -> sails; returns -> collects (modal auto-closed) -> re-sails.
// ===========================================================================
ship1.fire();
await settle();
check("enabled: idle ship sets sail", ship1.sailCount === 1, `sailCount=${ship1.sailCount}`);

ship1.arrive();
await settle();
check(
  "returned ship is collected and immediately re-sailed",
  ship1.state === STATE.ON_TRIP && ship1.sailCount === 2,
  `state=${ship1.state} sailCount=${ship1.sailCount}`,
);
check("loot modal was closed (rewards banked via didDestroy)", openModal === null);

// ===========================================================================
// 3. The dismisser must not touch a modal we didn't cause.
// ===========================================================================
showModal({ text: "You have reached Sailing level 10!", didDestroy: () => {} });
await settle();
check("an unrelated modal is left alone", openModal !== null);
openModal = null;

// A loot modal the *player* opened by hand (no collect of ours in flight) is also left.
showModal({ text: "500 Sailing Skill XP", didDestroy: () => {} });
await settle();
check("a hand-opened loot modal is left alone", openModal !== null);
openModal = null;

// ===========================================================================
// 3b. A loot modal stuck behind another popup must NOT cause a second collect.
//
// Melvor queues modals (addModalToQueue -> modalQueue), so ours can sit behind an
// offline-progress popup or a level-up for as long as it takes you to click them. The ship
// still reads HasReturned that whole time. If the engine ever re-collected, it would roll a
// second lot of loot and queue a second modal, and both would eventually grant.
// ===========================================================================
let lootRolls = 0;
const realCollect = ship1.collectLoot.bind(ship1);
ship1.collectLoot = (cb) => { lootRolls += 1; realCollect(cb); };

// A blocking popup is already up when the ship gets back — it holds the front of the queue.
showModal({ text: "Offline progress!", didDestroy: () => {} });
const blocking = openModal;
ship1.state = STATE.RETURNED;
ship1.fire();
await settle();
check("collect is issued once while a modal blocks the queue", lootRolls === 1,
  `rolls=${lootRolls}`);
check("the blocking modal is not dismissed for us", openModal === blocking);

// Sit on it long enough for several backstop ticks (and the old 60s timeout's intent).
await new Promise((r) => setTimeout(r, 150));
check("no second collect while the loot modal is still queued", lootRolls === 1,
  `rolls=${lootRolls}`);
check("ship is still awaiting collection", ship1.state === STATE.RETURNED,
  `state=${ship1.state}`);

// The player finally clicks the blocker; ours surfaces and the engine finishes the job.
dismissByHand();
await settle();
check("once the queue clears, the loot modal is collected and the ship re-sails",
  ship1.state === STATE.ON_TRIP && lootRolls === 1,
  `state=${ship1.state} rolls=${lootRolls}`);
check("exactly one loot roll happened in total", lootRolls === 1, `rolls=${lootRolls}`);
ship1.collectLoot = realCollect;

// ===========================================================================
// 4. Port strategy.
// ===========================================================================
sailing.level = 99;
ports.forEach((p) => (p._level = 1));

// "Level up" = furthest port, since XP/hr is linear in distance.
apply({ strategy: "levelup" });
ship1.state = STATE.READY;
ship1.fire();
await settle();
check("levelup picks the furthest port", ship1.selectedPort.name === "kingsLanding",
  `picked ${ship1.selectedPort.name}`);

// "Safe" with a weak cannon must back off to a port it can actually beat.
combatStat = 100;
apply({ strategy: "safe" });
ship1.state = STATE.READY;
ship1.fire();
await settle();
check("safe backs off to a 100%-success port with a weak cannon",
  ship1.selectedPort.name === "tinyIsland", `picked ${ship1.selectedPort.name}`);

// With a huge cannon, "safe" can take the best port.
combatStat = 999999;
ship1.state = STATE.READY;
ship1.fire();
await settle();
check("safe takes the furthest port once combat covers it",
  ship1.selectedPort.name === "kingsLanding", `picked ${ship1.selectedPort.name}`);

// ===========================================================================
// 5. Spending guards.
// ===========================================================================
gp = 0;
apply({ autoBuy: true, autoUpgrade: true });

ship2.fire();
await settle();
check("auto-buy does not buy a ship you cannot afford", ship2.lockState === LOCK.LOCKED);

gp = 100_000; // enough for Dock2? no — Dock2 costs 1,000,000
ship2.fire();
await settle();
check("auto-buy still refuses below the exact cost", ship2.lockState === LOCK.LOCKED,
  `gp=${gp}`);

gp = 1_000_000;
ship2.fire();
await settle();
check("auto-buy buys the ship once affordable, spending exactly the cost",
  ship2.lockState === LOCK.UNLOCKED && gp === 0, `lock=${ship2.lockState} gp=${gp}`);

// Upgrade: level-gated (Frigate needs 40) and cost-gated.
sailing.level = 1;
gp = 5_000_000;
ship1.state = STATE.READY;
ship1.fire();
await settle();
check("auto-upgrade respects the level requirement",
  ship1.currentUpgrade.localID === "Cutter", `tier=${ship1.currentUpgrade.localID}`);

sailing.level = 99;
ship1.state = STATE.READY;
ship1.fire();
await settle();
check("auto-upgrade upgrades once level and cost are met",
  ship1.currentUpgrade.localID === "Frigate" && gp === 4_000_000,
  `tier=${ship1.currentUpgrade.localID} gp=${gp}`);

// ===========================================================================
// 6. Persistence across a game restart.
//
// characterStorage only reaches the save file when the game next saves, so saveSettings()
// must also ask the game to save — otherwise a toggle followed by a reload is lost.
// ===========================================================================
// Go through the mod's real save path (what every panel control calls), not the harness's
// shortcut of writing to the store directly.
store.delete("settings");
saveCount = 0;
globalThis.autoSailing.settings.strategy = "safe";
globalThis.autoSailing.save();

check("saving a setting schedules a game save", saveCount > 0, `saves=${saveCount}`);

const storedNow = store.get("settings");
check("settings were actually written to characterStorage", !!storedNow);
check("the stored value round-trips as a plain object", typeof storedNow === "object");
check("the stored value holds what we set", storedNow?.strategy === "safe",
  `strategy=${storedNow?.strategy}`);
conf.strategy = "safe"; // keep the harness's expectation in step with what we just saved

const fresh = await import("../mod/setup.mjs?restart=1");
let freshCharLoaded, freshIfaceReady;
fresh.setup({
  settings: { section: () => ({ add() {}, set() {} }) },
  characterStorage: ctx.characterStorage,
  onCharacterLoaded: (f) => (freshCharLoaded = f),
  onInterfaceReady: (f) => (freshIfaceReady = f),
});
freshCharLoaded();
freshIfaceReady();
check("a restarted mod reads its settings back",
  globalThis.autoSailing.settings.enabled === true &&
    globalThis.autoSailing.settings.strategy === conf.strategy,
  `enabled=${globalThis.autoSailing.settings.enabled} strategy=${globalThis.autoSailing.settings.strategy}`);

// A storage layer that hands back JSON instead of an object must not silently degrade to
// defaults (spreading a string yields numeric keys and every real setting stays default).
store.set("settings", JSON.stringify({ ...conf, strategy: "safe" }));
const fresh2 = await import("../mod/setup.mjs?restart=2");
let f2Char, f2Iface;
fresh2.setup({
  settings: { section: () => ({ add() {}, set() {} }) },
  characterStorage: ctx.characterStorage,
  onCharacterLoaded: (f) => (f2Char = f),
  onInterfaceReady: (f) => (f2Iface = f),
});
f2Char();
f2Iface();
check("a JSON-string payload is parsed, not spread into garbage",
  globalThis.autoSailing.settings.strategy === "safe" &&
    globalThis.autoSailing.settings.enabled === true,
  `strategy=${globalThis.autoSailing.settings.strategy}`);

// ===========================================================================
console.log("");
let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "  PASS" : "  FAIL"}  ${r.name}${r.extra ? `  [${r.extra}]` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
