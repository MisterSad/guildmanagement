:rocket: **STATS DEFAULT CURRENT WEEK & TIMEFRAME SELECTION — v22**

Stats now load by default on the **current week**, with a dropdown selector allowing admins and members to inspect 1 week, 2 weeks, 4 weeks, 8 weeks, or all-time history.

---

:new: **What's new**

- :calendar: **Default Current Week View (`1w`):** Opening the Stats module now defaults to displaying performance and scores for the current week (`1w`) rather than the entire historical dataset.
- :time_box: **Expanded Period Selectors:** Added a **2 Weeks** (`2w`) option to the period dropdown alongside 1 week (`1w`), 4 weeks (`4w`), 8 weeks (`8w`), and All time (`all`).
- :database: **Updated `gm_leaderboard` RPC:** Deployed SQL migration `20260810100000_update_gm_leaderboard_2w.sql` updating default server-side period calculations to `'1w'` and adding support for `'2w'`.

---

:bug: **What's fixed**

- :chart_with_upwards_trend: **Default Stats Period Alignment:** Aligned client-side `statsPeriod` initial state (`stats.js`) with user preference to default to the active week.
- :globe_with_meridians: **Period Dropdown Ordering:** Reordered timeframe options sequentially: `1 Week`, `2 Weeks`, `4 Weeks`, `8 Weeks`, `All Time (Total)`.

---

:heart: _FGF Guild Management Tool_
