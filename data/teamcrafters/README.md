# TeamCrafters CFB27 roster data

Published source (open roster pages): https://www.teamcrafters.net/rosters/CFB27

Version used: **10-02-26** (`/rosters/CFB27/10-02-26` and per-team `/rosters/CFB27/10-02-26/{teamId}`).

## Files

| File | Purpose |
|------|---------|
| `teams-10-02-26.json` | 138 team ratings (team/offense/defense OVR) |
| `players-10-02-26.json` | Compact player dump (name, pos, jersey, OVR, class) for mapped FBS teams |
| `merge-report.json` | ESPN↔TeamCrafters team mapping + merge stats |

## Integration

`scripts/integrate_teamcrafters_ovr.py` fetches the published HTML, extracts embedded roster JSON, maps players onto `data/rosters/{espnId}.json` by name+position (+jersey bonus), rebuilds depth charts by OVR, and copies team OVRs into `data/cfb-2026.json`.

Sacramento State (FCS-only on TeamCrafters) is intentionally unmatched.
