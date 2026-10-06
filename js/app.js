(function () {
  "use strict";

  const STORAGE_KEY = "cfb-sim-2026-v1";
  let DATA = null;
  let state = {
    teamId: null,
    currentWeek: 1, // next week to sim (1..15); after simming week N, currentWeek = N+1
    results: {}, // eventId -> box
    seasonSeed: Date.now() % 1e9,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") state = Object.assign(state, parsed);
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

  function renderSeason() {
    const t = team(state.teamId);
    if (!t) return;
    const rec = CFBSim.teamRecord(resultsList(), state.teamId);
    $("#myTeamChip").innerHTML = `
      <img src="${t.logo}" alt="" width="52" height="52" onerror="this.style.visibility='hidden'" />
      <div>
        <h2>${escapeHtml(t.name)}</h2>
        <div class="sub">${escapeHtml(t.conference)} · OVR ${t.overall}${t.apRank ? " · seeded AP #" + t.apRank : ""}</div>
      </div>`;

    const next = state.currentWeek;
    const done = next > maxWeek();
    $("#weekLabel").textContent = done ? "Season complete" : "Ready for Week " + next;
    $("#recordLabel").textContent = rec.w + "–" + rec.l;
    const btn = $("#btnSimWeek");
    btn.disabled = done;
    btn.textContent = done ? "Season complete" : "Sim Week " + next;

    renderSchedule();
    renderBox();
    renderStandings();
    renderTop25();
  }

  function renderSchedule() {
    const sched = (DATA.schedules[state.teamId] || []).slice().sort((a, b) => a.week - b.week || a.date.localeCompare(b.date));
    const next = state.currentWeek;
    const html = sched
      .map((g) => {
        const opp = team(g.opponentId) || {
          name: g.opponentName,
          logo: `https://a.espncdn.com/i/teamlogos/ncaa/500/${g.opponentId}.png`,
          abbreviation: g.opponentAbbr,
        };
        const res = state.results[g.eventId];
        const isCurrent = g.week === next && !res;
        const where = g.neutralSite ? "Neutral" : g.homeAway === "home" ? "Home" : "Away";
        let resultHtml = '<span class="result pending">—</span>';
        if (res) {
          const mine = res.homeId === state.teamId ? res.homeScore : res.awayScore;
          const theirs = res.homeId === state.teamId ? res.awayScore : res.homeScore;
          const win = mine > theirs;
          resultHtml = `<span class="result ${win ? "win" : "loss"}">${win ? "W" : "L"} ${mine}–${theirs}</span>`;
        }
        return `
          <div class="game-row ${res ? "played" : ""} ${isCurrent ? "current" : ""}" data-event="${g.eventId}">
            <div class="week-num">W${g.week}</div>
            <div class="opp">
              <img src="${opp.logo}" alt="" width="28" height="28" onerror="this.style.visibility='hidden'" />
              <div>
                <div class="who">${g.homeAway === "home" ? "vs" : "@"} ${escapeHtml(opp.shortName || opp.name || g.opponentName)}</div>
                <div class="where">${where} · ${formatDate(g.date)}</div>
              </div>
            </div>
            ${resultHtml}
          </div>`;
      })
      .join("");
    $("#scheduleList").innerHTML = html || '<div class="empty">No schedule found for this team.</div>';
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
    } catch (_) {
      return iso.slice(0, 10);
    }
  }

  function renderBox() {
    const el = $("#boxScore");
    // Show most recent user game box
    const sched = DATA.schedules[state.teamId] || [];
    let last = null;
    for (const g of sched) {
      if (state.results[g.eventId]) last = state.results[g.eventId];
    }
    if (!last) {
      el.innerHTML = '<div class="box-empty">Sim a week to see your box score.</div>';
      return;
    }
    el.innerHTML = boxHtml(last);
  }

  function boxHtml(res) {
    const home = team(res.homeId);
    const away = team(res.awayId);
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
    const mid = `Week ${res.week}${res.ot ? " · OT" : ""}${res.neutralSite ? " · Neutral" : ""}`;

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
          <div class="box-mid">${mid}<br/>FINAL</div>
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
        const rec = CFBSim.teamRecord(resultsList(), m.id);
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

  function renderTop25() {
    const poll = CFBSim.computeTop25(
      DATA.fbsTeamIds,
      DATA.teams,
      resultsList(),
      DATA.schedules,
      state.currentWeek
    );
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

  /* ---------- Simulation ---------- */
  function simNextWeek() {
    const week = state.currentWeek;
    if (week > maxWeek()) return;

    const games = DATA.games.filter((g) => g.week === week);
    let userBox = null;
    let count = 0;

    for (const g of games) {
      if (state.results[g.eventId]) continue;
      const home = team(g.homeId) || stubTeam(g.homeId, "Home");
      const away = team(g.awayId) || stubTeam(g.awayId, "Away");
      const box = CFBSim.simulateGame(home, away, {
        eventId: g.eventId,
        week,
        neutralSite: g.neutralSite,
        seasonSeed: state.seasonSeed,
      });
      state.results[g.eventId] = box;
      count++;
      if (g.homeId === state.teamId || g.awayId === state.teamId) userBox = box;
    }

    state.currentWeek = week + 1;
    // skip empty weeks (e.g. week 14 with 0 games)
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
  }

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

  function pickTeam(id) {
    state.teamId = id;
    state.currentWeek = 1;
    state.results = {};
    state.seasonSeed = (Date.now() % 1e9) ^ CFBSim.hashSeed(id);
    save();
    showSeason();
    switchTab("schedule");
    toast("Season started · " + team(id).shortName);
  }

  function resetSeason() {
    if (!state.teamId) return;
    if (!confirm("Reset this season? All simmed results will be cleared.")) return;
    const id = state.teamId;
    state.currentWeek = 1;
    state.results = {};
    state.seasonSeed = (Date.now() % 1e9) ^ CFBSim.hashSeed(id + "|reset");
    save();
    renderSeason();
    switchTab("schedule");
    toast("Season reset");
  }

  function switchTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    ["schedule", "box", "standings", "top25"].forEach((p) => {
      $("#panel-" + p).hidden = p !== name;
    });
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
    $("#btnSimWeek").addEventListener("click", simNextWeek);
    $("#btnReset").addEventListener("click", resetSeason);
    $("#btnChangeTeam").addEventListener("click", () => {
      if (!confirm("Leave this season and pick a different team? Progress is kept in localStorage until you pick again (picking resets).")) return;
      state.teamId = null;
      state.currentWeek = 1;
      state.results = {};
      save();
      showPicker();
    });
    $$(".tab").forEach((t) =>
      t.addEventListener("click", () => switchTab(t.dataset.tab))
    );

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
