# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Contextual Help Tooltips ("i" Info Buttons)**: Added a small circular **ⓘ** info button beside section headers across the admin dashboard and player portal. Clicking any info button opens a sleek slide-up modal (`gm-help.js`) with plain-English guidance explaining how to use that specific feature:
  - **Accounts & Access**: New Account creation, Active Admin Accounts management, Player Portal Accounts approval flow, Guild Join Code usage.
  - **Discord Notifications**: Guild configuration & event coefficients, Global Discord role mention tagging, Webhook channel integration, Automated event reminders.
  - **Members**: Roster search/filter/edit, Pending guild transfers approval, Absences declaration tracking, Timezone offsets overview.
  - **Events & Stats**: SvS, GvG, Shadowfront squads, DTR, Arms Race stages, Glory tracker, Event history, and Guild Statistics KPI calculation.
  - **Sanctions & Banned**: Applying member sanctions, Banned player UID list enforcement.
  - **Player Portal**: Power updates, Glory score entry, Timezone declaration, Guild transfer requests, and Notification settings.

---

## Fixed

- **Crown Icon Overlap in Member Role Dropdown**: Fixed the `ph-crown` icon overlapping the selected role text (R1-R5) in the Edit Member modal (`app.js`). Moved the icon inside the `<label>` element so the `<select>` dropdown renders cleanly without text collision.
- **RLS Write Check Fallback (`check_user_guild_write_access` & `20260810240000_fix_write_access_auth_uid_fallback.sql`)**: Updated RLS SECURITY DEFINER helper functions to fall back to matching by JWT `sub` claim when `auth_user_id` is temporarily unlinked, preventing spurious `permission denied for table guild_members` errors.
- **GoTrue Shadow Secret Isolation in `admin-accounts`**: Updated the password reset block in `admin-accounts` edge function to re-sync GoTrue passwords without recreating shadow accounts or overwriting `gotrue_secret_enc`.
