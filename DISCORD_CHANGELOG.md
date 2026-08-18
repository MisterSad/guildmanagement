📢 **FGF Guild Management Tool Update — CHANG_V3.28**

Hey commanders! 👋

I have just deployed an update and fix for the **DEMO tenant** and its accounts! 🚀🔒

---

### 🔑 1. DemoPlayer Account Authentication & Portal Access
* **Demo Credentials Synchronized**: Both `DemoAdmin` and `DemoPlayer` accounts now have their demo password `demo1234` properly encrypted and provisioned into the database.
* **Instant Player Portal Access**: `DemoPlayer` is now linked directly to member commander **Valkyrie** (UID `90000002`), enabling immediate access to the **Player Portal** (`/portal` or Player login) to view personal military metrics, attendance records, Glory scores, and submit battle performances.
* **Automated Daily Reset Preserved**: The daily database cron job restores both `DemoAdmin` and `DemoPlayer` credentials and member linkages every night at 03:00 UTC.

---

### 🛡️ 2. Database RPC & Security Hardening
* Master migration definitions for `gm_check_login`, `gm_admin_upsert`, and `gm_reset_account_password` have been fully aligned with production cryptographic standards.

---

### 🧪 3. Quality & Verification
* **275/275 Automated Unit Tests Passing** 🟢
* Static TypeScript verification clean (`tsc --noEmit`) ⚡
* Production build validated.

*You can now test the platform freely as both a Guild Officer (`DemoAdmin` / `demo1234`) and a Guild Member (`DemoPlayer` / `demo1234`)!* ⚔️✨
