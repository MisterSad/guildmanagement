📢 **FGF Guild Management Tool Update — CHANG_V126.0**

Hey everyone! Today has been the biggest feature and reliability milestone yet for the FGF Guild Management Tool. I completely rebuilt the roster management workflow from the ground up, upgraded all metric scanners with smart safeguards, added stronger security protection for your accounts, and resolved two brief hiccups from earlier today. Here is everything you need to know:

📸 **Members OCR: Dedicated Roster Management**
- **Rebuilt Roster Workflow**: The new **Members OCR** button (now #1 in your OCR toolbar) is your dedicated scanner for guild membership. Use it to add new recruits, update member power, and track roster departures in one smooth step.
- **Real In-Game UID Entry**: You can now enter the actual in-game UID for every new recruit right inside the review window. No more auto-generated temporary IDs!
- **Three-Section Review Screen**: Your scanned roster is now neatly organized into three clear sections before anything is applied: **Existing Members**, **New Members**, and **Removed Members**.
- **One-Click Keep & Remove Overrides**: Departed members are automatically suggested for removal with an instant toggle to keep anyone who was simply missing from the screenshot.
- **Live Headcount Counters**: A real-time counter chip (`Roster: 60 → 63`) shows your exact roster numbers as you make changes.
- **Mistake-Proof Removal Warning**: Before any member is removed, a review modal lists every affected name so unintended departures are impossible.

🚀 **One-Click Cold Start for New Guilds**
- **Fast Guild Onboarding**: Starting a brand-new guild? Empty rosters now display a prominent **Members OCR** button to let you import your entire 60-member lineup from screenshots in seconds.
- **Instant Setup**: No manual typing required: drop your screenshots, check the player names and UIDs, and populate your entire guild directory at once.

📊 **Smarter Update-Only Metric Scanners**
- **Update-Only Combat Scanners**: The other 7 scanners (Power, Fleet, Tech, Flagship, Champs, Crew, Glory) are now strictly update-only. They only update stats for existing members and will never mistakenly create recruits or remove absent players.
- **"Not in Roster" Safety Section**: If an unassigned player appears in a metric screenshot, they are highlighted in a disabled **"Not in Roster"** section with a badge reminding you to add them via Members OCR first.
- **Clear Summary Feedback**: Applying a metric scan gives you an instant summary showing exactly how many members updated and how many unmatched players were skipped.

🛠️ **Reliability & Safeguards**
- **Sign-In Hiccup Patched**: A one-character bug briefly disrupted sign-in for some members early this morning. I diagnosed and resolved it right away.
- **Browser Loading Error Resolved**: A configuration oversight briefly caused loading errors when opening the application in web browsers around midday. I identified the root cause and deployed a fix across all services within the hour.
- **Automated Safeguards**: I added automated checks across my release process so neither glitch can ever happen again. Thank you for your patience while I resolved them!

🔒 **Stronger Account Protection**
- **Modern Password Hashing**: All accounts now use modern cryptographic hashing that upgrades automatically and invisibly on your next sign-in.
- **Anti-Brute-Force Lockout**: Repeated failed sign-in attempts now trigger an automatic temporary lockout to protect your account against guessing attempts.
- **Spam & Abuse Shields**: Added robust rate limits to protect all guild accounts and member portals against unauthorized automated traffic.

📊 **Player Portal Fixes**
- **Reliable Personal KPIs**: Fixed an issue where individual player attendance rates, event turnout scores, and power trends were intermittently failing to load on the Member Portal.
- **Fast and Accurate**: All personal metrics and historical activity charts now load consistently and instantly.

💳 **Subscription Stability**
- **Uninterrupted Guild Access**: Hardened the billing and subscription status handlers so premium guilds maintain smooth, uninterrupted access to all guild tools and roster limits after checkout.

---
*Thank you all for the fantastic feedback, patience, and support as I continue improving the platform! As always, feel free to reach out with any questions or ideas. Fly safe!* ⚔️

