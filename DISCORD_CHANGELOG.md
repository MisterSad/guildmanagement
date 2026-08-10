:chart_with_upwards_trend: **DRAFT REGULARITY SORTING & PAGINATION CAP FIX — v27**

Enhanced the **Draft** Mercato page with regularity tie-breaker sorting, un-capped player pagination, and session denominator unioning in SQL.

---

:new: **What's new**

- :sort: **Regularity Tie-Breaker Sorting:** Ranking by rate (%) now uses **Attended Count** and **Total Count** as secondary tie-breakers. Active players with a long track record (e.g. 22/23 events) are now ranked above players with few total sessions (e.g. 5/5).
- :infinity: **Un-Capped Player List:** Added `.range(0, 99999)` to bypass PostgREST's default 1000-row cap, fetching every single player across all guilds.
- :1234: **Dynamic Player Count Display:** Top-right counter now displays `1420 players` when unfiltered, and `45 of 1420 players` when filtering.
- :database: **Accurate Guild Event Denominators:** Migration `20260810130000_draft_ranking_session_union_and_regularity.sql` unions `event_status` and `event_participants` so any event created by a guild is properly counted in member total denominators.

---

:heart: _FGF Guild Management Tool_
