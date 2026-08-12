📸 **FGF Guild Management Tool — Member & Power OCR Import Update v88** 📸

We have updated the OCR Import tool with a **clean, white-label design** specifically dedicated to roster member creation and power updates!

---

🔍 **Dedicated Roster & Power OCR Scanner**
• **Dedicated Action Button**: Button in **Add a member** renamed to **"Import Members (OCR)"**.
• **Clear Purpose Modal**: Header updated to **"Import Members & Power (OCR)"** with explicit subtitle: *"Upload roster screenshots to import new members and update power levels"*.
• **White-Label Clean UI**: All provider brand names ("Gemini") removed from buttons, modals, spinners, and toast notifications.
• **Future Modular OCR Expansion**: Structured for seamless addition of dedicated OCR tools in future event & stats sections.

📋 **Interactive Verification & Review Grid**
• **Smart Match Detection**: Automatic status tagging (`New Player`, `Update`, `Unchanged`) compared against your existing roster.
• **Human-in-the-Loop Validation**: Select/deselect players or correct usernames before committing changes.

⚡ **High-Speed Bulk Database Sync**
• **Postgres Bulk Upsert RPC**: `gm_bulk_upsert_members` handles multi-row updates in a single database transaction.
• **Multi-Tenant Security**: Full RLS tenant isolation and active subscription write-gating.

---

⚡ **Quality & Reliability**: Passed type-check with 0 errors and 200/200 green Vitest tests!
