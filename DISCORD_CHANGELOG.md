:target: **TENANT-ISOLATED EVENT INDEX & ARMS RACE FIX — v54**

Resolved the index collision issue that prevented transferred players (like **Dust**) from appearing in active Arms Race Stage B sessions.

---

:wrench: **Fixed**

- :target: **Arms Race Stage B & Transferred Players Fix:** Replaced legacy global database indexes on `event_participants` with tenant-scoped unique indexes `(guild, event_name, session_id, pseudo)`.
- :shield: **Tenant Isolation:** Transferred players (including **Dust** in ALPHA) now cleanly enroll into all active sessions (Arms Race Stage A/B, SvS, GvG, DTR) without colliding with session IDs from their previous guild.

---

:heart: _FGF Guild Management Tool_
