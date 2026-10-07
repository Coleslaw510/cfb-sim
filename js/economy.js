/* Coin goals / payouts for between-season All-Time Shop. */
(function (global) {
  "use strict";

  /** Static goal definitions shown in the UI. Amounts are coin payouts. */
  const GOAL_DEFS = [
    { id: "wins-6", label: "Win 6+ games (bowl eligible)", amount: 75, group: "Regular season" },
    { id: "wins-8", label: "Win 8+ games", amount: 140, group: "Regular season" },
    { id: "wins-10", label: "Win 10+ games", amount: 280, group: "Regular season" },
    { id: "wins-11", label: "Win 11+ games", amount: 200, group: "Regular season" },
    { id: "wins-12", label: "Win 12+ games", amount: 260, group: "Regular season" },
    { id: "undefeated-rs", label: "Undefeated regular season (min 8 games)", amount: 500, group: "Regular season" },
    { id: "conf-title", label: "Win conference championship", amount: 320, group: "Conference" },
    { id: "conf-appear", label: "Reach conference championship", amount: 100, group: "Conference" },
    { id: "bowl-win", label: "Win a non-CFP bowl", amount: 200, group: "Bowls" },
    { id: "bowl-appear", label: "Make a non-CFP bowl", amount: 70, group: "Bowls" },
    { id: "cfp-berth", label: "Make the CFP field", amount: 260, group: "Playoff" },
    { id: "cfp-win", label: "Win a CFP game (per win)", amount: 200, group: "Playoff", perEvent: true },
    { id: "natty", label: "Win CFP National Championship", amount: 1200, group: "Playoff" },
    { id: "top25", label: "Finish Top 25", amount: 140, group: "Poll" },
    { id: "top10", label: "Finish Top 10", amount: 260, group: "Poll" },
    { id: "top1", label: "Finish #1 in sim poll", amount: 400, group: "Poll" },
    { id: "beat-top25", label: "Beat a Top 25 team (per win)", amount: 60, group: "Quality wins", perEvent: true },
  ];

  function winnerId(box) {
    if (!box) return null;
    if (box.homeScore > box.awayScore) return box.homeId;
    if (box.awayScore > box.homeScore) return box.awayId;
    return null;
  }

  /**
   * Evaluate which goals were earned for a completed season.
   * Returns [{id, label, amount, detail?}, ...] (cfp-win / beat-top25 may collapse with count).
   */
  function evaluateSeasonGoals(ctx) {
    const teamId = ctx.teamId;
    const results = ctx.results || [];
    const recap = ctx.recap || {};
    const top25WinCount = Number(ctx.top25WinCount) || 0;
    const earned = [];

    const allRec = recap.record || { w: 0, l: 0 };
    const wins = Number(allRec.w) || 0;

    // Regular-season-only record for undefeated check
    const rsGames = results.filter(
      (g) =>
        (g.homeId === teamId || g.awayId === teamId) &&
        !g.round &&
        !g.bowl
    );
    const rsWins = rsGames.filter((g) => winnerId(g) === teamId).length;
    const rsLosses = rsGames.length - rsWins;

    function add(def, detail, mult) {
      const m = mult || 1;
      earned.push({
        id: def.id,
        label: def.label,
        amount: def.amount * m,
        detail: detail || null,
        count: m,
      });
    }

    const byId = {};
    GOAL_DEFS.forEach((g) => { byId[g.id] = g; });

    if (wins >= 6) add(byId["wins-6"]);
    if (wins >= 8) add(byId["wins-8"]);
    if (wins >= 10) add(byId["wins-10"]);
    if (wins >= 11) add(byId["wins-11"]);
    if (wins >= 12) add(byId["wins-12"]);
    if (rsGames.length >= 8 && rsLosses === 0) add(byId["undefeated-rs"]);

    const confGame = results.find(
      (g) => g.round === "conf-champ" && (g.homeId === teamId || g.awayId === teamId)
    );
    if (confGame) {
      add(byId["conf-appear"]);
      if (winnerId(confGame) === teamId) add(byId["conf-title"]);
    }

    const myPost = results.filter(
      (g) =>
        (g.homeId === teamId || g.awayId === teamId) &&
        (g.bowl || (g.round && String(g.round).startsWith("cfp")))
    );
    const bowls = myPost.filter((g) => g.round === "bowl" || (g.bowl && !String(g.round || "").startsWith("cfp")));
    const cfpGames = myPost.filter((g) => g.round && String(g.round).startsWith("cfp"));

    if (bowls.length) {
      add(byId["bowl-appear"]);
      if (bowls.some((g) => winnerId(g) === teamId)) add(byId["bowl-win"]);
    }

    if (cfpGames.length) {
      add(byId["cfp-berth"]);
      const cfpWins = cfpGames.filter((g) => winnerId(g) === teamId).length;
      if (cfpWins > 0) add(byId["cfp-win"], cfpWins + " win" + (cfpWins > 1 ? "s" : ""), cfpWins);
      const champ = cfpGames.find((g) => g.round === "cfp-championship");
      if (champ && winnerId(champ) === teamId) add(byId["natty"]);
    }

    const rank = recap.finalRank;
    if (rank && rank <= 25) add(byId["top25"]);
    if (rank && rank <= 10) add(byId["top10"]);
    if (rank === 1) add(byId["top1"]);

    if (top25WinCount > 0) {
      add(
        byId["beat-top25"],
        top25WinCount + " win" + (top25WinCount > 1 ? "s" : ""),
        top25WinCount
      );
    }

    return earned;
  }

  function payoutTotal(lines) {
    return (lines || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  }

  global.CFBEconomy = {
    GOAL_DEFS,
    evaluateSeasonGoals,
    payoutTotal,
    STARTING_COINS: 250,
    BEAT_TOP25_BONUS: 60,
  };
})(window);
