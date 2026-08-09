:sparkles: **MULTI-TENANT HARDENING, CLEANER STATS ENGAGEMENT, STABLE TABS — v1**

A fresh batch of changes, applied to every guild on the platform.

---

:new: **What's new**

- :bar_chart: **Stats > Engagement rebuilt.** The page now tells a clear story:
  - Active members this week, average 8-week participation, members inactive for 2+ weeks.
  - A weekly participation trend, counted per distinct member (Arms A+B and Shadowfront squads count once per week).
  - A breakdown of how many members engaged in each event type (SvS, GvG, Shadowfront, Arms Race, DTR).
  - An inactive-members list sorted by how long they have been away, with last-seen week and power.
- :floppy_disk: **Your Stats tab sticks around.** Refresh the page or switch guilds and you stay on the tab you were on (Guild Health, Engagement, Roster, Operations). The period/week dropdowns are hidden on those tabs so they can no longer kick you back to the global leaderboard.
- :shield: **Sandbox hardening for every tenant.** The guild selector loads from the database (no more stale hard-coded list), the silent `ALPHA` column defaults are gone (an insert without a guild now fails loudly), `accounts.guild` is required for non-super admins, join codes are globally unique, and the cross-guild ranking is locked to admins only.

---

:bug: **What's fixed**

- Stats no longer jumps to "Weekly Global" when you reload or change the period while on a KPI tab.
- Participation is now counted per the game rules everywhere: Arms Race (A+B) and Shadowfront (Squad 1+2) count once per week, each DTR counts separately.
- Shadowfront weeks are derived from the admin's chosen battle date, not the sync time, so nobody lands in the wrong week. Existing inconsistent rows were backfilled across all tenants.
- History sessions are always sorted most recent first, and the RPC that used to empty the History page was fixed.
- Approve / Approve All no longer get stuck on "..." after an error.
- Active events no longer list players from other guilds (the shared session ids are now always scoped to the active guild).

---

:heart: _FGF Guild Management Tool_
