📢 **FGF Guild Management Tool Update — CHANG_V125.3**

Hey everyone! Today has been a massive milestone for the platform. I've rolled out our biggest roster management overhaul yet, deployed comprehensive security hardening to keep your guild accounts and data safe, and quickly resolved two morning glitches. Here is everything new for you and your guild:

📸 **OCR Roster Overhaul (Three-Section Review)**
- **Clear Roster Breakdown**: When updating your roster via screenshot, the review screen is now neatly divided into three sections: **Existing Members**, **New Members**, and **Removed Members**.
- **Real UID Input for Recruits**: You can now enter the actual in-game UID for new recruits right inside the review modal — no more auto-generated temporary IDs!
- **Smart Removal Detection & Overrides**: Members who left or weren't detected in your full roster screenshot are proposed for removal by default, with an instant one-click toggle to keep them if needed.
- **Live Roster Counters**: A real-time counter chip (`Roster: 60 → 63`) shows your exact before-and-after headcounts as you review.
- **Safety First**: Before any member is removed, a confirmation screen clearly lists every affected name so accidental removals are impossible.

🚀 **One-Click Roster Import for New Guilds**
- Setting up a fresh guild? The Members tab now features a prominent **"Roster OCR"** button so you can import your entire 60-member lineup from screenshots in seconds.

🛠️ **Morning Glitches Resolved**
- A configuration oversight in this morning's deployment briefly blocked browser communication for some users (causing loading errors on sign-in and the Player Portal). I identified the root cause and patched it across all platform services within the hour. Everything is now running smoothly. My apologies for the brief inconvenience!

🔒 **Stronger Account Protection**
- **Modern Password Hashing**: All accounts now use industry-standard one-way cryptographic hashing (your password automatically upgrades seamlessly on your next sign-in).
- **Anti-Brute-Force & Account Lockout**: Repeated incorrect password attempts now trigger an automatic temporary lockout to protect your account against guessing attacks.
- **Rate-Limiting Shields**: Strengthened protection against automated spam and unauthorized sign-in attempts.

📊 **Player Portal KPI Fix**
- Fixed an issue where individual player KPIs (attendance rate, overall power, and activity metrics) were occasionally failing to load on the Member Portal. Everything is fast and accurate once again!

💳 **Subscription Stability**
- Hardened the billing and subscription state handlers so paying guilds maintain uninterrupted access to all premium tactical tools and member capacities.

---
*Thank you all for the fantastic feedback and support! As always, if you spot anything or have suggestions, reach out directly. Fly safe out there!* ⚔️
