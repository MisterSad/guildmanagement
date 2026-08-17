📢 **FGF Guild Management Tool Update — CHANG_V3.25 (9 Dedicated Event AI OCR Scanners)**

Hey commanders! 👋

I'm excited to roll out a major automation upgrade to the **Events Command Center**: **9 dedicated AI OCR scanners** powered by Gemini Vision! 🚀⚡

You can now upload in-game event screenshots directly from each event's dedicated sub-tab, automatically extract scores, and let the system handle participation and role toggles for you! 📸🤖

---

### ⚔️ 1. SvS & GvG OCR Scanners (Day 1 to 5 & Day 6)
* **SvS Day 1 to 5 OCR & GvG Day 1 to 5 OCR**: Analyzes multi-guild server leaderboards, strictly targets players matching your guild tag, imports their **Preparation Stage scores**, and automatically validates the **`Participated`** toggle!
* **SvS Day 6 OCR & GvG Day 6 OCR**: Extracts **PvP battle scores** for your guild members from battle leaderboards and validates the **`Participated`** toggle.

---

### 🛡️ 2. Shadowfront Squad 1 & Squad 2 OCR
* **Shadowfront S1 OCR & Shadowfront S2 OCR**: Scans squad battle results and compares detected player usernames with your squad assignments:
  * **Main Squad Members** &rarr; Automatically sets **`PARTICIPATED`** (`✓`).
  * **Substitute (Reserve) Members** &rarr; Automatically sets **`SUB PRESENT`** (`✓`) **AND** **`PARTICIPATED`** (`✓`).

---

### 🚛 3. Defend Trade Route (DTR) OCR
* **DTR OCR**: Scans convoy defense leaderboards and scores:
  * **Score > 0** &rarr; Validates **`PARTICIPATED`** (`✓`).
  * **Score == 0** (registered without points) &rarr; Automatically validates both **`APPOINTED`** (`✓`) and **`PARTICIPATED`** (`✓`).

---

### ⚡ 4. Arms Race Stage A & Stage B OCR
* **Arms Race SA OCR & Arms Race SB OCR**: Extracts all participating members from stage battle screenshots and validates their **`PARTICIPATED`** status in one click.

---

### 🔒 5. Zero-Trust Security & Seamless Live Sync
* Built with the exact same Gemini API key and zero-trust Edge Function pipeline.
* Instant live refresh of participant tables, chips, and stats as soon as you commit.

*Head over to the Events tab in your Command Center and try out the new AI OCR buttons on your next battle session!* 🎮🛡️





