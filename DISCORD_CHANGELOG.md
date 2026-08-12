📸 **FGF Guild Management Tool — Gemini OCR AI Roster Import Update v87** 📸

We are super excited to launch the **AI-Powered OCR Gemini Roster Importer**! Updating member power and adding new players to your guild roster is now **100x faster**: simply take a screenshot of your in-game leaderboard or alliance list, and let Gemini AI do the rest!

---

🔍 **Gemini 2.5 Flash OCR Scanner**
• **One-Click OCR Import**: New **"Scan OCR"** button directly inside the **Add a member** section of the **Members** tab.
• **Drag & Drop Screenshots**: Upload single or multiple game screenshots (PNG, JPG, WEBP).
• **Structured AI Extraction**: Gemini 2.5 Flash extracts player usernames and converts power levels (e.g. `145.2M` ➔ `145,200,000`) with high precision.
• **100% English Localization**: Fully standardized UI titles, dropzone hints, review tables, and status tags (`New Player`, `Update`, `Unchanged`).

📋 **Interactive Verification & Review Grid**
• **Smart Match Detection**: Automatic status tagging compared against your existing guild roster.
• **Human-in-the-Loop Validation**: Select/deselect players or correct usernames before committing changes.

⚡ **High-Speed Bulk Database Sync**
• **Postgres Bulk Upsert RPC**: `gm_bulk_upsert_members` handles multi-row updates in a single database transaction.
• **Multi-Tenant Security**: Full RLS tenant isolation and active subscription write-gating.

---

🚀 **Ultimate Release Features (v85-v87)**
⚔️ **SvS & GvG Matchup & Dangerosity Engine**: 60 FPS Web Worker calculations & Discord sharing.
🏰 **Shadowfront Squad Builder**: Smart Squad 1 & Squad 2 roster composition with duplicate checking.
📊 **Player Portal & Canvas Charts**: High-DPI 2D power growth charts and personal KPI tracking.
📱 **PWA & Offline Support**: Mobile home screen shortcuts & offline status monitoring.
💳 **12-Month Subscriptions**: Best value plan with 37% total savings.

⚡ **Quality & Reliability**: Passed type-check with 0 errors and 200/200 green Vitest tests!
