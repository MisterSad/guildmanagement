:shield: **PLAYER APPROVAL & EVENT SYNC AUTH FIX — v58**

Resolved the issue preventing guild admins from approving new player registrations and auto-enrolling members into active events.

---

:wrench: **Fixed**

- :key: **Registration Approvals:** Fixed `unauthorized` errors when approving pending player registrations by removing conflicting client-context checks in backend service-role procedures.
- :sparkles: **Active Event Auto-Enroll:** Updated `gm_add_member_to_active_events` and `gm_populate_event_participants` to support resilient admin identity lookups and service-role execution.

---

:heart: _FGF Guild Management Tool_
