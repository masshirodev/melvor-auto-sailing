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

**From a modfile:** install `auto-sailing.zip` (contains `manifest.json` + `setup.mjs` at the
archive root).

**As a local mod:** create a local mod in the Melvor Mod Manager and point it at the `mod/`
folder.

Then enable it, along with the Sailing mod, and load a character.

## Development notes

Everything lives in one file, `mod/setup.mjs`. The Sailing mod ships minified, so most of what
follows was recovered by reading it and confirmed with `probes/probe1.js` — probe before you
trust any of it.

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
- The `probes/` directory holds console scripts used to reverse-engineer the skill's object
  graph at runtime. Paste them into the browser console (Melvor makes you type `allow pasting`
  once first).

## Build

```sh
./build.sh              # syntax-check, run tests, package auto-sailing.zip
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
semantics — including the `didDestroy`-only reward grant and the callbacks-before-callback
ordering above. Covers the collect → re-sail loop, modal-dismisser scoping, the port strategies,
and the spending guards. No game required.

## Known limits

While the game is **closed** the mod isn't running, so a ship that returns three hours into an
eight-hour absence still just waits. On load it's collected and re-sailed immediately, but the
voyages that "would have" happened aren't simulated — that would be fabricating rewards rather
than automating clicks.
