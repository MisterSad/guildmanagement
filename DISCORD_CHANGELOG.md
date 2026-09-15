📢 **FGF Guild Management Tool Update — CHANG_V3.18.1**

Welcome to V3.18.1! Today was a huge day of fixes and quality-of-life upgrades across the board: member logins now land straight on the Player Portal, SvS/GvG day results cycle smoothly in 3 clicks, the OCR scanner understands European & German score formats, official in-game chest thresholds are updated with a clean collapsible settings card, and Discord webhook reminders are back up and running reliably. Here is everything I rolled out today!

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

### 🔔 Discord Webhooks & Automatic Event Reminders Overhaul
- **What changed**: I thoroughly overhauled the Discord notification system and fixed the root causes that stopped reminders from arriving:
  - Added a dedicated **Default Discord Webhook URL** field and a **"Send Test Message"** button right inside Guild Settings so you can verify your Discord webhook in one click.
  - Added a manual **"Send Today's GvG Tasks Now"** button so guild admins can dispatch daily GvG tasks instantly on demand.
  - Fixed fallback resolution so empty event-specific webhooks cleanly fall back to your default guild webhook rather than silencing notifications.
  - Fixed false "sent" locks in the background scheduler that previously prevented reminders from dispatching.
  - Resolved webhook proxy URL validation to support all standard Discord webhook URL formats.
- **The benefit**: Automatic event reminders (Arms Race, DTR, Shadowfront, GvG daily tasks, SvS phases, and Calamity alerts) fire reliably into your guild's channels with role mentions, with instant testing available right in Guild Settings!

### 📱 Decommissioning Unused PWA Mobile Push
- **What changed**: I completely removed mobile browser push notifications (PWA web push) across the backend scheduler and frontend (Overview and Player Portal).
- **The benefit**: A cleaner, faster interface with zero notification clutter. All guild alerts are now centralized strictly where everyone actually checks them: directly inside your Discord server.

Try out the new updates and let me know how they work for your guild! As always, your feedback and bug reports through Report a Bug or Discord are greatly appreciated. 🚀⚔️🛡️

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