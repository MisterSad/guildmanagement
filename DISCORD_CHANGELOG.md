📢 **FGF Guild Management Tool Update — v91**

✨ **New Features & Improvements:**
- 🧠 **Intelligent Name Reconciliation (Fuzzy Matching)**: Automatically reconciles OCR-extracted pseudos with existing database members, even if there are typos, l33tspeak, spaces, or guild tags (e.g. `R4WKET` &rarr; `RAWKET`).
- 🏷️ **Gold Reconciled Badges**: Reconciled players are clearly highlighted in gold in the preview table with their matched DB username.
- 🚫 **Prevents Duplicate Ghost Players**: Guarantees that power updates target existing players in the database rather than creating duplicate accounts.
- 📦 **Multimodal OCR Batching**: Groups 4 screenshots per request for ultra-fast scanning of 200+ players with automatic HTTP 429 rate limit retries.

🛠️ **System Integrity:**
- 🛡️ Verified multi-tenant scoping and 100% test battery pass (200/200 tests green).
