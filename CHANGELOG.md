# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-07-10

### Fixed
- **Edge Functions**: Deployed all outstanding local Edge Function updates to the remote Supabase environment (version alignment for `event-reminders`, `auth-login`, and `admin-accounts`).
- **Event Reminders Deadlock**: Added stale lock handling for GvG Saturday, SvS PvP, and Calamity Befalls notifications inside the `event-reminders` function to prevent deadlocks (stale `sending` locks older than 5 minutes are now cleared automatically).
- **Webhooks**: Tested and verified Discord webhook URLs across all active tenants (`ALPHA`, `OMEGA`, `IMK`, `BABE`) to ensure messages deliver successfully.
- **Custom Templates**: Restored template configuration integration on the remote server for Arms Race, Shadowfront, and other event reminders.
