:wrench: **GUILD TRANSFER FIX & AUTO-ENROLL — v52**

Resolved the authorization error encountered during player transfers between guilds on the same server.

---

:wrench: **Fixed**

- :arrows_left_right: **Guild Transfer Authorization Fix:** Fixed a `not_authorized` check in `gm_add_member_to_active_events` that broke transfers when a guild admin moved a player to another guild. Transmitting players between guilds on the same server now completes smoothly.
- :arrows_counterclockwise: **Active Event Roster Auto-Sync:** Transferred players are cleanly removed from active events in their old guild and enrolled into active events in their new guild.

---

:heart: _FGF Guild Management Tool_
