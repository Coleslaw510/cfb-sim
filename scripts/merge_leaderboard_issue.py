#!/usr/bin/env python3
"""Parse a GitHub issue body for a CFB leaderboard JSON entry and merge into data/leaderboard.json."""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_PATH = ROOT / "data" / "leaderboard.json"
MARKER_START = "<!-- cfb-leaderboard-entry"
MARKER_END = "-->"
MAX_ENTRIES = 2000


def extract_payload(body: str) -> dict:
    if not body:
        raise ValueError("Empty issue body")
    # Prefer HTML comment marker block
    m = re.search(
        r"<!--\s*cfb-leaderboard-entry\s*(\{.*?\})\s*-->",
        body,
        flags=re.DOTALL,
    )
    if m:
        return json.loads(m.group(1))
    # Fallback: fenced json
    m = re.search(r"```json\s*(\{.*?\})\s*```", body, flags=re.DOTALL)
    if m:
        return json.loads(m.group(1))
    raise ValueError("No leaderboard JSON payload found")


def sanity(entry: dict) -> dict:
    if not isinstance(entry, dict):
        raise ValueError("Entry must be an object")
    team_id = str(entry.get("teamId") or "").strip()
    if not team_id:
        raise ValueError("Missing teamId")
    year = int(entry.get("year") or 0)
    if year < 2026 or year > 2200:
        raise ValueError("Invalid year")
    rec = entry.get("record") or {}
    w = int(rec.get("w") or 0)
    l = int(rec.get("l") or 0)
    if w < 0 or l < 0 or w > 20 or l > 20 or (w + l) < 1 or (w + l) > 24:
        raise ValueError("Implausible record")
    coach = str(entry.get("coachName") or "").strip()[:40]
    entry["coachName"] = coach or None
    entry["teamId"] = team_id
    entry["year"] = year
    entry["record"] = {"w": w, "l": l}
    # Cap nested lists
    if isinstance(entry.get("keyPlayers"), list):
        entry["keyPlayers"] = entry["keyPlayers"][:30]
    if isinstance(entry.get("shopBuys"), list):
        entry["shopBuys"] = entry["shopBuys"][:40]
    if isinstance(entry.get("schedule"), list):
        entry["schedule"] = entry["schedule"][:24]
    if not entry.get("id"):
        entry["id"] = f"{team_id}-{year}-{w}-{l}-{entry.get('fingerprint') or 'x'}"[:80]
    if not entry.get("submittedAt"):
        entry["submittedAt"] = datetime.now(timezone.utc).isoformat()
    return entry


def greatness_score(entry: dict) -> int:
    if entry.get("score") is not None:
        try:
            return int(entry["score"])
        except Exception:
            pass
    rec = entry.get("record") or {}
    w = int(rec.get("w") or 0)
    l = int(rec.get("l") or 0)
    score = w * 100 - l * 40
    rank = entry.get("finalRank")
    if isinstance(rank, int) and 1 <= rank <= 25:
        score += (26 - rank) * 80
    bowl = str(entry.get("bowlResult") or "").lower()
    if "national championship" in bowl and bowl.startswith("won"):
        score += 2500
    elif "national championship" in bowl:
        score += 900
    elif "cfp" in bowl and bowl.startswith("won"):
        score += 500
    elif bowl.startswith("won"):
        score += 220
    if "conference championship" in str(entry.get("summary") or "").lower():
        if "won conference" in str(entry.get("summary") or "").lower():
            score += 250
    ovr = entry.get("teamOvr")
    if isinstance(ovr, (int, float)):
        score += int(ovr) * 2
    return score


def main() -> int:
    body = os.environ.get("ISSUE_BODY") or ""
    if not body and len(sys.argv) > 1:
        body = Path(sys.argv[1]).read_text(encoding="utf-8")
    try:
        entry = sanity(extract_payload(body))
    except Exception as e:
        print(f"REJECT: {e}", file=sys.stderr)
        return 2

    entry["score"] = greatness_score(entry)

    if BOARD_PATH.exists():
        board = json.loads(BOARD_PATH.read_text(encoding="utf-8"))
    else:
        board = {"version": 1, "updatedAt": None, "entries": []}

    entries = board.get("entries") or []
    fp = entry.get("fingerprint")
    # Dedupe by fingerprint or id
    kept = []
    for e in entries:
        if fp and e.get("fingerprint") == fp:
            continue
        if e.get("id") == entry.get("id"):
            continue
        kept.append(e)
    kept.append(entry)
    kept.sort(key=lambda e: (-int(e.get("score") or 0), str(e.get("submittedAt") or "")))
    board["entries"] = kept[:MAX_ENTRIES]
    board["updatedAt"] = datetime.now(timezone.utc).isoformat()
    board["version"] = 1
    BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    BOARD_PATH.write_text(json.dumps(board, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"OK merged {entry.get('teamName')} {entry.get('year')} {entry['record']['w']}-{entry['record']['l']} score={entry['score']}")
    print(f"ENTRY_ID={entry.get('id')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
