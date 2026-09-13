📢 **FGF Guild Management Tool Update — CHANG_V3.18.1**

This update gives you full freedom on how you enter SvS/GvG preparation scores — one global total or day-by-day detail — with zero risk of double counting, plus a smarter OCR that reads single days too.

### 🎛️ Pick Your Entry Mode for Prep Scores
- **What changed**: In the Events war panel you now have a switcher: **Detailed D1–D5** (six per-day columns as before) or **Cumulative D1–D5** (one single "Total" column for the whole preparation phase + Day 6). Your choice is remembered per event.
- **The benefit**: Prefer precision on one day? Use the daily grid. Prefer speed? Enter one total per player. The tool never mixes the two for the same player.

### 🛡️ No More Double Counting, Ever
- **What changed**: The database now guarantees a player can never hold both a total AND per-day scores on the same session — writing one automatically (and safely) replaces the other.
- **The benefit**: Chest thresholds and totals always reflect exactly one coherent source, whichever mode each guild prefers.

### 📅 Party OCR: Total or Single-Day Screenshots
- **What changed**: The SvS/GvG OCR buttons now come in three: **Day 1 to 5 (Total)**, **Day N** (pick Day 1–5 inside the scanner), and **Day 6**. The daily scan imports each player's score straight into the matching day column.
- **The benefit**: You no longer have to crop screenshots into one cumulative image — scan any single prep day and the right column updates automatically, on both server and guild wars.

### ⚙️ Chest Tiers for the Cumulative Total
- **What changed**: Guild Settings → SvS/GvG Chest Tiers now includes a **"Day 1–5 (Total)"** block so you can calibrate rewards for phase-long performance.
- **The benefit**: Reward your players' overall preparation just as precisely as their daily pushes.

This update is all about making your Discord notifications behave exactly as you set them — no more notifications showing up every day when you turned them off, and no more reminders going missing at the wrong moment.

### 🛡️ Notifications Now Follow Your Switches
- **What changed**: I hardened how every notification toggle is read. A notification only fires when it's explicitly switched on — if it's off (or was never saved), it stays quiet.
- **The benefit**: If you uncheck "GvG Daily Tasks" or "SvS reminders" in Guild Admin, they now actually stop. No more phantom messages in your Discord every day.

### 🔇 Category Webhooks, On/Off
- **What changed**: Clearing a category webhook (for example the GvG one) now switches that category off completely instead of quietly routing to your general channel.
- **The benefit**: Full control per category — want SvS silent but Arms Race on? Just empty the SvS webhook.

### ⚡ Reminders Land at the Right Time
- **What changed**: I made the reminder trigger timezone-proof (always UTC) and fixed the weekly SvS detection so it follows the current calendar week, not a fragile time window.
- **The benefit**: GvG, SvS and Calamity reminders fire when they're supposed to — even across server and clock quirks — and portal battle alerts no longer depend on marking the prep phase as "Won".

### 🧾 Event Names Are Forgiving
- **What changed**: Event matching is now case- and spacing-insensitive.
- **The benefit**: Even if an event label differs slightly, your 30-minute, 5-minute and start reminders still go out.

Plus, if a setting ever fails to save (permission or subscription hiccup), you now get a clear error instead of a silent "saved" toast — so what you see is always what's actually running.

Try it and let me know! Feedback and bug reports through Report a Bug or Discord are always welcome. 🚀🔔

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