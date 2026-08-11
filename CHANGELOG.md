# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Nightwraith Guild & Roster Import**: Created migration `20260811190000_add_nightwraith_guild_and_members.sql` provisioning the guild `NIGHTWRAITH` (server 1078) with unlimited subscription and 129 unique members with their combat power values.
- **Automated Active Event Roster Sync**: Created migration `20260811000000_sync_active_event_participants_on_member_changes.sql` to auto-synchronize participant lists for active event sessions whenever members are added, approved, deleted, or transferred.
- **Full Codebase Audit & Hardening Pass**: Conducted a comprehensive 5-domain audit (frontend core, feature modules, migrations/RLS, edge functions, tests/config) and applied all identified fixes.

---

## Fixed

- **P0 Security: `guild_config` Dual SELECT Policy (`20260811193000`)**: Replaced the `FOR ALL` policy `gm_guild_config_write` (which doubled as an unintended second SELECT policy combining with OR) with separate `FOR INSERT`, `FOR UPDATE`, and `FOR DELETE` policies. Now exactly one permissive SELECT policy exists per AGENTS.md rules.
- **P1 Standards: SECURITY DEFINER `search_path` (`20260811193000`)**: Standardized `is_subscription_active`, `list_event_sessions`, `list_event_weeks`, and `is_super_admin` to use `SET search_path TO ''` with fully qualified `public.table` references. Added JWT `sub` fallback for resilient identity resolution.
- **P1 Standards: Em-dashes removed from UI text**: Replaced all em-dashes (`—`) with hyphens (`-`) in user-visible strings across 15 JS files (toasts, labels, placeholders, Discord content, help text).
- **P2 Code Quality: `esc()` added to guild `<option>` elements**: Applied `escapeHTML` defense-in-depth to guild name rendering in `app.js` and `shell.js`.
- **P2 Code Quality: Added `dev` script to `package.json`**: `npm run dev` now starts a local dev server via `serve`.
- **Admin Approval & Service Role Authorization (`20260811192500`)**: Fixed `gm_approve_player_account`, `gm_add_member_to_active_events`, and `gm_populate_event_participants` to support service-role Edge Function calls (removed invalid `auth.uid()` checks causing `unauthorized` errors).
- **NIGHTWRAITH Tenant Casing & Server Number (`20260811191000`)**: Corrected tenant ID to uppercase `NIGHTWRAITH`, set server `1078`, migrated 129 member rows.
