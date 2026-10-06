# CFB 2026 Season Sim (MVP)

Minimalist, mobile-friendly **college football season simulator**. Pick an FBS school, load its **real 2026 ESPN schedule**, sim every FBS game week by week, and browse box scores, conference standings, and a simple Top 25.

Pure static **HTML / CSS / JS** + one JSON data file — suitable for GitHub Pages.

## How to run

```bash
cd /workspace/cfb-sim
python3 -m http.server 8765
```

Open [http://localhost:8765](http://localhost:8765).

Progress is stored in `localStorage` (`cfb-sim-2026-v1`). Use **Reset season** to clear results for the current school.

## Features (this cut)

1. FBS team picker (search + conference filter)
2. Real 2026 regular-season schedule (weeks, opponents, home/away/neutral)
3. **Sim next week** — simulates **all** FBS regular-season games that week
4. Box score for your game (score, yards, turnovers, TOP, generic skill leaders)
5. Conference standings + sim Top 25
6. Persist / reset

## Data sources

| What | Source |
|------|--------|
| FBS conferences & membership | `sports.core.api.espn.com` … `/seasons/2026/types/2/groups/80/children` |
| Team metadata & logos | `site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{id}` |
| 2026 schedules | `…/teams/{id}/schedule?season=2026` (regular season only, `seasontype=2`) |
| Strength seed | AP Top 25 from `…/college-football/rankings` at data-build time |

**Do not invent teams or games** — schedules are scraped from ESPN. Non-FBS opponents that appear on FBS schedules are stubbed with lower ratings.

Rebuild data:

```bash
python3 scripts/build_data.py
```

## Ratings method

At data build time we read the current **AP Top 25**:

- Ranked teams: overall ≈ **94 → 72** by AP rank (linear).
- Unranked FBS: stable hash in **58–70**.
- Non-FBS opponents: ≈ **48–58**.
- Small offense/defense splits from a name hash.

This is **not** SP+; it is an AP-seeded MVP strength index so favorites behave realistically.

## Simulation method

Each game is a **drive-based probabilistic model**:

1. Expected points from offense vs opponent defense (+ home-field ≈ 2.4 pts unless neutral).
2. ~10–13 drives per team → TD / FG / turnover / punt outcomes.
3. OT if tied.
4. Box stats (pass/rush yards, C/A, turnovers, 3rd downs, TOP) derived from score + rating differential with seeded noise.
5. Skill leaders are **generic** placeholder names (rosters not required for MVP).

RNG is seeded per `eventId + week + seasonSeed` so a season is reproducible until reset.

## Top 25 formula

For each FBS team after the latest simmed week:

```
score = winPct×40 + SOS×25 + marginScore×15 + remainingOppStr×10 + apSeed×10
```

- **SOS** = mean opponent overall of games already played (scaled 0–1).
- **marginScore** maps average point differential (−20…+20) into 0–1.
- **apSeed** keeps a soft memory of the preseason AP (rank 1 → 1.0, unranked → 0.2).

Top 25 by `score`, then wins, then margin.

## Schedule coverage (data pull)

- Season year: **2026**
- FBS teams: **138** across 11 conferences
- Unique regular-season games: **~892**
- Weeks: ESPN calendar Weeks **1–15** (Week 14 may be empty depending on ESPN’s week numbering; championship / late games may land in Week 15)
- AP seed poll week: whatever ESPN reported as `latestWeek` when `scripts/build_data.py` ran (Week 6 in the initial build)

The simulator **ignores real 2026 scores** and always re-sims from Week 1.

## Limitations

- No play-by-play, injuries, weather, or coaching.
- Generic player names in box scores (not real rosters).
- No conference championship / bowl / CFP bracket yet.
- Top 25 is a homemade poll, not AP voters.
- Logo hotlinking depends on ESPN CDN availability.
- If ESPN has not published a team’s full slate, gaps are whatever the API returned (noted in app data `notes`).

## License / attribution

Schedules, team names, and logos © their respective owners / ESPN. This project is an unofficial fan tool for personal/educational use.
