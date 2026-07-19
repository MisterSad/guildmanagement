# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-07-19

### Fixed
- **Shadowfront Participation Controls**: Replaced the standard browser checkbox controls for "Late", "Excused", and "Sub Present" with premium, color-coded toggle switch sliders (Orange/Warning for Late, Blue/Info for Excused, Purple/Accent for Sub Present).
- **Shadowfront Live Tracking Stats**: Implemented real-time updates for the "X participated" statistic pill. Toggling any player's participation state now immediately recalculates and updates the stats in the UI without requiring a full tab refresh.

## [Unreleased] - 2026-07-10

### Fixed
- **Edge Functions**: Deployed all outstanding local Edge Function updates to the remote Supabase environment (version alignment for `event-reminders`, `auth-login`, and `admin-accounts`).
- **Event Reminders Deadlock**: Added stale lock handling for GvG Saturday, SvS PvP, and Calamity Befalls notifications inside the `event-reminders` function to prevent deadlocks (stale `sending` locks older than 5 minutes are now cleared automatically).
- **Webhooks**: Tested and verified Discord webhook URLs across all active tenants (`ALPHA`, `OMEGA`, `IMK`, `BABE`) to ensure messages deliver successfully.
- **Custom Templates**: Restored template configuration integration on the remote server for Arms Race, Shadowfront, and other event reminders.
