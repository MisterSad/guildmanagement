📢 **FGF Guild Management Tool Update — CHANG_V3.8**

Hey everyone! This one's a big reliability pass. I spent the last stretch digging into payments, event tracking, player transfers, and security, and fixed a bunch of things that were quietly broken under the hood. Here's what changed for you: 🛠️🔒⚔️

### 💳 Donations Are Working Again
- Fixed the **"Could not start the donation checkout"** error — the Buy Me a Coffee button works properly now.

### 📸 Event OCR: Your Screenshots Actually Save Now
- Fixed a bug where approving OCR-scanned screenshots for **Shadowfront, Arms Race, DTR, SvS, or GvG** could silently fail to add new participants to the event — most noticeable when uploading a roster *before* an event had started. Approved data now reliably shows up where it should.

### 🔄 Player Transfers: Fixed & Smoother
- The **Transfer Member** button could fail with an "Access denied" error for guild and server admins, even though it looked like the transfer had gone through. Fixed — transfers between guilds now work correctly and automatically carry over the player's full event history.
- The admin approval screen for transfer requests now shows a cleaner confirmation popup and clear, human error messages instead of raw error text.

### 👥 Smarter Member Imports
- When bulk-importing members via OCR, a player whose ID already belongs to another guild is now clearly flagged instead of blocking your *entire* import batch — everyone else still goes through normally.
- Player ID (UID) validation is now consistent everywhere in the app.

### ⚔️ Shadowfront Fix
- Fixed a crash when removing a participant from the Shadowfront tracking view.

### 📊 Leaderboard Respects Your Guild Settings
- If you've customized event weighting (SvS / GvG / Shadowfront / DTR / Arms Race coefficients) in Guild Settings, those settings now actually apply to the Global Leaderboard score — previously DTR and Arms Race quietly ignored your configuration and used the wrong default weight.

### 🔒 Security
- Strengthened the security of Leader Hall's private messaging and the OCR import pipeline.

*Thanks for your patience through all this under-the-hood work — the app should feel noticeably more solid now. As always, report anything weird via the Report a Bug button!* 🚀🛡️
