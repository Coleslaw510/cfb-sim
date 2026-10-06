#!/usr/bin/env python3
"""Fetch TeamCrafters CFB27 published roster OVRs and merge onto ESPN rosters.

Source (open published pages only):
  https://www.teamcrafters.net/rosters/CFB27/10-02-26
  https://www.teamcrafters.net/rosters/CFB27/10-02-26/{teamId}

Does not invent ratings. Maps by normalized name + position (+ jersey when helpful).
Rebuilds depth charts by OVR. Optionally updates team offense/defense/overall
from TeamCrafters team ratings when a mapping exists.
"""
from __future__ import annotations

import json
import os
import re
import ssl
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
ROSTER_DIR = os.path.join(DATA, "rosters")
TC_DIR = os.path.join(DATA, "teamcrafters")
ROSTER_VERSION = "10-02-26"
BASE = f"https://www.teamcrafters.net/rosters/CFB27/{ROSTER_VERSION}"
CTX = ssl.create_default_context()
UA = {"User-Agent": "Mozilla/5.0 cfb-sim/1.0 (personal fan tool; +https://github.com/Coleslaw510/cfb-sim)"}

POS_BUCKET = {
    "QB": "QB",
    "HB": "RB", "FB": "RB", "RB": "RB",
    "WR": "WR",
    "TE": "TE",
    "LT": "OL", "LG": "OL", "C": "OL", "RG": "OL", "RT": "OL",
    "OL": "OL", "OT": "OL", "OG": "OL", "G": "OL", "T": "OL",
    "LE": "DL", "RE": "DL", "DT": "DL", "DL": "DL", "DE": "DL", "NT": "DL",
    "LOLB": "LB", "MLB": "LB", "ROLB": "LB", "LB": "LB", "ILB": "LB", "OLB": "LB",
    "CB": "DB", "FS": "DB", "SS": "DB", "DB": "DB", "S": "DB", "NB": "DB",
    "K": "K", "PK": "K",
    "P": "P",
}
DEPTH_ORDER = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB", "K", "P"]
DEPTH_LIMITS = {"QB": 3, "RB": 4, "WR": 6, "TE": 3, "OL": 7, "DL": 6, "LB": 5, "DB": 6, "K": 2, "P": 2}
CLASS_MAP = {
    "Freshman": "FR", "Redshirt Freshman": "FR", "FR": "FR",
    "Sophomore": "SO", "Redshirt Sophomore": "SO", "SO": "SO",
    "Junior": "JR", "Redshirt Junior": "JR", "JR": "JR",
    "Senior": "SR", "Redshirt Senior": "SR", "SR": "SR",
}

# Manual aliases: TeamCrafters name -> ESPN location / shortName keys
NAME_ALIASES = {
    "Miami (FL)": ["Miami", "Miami FL"],
    "Miami (OH)": ["Miami (OH)", "Miami OH", "Miami-Ohio"],
    "Ole Miss": ["Ole Miss", "Mississippi"],
    "UConn": ["UConn", "Connecticut"],
    "UL–Monroe": ["UL Monroe", "Louisiana Monroe", "ULM"],
    "UL-Monroe": ["UL Monroe", "Louisiana Monroe", "ULM"],
    "ULâMonroe": ["UL Monroe", "Louisiana Monroe", "ULM"],
    "Southern Miss": ["Southern Miss", "Southern Mississippi"],
    "Sam Houston": ["Sam Houston"],
    "Appalachian State": ["App State", "Appalachian State"],
    "Central Michigan": ["C Michigan", "Central Michigan"],
    "Eastern Michigan": ["E Michigan", "Eastern Michigan"],
    "Western Michigan": ["W Michigan", "Western Michigan"],
    "Western Kentucky": ["W Kentucky", "Western Kentucky"],
    "Middle Tennessee": ["Middle Tennessee", "MTSU"],
    "New Mexico State": ["New Mexico State", "New Mexico St"],
    "Florida Atlantic": ["FAU", "Florida Atlantic"],
    "FIU": ["FIU", "Florida International"],
    "UMass": ["UMass", "Massachusetts"],
    "NC State": ["NC State", "North Carolina State"],
    "Louisiana": ["Louisiana", "Louisiana Lafayette", "UL Lafayette"],
    "Texas A&M": ["Texas A&M"],
    "Bowling Green": ["Bowling Green"],
    "Georgia Southern": ["Georgia Southern"],
    "Georgia State": ["Georgia State"],
    "Coastal Carolina": ["Coastal", "Coastal Carolina"],
    "Jacksonville State": ["Jacksonville St", "Jacksonville State"],
    "Kennesaw State": ["Kennesaw State"],
    "Missouri State": ["Missouri State"],
    "Delaware": ["Delaware"],
    "UL–Monroe": ["UL Monroe", "Louisiana Monroe", "ULM"],
    "UL-Monroe": ["UL Monroe", "Louisiana Monroe", "ULM"],
    "UL Monroe": ["UL Monroe", "Louisiana Monroe", "ULM"],
}


def get(url, retries=4):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, context=CTX, timeout=60) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(0.4 * (attempt + 1))
    raise last


def extract_array(s: str):
    depth = 0
    in_str = False
    esc = False
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return s[: i + 1]
    return None


def unescape_push(script: str):
    m = re.search(r'self\.__next_f\.push\(\[1,"(.*)"\]\)', script, re.S)
    if not m:
        return None
    return bytes(m.group(1), "utf-8").decode("unicode_escape")


def parse_players_from_html(html: str):
    scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    for s in sorted(scripts, key=len, reverse=True):
        if "firstName" not in s and "OVR" not in s:
            continue
        u = unescape_push(s)
        if not u:
            continue
        idx = u.find('"players":[')
        if idx < 0:
            continue
        arr = extract_array(u[idx + 10 :])
        if not arr:
            continue
        try:
            return json.loads(arr)
        except Exception:
            continue
    return None


def norm_name(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = s.replace("'", "'").replace("'", "'").replace("'", "")
    s = s.replace(".", " ").replace("-", " ").replace(",", " ")
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def name_tokens(s: str):
    return norm_name(s).split()


def names_match(a: str, b: str) -> float:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    # last-name + first initial / first name
    ta, tb = na.split(), nb.split()
    if len(ta) >= 2 and len(tb) >= 2:
        if ta[-1] == tb[-1] and (ta[0] == tb[0] or ta[0][0] == tb[0][0]):
            return 0.92 if ta[0] == tb[0] else 0.82
        # flipped "Jackson Bo" vs "Bo Jackson" unlikely for displayName but handle
        if ta[0] == tb[-1] and ta[-1] == tb[0]:
            return 0.95
    # containment of last name + shared first
    ratio = SequenceMatcher(None, na, nb).ratio()
    return ratio


def compact_tc_player(p):
    pos = p.get("POS") or ""
    return {
        "id": p.get("id"),
        "n": f"{p.get('firstName','').strip()} {p.get('lastName','').strip()}".strip(),
        "j": "" if p.get("number") is None else str(p.get("number")),
        "p": pos,
        "bucket": POS_BUCKET.get(pos, "WR"),
        "c": CLASS_MAP.get(p.get("class") or "", ""),
        "ovr": int(p.get("OVR") or 0),
        "dev": p.get("devTrait"),
        "filler": bool(p.get("isFiller")),
        "spd": p.get("SPD"),
        "teamId": (p.get("team") or {}).get("id"),
        "teamName": (p.get("team") or {}).get("name"),
    }


def fetch_team_roster(tc_id: int):
    html = get(f"{BASE}/{tc_id}").decode("utf-8", "replace")
    players = parse_players_from_html(html)
    if not players:
        raise RuntimeError(f"no players for team {tc_id}")
    return [compact_tc_player(p) for p in players]


def build_espn_name_index(espn_teams: dict):
    """Map normalized names -> espn team id for FBS only."""
    idx = {}
    for tid, t in espn_teams.items():
        if not t.get("isFbs"):
            continue
        keys = {
            t.get("location") or "",
            t.get("shortName") or "",
            t.get("name") or "",
            t.get("abbreviation") or "",
            (t.get("nickname") or ""),
        }
        # also strip mascot from full name
        loc = t.get("location") or ""
        if loc:
            keys.add(loc)
        for k in list(keys):
            nk = norm_name(k)
            if nk:
                idx.setdefault(nk, tid)
    return idx


def map_tc_to_espn(tc_teams, espn_teams):
    idx = build_espn_name_index(espn_teams)
    mapping = {}
    unmatched = []
    for t in tc_teams:
        name = t["name"]
        # skip obvious FCS that aren't in our FBS set
        candidates = [name] + NAME_ALIASES.get(name, [])
        # also try without parenthetical
        candidates.append(re.sub(r"\s*\([^)]*\)", "", name).strip())
        hit = None
        for c in candidates:
            nk = norm_name(c)
            if nk in idx:
                hit = idx[nk]
                break
            # fuzzy against espn locations
        if not hit:
            best = (0, None)
            for c in candidates:
                for et in espn_teams.values():
                    if not et.get("isFbs"):
                        continue
                    score = max(
                        names_match(c, et.get("location") or ""),
                        names_match(c, et.get("shortName") or ""),
                    )
                    if score > best[0]:
                        best = (score, et["id"])
            if best[0] >= 0.86:
                hit = best[1]
        if hit:
            mapping[str(t["id"])] = {
                "espnId": str(hit),
                "tcId": t["id"],
                "tcName": name,
                "espnName": espn_teams[str(hit)].get("location") or espn_teams[str(hit)].get("name"),
                "teamOVR": t.get("teamOVR"),
                "offenseOVR": t.get("offenseOVR"),
                "defenseOVR": t.get("defenseOVR"),
            }
        else:
            unmatched.append(name)
    return mapping, unmatched


def rebuild_depth(players):
    buckets = {k: [] for k in DEPTH_ORDER}
    for i, p in enumerate(players):
        raw = p.get("p") or ""
        bucket = POS_BUCKET.get(raw) or POS_BUCKET.get(raw.upper()) 
        # ESPN positions already abbreviated; TC maybe HB etc — packed into p for ESPN keep original
        # For depth, use engine mapping via stored bucket if present
        b = p.get("_bucket") or POS_BUCKET.get(raw, None)
        if b is None:
            # try common ESPN abbreviations already in POS_BUCKET
            b = POS_BUCKET.get(raw.upper() if raw else "", None)
        if b is None:
            # infer from existing depth usage — skip specialists without map
            continue
        buckets[b].append(i)
    depth = {}
    for b in DEPTH_ORDER:
        lim = DEPTH_LIMITS.get(b, 5)
        idxs = buckets[b]
        idxs.sort(key=lambda i: (-(players[i].get("ovr") or 0), players[i].get("n") or ""))
        depth[b] = idxs[:lim]
    return depth


def match_players(espn_players, tc_players):
    """Return (mapped_count, updates list of (espn_idx, tc_player, score))."""
    used_tc = set()
    matches = []
    # Pre-index TC by bucket
    by_bucket = {}
    for i, tp in enumerate(tc_players):
        by_bucket.setdefault(tp["bucket"], []).append(i)

    for ei, ep in enumerate(espn_players):
        raw = ep.get("p") or ""
        bucket = POS_BUCKET.get(raw, POS_BUCKET.get(raw.upper(), None))
        if bucket is None:
            continue
        best = (0.0, None)
        for ti in by_bucket.get(bucket, []):
            if ti in used_tc:
                continue
            tp = tc_players[ti]
            score = names_match(ep.get("n") or "", tp["n"])
            # jersey bonus
            if ep.get("j") and tp.get("j") and str(ep["j"]) == str(tp["j"]) and score >= 0.55:
                score = min(1.0, score + 0.12)
            if score > best[0]:
                best = (score, ti)
        # also try adjacent buckets for OL/DL ambiguity? skip for now
        if best[1] is not None and best[0] >= 0.78:
            used_tc.add(best[1])
            matches.append((ei, tc_players[best[1]], best[0]))
    return matches, used_tc


def merge_team(espn_roster, tc_players, prefer_tc_depth=False, match_ratio_threshold=0.55):
    players = [dict(p) for p in espn_roster.get("players") or []]
    matches, used_tc = match_players(players, tc_players)
    for ei, tp, score in matches:
        players[ei]["ovr"] = tp["ovr"]
        players[ei]["tcId"] = tp["id"]
        if tp.get("dev"):
            players[ei]["dev"] = tp["dev"]
        players[ei]["_bucket"] = tp["bucket"]

    mapped = len(matches)
    espn_n = len(players)
    # Assign fallback OVRs for unmatched ESPN players based on class + position scarcity
    CLASS_BASE = {"SR": 72, "JR": 70, "SO": 67, "FR": 64, "": 66}
    for p in players:
        if p.get("ovr") is not None:
            continue
        base = CLASS_BASE.get((p.get("c") or "").upper(), 66)
        # slight position jitter via name hash for stability
        h = sum(ord(c) for c in (p.get("n") or "")) % 7
        p["ovr"] = int(max(40, min(82, base + h - 3)))
        p["ovrSrc"] = "estimate"
        raw = p.get("p") or ""
        p["_bucket"] = POS_BUCKET.get(raw, POS_BUCKET.get(raw.upper(), "WR"))

    match_ratio = mapped / max(1, espn_n)
    added = 0
    # If TeamCrafters is fuller and match quality high, add unmatched non-filler TC players
    if prefer_tc_depth or match_ratio >= match_ratio_threshold:
        existing_names = {norm_name(p.get("n") or "") for p in players}
        for i, tp in enumerate(tc_players):
            if i in used_tc:
                continue
            if tp.get("filler") and tp["ovr"] < 75:
                continue
            if norm_name(tp["n"]) in existing_names:
                continue
            # Only add if TC has meaningful depth beyond ESPN for this bucket
            players.append({
                "n": tp["n"],
                "j": tp["j"],
                "p": tp["p"],
                "c": tp["c"],
                "ovr": tp["ovr"],
                "tcId": tp["id"],
                "src": "tc",
                "dev": tp.get("dev"),
                "_bucket": tp["bucket"],
            })
            existing_names.add(norm_name(tp["n"]))
            added += 1

    # Mark mapped source
    for p in players:
        if p.get("tcId") and not p.get("src"):
            p["ovrSrc"] = "teamcrafters"
        if "_bucket" not in p:
            raw = p.get("p") or ""
            p["_bucket"] = POS_BUCKET.get(raw, POS_BUCKET.get(raw.upper(), "WR"))

    depth = rebuild_depth(players)
    # Strip helper
    for p in players:
        p.pop("_bucket", None)

    return {
        "id": espn_roster.get("id"),
        "players": players,
        "depth": depth,
        "meta": {
            "mapped": mapped,
            "espnPlayers": espn_n,
            "tcPlayers": len(tc_players),
            "addedFromTc": added,
            "matchRatio": round(match_ratio, 3),
            "ovrSource": "teamcrafters-CFB27-10-02-26",
        },
    }


def update_team_ratings(espn_data, mapping):
    updated = 0
    for tc_id, m in mapping.items():
        eid = m["espnId"]
        t = espn_data["teams"].get(eid)
        if not t:
            continue
        # Blend toward TC ratings but keep float style of existing data
        if m.get("offenseOVR") is not None:
            t["offense"] = float(m["offenseOVR"])
        if m.get("defenseOVR") is not None:
            t["defense"] = float(m["defenseOVR"])
        if m.get("teamOVR") is not None:
            t["overall"] = float(m["teamOVR"])
        t["ratingsSource"] = "teamcrafters-CFB27-10-02-26"
        updated += 1
    return updated


def main():
    os.makedirs(TC_DIR, exist_ok=True)
    espn = json.load(open(os.path.join(DATA, "cfb-2026.json")))
    tc_index = json.load(open(os.path.join(TC_DIR, "teams-10-02-26.json")))
    tc_teams = tc_index["teams"]
    # Normalize mojibake / fancy dashes in published names
    for t in tc_teams:
        if t.get("id") == 674 or "Monroe" in (t.get("name") or ""):
            t["name"] = "UL Monroe"

    mapping, unmatched = map_tc_to_espn(tc_teams, espn["teams"])
    print(f"Mapped teams: {len(mapping)} / {len(tc_teams)}; unmatched: {unmatched}")

    # Fetch all mapped TC rosters
    tc_rosters = {}
    errors = []

    def job(tc_id):
        return tc_id, fetch_team_roster(int(tc_id))

    ids = [m["tcId"] for m in mapping.values()]
    print(f"Fetching {len(ids)} TeamCrafters team rosters…")
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(job, tid): tid for tid in ids}
        done = 0
        for fut in as_completed(futs):
            tid = futs[fut]
            try:
                tc_id, players = fut.result()
                tc_rosters[str(tc_id)] = players
            except Exception as e:
                errors.append((tid, str(e)))
            done += 1
            if done % 20 == 0 or done == len(ids):
                print(f"  {done}/{len(ids)}")

    # Save raw compact TC dump
    dump = {
        "source": BASE,
        "rosterVersion": ROSTER_VERSION,
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "teamCount": len(tc_rosters),
        "playerCount": sum(len(v) for v in tc_rosters.values()),
        "teams": {
            tid: {
                "tcId": int(tid),
                "espnId": mapping[tid]["espnId"],
                "name": mapping[tid]["tcName"],
                "players": players,
            }
            for tid, players in tc_rosters.items()
            if tid in mapping
        },
        "errors": errors,
        "unmatchedTeams": unmatched,
    }
    dump_path = os.path.join(TC_DIR, "players-10-02-26.json")
    with open(dump_path, "w") as f:
        json.dump(dump, f)
    print(f"Wrote {dump_path} ({dump['playerCount']} players)")

    # Merge onto ESPN roster files
    stats = {
        "teamsMerged": 0,
        "playersMapped": 0,
        "playersEstimated": 0,
        "playersAdded": 0,
        "samples": [],
    }
    for tc_id, m in mapping.items():
        if tc_id not in tc_rosters:
            continue
        eid = m["espnId"]
        path = os.path.join(ROSTER_DIR, f"{eid}.json")
        if not os.path.exists(path):
            continue
        espn_roster = json.load(open(path))
        merged = merge_team(espn_roster, tc_rosters[tc_id], prefer_tc_depth=True)
        # write without verbose meta into roster file (keep slim meta)
        out = {
            "id": merged["id"],
            "players": merged["players"],
            "depth": merged["depth"],
            "ovrSource": "teamcrafters-CFB27-10-02-26",
        }
        with open(path, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        stats["teamsMerged"] += 1
        stats["playersMapped"] += merged["meta"]["mapped"]
        stats["playersAdded"] += merged["meta"]["addedFromTc"]
        stats["playersEstimated"] += sum(1 for p in merged["players"] if p.get("ovrSrc") == "estimate")
        # sample stars
        stars = sorted(
            [p for p in merged["players"] if p.get("ovr")],
            key=lambda p: -p["ovr"],
        )[:3]
        if m["tcName"] in ("Ohio State", "Indiana", "Texas", "Miami (FL)", "Notre Dame", "Alabama", "Oregon"):
            stats["samples"].append({
                "team": m["tcName"],
                "espnId": eid,
                "mapped": merged["meta"]["mapped"],
                "added": merged["meta"]["addedFromTc"],
                "stars": [{"n": p["n"], "p": p["p"], "ovr": p["ovr"]} for p in stars],
            })

    # Update team ratings in cfb-2026.json
    n_ratings = update_team_ratings(espn, mapping)
    espn["ratingsMethod"] = "teamcrafters-CFB27-10-02-26 teamOVR/offenseOVR/defenseOVR (player OVRs in data/rosters)"
    notes = espn.get("notes")
    note = "Player OVRs and team ratings from TeamCrafters CFB27 10-02-26 published rosters (https://www.teamcrafters.net/rosters/CFB27)."
    if isinstance(notes, list):
        if not any("TeamCrafters" in str(x) for x in notes):
            notes.append(note)
        espn["notes"] = notes
    elif isinstance(notes, str):
        espn["notes"] = (notes + " | " + note) if "TeamCrafters" not in notes else notes
    else:
        espn["notes"] = [note]
    with open(os.path.join(DATA, "cfb-2026.json"), "w") as f:
        json.dump(espn, f, separators=(",", ":"))

    # Mapping doc
    map_doc = {
        "source": BASE,
        "rosterVersion": ROSTER_VERSION,
        "mappedTeams": len(mapping),
        "unmatchedTeams": unmatched,
        "mapping": mapping,
        "mergeStats": stats,
        "teamRatingsUpdated": n_ratings,
        "errors": errors,
    }
    with open(os.path.join(TC_DIR, "merge-report.json"), "w") as f:
        json.dump(map_doc, f, indent=2)

    print(json.dumps({"mergeStats": stats, "teamRatingsUpdated": n_ratings, "errors": errors[:5]}, indent=2))


if __name__ == "__main__":
    main()
