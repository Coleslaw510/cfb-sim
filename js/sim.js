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

  /** Normalize ESPN class year (FR/SO/JR/SR/RS…). */
  function normalizeClass(c) {
    if (!c) return "";
    const u = String(c).trim().toUpperCase();
    if (/^(FR|SO|JR|SR|RS)$/.test(u)) return u;
    if (u.startsWith("RS-") || u.startsWith("RS ")) {
      const rest = u.replace(/^RS[\s-]+/, "");
      if (/^(FR|SO|JR|SR)$/.test(rest)) return "RS-" + rest;
      return "RS";
    }
    if (u.includes("FRESH")) return "FR";
    if (u.includes("SOPH")) return "SO";
    if (u.includes("JUNIOR")) return "JR";
    if (u.includes("SENIOR")) return "SR";
    if (u.includes("REDSHIRT")) return "RS";
    return u.slice(0, 6);
  }

  /** Resolve a depth-chart player { name, class }; fall back to generic. */
  function depthPlayer(roster, pos, slot, rng) {
    if (roster && roster.depth && roster.players) {
      const idxs = roster.depth[pos] || [];
      const tryIdx = (i) => {
        const p = roster.players[i];
        if (!p) return null;
        return { name: p.n, class: normalizeClass(p.c), ovr: p.ovr != null ? Number(p.ovr) : null };
      };
      if (idxs[slot] != null) {
        const hit = tryIdx(idxs[slot]);
        if (hit) return hit;
      }
      for (let i = 0; i < idxs.length; i++) {
        const hit = tryIdx(idxs[i]);
        if (hit) return hit;
      }
    }
    return { name: pickName(rng), class: "", ovr: null };
  }

  function depthName(roster, pos, slot, rng) {
    return depthPlayer(roster, pos, slot, rng).name;
  }

  /**
   * Expected team points for modern FBS scoring (~27 PPG league average).
   * Slightly under the prior ~29 PPG / ~58 totals tune — not a return to low-scoring.
   * Ratings in this dataset center near ~60, not 50.
   */
  function expectedPoints(off, def, homeBoost) {
    const base = 23.4 + (off - 60) * 0.47 - (def - 60) * 0.40 + homeBoost;
    return clamp(base, 10, 54);
  }


  /**
   * Realistic college football overtime.
   * Each OT period both teams get the same number of possessions (or 2-pt tries),
   * so you cannot "lose by 10 in OT" from unequal period counts.
   */
  function simulateCollegeOT(homeExp, awayExp, rng) {
    function possessionPoints(offenseExp, defenseExp) {
      // From the opponent 25: modern CFB OT scoring rates are high
      const edge = (offenseExp - defenseExp) * 0.012;
      const pScore = clamp(0.78 + edge, 0.55, 0.92);
      const pTdGivenScore = clamp(0.62 + edge * 0.5, 0.45, 0.78);
      const r = rng();
      if (r < pScore * pTdGivenScore) return 7;
      if (r < pScore) return 3;
      return 0;
    }
    function twoPoint(offenseExp, defenseExp) {
      const edge = (offenseExp - defenseExp) * 0.01;
      return rng() < clamp(0.42 + edge, 0.28, 0.58) ? 2 : 0;
    }
    let home = 0;
    let away = 0;
    let period = 0;
    while (period < 12) {
      period += 1;
      if (period <= 2) {
        home += possessionPoints(homeExp, awayExp);
        away += possessionPoints(awayExp, homeExp);
      } else {
        home += twoPoint(homeExp, awayExp);
        away += twoPoint(awayExp, homeExp);
      }
      if (home !== away) break;
    }
    // Extremely rare safety: force a deciding 2-pt for home if still tied
    if (home === away) {
      home += 2;
    }
    return { home, away, periods: period };
  }

  function simulateGame(homeTeam, awayTeam, meta) {
    const seed = hashSeed(
      String(meta.eventId) + "|" + String(meta.week) + "|" + String(meta.seasonSeed || 0)
    );
    const rng = mulberry32(seed);

    const homeBoost = meta.neutralSite ? 0 : 2.2;
    const homeExp = expectedPoints(homeTeam.offense, awayTeam.defense, homeBoost);
    const awayExp = expectedPoints(awayTeam.offense, homeTeam.defense, 0);

    // Modern CFB: ~11–14 possessions per side is common
    const homeDrives = 11 + Math.floor(rng() * 4);
    const awayDrives = 11 + Math.floor(rng() * 4);

    function scoreFromDrives(expPts, drives) {
      let pts = 0;
      let td = 0;
      let fg = 0;
      let to = 0;
      // ~5.45 pts per scoring drive on avg (mix of TDs/FGs) → divisor tracks expPts
      const pScore = clamp(expPts / (drives * 5.45), 0.22, 0.78);
      // Game-script variance: some days offenses click / stall without wall-to-wall shootouts
      const tempo = clamp(0.90 + rng() * 0.22, 0.88, 1.14);
      const pAdj = clamp(pScore * tempo, 0.18, 0.82);
      for (let i = 0; i < drives; i++) {
        const r = rng();
        // ~70% of scoring drives are TDs in modern FBS
        if (r < pAdj * 0.70) {
          pts += 7;
          td += 1;
        } else if (r < pAdj) {
          pts += 3;
          fg += 1;
        } else if (r < pAdj + 0.07) {
          to += 1;
        }
      }
      if (rng() < 0.045) pts += 2; // safety
      return { pts, td, fg, to };
    }

    let homeS = scoreFromDrives(homeExp, homeDrives);
    let awayS = scoreFromDrives(awayExp, awayDrives);

    // Avoid ultra-low combined totals that feel pre-spread-era
    if (homeS.pts + awayS.pts < 21) {
      if (rng() < 0.5) homeS.pts += 7;
      else awayS.pts += 7;
    }

    // College OT: equal possessions each period from the opponent ~25.
    // Periods 1–2: possession → TD (7) / FG (3) / no score (0).
    // Period 3+: alternating 2-point tries only (0 or 2). Margins stay small.
    let ot = false;
    let otPeriods = 0;
    if (homeS.pts === awayS.pts) {
      ot = true;
      const otResult = simulateCollegeOT(homeExp, awayExp, rng);
      homeS.pts += otResult.home;
      awayS.pts += otResult.away;
      otPeriods = otResult.periods;
    }

    function yardsBundle(pts, off, def, isHome) {
      // Modern FBS lean pass-first but still allows grind-it-out / option looks
      const passShare = clamp(0.58 + (rng() - 0.5) * 0.22 + (off - 60) * 0.0015, 0.44, 0.74);
      const totalOff = clamp(
        370 + (off - def) * 3.6 + (pts - 27) * 6.8 + (rng() - 0.5) * 75,
        190,
        700
      );
      let passYds = Math.round(totalOff * passShare);
      let rushYds = Math.round(totalOff - passYds);
      // Soft floor: teams that put up points should rarely be stuck under ~100 pass yards
      if (pts >= 17 && passYds < 105) {
        const bump = 105 - passYds + Math.floor(rng() * 25);
        passYds += bump;
        rushYds = Math.max(40, rushYds - Math.floor(bump * 0.35));
      } else if (pts >= 28 && passYds < 150) {
        const bump = 150 - passYds + Math.floor(rng() * 30);
        passYds += bump;
        rushYds = Math.max(50, rushYds - Math.floor(bump * 0.3));
      }
      // Target ~6.5–8.0 YPA for average/good offenses; derive attempts from yards
      const ypa = clamp(
        6.5 + (off - 60) * 0.04 + (pts - 27) * 0.03 + (rng() - 0.5) * 1.5,
        4.5,
        11.8
      );
      const passAtt = clamp(Math.round(passYds / ypa + (rng() - 0.5) * 3), 18, 58);
      const completions = clamp(
        Math.round(passAtt * (0.615 + (off - 60) * 0.0028 + (rng() - 0.5) * 0.07)),
        9,
        passAtt - 1
      );
      const rushAtt = clamp(Math.round(29 + (1 - passShare) * 18 + (rng() - 0.5) * 6), 20, 55);
      const interceptions = Math.max(0, Math.round((rng() < 0.32 ? 1 : 0) + (rng() < 0.10 ? 1 : 0)));
      const fumblesLost = Math.max(0, (rng() < 0.25 ? 1 : 0) + (rng() < 0.07 ? 1 : 0));
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
        thirdDownConv: clamp(Math.round(4 + rng() * 9), 2, 14),
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
      const qb = depthPlayer(roster, "QB", 0, rng);
      const rb1 = depthPlayer(roster, "RB", 0, rng);
      const rb2 = depthPlayer(roster, "RB", 1, rng);
      const wr1 = depthPlayer(roster, "WR", 0, rng);
      const wr2 = depthPlayer(roster, "WR", 1, rng);
      const te1 = depthPlayer(roster, "TE", 0, rng);
      const passTds = clamp(Math.round(pts / 10 + (rng() - 0.4)), 0, 5);
      const rushTds = Math.max(0, Math.round(pts / 14) - Math.floor(passTds * 0.4));
      const rush1 = Math.round(yds.rushYds * (0.55 + rng() * 0.2));
      const rush2 = Math.max(8, yds.rushYds - rush1 - Math.round(rng() * 20));
      const recYds = Math.round(yds.passYds * (0.28 + rng() * 0.15));
      const recYds2 = Math.round(yds.passYds * (0.18 + rng() * 0.1));
      // Prefer WR; occasionally TE for receiving leader
      const recP = rng() < 0.18 ? te1 : wr1;
      return {
        passing: { name: qb.name, class: qb.class, comp: yds.completions, att: yds.passAtt, yds: yds.passYds, td: passTds, int: yds.interceptions },
        rushing: [
          { name: rb1.name, class: rb1.class, att: Math.round(yds.rushAtt * 0.55), yds: rush1, td: Math.min(rushTds, 2) },
          { name: rb2.name, class: rb2.class, att: Math.max(3, yds.rushAtt - Math.round(yds.rushAtt * 0.55) - 4), yds: Math.max(0, rush2), td: Math.max(0, rushTds - 2) },
        ],
        receiving: [
          { name: recP.name, class: recP.class, rec: clamp(Math.round(3 + rng() * 6), 2, 10), yds: recYds, td: Math.min(passTds, 2) },
          { name: wr2.name, class: wr2.class, rec: clamp(Math.round(2 + rng() * 5), 1, 8), yds: recYds2, td: Math.max(0, Math.min(passTds - 1, 1)) },
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
      otPeriods,
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
   * Tracks games played (gp) and class year when present.
   * FBS leaders are sorted by season totals (yards) with min-game / attempt qualifiers.
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
      const row = bucket[p.name] || { name: p.name, class: "", gp: 0, comp: 0, att: 0, yds: 0, td: 0, int: 0 };
      row.gp += 1;
      if (!row.class && p.class) row.class = normalizeClass(p.class);
      row.comp += p.comp || 0;
      row.att += p.att || 0;
      row.yds += p.yds || 0;
      row.td += p.td || 0;
      row.int += p.int || 0;
      bucket[p.name] = row;
    };
    const addRush = (bucket, p) => {
      if (!p || !p.name) return;
      const row = bucket[p.name] || { name: p.name, class: "", gp: 0, att: 0, yds: 0, td: 0 };
      row.gp += 1;
      if (!row.class && p.class) row.class = normalizeClass(p.class);
      row.att += p.att || 0;
      row.yds += p.yds || 0;
      row.td += p.td || 0;
      bucket[p.name] = row;
    };
    const addRec = (bucket, p) => {
      if (!p || !p.name) return;
      const row = bucket[p.name] || { name: p.name, class: "", gp: 0, rec: 0, yds: 0, td: 0 };
      row.gp += 1;
      if (!row.class && p.class) row.class = normalizeClass(p.class);
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

    function leadersByTotals(map, kind) {
      const all = toSorted(map, "yds");
      return qualify(all, kind).sort(
        (a, b) => (b.yds || 0) - (a.yds || 0) || (b.td || 0) - (a.td || 0) || (b.gp || 0) - (a.gp || 0)
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
        passing: leadersByTotals(fbsLeaders.passing, "pass"),
        rushing: leadersByTotals(fbsLeaders.rushing, "rush"),
        receiving: leadersByTotals(fbsLeaders.receiving, "rec"),
      },
      teamLeaders(teamId) {
        const b = byTeam[teamId] || { passing: {}, rushing: {}, receiving: {} };
        return {
          // Team view: season totals (yards), light floor so empty rows stay out
          passing: toSorted(b.passing, "yds").filter((p) => (p.att || 0) > 0),
          rushing: toSorted(b.rushing, "yds").filter((p) => (p.att || 0) > 0),
          receiving: toSorted(b.receiving, "yds").filter((p) => (p.rec || 0) > 0),
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


  /* ------------------------------------------------------------------ */
  /* Multi-year schedule generation (season 2+)                          */
  /* ------------------------------------------------------------------ */

  /** Target conference games per team from real 2026 slate modes. */
  const CONF_GAME_TARGETS = {
    "151": 8, // American
    "1": 9,   // ACC
    "4": 9,   // Big 12
    "5": 9,   // Big Ten
    "12": 8,  // CUSA
    "18": 0,  // Independents
    "15": 8,  // MAC
    "17": 8,  // Mountain West
    "9": 7,   // Pac-12
    "8": 9,   // SEC
    "37": 8,  // Sun Belt
  };

  const TOTAL_GAMES_TARGET = 12;

  /**
   * Protected rivalry pairs (shortName aliases). Applied when both teams exist.
   * Same-conference rivals count toward conf games; cross-conf count as non-conf.
   * `neutral: true` → neutral-site game.
   */
  const RIVALRY_DEFS = [
    { a: "Michigan", b: "Ohio State" },
    { a: "Alabama", b: "Auburn" },
    { a: "Iowa", b: "Iowa State" },
    { a: "Texas", b: "Oklahoma", neutral: true },
    { a: "USC", b: "UCLA" },
    { a: "Georgia", b: "Florida", neutral: true },
    { a: "Michigan", b: "Michigan State" },
    { a: "Ohio State", b: "Michigan State" },
    { a: "Penn State", b: "Ohio State" },
    { a: "Penn State", b: "Michigan State" },
    { a: "Clemson", b: "South Carolina" },
    { a: "Florida", b: "Florida State" },
    { a: "Georgia", b: "Georgia Tech" },
    { a: "Notre Dame", b: "USC" },
    { a: "Notre Dame", b: "Navy" },
    { a: "Notre Dame", b: "Stanford" },
    { a: "Texas", b: "Texas A&M" },
    { a: "Oklahoma", b: "Oklahoma State" },
    { a: "Ole Miss", b: "Mississippi State" },
    { a: "LSU", b: "Alabama" },
    { a: "LSU", b: "Florida" },
    { a: "Tennessee", b: "Alabama" },
    { a: "Auburn", b: "Georgia" },
    { a: "Kentucky", b: "Louisville" },
    { a: "Oregon", b: "Oregon State" },
    { a: "Washington", b: "Washington State" },
    { a: "Wisconsin", b: "Minnesota" },
    { a: "Nebraska", b: "Iowa" },
    { a: "Indiana", b: "Purdue" },
    { a: "Illinois", b: "Northwestern" },
    { a: "BYU", b: "Utah" },
    { a: "Utah", b: "Colorado" },
    { a: "Arizona", b: "Arizona St" },
    { a: "Arizona", b: "Arizona State" },
    { a: "Kansas", b: "Kansas State" },
    { a: "Missouri", b: "Kansas" },
    { a: "Baylor", b: "TCU" },
    { a: "Texas Tech", b: "Texas" },
    { a: "Virginia", b: "Virginia Tech" },
    { a: "North Carolina", b: "NC State" },
    { a: "North Carolina", b: "Duke" },
    { a: "Stanford", b: "California" },
    { a: "Pitt", b: "West Virginia" },
    { a: "Miami", b: "Florida State" },
    { a: "Boise St", b: "Fresno St" },
    { a: "Army", b: "Navy", neutral: true },
    { a: "Army", b: "Air Force" },
    { a: "Navy", b: "Air Force" },
    { a: "Cincinnati", b: "Louisville" },
    { a: "Memphis", b: "UCF" },
    { a: "SMU", b: "Houston" },
    { a: "Colorado", b: "Nebraska" },
    { a: "Florida State", b: "Clemson" },
    { a: "Oregon", b: "Washington" },
    { a: "Michigan", b: "Penn State" },
    { a: "Ohio State", b: "Wisconsin" },
    { a: "Alabama", b: "Georgia" },
    { a: "Texas A&M", b: "LSU" },
    { a: "South Carolina", b: "Georgia" },
    { a: "Wake Forest", b: "Duke" },
    { a: "Boston College", b: "Syracuse" },
    { a: "Rutgers", b: "Maryland" },
    { a: "UConn", b: "UCF" },
  ];

  const NAME_ALIASES = {
    "florida state": ["Florida State", "Florida St"],
    "michigan state": ["Michigan State", "Michigan St"],
    "oklahoma state": ["Oklahoma State", "Oklahoma St"],
    "mississippi state": ["Mississippi State", "Mississippi St"],
    "oregon state": ["Oregon State", "Oregon St"],
    "washington state": ["Washington State", "Washington St"],
    "arizona state": ["Arizona State", "Arizona St"],
    "kansas state": ["Kansas State", "Kansas St"],
    "florida atlantic": ["Florida Atlantic", "FAU"],
    "cal": ["California", "Cal"],
  };

  function buildNameIndex(teams, fbsIds) {
    const idx = {};
    for (const id of fbsIds) {
      const t = teams[id];
      if (!t) continue;
      const keys = [t.shortName, t.name, t.abbreviation, t.displayName]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      for (const k of keys) idx[k] = id;
    }
    return idx;
  }

  function resolveTeamId(nameIndex, name) {
    if (!name) return null;
    const key = String(name).toLowerCase();
    if (nameIndex[key]) return nameIndex[key];
    const aliases = NAME_ALIASES[key] || [name];
    for (const a of aliases) {
      const hit = nameIndex[String(a).toLowerCase()];
      if (hit) return hit;
    }
    // partial shortName match
    for (const [k, id] of Object.entries(nameIndex)) {
      if (k === key || k.startsWith(key + " ") || key.startsWith(k + " ")) return id;
    }
    return null;
  }

  function pairKey(a, b) {
    return a < b ? a + "|" + b : b + "|" + a;
  }

  /**
   * Generate a full FBS regular-season slate for `year`.
   * Season 1 uses ESPN data; later seasons call this.
   */
  function generateSeasonSchedule(opts) {
    const teams = opts.teams;
    const fbsIds = opts.fbsTeamIds.slice();
    const year = opts.year || 2027;
    const seed = opts.seasonSeed != null ? opts.seasonSeed : hashSeed(String(year));
    const rng = mulberry32(seed >>> 0);
    const nameIndex = buildNameIndex(teams, fbsIds);
    const fbsSet = new Set(fbsIds);

    const fcsPool = Object.keys(teams).filter((id) => !fbsSet.has(id));
    // shuffle FCS pool
    for (let i = fcsPool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = fcsPool[i];
      fcsPool[i] = fcsPool[j];
      fcsPool[j] = tmp;
    }
    let fcsCursor = 0;

    // Per-team bookkeeping
    const confNeed = {};
    const totalNeed = {};
    const opponents = {}; // tid -> Set
    const homeCount = {};
    const awayCount = {};
    for (const id of fbsIds) {
      const confId = teams[id].conferenceId;
      confNeed[id] = CONF_GAME_TARGETS[confId] != null ? CONF_GAME_TARGETS[confId] : 8;
      totalNeed[id] = TOTAL_GAMES_TARGET;
      opponents[id] = new Set();
      homeCount[id] = 0;
      awayCount[id] = 0;
    }

    /** Raw edges before week assignment: { homeId, awayId, neutralSite, isConf, isRivalry } */
    const edges = [];
    const edgeSet = new Set();

    function isFbs(id) {
      return fbsSet.has(id);
    }

    function canPair(a, b, asConf) {
      if (a === b) return false;
      const aF = isFbs(a);
      const bF = isFbs(b);
      if (!aF && !bF) return false;
      if (aF && opponents[a].has(b)) return false;
      if (bF && opponents[b].has(a)) return false;
      if (aF && totalNeed[a] <= 0) return false;
      if (bF && totalNeed[b] <= 0) return false;
      if (asConf) {
        if (!aF || !bF) return false;
        if (confNeed[a] <= 0 || confNeed[b] <= 0) return false;
      }
      return true;
    }

    function addEdge(homeId, awayId, meta) {
      const a = homeId;
      const b = awayId;
      const key = pairKey(a, b);
      if (edgeSet.has(key)) return false;
      if (!canPair(a, b, meta.isConf)) return false;
      edgeSet.add(key);
      if (isFbs(a)) {
        opponents[a].add(b);
        totalNeed[a]--;
        if (meta.isConf) confNeed[a]--;
        if (!meta.neutralSite) homeCount[a]++;
      }
      if (isFbs(b)) {
        opponents[b].add(a);
        totalNeed[b]--;
        if (meta.isConf) confNeed[b]--;
        if (!meta.neutralSite) awayCount[b]++;
      }
      edges.push({
        homeId,
        awayId,
        neutralSite: !!meta.neutralSite,
        isConf: !!meta.isConf,
        isRivalry: !!meta.isRivalry,
      });
      return true;
    }

    function pickHome(a, b, preferNeutral) {
      if (preferNeutral) return { homeId: a, awayId: b, neutralSite: true };
      // Balance home/away; flip by year seed for variety
      const aHomeBias = homeCount[a] - awayCount[a];
      const bHomeBias = homeCount[b] - awayCount[b];
      let aHome;
      if (aHomeBias < bHomeBias - 0.5) aHome = true;
      else if (bHomeBias < aHomeBias - 0.5) aHome = false;
      else aHome = (hashSeed(pairKey(a, b) + "|" + year) % 2) === 0;
      return aHome
        ? { homeId: a, awayId: b, neutralSite: false }
        : { homeId: b, awayId: a, neutralSite: false };
    }

    // 1) Same-conference protected rivalries first (count toward conf games)
    const crossConfRivalries = [];
    for (const def of RIVALRY_DEFS) {
      const a = resolveTeamId(nameIndex, def.a);
      const b = resolveTeamId(nameIndex, def.b);
      if (!a || !b || a === b) continue;
      if (!fbsSet.has(a) || !fbsSet.has(b)) continue;
      const sameConf =
        teams[a].conferenceId === teams[b].conferenceId &&
        teams[a].conferenceId !== "18";
      if (!sameConf) {
        crossConfRivalries.push({ a, b, neutral: !!def.neutral });
        continue;
      }
      const ha = pickHome(a, b, !!def.neutral);
      addEdge(ha.homeId, ha.awayId, {
        isConf: true,
        isRivalry: true,
        neutralSite: ha.neutralSite || !!def.neutral,
      });
    }

    // 2) Conference games — repeated greedy passes by remaining need
    const byConf = {};
    for (const id of fbsIds) {
      const c = teams[id].conferenceId;
      if (c === "18") continue;
      if (!byConf[c]) byConf[c] = [];
      byConf[c].push(id);
    }

    for (const confId of Object.keys(byConf)) {
      const members = byConf[confId];
      const n = members.length;
      const target = CONF_GAME_TARGETS[confId] != null ? CONF_GAME_TARGETS[confId] : 8;
      const hardMax = Math.min(n - 1, target + 2); // soft overflow so needy teams are not stranded

      // Track conf games placed (rivalries already counted via confNeed deltas)
      const confHave = {};
      for (const id of members) {
        confHave[id] = target - (confNeed[id] || 0);
      }

      for (let pass = 0; pass < 60; pass++) {
        const needy = members
          .filter((id) => (confHave[id] || 0) < target && (totalNeed[id] || 0) > 0)
          .sort((a, b) => (confHave[a] || 0) - (confHave[b] || 0) || rng() - 0.5);
        if (!needy.length) break;
        let progress = false;
        for (const a of needy) {
          const partners = members
            .filter(
              (b) =>
                b !== a &&
                !opponents[a].has(b) &&
                (totalNeed[b] || 0) > 0 &&
                (confHave[b] || 0) < hardMax
            )
            .sort((x, y) => (confHave[x] || 0) - (confHave[y] || 0) || rng() - 0.5);
          for (const b of partners) {
            // Temporarily allow addEdge even if confNeed[b] is 0 by bumping confNeed
            const bumpedA = confNeed[a] <= 0;
            const bumpedB = confNeed[b] <= 0;
            if (bumpedA) confNeed[a] = 1;
            if (bumpedB) confNeed[b] = 1;
            const ha = pickHome(a, b, false);
            const ok = addEdge(ha.homeId, ha.awayId, { isConf: true, isRivalry: false, neutralSite: false });
            if (!ok) {
              if (bumpedA) confNeed[a] = 0;
              if (bumpedB) confNeed[b] = 0;
              continue;
            }
            confHave[a] = (confHave[a] || 0) + 1;
            confHave[b] = (confHave[b] || 0) + 1;
            progress = true;
            break;
          }
          if (progress) break;
        }
        if (!progress) break;
      }
    }

    // 3) Cross-conference protected rivalries
    for (const r of crossConfRivalries) {
      const ha = pickHome(r.a, r.b, r.neutral);
      addEdge(ha.homeId, ha.awayId, {
        isConf: false,
        isRivalry: true,
        neutralSite: ha.neutralSite || r.neutral,
      });
    }

    // 4) Non-conference fill (FBS + occasional FCS)
    function remainingList() {
      return fbsIds.filter((id) => totalNeed[id] > 0).sort((a, b) => totalNeed[b] - totalNeed[a]);
    }

    let guard = 0;
    while (guard++ < 8000) {
      const needers = remainingList();
      if (!needers.length) break;
      let placed = false;
      for (const a of needers) {
        if (totalNeed[a] <= 0) continue;
        const cands = fbsIds.filter(
          (b) =>
            b !== a &&
            totalNeed[b] > 0 &&
            !opponents[a].has(b) &&
            (teams[a].conferenceId === "18" ||
              teams[b].conferenceId === "18" ||
              teams[a].conferenceId !== teams[b].conferenceId)
        );
        for (let i = cands.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          const tmp = cands[i];
          cands[i] = cands[j];
          cands[j] = tmp;
        }
        cands.sort((x, y) => {
          const dx = Math.abs((teams[x].overall || 60) - (teams[a].overall || 60));
          const dy = Math.abs((teams[y].overall || 60) - (teams[a].overall || 60));
          return dx - dy;
        });
        for (const b of cands.slice(0, 32)) {
          const ha = pickHome(a, b, false);
          if (addEdge(ha.homeId, ha.awayId, { isConf: false, isRivalry: false, neutralSite: false })) {
            placed = true;
            break;
          }
        }
        if (placed) break;
        if (fcsPool.length && totalNeed[a] > 0) {
          for (let k = 0; k < Math.min(12, fcsPool.length); k++) {
            const fcsId = fcsPool[(fcsCursor + k) % fcsPool.length];
            if (opponents[a].has(fcsId)) continue;
            if (addEdge(a, fcsId, { isConf: false, isRivalry: false, neutralSite: false })) {
              fcsCursor += k + 1;
              placed = true;
              break;
            }
          }
          if (placed) break;
        }
      }
      if (!placed) break;
    }

    // 5) Assign weeks (1–14). Never double-book a team. Non-conf early; conf mid/late; rivalries late ok.
    const weekSlots = {};
    for (const id of fbsIds) weekSlots[id] = new Set();

    function assignWeek(edge, preferWeeks) {
      const a = edge.homeId;
      const b = edge.awayId;
      const aFbs = fbsSet.has(a);
      const bFbs = fbsSet.has(b);
      const tryWeeks = preferWeeks.concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      const seen = new Set();
      function free(w) {
        if (aFbs && weekSlots[a].has(w)) return false;
        if (bFbs && weekSlots[b].has(w)) return false;
        return true;
      }
      for (const w of tryWeeks) {
        if (seen.has(w) || !free(w)) continue;
        seen.add(w);
        if (aFbs) weekSlots[a].add(w);
        if (bFbs) weekSlots[b].add(w);
        edge.week = w;
        return true;
      }
      // Absolute last resort: first free week up to 16
      for (let w = 1; w <= 16; w++) {
        if (!free(w)) continue;
        if (aFbs) weekSlots[a].add(w);
        if (bFbs) weekSlots[b].add(w);
        edge.week = w;
        return true;
      }
      edge.week = 15;
      return false;
    }

    const nonConf = edges.filter((e) => !e.isConf);
    const conf = edges.filter((e) => e.isConf);
    for (const list of [nonConf, conf]) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = list[i];
        list[i] = list[j];
        list[j] = tmp;
      }
    }
    // Rivalries first within each group for preferred weeks
    nonConf.sort((a, b) => (b.isRivalry ? 1 : 0) - (a.isRivalry ? 1 : 0));
    conf.sort((a, b) => (b.isRivalry ? 1 : 0) - (a.isRivalry ? 1 : 0));
    for (const e of nonConf) {
      const prefs = e.isRivalry
        ? [1, 2, 3, 12, 13, 4, 5]
        : [1, 2, 3, 4, 5, 6];
      assignWeek(e, prefs);
    }
    for (const e of conf) {
      const prefs = e.isRivalry
        ? [13, 12, 11, 10, 9, 8]
        : [6, 7, 8, 9, 10, 11, 12, 13, 5, 4];
      assignWeek(e, prefs);
    }

    //     // 5) Materialize schedules + unique games
    function isoDate(week) {
      // Approximate: Week 1 ≈ first Saturday after Aug 28 of `year`
      const start = new Date(Date.UTC(year, 7, 28)); // Aug 28
      while (start.getUTCDay() !== 6) start.setUTCDate(start.getUTCDate() + 1);
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + (week - 1) * 7);
      return d.toISOString().replace(".000Z", "Z");
    }

    const schedules = {};
    for (const id of fbsIds) schedules[id] = [];
    const games = [];
    let eventSeq = 0;

    for (const e of edges) {
      eventSeq++;
      const eventId = "gen-" + year + "-" + eventSeq;
      const home = teams[e.homeId];
      const away = teams[e.awayId];
      const homeName = home ? home.name : "Home";
      const awayName = away ? away.name : "Away";
      const homeAbbr = home ? home.abbreviation : "HOME";
      const awayAbbr = away ? away.abbreviation : "AWAY";
      const week = e.week || 1;
      const date = isoDate(week);
      const game = {
        eventId,
        date,
        week,
        homeId: e.homeId,
        awayId: e.awayId,
        neutralSite: !!e.neutralSite,
        name: awayName + (e.neutralSite ? " vs " : " at ") + homeName,
        shortName: awayAbbr + (e.neutralSite ? " vs " : " @ ") + homeAbbr,
        homeIsFbs: fbsSet.has(e.homeId),
        awayIsFbs: fbsSet.has(e.awayId),
        generated: true,
        isConf: !!e.isConf,
        isRivalry: !!e.isRivalry,
      };
      games.push(game);

      function pushTeamView(tid, oppId, homeAway) {
        if (!schedules[tid]) return;
        const opp = teams[oppId] || {};
        schedules[tid].push({
          eventId,
          date,
          week,
          homeAway,
          neutralSite: !!e.neutralSite,
          opponentId: oppId,
          opponentName: opp.name || "Opponent",
          opponentAbbr: opp.abbreviation || "OPP",
          homeId: e.homeId,
          awayId: e.awayId,
          name: game.name,
          shortName: game.shortName,
          generated: true,
          isConf: !!e.isConf,
          isRivalry: !!e.isRivalry,
        });
      }

      if (fbsSet.has(e.homeId)) pushTeamView(e.homeId, e.awayId, e.neutralSite ? "neutral" : "home");
      if (fbsSet.has(e.awayId)) pushTeamView(e.awayId, e.homeId, e.neutralSite ? "neutral" : "away");
    }

    for (const id of fbsIds) {
      schedules[id].sort((a, b) => a.week - b.week || a.date.localeCompare(b.date));
    }
    games.sort((a, b) => a.week - b.week || a.date.localeCompare(b.date));

    // Stats for debugging / README sanity
    const confCounts = {};
    for (const id of fbsIds) {
      const c = teams[id].conferenceId;
      const n = (schedules[id] || []).filter((g) => g.isConf).length;
      if (!confCounts[c]) confCounts[c] = [];
      confCounts[c].push(n);
    }

    return {
      year,
      schedules,
      games,
      meta: {
        rivalryCount: edges.filter((e) => e.isRivalry).length,
        totalGames: games.length,
        confTargets: CONF_GAME_TARGETS,
        confCounts,
      },
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
    generateSeasonSchedule,
    normalizeClass,
    CONF_GAME_TARGETS,
    POWER4,
    G6,
  };
})(window);
