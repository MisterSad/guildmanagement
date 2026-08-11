# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Nightwraith Guild & Roster Import**: Created migration `20260811190000_add_nightwraith_guild_and_members.sql` provisioning the guild `NIGHTWRAITH` (server 1078) in `public.guilds` with unlimited subscription status, and importing 129 unique members (Ducksauce, Rohaz, Lionheart, BartiZ, Hanssssolo, MadTomcat1953, Marijus, mykka, adones, QII7, etc.) with their exact combat power values into `public.guild_members`.
- **Automated Active Event Roster Sync on Member Changes**: Created migration `20260811000000_sync_active_event_participants_on_member_changes.sql` and updated frontend loaders (`events.js`, `armsrace.js`) to automatically synchronize participant lists for all active event sessions whenever a member is added, approved, deleted, or transferred.

---

## Fixed

- **NIGHTWRAITH Tenant Casing & Server Number (`20260811191000_fix_nightwraith_tenant_and_server.sql`)**: Corrected tenant ID casing to uppercase `NIGHTWRAITH`, assigned server number `1078`, migrated all 129 member rows from `Nightwraith` to `NIGHTWRAITH`, and purged the stray `Nightwraith` entry from `public.guilds`.
- **Roster & Power Seeding Integrity**: Ensured idempotent composite unique key handling on `(guild, pseudo)` during guild member batch inserts and triggered PostgREST schema cache reload.
