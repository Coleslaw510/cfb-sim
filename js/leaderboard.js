/* Public All-Time Seasons leaderboard — local HoF + GitHub Issues → data/leaderboard.json */
(function (global) {
  "use strict";

  const HOF_KEY = "cfb-sim-hof-v1";
  const BOARD_URL = "data/leaderboard.json";
  const REPO_ISSUES = "https://github.com/Coleslaw510/cfb-sim/issues/new";
  const LABEL = "leaderboard";

  function loadLocalHof() {
    try {
      const raw = localStorage.getItem(HOF_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveLocalHof(entries) {
    try {
      localStorage.setItem(HOF_KEY, JSON.stringify(entries.slice(0, 100)));
    } catch (_) { /* ignore */ }
  }

  function upsertLocal(entry) {
    const list = loadLocalHof();
    const fp = entry.fingerprint;
    const next = list.filter((e) => e.fingerprint !== fp && e.id !== entry.id);
    next.unshift(entry);
    saveLocalHof(next);
    return next;
  }

  function simpleHash(str) {
    let h = 2166136261;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function greatnessScore(entry) {
    const rec = entry.record || {};
    const w = Number(rec.w) || 0;
    const l = Number(rec.l) || 0;
    let score = w * 100 - l * 40;
    const rank = entry.finalRank;
    if (rank && rank >= 1 && rank <= 25) score += (26 - rank) * 80;
    const bowl = String(entry.bowlResult || "").toLowerCase();
    if (bowl.includes("national championship") && bowl.startsWith("won")) score += 2500;
    else if (bowl.includes("national championship")) score += 900;
    else if (bowl.includes("cfp") && bowl.startsWith("won")) score += 500;
    else if (bowl.startsWith("won")) score += 220;
    const summary = String(entry.summary || "").toLowerCase();
    if (summary.includes("won conference championship")) score += 250;
    if (typeof entry.teamOvr === "number") score += Math.round(entry.teamOvr) * 2;
    return score;
  }

  function validateEntry(entry, fbsIds) {
    if (!entry || typeof entry !== "object") return "Missing entry";
    if (!entry.teamId) return "Missing team";
    if (fbsIds && fbsIds.length && fbsIds.indexOf(String(entry.teamId)) < 0) {
      return "Team is not FBS";
    }
    const year = Number(entry.year);
    if (!year || year < 2026 || year > 2200) return "Invalid year";
    const w = Number(entry.record && entry.record.w);
    const l = Number(entry.record && entry.record.l);
    if (!Number.isFinite(w) || !Number.isFinite(l)) return "Missing record";
    if (w < 0 || l < 0 || w > 20 || l > 20) return "Record out of range";
    if (w + l < 1 || w + l > 24) return "Finish a full season before submitting";
    if (entry.coachName && String(entry.coachName).length > 40) return "Coach name too long";
    return null;
  }

  function buildIssueBody(entry) {
    const rec = entry.record || {};
    const conf = entry.confRecord || {};
    const headline =
      (entry.teamName || "Team") +
      " " +
      (entry.year || "") +
      " · " +
      rec.w +
      "–" +
      rec.l +
      (entry.finalRank ? " · #" + entry.finalRank : "");
    const json = JSON.stringify(entry);
    return (
      "<!-- cfb-leaderboard-entry " +
      json +
      " -->\n\n" +
      "## All-Time Board submission\n\n" +
      "**" +
      headline +
      "**\n\n" +
      "- Coach: " +
      (entry.coachName || "—") +
      "\n" +
      "- Conference: " +
      (entry.conference || "—") +
      " (" +
      (conf.w != null ? conf.w + "–" + conf.l : "—") +
      ")\n" +
      "- Bowl / CFP: " +
      (entry.bowlResult || "—") +
      "\n" +
      "- Team OVR: " +
      (entry.teamOvr != null ? entry.teamOvr : "—") +
      "\n" +
      "- Shop buys: " +
      ((entry.shopBuys && entry.shopBuys.length) || 0) +
      "\n\n" +
      "_Submitted from [cfb-sim](https://coleslaw510.github.io/cfb-sim/). A GitHub Action will merge valid entries into `data/leaderboard.json`._\n"
    );
  }

  function buildIssueUrl(entry) {
    const title =
      "[CFB Leaderboard] " +
      (entry.teamName || "Team") +
      " " +
      (entry.year || "") +
      " " +
      (entry.record ? entry.record.w + "-" + entry.record.l : "");
    const body = buildIssueBody(entry);
    const url =
      REPO_ISSUES +
      "?title=" +
      encodeURIComponent(title) +
      "&labels=" +
      encodeURIComponent(LABEL) +
      "&body=" +
      encodeURIComponent(body);
    return { url: url, tooLong: url.length > 7000, body: body, title: title };
  }

  async function fetchPublicBoard() {
    const res = await fetch(BOARD_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load leaderboard");
    const data = await res.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      updatedAt: data.updatedAt || null,
      entries: entries.map((e) => {
        if (e.score == null) e.score = greatnessScore(e);
        return e;
      }),
    };
  }

  function mergeBoards(publicEntries, localEntries) {
    const byFp = new Map();
    (publicEntries || []).forEach((e) => {
      const key = e.fingerprint || e.id;
      if (key) byFp.set(key, Object.assign({ source: "public" }, e));
    });
    (localEntries || []).forEach((e) => {
      const key = e.fingerprint || e.id;
      if (!key) return;
      if (byFp.has(key)) {
        const pub = byFp.get(key);
        byFp.set(key, Object.assign({}, pub, { source: "public", localPending: false }));
      } else {
        byFp.set(key, Object.assign({ source: "local", localPending: true }, e));
      }
    });
    return Array.from(byFp.values()).sort(
      (a, b) => (b.score || 0) - (a.score || 0) || String(b.submittedAt || "").localeCompare(String(a.submittedAt || ""))
    );
  }

  function sortEntries(entries, sortKey) {
    const list = (entries || []).slice();
    switch (sortKey) {
      case "wins":
        list.sort((a, b) => (b.record?.w || 0) - (a.record?.w || 0) || (a.record?.l || 0) - (b.record?.l || 0));
        break;
      case "rank":
        list.sort((a, b) => {
          const ar = a.finalRank || 99;
          const br = b.finalRank || 99;
          return ar - br || (b.score || 0) - (a.score || 0);
        });
        break;
      case "year":
        list.sort((a, b) => (b.year || 0) - (a.year || 0) || (b.score || 0) - (a.score || 0));
        break;
      case "ovr":
        list.sort((a, b) => (b.teamOvr || 0) - (a.teamOvr || 0) || (b.score || 0) - (a.score || 0));
        break;
      case "date":
        list.sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
        break;
      case "score":
      default:
        list.sort((a, b) => (b.score || 0) - (a.score || 0));
        break;
    }
    return list;
  }

  global.CFBLeaderboard = {
    HOF_KEY,
    loadLocalHof,
    saveLocalHof,
    upsertLocal,
    simpleHash,
    greatnessScore,
    validateEntry,
    buildIssueBody,
    buildIssueUrl,
    fetchPublicBoard,
    mergeBoards,
    sortEntries,
  };
})(window);
