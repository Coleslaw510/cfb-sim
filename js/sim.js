/* CFB 2026 simulation engine — drive-based + postseason selection */
(function (global) {
  "use strict";

  const FIRST_NAMES = ["Jaylen","Marcus","Tyler","Cam","Jordan","Malik","Noah","Isaiah","Cole","Dylan","Brayden","Jalen","Xavier","Aiden","Carson","Miles","Kaiden","Bryce","Devin","Riley","Owen","Eli","Caleb","Nate","Chris","Jake","Hunter","Logan","Quinn","Austin"];
  const LAST_NAMES = ["Williams","Johnson","Brown","Davis","Miller","Wilson","Moore","Taylor","Anderson","Thomas","Jackson","White","Harris","Martin","Thompson","Garcia","Martinez","Robinson","Clark","Lewis","Lee","Walker","Hall","Allen","Young","King","Wright","Scott","Green","Baker","Adams","Nelson","Carter","Mitchell","Perez","Roberts","Turner","Phillips","Campbell","Parker"];

  const POWER4 = new Set(["1", "4", "5", "8"]); // ACC, Big 12, Big Ten, SEC
  const G6 = new Set(["151", "12", "15", "17", "9", "37"]); // American, CUSA, MAC, MW, Pac-12, Sun Belt
  const INDEPENDENT = "18";

  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function pickName(rng) {
    const f = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
    const l = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
    return f + " " + l;
  }

  /** Resolve a depth-chart player name; fall back to generic. */
  function depthName(roster, pos, slot, rng) {
    if (roster && roster.depth && roster.players) {
      const idxs = roster.depth[pos] || [];
      if (idxs[slot] != null && roster.players[idxs[slot]]) {
        return roster.players[idxs[slot]].n;
      }
      // try next slots if preferred missing
      for (let i = 0; i < idxs.length; i++) {
        if (roster.players[idxs[i]]) return roster.players[idxs[i]].n;
      }
    }
    return pickName(rng);
  }

  function expectedPoints(off, def, homeBoost) {
    const base = 12 + (off - 50) * 0.55 - (def - 50) * 0.45 + homeBoost;
    return clamp(base, 7, 52);
  }

  function simulateGame(homeTeam, awayTeam, meta) {
    const seed = hashSeed(
      String(meta.eventId) + "|" + String(meta.week) + "|" + String(meta.seasonSeed || 0)
    );
    const rng = mulberry32(seed);

    const homeBoost = meta.neutralSite ? 0 : 2.4;
    const homeExp = expectedPoints(homeTeam.offense, awayTeam.defense, homeBoost);
    const awayExp = expectedPoints(awayTeam.offense, homeTeam.defense, 0);

    const homeDrives = 10 + Math.floor(rng() * 4);
    const awayDrives = 10 + Math.floor(rng() * 4);

    function scoreFromDrives(expPts, drives) {
      let pts = 0;
      let td = 0;
      let fg = 0;
      let to = 0;
      const pScore = clamp(expPts / (drives * 4.2), 0.18, 0.72);
      for (let i = 0; i < drives; i++) {
        const r = rng();
        if (r < pScore * 0.62) {
          pts += 7;
          td += 1;
        } else if (r < pScore) {
          pts += 3;
          fg += 1;
        } else if (r < pScore + 0.08) {
          to += 1;
        }
      }
      if (rng() < 0.04) pts += 2;
      return { pts, td, fg, to };
    }

    let homeS = scoreFromDrives(homeExp, homeDrives);
    let awayS = scoreFromDrives(awayExp, awayDrives);

    if (homeS.pts + awayS.pts < 17) {
      if (rng() < 0.5) homeS.pts += 7;
      else awayS.pts += 7;
    }

    let ot = false;
    while (homeS.pts === awayS.pts) {
      ot = true;
      if (rng() < 0.55) homeS.pts += 7;
      else awayS.pts += 3;
      if (rng() < 0.55) awayS.pts += 7;
      else homeS.pts += 3;
      if (homeS.pts === awayS.pts) {
        if (rng() < 0.5) homeS.pts += 3;
        else awayS.pts += 3;
      }
    }

    function yardsBundle(pts, off, def, isHome) {
      const passShare = 0.52 + (rng() - 0.5) * 0.18;
      const totalOff = clamp(
        280 + (off - def) * 3.2 + (pts - 24) * 6.5 + (rng() - 0.5) * 60,
        140,
        620
      );
      const passYds = Math.round(totalOff * passShare);
      const rushYds = Math.round(totalOff - passYds);
      const passAtt = clamp(Math.round(28 + passShare * 18 + (rng() - 0.5) * 8), 18, 55);
      const completions = clamp(Math.round(passAtt * (0.55 + (off - 50) * 0.003 + (rng() - 0.5) * 0.08)), 8, passAtt - 2);
      const rushAtt = clamp(Math.round(28 + (1 - passShare) * 16 + (rng() - 0.5) * 6), 20, 52);
      const interceptions = Math.max(0, Math.round((rng() < 0.35 ? 1 : 0) + (rng() < 0.12 ? 1 : 0)));
      const fumblesLost = Math.max(0, (rng() < 0.28 ? 1 : 0) + (rng() < 0.08 ? 1 : 0));
      const turnovers = interceptions + fumblesLost;
      return {
        passYds,
        rushYds,
        totalYds: passYds + rushYds,
        passAtt,
        completions,
        rushAtt,
        interceptions,
        fumblesLost,
        turnovers,
        thirdDownConv: clamp(Math.round(4 + rng() * 8), 2, 12),
        thirdDownAtt: clamp(Math.round(11 + rng() * 5), 10, 18),
        timeOfPoss: null,
        isHome,
      };
    }

    const homeY = yardsBundle(homeS.pts, homeTeam.offense, awayTeam.defense, true);
    const awayY = yardsBundle(awayS.pts, awayTeam.offense, homeTeam.defense, false);

    homeY.turnovers = Math.max(homeY.turnovers, homeS.to > 0 ? homeS.to : homeY.turnovers);
    awayY.turnovers = Math.max(awayY.turnovers, awayS.to > 0 ? awayS.to : awayY.turnovers);

    const homePossMin = clamp(26 + (homeY.rushAtt - awayY.rushAtt) * 0.15 + (rng() - 0.5) * 4, 24, 36);
    homeY.timeOfPoss = formatTOP(homePossMin);
    awayY.timeOfPoss = formatTOP(60 - homePossMin);

    function leadersFor(roster, yds, pts) {
      const qb = depthName(roster, "QB", 0, rng);
      const rb1 = depthName(roster, "RB", 0, rng);
      const rb2 = depthName(roster, "RB", 1, rng);
      const wr1 = depthName(roster, "WR", 0, rng);
      const wr2 = depthName(roster, "WR", 1, rng);
      const te1 = depthName(roster, "TE", 0, rng);
      const passTds = clamp(Math.round(pts / 10 + (rng() - 0.4)), 0, 5);
      const rushTds = Math.max(0, Math.round(pts / 14) - Math.floor(passTds * 0.4));
      const rush1 = Math.round(yds.rushYds * (0.55 + rng() * 0.2));
      const rush2 = Math.max(8, yds.rushYds - rush1 - Math.round(rng() * 20));
      const recYds = Math.round(yds.passYds * (0.28 + rng() * 0.15));
      const recYds2 = Math.round(yds.passYds * (0.18 + rng() * 0.1));
      // Prefer WR; occasionally TE for receiving leader
      const recName = rng() < 0.18 ? te1 : wr1;
      return {
        passing: { name: qb, comp: yds.completions, att: yds.passAtt, yds: yds.passYds, td: passTds, int: yds.interceptions },
        rushing: [
          { name: rb1, att: Math.round(yds.rushAtt * 0.55), yds: rush1, td: Math.min(rushTds, 2) },
          { name: rb2, att: Math.max(3, yds.rushAtt - Math.round(yds.rushAtt * 0.55) - 4), yds: Math.max(0, rush2), td: Math.max(0, rushTds - 2) },
        ],
        receiving: [
          { name: recName, rec: clamp(Math.round(3 + rng() * 6), 2, 10), yds: recYds, td: Math.min(passTds, 2) },
          { name: wr2, rec: clamp(Math.round(2 + rng() * 5), 1, 8), yds: recYds2, td: Math.max(0, Math.min(passTds - 1, 1)) },
        ],
      };
    }

    const homeLeaders = leadersFor(meta.homeRoster || null, homeY, homeS.pts);
    const awayLeaders = leadersFor(meta.awayRoster || null, awayY, awayS.pts);

    return {
      eventId: meta.eventId,
      week: meta.week,
      label: meta.label || null,
      bowl: meta.bowl || null,
      round: meta.round || null,
      neutralSite: !!meta.neutralSite,
      ot,
      homeId: homeTeam.id,
      awayId: awayTeam.id,
      homeScore: homeS.pts,
      awayScore: awayS.pts,
      homeStats: homeY,
      awayStats: awayY,
      homeLeaders,
      awayLeaders,
    };
  }

  function formatTOP(minutes) {
    const m = Math.floor(minutes);
    const s = Math.floor((minutes - m) * 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function teamRecord(results, teamId, opts) {
    opts = opts || {};
    let w = 0, l = 0, pf = 0, pa = 0;
    for (const g of results) {
      if (g.homeId !== teamId && g.awayId !== teamId) continue;
      if (opts.regularOnly && (g.round || g.bowl)) continue;
      if (opts.postseasonOnly && !(g.round || g.bowl)) continue;
      const mine = g.homeId === teamId ? g.homeScore : g.awayScore;
      const theirs = g.homeId === teamId ? g.awayScore : g.homeScore;
      pf += mine;
      pa += theirs;
      if (mine > theirs) w++;
      else l++;
    }
    return { w, l, pf, pa, margin: pf - pa };
  }

  function conferenceRecord(results, teamId, teams) {
    const conf = teams[teamId] && teams[teamId].conferenceId;
    let w = 0, l = 0;
    for (const g of results) {
      if (g.homeId !== teamId && g.awayId !== teamId) continue;
      if (g.round || g.bowl) continue; // conf record = regular season
      const oppId = g.homeId === teamId ? g.awayId : g.homeId;
      const opp = teams[oppId];
      if (!opp || opp.conferenceId !== conf || conf === "fcs") continue;
      const mine = g.homeId === teamId ? g.homeScore : g.awayScore;
      const theirs = g.homeId === teamId ? g.awayScore : g.homeScore;
      if (mine > theirs) w++;
      else l++;
    }
    return { w, l };
  }

  /** Power 4 conferences + Notre Dame get strong poll weight. */
  function isPowerOrND(t) {
    if (!t) return false;
    if (t.id === "87") return true; // Notre Dame
    return POWER4.has(String(t.conferenceId));
  }

  function confPrestige(t) {
    if (!t) return 0.4;
    if (t.id === "87") return 1.0;
    if (POWER4.has(String(t.conferenceId))) return 1.0;
    if (G6.has(String(t.conferenceId))) return 0.55;
    return 0.45;
  }

  /**
   * Sim Top 25 — retuned for committee-ish priorities:
   * strong P4/ND records, quality wins, real SOS; dampened blowout margins.
   *
   * score =
   *   winPct×26 + confStrength×20 + qualityWins×24 + SOS×16
   *   + marginScore×6 + remainingOppStr×4 + apSeed×4
   */
  function computeTop25(fbsIds, teams, results, schedules, currentWeek) {
    const playedOppRatings = {};
    const remaining = {};
    const regularish = results.filter((g) => !g.bowl || g.round === "conf-champ");

    // Precompute records for quality-win opponent look-ups
    const recCache = {};
    for (const id of fbsIds) {
      recCache[id] = teamRecord(regularish, id);
    }

    for (const id of fbsIds) {
      playedOppRatings[id] = [];
      remaining[id] = [];
      const sched = schedules[id] || [];
      for (const g of sched) {
        const opp = teams[g.opponentId];
        const rating = opp ? opp.overall : 50;
        if (g.week < currentWeek) {
          const played = regularish.some((r) => r.eventId === g.eventId);
          if (played) playedOppRatings[id].push(rating);
        } else if (g.week >= currentWeek) {
          remaining[id].push(rating);
        }
      }
    }

    const scored = fbsIds.map((id) => {
      const t = teams[id];
      const rec = recCache[id] || { w: 0, l: 0, pf: 0, pa: 0, margin: 0 };
      const games = rec.w + rec.l;
      const winPct = games ? rec.w / games : 0;
      const sosArr = playedOppRatings[id];
      const sos = sosArr.length ? sosArr.reduce((a, b) => a + b, 0) / sosArr.length / 100 : 0.55;
      const avgMargin = games ? rec.margin / games : 0;
      const rem = remaining[id];
      const remStr = rem.length ? rem.reduce((a, b) => a + b, 0) / rem.length / 100 : 0.55;
      const ap = t.apRank;
      const apSeed = ap ? (26 - ap) / 25 : 0.15;

      // Dampen margins: cupcake blowouts shouldn't dominate (cap ~±14, soft curve)
      const marginScore = clamp((Math.tanh(avgMargin / 14) + 1) / 2, 0, 1);

      // Conference strength: conf win% × prestige (P4/ND ≫ G5)
      const conf = conferenceRecord(regularish, id, teams);
      const confGames = conf.w + conf.l;
      const confPct = confGames ? conf.w / confGames : winPct;
      const prestige = confPrestige(t);
      // Partial-season conf schedule still counts; few conf games → blend toward winPct
      const confBlend = confGames >= 3 ? confPct : (confGames ? (confPct * confGames + winPct * (3 - confGames)) / 3 : winPct);
      const confStrength = confBlend * prestige;
      // Undefeated / near-perfect P4 bonus
      if (prestige >= 1.0 && games >= 8 && winPct >= 0.9) {
        // small additive handled via confStrength bump below in score
      }

      // Quality wins: reward beating strong / P4 / winning opponents
      let qwRaw = 0;
      let qwCount = 0;
      let badLossPenalty = 0;
      for (const g of regularish) {
        if (g.homeId !== id && g.awayId !== id) continue;
        const won = winnerId(g) === id;
        const oppId = g.homeId === id ? g.awayId : g.homeId;
        const opp = teams[oppId];
        if (!opp) continue;
        const oppRec = recCache[oppId] || teamRecord(regularish, oppId);
        const oppGames = oppRec.w + oppRec.l;
        const oppPct = oppGames ? oppRec.w / oppGames : 0.5;
        const oppOvr = (opp.overall || 50) / 100;

        if (won) {
          let q = oppOvr * 0.85;
          if (isPowerOrND(opp)) q += 0.22;
          if ((opp.overall || 0) >= 88) q += 0.28;
          else if ((opp.overall || 0) >= 80) q += 0.16;
          else if ((opp.overall || 0) >= 72) q += 0.06;
          q += oppPct * 0.35;
          // Top-tier win (e.g. OSU-caliber) lands hard
          if ((opp.overall || 0) >= 88 && isPowerOrND(opp)) q += 0.18;
          qwRaw += q;
          qwCount++;
        } else {
          // Losing to a weak non-P4 team hurts more than losing to elite
          if (!isPowerOrND(opp) && (opp.overall || 50) < 68) badLossPenalty += 0.12;
          else if (!isPowerOrND(opp) && oppPct < 0.4) badLossPenalty += 0.06;
        }
      }
      // Average quality × diminishing returns on volume, scale 0–1-ish
      const qwAvg = qwCount ? qwRaw / Math.max(qwCount, 1) : 0;
      const qwVolume = 1 - Math.exp(-(qwRaw) / 2.8);
      const qualityWins = clamp(qwAvg * 0.45 + qwVolume * 0.55, 0, 1.15);

      const p4Hot = prestige >= 1.0 && games >= 9 && winPct >= 0.9 ? 3.5 : 0;
      const p4Perfect = prestige >= 1.0 && games >= 9 && winPct >= 0.99 ? 2.5 : 0;

      const score =
        winPct * 26 +
        confStrength * 20 +
        qualityWins * 24 +
        sos * 16 +
        marginScore * 6 +
        remStr * 4 +
        apSeed * 4 +
        p4Hot +
        p4Perfect -
        badLossPenalty * 8;

      return {
        id,
        score,
        rec,
        winPct,
        sos: sos * 100,
        avgMargin,
        confStrength,
        qualityWins,
        prestige,
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.rec.w !== a.rec.w) return b.rec.w - a.rec.w;
      if ((b.qualityWins || 0) !== (a.qualityWins || 0)) return (b.qualityWins || 0) - (a.qualityWins || 0);
      return b.rec.margin - a.rec.margin;
    });
    return scored.map((row, i) => ({ rank: i + 1, ...row }));
  }

  /**
   * Aggregate season player stats from box-score leaders.
   * Tracks games played (gp) and exposes per-game rates (ypg / tdpg).
   * FBS leaders are sorted by YPG with min-game / attempt qualifiers.
   */
  function accumulateSeasonStats(results, teamIds) {
    const byTeam = {};
    const ensure = (tid) => {
      if (!byTeam[tid]) {
        byTeam[tid] = { passing: {}, rushing: {}, receiving: {} };
      }
      return byTeam[tid];
    };
    const addPass = (bucket, p) => {
      if (!p || !p.name) return;
      const row = bucket[p.name] || { name: p.name, gp: 0, comp: 0, att: 0, yds: 0, td: 0, int: 0 };
      row.gp += 1;
      row.comp += p.comp || 0;
      row.att += p.att || 0;
      row.yds += p.yds || 0;
      row.td += p.td || 0;
      row.int += p.int || 0;
      bucket[p.name] = row;
    };
    const addRush = (bucket, p) => {
      if (!p || !p.name) return;
      const row = bucket[p.name] || { name: p.name, gp: 0, att: 0, yds: 0, td: 0 };
      row.gp += 1;
      row.att += p.att || 0;
      row.yds += p.yds || 0;
      row.td += p.td || 0;
      bucket[p.name] = row;
    };
    const addRec = (bucket, p) => {
      if (!p || !p.name) return;
      const row = bucket[p.name] || { name: p.name, gp: 0, rec: 0, yds: 0, td: 0 };
      row.gp += 1;
      row.rec += p.rec || 0;
      row.yds += p.yds || 0;
      row.td += p.td || 0;
      bucket[p.name] = row;
    };

    for (const g of results) {
      const sides = [
        { tid: g.homeId, leaders: g.homeLeaders },
        { tid: g.awayId, leaders: g.awayLeaders },
      ];
      for (const side of sides) {
        if (!side.leaders) continue;
        if (teamIds && teamIds.length && !teamIds.includes(side.tid)) continue;
        const b = ensure(side.tid);
        addPass(b.passing, side.leaders.passing);
        (side.leaders.rushing || []).forEach((p) => addRush(b.rushing, p));
        (side.leaders.receiving || []).forEach((p) => addRec(b.receiving, p));
      }
    }

    function withRates(row) {
      const gp = row.gp || 0;
      return {
        ...row,
        gp,
        ypg: gp ? row.yds / gp : 0,
        tdpg: gp ? row.td / gp : 0,
      };
    }

    function toSorted(map, key) {
      return Object.values(map)
        .map(withRates)
        .sort((a, b) => (b[key] || 0) - (a[key] || 0) || (b.td || 0) - (a.td || 0) || (b.yds || 0) - (a.yds || 0));
    }

    function maxGp(rows) {
      return rows.reduce((m, r) => Math.max(m, r.gp || 0), 0);
    }

    /** Min games so one-game flukes do not top boards; soft early in season. */
    function minGamesFor(rows) {
      const peak = maxGp(rows);
      if (peak >= 6) return 4;
      if (peak >= 3) return 3;
      return Math.max(1, peak);
    }

    function qualify(rows, kind) {
      const minG = minGamesFor(rows);
      return rows.filter((p) => {
        if ((p.gp || 0) < minG) return false;
        if (kind === "pass") return (p.att || 0) >= minG * 10;
        if (kind === "rush") return (p.att || 0) >= minG * 5;
        if (kind === "rec") return (p.rec || 0) >= minG * 2;
        return true;
      });
    }

    function leadersByYpg(map, kind) {
      const all = toSorted(map, "yds");
      return qualify(all, kind).sort(
        (a, b) => (b.ypg || 0) - (a.ypg || 0) || (b.yds || 0) - (a.yds || 0) || (b.td || 0) - (a.td || 0)
      );
    }

    const fbsLeaders = { passing: {}, rushing: {}, receiving: {} };
    for (const tid of Object.keys(byTeam)) {
      const b = byTeam[tid];
      Object.values(b.passing).forEach((p) => {
        fbsLeaders.passing[p.name + "|" + tid] = { ...p, teamId: tid };
      });
      Object.values(b.rushing).forEach((p) => {
        fbsLeaders.rushing[p.name + "|" + tid] = { ...p, teamId: tid };
      });
      Object.values(b.receiving).forEach((p) => {
        fbsLeaders.receiving[p.name + "|" + tid] = { ...p, teamId: tid };
      });
    }

    const passPool = Object.values(fbsLeaders.passing).map(withRates);
    const rushPool = Object.values(fbsLeaders.rushing).map(withRates);
    const recPool = Object.values(fbsLeaders.receiving).map(withRates);

    return {
      byTeam,
      qualifiers: {
        passing: { minGames: minGamesFor(passPool), minAttPerGame: 10 },
        rushing: { minGames: minGamesFor(rushPool), minAttPerGame: 5 },
        receiving: { minGames: minGamesFor(recPool), minRecPerGame: 2 },
      },
      leaders: {
        passing: leadersByYpg(fbsLeaders.passing, "pass"),
        rushing: leadersByYpg(fbsLeaders.rushing, "rush"),
        receiving: leadersByYpg(fbsLeaders.receiving, "rec"),
      },
      teamLeaders(teamId) {
        const b = byTeam[teamId] || { passing: {}, rushing: {}, receiving: {} };
        return {
          // Team view: lead with YPG, light floor so empty rows stay out
          passing: toSorted(b.passing, "yds").filter((p) => (p.att || 0) > 0).sort((a, b) => b.ypg - a.ypg || b.yds - a.yds),
          rushing: toSorted(b.rushing, "yds").filter((p) => (p.att || 0) > 0).sort((a, b) => b.ypg - a.ypg || b.yds - a.yds),
          receiving: toSorted(b.receiving, "yds").filter((p) => (p.rec || 0) > 0).sort((a, b) => b.ypg - a.ypg || b.yds - a.yds),
        };
      },
    };
  }

  function conferenceStandings(confId, fbsIds, teams, results) {
    return fbsIds
      .map((id) => teams[id])
      .filter((t) => t && t.conferenceId === confId)
      .map((t) => {
        const conf = conferenceRecord(results, t.id, teams);
        const rec = teamRecord(results.filter((g) => !g.bowl), t.id);
        return { team: t, conf, rec };
      })
      .sort((a, b) => {
        const aw = a.conf.w + a.conf.l ? a.conf.w / (a.conf.w + a.conf.l) : 0;
        const bw = b.conf.w + b.conf.l ? b.conf.w / (b.conf.w + b.conf.l) : 0;
        if (bw !== aw) return bw - aw;
        if (b.conf.w !== a.conf.w) return b.conf.w - a.conf.w;
        if (b.rec.w !== a.rec.w) return b.rec.w - a.rec.w;
        return b.rec.margin - a.rec.margin;
      });
  }

  /**
   * Build conference championship slate: #1 vs #2 by conference standings
   * for every conference with ≥ 4 teams (skip Independents).
   */
  function buildConferenceChampionships(fbsIds, teams, results, conferences) {
    const games = [];
    for (const conf of conferences) {
      if (conf.id === INDEPENDENT) continue;
      const standings = conferenceStandings(conf.id, fbsIds, teams, results);
      if (standings.length < 4) continue;
      const a = standings[0].team;
      const b = standings[1].team;
      games.push({
        eventId: "cc-" + conf.id,
        round: "conf-champ",
        label: conf.name + " Championship",
        bowl: null,
        homeId: a.id,
        awayId: b.id,
        neutralSite: true,
        week: "CC",
      });
    }
    return games;
  }

  /**
   * 2026 CFP selection (simplified to match real format):
   * Auto bids: ACC / Big Ten / Big 12 / SEC champions + highest-ranked G6 team
   *            (G6 auto bid is best-ranked team from G6 conferences, champ or not).
   * At-large: next highest-ranked teams to fill 12.
   * Seeds 1–4 by ranking get first-round byes.
   * First round: 5v12, 6v11, 7v10, 8v9 (higher seed home).
   */
  function selectCfpField(ranked, teams, conferenceChamps) {
    const byId = {};
    ranked.forEach((r) => { byId[r.id] = r; });

    const field = [];
    const used = new Set();

    function add(id, autoBid, reason) {
      if (!id || used.has(id)) return false;
      used.add(id);
      field.push({
        teamId: id,
        autoBid: !!autoBid,
        reason: reason || (autoBid ? "auto" : "at-large"),
        rank: byId[id] ? byId[id].rank : 99,
      });
      return true;
    }

    // Power 4 conference champions
    for (const confId of ["1", "5", "4", "8"]) {
      const champ = conferenceChamps[confId];
      if (champ) add(champ, true, "P4 champion");
    }

    // Highest-ranked G6 team (any G6 school)
    const g6Best = ranked.find((r) => G6.has(teams[r.id].conferenceId));
    if (g6Best) add(g6Best.id, true, "G6 auto bid");

    // At-large fill to 12 (includes Notre Dame / independents / remaining P4 / G6)
    for (const r of ranked) {
      if (field.length >= 12) break;
      add(r.id, false, "at-large");
    }

    // Seed by ranking (committee proxy = sim poll)
    field.sort((a, b) => a.rank - b.rank);
    field.forEach((f, i) => { f.seed = i + 1; });
    return field;
  }

  function winnerId(box) {
    return box.homeScore > box.awayScore ? box.homeId : box.awayId;
  }

  /**
   * Build full postseason package after regular season (+ optional conf champs already simmed).
   * conferenceChamps: { confId: teamId }
   * Returns { field, firstRound, bowls, quartersMeta, semisMeta, championshipMeta }
   */
  function buildPostseason(ranked, teams, conferenceChamps, postseasonMeta, results) {
    const field = selectCfpField(ranked, teams, conferenceChamps);
    const seedMap = {};
    field.forEach((f) => { seedMap[f.seed] = f.teamId; });

    const firstRound = [
      { eventId: "cfp-r1-5-12", seedHome: 5, seedAway: 12 },
      { eventId: "cfp-r1-6-11", seedHome: 6, seedAway: 11 },
      { eventId: "cfp-r1-7-10", seedHome: 7, seedAway: 10 },
      { eventId: "cfp-r1-8-9", seedHome: 8, seedAway: 9 },
    ].map((g) => ({
      eventId: g.eventId,
      round: "cfp-first",
      label: "CFP First Round",
      bowl: null,
      homeId: seedMap[g.seedHome],
      awayId: seedMap[g.seedAway],
      seedHome: g.seedHome,
      seedAway: g.seedAway,
      neutralSite: false,
      week: "PS1",
    }));

    const cfpBowls = (postseasonMeta.cfpBowls || []).slice();
    // Quarters: winners of first round vs seeds 1-4
    // Bracket: 1 vs winner(8/9), 4 vs winner(5/12), 2 vs winner(7/10), 3 vs winner(6/11)
    const quarterSlots = [
      { eventId: "cfp-qf-1", byeSeed: 1, fromGame: "cfp-r1-8-9", bowl: cfpBowls[0] },
      { eventId: "cfp-qf-2", byeSeed: 4, fromGame: "cfp-r1-5-12", bowl: cfpBowls[1] },
      { eventId: "cfp-qf-3", byeSeed: 2, fromGame: "cfp-r1-7-10", bowl: cfpBowls[2] },
      { eventId: "cfp-qf-4", byeSeed: 3, fromGame: "cfp-r1-6-11", bowl: cfpBowls[3] },
    ];

    const otherBowlDefs = postseasonMeta.otherBowls || [];
    const cfpIds = new Set(field.map((f) => f.teamId));
    // Bowl-eligible: FBS, ≥ 6 wins, not in CFP
    const eligible = ranked
      .filter((r) => {
        if (cfpIds.has(r.id)) return false;
        const rec = teamRecord(results.filter((g) => !g.bowl || g.round === "conf-champ"), r.id);
        return rec.w >= 6;
      })
      .map((r) => r.id);

    const bowls = [];
    for (let i = 0; i + 1 < eligible.length && bowls.length < otherBowlDefs.length; i += 2) {
      const def = otherBowlDefs[bowls.length];
      bowls.push({
        eventId: "bowl-" + def.id,
        round: "bowl",
        label: def.name,
        bowl: def.name,
        homeId: eligible[i],
        awayId: eligible[i + 1],
        neutralSite: true,
        week: "BOWL",
      });
    }

    return {
      field,
      firstRound,
      quarterSlots,
      bowls,
      cfpBowlNames: cfpBowls.map((b) => b.name),
      semiBowlNames: [cfpBowls[4] ? cfpBowls[4].name : "Rose Bowl", cfpBowls[5] ? cfpBowls[5].name : "Sugar Bowl"],
      championshipName: (postseasonMeta.championship && postseasonMeta.championship.name) || "CFP National Championship",
    };
  }

  function buildQuarterfinals(pkg, resultsById, seedMap) {
    return pkg.quarterSlots.map((slot, idx) => {
      const fr = resultsById[slot.fromGame];
      const opp = fr ? winnerId(fr) : null;
      const bye = seedMap[slot.byeSeed];
      return {
        eventId: slot.eventId,
        round: "cfp-quarters",
        label: slot.bowl ? slot.bowl.name : "CFP Quarterfinal",
        bowl: slot.bowl ? slot.bowl.name : null,
        homeId: bye,
        awayId: opp,
        neutralSite: true,
        week: "PS2",
        byeSeed: slot.byeSeed,
      };
    });
  }

  function buildSemifinals(qfResults, pkg) {
    // Pair QF winners: qf-1 vs qf-2, qf-3 vs qf-4
    const order = ["cfp-qf-1", "cfp-qf-2", "cfp-qf-3", "cfp-qf-4"];
    const winners = order.map((id) => {
      const box = qfResults[id];
      return box ? winnerId(box) : null;
    });
    return [
      {
        eventId: "cfp-sf-1",
        round: "cfp-semis",
        label: pkg.semiBowlNames[0] || "CFP Semifinal",
        bowl: pkg.semiBowlNames[0] || "Rose Bowl",
        homeId: winners[0],
        awayId: winners[1],
        neutralSite: true,
        week: "PS3",
      },
      {
        eventId: "cfp-sf-2",
        round: "cfp-semis",
        label: pkg.semiBowlNames[1] || "CFP Semifinal",
        bowl: pkg.semiBowlNames[1] || "Sugar Bowl",
        homeId: winners[2],
        awayId: winners[3],
        neutralSite: true,
        week: "PS3",
      },
    ];
  }

  function buildChampionship(sfResults, pkg) {
    const w1 = sfResults["cfp-sf-1"] ? winnerId(sfResults["cfp-sf-1"]) : null;
    const w2 = sfResults["cfp-sf-2"] ? winnerId(sfResults["cfp-sf-2"]) : null;
    return {
      eventId: "cfp-championship",
      round: "cfp-championship",
      label: pkg.championshipName,
      bowl: pkg.championshipName,
      homeId: w1,
      awayId: w2,
      neutralSite: true,
      week: "PS4",
    };
  }

  function seasonRecap(teamId, teams, results, ranked, postseason) {
    const t = teams[teamId];
    const allRec = teamRecord(results, teamId);
    const conf = conferenceRecord(results, teamId, teams);
    const pollRow = ranked.find((r) => r.id === teamId);
    const finalRank = pollRow && pollRow.rank <= 25 ? pollRow.rank : null;

    // Find postseason outcome
    let bowlResult = "Did not bowl";
    const myPost = results.filter(
      (g) =>
        (g.homeId === teamId || g.awayId === teamId) &&
        (g.bowl || (g.round && g.round !== "conf-champ"))
    );
    const confChampGame = results.find(
      (g) => g.round === "conf-champ" && (g.homeId === teamId || g.awayId === teamId)
    );
    let confChampNote = null;
    if (confChampGame) {
      const won = winnerId(confChampGame) === teamId;
      confChampNote = won ? "Won conference championship" : "Lost conference championship";
    }

    if (myPost.length) {
      const last = myPost[myPost.length - 1];
      const won = winnerId(last) === teamId;
      const name = last.bowl || last.label || "bowl";
      if (last.round === "cfp-championship") {
        bowlResult = won ? "Won CFP National Championship" : "Lost CFP National Championship";
      } else if (last.round && String(last.round).startsWith("cfp")) {
        bowlResult = won ? "Won " + name : "Lost " + name;
        // If they won a round but didn't play further, still show last game
      } else {
        bowlResult = won ? "Won " + name : "Lost " + name;
      }
    }

    // Best win: highest-ranked opponent defeated (by final poll)
    let bestWin = null;
    for (const g of results) {
      if (g.homeId !== teamId && g.awayId !== teamId) continue;
      if (winnerId(g) !== teamId) continue;
      const oppId = g.homeId === teamId ? g.awayId : g.homeId;
      const oppRank = ranked.find((r) => r.id === oppId);
      if (!oppRank) continue;
      if (!bestWin || oppRank.rank < bestWin.rank) {
        bestWin = { rank: oppRank.rank, name: teams[oppId].shortName || teams[oppId].name, score: (g.homeId === teamId ? g.homeScore : g.awayScore) + "-" + (g.homeId === teamId ? g.awayScore : g.homeScore) };
      }
    }

    const summaryParts = [];
    if (bestWin && bestWin.rank <= 25) {
      summaryParts.push("Best win: #" + bestWin.rank + " " + bestWin.name + " (" + bestWin.score + ")");
    }
    if (confChampNote) summaryParts.push(confChampNote);

    return {
      teamId,
      name: t.shortName || t.name,
      fullName: t.name,
      record: allRec,
      confRecord: conf,
      conference: t.conference,
      finalRank,
      bowlResult,
      confChampNote,
      bestWin,
      summary: summaryParts.join(" · ") || null,
    };
  }

  global.CFBSim = {
    simulateGame,
    teamRecord,
    conferenceRecord,
    computeTop25,
    accumulateSeasonStats,
    isPowerOrND,
    confPrestige,
    hashSeed,
    conferenceStandings,
    buildConferenceChampionships,
    selectCfpField,
    buildPostseason,
    buildQuarterfinals,
    buildSemifinals,
    buildChampionship,
    seasonRecap,
    winnerId,
    POWER4,
    G6,
  };
})(window);
