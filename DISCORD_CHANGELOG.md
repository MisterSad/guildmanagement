📢 **FGF Guild Management Tool Update — CHANG_V3.29**

Hey commanders! 👋

Following community feedback on mobile usability, I have just released an overhaul of the **AI OCR Scanner** interface on mobile devices! 📱⚡🔍

---

### 📱 1. Mobile-First Card Layout (No More Truncated Names!)
* **Full-Width Player Usernames**: On smartphone screens, the OCR review table now automatically transforms into comfortable, touch-friendly cards. Player names get 100% of the available width, so you can clearly see full usernames and distinguished numbered accounts (e.g. `Trader99104` vs `Trader99205`) without having to tap into each field!
* **Two-Level Card Hierarchy**:
  * **Top**: Large username, selection checkbox, and instant roster status badge (New Player, Update, Reconciled).
  * **Bottom**: Metric score/power input with previous value comparison and dedicated icon.
* **Full-Screen Mobile Dialog**: The OCR modal now expands edge-to-edge on mobile with safe-area spacing and sticky action buttons for fast thumb navigation.

---

### 🔍 2. Instant Player Search Filter
* **Real-Time Name Search**: Added a quick search filter bar right above the results list. When scanning large batches of 150+ members, simply type a name (e.g. `Trader`) to instantly filter the list and review matching players in seconds.
* **Smart Multi-Select**: Selecting or deselecting all rows while a search filter is active only affects visible matching players.

---

### ⚔️ 3. Universal Across All 12 OCR Scanners
* This mobile improvement is active everywhere:
  * **Roster & Powers**: Overall Power, Fleet Rating, Tech Power, Flagship Power, Champions Power, Crew Power, Glory Score.
  * **Guild Wars & Events**: SvS Prep & PvP, GvG Prep & PvP, Shadowfront Squads 1 & 2, Defend Trade Route (DTR), and Arms Race Stages A & B.

---

### 🧪 4. Quality & Performance Gate
* **277/277 Automated Unit Tests Passing** 🟢
* Strict TypeScript verification clean (`tsc --noEmit`) ⚡
* Zero desktop regressions (standard 4-column data table preserved on desktop).

*Feel free to test the new mobile OCR scanning and let me know your thoughts!* 🚀🛡️

