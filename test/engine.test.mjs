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

// ---- fake Swal ------------------------------------------------------------
let openModal = null;
const showModal = (modal) => {
  openModal = modal;
  setTimeout(() => observers.forEach((cb) => cb()), 0); // the "DOM changed" signal
};
globalThis.Swal = {
  isVisible: () => openModal !== null,
  getPopup: () => (openModal ? { textContent: openModal.text } : null),
  clickConfirm: () => {
    const m = openModal;
    openModal = null;
    m.didDestroy(); // SweetAlert2 fires didDestroy on close, however it was closed
  },
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
globalThis.game = { sailing };

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
console.log("");
let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "  PASS" : "  FAIL"}  ${r.name}${r.extra ? `  [${r.extra}]` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
