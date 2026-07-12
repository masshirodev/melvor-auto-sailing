// Auto Sailing — probe 1: the Sailing skill object graph.
//
// Run it with the SAILING PAGE OPEN, in the browser console.
// (Melvor requires you to type `allow pasting` in the console once first.)
//
// Confirms every assumption auto-sailing relies on:
//   - game.sailing exists, with ships/docks/ports/shipUpgrades registries
//   - Ship.setSail / collectLoot / registerOnUpdate / selectedPort are callable
//   - the loot modal's signature text, so the auto-dismisser can identify it
//   - port interval / baseExperience / sailingStats formulas

(() => {
  const lines = [];
  const p = (...a) => lines.push(a.join(" "));

  const sailing = game.sailing;
  if (!sailing) {
    console.warn("game.sailing is undefined — is the Sailing mod installed and enabled?");
    return "no sailing skill";
  }

  p("===== SKILL =====");
  p("  id            =", sailing.id);
  p("  level         =", sailing.level);
  p("  ctor          =", sailing.constructor?.name);
  p("  page.update   =", typeof sailing.page?.update);
  p("  registries    =", ["ships", "docks", "ports", "shipUpgrades"]
    .map((k) => `${k}:${sailing[k]?.size ?? "MISSING"}`)
    .join(" "));
  p("  modifyXP      =", typeof sailing.modifyXP);
  p("  modifyInterval=", typeof sailing.modifyInterval);
  p("  getCombatModifier =", typeof sailing.getCombatModifier);

  p("");
  p("===== SHIPS =====");
  sailing.ships.forEach((ship) => {
    p(`  ${ship.id}  (${ship.name})`);
    p("     state          =", ship.state, "(0=ReadyToSail 1=OnTrip 2=HasReturned)");
    p("     lockState      =", ship.lockState, "(0=Locked 1=Unlocked)");
    p("     onTrip         =", ship.onTrip);
    p("     ticksLeft      =", ship.sailTimer?.ticksLeft);
    p("     selectedPort   =", ship.selectedPort?.id, `(${ship.selectedPort?.name})`);
    p("     currentUpgrade =", ship.currentUpgrade?.id);
    p("     nextUpgrade    =", ship.getNextUpgrade()?.id ?? "(none)");
    p("     dock.level     =", ship.dock?.level);
    p("     methods        =", ["setSail", "collectLoot", "upgrade", "registerOnUpdate",
      "getUpgradeCosts"].map((m) => `${m}:${typeof ship[m]}`).join(" "));
    p("     dock.getUnlockCosts =", typeof ship.dock?.getUnlockCosts);
    p("     combatModifier =", sailing.getCombatModifier(ship.dock));
  });

  p("");
  p("===== PORTS =====");
  p("  name / distance / interval(min) / baseXP / combatReq / unlocked / hasLevel");
  sailing.ports.forEach((port) => {
    p(
      `  ${(port.name ?? port.id).padEnd(22)}`,
      String(port.distance).padStart(5),
      String(port.interval / 60000).padStart(5),
      String(Math.round(port.baseExperience)).padStart(8),
      String(port.sailingStats?.combat ?? "-").padStart(7),
      String(port.isUnlocked()).padStart(6),
      String(port.hasLevelRequirements()).padStart(6),
    );
  });

  // The formulas auto-sailing's port picker depends on.
  const sample = sailing.ports.allObjects[0];
  p("");
  p("===== FORMULA CHECK (" + sample.id + ") =====");
  p("  interval == 60 * distance * 1000 ?", sample.interval === 60 * sample.distance * 1000);
  p("  baseXP   == distance^2 / 8      ?",
    Math.abs(sample.baseExperience - (sample.distance * sample.distance) / 8) < 1e-6);

  p("");
  p("===== MODAL =====");
  p("  addModalToQueue =", typeof addModalToQueue);
  p("  Swal.isVisible / clickConfirm / getPopup =",
    [typeof Swal?.isVisible, typeof Swal?.clickConfirm, typeof Swal?.getPopup].join(" "));
  p("  Swal.isVisible() =", Swal?.isVisible?.());
  const popup = Swal?.getPopup?.();
  p("  popup contains 'Sailing Skill XP' ?",
    popup ? popup.textContent.includes("Sailing Skill XP") : "(no popup open)");
  p("");
  p("  addModalToQueue source:");
  p(String(addModalToQueue));

  const text = lines.join("\n");
  console.log(text);
  copy(text);
  return "copied to clipboard";
})();
