#!/usr/bin/env python3
"""Fetch real 2026 FBS teams/schedules/AP seeds from ESPN into data/cfb-2026.json."""
import json, urllib.request, time, ssl, os
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "cfb-2026.json")
ctx = ssl.create_default_context()

def get(url, retries=3):
    url = url.replace("http://sports.core.api.espn.com", "https://sports.core.api.espn.com")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 cfb-sim/1.0"})
            with urllib.request.urlopen(req, context=ctx, timeout=45) as r:
                return json.load(r)
        except Exception as e:
            last = e
            time.sleep(0.5 * (attempt + 1))
    raise last

def main():
    conf_ids = ["151", "1", "4", "5", "12", "18", "15", "17", "9", "8", "37"]
    teams, conferences = {}, {}
    for cid in conf_ids:
        conf = get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/{cid}?lang=en&region=us")
        cname = conf.get("name") or conf.get("shortName")
        conferences[cid] = {"id": cid, "name": cname, "abbreviation": conf.get("abbreviation") or conf.get("shortName") or cname}
        team_items = []
        try:
            tpage = get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/{cid}/teams?limit=100&lang=en&region=us")
            team_items = tpage.get("items", [])
        except Exception:
            pass
        if not team_items:
            children = get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/{cid}/children?limit=50&lang=en&region=us")
            for ch in children.get("items", []):
                chid = ch["$ref"].split("/groups/")[1].split("?")[0]
                tpage = get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/types/2/groups/{chid}/teams?limit=100&lang=en&region=us")
                team_items.extend(tpage.get("items", []))
        print(f"  {cname}: {len(team_items)}")
        for tit in team_items:
            tid = tit["$ref"].split("/teams/")[1].split("?")[0]
            teams[tid] = {"id": tid, "conferenceId": cid, "conference": cname}

    def fetch_team(tid):
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{tid}")
        t = d["team"]
        logos = t.get("logos") or []
        return tid, {
            "id": tid,
            "name": t.get("displayName"),
            "shortName": t.get("shortDisplayName") or t.get("nickname"),
            "abbreviation": t.get("abbreviation"),
            "location": t.get("location"),
            "nickname": t.get("nickname") or t.get("name"),
            "color": "#" + (t.get("color") or "333333"),
            "altColor": "#" + (t.get("alternateColor") or "ffffff"),
            "logo": logos[0]["href"] if logos else None,
            "conferenceId": teams[tid]["conferenceId"],
            "conference": teams[tid]["conference"],
        }

    enriched = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for tid, info in ex.map(lambda x: fetch_team(x), teams):
            enriched[tid] = info

    rankings = get("https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings")
    rank_map = {r["team"]["id"]: r.get("current") for r in rankings["rankings"][0].get("ranks", [])}

    def ratings_for(tid, name):
        if tid in rank_map and rank_map[tid]:
            base = 94 - (rank_map[tid] - 1) * (22 / 24)
        else:
            base = 58 + (sum(ord(c) for c in tid) % 20) * 0.6
        h2 = (sum(ord(c) for c in (name or "")) % 11) - 5
        off = round(base + h2 * 0.4, 1)
        deff = round(base - h2 * 0.35, 1)
        return off, deff, rank_map.get(tid)

    for tid, t in enriched.items():
        off, deff, rk = ratings_for(tid, t["name"])
        t.update(offense=off, defense=deff, apRank=rk, overall=round((off + deff) / 2, 1), isFbs=True)

    def fetch_sched(tid):
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{tid}/schedule?season=2026")
        games = []
        for e in d.get("events", []):
            if e.get("seasonType", {}).get("type") != 2:
                continue
            comp = e["competitions"][0]
            home = away = None
            for c in comp["competitors"]:
                info = {"id": c["team"]["id"], "name": c["team"].get("displayName"), "abbreviation": c["team"].get("abbreviation")}
                if c["homeAway"] == "home":
                    home = info
                else:
                    away = info
            if not home or not away:
                continue
            opp, ha = (away, "home") if home["id"] == tid else (home, "away")
            games.append({
                "eventId": e["id"], "date": e["date"], "week": e.get("week", {}).get("number"),
                "homeAway": ha, "neutralSite": bool(comp.get("neutralSite")),
                "opponentId": opp["id"], "opponentName": opp["name"], "opponentAbbr": opp["abbreviation"],
                "homeId": home["id"], "awayId": away["id"], "name": e.get("name"), "shortName": e.get("shortName"),
            })
        return tid, games

    schedules = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for tid, games in ex.map(lambda x: fetch_sched(x), enriched):
            schedules[tid] = games

    all_games = {}
    for games in schedules.values():
        for g in games:
            all_games.setdefault(g["eventId"], {
                "eventId": g["eventId"], "date": g["date"], "week": g["week"],
                "homeId": g["homeId"], "awayId": g["awayId"], "neutralSite": g["neutralSite"],
                "name": g["name"], "shortName": g["shortName"],
                "homeIsFbs": g["homeId"] in enriched, "awayIsFbs": g["awayId"] in enriched,
            })

    opp_stubs = {}
    for g in all_games.values():
        for oid in (g["homeId"], g["awayId"]):
            if oid in enriched or oid in opp_stubs:
                continue
            name = abbr = None
            for games in schedules.values():
                for sg in games:
                    if sg["opponentId"] == oid:
                        name, abbr = sg["opponentName"], sg["opponentAbbr"]
                        break
                if name:
                    break
            h = sum(ord(c) for c in oid) % 15
            off, deff = round(48 + h * 0.5, 1), round(50 + (15 - h) * 0.3, 1)
            opp_stubs[oid] = {
                "id": oid, "name": name or f"Team {oid}", "shortName": name or f"Team {oid}",
                "abbreviation": abbr or "UNK", "location": "", "nickname": "",
                "color": "#666666", "altColor": "#cccccc",
                "logo": f"https://a.espncdn.com/i/teamlogos/ncaa/500/{oid}.png",
                "conferenceId": "fcs", "conference": "Non-FBS",
                "offense": off, "defense": deff, "overall": round((off + deff) / 2, 1),
                "apRank": None, "isFbs": False,
            }

    weeks = [{"week": i, "label": f"Week {i}", "detail": d} for i, d in enumerate([
        "Aug 22–Sep 7", "Sep 8–13", "Sep 14–20", "Sep 21–27", "Sep 28–Oct 4",
        "Oct 5–11", "Oct 12–18", "Oct 19–25", "Oct 26–Nov 1", "Nov 2–8",
        "Nov 9–15", "Nov 16–22", "Nov 23–29", "Nov 30–Dec 6", "Dec 7–12",
    ], 1)]

    data = {
        "season": 2026,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "ESPN site.api.espn.com and sports.core.api.espn.com",
        "ratingsMethod": "AP Top 25 seeded strength (see README).",
        "apPollWeek": rankings.get("latestWeek"),
        "weeks": weeks,
        "conferences": list(conferences.values()),
        "teams": {**enriched, **opp_stubs},
        "fbsTeamIds": sorted(enriched.keys(), key=lambda x: enriched[x]["name"]),
        "schedules": schedules,
        "games": list(all_games.values()),
        "notes": ["Regular-season only.", "Ignores real 2026 results; re-sims from Week 1."],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print("wrote", OUT, "FBS", len(enriched), "games", len(all_games))

if __name__ == "__main__":
    main()
