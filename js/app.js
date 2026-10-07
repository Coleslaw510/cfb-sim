(function () {
  "use strict";

  const STORAGE_KEY = "cfb-sim-2026-v8";
  const LEGACY_KEYS = ["cfb-sim-2026-v1", "cfb-sim-2026-v2", "cfb-sim-2026-v3", "cfb-sim-2026-v4", "cfb-sim-2026-v5", "cfb-sim-2026-v6", "cfb-sim-2026-v7"];
  let DATA = null;

  function createFreshState() {
    return {
      teamId: null,
      seasonYear: 2026,
      currentWeek: 1,
      results: {},
      seasonSeed: Date.now() % 1e9,
      phase: "regular", // regular | conf-champ | cfp-first | bowls | cfp-quarters | cfp-semis | cfp-championship | complete
      postseason: null, // built package + generated games
      history: [], // archived seasons { year, teamId, teamName, record, confRecord, finalRank, bowlResult, note }
      generatedSchedule: null, // { year, schedules, games } for seasonYear > 2026
      // Coin economy + All-Time Shop (between seasons). Recruiting can reuse owned/roster engine later.
      coins: typeof CFBEconomy !== "undefined" ? CFBEconomy.STARTING_COINS : 100,
      ownedPlayerIds: [], // catalog ids permanently on user's program
      claimedGoals: {}, // { [seasonYear]: [goalId, ...] } — prevents double-pay
      lastSeasonPayout: null, // { year, total, lines }
      // Preseason non-conference edits: { [week]: { opponentId, homeAway } }
      nonConfOverrides: {},
    };
  }

  let state = createFreshState();

  let ALLTIME = null; // { players, teams, ... } catalog
  let shopFilter = { q: "", teamId: "", pos: "", sort: "ovr" };
  /** Where the shop was opened from: "recap" (between seasons) | "picker" | "season" (main season screen). */
  let shopReturn = "recap";

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
        if (!state.generatedSchedule) state.generatedSchedule = null;
        if (!Array.isArray(state.ownedPlayerIds)) state.ownedPlayerIds = [];
        if (!state.claimedGoals || typeof state.claimedGoals !== "object") state.claimedGoals = {};
        if (typeof state.coins !== "number" || !Number.isFinite(state.coins)) {
          state.coins = typeof CFBEconomy !== "undefined" ? CFBEconomy.STARTING_COINS : 100;
        }
        if (!state.lastSeasonPayout) state.lastSeasonPayout = null;
        if (!state.nonConfOverrides || typeof state.nonConfOverrides !== "object") state.nonConfOverrides = {};
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

  /** Season 1 (2026) uses ESPN data; later years use generatedSchedule. */
  function usesGeneratedSchedule() {
    return (state.seasonYear || 2026) > 2026;
  }

  function ensureGeneratedSchedule() {
    if (!usesGeneratedSchedule()) {
      state.generatedSchedule = null;
      return null;
    }
    if (
      state.generatedSchedule &&
      state.generatedSchedule.year === state.seasonYear &&
      state.generatedSchedule.schedules &&
      state.generatedSchedule.games
    ) {
      return state.generatedSchedule;
    }
    const pack = CFBSim.generateSeasonSchedule({
      teams: DATA.teams,
      fbsTeamIds: DATA.fbsTeamIds,
      year: state.seasonYear,
      seasonSeed: state.seasonSeed ^ CFBSim.hashSeed("sched|" + state.seasonYear),
    });
    state.generatedSchedule = {
      year: pack.year,
      schedules: pack.schedules,
      games: pack.games,
      meta: pack.meta || null,
    };
    return state.generatedSchedule;
  }

  function baseSchedules() {
    if (!usesGeneratedSchedule()) return DATA.schedules;
    const pack = ensureGeneratedSchedule();
    return (pack && pack.schedules) || DATA.schedules;
  }

  function baseGames() {
    if (!usesGeneratedSchedule()) return DATA.games;
    const pack = ensureGeneratedSchedule();
    return (pack && pack.games) || DATA.games;
  }

  /** Conference game if both sides share the user's conference (or flagged isConf). */
  function isConferenceGameFor(teamId, g) {
    if (!g) return false;
    if (g.isConf) return true;
    const me = DATA.teams[teamId];
    if (!me) return false;
    const oppId = g.opponentId != null
      ? g.opponentId
      : (g.homeId === teamId ? g.awayId : g.homeId);
    const opp = DATA.teams[oppId];
    if (!opp || !opp.isFbs || !me.isFbs) return false;
    if (me.conferenceId === "18" || opp.conferenceId === "18") return false; // independents
    return String(me.conferenceId) === String(opp.conferenceId);
  }

  function cloneGame(g) {
    return Object.assign({}, g);
  }

  /**
   * Apply user's preseason non-conference opponent swaps onto schedules + games.
   * Old opponent gets a bye that week; new opponent drops their same-week game (bye).
   */
  function applyNonConfOverrides(schedulesIn, gamesIn) {
    const overrides = state.nonConfOverrides || {};
    const keys = Object.keys(overrides);
    if (!keys.length || !state.teamId) {
      return { schedules: schedulesIn, games: gamesIn };
    }
    const tid = String(state.teamId);
    const schedules = {};
    for (const id of Object.keys(schedulesIn)) {
      schedules[id] = (schedulesIn[id] || []).map(cloneGame);
    }
    let games = (gamesIn || []).map(cloneGame);

    function removeEventEverywhere(eventId) {
      for (const id of Object.keys(schedules)) {
        schedules[id] = (schedules[id] || []).filter((x) => String(x.eventId) !== String(eventId));
      }
      games = games.filter((x) => String(x.eventId) !== String(eventId));
    }

    function pushTeamView(sched, eventId, date, week, homeAway, neutralSite, homeId, awayId, oppId, name, shortName) {
      const opp = DATA.teams[oppId] || {};
      sched.push({
        eventId,
        date,
        week,
        homeAway,
        neutralSite: !!neutralSite,
        opponentId: oppId,
        opponentName: opp.name || "Opponent",
        opponentAbbr: opp.abbreviation || "OPP",
        homeId,
        awayId,
        name,
        shortName,
        generated: true,
        isConf: false,
      });
    }

    // Overrides keyed by week string for user's non-conf slots
    for (const weekKey of keys) {
      const ov = overrides[weekKey];
      if (!ov || !ov.opponentId) continue;
      const week = Number(weekKey);
      if (!Number.isFinite(week)) continue;
      const newOppId = String(ov.opponentId);
      if (newOppId === tid) continue;

      const mineList = schedules[tid] || [];
      const mineIdx = mineList.findIndex(
        (x) => Number(x.week) === week && !isConferenceGameFor(tid, x)
      );
      if (mineIdx < 0) continue;
      const orig = mineList[mineIdx];
      const homeAway = ov.homeAway || orig.homeAway || "home";
      const neutralSite = !!ov.neutralSite;

      // Remove user's original matchup that week
      removeEventEverywhere(orig.eventId);

      // Drop new opponent's same-week game if any
      const newOppSched = schedules[newOppId] || (schedules[newOppId] = []);
      const conflict = newOppSched.find((x) => Number(x.week) === week);
      if (conflict) removeEventEverywhere(conflict.eventId);

      const homeId = homeAway === "away" ? newOppId : tid;
      const awayId = homeAway === "away" ? tid : newOppId;
      const homeT = DATA.teams[homeId] || {};
      const awayT = DATA.teams[awayId] || {};
      const name = (awayT.name || "Away") + (neutralSite ? " vs " : " at ") + (homeT.name || "Home");
      const shortName =
        (awayT.abbreviation || "AWAY") + (neutralSite ? " vs " : " @ ") + (homeT.abbreviation || "HOME");
      const newEventId = "ncedit-" + tid + "-w" + week + "-" + newOppId;
      const date = orig.date;

      games.push({
        eventId: newEventId,
        date,
        week,
        homeId,
        awayId,
        neutralSite,
        name,
        shortName,
        homeIsFbs: !!(DATA.teams[homeId] && DATA.teams[homeId].isFbs),
        awayIsFbs: !!(DATA.teams[awayId] && DATA.teams[awayId].isFbs),
        generated: true,
        isConf: false,
        nonConfEdit: true,
      });

      if (!schedules[tid]) schedules[tid] = [];
      pushTeamView(
        schedules[tid],
        newEventId,
        date,
        week,
        homeAway === "away" ? "away" : "home",
        neutralSite,
        homeId,
        awayId,
        newOppId,
        name,
        shortName
      );
      if (DATA.teams[newOppId] && DATA.teams[newOppId].isFbs) {
        if (!schedules[newOppId]) schedules[newOppId] = [];
        pushTeamView(
          schedules[newOppId],
          newEventId,
          date,
          week,
          homeAway === "away" ? "home" : "away",
          neutralSite,
          homeId,
          awayId,
          tid,
          name,
          shortName
        );
      }
      schedules[tid].sort((a, b) => a.week - b.week || String(a.date).localeCompare(String(b.date)));
      if (schedules[newOppId]) {
        schedules[newOppId].sort((a, b) => a.week - b.week || String(a.date).localeCompare(String(b.date)));
      }
    }

    games.sort((a, b) => a.week - b.week || String(a.date).localeCompare(String(b.date)));
    return { schedules, games };
  }

  function activeSchedules() {
    const base = baseSchedules();
    return applyNonConfOverrides(base, baseGames()).schedules;
  }

  function activeGames() {
    const baseS = baseSchedules();
    return applyNonConfOverrides(baseS, baseGames()).games;
  }

  function isPreseasonEditable() {
    return (
      !!state.teamId &&
      state.phase === "regular" &&
      Object.keys(state.results || {}).length === 0
    );
  }

  function classBadge(c) {
    const n = CFBSim.normalizeClass(c);
    if (!n) return "";
    return `<span class="class-badge" title="Class year">${escapeHtml(n)}</span>`;
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
      activeSchedules(),
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

  function ownedCatalogPlayers() {
    if (!ALLTIME || !ALLTIME.players) return [];
    const set = new Set(state.ownedPlayerIds || []);
    return ALLTIME.players.filter((p) => set.has(p.id));
  }

  /** Effective roster for display/sim — user's team merges purchased all-time players. */
  async function effectiveRoster(teamId) {
    const base = await loadRoster(teamId);
    if (!base) return null;
    if (String(teamId) !== String(state.teamId)) return base;
    const owned = ownedCatalogPlayers();
    if (!owned.length) return base;
    return CFBRosterEngine.applyOwnedPlayers(base, owned, { source: "alltime" });
  }

  /** Team ratings with soft shop boost for the user's school only. */
  function effectiveTeam(teamId) {
    const t = team(teamId);
    if (!t) return null;
    if (String(teamId) !== String(state.teamId)) return t;
    const boost = CFBRosterEngine.ratingBoostFromOwned(ownedCatalogPlayers());
    if (!boost.offense && !boost.defense) return t;
    return CFBRosterEngine.applyBoostToTeam(t, boost);
  }

  function updateCoinUI() {
    const chip = $("#coinChip");
    const bal = $("#coinBalance");
    const shopBal = $("#shopCoinBalance");
    if (bal) bal.textContent = String(state.coins || 0);
    if (shopBal) shopBal.textContent = String(state.coins || 0);
    // Always show balance (including starting coins on the team picker).
    if (chip) chip.hidden = false;
  }

  /** True before any games have been simmed this season (picker or week-1 blank slate). */
  function isPreseasonShopWindow() {
    if (state.phase === "complete") return false;
    const results = state.results && typeof state.results === "object" ? state.results : {};
    return Object.keys(results).length === 0 && (state.phase === "regular" || !state.teamId);
  }

  function canPurchaseInShop() {
    return state.phase === "complete" || isPreseasonShopWindow();
  }

  /** Wins vs opponents ranked in the Top 25 entering that game (AP seed preseason). */
  function countTop25Wins(teamId) {
    let n = 0;
    const histCache = {};
    function ranksEnteringWeek(week) {
      if (histCache[week]) return histCache[week];
      const prior = resultsBeforeWeek(week);
      if (!prior.length) {
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
    for (const g of resultsList()) {
      if (g.homeId !== teamId && g.awayId !== teamId) continue;
      const mine = g.homeId === teamId ? g.homeScore : g.awayScore;
      const theirs = g.homeId === teamId ? g.awayScore : g.homeScore;
      if (mine <= theirs) continue;
      const oppId = g.homeId === teamId ? g.awayId : g.homeId;
      let rank = null;
      if (g.round || g.bowl) {
        // Postseason: use latest poll at end of regular season
        rank = pollRankMap(
          resultsList().filter((x) => !x.round && !x.bowl),
          maxWeek() + 1
        )[oppId] || null;
      } else {
        const w = Number(g.week) || 1;
        rank = ranksEnteringWeek(w)[oppId] || null;
      }
      if (rank && rank <= 25) n += 1;
    }
    return n;
  }

  function awardSeasonCoinsIfNeeded() {
    if (state.phase !== "complete" || !state.teamId) return null;
    const year = String(state.seasonYear || 2026);
    if (!state.claimedGoals) state.claimedGoals = {};
    if (Object.prototype.hasOwnProperty.call(state.claimedGoals, year)) {
      // Already paid for this year — keep lastSeasonPayout if present
      return state.lastSeasonPayout;
    }
    const recap = currentSeasonRecap();
    const lines = CFBEconomy.evaluateSeasonGoals({
      teamId: state.teamId,
      results: resultsList(),
      recap,
      top25WinCount: countTop25Wins(state.teamId),
    });
    const total = CFBEconomy.payoutTotal(lines);
    state.coins = (state.coins || 0) + total;
    state.claimedGoals[year] = lines.map((l) => l.id + (l.count && l.count > 1 ? "x" + l.count : ""));
    state.lastSeasonPayout = { year: Number(year), total, lines };
    save();
    return state.lastSeasonPayout;
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
    if ($("#view-shop")) $("#view-shop").hidden = true;
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
    const liveRanks = latestPollRanks();
    let liveRank = liveRanks[state.teamId] || null;
    if (liveRank == null && resultsList().length === 0 && t.apRank) liveRank = t.apRank;
    const rankBit = liveRank ? ` · <span class="live-rank">#${liveRank}</span>` : "";
    const shopBit = (state.ownedPlayerIds||[]).length ? ` · ${state.ownedPlayerIds.length} shop` : "";
    $("#myTeamChip").innerHTML = `
      <img src="${t.logo}" alt="" width="52" height="52" onerror="this.style.visibility='hidden'" />
      <div>
        <h2>${escapeHtml(t.name)}</h2>
        <div class="sub">${year} · ${escapeHtml(t.conference)} · OVR ${(effectiveTeam(state.teamId)||t).overall}${rankBit}${shopBit}</div>
      </div>`;

    const btn = $("#btnSimWeek");
    const btnChunk = $("#btnSimPostseason");
    $("#recordLabel").textContent = rec.w + "–" + rec.l;

    const btnSeasonShop = $("#btnSeasonShop");
    const btnTopShop = $("#btnTopShop");
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
      btn.textContent = "All-Time Shop";
      btnChunk.hidden = true;
    } else {
      $("#weekLabel").textContent = phaseLabel();
      btn.disabled = false;
      btn.textContent = "Sim " + shortPhase(state.phase);
      btnChunk.hidden = false;
      btnChunk.textContent = "Sim rest of postseason";
    }
    // Always keep shop on the main season screen (not only via Change Team → picker).
    const shopLabel = state.phase === "complete" || isPreseasonShopWindow()
      ? "All-Time Shop"
      : "Browse All-Time Shop";
    if (btnSeasonShop) {
      btnSeasonShop.hidden = false;
      btnSeasonShop.textContent = shopLabel;
    }
    if (btnTopShop) {
      btnTopShop.hidden = false;
      btnTopShop.textContent = shopLabel;
    }

    renderSchedule();
    renderBox();
    renderStandings();
    renderTop25();
    renderSeasonStats();
    renderDepth();
    renderPostseason();
    if (state.phase === "complete") awardSeasonCoinsIfNeeded();
    updateCoinUI();
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
    const sched = (activeSchedules()[state.teamId] || []).slice().sort((a, b) => a.week - b.week || a.date.localeCompare(b.date));
    const next = state.currentWeek;
    const myT = effectiveTeam(state.teamId) || team(state.teamId);
    const latestRanks = latestPollRanks();
    const histCache = {};
    function ranksEnteringWeek(week) {
      if (histCache[week]) return histCache[week];
      const prior = resultsBeforeWeek(week);
      if (!prior.length) {
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

    function myRankForGame(g, played) {
      if (played) {
        const r = ranksEnteringWeek(g.week)[state.teamId];
        return r && r <= 25 ? r : null;
      }
      let r = latestRanks[state.teamId] || null;
      if (r == null && resultsList().length === 0) r = (myT && myT.apRank) || null;
      return r && r <= 25 ? r : null;
    }

    function buildRow(g, opts) {
      opts = opts || {};
      const isPs = !!opts.postseason;
      const oppId = isPs
        ? (g.homeId === state.teamId ? g.awayId : g.homeId)
        : g.opponentId;
      const opp = team(oppId) || {
        name: g.opponentName || "TBD",
        logo: oppId ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${oppId}.png` : "",
        abbreviation: g.opponentAbbr || "TBD",
        shortName: g.opponentName || "TBD",
        overall: null,
      };
      const res = state.results[g.eventId];
      const isCurrent = opts.isCurrent;
      const where = isPs
        ? escapeHtml(g.bowl || g.label || "Postseason")
        : (g.neutralSite ? "Neutral" : g.homeAway === "home" ? "Home" : "Away") + " · " + formatDate(g.date);
      let resultHtml = '<span class="result pending">—</span>';
      if (res) {
        const mine = res.homeId === state.teamId ? res.homeScore : res.awayScore;
        const theirs = res.homeId === state.teamId ? res.awayScore : res.homeScore;
        const win = mine > theirs;
        const otTag = res.ot ? " OT" : "";
        resultHtml = `<span class="result ${win ? "win" : "loss"}">${win ? "W" : "L"} ${mine}–${theirs}${otTag}</span>`;
      }
      const prefix = isPs
        ? (g.homeId === state.teamId ? "vs" : "@")
        : (g.homeAway === "home" ? "vs" : "@");
      let oppRank;
      if (res) {
        if (isPs) oppRank = latestRanks[oppId] || null;
        else oppRank = ranksEnteringWeek(g.week)[oppId] || null;
      } else {
        oppRank = latestRanks[oppId] || null;
        if (oppRank == null && resultsList().length === 0) oppRank = (opp.apRank) || null;
        if (oppRank && oppRank > 25) oppRank = null;
      }
      const myRank = myRankForGame(isPs ? { week: next } : g, !!res);
      const oppEff = effectiveTeam(oppId) || opp;
      const myOvr = myT && myT.overall != null ? myT.overall : "—";
      const oppOvr = oppEff && oppEff.overall != null ? oppEff.overall : "—";
      const weekLabel = isPs ? escapeHtml(shortRoundTag(g.round)) : ("W" + g.week);
      const confLock = !isPs && isConferenceGameFor(state.teamId, g);
      const editable = !isPs && isPreseasonEditable() && !confLock;
      // Opponent rank ONLY on opponent (logo + name). Your rank ONLY next to "You".
      const oppRankBadge = oppRank ? `<span class="rank-badge" title="Opponent rank">#${oppRank}</span>` : "";
      const youRankSpan = myRank ? `<span class="you-rank" title="Your rank this week">#${myRank}</span> ` : "";
      const pin = opts.pinned ? " pinned-next" : "";
      const pinLabel = opts.pinned ? `<div class="next-game-label">${isPs ? "Your next game" : "Next up"}</div>` : "";
      return `
        <div class="game-row ${res ? "played" : ""} ${isCurrent ? "current" : ""}${isPs ? " postseason-row" : ""}${pin}${confLock ? " conf-locked" : ""}" data-event="${g.eventId}" data-opp="${oppId || ""}">
          ${pinLabel}
          <div class="week-num">${weekLabel}</div>
          <div class="opp team-link" data-team-id="${oppId || ""}" title="View roster">
            <span class="logo-wrap">
              ${oppRank ? `<span class="logo-rank">${oppRank}</span>` : ""}
              <img src="${opp.logo || ""}" alt="" width="28" height="28" onerror="this.style.visibility='hidden'" />
            </span>
            <div>
              <div class="who">${prefix} ${oppRankBadge}${escapeHtml(opp.shortName || opp.name || "Opponent")}</div>
              <div class="where">${where}${confLock ? " · Conf" : ""}${editable ? " · Non-conf" : ""}</div>
              <div class="matchup-ovrs"><span class="ovr-mini">${youRankSpan}You ${myOvr}</span><span>·</span><span class="ovr-mini">Opp ${oppOvr}</span></div>
            </div>
          </div>
          ${resultHtml}
        </div>`;
    }

    // Identify next/current game to pin (regular or postseason)
    let pinKey = null;
    let pinIsPs = false;
    if (state.phase === "regular") {
      const cur = sched.find((g) => g.week === next && !state.results[g.eventId]);
      if (cur) { pinKey = cur.eventId; pinIsPs = false; }
      else {
        const upcoming = sched.find((g) => !state.results[g.eventId] && g.week >= next);
        if (upcoming) { pinKey = upcoming.eventId; pinIsPs = false; }
      }
    }
    const psGames = postseasonGamesForUser();
    if (!pinKey && psGames.length) {
      const nextPs = psGames.find((g) => !state.results[g.eventId]);
      if (nextPs) { pinKey = nextPs.eventId; pinIsPs = true; }
      else if (state.phase !== "regular" && state.phase !== "complete") {
        // fall back to last ps game if all played but still in postseason
        pinKey = psGames[psGames.length - 1].eventId;
        pinIsPs = true;
      }
    }

    const rows = [];
    // Pinned next game at top
    if (pinKey) {
      if (pinIsPs) {
        const g = psGames.find((x) => x.eventId === pinKey);
        if (g) rows.push(buildRow(g, { postseason: true, pinned: true, isCurrent: !state.results[g.eventId] }));
      } else {
        const g = sched.find((x) => x.eventId === pinKey);
        if (g) {
          rows.push(buildRow(g, {
            pinned: true,
            isCurrent: state.phase === "regular" && g.week === next && !state.results[g.eventId],
          }));
        }
      }
    }

    for (const g of sched) {
      if (pinKey && !pinIsPs && g.eventId === pinKey) continue; // already pinned
      const isCurrent = state.phase === "regular" && g.week === next && !state.results[g.eventId];
      rows.push(buildRow(g, { isCurrent }));
    }
    for (const g of psGames) {
      if (pinKey && pinIsPs && g.eventId === pinKey) continue;
      rows.push(buildRow(g, { postseason: true }));
    }

    let editHtml = "";
    if (isPreseasonEditable()) {
      editHtml = renderNonConfEditor(sched);
    }

    $("#scheduleList").innerHTML =
      editHtml +
      (rows.join("") || '<div class="empty">No schedule found for this team.</div>');

    // Click opponent → depth chart
    $("#scheduleList").querySelectorAll(".team-link[data-team-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.getAttribute("data-team-id");
        if (id) openTeamRoster(id);
      });
    });
    // Non-conf editor binds
    const applyBtn = $("#btnApplyNonConf");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => applyNonConfEditorForm());
    }
    const resetBtn = $("#btnResetNonConf");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.nonConfOverrides = {};
        save();
        renderSchedule();
        toast("Non-conference schedule restored");
      });
    }
  }

  function renderNonConfEditor(sched) {
    // Always edit against base slate non-conf weeks; show current (possibly overridden) opponent selected
    const baseNonConf = (baseSchedules()[state.teamId] || [])
      .filter((g) => !isConferenceGameFor(state.teamId, g))
      .slice()
      .sort((a, b) => a.week - b.week);
    if (!baseNonConf.length) {
      return `<div class="nonconf-editor"><div class="panel-head"><h2>Non-conference schedule</h2><p class="muted small">No editable non-conference games on this slate.</p></div></div>`;
    }
    const currentByWeek = {};
    (sched || []).forEach((g) => {
      if (!isConferenceGameFor(state.teamId, g)) currentByWeek[g.week] = g;
    });
    const myConf = (team(state.teamId) || {}).conferenceId;
    const fbsOpts = DATA.fbsTeamIds
      .filter((id) => id !== state.teamId)
      .map((id) => DATA.teams[id])
      .filter(Boolean)
      .sort((a, b) => (a.shortName || a.name).localeCompare(b.shortName || b.name));

    const slots = baseNonConf.map((baseG) => {
      const cur = currentByWeek[baseG.week] || baseG;
      const options = fbsOpts
        .map((t) => {
          const sameConf = myConf && t.conferenceId === myConf && myConf !== "18";
          if (sameConf) return ""; // can't pick conference foes as "non-conf"
          const sel = String(t.id) === String(cur.opponentId) ? "selected" : "";
          const ovr = t.overall != null ? ` · OVR ${t.overall}` : "";
          const ap = t.apRank ? ` · AP #${t.apRank}` : "";
          return `<option value="${t.id}" ${sel}>${escapeHtml(t.shortName || t.name)}${ovr}${ap}</option>`;
        })
        .join("");
      const ha = cur.homeAway === "away" ? "away" : "home";
      return `<div class="nonconf-slot" data-week="${baseG.week}">
        <div class="nonconf-week">Week ${baseG.week}</div>
        <select class="nonconf-opp" aria-label="Non-conference opponent week ${baseG.week}">${options}</select>
        <select class="nonconf-ha" aria-label="Home or away">
          <option value="home" ${ha === "home" ? "selected" : ""}>Home</option>
          <option value="away" ${ha === "away" ? "selected" : ""}>Away</option>
        </select>
      </div>`;
    }).join("");

    const nEdits = Object.keys(state.nonConfOverrides || {}).length;
    return `<div class="nonconf-editor">
      <div class="panel-head">
        <h2>Edit non-conference schedule</h2>
        <p class="muted small">Preseason only · conference games stay locked. Pick tougher non-con for Top 25 win bonuses.</p>
      </div>
      <div class="nonconf-slots">${slots}</div>
      <div class="nonconf-actions">
        <button type="button" class="btn btn-primary" id="btnApplyNonConf">Save non-con matchups</button>
        <button type="button" class="btn btn-ghost" id="btnResetNonConf" ${nEdits ? "" : "disabled"}>Reset non-con</button>
      </div>
    </div>`;
  }

  function applyNonConfEditorForm() {
    if (!isPreseasonEditable()) {
      toast("Non-con edits only in preseason");
      return;
    }
    const overrides = {};
    const baseList = baseSchedules()[state.teamId] || [];
    $$(".nonconf-slot").forEach((slot) => {
      const week = Number(slot.getAttribute("data-week"));
      const oppSel = slot.querySelector(".nonconf-opp");
      const haSel = slot.querySelector(".nonconf-ha");
      if (!Number.isFinite(week) || !oppSel) return;
      const base = baseList.find((g) => Number(g.week) === week && !isConferenceGameFor(state.teamId, g));
      if (!base) return;
      const opponentId = oppSel.value;
      const homeAway = haSel ? haSel.value : "home";
      const baseHa = base.homeAway === "away" ? "away" : "home";
      if (String(opponentId) !== String(base.opponentId) || homeAway !== baseHa) {
        overrides[String(week)] = { opponentId, homeAway, neutralSite: false };
      }
    });
    state.nonConfOverrides = overrides;
    save();
    renderSchedule();
    const n = Object.keys(overrides).length;
    toast(n ? `Saved ${n} non-con edit${n > 1 ? "s" : ""}` : "Non-con matches base slate");
  }

  async function openTeamRoster(teamId) {
    if (!teamId || !DATA.teams[teamId]) {
      toast("No roster for that team");
      return;
    }
    const sel = $("#depthTeamSelect");
    if (sel) {
      // Ensure option exists
      let found = false;
      for (const opt of sel.options) {
        if (opt.value === String(teamId)) { found = true; break; }
      }
      if (!found) {
        const t = DATA.teams[teamId];
        const opt = document.createElement("option");
        opt.value = teamId;
        opt.textContent = t.shortName || t.name;
        sel.appendChild(opt);
      }
      sel.value = String(teamId);
    }
    switchTab("depth");
    await renderDepth();
    const t = effectiveTeam(teamId) || team(teamId);
    toast(`${t.shortName || t.name} · OVR ${t.overall != null ? t.overall : "—"}`);
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
    const sched = activeSchedules()[state.teamId] || [];
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
    if (res.ot) midParts.push(res.otPeriods && res.otPeriods > 1 ? res.otPeriods + "OT" : "OT");
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
              return `<tr class="${mine} team-row-link" data-team-id="${row.m.id}" title="View roster">
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
    $("#standingsTable").querySelectorAll("[data-team-id]").forEach((el) => {
      el.addEventListener("click", () => openTeamRoster(el.getAttribute("data-team-id")));
    });
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
      activeSchedules(),
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
              return `<tr class="${mine} team-row-link" data-team-id="${row.id}" title="View roster">
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
    $("#top25Table").querySelectorAll("[data-team-id]").forEach((el) => {
      el.addEventListener("click", () => openTeamRoster(el.getAttribute("data-team-id")));
    });
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
      ? `FBS boards ranked by season totals (Yds) · medals for top 3 · min ${q.passing.minGames} games (pass ≥${q.passing.minAttPerGame * q.passing.minGames} att · rush ≥${q.rushing.minAttPerGame * q.rushing.minGames} att · rec ≥${q.receiving.minRecPerGame * q.receiving.minGames} rec).`
      : "FBS boards ranked by season yard totals with min-game qualifiers. Medals on top 3 only.";

    function teamAbbrev(tid) {
      const tm = team(tid);
      return tm ? escapeHtml(tm.abbreviation || "") : "";
    }

    function playerCell(p) {
      const teamCell = p.teamId ? `<span class="muted small"> · ${teamAbbrev(p.teamId)}</span>` : "";
      return `${escapeHtml(p.name)}${teamCell}`;
    }

    function rankCell(rank, useMedals) {
      if (useMedals) return medalCell(rank);
      return `<span class="rank-num">${rank}</span>`;
    }

    /** useMedals: true only for FBS leaderboards (not team tables). */
    function passTable(rows, limit, useMedals) {
      const slice = rows.slice(0, limit);
      if (!slice.length) return '<p class="muted small">No qualified passing stats yet.</p>';
      return `<table class="rank-table stats-table">
        <thead><tr><th>#</th><th>Player</th><th>Yr</th><th>G</th><th>Yds</th><th>TD</th><th>C/A</th><th>INT</th></tr></thead>
        <tbody>${slice.map((p, i) => {
          const rank = i + 1;
          return `<tr>
            <td class="rank-col">${rankCell(rank, useMedals)}</td>
            <td>${playerCell(p)}</td>
            <td>${classBadge(p.class) || "—"}</td>
            <td>${p.gp || 0}</td>
            <td class="stat-lead">${p.yds}</td>
            <td>${p.td}</td>
            <td>${p.comp}/${p.att}</td>
            <td>${p.int}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }
    function rushTable(rows, limit, useMedals) {
      const slice = rows.slice(0, limit);
      if (!slice.length) return '<p class="muted small">No qualified rushing stats yet.</p>';
      return `<table class="rank-table stats-table">
        <thead><tr><th>#</th><th>Player</th><th>Yr</th><th>G</th><th>Yds</th><th>TD</th><th>Att</th></tr></thead>
        <tbody>${slice.map((p, i) => {
          const rank = i + 1;
          return `<tr>
            <td class="rank-col">${rankCell(rank, useMedals)}</td>
            <td>${playerCell(p)}</td>
            <td>${classBadge(p.class) || "—"}</td>
            <td>${p.gp || 0}</td>
            <td class="stat-lead">${p.yds}</td>
            <td>${p.td}</td>
            <td>${p.att}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }
    function recTable(rows, limit, useMedals) {
      const slice = rows.slice(0, limit);
      if (!slice.length) return '<p class="muted small">No qualified receiving stats yet.</p>';
      return `<table class="rank-table stats-table">
        <thead><tr><th>#</th><th>Player</th><th>Yr</th><th>G</th><th>Yds</th><th>TD</th><th>Rec</th></tr></thead>
        <tbody>${slice.map((p, i) => {
          const rank = i + 1;
          return `<tr>
            <td class="rank-col">${rankCell(rank, useMedals)}</td>
            <td>${playerCell(p)}</td>
            <td>${classBadge(p.class) || "—"}</td>
            <td>${p.gp || 0}</td>
            <td class="stat-lead">${p.yds}</td>
            <td>${p.td}</td>
            <td>${p.rec}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }

    el.innerHTML = `
      <div class="stats-section">
        <h3>${escapeHtml(t.shortName || t.name)} leaders</h3>
        <p class="muted small stats-note">Season totals · sorted by yards. Plain 1–3 ranks (no medals).</p>
        <div class="stats-grid">
          <div class="stat-block"><h3>Passing</h3>${passTable(mine.passing, 5, false)}</div>
          <div class="stat-block"><h3>Rushing</h3>${rushTable(mine.rushing, 6, false)}</div>
          <div class="stat-block"><h3>Receiving</h3>${recTable(mine.receiving, 6, false)}</div>
        </div>
      </div>
      <div class="stats-section">
        <h3>FBS leaders</h3>
        <p class="muted small stats-note">${escapeHtml(qNote)}</p>
        <div class="stats-grid">
          <div class="stat-block"><h3>Passing yards</h3>${passTable(agg.leaders.passing, 10, true)}</div>
          <div class="stat-block"><h3>Rushing yards</h3>${rushTable(agg.leaders.rushing, 10, true)}</div>
          <div class="stat-block"><h3>Receiving yards</h3>${recTable(agg.leaders.receiving, 10, true)}</div>
        </div>
      </div>`;
  }

  /* ---------- Depth chart ---------- */
  async function renderDepth() {
    const el = $("#depthChart");
    const sel = $("#depthTeamSelect");
    if (!sel.options.length) {
      const t = team(state.teamId);
      const sched = activeSchedules()[state.teamId] || [];
      const oppIds = new Set();
      for (const g of sched) {
        if (g.opponentId) oppIds.add(String(g.opponentId));
      }
      const opts = [];
      opts.push(`<option value="${t.id}">${escapeHtml(t.shortName || t.name)} (yours)</option>`);
      // Opponents first
      for (const oid of oppIds) {
        if (oid === String(t.id)) continue;
        const opp = team(oid);
        if (!opp || !opp.isFbs) continue;
        opts.push(`<option value="${opp.id}">${escapeHtml(opp.shortName || opp.name)} · OVR ${opp.overall != null ? opp.overall : "—"}</option>`);
      }
      opts.push(`<option disabled>────────</option>`);
      for (const id of DATA.fbsTeamIds) {
        if (id === t.id || oppIds.has(String(id))) continue;
        const o = DATA.teams[id];
        if (!o) continue;
        opts.push(`<option value="${o.id}">${escapeHtml(o.shortName || o.name)} · OVR ${o.overall != null ? o.overall : "—"}</option>`);
      }
      sel.innerHTML = opts.join("");
    }
    const tid = sel.value || state.teamId;
    const roster = await effectiveRoster(tid);
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
          <div class="muted small">Team OVR <strong>${(effectiveTeam(tid)||t).overall != null ? (effectiveTeam(tid)||t).overall : "—"}</strong> · Off ${(effectiveTeam(tid)||t).offense != null ? (effectiveTeam(tid)||t).offense : "—"} · Def ${(effectiveTeam(tid)||t).defense != null ? (effectiveTeam(tid)||t).defense : "—"} · ${roster.players.length} players · ${(roster.ovrSource||"").indexOf("teamcrafters")>=0?"CFB27 OVRs":"ESPN base"}${(roster.players||[]).filter(p=>p.src==="alltime").length ? " + " + (roster.players||[]).filter(p=>p.src==="alltime").length + " all-time" : ""}${(roster.players||[]).some(p=>p.ovr!=null) ? " · depth by OVR" : ""}${String(tid)===String(state.teamId) && (state.ownedPlayerIds||[]).length ? " · shop active" : ""}</div>
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
                      const isAt = p.src === "alltime" || String(p.c || "").toUpperCase() === "AT";
                      let badge = "";
                      if (isAt) badge = `<span class="class-badge at" title="All-time shop">AT</span>`;
                      else if (p.src === "tc") badge = `<span class="class-badge" title="TeamCrafters CFB27">TC</span>`;
                      else badge = classBadge(p.c);
                      const ovr = p.ovr != null ? `<span class="ovr-pill ${p.ovr>=95?"elite":p.ovr>=88?"great":""}" title="Overall">${p.ovr}</span>` : "";
                      const name = escapeHtml(p.n || "");
                      return `<li class="depth-row"><span class="depth-slot">${slot + 1}</span><span class="jersey">#${escapeHtml(p.j || "—")}</span><span class="pname" title="${name}">${name}</span><span class="depth-meta">${badge}${ovr}<span class="pos-tag">${escapeHtml(p.p || "")}</span></span></li>`;
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
        ${(opts && opts.coinsHtml) ? opts.coinsHtml : ""}
        ${actions}
      </div>`;
  }

  function currentSeasonRecap() {
    const ranked = CFBSim.computeTop25(
      DATA.fbsTeamIds,
      DATA.teams,
      resultsList(),
      activeSchedules(),
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
    const payout = awardSeasonCoinsIfNeeded();
    updateCoinUI();
    let coinsHtml = "";
    if (payout) {
      const lines = (payout.lines || [])
        .map((l) => `<div class="payout-line"><span>${escapeHtml(l.label)}${l.detail ? " · " + escapeHtml(l.detail) : ""}</span><span class="goal-amt">+${l.amount}</span></div>`)
        .join("") || '<div class="muted small">No goal payouts this season.</div>';
      coinsHtml = `<div class="recap-coins"><h3>Coins earned · ${payout.year}</h3>${lines}<div class="payout-total">Payout +${payout.total} · Balance ${state.coins}</div></div>`;
    }
    const actions = `<div class="recap-actions">
        <button type="button" class="btn btn-primary" id="btnOpenShop">All-Time Shop</button>
        <button type="button" class="btn btn-ghost" id="btnStartNextSeason">Start next season</button>
        <span class="muted small">Shop between seasons · purchases stay on your roster</span>
      </div>`;
    const html = buildRecapHtml(recap, t, { actions, coinsHtml });
    wrap.hidden = false;
    wrap.innerHTML = html;
    if (panel) panel.innerHTML = html;
    $$("#btnStartNextSeason").forEach((btn) => {
      btn.addEventListener("click", () => startNextSeason());
    });
    $$("#btnOpenShop").forEach((btn) => {
      btn.addEventListener("click", () => openShop());
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
            <button type="button" class="btn btn-primary" id="btnOpenShopHistory">All-Time Shop</button>
            <button type="button" class="btn btn-ghost" id="btnStartNextSeasonHistory">Start next season</button>
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
    const shopBtn = $("#btnOpenShopHistory");
    if (shopBtn) shopBtn.addEventListener("click", () => openShop());
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


  /* ---------- All-Time Shop (between seasons + pre-season browse) ---------- */
  function showShop() {
    $("#view-picker").hidden = true;
    $("#view-season").hidden = true;
    $("#view-shop").hidden = false;
    $("#topbarActions").hidden = shopReturn === "picker";
    updateCoinUI();
  }

  function configureShopChrome() {
    const eyebrow = $("#shopEyebrow");
    const blurb = $("#shopBlurb");
    const back = $("#btnShopBack");
    const go = $("#btnShopStartSeason");
    const between = shopReturn === "recap";
    const canBuy = canPurchaseInShop();
    if (eyebrow) {
      eyebrow.textContent = between
        ? "Between seasons"
        : (canBuy ? "Pre-season" : "Browse only");
    }
    if (blurb) {
      if (between) {
        blurb.textContent = "Spend coins on real historical greats. They join your depth chart as starters and give a soft rating boost.";
      } else if (canBuy) {
        blurb.textContent = "Browse and buy before you sim. Purchases join your depth chart when you pick a team (or right away if you already have).";
      } else {
        blurb.textContent = "Browsing the catalog mid-season. Purchases unlock again between seasons (or reset to pre-season). Owned players already on your depth chart stay active.";
      }
    }
    if (back) {
      back.textContent = between ? "Back to recap" : (shopReturn === "picker" ? "Back to team pick" : "Back to season");
    }
    if (go) {
      go.hidden = !between;
      go.textContent = "Start next season";
    }
  }

  function refreshShopPanels() {
    populateShopTeamFilter();
    renderShopOwned();
    renderShopGrid();
    configureShopChrome();
    showShop();
  }

  /** Between-season shop (after a completed year). */
  function openShop() {
    if (state.phase !== "complete" || !state.teamId) {
      toast("Between-season shop opens after the year ends — use Browse All-Time Shop before you sim");
      return;
    }
    shopReturn = "recap";
    awardSeasonCoinsIfNeeded();
    refreshShopPanels();
  }

  /** From team picker — browse (and optionally buy with starting coins) before picking. */
  function openShopFromPicker() {
    if (!$("#view-shop")) {
      toast("Shop view missing — reload the page");
      return;
    }
    shopReturn = "picker";
    preferIowaShopFilter();
    refreshShopPanels();
    applyShopTeamFilterSelect();
  }

  /** Prefer Iowa filter when the user's school is Iowa (catalog school id 2294). */
  function preferIowaShopFilter() {
    if (!ALLTIME || shopFilter.teamId) return;
    if (ALLTIME.teams && ALLTIME.teams["2294"] && !state.teamId) {
      shopFilter.teamId = "2294";
      return;
    }
    if (!state.teamId) return;
    const t = team(state.teamId);
    if (t && /iowa/i.test(t.name) && !/state/i.test(t.name)) shopFilter.teamId = "2294";
  }

  function applyShopTeamFilterSelect() {
    const teamF = $("#shopTeamFilter");
    if (teamF && shopFilter.teamId) teamF.value = shopFilter.teamId;
    renderShopGrid();
  }

  /**
   * From the main season screen (or topbar). Always opens the shop.
   * Purchases remain gated by canPurchaseInShop(); mid-season is browse-only.
   */
  function openShopFromSeason() {
    if (state.phase === "complete" && state.teamId) {
      openShop();
      return;
    }
    if (!$("#view-shop")) {
      toast("Shop view missing — reload the page");
      return;
    }
    shopReturn = "season";
    preferIowaShopFilter();
    refreshShopPanels();
    applyShopTeamFilterSelect();
  }

  function closeShop() {
    $("#view-shop").hidden = true;
    if (shopReturn === "picker") {
      showPicker();
      updateCoinUI();
      return;
    }
    showSeason();
    if (shopReturn === "recap") switchTab("recap");
    else switchTab("schedule");
    updateCoinUI();
  }

  function closeShopToRecap() {
    shopReturn = "recap";
    closeShop();
  }

  function populateShopTeamFilter() {
    const sel = $("#shopTeamFilter");
    if (!sel || !ALLTIME) return;
    const cur = sel.value;
    const teams = Object.values(ALLTIME.teams || {}).slice().sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">All teams</option>' + teams.map((t) =>
      `<option value="${t.id}">${escapeHtml(t.name)} (${t.count})</option>`
    ).join("");
    if (cur) sel.value = cur;
  }

  function renderShopOwned() {
    const el = $("#shopOwnedList");
    if (!el) return;
    const owned = ownedCatalogPlayers();
    if (!owned.length) {
      el.innerHTML = "None yet — buy players from the catalog.";
      return;
    }
    el.innerHTML = owned
      .slice()
      .sort((a, b) => b.ovr - a.ovr)
      .map((p) => {
        const nm = escapeHtml(p.n || "");
        const meta = escapeHtml(`${p.p || ""} · ${p.school || ""}`);
        return `<div class="owned-item"><span class="owned-name" title="${nm} · ${meta}">${nm} <span class="owned-meta">${meta}</span></span><span class="ovr-pill ${p.ovr>=95?"elite":p.ovr>=88?"great":""}">${p.ovr}</span></div>`;
      })
      .join("");
  }

  function filteredShopPlayers() {
    if (!ALLTIME || !ALLTIME.players) return [];
    const q = (shopFilter.q || "").trim().toLowerCase();
    let list = ALLTIME.players.slice();
    if (shopFilter.teamId) list = list.filter((p) => String(p.schoolId) === String(shopFilter.teamId));
    if (shopFilter.pos) list = list.filter((p) => CFBRosterEngine.depthBucket(p.p) === shopFilter.pos);
    if (q) {
      list = list.filter((p) =>
        p.n.toLowerCase().includes(q) ||
        (p.school || "").toLowerCase().includes(q) ||
        (p.p || "").toLowerCase().includes(q)
      );
    }
    const owned = new Set(state.ownedPlayerIds || []);
    const sort = shopFilter.sort || "ovr";
    list.sort((a, b) => {
      if (sort === "cost") return b.cost - a.cost || b.ovr - a.ovr;
      if (sort === "name") return a.n.localeCompare(b.n);
      if (sort === "school") return a.school.localeCompare(b.school) || b.ovr - a.ovr;
      return b.ovr - a.ovr || a.n.localeCompare(b.n);
    });
    // Prefer showing owned first lightly? No — keep sort, mark owned in card
    return list;
  }

  function renderShopGrid() {
    const el = $("#shopGrid");
    const meta = $("#shopMeta");
    if (!el) return;
    if (!ALLTIME) {
      el.innerHTML = '<div class="box-empty">All-time catalog failed to load.</div>';
      return;
    }
    const owned = new Set(state.ownedPlayerIds || []);
    const list = filteredShopPlayers();
    if (meta) {
      meta.textContent = `${list.length} players shown · ${ALLTIME.playerCount} in catalog · ${owned.size} owned · balance ${state.coins}`;
    }
    const MAX = 120;
    const slice = list.slice(0, MAX);
    if (!slice.length) {
      el.innerHTML = '<div class="box-empty">No players match these filters.</div>';
      return;
    }
    const purchaseOk = canPurchaseInShop();
    el.innerHTML = slice.map((p) => {
      const isOwned = owned.has(p.id);
      const canBuy = purchaseOk && !isOwned && state.coins >= p.cost;
      const ovrClass = p.ovr >= 95 ? "elite" : p.ovr >= 88 ? "great" : "";
      let btn;
      if (isOwned) {
        btn = `<button type="button" class="btn btn-ghost btn-buy" disabled>Owned</button>`;
      } else if (!purchaseOk) {
        btn = `<button type="button" class="btn btn-ghost btn-buy" disabled title="Purchases unlock pre-season or between seasons">Browse only</button>`;
      } else {
        btn = `<button type="button" class="btn btn-primary btn-buy" data-buy="${p.id}" ${canBuy ? "" : "disabled"}>${canBuy ? "Buy" : "Need coins"}</button>`;
      }
      return `<div class="shop-card-player ${isOwned ? "owned" : ""}">
        <div class="sp-top">
          <div>
            <div class="sp-name">${escapeHtml(p.n)}</div>
            <div class="sp-meta">${escapeHtml(p.p)} · ${escapeHtml(p.school)}</div>
          </div>
          <span class="ovr-pill ${ovrClass}">${p.ovr}</span>
        </div>
        <div class="sp-actions">
          <span class="shop-cost">${p.cost} coins</span>
          ${btn}
        </div>
      </div>`;
    }).join("") + (list.length > MAX ? `<div class="muted small" style="grid-column:1/-1;padding:8px">Showing ${MAX} of ${list.length} — refine filters to narrow.</div>` : "");

    el.querySelectorAll("[data-buy]").forEach((btn) => {
      btn.addEventListener("click", () => purchasePlayer(btn.getAttribute("data-buy")));
    });
  }

  function purchasePlayer(playerId) {
    if (!canPurchaseInShop()) {
      toast("Purchases only pre-season or between seasons");
      return;
    }
    if (!ALLTIME) return;
    const player = ALLTIME.players.find((p) => p.id === playerId);
    if (!player) return;
    if ((state.ownedPlayerIds || []).includes(playerId)) {
      toast("Already owned");
      return;
    }
    if ((state.coins || 0) < player.cost) {
      toast("Not enough coins");
      return;
    }
    state.coins -= player.cost;
    state.ownedPlayerIds = (state.ownedPlayerIds || []).concat([playerId]);
    // Invalidate cached effective roster by clearing nothing — effectiveRoster rebuilds from base+owned
    save();
    updateCoinUI();
    renderShopOwned();
    renderShopGrid();
    toast(`Signed ${player.n} (${player.ovr} OVR) · #1 ${CFBRosterEngine.depthBucket(player.p)}`);
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
    state.nonConfOverrides = {};
    state.generatedSchedule = null; // force fresh slate for the new year
    if (nextYear > 2026) ensureGeneratedSchedule();
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    save();
    if ($("#view-shop")) $("#view-shop").hidden = true;
    showSeason();
    switchTab("schedule");
    updateCoinUI();
    toast(
      archived
        ? `${archived.year} archived · ${nextYear} schedule generated`
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
    const home = effectiveTeam(g.homeId) || stubTeam(g.homeId, "Home");
    const away = effectiveTeam(g.awayId) || stubTeam(g.awayId, "Away");
    await loadRosters([g.homeId, g.awayId]);
    const homeRoster =
      String(g.homeId) === String(state.teamId)
        ? await effectiveRoster(g.homeId)
        : rosterCache[g.homeId] || null;
    const awayRoster =
      String(g.awayId) === String(state.teamId)
        ? await effectiveRoster(g.awayId)
        : rosterCache[g.awayId] || null;
    return CFBSim.simulateGame(home, away, {
      eventId: g.eventId,
      week: weekLabel != null ? weekLabel : g.week,
      neutralSite: g.neutralSite,
      seasonSeed: state.seasonSeed,
      homeRoster,
      awayRoster,
      label: g.label || null,
      bowl: g.bowl || null,
      round: g.round || null,
    });
  }

  async function simNextWeek() {
    if (state.phase === "complete") {
      openShop();
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
    const games = activeGames().filter((g) => g.week === week);
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
    while (state.currentWeek <= maxWeek() && !activeGames().some((g) => g.week === state.currentWeek)) {
      state.currentWeek++;
    }

    save();
    renderSeason();

    if (userBox) {
      switchTab("box");
      toast(`Week ${week} done · ${count} games simmed`);
    } else {
      const bye = !(activeSchedules()[state.teamId] || []).some((g) => g.week === week);
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
      activeSchedules(),
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
    const keepCoins = typeof state.coins === "number" ? state.coins : CFBEconomy.STARTING_COINS;
    const keepOwned = Array.isArray(state.ownedPlayerIds) ? state.ownedPlayerIds : [];
    const keepClaimed = state.claimedGoals && typeof state.claimedGoals === "object" ? state.claimedGoals : {};
    const keepPayout = state.lastSeasonPayout || null;
    state.teamId = id;
    state.seasonYear = keepYear;
    state.history = keepHistory;
    state.coins = keepCoins;
    state.ownedPlayerIds = keepOwned;
    state.claimedGoals = keepClaimed;
    state.lastSeasonPayout = keepPayout;
    state.currentWeek = 1;
    state.results = {};
    state.seasonSeed = (Date.now() % 1e9) ^ CFBSim.hashSeed(id + "|" + keepYear);
    state.phase = "regular";
    state.postseason = null;
    state.nonConfOverrides = {};
    // reset depth select
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    save();
    loadRoster(id); // warm cache
    showSeason();
    switchTab("schedule");
    updateCoinUI();
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
    state.nonConfOverrides = {};
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    save();
    renderSeason();
    switchTab("schedule");
    toast("Season reset · history kept");
  }

  /** Remove every localStorage key this game writes (current + legacy). Auto-save still works after. */
  function wipePersistedKeys() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
      const extra = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("cfb-sim") === 0) extra.push(k);
      }
      extra.forEach((k) => localStorage.removeItem(k));
    } catch (_) { /* ignore quota / private mode */ }
  }

  /** Full wipe: history, coins, shop buys, current season — back to team pick. */
  function fullReset() {
    if (!confirm("Full reset?\n\nThis clears history, coins, shop buys, and all progress. This cannot be undone.")) {
      return;
    }
    wipePersistedKeys();
    state = createFreshState();
    shopFilter = { q: "", teamId: "", pos: "", sort: "ovr" };
    const sel = $("#depthTeamSelect");
    if (sel) sel.innerHTML = "";
    const search = $("#teamSearch");
    if (search) search.value = "";
    const conf = $("#confFilter");
    if (conf) conf.value = "";
    if ($("#view-shop")) $("#view-shop").hidden = true;
    // Do not save() here — empty start has no team; first pick will auto-save again.
    renderPicker();
    showPicker();
    updateCoinUI();
    toast("Full reset · pick a team to start fresh");
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
    try {
      const ar = await fetch("data/alltime-players.json");
      if (ar.ok) {
        ALLTIME = await ar.json();
        // Keep catalog costs in sync with roster-engine formula
        if (ALLTIME && Array.isArray(ALLTIME.players) && typeof CFBRosterEngine !== "undefined") {
          ALLTIME.players.forEach((p) => {
            if (p && p.ovr != null) p.cost = CFBRosterEngine.costForOvr(p.ovr);
          });
        }
      }
    } catch (e) {
      console.warn("alltime catalog", e);
      ALLTIME = null;
    }
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
    const btnFullReset = $("#btnFullReset");
    if (btnFullReset) btnFullReset.addEventListener("click", fullReset);
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

    // Shop controls
    const bindShop = () => {
      const search = $("#shopSearch");
      const teamF = $("#shopTeamFilter");
      const posF = $("#shopPosFilter");
      const sortF = $("#shopSort");
      if (search) search.addEventListener("input", () => { shopFilter.q = search.value; renderShopGrid(); });
      if (teamF) teamF.addEventListener("change", () => { shopFilter.teamId = teamF.value; renderShopGrid(); });
      if (posF) posF.addEventListener("change", () => { shopFilter.pos = posF.value; renderShopGrid(); });
      if (sortF) sortF.addEventListener("change", () => { shopFilter.sort = sortF.value; renderShopGrid(); });
      const back = $("#btnShopBack");
      if (back) back.addEventListener("click", () => closeShop());
      const go = $("#btnShopStartSeason");
      if (go) go.addEventListener("click", () => startNextSeason());
    };
    bindShop();
    const browse = $("#btnBrowseShop");
    if (browse) browse.addEventListener("click", () => openShopFromPicker());
    const seasonShop = $("#btnSeasonShop");
    if (seasonShop) seasonShop.addEventListener("click", () => openShopFromSeason());
    const topShop = $("#btnTopShop");
    if (topShop) topShop.addEventListener("click", () => openShopFromSeason());

    if (usesGeneratedSchedule()) ensureGeneratedSchedule();
    if (state.teamId && DATA.teams[state.teamId] && DATA.teams[state.teamId].isFbs) {
      showSeason();
      updateCoinUI();
    } else {
      showPicker();
      updateCoinUI();
    }
  }

  init().catch((err) => {
    console.error(err);
    $("#teamGrid").innerHTML = '<div class="empty">Could not load data/cfb-2026.json. Serve over HTTP.</div>';
  });
})();
