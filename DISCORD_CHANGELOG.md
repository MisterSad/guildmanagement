📢 **FGF Guild Management Tool Update — CHANG_V3.18.4**

Welcome to V3.18.4! I have just deployed a massive overhaul of the **Video & Screenshot OCR Scanner**, making guild roster audits, event tracking, and member syncs faster, virtually error-free, and safer than ever before!

Here is everything I updated in this release:

---

### 🎥 1. Rock-Solid Video OCR (No More Skipped Members!)
- **What changed**: I completely rebuilt the video keyframe extraction pipeline from scratch. Instead of sampling blurry frames while the screen is scrolling, the engine now tracks motion gradients and pixel sharpness to capture clean frames during natural scroll pauses or steady movements. It also crops out the game's top header and bottom navigation bars, focusing 100% on the member list.
- **The benefit**: Say goodbye to skipped players! Even with fast or uneven scrolling, every single member is captured in crisp detail without motion blur or missing rows.

---

### 📸 2. Massive 60-Screenshot Batches & Zero Upload Errors
- **What changed**: I raised the screenshot upload limit from 25 to **60 captures per batch**! In addition, all images are now compressed in parallel directly inside your browser before upload (reducing heavy 4–10 MB phone screenshots to ~180 KB).
- **The benefit**: You can easily scan 300+ players in a single go without ever hitting browser crashes or HTTP 413 "payload too large" errors. Uploads are lightning fast thanks to concurrent chunking.

---

### 🧩 3. Smart Multi-Frame Player Fusion
- **What changed**: When players appear across overlapping frames or split across screenshot boundaries, the new fuzzy fusion engine matches and combines their entries using Levenshtein distance algorithms.
- **The benefit**: Zero duplicate rows, zero cut-off names, and the system automatically preserves their highest recorded combat power, score, and rank across all frames.

---

### 🛡️ 4. Zero-Trust Safety: Partial Scan Protection
- **What changed**: If you only scan a portion of your guild (for example, the top 20 members in a 60-person roster), the system detects a partial scan (< 75% coverage). Missing members are safely kept by default (`checked = false`), tagged with a `Kept (Partial Scan)` badge, and an amber alert banner advises you before committing.
- **The benefit**: Total peace of mind! You will never accidentally delete absent or unscanned members from your guild roster by mistake.

---

### 🤖 5. Gemini 2.5 Flash Precision Tuning
- **What changed**: I upgraded the backend AI prompt with strict top-to-bottom reading instructions, full support for special Unicode gaming symbols and emojis, and expanded the output token capacity to 8,192 tokens.
- **The benefit**: Zero truncated responses on long rosters and flawless parsing of complex gamer tags and zero-score members.

---

### 🏗️ 6. Automated Discord Server Bootstrap (`/setup-server`)
- **What it does**: Need to set up a brand new Discord server for your guild? With a single command, the bot completely formats and bootstraps a full, battle-ready command center in under 15 seconds!
- **100% Dynamic Customization**: Automatically sets up 4 custom roles (`👑 R5`, `⭐ R4`, `🛡️ Member`, `👽 Visitor`), 7 categories, and 31 pre-configured channels with strict zero-trust permission isolation.
- **SaaS Auto-Wiring**: Automatically links created channels (`#verification`, `#r4-chat`) into your FGF database settings.

---

### 📋 OCR & Bot Quick Reference

| Feature | Capacity / Access | Benefit |
| :--- | :--- | :--- |
| **Screenshot Batch OCR** | Up to 60 images (300+ players) | Instant client compression, no payload errors |
| **Video Scroll OCR** | MP4 / MOV (up to 35 sharp frames) | Zero motion blur, stillness peak detection |
| **Partial Scan Shield** | Automatic on < 75% coverage | Prevents accidental roster deletions |
| `/setup-server` | 👑 Server Admin | Instant Discord server setup in 15s |
| `/call-to-arms` | ⭐ Officers (R4/R5) | Live war attendance & mobilized fleet rating |
| `/top` | 👥 Everyone | Leaderboards (Power, Glory, Fleet) |
| `/profile` | 👥 Everyone | Displays combat stats, local time, and status |
| `/absent` & `/absences` | 🛡️ Members & ⭐ Officers | Declare and monitor absences in real-time |

---

Enjoy the rock-solid OCR scanning and server tools, and let me know if you have any feedback or ideas! 🚀⚔️🛡️