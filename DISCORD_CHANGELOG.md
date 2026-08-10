:rocket: **MAJOR UPDATE & FIXES — v51**

Summary of all updates, security fixes, and new features deployed over the last 2 hours:

---

:new: **What's new**

- :information_source: **Contextual Help System ("i" Buttons):** Added interactive **ⓘ** info buttons across all 17 cards/sections of the Admin Dashboard and Player Portal. Clicking any icon opens a quick guide explaining how to use that specific feature.
- :arrows_counterclockwise: **Automated Active Event Roster Sync:** Active event sessions (SvS, GvG, DTR, Arms Race) now automatically update their rosters in real time whenever members are added, approved, deleted, or transferred between guilds.
- :arrows_left_right: **Seamless Guild Transfers:** Transferring a player automatically cleans up unparticipated active event rows in the old guild and enrolls them into active events in the new target guild.
- :shield: **SEN Guild & Member Provisioning:** Registered the new **SEN (#1094)** guild tenant along with admin Buck and all associated guild members.

---

:wrench: **Fixed**

- :crown: **Member Edit Modal Layout:** Fixed the `ph-crown` icon overlapping the role dropdown options (R1-R5) when editing a member profile.
- :key: **GoTrue Shadow Account Self-Healing:** Resolved password reset credential mismatches by decoupling human passwords from GoTrue machine secrets, adding automatic self-healing in `auth-login`.
- :lock: **RLS Permission Fallback:** Updated database RLS write check helpers (`check_user_guild_write_access`) to fall back to matching by JWT `sub` claim when `auth_user_id` is unlinked, preventing `permission denied` errors on `guild_members`.

---

:heart: _FGF Guild Management Tool_
