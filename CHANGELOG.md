# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Automated Active Event Roster Sync on Member Changes**: Created migration `20260811000000_sync_active_event_participants_on_member_changes.sql` and updated frontend loaders (`events.js`, `armsrace.js`) to automatically synchronize participant lists for all active (already initiated) event sessions whenever a member is added, approved, deleted, or transferred between guilds.
  - **Guild Transfers**: Transferring a member (`gm_transfer_guild_member` & `resolve_guild_transfer`) now automatically removes their unparticipated active event rows from the old guild and auto-enrolls them into all active event sessions of their new target guild.
  - **Player Approvals**: Approving a pending player registration (`gm_approve_player_account`) automatically enrolls the new member into all active event sessions of their guild.
  - **Member Deletions**: Deleting a member cleans up unparticipated active event entries while preserving past completed event history.
  - **On-Demand Loader Sync**: Opening or fetching any active event session (`events.js`, `armsrace.js`) runs `gm_populate_event_participants` on the fly to guarantee 100% real-time alignment with the current guild roster.

- **Contextual Help Tooltips ("i" Info Buttons)**: Added a small circular **ⓘ** info button beside section headers across the admin dashboard and player portal. Clicking any info button opens a sleek slide-up modal (`gm-help.js`) with plain-English guidance explaining how to use that specific feature.

---

## Fixed

- **Cross-Guild Transfer Auto-Enroll Authorization Exception**: Fixed migration `20260811001000_fix_transfer_auto_enroll_authorization.sql` where `gm_add_member_to_active_events` raised a `not_authorized` exception during a player transfer. When a `guild_admin` of the source guild transferred a player to a target guild, `gm_add_member_to_active_events` erroneously compared the target guild against the caller's source guild and aborted the transaction. Relaxed the check to verify that the member belongs to the target guild in `guild_members`, ensuring smooth transfers across all guilds.
- **Stale Participant Rosters in Active Events**: Resolved issue where members added or transferred after an event session was started did not appear in active event participant lists, and transferred members remained stuck in the old guild's active events.
- **Crown Icon Overlap in Member Role Dropdown**: Fixed the `ph-crown` icon overlapping the selected role text (R1-R5) in the Edit Member modal (`app.js`).
- **RLS Write Check Fallback**: Updated RLS SECURITY DEFINER helper functions to fall back to matching by JWT `sub` claim when `auth_user_id` is temporarily unlinked.
