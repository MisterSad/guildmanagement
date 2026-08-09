:calendar: **EVENT RELIABILITY & SESSION ID HARDENING — v16**

Critical fixes to the event session system: SQL crash eliminated, same-day session collision prevention, mandatory date picker for all events, and automatic session ID recalculation on schedule edits.

---

:new: **What's new**

- :id: **Anti-Collision Session IDs:** DTR, Arms Race, and Shadowfront sessions on the same day now generate unique IDs (`DTR-20260812-1`, `DTR-20260812-2`, ...) instead of overwriting each other.
- :calendar: **Mandatory Date Picker for SvS and GvG:** Starting a SvS or GvG event now requires an explicit battle date, ensuring the ISO-week session ID always matches the real battle week.
- :arrows_counterclockwise: **Session ID Cascade on Schedule Edit:** Editing the battle date of any active event now updates the session ID in all related tables automatically.
- :zap: **New DB Index `idx_event_status_guild_session`:** Faster JOIN resolution on event history queries across all tenants.

---

:bug: **What's fixed**

- :boom: **CRITICAL SQL Crash in Event History (`gm_list_event_sessions`):** The ORDER BY clause was casting `session_id::timestamptz`, crashing PostgreSQL on IDs like `SF1-20260812`, `ARA-20260809`. Fixed with safe YYYYMMDD regex extraction.
- :collision: **Same-Day Event Collision (DTR, Arms Race, Shadowfront):** Starting a 2nd session of these events on the same UTC day silently overwrote the first. Now generates a new unique session each time.
- :repeat: **Stale Session ID After Date Edit:** Editing an event's date updated `start_at` but left the `session_id` pointing to the original date, causing stat incoherence. Fixed with full cascade.
- :bar_chart: **Arms Race Historical Stats Backfill:** Rows from before 09/08/2026 had `week_start` inconsistent with the date in their `session_id`. Backfill migration corrects all affected rows.

---

:heart: _FGF Guild Management Tool_
