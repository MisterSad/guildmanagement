# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Glory Upsert Edge Function Authorization (`20260812033000`)**: Created migration `20260812033000_fix_glory_upsert_service_role_access.sql` allowing `service_role` (Edge Functions) to execute `gm_upsert_player_glory` on behalf of validated players.

---

## Fixed

- **Player Portal Glory Save (`20260812033000`)**: Fixed an issue where `member` accounts received `Failed to save: permission_denied` when updating their weekly Glory score in the Player Portal. `check_user_guild_write_access` now authorizes `service_role` Edge Function execution while maintaining strict RLS write restrictions on direct client database access.
