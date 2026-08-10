:chart_with_downwards_trend: **SVS DANGEROSITY POWER PENALTIES & SCORE AVERAGES — v32**

Applied combat power penalty multipliers to Dangerosity Scoring and updated table columns to display average scores.

---

:new: **What's new**

- :weight_lifting: **Power Penalties on Dangerosity Score:**
  - **< 60M Power:** Big Penalty (`0.30x` multiplier)
  - **61M - 90M Power:** Moderate Penalty (`0.65x` multiplier)
  - **> 91M Power:** Normal Dangerosity (`1.00x` multiplier, no penalty)
- :bar_chart: **Average Scores Displayed:**
  - **Day 1 to 5 (Avg):** Displays average preparation phase score.
  - **Day 6 (Avg):** Displays average PvP invasion score.
- :database: **Updated RPC `gm_svs_server_matchup`:** Migration `20260810180000_svs_matchup_power_penalty.sql` deployed to calculate penalized dangerosity scores in PostgreSQL.

---

:heart: _FGF Guild Management Tool_
