:swords: **SUPER ADMIN SVS SERVER MATCHUP & DANGEROSITY DASHBOARD — v31**

Added a dedicated **SvS Matchup** tab in the Super Admin menu to compare Server vs Server guild rosters and dangerosity scores.

---

:new: **What's new**

- :crossed_swords: **Server vs Server Matchup:** Compare all guilds of **Server A** vs all guilds of **Server B** side by side.
- :calendar: **Day 1 to 5 vs Day 6 Scoring:** Tracks player scores during **Day 1-5 (Prep Phase)** and **Day 6 (PvP / Invasion Day)**.
- :warning: **Dangerosity Score & Badges:** Calculates a weighted Dangerosity Score ($\text{Power} + 2 \times \text{Prep} + 5 \times \text{PvP}$) and assigns Threat Badges (`EXTREME 🔴`, `HIGH 🟠`, `MEDIUM 🟡`, `LOW 🟢`).
- :columns: **Dual View Modes:** Switch between **Side by Side** server roster comparison and **Combined Leaderboard**.
- :database: **New RPC `gm_svs_server_matchup`:** Migration `20260810170000_svs_server_matchup_rpc.sql` deployed to calculate dangerosity scores in PostgreSQL.

---

:heart: _FGF Guild Management Tool_
