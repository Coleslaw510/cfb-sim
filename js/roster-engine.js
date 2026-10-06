/* Shared roster mutation engine — All-Time Shop today, Recruiting later. */
(function (global) {
  "use strict";

  const POSITIONS = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K", "P"];

  /** Map catalog / ESPN position → depth-chart bucket. */
  function depthBucket(pos) {
    const p = String(pos || "").toUpperCase();
    if (p === "PK" || p === "K" || p === "KICKER") return "K";
    if (p === "P" || p === "PUNTER") return "P";
    if (POSITIONS.includes(p)) return p;
    if (["HB", "FB", "TB"].includes(p)) return "RB";
    if (["CB", "S", "FS", "SS", "NB"].includes(p)) return "DB";
    if (["DE", "DT", "NT"].includes(p)) return "DL";
    if (["ILB", "OLB", "MLB"].includes(p)) return "LB";
    if (["C", "G", "T", "OT", "OG"].includes(p)) return "OL";
    return "WR";
  }

  function sideForPos(pos) {
    const b = depthBucket(pos);
    if (b === "DL" || b === "LB" || b === "DB") return "def";
    if (b === "K" || b === "P") return "spec";
    return "off";
  }

  function costForOvr(ovr) {
    const x = Math.max(0, Number(ovr) - 39);
    return Math.round(10 + x * x * 0.35);
  }

  function cloneRoster(roster) {
    if (!roster) return { id: null, players: [], depth: {} };
    return {
      id: roster.id,
      players: (roster.players || []).map((p) => Object.assign({}, p)),
      depth: Object.assign(
        {},
        ...POSITIONS.map((pos) => ({
          [pos]: ((roster.depth && roster.depth[pos]) || []).slice(),
        }))
      ),
    };
  }

  /**
   * Insert an all-time (or future recruit) player at the top of their position depth.
   * Behavior:
   *  - Appends to players[] with flags {src:"alltime"|"recruit", ovr, schoolId, catalogId}
   *  - Prepends index to depth[pos] (becomes starter / #1)
   *  - Does not remove existing players (depth list grows; sim uses slot 0 first)
   * Returns { roster, index }.
   */
  function insertPlayer(roster, player, opts) {
    const r = cloneRoster(roster);
    opts = opts || {};
    const bucket = depthBucket(player.p || player.pos);
    const entry = {
      n: player.n || player.name,
      j: player.j || player.jersey || "—",
      p: bucket === "K" ? "PK" : bucket,
      c: opts.classYear || (opts.source === "recruit" ? "FR" : "AT"),
      src: opts.source || "alltime",
      ovr: player.ovr != null ? Number(player.ovr) : null,
      schoolId: player.schoolId || null,
      catalogId: player.id || player.catalogId || null,
    };
    // Avoid duplicate catalog inserts
    if (entry.catalogId) {
      const existing = r.players.findIndex((p) => p.catalogId === entry.catalogId);
      if (existing >= 0) {
        // Re-promote to depth #1
        const depth = r.depth[bucket] || (r.depth[bucket] = []);
        const at = depth.indexOf(existing);
        if (at >= 0) depth.splice(at, 1);
        depth.unshift(existing);
        return { roster: r, index: existing, promoted: true };
      }
    }
    const index = r.players.length;
    r.players.push(entry);
    const depth = r.depth[bucket] || (r.depth[bucket] = []);
    depth.unshift(index);
    return { roster: r, index, promoted: false };
  }

  /** Apply a list of catalog players onto a base ESPN roster. */
  function applyOwnedPlayers(baseRoster, ownedCatalogPlayers, opts) {
    let r = cloneRoster(baseRoster);
    const list = ownedCatalogPlayers || [];
    for (const pl of list) {
      const out = insertPlayer(r, pl, Object.assign({ source: "alltime" }, opts || {}));
      r = out.roster;
    }
    return r;
  }

  /**
   * Soft rating boost from owned all-time players so purchases matter beyond names.
   * Caps keep the sim from breaking.
   */
  function ratingBoostFromOwned(ownedCatalogPlayers) {
    let off = 0;
    let def = 0;
    let spec = 0;
    for (const pl of ownedCatalogPlayers || []) {
      const ovr = Number(pl.ovr) || 70;
      const weight = Math.max(0, ovr - 72) * 0.09 + (ovr >= 90 ? 0.6 : 0);
      const side = sideForPos(pl.p);
      if (side === "off") off += weight;
      else if (side === "def") def += weight;
      else spec += weight * 0.25;
    }
    // Specialists trickle into both a little
    off += spec * 0.5;
    def += spec * 0.5;
    const CAP = 12;
    return {
      offense: Math.min(CAP, Math.round(off * 10) / 10),
      defense: Math.min(CAP, Math.round(def * 10) / 10),
      overall: Math.min(CAP, Math.round(((Math.min(CAP, off) + Math.min(CAP, def)) / 2) * 10) / 10),
    };
  }

  function applyBoostToTeam(team, boost) {
    if (!team || !boost) return team;
    const t = Object.assign({}, team);
    t.offense = Math.min(99, (Number(team.offense) || 60) + (boost.offense || 0));
    t.defense = Math.min(99, (Number(team.defense) || 60) + (boost.defense || 0));
    t.overall = Math.min(99, (Number(team.overall) || 60) + (boost.overall || 0));
    t._shopBoost = boost;
    return t;
  }

  global.CFBRosterEngine = {
    POSITIONS,
    depthBucket,
    sideForPos,
    costForOvr,
    cloneRoster,
    insertPlayer,
    applyOwnedPlayers,
    ratingBoostFromOwned,
    applyBoostToTeam,
  };
})(window);
