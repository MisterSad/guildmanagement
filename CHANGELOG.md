# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **NIGHTWRAITH Guild Roster Clean & Sync (`20260812045500`)**: Created migration `20260812045500_clean_obsolete_nightwraith_members.sql` purging 7 obsolete member records (old pseudos, case variants, and past roster entries) so that `NIGHTWRAITH` (Server #1078) reflects exactly the 147 current members.
- **NIGHTWRAITH Guild Roster & Power Update (`20260812045000`)**: Created migration `20260812045000_upsert_nightwraith_members.sql` upserting 147 members into the existing `NIGHTWRAITH` tenant (Server #1078) with updated overall combat power ratings.
- **OBSIDIANSTAR Guild Roster Correction (`20260812043000`)**: Created migration `20260812043000_fix_obsidianstar_typo_and_move_members.sql` transferring all 126 imported members to the correct tenant `OBSIDIANSTAR` (server #1078) and deleting the erroneous `OBSIDANSTAR` tenant.
- **Super Admin Tenant Deletion (`20260812042000`)**: Created `public.gm_delete_guild(p_guild_id)` SECURITY DEFINER RPC allowing super admins to permanently delete a tenant and all its associated data. Added Delete button with confirmation modal to the Super Admin dashboard in `app.js`.

---

## Fixed

- **Frontend Syntax Error Fix (`app.js`)**: Fixed a missing closing brace `}` in `renderGuildsSubscriptionList()` introduced during the tenant deletion update that caused `app.js` to fail parsing (`SyntaxError: Unexpected token ')'`) on page load in client browsers.
- **RLS Policy Standardization for Accounts and Guilds (`20260812044000`)**: Created migration `20260812044000_harden_accounts_and_guilds_rls_helpers.sql` introducing `gm_can_read_account(id)` helper and purging inline `auth.jwt()` checks from `accounts` and `guilds` policies. Resolves PostgREST 403 / permission errors during initial login data fetching.
- **Super Admin Login Verification & Error Feedback (`app.js`, `index.html`)**: Verified database authentication pipeline and Edge Function authorization for `HawkEye`. Improved UI login error display to report specific server responses directly without masking errors or hanging.
- **Login Casing & Session Refresh Robustness (`app.js`, `gm-utils.js`)**: Fixed login issues where entering an identifier with different letter casing led to failed guild restriction lookup and lost permissions. Enforced canonical user ID usage returned by `auth-login`, updated DB account lookups to use case-insensitive `.ilike()`, and enabled automatic token refresh (`forceRefreshPortalSession`) for all account sessions upon page load.
