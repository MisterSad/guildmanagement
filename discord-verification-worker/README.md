# discord-verification-worker

Always-on Discord Gateway listener for the player-verification feature (screenshot -> role + nickname + roster). This is the only piece of the feature that can't run on Supabase Edge Functions, because reacting to a message posted in a channel requires a persistent Gateway (WebSocket) connection, which a stateless, invoked-per-request Edge Function cannot hold open.

This worker holds no verification business logic. It detects an image posted in a configured verification channel and gives the player immediate feedback as **reactions only** (⏳ while the screenshot is processed, then ✅/❌) -- the `discord-profile-verification` Supabase Edge Function owns every actual decision (OCR, validation, database writes, role resolution, nickname change) and posts the detailed confirmation/error message itself, so the worker never adds a duplicate text reply. On a verification that the roster confirmed (`role: "guild_member"`) it assigns the configured verified-member role (see below); it deliberately does **not** on the visitor or pending outcomes -- see ADR-020. It also registers and serves the slash commands listed below, forwarding reads/writes through the same service-role database paths the web app uses. It runs a trivial HTTP listener (`GET /` -> 200 once Discord is connected, 503 before). It was added for Render's health checks; on the VM only the local heartbeat timer calls it, and the VM firewall keeps it unreachable from outside.

Requires Node.js >= 22 (the `ws` package is pinned as the Realtime transport for `@supabase/supabase-js`, which avoids the WebSocket resolution crash some runtimes hit at startup).

## Deploying on an Oracle Cloud VM (Always Free)

The worker runs as a systemd service on a small Ubuntu VM. Render was dropped on 2026-11-07: its free tier spins down on inactivity, which drops the Gateway connection, and the always-on tier is paid. Everything needed lives in [`deploy/oracle/`](deploy/oracle/):

- `setup.sh` installs **or updates** the worker (idempotent): Node 22, a `fgfbot` system user, a sparse clone of this repo in `/opt/fgf-guild-management` (root-owned, read-only to the bot), `npm ci --omit=dev --ignore-scripts`, and the systemd units. It never writes a secret, and it only starts the bot once the required variables are filled in.
- `fgf-discord-bot.service` runs `node index.js` as `fgfbot`, restarts it forever (`Restart=always`, no start limit), and sandboxes it (read-only filesystem, no capabilities, 512 MB cap).
- `env.example` is the template for `/etc/fgf-discord-bot/env` (root, mode 600), the only place the secrets live on the VM.
- `fgf-discord-bot-heartbeat.{service,timer}` pings `HEARTBEAT_URL` every 5 minutes, but only while the local listener says the bot is connected to Discord. Point it at a Better Stack heartbeat to be alerted when the bot goes silent. Empty = disabled.

**Only one instance may run at a time.** Two Gateway clients on the same token both react to every screenshot and both answer every command. Suspend the Render service before starting the VM one, and never run `npm start` locally with the production token while the VM is up.

### One-time setup

1. **Account.** Sign up at oracle.com/cloud/free. The home region is permanent; pick one close to the players (Paris, Marseille, Frankfurt). Oracle asks for a card to verify identity.
2. **Upgrade the account to Pay As You Go** (Billing -> Upgrade), then create a budget alert at 1 (Billing -> Budgets). Always Free resources stay free after the upgrade, and only Always Free *accounts* have idle instances reclaimed: this worker uses almost no CPU, so on a free-only account Oracle would stop the VM after 7 idle days. Stay on Always Free shapes and the bill stays at 0.
3. **Instance.** Compute -> Instances -> Create: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex** with 1 OCPU / 6 GB (Ampere, Always Free). If Oracle answers "out of capacity", use **VM.Standard.E2.1.Micro** (1 GB, also Always Free, enough for this worker). Keep "assign a public IPv4", and download the generated SSH private key. No ingress rule is needed beyond the default SSH one: the worker only makes outbound connections.
4. **Install.** From your machine:
   ```bash
   chmod 600 ~/Downloads/ssh-key-*.key
   ssh -i ~/Downloads/ssh-key-*.key ubuntu@<public-ip>
   curl -fsSL https://raw.githubusercontent.com/MisterSad/guildmanagement/main/discord-verification-worker/deploy/oracle/setup.sh | sudo bash
   ```
   The first run installs everything and stops before starting the bot, listing the empty variables.
5. **Secrets.** `sudo nano /etc/fgf-discord-bot/env` and paste the values (from the Render dashboard while it still exists, otherwise from their source). Then run the same `curl ... | sudo bash` line again: it starts the bot and prints its log. `discord-verification-worker logged in as ...` means it is connected.
6. **Check in Discord**: `/profile` answers, and a screenshot in a verification channel gets the reactions.

### Day to day

- Logs: `journalctl -u fgf-discord-bot -f`
- Status: `systemctl status fgf-discord-bot`
- Deploy a new version of the worker (after it is merged to `main`): run the `curl ... | sudo bash` line again.
- Change a variable: edit the env file, then `sudo systemctl restart fgf-discord-bot`.
- Ubuntu security updates install themselves (`unattended-upgrades` is on by default); a kernel update needs an occasional `sudo reboot`, and the bot comes back by itself.

### Environment variables

- `DISCORD_BOT_TOKEN` -- same bot token already used for slash commands (Developer Portal -> Bot). Needs `Manage Roles` + `Manage Nicknames` permissions granted when the bot was invited (re-invite required if it was added with `permissions=0`).
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`
- `VERIFICATION_FUNCTION_URL` -- the deployed `discord-profile-verification` function URL, e.g. `https://<project-ref>.supabase.co/functions/v1/discord-profile-verification`
- `DISCORD_WORKER_SECRET` -- a randomly generated secret shared with the Edge Function (also set as a Supabase Edge Function secret under the same name). Authenticates worker -> Edge Function calls; not related to `DISCORD_PUBLIC_KEY` (which authenticates Discord -> `discord-bot-interactions` instead). Must be the exact same value in both places.
- `DISCORD_MEMBER_ROLE_ID` *(optional)* -- Discord role ID granted automatically after a verification the roster confirmed (e.g. a `Verified` role). **Only** on the `guild_member` outcome: `server-provisioner.js` auto-wires the per-guild fallback to a tag-bearing `[TAG] Member` role, so granting it to a visitor or a pending recruit would hand out exactly what the roster gate withholds (ADR-020). Falls back to the per-guild `guild_config` key `discord_member_role_id` when unset; if neither is configured the feature is silently disabled. Requires the bot to have `manage roles` and its own role positioned **above** the target role.


Without `DISCORD_BOT_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` set, the process exits immediately at startup with a clear "Missing required environment variable" log line -- that's expected until both are added.

## Per-guild setup (admin side, no code)

In the app: **Admin -> Discord Notifications -> Player Verification (Screenshot OCR)**:
- **Verification Channel ID**: the Discord channel (e.g. `🔐・verification`) to watch. Empty = disabled for that guild.
- **Only grant the guild role to players already on the roster**: the ADR-020 gate, stored as `guild_config` key `discord_verification_require_roster`. Off by default (a guild with no value keeps the old behaviour, where a screenshot could create the roster entry it was checked against). On, the member list is the authority: the guild role goes only to a player already in it, matched on their in-game UID -- or on their pseudo when that roster row still holds no real UID, in which case the UID read off the screenshot is written to it. Anyone else gets `[PENDING]`, nothing is written to the roster, and the audit/officer channel gets a durable message naming them.
- **Verified Member Role ID** (per-guild fallback for `DISCORD_MEMBER_ROLE_ID`): add a `discord_member_role_id` row in `guild_config` with the Discord role ID as its value.

There's no "role ID" to configure -- roles are resolved dynamically by name. On that Discord server, create a role named exactly after the guild's bracketed tag (e.g. `[PR1M]`), one named `[VISITOR]`, and one named `[PENDING]`, all positioned **below** the bot's own role (Server Settings -> Roles -> drag the bot's role above them) -- a Discord-level constraint, not something any code here can work around. Without a `[PENDING]` role a held verification falls back to `[VISITOR]`, and without either it only gets a nickname; it never gets the guild role.

**A tag is only ever matched within one game server.** The candidate guilds are those sharing the channel guild's own `guilds.server_number`, so a guild on another game server carrying the same tag resolves to nothing and its members get `[VISITOR]` here -- and cannot be blocked from their own server either. A channel guild with **no** server number can resolve no tag at all: set it in the app (Settings -> Guild), or every screenshot there becomes a visitor. Two guilds sharing a tag on one server is reported to the officer channel and never guessed.

## Slash commands

Registered globally on startup (merged into any existing global commands, so other commands are never wiped):

- `/profile [user] [ingame_name]` -- shows a member's FGF roster stats (role, Overall Power, Fleet, Tech, Flagship, Champs, Crew, timezone) as an embed; resolved via the target's linked account (`discord_account_links` -> `accounts`) or an in-game pseudo search in `guild_members`, **within the caller's own guild only** (the channel's guild, else the caller's linked account). The pseudo is matched case-insensitively with LIKE wildcards escaped. Always ephemeral, and an absence shows its end date, never its reason.
- `/absent <start_date> <end_date> [reason]` -- declares a full absence for the caller's linked guild. Dates are validated (`YYYY-MM-DD`, end >= start) and the write goes through the same `gm_upsert_player_absence` service-role RPC the web + Edge Function paths use. Always replies ephemeral.
- `/setup-server <guild> [server_number] [clean_mode]` -- needs **both** Discord Administrator on the server **and** a linked FGF officer account (`discord_account_links` -> an active guild_admin of `<guild>`, a server_admin of its server, or a super_admin; `officer-scope.js`, same rules as `isGuildInScope`). Discord permissions alone grant nothing: anyone can create a server and invite the bot. Refuses a guild that is not registered in the tool, and refuses to invent a game-server number: that number scopes guild-tag resolution (ADR-020) and the `server_admin` role. Creates `[VISITOR]`, `[PENDING]`, the `[TAG]` member role and the R4/R5 roles, the categories and channels, and wires the verification and audit channels into `guild_config`. It no longer wires `discord_member_role_id`. **Safe to re-run**: roles, categories and channels are matched by name (channels also by parent category and type, on the name Discord actually stores) and reused, so a second run only adds what is missing and never reposts the welcome embeds. The confirmation prompt counts its plan from the same template (`summarizeTemplate`). `clean_mode` still deletes every channel the bot can delete.
- `/mystats [weeks]` -- the caller's attendance per event type (SvS, GvG, Shadowfront, DTR, Arms Race) against their guild's pooled rate, from `gm_player_stats`. Ephemeral. It reports counts and computes **no** weighted score: the weighting lives in `src/core/scoring/reliability.ts`, shared by the admin page and the Portal, and a third copy here is how those two came to disagree once already.
- `/verifications [days]` -- officers (`ManageMessages`): players whose verification was held back by the ADR-020 roster gate, read from the `discord_verification_refused` audit rows. The guild comes from the verification-channel map or the caller's linked account, **never** from an option. Ephemeral, 20 rows, pings nobody.
- `/reconcile-roles` -- officers (`ManageRoles`): who holds the guild tag role without a roster row. Report first; removal only behind a confirmation button that only the officer who ran it can press, and only ever the tag role. **Needs Discord's privileged Server Members Intent**: enable "Server Members Intent" in the Developer Portal, then set `DISCORD_GUILD_MEMBERS_INTENT=true` in the VM env file. The intent is opt-in because declaring it while the toggle is off makes the bot fail to log in entirely.
- `/update-stats [power] [glory]`, `/timezone`, `/challenges`, `/absence list|cancel` -- **forwarded** to the `discord-bot-interactions` Edge Function with the shared worker secret, and its reply relayed. They run the same validated `_shared/player-actions.ts` code the Player Portal uses, so power is clamped to `MAX_ALLOWED_POWER` and every write leaves an audit row; the worker's old direct-RPC version did neither. Reimplementing them here would be a second copy that drifts.

**Retired 2026-09-28**: `/power` and `/glory` (both covered by `/update-stats`) and `/absence set` (covered by `/absent`, which also alerts the officer channel). `/absence list` and `cancel` stay -- `/absences` lists the GUILD's absences, not the caller's own, and nothing else can cancel one. Retiring a command means naming it in `RETIRED_COMMANDS`: the registration step folds unknown existing commands back in so the worker never wipes one it does not own, so dropping it from the desired map alone leaves Discord still serving it.
- Also registered: `/myinfo`, `/top`, `/absences`, `/call-to-arms`.
- `/invite [guild]` -- **forwarded**. An officer posts a "Join [TAG]" LINK button to the guild's `#join=` invite link. Authority is the caller's linked app account checked with `isGuildInScope()`, never a Discord permission.
- Join-request buttons (`gmjoin:approve|reject|rejectok:<accountId>`) on the message auth-discord posts in the audit channel -- **forwarded** (custom_id + message id only). The Edge Function authorizes the clicker's linked officer account with `canManageAccount()` and runs `_shared/registration-decision.ts`, the same code the app's Approve / Reject runs.
- **Retired 2026-10-03: `/link`.** It linked accounts outside the Discord sign-in rules (password kept, claim blocked for good, a second account without an admin relink code). Signing in to the app with Discord links the account. A stale `/link` gets an ephemeral pointer to Continue with Discord.
- Replies that need the app carry a LINK button (style 5) to `APP_URL` (env, defaults to the production origin). Relayed Edge replies keep only https link buttons and `gmjoin:` buttons.
- `/call-to-arms` answers are stored in `discord_rally_responses` (service role only, purged after 7 days), and the post is repainted from every stored answer on each click, so a worker restart loses nothing. They used to live in memory.

**One transport.** Discord delivers interactions over an Interactions Endpoint URL **or** the Gateway, never both. Measured 2026-09-28: `discord-bot-interactions` was invoked 0 times in 24 hours while `discord-profile-verification` was invoked 15, so the Gateway -- this worker -- is the live one. The worker owns every command definition and registers them on boot, globally only (the per-guild copies are cleared on boot, since Discord lists both scopes and showed every command twice); `scripts/register-discord-commands.mjs` was deleted for being a third registry that nothing kept in step.

**One Discord identity may hold several player accounts** since migration `20260927001726` (an administrator who is also a player). Every command that acts *as* the player resolves the link, keeps only the active accounts, and asks which one to use when there is more than one -- it never picks silently, because silently picking is how an admin's command lands on their player account. `/profile @someone` cannot ask them, so it says to search by in-game name instead.
