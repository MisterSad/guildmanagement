# discord-verification-worker

Always-on Discord Gateway listener for the player-verification feature (screenshot -> role + nickname + roster). This is the only piece of the feature that can't run on Supabase Edge Functions, because reacting to a message posted in a channel requires a persistent Gateway (WebSocket) connection, which a stateless, invoked-per-request Edge Function cannot hold open.

This worker has no business logic. It only detects an image posted in a configured verification channel and forwards it to the `discord-profile-verification` Supabase Edge Function, which does everything else (OCR, validation, database writes, role resolution, nickname change, and the reply posted back into the channel). It also runs a trivial HTTP listener (`GET /` -> 200 once Discord is connected, 503 before) -- that exists **only** because Render's simplified web-service tooling has no "background worker" type and a Web Service expects a bound port for health checks; nothing is meant to actually call it.

## Deploying on Render

1. **New Web Service** pointing at this GitHub repo (this is a monorepo -- the worker lives in this `discord-verification-worker/` subfolder alongside the main app).
2. **Root Directory**: set this to `discord-verification-worker` if your Render flow exposes that field. If provisioning through a tool/API that doesn't expose a root-directory field (as happened here), the equivalent is folding the `cd` into the commands instead:
   - **Build Command**: `cd discord-verification-worker && npm install`
   - **Start Command**: `cd discord-verification-worker && npm start`
3. **Instance type**: any paid, always-on tier -- **not the free tier**, which spins down on inactivity and would drop the Gateway connection (and miss verification messages) until the next request wakes it back up.
4. **Environment variables** (Render dashboard -> Environment) -- `SUPABASE_URL`, `VERIFICATION_FUNCTION_URL`, and `DISCORD_WORKER_SECRET` were set when the service was provisioned; `DISCORD_BOT_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` were deliberately left out (highly sensitive, added by the account owner directly in the dashboard, never passed through an assistant tool call):
   - `DISCORD_BOT_TOKEN` -- same bot token already used for slash commands (Developer Portal -> Bot). Needs `Manage Roles` + `Manage Nicknames` permissions granted when the bot was invited (re-invite required if it was added with `permissions=0`).
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_URL`
   - `VERIFICATION_FUNCTION_URL` -- the deployed `discord-profile-verification` function URL, e.g. `https://<project-ref>.supabase.co/functions/v1/discord-profile-verification`
   - `DISCORD_WORKER_SECRET` -- a randomly generated secret shared with the Edge Function (also set as a Supabase Edge Function secret under the same name). Authenticates worker -> Edge Function calls; not related to `DISCORD_PUBLIC_KEY` (which authenticates Discord -> `discord-bot-interactions` instead). Must be the exact same value in both places.

Without `DISCORD_BOT_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` set, the process exits immediately at startup with a clear "Missing required environment variable" log line -- that's expected until both are added.

## Per-guild setup (admin side, no code)

In the app: **Admin -> Discord Notifications -> Player Verification (Screenshot OCR)**:
- **Verification Channel ID**: the Discord channel (e.g. `🔐・verification`) to watch. Empty = disabled for that guild.

There's no "role ID" to configure -- roles are resolved dynamically by name. On that Discord server, create a role named exactly after the guild's bracketed tag (e.g. `[PR1M]`) and one named `[VISITOR]`, both positioned **below** the bot's own role (Server Settings -> Roles -> drag the bot's role above them) -- a Discord-level constraint, not something any code here can work around.
