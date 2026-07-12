# Changelog

## 0.1.1 — Duplicate-loot fix

- **Fixed duplicate loot when the modal queue backs up.** Melvor queues modals
  (`addModalToQueue` pushes to `modalQueue`), so a loot modal can sit behind an
  offline-progress popup, a level-up or a pet drop for as long as it takes you to click them.
  `collect()` used to release its `busy` flag on a 60s timeout — but the ship still reads
  `HasReturned` until the modal is destroyed, so the next tick collected *again*: a second loot
  roll, a second queued modal, and both would eventually grant. This bites hardest in exactly
  the case the mod exists for — loading in after hours away, with four ships returning into a
  backed-up queue.

  The timeout is gone. `busy` is now cleared only by the modal's own callback, so a ship stays
  flagged until its loot actually lands. A ship stranded by a modal that never resolves is
  fixed by a reload; duplicated rewards are not.

- The test harness now models the modal **queue** rather than a single popup, which is what
  made the bug visible.

## 0.1.0 — Initial release

Automates the Sailing mod's trade loop: collect on return, re-dispatch immediately, and
optionally steer each ship to the best port.

- **Auto collect + auto set sail.** Driven by `Ship.registerOnUpdate()`, the Sailing mod's own
  per-ship callback list, so the engine reacts to state changes rather than polling the game
  loop. A 5s interval remains as a backstop only.
- **Port strategies** — Manual, Level up, Best XP rate, Safe, and Pinned — settable globally or
  per ship, so one ship can farm a guild port while another levels.
- **Auto upgrade tier** and **auto buy ships**, both **off by default** because they spend GP
  (up to 100M and 50M respectively).
- Control panel on the Sailing page, under the XP bars, with a row per ship. Master switch
  mirrored into the Mod Manager settings.
- Settings persist per character via `characterStorage`.

### Notes from building it

- **Collecting loot grants nothing directly.** `collectLoot()` opens a Swal modal and commits
  the XP, items, currency and mastery inside that modal's **`didDestroy`** — not its confirm
  handler. Since the grant hangs off *destroy*, simply closing the modal banks everything
  through the game's own code path, so none of the reward logic is reimplemented here and none
  of it can drift when Sailing updates.
- **The dismisser is deliberately narrow.** It only acts while one of our own collects is in
  flight *and* the popup contains the loot template's signature text, so it can't swallow a
  level-up, a pet drop, or a confirmation you actually wanted. A loot modal you opened by hand
  is left for you to click.
- **`collectLoot()` fires the ship's update callbacks *before* its own callback**, so the "ship
  is ready again" event arrives while the ship is still flagged busy and gets ignored. The
  engine re-ticks explicitly afterwards; without that the ship would sit in port until the
  backstop fired.
- **`setSail()`, `upgrade()` and the `lockState` setter have no guards at all** — they check no
  levels and consume no costs, because the real validation lives inside Sailing's UI component
  closures, which aren't reachable from another mod. `tryBuyShip()` / `tryUpgrade()` replicate
  that sequence exactly (`getCosts` → `setSource` → `checkIfOwned` → level check →
  `consumeCosts`), so the mod can never spend what a button wouldn't.
- **XP per hour is linear in port distance.** Trip time is `distance × 60s` and base XP is
  `distance² / 8`, so the furthest reachable port is always the fastest to level on — which is
  why "Level up" needs no tuning. The Combat check is the only thing that complicates it: a
  failed roll halves the *entire* reward bundle, XP included, so expected value carries a factor
  of `0.5 + 0.5 × chance`. That's what "Best XP rate" optimises and what "Safe" refuses to risk.
- **`ship.selectedPort` is a plain settable property** — the in-game port picker modal is
  cosmetic and is bypassed entirely.
- There are exactly **4 ships**, one per `Dock`; a "Dock" is just the internal record backing a
  ship slot, and all four must be bought (100k / 1M / 10M / 50M GP).
