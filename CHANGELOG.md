# Changelog

## New

- **Discord Webhook Fallback & Robust Error Diagnostics**: Enhanced Discord Webhook integration for Super Admin Opponent Roster sharing with automatic URL formatting/cleaning, detailed HTTP status error reporting (e.g. 404/400/429), and a form-encoded fallback mechanism (`URLSearchParams`) to bypass browser CORS preflight blocks or extension restrictions.
- **Dedicated Super Admin Webhooks for SvS & GvG Opponent Rosters**: Created isolated webhook configuration keys (`webhook_svs_opponent` and `webhook_gvg_opponent`) dedicated strictly to the Super Admin secret Opponent Roster export tool in SvS and GvG. These webhooks are completely separate from standard public guild event notification webhooks (`webhook_svs` / `webhook_gvg` / `discord_webhook_url`) to ensure complete privacy and zero data leakage.
- **In-Tab Webhook Configuration for SvS & GvG**: Added an inline Discord Webhook input field and **Save** button directly inside both the **SvS** and **GvG** Super Admin matchup cards. Super admins can configure, save, or update the target Webhook URL directly from either tab without navigating away.
- **Discord Roster Sharing in SvS & GvG Matchups**: Added one-click Discord Webhook integration in the Super Admin **SvS** and **GvG** matchup tabs to export and post the Opponent / Target server or guild roster directly to Discord. Each shared entry includes Member pseudo, Guild, Power, and Threat level tier. Automatically chunks long rosters into clean sequential messages to comply with Discord payload limits.
- **TWILIGHT Roster Import**: Imported 181 members with combat power into the `TWILIGHT` tenant (Server #1078).
- **BLACKTHUNDER Roster Import**: Imported 71 members with combat power into the `BLACKTHUNDER` tenant (Server #1078).
- **ASTRAL_LIBERION Roster Import**: Imported 73 members with combat power into the `ASTRAL_LIBERION` tenant (Server #1078).
- **NIGHTWRAITH Roster Import & Sync**: Imported 147 members with combat power into the `NIGHTWRAITH` tenant (Server #1078) and purged 7 duplicate/obsolete accounts.

## Fixed

- **Discord Webhook Error Handling**: Detailed failure notifications now display the exact HTTP code or network error reason when a Discord post attempt fails.
- **Client App Syntax Error & Login Restoration**: Fixed missing syntax brace in `app.js` introduced during subscription UI updates and restored login connectivity for HawkEye and guild admin accounts.
- **SECURITY DEFINER RLS Policy Hardening**: Hardened `accounts` and `guilds` access policies via SECURITY DEFINER functions to eliminate permission errors during REST queries.
