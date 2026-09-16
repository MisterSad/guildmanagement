📢 **FGF Guild Management Tool Update — CHANG_V3.18.4**

Welcome to V3.18.4! Today I just deployed our new **Automated Discord Server Bootstrap & Provisioning Engine** (`/setup-server`)! With this release, our bot can take any blank or new Discord server and completely format it into a battle-ready, standardized guild command center tailored dynamically to your guild. Here is everything newly available:

### 🏗️ Complete Automated Discord Server Bootstrap (`/setup-server`)
- **What changed**: Guild administrators can now run `/setup-server guild:<GUILD_ID>` (with optional `server_number` and `clean_mode`).
- **The benefit**: In under 15 seconds, the bot builds an entire server hierarchy with **7 categories, 28 text channels, 3 voice channels, and 4 specialized roles**!

### 🏷️ 100% Dynamic Guild Customization
- **What changed**: Zero hardcoded names! The bot dynamically extracts your guild's data:
  - Custom roles: `👑 [TAG] R5`, `⭐ [TAG] R4`, `🛡️ [TAG] Member`, `👽 Visitor`.
  - Custom category: `🔴 <GUILD_NAME>` (e.g. `🔴 ALPHA` or `🔴 BABE`).
  - Custom channels: `#📡・<guild_slug>-chat`, `#🗓️・<tag_slug>-leave-and-absence`, `🔊 🎧・<tag_slug>-voice`.
  - Game server category: `🪐 SERVER #<server_number>` with community rules and channels.
- **The benefit**: Works out of the box for any guild tenant across the galaxy with zero manual renaming needed.

### 🛡️ Zero-Trust Channel Permissions & Officer Privacy
- **What changed**: Public visitors and unverified members are automatically locked out of private guild headquarters and classified war rooms. Officers receive dedicated secure rooms (`#👑・r4-chat` and `🔊 R4 VC`) locked strictly to R4 and R5 ranks.
- **The benefit**: Total operational security for battle strategies, treaty deliberations, and leadership meetings.

### ⚡ Automatic FGF Platform Synchronization
- **What changed**: The bot doesn't just create channels; it automatically links the newly created `#🔐・verification`, `#👑・r4-chat`, and member role directly into your FGF database (`guild_config`).
- **The benefit**: Instant zero-configuration activation of AI screenshot verification and officer alerts!

Run `/setup-server` on your Discord server and enjoy an instant, professional guild command center! 🚀🏛️⚔️

---

📢 **FGF Guild Management Tool Update — CHANG_V3.18.3**

Welcome to V3.18.3! Today I just rolled out a major upgrade to our **Interactive Discord Bot**! From privacy-first zero-clutter channel verification to real-time war check-ins and guild leaderboards, here is everything newly available directly inside your Discord server:

### 🧹 Clean Verification & Privacy: Auto-Delete & Welcome DMs
- **What changed**: When players upload their in-game profile screenshot in `#verification`:
  - **Auto-Clean**: Once their profile is verified, the bot automatically deletes their screenshot after 3 seconds, keeping your channel spotless and protecting sensitive in-game data (UID, fleet levels, fleet power) from public view!
  - **Welcome DM**: The bot sends a direct message to the player confirming their registered power, glory, assigned server nickname, and guild role. (If their DMs are disabled, a friendly notice is shown and auto-destructs after 20 seconds).
  - **Officer Audit Log**: Verification events are silently archived in the officer audit channel (`#verification-logs`) for easy tracking.
  - **Failed Image Cleanup**: If a screenshot cannot be read, it is cleaned up after 60 seconds.
- **The benefit**: No more messy verification channels full of old screenshots, and maximum privacy for your guild members.

### 🏆 Guild Leaderboards (`/top`)
- **What changed**: Added the `/top` slash command to see who is leading the guild:
  - `/top category:Overall Power` — Top 10 most powerful commanders.
  - `/top category:Glory Score` — Top 10 weekly glory contributors.
  - `/top category:Fleet Rating` — Top 10 strongest battle fleets.
- **The benefit**: Instant recognition for your top performers and friendly competition directly inside Discord!

### ⚔️ Interactive Call to Arms War Check-In (`/call-to-arms`)
- **What changed**: Officers can now launch an interactive war attendance roll-call with `/call-to-arms <event_name>` (e.g. `SvS Invasion`, `GvG Saturday`).
- **The benefit**: Members simply click **🟢 Present**, **🟡 Late**, or **🔴 Absent**. The bot automatically updates the message in real-time, displaying the player list and calculating the **Total Mobilized Combat Power** and **Fleet Rating** ready for battle!

### 🕐 Live Member Local Time & Absence Status on `/profile`
- **What changed**: When viewing any member's combat card via `/profile`:
  - **Live Local Time**: The bot calculates their current time based on their timezone (e.g. `16:30 (UTC+2)`), so you know at a glance whether they are awake before a war ping.
  - **Live Absence Status**: Shows if they are `🟢 Active` or `🔴 Absent until YYYY-MM-DD` with their note.
- **The benefit**: Seamless war coordination without guessing timezones or availability.

### 📅 Officer Absence Briefings (`/absences`) & Instant Alerts
- **What changed**: Officers can check `/absences scope:Today` or `/absences scope:Upcoming` to view planned leaves for the week. Additionally, when any member submits `/absent`, an alert is immediately sent to the officer channel.
- **The benefit**: Fast roster adjustments before GvG or SvS match-ups.

### ⚡ Quick Stats Update (`/update-stats`)
- **What changed**: Verified members can now quickly update their power or glory via `/update-stats [power] [glory]`, showing their progression delta instantly.

Redeploy your worker or invite the updated bot to take advantage of these new capabilities! 🚀⚔️🛡️

---

📢 **FGF Guild Management Tool Update — CHANG_V3.18.2**

Welcome to V3.18.2! Over the past few hours, I completed a complete overhaul of the Discord notification and reminder system. Between an end-to-end fix for automated event reminder delivery and a brand new Message Customization Studio featuring live Discord preview and 1-click tag insertion, customizing and sending your guild's Discord alerts is now effortless and foolproof. Here is everything I just rolled out!

### 🎨 Brand New Discord Reminder Customizer: Tabs, 1-Click Pills & Live Preview
- **What changed**: When customizing event reminder messages (Arms Race, DTR, Shadowfront, Calamity, GvG, SvS) from Guild Settings, you now have an all-new split-screen studio:
  - **Horizontal Tabs**: No more endless scrolling through 21 stacked inputs! You can now hop between reminders (`30 Min`, `5 Min`, `Event Start`, `Defense`, `Garrison`) with clean horizontal tabs and configure one reminder at a time.
  - **1-Click Tag Insertion Pills**: Forget memorizing placeholder syntax or risking broken tags. Handy buttons above each field let you insert your **Guild Role** (`{guild_tag}`), `@everyone`, **Event Name** (`{event_name}`), **UTC Time** (`{date}`), and **Round #** (`{round}`) at your cursor position with a single click.
  - **Real-Time Discord Live Preview**: The right side displays a realistic Discord dark theme message (`#313338`) that updates live on every keystroke, showing highlighted role mentions, your embed title and body, and color-coded accent borders matching event urgency (Amber, Red, Emerald, Cyan).
  - **1-Click Reset to Default**: Made a mistake or want to go back to the standard wording? A single tap on **"Reset to default template"** instantly restores the built-in message.
- **The benefit**: Total creative control over how alerts appear in your Discord server with zero formatting stress, zero syntax errors, and an exact live preview before saving!

### 🔔 Discord Webhooks & Automatic Reminders Fully Restored
- **What changed**: I tracked down and resolved the underlying issues that caused automated Discord event reminders to get dropped:
  - **Smart Fallback Webhook Resolution**: If you leave specific event category webhooks blank, the system now automatically falls back to your guild's default Discord webhook rather than silencing the notification.
  - **Scheduler Lock Resolution**: Fixed a lock bug in the background cron worker where missing webhooks previously marked reminders as permanently "sent", preventing future retries.
  - **Dedicated Webhook Testing**: Added a **Default Discord Webhook URL** field with an instant **"Send Test Message"** button directly in Guild Settings so you can verify webhook connectivity in 2 seconds.
  - **Manual GvG Task Dispatch**: Added an instant **"Send Today's GvG Tasks Now"** button so Guild Admins can push daily assignments to Discord on demand whenever needed.
  - **Cloud Infrastructure Updated**: Deployed updated background reminder and webhook proxy functions to production.
- **The benefit**: Scheduled alerts for Arms Race, Defend Trade Route, Shadowfront, Calamity Befalls, GvG, and SvS now arrive reliably in your guild's Discord channels with proper role pings.

### ✏️ Fixed Pencil / Edit Icon on Event Cards
- **What changed**: I fixed a bug where clicking the pencil/edit icon on the event cards inside the Guild Settings Discord section did nothing.
- **The benefit**: Clicking the edit button on any event card immediately opens the new personalization studio, allowing you to customize your alerts in seconds.

### 📱 Decommissioned Redundant Mobile PWA Web Push
- **What changed**: I completely decommissioned the experimental browser web push notifications from both the frontend dashboard and backend scheduler.
- **The benefit**: No redundant background prompts or mobile browser notification noise. All alerts are now unified where your guild actually coordinates: directly inside Discord.

Try out the new customization studio in Guild Settings and let me know your thoughts! As always, your feedback and bug reports are warmly welcome. 🚀⚔️🛡️

---

📢 **FGF Guild Management Tool Update — CHANG_V3.18.1**

Welcome to V3.18.1! Today brought major quality-of-life upgrades across the board: member logins now land straight on the Player Portal, SvS/GvG day results cycle smoothly in 3 clicks, the OCR scanner understands European & German score formats, and official in-game chest thresholds are updated with a clean collapsible settings card. Here is everything rolled out in this release!

### 🛡️ Member Login Fix: Direct Player Portal Landing
- **What changed**: I fixed an issue where regular guild members signing in through the main login screen, biometric passkeys, or refreshing their browser were occasionally routed to an empty Admin Command Center showing 0 active members and 0 stats. Members now land directly and immediately on their personal **Player Portal** (`#tab-portal`), and their session remains cleanly locked to the portal.
- **The benefit**: Zero confusion for your players — instant access to score submissions, personal combat history, event signups, and absence reports without ever seeing a blank admin screen.

### ⚔️ SvS & GvG Daily Win/Loss: 3-Click Cycling
- **What changed**: The daily D1–D6 win/loss outcome buttons on SvS and GvG event banners now cycle intuitively in 3 clicks:
  - **Default**: **Neutral** (`—` in subtle gray).
  - **1st click**: **Won** (`W` in vibrant green).
  - **2nd click**: **Lost** (`L` in clear red).
  - **3rd click**: Smoothly resets back to **Neutral** (`—`).
- **The benefit**: I also updated the backend database logic so resetting a day back to neutral actually saves properly instead of getting stuck on "Lost". Combined with responsive hover tooltips and smooth click micro-interactions, recording daily war outcomes is faster and clearer than ever.

### 🔍 Smart OCR: European & German Leaderboard Support
- **What changed**: I upgraded the AI OCR scanner to natively recognize European and German number formats (such as on "Schadensrangliste" damage boards). The scanner now understands that in German interfaces, `T` stands for *Tausend* (1,000), commas are decimal separators, and dots are thousands separators (`67,4T` = 67,400, `24,98T` = 24,980, and `5.663` = 5,663).
- **The benefit**: No more inflated scores! German screenshot scores are no longer misinterpreted as trillions or billions, and a built-in safety guard prevents multiplier runaway while preserving exact leaderboard ranks.

### 📦 Official GvG & SvS 9-Tier Chest Thresholds & Clean Accordion
- **What changed**: I updated the default 9-tier chest point thresholds for every single day of GvG and SvS (Day 1, Days 2 to 4, Day 5, Day 6 PvP, and cumulative Day 0) to match the official in-game requirements. Additionally, the Chest Tiers configuration in Guild Settings is now housed inside a neat collapsible accordion that stays **closed by default**.
- **The benefit**: Your war chest calculations are 100% accurate right out of the box, and Guild Admins enjoy a clutter-free settings dashboard that unfolds in one click whenever you want to fine-tune tier values.

Try out the updates and let me know how they work for your guild! As always, your feedback and bug reports are greatly appreciated. 🚀⚔️🛡️

---

📢 **FGF Guild Management Tool Update — CHANG_V3.18.0**

Welcome to V3.18! This update reworks SvS and GvG tracking around a single idea: every day counts, on its own. Scores are now entered day by day (Day 1 to Day 6), chest rewards follow a configurable score grid, and you can mark each day Won or Lost — with the enemy server or guild tracked right on the event screen.

### ⚔️ Daily SvS / GvG Scores, Day by Day
- **What changed**: the old "Day 1-5 score" box is gone. You now have six separate score columns — Day 1, Day 2, Day 3, Day 4, Day 5 and Day 6 — one per player, saved automatically as you type.
- **The benefit**: you can finally see *which* day won or lost you the fight, not just a week-long blob. Perfect for coaching, garrisons, and post-war debriefs.

### 📦 Configurable Chest Tiers
- **What changed**: a new "Chest Tiers" panel in Guild Settings lets you define, for each day, exactly how many points unlock how many chests — add, edit or remove thresholds for SvS and GvG separately.
- **The benefit**: when the game's editor rebalances chest rewards, you adjust one screen instead of re-entering every score. Past sessions keep the grid they started with, so your history stays accurate forever.

### 🏹 Track the Enemy & the Result
- **What changed**: each SvS session now remembers the enemy server, each GvG session the enemy guild (pick one, or type a new one on the fly), and every day gets a simple Won / Lost toggle. History cards show it all at a glance: "vs Omega · 4W/2L".
- **The benefit**: no more digging through screenshots to remember who you faced and whether you won the day. One glance at History tells the whole story.

### 🧭 Smarter OCR Guard
- **What changed**: the old SvS/GvG "Day 1 to 5" OCR buttons automatically switch off while a session is in per-day mode, with a clear hint to enter scores day by day instead.
- **The benefit**: no more accidental overwrites of your carefully-entered daily scores — the tool nudges you to the right workflow.

Try it on the next SvS or GvG session, and let me know what you think! As always, feedback and bug reports through Report a Bug or Discord are very welcome. 🚀⚔️

---

📢 **FGF Guild Management Tool Update — CHANG_V3.17.2**

Welcome to V3.17.2! This update is all about keeping things fast, safe and smooth: logins stay instant even during the biggest SvS/GvG rallies, accounts are locked down behind strict role isolation, the roster feels effortless, and network hiccups now come with clear guidance. Full breakdown below.

### ⚡ Instant Logins & Peak-Hour Stability
- **What changed**: I reworked the login and reminder backends — targeted database indexes, strict timeouts, an atomic rate limiter, and smarter background jobs. The busiest hours no longer strain the servers.
- **The benefit**: Your password sign-ins and Passkey unlocks stay lightning-fast and rock-solid during large SvS/GvG gatherings, with none of the connection timeouts some players saw before.

### 🛡️ Strict Role Isolation & Account Protection
- **What changed**: Access is now strictly limited to the four canonical roles, with the older in-game rank values retired permanently. Every account session can also be invalidated on demand (after a password reset or role change).
- **The benefit**: Absolute separation between guilds — no account can slip into elevated access, and a session that could have been compromised can be shut down immediately.

### 🚀 Ultra-Smooth Roster & Tactical Matrix
- **What changed**: The roster now uses one-time event wiring and precomputed scores, sorting and searching instantly, and the Tactical Force Matrix ranks in a single pass.
- **The benefit**: Flicker-free interaction with your member list even with hundreds of players, and lightning-quick navigation between tabs without redundant loading screens.

### 🌐 Smarter Offline & Reconnect Alerts
- **What changed**: Network problems (brief disconnections, server timeouts, rate limits) now show clear, friendly messages with an immediate Retry button instead of a cryptic error.
- **The benefit**: If you hit a micro-outage, you'll instantly know what happened and can get right back to work with a single click.

*Thank you for your feedback, bug reports, and suggestions! As always, feel free to report issues or suggest ideas using the Report a Bug button or via Discord.* 🚀⚔️