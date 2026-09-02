# discord-verification-worker

Always-on Discord Gateway listener for the player-verification feature (screenshot -> role + nickname + roster). This is the only piece of the feature that can't run on Supabase Edge Functions, because reacting to a message posted in a channel requires a persistent Gateway (WebSocket) connection, which a stateless, invoked-per-request Edge Function cannot hold open.

This worker has no business logic. It only detects an image posted in a configured verification channel and forwards it to the `discord-profile-verification` Supabase Edge Function, which does everything else (OCR, validation, database writes, role assignment, nickname change, and the reply posted back into the channel).

## Deploying on Render

1. **New Web Service** (not Static Site) pointing at this GitHub repo.
2. **Root Directory**: `discord-verification-worker`
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Instance type**: any paid, always-on tier -- **not the free tier**, which spins down on inactivity and would drop the Gateway connection (and miss verification messages) until the next request wakes it back up.
6. **Environment variables** (Render dashboard -> Environment):
   - `DISCORD_BOT_TOKEN` -- same bot token already used for slash commands (Developer Portal -> Bot). Needs `Manage Roles` + `Manage Nicknames` permissions granted when the bot was invited (re-invite required if it was added with `permissions=0`).
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `VERIFICATION_FUNCTION_URL` -- the deployed `discord-profile-verification` function URL, e.g. `https://<project-ref>.supabase.co/functions/v1/discord-profile-verification`
   - `DISCORD_WORKER_SECRET` -- a new, randomly generated secret shared with the Edge Function (also set as a Supabase Edge Function secret under the same name). Authenticates worker -> Edge Function calls; not related to `DISCORD_PUBLIC_KEY` (which authenticates Discord -> `discord-bot-interactions` instead).

## Per-guild setup (admin side, no code)

In the app: **Admin -> Discord Notifications -> Player Verification (Screenshot OCR)**:
- **Verification Channel ID**: the Discord channel (e.g. `🔐・verification`) to watch. Empty = disabled for that guild.
- **Member Role ID**: the Discord role to assign on a successful verification.

Also required once per Discord server, in Discord itself:
- The bot's own role must be positioned **above** the role(s) it needs to assign (Server Settings -> Roles) -- a Discord-level constraint, not something any code here can work around.
