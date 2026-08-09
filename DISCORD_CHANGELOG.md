:sparkles: **SCOUTING REMOVED — v7**

The Scouting tool is gone: tab, client module, database objects and data, for every tenant.

---

:new: **What's new**

- Nothing new this round; this is a removal.

---

:bug: **What's fixed**

- :wastebasket: **Scouting removed.** The Scouting tab, its client module (`scouting.js`) and all backend objects (`scouting_snapshots` table, capture/report/history functions, grants) are deleted for every tenant via the drop migration `20260809140000_drop_scouting.sql`. The rival-roster data is dropped too, and no lingering references remain in the app.

---

:heart: _FGF Guild Management Tool_
