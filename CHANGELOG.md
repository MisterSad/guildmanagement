# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **OBSIDIANSTAR Guild Roster Correction (`20260812043000`)**: Created migration `20260812043000_fix_obsidianstar_typo_and_move_members.sql` transferring all 126 imported members to the correct tenant `OBSIDIANSTAR` (server #1078) and deleting the erroneous `OBSIDANSTAR` tenant.
- **Super Admin Tenant Deletion (`20260812042000`)**: Created `public.gm_delete_guild(p_guild_id)` SECURITY DEFINER RPC allowing super admins to permanently delete a tenant and all its associated data. Added Delete button with confirmation modal to the Super Admin dashboard in `app.js`.

---

## Fixed

- **Login Casing & Session Refresh Robustness (`app.js`, `gm-utils.js`)**: Fixed login issues where entering an identifier with different letter casing (e.g. lowercase) led to failed guild restriction lookup and lost permissions. Enforced canonical user ID usage returned by `auth-login`, updated DB account lookups to use case-insensitive `.ilike()`, and enabled automatic token refresh (`forceRefreshPortalSession`) for all account sessions upon page load.
- **Player Portal Glory Save (`20260812033000`)**: Fixed an issue where `member` accounts received `Failed to save: permission_denied` when updating their weekly Glory score in the Player Portal. `check_user_guild_write_access` now authorizes `service_role` Edge Function execution while maintaining strict RLS write restrictions on direct client database access.
