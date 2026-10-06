/* CFB 2026 simulation engine — drive-based probabilistic model */
(function (global) {
  "use strict";

  const FIRST_NAMES = ["Jaylen","Marcus","Tyler","Cam","Jordan","Malik","Noah","Isaiah","Cole","Dylan","Brayden","Jalen","Xavier","Aiden","Carson","Miles","Kaiden","Bryce","Devin","Riley","Owen","Eli","Caleb","Nate","Chris","Jake","Hunter","Logan","Quinn","Austin"];
  const LAST_NAMES = ["Williams","Johnson","Brown","Davis","Miller","Wilson","Moore","Taylor","Anderson","Thomas","Jackson","White","Harris","Martin","Thompson","Garcia","Martinez","Robinson","Clark","Lewis","Lee","Walker","Hall","Allen","Young","King","Wright","Scott","Green","Baker","Adams","Nelson","Carter","Mitchell","Perez","Roberts","Turner","Phillips","Campbell","Parker"];

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

  /** Expected points from rating differential */
  function expectedPoints(off, def, homeBoost) {
    // League average ~27; each rating point ~0.55 pts of expected scoring
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

    // Drive count ~10–13 each
    const homeDrives = 10 + Math.floor(rng() * 4);
    const awayDrives = 10 + Math.floor(rng() * 4);

    function scoreFromDrives(expPts, drives) {
      // Convert expected points into TD/FG mix with noise
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
      // Occasional safety / 2pt noise omitted for simplicity; add small variance
      if (rng() < 0.04) pts += 2;
      return { pts, td, fg, to };
    }

    let homeS = scoreFromDrives(homeExp, homeDrives);
    let awayS = scoreFromDrives(awayExp, awayDrives);

    // Avoid too many 0–0 / very low; bump if both tiny
    if (homeS.pts + awayS.pts < 17) {
      if (rng() < 0.5) homeS.pts += 7;
      else awayS.pts += 7;
    }

    // OT if tied
    let ot = false;
    while (homeS.pts === awayS.pts) {
      ot = true;
      if (rng() < 0.55) homeS.pts += 7;
      else awayS.pts += 3;
      if (rng() < 0.55) awayS.pts += 7;
      else homeS.pts += 3;
      // ensure not still tied after both scored same
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
        timeOfPoss: null, // filled below
        isHome,
      };
    }

    const homeY = yardsBundle(homeS.pts, homeTeam.offense, awayTeam.defense, true);
    const awayY = yardsBundle(awayS.pts, awayTeam.offense, homeTeam.defense, false);

    // Align turnovers somewhat with drive TOs
    homeY.turnovers = Math.max(homeY.turnovers, homeS.to > 0 ? homeS.to : homeY.turnovers);
    awayY.turnovers = Math.max(awayY.turnovers, awayS.to > 0 ? awayS.to : awayY.turnovers);

    const homePossMin = clamp(26 + (homeY.rushAtt - awayY.rushAtt) * 0.15 + (rng() - 0.5) * 4, 24, 36);
    homeY.timeOfPoss = formatTOP(homePossMin);
    awayY.timeOfPoss = formatTOP(60 - homePossMin);

    function leadersFor(team, yds, pts) {
      const qb = pickName(rng);
      const rb1 = pickName(rng);
      const rb2 = pickName(rng);
      const wr1 = pickName(rng);
      const passTds = clamp(Math.round(pts / 10 + (rng() - 0.4)), 0, 5);
      const rushTds = Math.max(0, Math.round(pts / 14) - Math.floor(passTds * 0.4));
      const rush1 = Math.round(yds.rushYds * (0.55 + rng() * 0.2));
      const rush2 = Math.max(8, yds.rushYds - rush1 - Math.round(rng() * 20));
      const recYds = Math.round(yds.passYds * (0.28 + rng() * 0.15));
      return {
        passing: { name: qb, comp: yds.completions, att: yds.passAtt, yds: yds.passYds, td: passTds, int: yds.interceptions },
        rushing: [
          { name: rb1, att: Math.round(yds.rushAtt * 0.55), yds: rush1, td: Math.min(rushTds, 2) },
          { name: rb2, att: Math.max(3, yds.rushAtt - Math.round(yds.rushAtt * 0.55) - 4), yds: Math.max(0, rush2), td: Math.max(0, rushTds - 2) },
        ],
        receiving: [{ name: wr1, rec: clamp(Math.round(3 + rng() * 6), 2, 10), yds: recYds, td: Math.min(passTds, 2) }],
      };
    }

    const homeLeaders = leadersFor(homeTeam, homeY, homeS.pts);
    const awayLeaders = leadersFor(awayTeam, awayY, awayS.pts);

    return {
      eventId: meta.eventId,
      week: meta.week,
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

  function teamRecord(results, teamId) {
    let w = 0, l = 0, pf = 0, pa = 0;
    for (const g of results) {
      if (g.homeId !== teamId && g.awayId !== teamId) continue;
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

  /**
   * Sim poll ranking score:
   * winPct*40 + SOS*25 + avgMargin*15 + remainingOppStrength*10 + apSeed*10
   * SOS = average opponent overall of games played
   * apSeed = leftover from preseason AP (rank 1 => 1.0, unranked => 0.2)
   */
  function computeTop25(fbsIds, teams, results, schedules, currentWeek) {
    const playedOppRatings = {};
    const remaining = {};

    for (const id of fbsIds) {
      playedOppRatings[id] = [];
      remaining[id] = [];
      const sched = schedules[id] || [];
      for (const g of sched) {
        const opp = teams[g.opponentId];
        const rating = opp ? opp.overall : 50;
        if (g.week < currentWeek) {
          // only count if game was actually simmed (exists in results)
          const played = results.some((r) => r.eventId === g.eventId);
          if (played) playedOppRatings[id].push(rating);
        } else if (g.week >= currentWeek) {
          remaining[id].push(rating);
        }
      }
    }

    const scored = fbsIds.map((id) => {
      const rec = teamRecord(results, id);
      const games = rec.w + rec.l;
      const winPct = games ? rec.w / games : 0;
      const sosArr = playedOppRatings[id];
      const sos = sosArr.length ? sosArr.reduce((a, b) => a + b, 0) / sosArr.length / 100 : 0.55;
      const avgMargin = games ? rec.margin / games : 0;
      const rem = remaining[id];
      const remStr = rem.length ? rem.reduce((a, b) => a + b, 0) / rem.length / 100 : 0.55;
      const ap = teams[id].apRank;
      const apSeed = ap ? (26 - ap) / 25 : 0.2;
      const marginScore = clamp((avgMargin + 20) / 40, 0, 1); // -20..+20 → 0..1
      const score =
        winPct * 40 +
        sos * 25 +
        marginScore * 15 +
        remStr * 10 +
        apSeed * 10;
      return {
        id,
        score,
        rec,
        winPct,
        sos: sos * 100,
        avgMargin,
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.rec.w !== a.rec.w) return b.rec.w - a.rec.w;
      return b.rec.margin - a.rec.margin;
    });
    return scored.slice(0, 25).map((row, i) => ({ rank: i + 1, ...row }));
  }

  global.CFBSim = {
    simulateGame,
    teamRecord,
    conferenceRecord,
    computeTop25,
    hashSeed,
  };
})(window);
