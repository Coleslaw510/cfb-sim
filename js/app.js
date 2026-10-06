(function () {
  "use strict";

  const STORAGE_KEY = "cfb-sim-2026-v4";
  const LEGACY_KEYS = ["cfb-sim-2026-v1", "cfb-sim-2026-v2", "cfb-sim-2026-v3"];
  let DATA = null;
  let state = {
    teamId: null,
    seasonYear: 2026,
    currentWeek: 1,
    results: {},
    seasonSeed: Date.now() % 1e9,
    phase: "regular", // regular | conf-champ | cfp-first | bowls | cfp-quarters | cfp-semis | cfp-championship | complete
    postseason: null, // built package + generated games
    history: [], // archived seasons { year, teamId, teamName, record, confRecord, finalRank, bowlResult, note }
  };

  const rosterCache = {}; // teamId -> roster json
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function load() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let migrated = false;
      if (!raw) {
        // Prefer newest legacy (v3) if present
        for (let i = LEGACY_KEYS.length - 1; i >= 0; i--) {
          const legacy = localStorage.getItem(LEGACY_KEYS[i]);
          if (legacy) {
            raw = legacy;
            migrated = true;
            break;
          }
        }
      }
      LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        state = Object.assign(state, parsed);
        if (!Array.isArray(state.history)) state.history = [];
        if (!state.seasonYear) state.seasonYear = 2026;
        if (migrated) {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }

  function team(id) {
    return DATA.teams[id];
  }

  function fbsTeams() {
    return DATA.fbsTeamIds.map((id) => DATA.teams[id]);
  }

  function resultsList() {
    return Object.values(state.results);
  }

  function maxWeek() {
    return Math.max(...DATA.weeks.map((w) => w.week));
  }

  /** Results for poll as of entering `week` (regular-season games with week < week). */
  function resultsBeforeWeek(week) {
    return resultsList().filter((g) => {
      if (g.round || g.bowl) return false;
      const w = Number(g.week);
      return Number.isFinite(w) && w < week;
    });
  }

  /** Map of teamId -> rank (1–25) for a poll computed with given results / asOfWeek. */
  function pollRankMap(results, asOfWeek) {
    const poll = CFBSim.computeTop25(
      DATA.fbsTeamIds,
      DATA.teams,
      results,
      DATA.schedules,
      asOfWeek
    );
    const map = {};
    for (const row of poll) {
      if (row.rank <= 25) map[row.id] = row.rank;
    }
    return map;
  }

  function latestPollRanks() {
    return pollRankMap(resultsList(), currentPollWeek());
  }

  /**
   * Opponent rank badge for a schedule game.
   * Completed: sim poll entering that week (AP seed if no games yet).
   * Upcoming: latest available poll.
   */
  function opponentRankBadge(opponentId, gameWeek, played) {
    if (!opponentId || !DATA.teams[opponentId] || !DATA.teams[opponentId].isFbs) {
      // Non-FBS: no badge
      const t = DATA.teams[opponentId];
      if (!t || !t.isFbs) return null;
    }
    let rank = null;
    if (played) {
      const prior = resultsBeforeWeek(gameWeek);
      if (prior.length) {
        rank = pollRankMap(prior, gameWeek)[opponentId] || null;
      } else {
        const ap = DATA.teams[opponentId] && DATA.teams[opponentId].apRank;
        rank = ap || null;
      }
    } else {
      rank = latestPollRanks()[opponentId] || null;
      // Early season with no results: fall back to AP
      if (rank == null && resultsList().length === 0) {
        rank = (DATA.teams[opponentId] && DATA.teams[opponentId].apRank) || null;
      }
    }
    return rank && rank <= 25 ? rank : null;
  }

  function formatOppLabel(prefix, opp, rank) {
    const name = escapeHtml(opp.shortName || opp.name || "Opponent");
    if (rank) return `${prefix} <span class="rank-badge">#${rank}</span> ${name}`;
    return `${prefix} ${name}`;
  }

  async function loadRoster(teamId) {
    if (!teamId) return null;
    if (rosterCache[teamId]) return rosterCache[teamId];
    if (DATA.rosterTeams && !DATA.rosterTeams.includes(teamId)) return null;
    try {
      const res = await fetch("data/rosters/" + teamId + ".json");
      if (!res.ok) return null;
      const json = await res.json();
      rosterCache[teamId] = json;
      return json;
    } catch (_) {
      return null;
    }
  }

  async function loadRosters(ids) {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    await Promise.all(uniq.map((id) => loadRoster(id)));
  }

  /* ---------- Picker ---------- */
  function populateConfFilter() {
    const sel = $("#confFilter");
    const confs = DATA.conferences.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const c of confs) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
  }

  function renderPicker() {
    const q = ($("#teamSearch").value || "").trim().toLowerCase();
    const conf = $("#confFilter").value;
    const grid = $("#teamGrid");
    const list = fbsTeams().filter((t) => {
      if (conf && t.conferenceId !== conf) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.abbreviation.toLowerCase().includes(q) ||
        (t.location || "").toLowerCase().includes(q) ||
        (t.nickname || "").toLowerCase().includes(q)
      );
    });
    if (!list.length) {
      grid.innerHTML = '<div class="empty">No teams match.</div>';
      return;
    }
    grid.innerHTML = list
      .map(
        (t) => `
      <button type="button" class="team-card" data-id="${t.id}">
        <img src="${t.logo}" alt="" loading="lazy" width="48" height="48" onerror="this.style.visibility='hidden'" />
        <div class="name">${escapeHtml(t.shortName || t.name)}</div>
        <div class="meta">${escapeHtml(t.conference)}</div>
        ${t.apRank ? `<span class="rank-pill">AP #${t.apRank}</span>` : ""}
      </button>`
      )
      .join("");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- Season UI ---------- */
  function showSeason() {
    $("#view-picker").hidden = true;
    $("#view-season").hidden = false;
    $("#topbarActions").hidden = false;
    renderSeason();
  }

  function showPicker() {
    $("#view-picker").hidden = false;
    $("#view-season").hidden = true;
    $("#topbarActions").hidden = true;
  }

  function phaseLabel() {
    const map = {
      regular: null,
      "conf-champ": "Conference Championships",
      "cfp-first": "CFP First Round",
      bowls: "Bowl Games",
      "cfp-quarters": "CFP Quarterfinals",
      "cfp-semis": "CFP Semifinals",
      "cfp-championship": "CFP Championship",
      complete: "Season complete",
    };
    return map[state.phase] || state.phase;
  }

  function renderSeason() {
    const t = team(state.teamId);
    if (!t) return;
    const rec = CFBSim.teamRecord(resultsList(), state.teamId);
    const year = state.seasonYear || 2026;
    const brandTitle = document.querySelector(".brand-title");
    if (brandTitle) brandTitle.textContent = year + " Season Sim";
    $("#myTeamChip").innerHTML = `
      <img src="${t.logo}" alt="" width="52" height="52" onerror="this.style.visibility='hidden'" />
      <div>
        <h2>${escapeHtml(t.name)}</h2>
        <div class="sub">${year} · ${escapeHtml(t.conference)} · OVR ${t.overall}${t.apRank ? " · seeded AP #" + t.apRank : ""}</div>
      </div>`;

    const btn = $("#btnSimWeek");
    const btnChunk = $("#btnSimPostseason");
    $("#recordLabel").textContent = rec.w + "–" + rec.l;

    if (state.phase === "regular") {
      const next = state.currentWeek;
      const done = next > maxWeek();
      if (done) {
        // Transition will happen on next sim click
        $("#weekLabel").textContent = "Regular season complete";
        btn.disabled = false;
        btn.textContent = "Start postseason";
        btnChunk.hidden = true;
      } else {
        $("#weekLabel").textContent = "Ready for Week " + next;
        btn.disabled = false;
        btn.textContent = "Sim Week " + next;
        btnChunk.hidden = true;
      }
    } else if (state.phase === "complete") {
      $("#weekLabel").textContent = (state.seasonYear || 2026) + " season complete";
      btn.disabled = false;
      btn.textContent = "Start next season";
      btnChunk.hidden = true;
    } else {
      $("#weekLabel").textContent = phaseLabel();
      btn.disabled = false;
      btn.textContent = "Sim " + shortPhase(state.phase);
      btnChunk.hidden = false;
      btnChunk.textContent = "Sim rest of postseason";
    }

    renderSchedule();
    renderBox();
    renderStandings();
    renderTop25();
    renderSeasonStats();
    renderDepth();
    renderPostseason();
    renderRecap();
    renderHistory();
  }

  function shortPhase(p) {
    return {
      "conf-champ": "conf. championships",
      "cfp-first": "CFP first round",
      bowls: "bowl games",
      "cfp-quarters": "quarterfinals",
      "cfp-semis": "semifinals",
      "cfp-championship": "championship",
    }[p] || p;
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
    } catch (_) {
      return String(iso).slice(0, 10);
    }
  }

  function renderSchedule() {
    const sched = (DATA.schedules[state.teamId] || []).slice().sort((a, b) => a.week - b.week || a.date.localeCompare(b.date));
    const next = state.currentWeek;
    // Cache latest ranks once for upcoming games + historical polls by week
    const latestRanks = latestPollRanks();
    const histCache = {};
    function ranksEnteringWeek(week) {
      if (histCache[week]) return histCache[week];
      const prior = resultsBeforeWeek(week);
      if (!prior.length) {
        // Preseason: AP ranks
        const map = {};
        for (const id of DATA.fbsTeamIds) {
          const ap = DATA.teams[id].apRank;
          if (ap && ap <= 25) map[id] = ap;
        }
        histCache[week] = map;
        return map;
      }
      histCache[week] = pollRankMap(prior, week);
      return histCache[week];
    }
    const rows = sched.map((g) => {
      const opp = team(g.opponentId) || {
        name: g.opponentName,
        logo: `https://a.espncdn.com/i/teamlogos/ncaa/500/${g.opponentId}.png`,
        abbreviation: g.opponentAbbr,
        shortName: g.opponentName,
      };
      const res = state.results[g.eventId];
      const isCurrent = state.phase === "regular" && g.week === next && !res;
      const where = g.neutralSite ? "Neutral" : g.homeAway === "home" ? "Home" : "Away";
      let resultHtml = '<span class="result pending">—</span>';
      if (res) {
        const mine = res.homeId === state.teamId ? res.homeScore : res.awayScore;
        const theirs = res.homeId === state.teamId ? res.awayScore : res.homeScore;
        const win = mine > theirs;
        resultHtml = `<span class="result ${win ? "win" : "loss"}">${win ? "W" : "L"} ${mine}–${theirs}</span>`;
      }
      const prefix = g.homeAway === "home" ? "vs" : "@";
      let rank;
      if (res) {
        rank = ranksEnteringWeek(g.week)[g.opponentId] || null;
      } else {
        rank = latestRanks[g.opponentId] || null;
        if (rank == null && resultsList().length === 0) {
          rank = (opp.apRank) || null;
        }
        if (rank && rank > 25) rank = null;
      }
      return `
        <div class="game-row ${res ? "played" : ""} ${isCurrent ? "current" : ""}" data-event="${g.eventId}">
          <div class="week-num">W${g.week}</div>
          <div class="opp">
            <img src="${opp.logo}" alt="" width="28" height="28" onerror="this.style.visibility='hidden'" />
            <div>
              <div class="who">${formatOppLabel(prefix, opp, rank)}</div>
              <div class="where">${where} · ${formatDate(g.date)}</div>
            </div>
          </div>
          ${resultHtml}
        </div>`;
    });

    // Append user's postseason games to schedule (use latest poll ranks)
    const psGames = postseasonGamesForUser();
    for (const g of psGames) {
      const oppId = g.homeId === state.teamId ? g.awayId : g.homeId;
      const opp = team(oppId) || { name: "TBD", logo: "", shortName: "TBD" };
      const res = state.results[g.eventId];
      let resultHtml = '<span class="result pending">—</span>';
      if (res) {
        const mine = res.homeId === state.teamId ? res.homeScore : res.awayScore;
        const theirs = res.homeId === state.teamId ? res.awayScore : res.homeScore;
        const win = mine > theirs;
        resultHtml = `<span class="result ${win ? "win" : "loss"}">${win ? "W" : "L"} ${mine}–${theirs}</span>`;
      }
      const ha = g.homeId === state.teamId ? "vs" : "@";
      const rank = (oppId && latestRanks[oppId]) || null;
      rows.push(`
        <div class="game-row ${res ? "played" : ""} postseason-row" data-event="${g.eventId}">
          <div class="week-num">${escapeHtml(shortRoundTag(g.round))}</div>
          <div class="opp">
            <img src="${opp.logo || ""}" alt="" width="28" height="28" onerror="this.style.visibility='hidden'" />
            <div>
              <div class="who">${formatOppLabel(ha, opp, rank)}</div>
              <div class="where">${escapeHtml(g.bowl || g.label || "Postseason")}</div>
            </div>
          </div>
          ${resultHtml}
        </div>`);
    }

    $("#scheduleList").innerHTML = rows.join("") || '<div class="empty">No schedule found for this team.</div>';
  }

  function shortRoundTag(round) {
    return {
      "conf-champ": "CC",
      "cfp-first": "R1",
      "cfp-quarters": "QF",
      "cfp-semis": "SF",
      "cfp-championship": "NC",
      bowl: "BWL",
    }[round] || "PS";
  }

  function postseasonGamesForUser() {
    if (!state.postseason || !state.postseason.games) return [];
    return state.postseason.games.filter(
      (g) => g.homeId === state.teamId || g.awayId === state.teamId
    );
  }

  function renderBox() {
    const el = $("#boxScore");
    const sched = DATA.schedules[state.teamId] || [];
    let last = null;
    for (const g of sched) {
      if (state.results[g.eventId]) last = state.results[g.eventId];
    }
    // Prefer latest postseason game if any
    for (const g of postseasonGamesForUser()) {
      if (state.results[g.eventId]) last = state.results[g.eventId];
    }
    if (!last) {
      el.innerHTML = '<div class="box-empty">Sim a week to see your box score.</div>';
      return;
    }
    el.innerHTML = boxHtml(last);
  }

  function boxHtml(res) {
    const home = team(res.homeId) || { abbreviation: "HOME", logo: "", name: "Home" };
    const away = team(res.awayId) || { abbreviation: "AWAY", logo: "", name: "Away" };
    const homeWin = res.homeScore > res.awayScore;
    const hs = res.homeStats;
    const as = res.awayStats;
    const rows = [
      ["Total yards", as.totalYds, hs.totalYds],
      ["Pass yards", as.passYds, hs.passYds],
      ["Rush yards", as.rushYds, hs.rushYds],
      ["Pass C/A", `${as.completions}/${as.passAtt}`, `${hs.completions}/${hs.passAtt}`],
      ["Rush att", as.rushAtt, hs.rushAtt],
      ["Turnovers", as.turnovers, hs.turnovers],
      ["3rd downs", `${as.thirdDownConv}/${as.thirdDownAtt}`, `${hs.thirdDownConv}/${hs.thirdDownAtt}`],
      ["Time of poss", as.timeOfPoss, hs.timeOfPoss],
    ];
    const midParts = [];
    if (res.bowl || res.label) midParts.push(res.bowl || res.label);
    else midParts.push("Week " + res.week);
    if (res.ot) midParts.push("OT");
    if (res.neutralSite) midParts.push("Neutral");
    const mid = midParts.join(" · ");

    function leadersBlock(label, leaders) {
      const p = leaders.passing;
      const r = leaders.rushing[0];
      const wr = leaders.receiving[0];
      return `
        <div class="stat-block">
          <h3>${escapeHtml(label)} leaders</h3>
          <div class="leader-line"><strong>Pass</strong> ${escapeHtml(p.name)} ${p.comp}/${p.att}, ${p.yds} yds, ${p.td} TD, ${p.int} INT</div>
          <div class="leader-line"><strong>Rush</strong> ${escapeHtml(r.name)} ${r.att} car, ${r.yds} yds, ${r.td} TD</div>
          <div class="leader-line"><strong>Rec</strong> ${escapeHtml(wr.name)} ${wr.rec} rec, ${wr.yds} yds, ${wr.td} TD</div>
        </div>`;
    }

    return `
      <div class="box-card">
        <div class="box-scoreline">
          <div class="box-team ${!homeWin ? "winner" : ""}">
            <img src="${away.logo}" alt="" onerror="this.style.visibility='hidden'" />
            <div class="tname">${escapeHtml(away.abbreviation)}</div>
            <div class="tscore">${res.awayScore}</div>
          </div>
          <div class="box-mid">${escapeHtml(mid)}<br/>FINAL</div>
          <div class="box-team ${homeWin ? "winner" : ""}">
            <img src="${home.logo}" alt="" onerror="this.style.visibility='hidden'" />
            <div class="tname">${escapeHtml(home.abbreviation)}</div>
            <div class="tscore">${res.homeScore}</div>
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat-block">
            <h3>Team stats</h3>
            ${rows
              .map(
                ([label, a, h]) => `
              <div class="stat-row">
                <div class="l">${a}</div>
                <div class="c">${label}</div>
                <div class="r">${h}</div>
              </div>`
              )
              .join("")}
            <div class="stat-row" style="margin-top:6px">
              <div class="l muted">${escapeHtml(away.abbreviation)}</div>
              <div class="c"></div>
              <div class="r muted">${escapeHtml(home.abbreviation)}</div>
            </div>
          </div>
          ${leadersBlock(away.abbreviation, res.awayLeaders)}
          ${leadersBlock(home.abbreviation, res.homeLeaders)}
        </div>
      </div>`;
  }

  function renderStandings() {
    const t = team(state.teamId);
    const confId = t.conferenceId;
    const confName = t.conference;
    $("#standingsTitle").textContent = confName + " standings";
    const members = DATA.fbsTeamIds
      .map((id) => DATA.teams[id])
      .filter((x) => x.conferenceId === confId);

    const rows = members
      .map((m) => {
        const rec = CFBSim.teamRecord(resultsList().filter((g) => !g.bowl || g.round === "conf-champ"), m.id);
        const conf = CFBSim.conferenceRecord(resultsList(), m.id, DATA.teams);
        return { m, rec, conf };
      })
      .sort((a, b) => {
        const aw = a.conf.w + a.conf.l ? a.conf.w / (a.conf.w + a.conf.l) : 0;
        const bw = b.conf.w + b.conf.l ? b.conf.w / (b.conf.w + b.conf.l) : 0;
        if (bw !== aw) return bw - aw;
        if (b.conf.w !== a.conf.w) return b.conf.w - a.conf.w;
        const aow = a.rec.w + a.rec.l ? a.rec.w / (a.rec.w + a.rec.l) : 0;
        const bow = b.rec.w + b.rec.l ? b.rec.w / (b.rec.w + b.rec.l) : 0;
        if (bow !== aow) return bow - aow;
        return b.rec.margin - a.rec.margin;
      });

    $("#standingsTable").innerHTML = `
      <table class="rank-table">
        <thead><tr><th>#</th><th>Team</th><th>Conf</th><th>Overall</th><th>PF</th><th>PA</th></tr></thead>
        <tbody>
          ${rows
            .map((row, i) => {
              const mine = row.m.id === state.teamId ? "mine" : "";
              return `<tr class="${mine}">
                <td>${i + 1}</td>
                <td><div class="team-cell"><img src="${row.m.logo}" alt="" onerror="this.style.visibility='hidden'" /><span>${escapeHtml(row.m.shortName || row.m.name)}</span></div></td>
                <td>${row.conf.w}–${row.conf.l}</td>
                <td>${row.rec.w}–${row.rec.l}</td>
                <td>${row.rec.pf}</td>
                <td>${row.rec.pa}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function currentPollWeek() {
    if (state.phase === "regular") return state.currentWeek;
    return maxWeek() + 1;
  }

  function renderTop25() {
    const poll = CFBSim.computeTop25(
      DATA.fbsTeamIds,
      DATA.teams,
      resultsList(),
      DATA.schedules,
      currentPollWeek()
    ).slice(0, 25);
    $("#top25Table").innerHTML = `
      <table class="rank-table">
        <thead><tr><th>Rk</th><th>Team</th><th>Rec</th><th>SOS</th><th>Margin</th></tr></thead>
        <tbody>
          ${poll
            .map((row) => {
              const t = team(row.id);
              const mine = row.id === state.teamId ? "mine" : "";
              return `<tr class="${mine}">
                <td>${row.rank}</td>
                <td><div class="team-cell"><img src="${t.logo}" alt="" onerror="this.style.visibility='hidden'" /><span>${escapeHtml(t.shortName || t.name)}</span></div></td>
                <td>${row.rec.w}–${row.rec.l}</td>
                <td>${row.sos.toFixed(1)}</td>
                <td>${row.avgMargin >= 0 ? "+" : ""}${row.avgMargin.toFixed(1)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;
  }

  function fmtRate(n, digits) {
    if (n == null || !Number.isFinite(n)) return "—";
    return n.toFixed(digits == null ? 1 : digits);
  }

  function medalCell(rank) {
    if (rank === 1) return '<span class="medal medal-gold" title="1st">1</span>';
    if (rank === 2) return '<span class="medal medal-silver" title="2nd">2</span>';
    if (rank === 3) return '<span class="medal medal-bronze" title="3rd">3</span>';
    return `<span class="rank-num">${rank}</span>`;
  }

  function renderSeasonStats() {
    const el = $("#seasonStats");
    if (!el) return;
    const list = resultsList();
    if (!list.length) {
      el.innerHTML = '<div class="box-empty">Sim games to accumulate season stats for your roster.</div>';
      return;
    }
    const agg = CFBSim.accumulateSeasonStats(list, null);
    const mine = agg.teamLeaders(state.teamId);
    const t = team(state.teamId);
    const q = agg.qualifiers || {};
    const qNote = q.passing
      ? `FBS boards ranked by YPG · min ${q.passing.minGames} games (pass ≥${q.passing.minAttPerGame * q.passing.minGames} att · rush ≥${q.rushing.minAttPerGame * q.rushing.minGames} att · rec ≥${q.receiving.minRecPerGame * q.receiving.minGames} rec).`
      : "FBS boards ranked by yards per game with min-game qualifiers.";

    function teamAbbrev(tid) {
      const tm = team(tid);
      return tm ? escapeHtml(tm.abbreviation || "") : "";
    }

    function passTable(rows, limit, ranked) {
      const slice = rows.slice(0, limit);
      if (!slice.length) return '<p class="muted small">No qualified passing stats yet.</p>';
      return `<table class="rank-table stats-table">
        <thead><tr><th>#</th><th>Player</th><th>G</th><th>YPG</th><th>Yds</th><th>TD/G</th><th>C/A</th><th>INT</th></tr></thead>
        <tbody>${slice.map((p, i) => {
          const rank = i + 1;
          const teamCell = p.teamId ? `<span class="muted small"> · ${teamAbbrev(p.teamId)}</span>` : "";
          return `<tr>
            <td class="rank-col">${ranked ? medalCell(rank) : rank}</td>
            <td>${escapeHtml(p.name)}${teamCell}</td>
            <td>${p.gp || 0}</td>
            <td class="stat-lead">${fmtRate(p.ypg)}</td>
            <td>${p.yds}</td>
            <td>${fmtRate(p.tdpg, 2)}</td>
            <td>${p.comp}/${p.att}</td>
            <td>${p.int}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }
    function rushTable(rows, limit, ranked) {
      const slice = rows.slice(0, limit);
      if (!slice.length) return '<p class="muted small">No qualified rushing stats yet.</p>';
      return `<table class="rank-table stats-table">
        <thead><tr><th>#</th><th>Player</th><th>G</th><th>YPG</th><th>Yds</th><th>TD/G</th><th>Att</th></tr></thead>
        <tbody>${slice.map((p, i) => {
          const rank = i + 1;
          const teamCell = p.teamId ? `<span class="muted small"> · ${teamAbbrev(p.teamId)}</span>` : "";
          return `<tr>
            <td class="rank-col">${ranked ? medalCell(rank) : rank}</td>
            <td>${escapeHtml(p.name)}${teamCell}</td>
            <td>${p.gp || 0}</td>
            <td class="stat-lead">${fmtRate(p.ypg)}</td>
            <td>${p.yds}</td>
            <td>${fmtRate(p.tdpg, 2)}</td>
            <td>${p.att}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }
    function recTable(rows, limit, ranked) {
      const slice = rows.slice(0, limit);
      if (!slice.length) return '<p class="muted small">No qualified receiving stats yet.</p>';
      return `<table class="rank-table stats-table">
        <thead><tr><th>#</th><th>Player</th><th>G</th><th>YPG</th><th>Yds</th><th>TD/G</th><th>Rec</th></tr></thead>
        <tbody>${slice.map((p, i) => {
          const rank = i + 1;
          const teamCell = p.teamId ? `<span class="muted small"> · ${teamAbbrev(p.teamId)}</span>` : "";
          return `<tr>
            <td class="rank-col">${ranked ? medalCell(rank) : rank}</td>
            <td>${escapeHtml(p.name)}${teamCell}</td>
            <td>${p.gp || 0}</td>
            <td class="stat-lead">${fmtRate(p.ypg)}</td>
            <td>${p.yds}</td>
            <td>${fmtRate(p.tdpg, 2)}</td>
            <td>${p.rec}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }

    el.innerHTML = `
      <div class="stats-section">
        <h3>${escapeHtml(t.shortName || t.name)} leaders</h3>
        <p class="muted small stats-note">Sorted by yards/game · totals shown alongside.</p>
        <div class="stats-grid">
          <div class="stat-block"><h3>Passing</h3>${passTable(mine.passing, 5, true)}</div>
          <div class="stat-block"><h3>Rushing</h3>${rushTable(mine.rushing, 6, true)}</div>
          <div class="stat-block"><h3>Receiving</h3>${recTable(mine.receiving, 6, true)}</div>
        </div>
      </div>
      <div class="stats-section">
        <h3>FBS leaders</h3>
        <p class="muted small stats-note">${escapeHtml(qNote)}</p>
        <div class="stats-grid">
          <div class="stat-block"><h3>Passing YPG</h3>${passTable(agg.leaders.passing, 10, true)}</div>
          <div class="stat-block"><h3>Rushing YPG</h3>${rushTable(agg.leaders.rushing, 10, true)}</div>
          <div class="stat-block"><h3>Receiving YPG</h3>${recTable(agg.leaders.receiving, 10, true)}</div>
        </div>
      </div>`;
  }

  /* ---------- Depth chart ---------- */
  async function renderDepth() {
    const el = $("#depthChart");
    const sel = $("#depthTeamSelect");
    if (!sel.options.length) {
      const t = team(state.teamId);
      sel.innerHTML = `<option value="${t.id}">${escapeHtml(t.shortName || t.name)} (yours)</option>`;
      // Add upcoming / recent opponents
      const sched = DATA.schedules[state.teamId] || [];
      const seen = new Set([t.id]);
      for (const g of sched) {
        if (seen.has(g.opponentId)) continue;
        const opp = team(g.opponentId);
        if (!opp || !opp.isFbs) continue;
        seen.add(g.opponentId);
        sel.innerHTML += `<option value="${g.opponentId}">${escapeHtml(opp.shortName || opp.name)}</option>`;
      }
    }
    const tid = sel.value || state.teamId;
    const roster = await loadRoster(tid);
    const t = team(tid);
    if (!roster || !roster.players || !roster.players.length) {
      el.innerHTML = `<div class="box-empty">No roster available for ${escapeHtml(t.shortName || t.name)}.</div>`;
      return;
    }
    const order = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K", "P"];
    const labels = { QB: "Quarterbacks", RB: "Running backs", WR: "Wide receivers", TE: "Tight ends", OL: "Offensive line", DL: "Defensive line", LB: "Linebackers", DB: "Defensive backs", K: "Kickers", P: "Punters" };
    el.innerHTML = `
      <div class="depth-head">
        <img src="${t.logo}" alt="" width="36" height="36" onerror="this.style.visibility='hidden'" />
        <div>
          <strong>${escapeHtml(t.shortName || t.name)} depth chart</strong>
          <div class="muted small">${roster.players.length} players · ESPN roster order</div>
        </div>
      </div>
      <div class="depth-grid">
        ${order
          .map((pos) => {
            const idxs = roster.depth[pos] || [];
            if (!idxs.length) return "";
            return `
              <div class="depth-group">
                <h3>${labels[pos] || pos}</h3>
                <ol>
                  ${idxs
                    .map((i, slot) => {
                      const p = roster.players[i];
                      if (!p) return "";
                      return `<li><span class="depth-slot">${slot + 1}</span><span class="jersey">#${escapeHtml(p.j || "—")}</span> <span class="pname">${escapeHtml(p.n)}</span> <span class="muted small">${escapeHtml(p.p)}${p.c ? " · " + escapeHtml(p.c) : ""}</span></li>`;
                    })
                    .join("")}
                </ol>
              </div>`;
          })
          .join("")}
      </div>`;
  }

  /* ---------- Postseason panel ---------- */
  function renderPostseason() {
    const el = $("#postseasonPanel");
    if (state.phase === "regular" && state.currentWeek <= maxWeek()) {
      el.innerHTML = '<div class="box-empty">Finish the regular season to unlock the postseason bracket and bowls.</div>';
      return;
    }
    if (!state.postseason) {
      el.innerHTML = '<div class="box-empty">Click <strong>Start postseason</strong> to build conference championships, the 12-team CFP, and bowls.</div>';
      return;
    }

    const ps = state.postseason;
    const field = ps.field || [];
    let html = "";

    html += `<div class="panel-head"><h2>12-Team CFP Field</h2><p class="muted small">Seeds 1–4 earn first-round byes. Auto bids: ACC, Big Ten, Big 12, SEC champs + highest-ranked G6 team; remaining at-large by sim poll.</p></div>`;
    html += `<div class="cfp-field">`;
    for (const f of field) {
      const t = team(f.teamId);
      const mine = f.teamId === state.teamId ? "mine" : "";
      html += `<div class="cfp-seed ${mine}"><span class="seed">#${f.seed}</span><img src="${t.logo}" alt="" onerror="this.style.visibility='hidden'" /><span class="nm">${escapeHtml(t.shortName || t.name)}</span><span class="tag">${f.autoBid ? "Auto" : "At-large"}</span></div>`;
    }
    html += `</div>`;

    const rounds = [
      { key: "conf-champ", title: "Conference Championships" },
      { key: "cfp-first", title: "CFP First Round" },
      { key: "bowl", title: "Other Bowls" },
      { key: "cfp-quarters", title: "CFP Quarterfinals" },
      { key: "cfp-semis", title: "CFP Semifinals" },
      { key: "cfp-championship", title: "CFP National Championship" },
    ];

    for (const round of rounds) {
      const games = (ps.games || []).filter((g) => g.round === round.key);
      if (!games.length) continue;
      html += `<div class="ps-round"><h3>${round.title}</h3>`;
      for (const g of games) {
        const home = team(g.homeId) || { shortName: "TBD", logo: "" };
        const away = team(g.awayId) || { shortName: "TBD", logo: "" };
        const res = state.results[g.eventId];
        let score = '<span class="muted">vs</span>';
        if (res) {
          score = `<span class="ps-score">${res.awayScore} – ${res.homeScore}</span>`;
        }
        const mine = g.homeId === state.teamId || g.awayId === state.teamId ? "mine" : "";
        html += `
          <div class="ps-game ${mine}">
            <div class="ps-bowl">${escapeHtml(g.bowl || g.label || "")}</div>
            <div class="ps-teams">
              <div class="ps-side"><img src="${away.logo || ""}" alt="" onerror="this.style.visibility='hidden'" />${escapeHtml(away.shortName || away.name || "TBD")}${g.seedAway ? " <span class='muted'>(" + g.seedAway + ")</span>" : ""}</div>
              ${score}
              <div class="ps-side"><img src="${home.logo || ""}" alt="" onerror="this.style.visibility='hidden'" />${escapeHtml(home.shortName || home.name || "TBD")}${g.seedHome ? " <span class='muted'>(" + g.seedHome + ")</span>" : ""}</div>
            </div>
          </div>`;
      }
      html += `</div>`;
    }

    el.innerHTML = html;
  }

  /* ---------- Recap ---------- */
  function buildRecapHtml(recap, t, opts) {
    const rankTxt = recap.finalRank ? ` · Final #${recap.finalRank}` : "";
    const year = (opts && opts.year) || state.seasonYear || 2026;
    const actions = (opts && opts.actions) ? opts.actions : "";
    return `
      <div class="recap-card">
        <div class="eyebrow">${year} · End of season</div>
        <div class="recap-title">
          <img src="${t.logo}" alt="" width="48" height="48" onerror="this.style.visibility='hidden'" />
          <div>
            <h2>${escapeHtml(recap.name)} ${recap.record.w}–${recap.record.l}</h2>
            <div class="sub">(${recap.confRecord.w}–${recap.confRecord.l} ${escapeHtml(t.conference)})${rankTxt}</div>
          </div>
        </div>
        <p class="recap-bowl">${escapeHtml(recap.bowlResult)}</p>
        ${recap.summary ? `<p class="recap-summary muted">${escapeHtml(recap.summary)}</p>` : ""}
        ${actions}
      </div>`;
  }

  function currentSeasonRecap() {
    const ranked = CFBSim.computeTop25(
      DATA.fbsTeamIds,
      DATA.teams,
      resultsList(),
      DATA.schedules,
      maxWeek() + 1
    );
    return CFBSim.seasonRecap(state.teamId, DATA.teams, resultsList(), ranked, state.postseason);
  }

  function renderRecap() {
    const wrap = $("#recapCard");
    const panel = $("#panel-recap");
    if (state.phase !== "complete") {
      wrap.hidden = true;
      wrap.innerHTML = "";
      if (panel) panel.innerHTML = '<div class="box-empty">Complete the postseason to see your end-of-season recap.</div>';
      return;
    }
    const recap = currentSeasonRecap();
    const t = team(state.teamId);
    const actions = `<div class="recap-actions">
        <button type="button" class="btn btn-primary" id="btnStartNextSeason">Start next season</button>
        <span class="muted small">Same roster &amp; ratings · history is saved</span>
      </div>`;
    const html = buildRecapHtml(recap, t, { actions });
    wrap.hidden = false;
    wrap.innerHTML = html;
    if (panel) panel.innerHTML = html;
    // Wire both possible buttons (card + panel)
    $$("#btnStartNextSeason").forEach((btn) => {
      btn.addEventListener("click", () => startNextSeason());
    });
  }

  /* ---------- History ---------- */
  function renderHistory() {
    const el = $("#historyPanel");
    if (!el) return;
    const rows = Array.isArray(state.history) ? state.history.slice() : [];
    // Show in-progress? Only completed archives. Optionally preview current if complete.
    if (state.phase === "complete" && state.teamId) {
      // Preview current season as a soft row if not yet archived
      // (archived only when starting next season)
    }
    if (!rows.length && state.phase !== "complete") {
      el.innerHTML = '<div class="box-empty">Finish a season, then use <strong>Start next season</strong> to archive it here. Same rosters carry forward.</div>';
      return;
    }

    let preview = "";
    if (state.phase === "complete" && state.teamId) {
      const recap = currentSeasonRecap();
      const t = team(state.teamId);
      preview = `
        <div class="history-current">
          <div class="eyebrow">Current season (not archived yet)</div>
          <div class="history-row current">
            <div class="hy">${state.seasonYear || 2026}</div>
            <div class="ht">
              <img src="${t.logo}" alt="" width="22" height="22" onerror="this.style.visibility='hidden'" />
              ${escapeHtml(recap.name)}
            </div>
            <div class="hr">${recap.record.w}–${recap.record.l}</div>
            <div class="hc">${recap.confRecord.w}–${recap.confRecord.l}</div>
            <div class="hk">${recap.finalRank ? "#" + recap.finalRank : "—"}</div>
            <div class="hb">${escapeHtml(recap.bowlResult)}</div>
          </div>
          <div class="recap-actions" style="margin-top:10px">
            <button type="button" class="btn btn-primary" id="btnStartNextSeasonHistory">Start next season</button>
          </div>
        </div>`;
    }

    const archived = rows.length
      ? `<div class="history-list">
          <div class="history-row head">
            <div class="hy">Year</div>
            <div class="ht">Team</div>
            <div class="hr">Record</div>
            <div class="hc">Conf</div>
            <div class="hk">Rank</div>
            <div class="hb">Bowl / CFP</div>
          </div>
          ${rows.slice().reverse().map((h) => {
            const tm = team(h.teamId);
            const logo = tm && tm.logo ? tm.logo : "";
            const note = h.note ? `<div class="history-note muted small">${escapeHtml(h.note)}</div>` : "";
            return `<div class="history-row">
              <div class="hy">${h.year}</div>
              <div class="ht">
                ${logo ? `<img src="${logo}" alt="" width="22" height="22" onerror="this.style.visibility='hidden'" />` : ""}
                <div>
                  <div>${escapeHtml(h.teamName || (tm && (tm.shortName || tm.name)) || "Team")}</div>
                  ${note}
                </div>
              </div>
              <div class="hr">${escapeHtml(h.record || "—")}</div>
              <div class="hc">${escapeHtml(h.confRecord || "—")}</div>
              <div class="hk">${h.finalRank ? "#" + h.finalRank : "—"}</div>
              <div class="hb">${escapeHtml(h.bowlResult || "—")}</div>
            </div>`;
          }).join("")}
        </div>`
      : '<p class="muted small" style="padding:8px 12px">No archived seasons yet — start the next season from Recap to save this one.</p>';

    el.innerHTML = preview + archived;
    const btn = $("#btnStartNextSeasonHistory");
    if (btn) btn.addEventListener("click", () => startNextSeason());
  }

  function archiveCurrentSeason() {
    if (state.phase !== "complete" || !state.teamId) return null;
    const recap = currentSeasonRecap();
    const entry = {
      year: state.seasonYear || 2026,
      teamId: state.teamId,
      teamName: recap.name,
      record: recap.record.w + "–" + recap.record.l,
      confRecord: recap.confRecord.w + "–" + recap.confRecord.l,
      conference: recap.conference,
      finalRank: recap.finalRank,
      bowlResult: recap.bowlResult,
      note: recap.summary,
    };
    if (!Array.isArray(state.history)) state.history = [];
    state.history.push(entry);
    return entry;
  }

  function startNextSeason() {
    if (state.phase !== "complete" || !state.teamId) return;
    const archived = archiveCurrentSeason();
    const nextYear = (state.seasonYear || 2026) + 1;
    const id = state.teamId;
    state.seasonYear = nextYear;
    state.currentWeek = 1;
    state.results = {};
    state.seasonSeed = (Date.now() % 1e9) ^ CFBSim.hashSeed(id + "|" + nextYear);
    state.phase = "regular";
    state.postseason = null;
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    save();
    renderSeason();
    switchTab("schedule");
    toast(
      archived
        ? `${archived.year} archived · ${nextYear} season started`
        : `${nextYear} season started`
    );
  }

  /* ---------- Simulation ---------- */
  function stubTeam(id, label) {
    return {
      id,
      name: label,
      abbreviation: "UNK",
      offense: 52,
      defense: 52,
      overall: 52,
      logo: `https://a.espncdn.com/i/teamlogos/ncaa/500/${id}.png`,
    };
  }

  async function simGame(g, weekLabel) {
    const home = team(g.homeId) || stubTeam(g.homeId, "Home");
    const away = team(g.awayId) || stubTeam(g.awayId, "Away");
    await loadRosters([g.homeId, g.awayId]);
    return CFBSim.simulateGame(home, away, {
      eventId: g.eventId,
      week: weekLabel != null ? weekLabel : g.week,
      neutralSite: g.neutralSite,
      seasonSeed: state.seasonSeed,
      homeRoster: rosterCache[g.homeId] || null,
      awayRoster: rosterCache[g.awayId] || null,
      label: g.label || null,
      bowl: g.bowl || null,
      round: g.round || null,
    });
  }

  async function simNextWeek() {
    if (state.phase === "complete") {
      startNextSeason();
      return;
    }

    if (state.phase === "regular") {
      if (state.currentWeek > maxWeek()) {
        await beginPostseason();
        return;
      }
      await simRegularWeek(state.currentWeek);
      return;
    }

    await simPostseasonStep(false);
  }

  async function simRegularWeek(week) {
    const games = DATA.games.filter((g) => g.week === week);
    let userBox = null;
    let count = 0;

    // Prefetch rosters for every FBS side this week (season stats + box names)
    const weekIds = [];
    for (const g of games) {
      weekIds.push(g.homeId, g.awayId);
    }
    await loadRosters(weekIds);

    for (const g of games) {
      if (state.results[g.eventId]) continue;
      const box = await simGame(g, week);
      state.results[g.eventId] = box;
      count++;
      if (g.homeId === state.teamId || g.awayId === state.teamId) userBox = box;
    }

    state.currentWeek = week + 1;
    while (state.currentWeek <= maxWeek() && !DATA.games.some((g) => g.week === state.currentWeek)) {
      state.currentWeek++;
    }

    save();
    renderSeason();

    if (userBox) {
      switchTab("box");
      toast(`Week ${week} done · ${count} games simmed`);
    } else {
      const bye = !(DATA.schedules[state.teamId] || []).some((g) => g.week === week);
      switchTab(bye ? "standings" : "schedule");
      toast(bye ? `Week ${week}: bye · ${count} FBS games simmed` : `Week ${week} · ${count} games`);
    }

    if (state.currentWeek > maxWeek()) {
      toast("Regular season complete — start postseason when ready");
    }
  }

  function determineConferenceChamps(ccResults) {
    const champs = {};
    // Start from standings leaders, then override with CC winners
    for (const conf of DATA.conferences) {
      if (conf.id === "18") continue;
      const standings = CFBSim.conferenceStandings(conf.id, DATA.fbsTeamIds, DATA.teams, resultsList());
      if (standings.length) champs[conf.id] = standings[0].team.id;
    }
    for (const g of ccResults) {
      const confId = String(g.eventId).replace("cc-", "");
      champs[confId] = CFBSim.winnerId(g);
    }
    return champs;
  }

  async function beginPostseason() {
    // Build & sim readiness for conf championships
    const ccGames = CFBSim.buildConferenceChampionships(
      DATA.fbsTeamIds,
      DATA.teams,
      resultsList(),
      DATA.conferences
    );
    state.postseason = {
      games: ccGames.slice(),
      field: null,
      pkg: null,
    };
    state.phase = "conf-champ";
    save();
    renderSeason();
    switchTab("postseason");
    toast("Postseason ready · Conference Championships");
  }

  async function afterConfChamps() {
    const ccResults = resultsList().filter((g) => g.round === "conf-champ");
    const champs = determineConferenceChamps(ccResults);
    const ranked = CFBSim.computeTop25(
      DATA.fbsTeamIds,
      DATA.teams,
      resultsList(),
      DATA.schedules,
      maxWeek() + 1
    );
    const pkg = CFBSim.buildPostseason(
      ranked,
      DATA.teams,
      champs,
      DATA.postseasonMeta,
      resultsList()
    );
    state.postseason.pkg = pkg;
    state.postseason.field = pkg.field;
    state.postseason.conferenceChamps = champs;
    // Add first round + bowls to games list (quarters built later)
    state.postseason.games = state.postseason.games
      .concat(pkg.firstRound)
      .concat(pkg.bowls);
    state.phase = "cfp-first";
    save();
  }

  async function afterFirstRound() {
    // Build quarters from first-round results; bowls can sim in parallel phase
    const pkg = state.postseason.pkg;
    const seedMap = {};
    pkg.field.forEach((f) => { seedMap[f.seed] = f.teamId; });
    const resultsById = state.results;
    const quarters = CFBSim.buildQuarterfinals(pkg, resultsById, seedMap);
    // Remove any stale quarter games
    state.postseason.games = state.postseason.games.filter((g) => g.round !== "cfp-quarters");
    state.postseason.games = state.postseason.games.concat(quarters);
    // Bowls may still be pending — if bowls not done, go to bowls; else quarters
    const bowlsPending = (state.postseason.games || []).some(
      (g) => g.round === "bowl" && !state.results[g.eventId]
    );
    state.phase = bowlsPending ? "bowls" : "cfp-quarters";
    save();
  }

  async function afterBowls() {
    state.phase = "cfp-quarters";
    save();
  }

  async function afterQuarters() {
    const pkg = state.postseason.pkg;
    const qfResults = {};
    for (const g of state.postseason.games.filter((x) => x.round === "cfp-quarters")) {
      if (state.results[g.eventId]) qfResults[g.eventId] = state.results[g.eventId];
    }
    const semis = CFBSim.buildSemifinals(qfResults, pkg);
    state.postseason.games = state.postseason.games.filter((g) => g.round !== "cfp-semis");
    state.postseason.games = state.postseason.games.concat(semis);
    state.phase = "cfp-semis";
    save();
  }

  async function afterSemis() {
    const pkg = state.postseason.pkg;
    const sfResults = {};
    for (const g of state.postseason.games.filter((x) => x.round === "cfp-semis")) {
      if (state.results[g.eventId]) sfResults[g.eventId] = state.results[g.eventId];
    }
    const champ = CFBSim.buildChampionship(sfResults, pkg);
    state.postseason.games = state.postseason.games.filter((g) => g.round !== "cfp-championship");
    state.postseason.games.push(champ);
    state.phase = "cfp-championship";
    save();
  }

  async function simPostseasonStep(allRemaining) {
    const roundOf = (phase) => {
      if (phase === "conf-champ") return "conf-champ";
      if (phase === "cfp-first") return "cfp-first";
      if (phase === "bowls") return "bowl";
      if (phase === "cfp-quarters") return "cfp-quarters";
      if (phase === "cfp-semis") return "cfp-semis";
      if (phase === "cfp-championship") return "cfp-championship";
      return null;
    };

    do {
      const round = roundOf(state.phase);
      if (!round) break;

      // Ensure games exist for this phase
      if (state.phase === "cfp-first" && !(state.postseason.field)) {
        // Should have been built after conf champs
      }

      const games = (state.postseason.games || []).filter(
        (g) => g.round === round && !state.results[g.eventId] && g.homeId && g.awayId
      );

      // Prefetch rosters for all games in this round (season stats)
      const ids = [];
      for (const g of games) ids.push(g.homeId, g.awayId);
      await loadRosters(ids);

      let userBox = null;
      let count = 0;
      for (const g of games) {
        const box = await simGame(g, g.week);
        state.results[g.eventId] = box;
        count++;
        if (g.homeId === state.teamId || g.awayId === state.teamId) userBox = box;
      }

      // Advance phase
      if (state.phase === "conf-champ") {
        await afterConfChamps();
        toast(`Conference championships · ${count} games`);
      } else if (state.phase === "cfp-first") {
        await afterFirstRound();
        toast(`CFP first round · ${count} games`);
      } else if (state.phase === "bowls") {
        await afterBowls();
        toast(`Bowl games · ${count} games`);
      } else if (state.phase === "cfp-quarters") {
        await afterQuarters();
        toast(`Quarterfinals · ${count} games`);
      } else if (state.phase === "cfp-semis") {
        await afterSemis();
        toast(`Semifinals · ${count} games`);
      } else if (state.phase === "cfp-championship") {
        state.phase = "complete";
        save();
        toast("National champion crowned");
      }

      save();
      renderSeason();
      if (userBox) switchTab("box");
      else switchTab(state.phase === "complete" ? "recap" : "postseason");

      if (!allRemaining || state.phase === "complete") break;
    } while (state.phase !== "complete");

    if (state.phase === "complete") {
      switchTab("recap");
      renderRecap();
    }
  }

  function pickTeam(id) {
    const keepHistory = Array.isArray(state.history) ? state.history : [];
    const keepYear = state.seasonYear || 2026;
    state.teamId = id;
    state.seasonYear = keepYear;
    state.history = keepHistory;
    state.currentWeek = 1;
    state.results = {};
    state.seasonSeed = (Date.now() % 1e9) ^ CFBSim.hashSeed(id + "|" + keepYear);
    state.phase = "regular";
    state.postseason = null;
    // reset depth select
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    save();
    loadRoster(id); // warm cache
    showSeason();
    switchTab("schedule");
    toast(keepYear + " season · " + team(id).shortName);
  }

  function resetSeason() {
    if (!state.teamId) return;
    if (!confirm("Reset this season? Simmed results clear; History stays.")) return;
    const id = state.teamId;
    state.currentWeek = 1;
    state.results = {};
    state.seasonSeed = (Date.now() % 1e9) ^ CFBSim.hashSeed(id + "|reset|" + (state.seasonYear || 2026));
    state.phase = "regular";
    state.postseason = null;
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    save();
    renderSeason();
    switchTab("schedule");
    toast("Season reset · history kept");
  }

  function switchTab(name) {
    const tabs = ["schedule", "box", "standings", "top25", "stats", "depth", "postseason", "recap", "history"];
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    tabs.forEach((p) => {
      const el = $("#panel-" + p);
      if (el) el.hidden = p !== name;
    });
    if (name === "depth") renderDepth();
    if (name === "stats") renderSeasonStats();
    if (name === "postseason") renderPostseason();
    if (name === "recap") renderRecap();
    if (name === "history") renderHistory();
  }

  /* ---------- Boot ---------- */
  async function init() {
    load();
    const res = await fetch("data/cfb-2026.json");
    if (!res.ok) throw new Error("Failed to load data");
    DATA = await res.json();
    populateConfFilter();
    renderPicker();

    $("#teamSearch").addEventListener("input", renderPicker);
    $("#confFilter").addEventListener("change", renderPicker);
    $("#teamGrid").addEventListener("click", (e) => {
      const card = e.target.closest(".team-card");
      if (card) pickTeam(card.dataset.id);
    });
    $("#btnSimWeek").addEventListener("click", () => {
      simNextWeek().catch((err) => {
        console.error(err);
        toast("Sim error — see console");
      });
    });
    $("#btnSimPostseason").addEventListener("click", () => {
      simPostseasonStep(true).catch((err) => {
        console.error(err);
        toast("Sim error — see console");
      });
    });
    $("#btnReset").addEventListener("click", resetSeason);
    $("#btnChangeTeam").addEventListener("click", () => {
      if (!confirm("Leave this season and pick a different team? History is kept; the in-progress season is discarded when you pick.")) return;
      state.teamId = null;
      state.currentWeek = 1;
      state.results = {};
      state.phase = "regular";
      state.postseason = null;
      save();
      showPicker();
    });
    $$(".tab").forEach((t) =>
      t.addEventListener("click", () => switchTab(t.dataset.tab))
    );
    $("#depthTeamSelect").addEventListener("change", () => renderDepth());

    if (state.teamId && DATA.teams[state.teamId] && DATA.teams[state.teamId].isFbs) {
      showSeason();
    } else {
      showPicker();
    }
  }

  init().catch((err) => {
    console.error(err);
    $("#teamGrid").innerHTML = '<div class="empty">Could not load data/cfb-2026.json. Serve over HTTP.</div>';
  });
})();
