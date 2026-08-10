:checkered_flag: **ACTIVE EVENT BACKFILL FOR TRANSFERRED PLAYERS — v53**

Backfilled active event participant records for all existing transferred players (including player **Dust** moved from OMEGA to ALPHA).

---

:wrench: **Fixed**

- :sparkles: **Transferred Players Roster Repair:** Ran a database migration (`20260811002000`) that immediately populates transferred players (like **Dust**) into ongoing active events of their new guild (ALPHA), while cleaning up stale unparticipated rows in their old guild (OMEGA).
- :arrows_counterclockwise: **Real-Time Active Event Roster Sync:** Any future transfers, additions, or approvals automatically sync active event participant lists on the fly.

---

:heart: _FGF Guild Management Tool_
