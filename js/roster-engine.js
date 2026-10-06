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
      ovrSource: roster.ovrSource || null,
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

  /**
   * Soft offense/defense signal from depth-chart starter OVRs (40–99).
   * Same scale as all-time shop OVRs; used when team ratings need a roster-aware nudge.
   * Caps match ratingBoostFromOwned so shop + roster stay consistent.
   */
  function ratingFromRosterDepth(roster) {
    if (!roster || !roster.players || !roster.depth) {
      return { offense: 0, defense: 0, overall: 0, starterOvrs: [] };
    }
    const OFF = ["QB", "RB", "WR", "TE", "OL"];
    const DEF = ["DL", "LB", "DB"];
    const starterOvrs = [];
    function slotOvr(pos, slot) {
      const idxs = roster.depth[pos] || [];
      const i = idxs[slot];
      if (i == null) return null;
      const p = roster.players[i];
      if (!p || p.ovr == null) return null;
      return Number(p.ovr);
    }
    let offSum = 0, offN = 0, defSum = 0, defN = 0;
    // Weight skill positions + OL a bit like a video-game team OVR
    const offSlots = [["QB",0,1.4],["RB",0,1.0],["WR",0,1.0],["WR",1,0.85],["TE",0,0.7],["OL",0,0.9],["OL",1,0.85],["OL",2,0.85],["OL",3,0.8],["OL",4,0.8]];
    const defSlots = [["DL",0,1.0],["DL",1,0.95],["DL",2,0.9],["LB",0,1.0],["LB",1,0.9],["DB",0,1.0],["DB",1,0.95],["DB",2,0.9],["DB",3,0.85]];
    for (const [pos, slot, w] of offSlots) {
      const o = slotOvr(pos, slot);
      if (o == null) continue;
      offSum += o * w; offN += w; starterOvrs.push({ pos, slot, ovr: o });
    }
    for (const [pos, slot, w] of defSlots) {
      const o = slotOvr(pos, slot);
      if (o == null) continue;
      defSum += o * w; defN += w; starterOvrs.push({ pos, slot, ovr: o });
    }
    const offense = offN ? Math.round((offSum / offN) * 10) / 10 : 0;
    const defense = defN ? Math.round((defSum / defN) * 10) / 10 : 0;
    const overall = offense && defense ? Math.round(((offense + defense) / 2) * 10) / 10 : offense || defense;
    return { offense, defense, overall, starterOvrs };
  }

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
    ratingFromRosterDepth,
    ratingBoostFromOwned,
    applyBoostToTeam,
  };
})(window);
