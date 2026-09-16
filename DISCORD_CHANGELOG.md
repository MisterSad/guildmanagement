📢 **FGF Guild Management Tool Update — CHANG_V3.18.4**

Welcome to V3.18.4! Over the recent releases, I have completely transformed our interactive Discord Bot from a simple verification worker into an all-in-one, automated guild management powerhouse directly inside your Discord server.

From zero-effort server setup to privacy-first OCR verification, live war check-ins, and leaderboards, here is a complete guide to all the bot's features and recent evolutions!

---

### 🏗️ 1. Automated Discord Server Bootstrap (`/setup-server`)
- **What it does**: Need to set up a brand new Discord server for your guild? With a single command, the bot completely formats and bootstraps a full, battle-ready command center in under 15 seconds!
- **100% Dynamic Guild Customization**: Zero hardcoded values! The bot dynamically pulls your guild's data to tailor every name, slug, and role:
  - **4 Custom Roles**: `👑 [TAG] R5` (Leader), `⭐ [TAG] R4` (Officer), `🛡️ [TAG] Member`, and `👽 Visitor`.
  - **7 Standardized Categories**: `🛂 WELCOME`, `👽 CROSS SERVER VISITORS`, `GAME UPDATES`, `⌛ EVENT REMINDERS`, `🪐 SERVER #<num>`, `🚨 DOMINION WARZONE`, and `🔴 <GUILD_NAME>`.
  - **31 Pre-Configured Channels**: 28 text channels and 3 voice rooms (including squad voice and classified officer conference).
- **Zero-Trust Security & Confidentiality**:
  - Non-verified members and visitors are strictly isolated from private guild channels and classified war rooms.
  - `#👑・r4-chat` and `🔊 R4 VC` are locked strictly to R4 Officers and R5 Leaders.
- **SaaS Auto-Wiring**: Automatically links the created `#🔐・verification`, `#👑・r4-chat`, and member role into your FGF database (`guild_config`).
- **Safety Safeguards**:
  - Requires native Discord **Administrator** permission.
  - Interactive validation buttons (`[ 🚀 Confirmer et Déployer ]` / `[ ❌ Annuler ]`) prevent accidental executions.
  - Live animated progress bar (`[████████░░░░░░░░] 50%`) with anti-rate-limit throttling.
  - Optional `clean_mode: true` to delete default Discord channels (like `#general`) before building.

---

### 🧹 2. Zero-Clutter OCR Profile Verification & Privacy
- **What it does**: New members post their in-game profile screenshot into `#verification` to get verified and gain access.
- **Auto-Delete for Privacy**: Once processed, the bot automatically deletes the uploaded screenshot after 3 seconds! This keeps your verification channel spotless and protects sensitive player data (UID, fleet levels, total power) from public view.
- **Friendly DMs**: The bot sends a direct message to the player confirming their power, glory score, assigned nickname (`[TAG] Pseudo #Server`), and role. (If their DMs are disabled, a clean self-destructing notice is shown for 20 seconds).
- **Officer Audit Archiving**: Every verification event is silently logged into your officer audit channel (`#r4-chat`) for easy historical tracking.
- **Visitor Diplomacy**: If an ally or external player posts their profile, they receive the `[VISITOR]` role with a formatted nickname so they can access cross-server diplomacy channels.
- **Error Cleanup**: If an image cannot be read, the message auto-deletes after 60 seconds to prevent channel clutter.

---

### ⚔️ 3. Interactive Call to Arms War Check-In (`/call-to-arms`)
- **What it does**: Officers can launch a live war attendance roll-call before any battle (e.g. `/call-to-arms event_name:SvS Invasion description:Defense starts at 20:00 UTC`).
- **Live Interactive Buttons**: Members simply click **🟢 Present**, **🟡 Late (15-30m)**, or **🔴 Absent**.
- **Real-Time Mobilization Stats**: The bot updates the message in real-time, listing participating commanders and dynamically calculating the **Total Mobilized Combat Power** and **Fleet Rating** ready for battle!

---

### 🏆 4. Guild Leaderboards (`/top`)
- **What it does**: Check who leads the guild across three competitive categories:
  - `/top category:Overall Power` — Top 10 most powerful commanders in the roster.
  - `/top category:Glory Score` — Top 10 weekly glory contributors.
  - `/top category:Fleet Rating` — Top 10 highest fleet ratings.
- **Podium Styling**: Top 3 commanders receive gold, silver, and bronze podium medals (`🥇`, `🥈`, `🥉`) with clean numerical formatting.

---

### 🕐 5. Enriched Player Profiles (`/profile`)
- **What it does**: Inspect any commander's combat stats via `/profile user:@Commander` or `/profile ingame_name:Pseudo`.
- **Live Local Time**: The bot calculates their current local time based on their timezone offset (e.g. `16:30 (UTC+2)`), so officers know whether a player is awake before calling for urgent defenses.
- **Live Absence Status**: Instantly shows whether the player is `🟢 Active` or `🔴 Absent until YYYY-MM-DD` with their note.

---

### 📅 6. Absence Management & Instant Alerts (`/absent` & `/absences`)
- **Player Declarations (`/absent`)**: Players declare absence periods with `/absent start_date:YYYY-MM-DD end_date:YYYY-MM-DD reason:...`.
- **Officer Briefings (`/absences`)**: Officers can check `/absences scope:Today` to see who is unavailable right now, or `/absences scope:Upcoming` for planned leaves over the next 7 days.
- **Officer Alerts**: Whenever an absence is registered, an alert is automatically dispatched to the leadership channel.

---

### ⚡ 7. Quick Stats Update (`/update-stats`)
- **What it does**: Verified commanders can quickly update their combat power or glory score directly via Discord without logging into the web platform.
- **Delta Progression**: Shows the progression difference (`+15,000,000 Power`) and synchronizes the roster immediately.

---

### 📋 Bot Commands Cheat Sheet

| Command | Who Can Use | Description |
| :--- | :--- | :--- |
| `/setup-server` | 👑 Server Admin | Formats and provisions the entire Discord server structure. |
| `/call-to-arms` | ⭐ Officers (R4/R5) | Launches interactive war roll-call with live power aggregation. |
| `/absences` | ⭐ Officers (R4/R5) | Lists members currently absent today or in the next 7 days. |
| `/top` | 👥 Everyone | Displays top 10 guild leaderboard (Power, Glory, Fleet). |
| `/profile` | 👥 Everyone | Displays a commander's combat stats, local time, and status. |
| `/absent` | 🛡️ Verified Members | Declares a temporary absence period in the guild roster. |
| `/update-stats` | 🛡️ Verified Members | Updates your in-game power or glory score directly. |
| `/link` | 👥 Everyone | Links your Discord account to your FGF player account. |
| `/myinfo` | 🛡️ Verified Members | Displays your own linked player stats and timezone. |

---

Enjoy the upgraded bot, and let me know if you need any additional features for your guild! 🚀⚔️🛡️