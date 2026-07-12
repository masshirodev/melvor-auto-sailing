# Auto Sailing

A Melvor Idle mod that automates the [Sailing](https://mod.io/g/melvoridle/m/sailing) skill's
trade loop.

Sailing voyages are long — a port's trip time is `distance × 60s`, so Tiny Island takes an hour
and King's Landing takes **22 hours** — and a ship that gets back does *nothing at all* until
you click **Collect Loot** and then **Set Sail** again. Miss that window and the ship idles.

This mod closes the loop: it collects the moment a ship returns, re-dispatches it immediately,
and can keep each ship pointed at the best port for whatever you're going for.

**Requires the Sailing mod.** Without it, Auto Sailing logs a warning and does nothing.

## Features

| Setting | Default | What it does |
| --- | --- | --- |
| **Automation enabled** | off | Master switch. |
| **Auto set sail** | on | Re-dispatches any idle, unlocked ship. |
| **Auto collect loot** | on | Collects the moment a ship returns, closing the loot modal for you. |
| **Offline catch-up** | **off** | Replays the voyages your ships missed while the game was closed. |
| **Catch-up at most** | 24h | How much of an absence catch-up will credit. |
| **Auto upgrade tier** | **off** | Buys the next ship tier when affordable. **Spends up to 100M GP + materials.** |
| **Auto buy ships** | **off** | Buys locked ships when affordable. **Spends up to 50M GP.** |

Controls live in a panel on the Sailing page, just under the XP bars, with a per-ship row (on/off,
strategy, pinned port) so you can farm a guild port with one ship while another levels. The master
switch is mirrored into the Mod Manager settings so you can flip it without opening the page.

### Port strategies

Set one globally, or override it per ship.

| Strategy | Rule |
| --- | --- |
| **Manual** (default) | Never touches your chosen port. |
| **Level up** | Always the furthest port you've unlocked. |
| **Best XP rate** | Maximises expected XP/hour, backing off to a nearer port when your cannon can't cover the combat check. |
| **Safe** | The furthest port you can reach at 100% success — no pirate risk. |
| **Pinned port** | One specific port forever. This is how you farm a guild port. |

**Why "level up" is just "go furthest":** trip time is `distance × 60s` and base XP is
`distance² / 8`, so XP per hour works out linear in distance. The furthest port you can reach is
always the fastest to level on — there's no tradeoff to tune.

**Why the other strategies exist:** each port has a `combat` requirement, and your success
chance is `min(1, yourCombat / portCombat)`. A failed trip means *"you were attacked by pirates
and lost half your loot"* — and it halves the XP too. Combat comes from the cannons you buy in
the shop, so a port that's technically unlocked can still be a bad deal. **Best XP rate** prices
that in (expected value carries a factor of `0.5 + 0.5 × chance`); **Safe** refuses to gamble.

## Install

**From a modfile:** install `auto-sailing-v<version>.zip` (contains `manifest.json` + `setup.mjs` at the
archive root).

**As a local mod:** create a local mod in the Melvor Mod Manager and point it at the `mod/`
folder.

> **Settings will not persist for an unlinked local mod.** Melvor's wiki says this of both Mod
> Settings and character storage: *"When loading your mod as a Local Mod via the Creator Toolkit,
> the mod must be linked to mod.io and you must have subscribed to and installed the mod via
> mod.io in order for this data to persist."* Nothing is saved until you do — no amount of code
> here can change that. The mod says so in the console at load; run `autoSailing.check()` to see
> for yourself.

Then enable it, along with the Sailing mod, and load a character.

## Development notes

Everything lives in one file, `mod/setup.mjs`. The Sailing mod ships minified, so most of what
follows was originally recovered by reading the bundle and confirmed with `probes/probe1.js`.
Its source is public — <https://github.com/adamk33n3r/melvor-sailing> — and is the better
reference now (`src/ts/ship.ts`, `src/ts/sailing.ts`); still probe before you trust anything about
the *live* object graph.

Things worth knowing before changing this:

- **`manifest.json` is the required filename.** A `setup.json` is silently ignored: the mod
  installs and enables fine but never runs.
- **Melvor's globals are lexically scoped**, not on `globalThis`. Reach `game`, `Swal` etc. by
  bare name behind a `typeof` guard (see `getGame()`).
- **The Sailing skill instance is `game.sailing`**, with `.ships` / `.docks` / `.ports` /
  `.shipUpgrades` registries. There are exactly 4 ships — one per `Dock` — so a "Dock" is just
  the internal record backing a ship slot.
- **`Ship.registerOnUpdate(fn)`** is the Sailing mod's own per-ship callback list, fired on
  every state change. That's our event hook; the 5s interval is only a backstop.
- **Collecting loot is the awkward part.** `collectLoot()` grants nothing directly — it opens a
  Swal modal and commits XP/items/currency/mastery inside that modal's **`didDestroy`**. Since
  the grant hangs off *destroy* rather than *confirm*, simply closing the modal banks everything
  through the game's own code path, so we reimplement none of it. The dismisser only fires while
  one of our own collects is in flight (`busy` is non-empty) **and** the popup contains the loot
  template's signature text, so it can't swallow a level-up or a real confirmation.
- **`collectLoot()` fires the ship's update callbacks *before* its own callback**, so the "ship
  is ready again" event arrives while we're still marked busy. The engine re-ticks explicitly
  after the callback; without that the ship sits in port until the backstop.
- **`setSail()`, `upgrade()` and the `lockState` setter have no guards.** They check no levels
  and consume no costs — the validated flows exist only inside Sailing's UI component closures,
  which aren't reachable. `tryBuyShip()` / `tryUpgrade()` replicate them exactly
  (`getCosts` → `setSource` → `checkIfOwned` → level check → `consumeCosts`), so the mod can
  never spend what a button wouldn't.
- **`ship.selectedPort` is a plain settable property** — the in-game port picker modal is
  cosmetic and can be bypassed entirely.
- `game.sailing.page.update()` redraws the Sailing UI, so none of the `renderQueue` gymnastics
  other Melvor mods need apply here.
- **Offline catch-up takes the sail timers off the game.** It snapshots the away time in
  `onCharacterLoaded` — the last moment `game.tickTimestamp` still holds the previous session's
  final tick — and calls `sailTimer.stop()` on the ships it's going to replay. A stopped `Timer`
  ignores `tick()`, so the game's offline loop can't advance a voyage the mod is already
  accounting for; without that the two would double-count the same hours. The ships are marked
  `busy` for the duration, which is what keeps the engine's own loop off them, and `runCatchUp()`
  always hands them back.
- The `probes/` directory holds console scripts used to reverse-engineer the skill's object
  graph at runtime. Paste them into the browser console (Melvor makes you type `allow pasting`
  once first).

## Build

```sh
./build.sh              # syntax-check, run tests, package auto-sailing-v<version>.zip
./build.sh --skip-tests
```

`manifest.json` and `setup.mjs` must end up at the **root** of the archive (hence `zip -j`).
A wrongly nested mod installs and enables without complaint and then never runs, so the
script verifies the layout instead of trusting it.

## Tests

```sh
node test/engine.test.mjs
```

Drives the real `mod/setup.mjs` against a fake Sailing skill that reproduces the mod's actual
semantics — including the `didDestroy`-only reward grant, the callbacks-before-callback ordering
above, and a `Timer` that ignores ticks once stopped. Covers the collect → re-sail loop,
modal-dismisser scoping, the port strategies, the spending guards, and offline catch-up (voyage
accounting, the cap, and the ships it must refuse to credit). No game required.

## Offline catch-up

Sailing is a `PassiveAction`: its `passiveTick()` ticks every ship's `sailTimer`, and Melvor runs
that same tick loop over the time you were away. So the voyage a ship was on **does** finish while
the game is closed. What never happens is the collect and the re-dispatch — those are clicks — so
the ship gets home three hours into an eight-hour absence and then sits there for five hours.

The clicks are the only thing missing, so they're the only thing this replays. For each voyage that
would have fitted in your absence, the mod calls the game's own `collectLoot()`: the loot rolls, the
pirate check, the XP, the mastery, the pets and the ancient relics are all decided by Sailing's code,
not ours. No rewards are fabricated — the mod supplies the clicks it owed you.

**It's off by default, and it's a real power increase**, not just a convenience: an eight-hour night
goes from one voyage to eight, with eight independent pet and relic rolls. Turn it on deliberately.
The cap bounds how much of an absence gets credited (and the game's own 24-hour offline ceiling
bounds it regardless of what you set).

Two things it deliberately doesn't do:

- **It replays each ship from the port it sailed from.** A strategy that would have re-pointed the
  ship mid-absence — say, after an offline level-up opened a better port — doesn't get to. That
  under-credits rather than over-credits, which is the right way to be wrong.
- **It won't credit a ship that was sitting in port when you quit**, unless the loop was actually
  switched on for it. Catch-up replays a loop that was running; it doesn't start one retroactively.

Every replayed voyage opens the game's real loot modal, which the mod closes for you (that's what
banks the rewards — see below). They're collected strictly one at a time, so they queue politely
behind Melvor's own offline-progress popup rather than racing it.
