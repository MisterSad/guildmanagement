:key: **FIXED SHADOW ACCOUNT SECRET SYNC & LOGINS — v48**

Resolved the issue where resetting an admin password caused GoTrue shadow user authentication to fail.

---

:new: **What's new**

- :wrench: **Shadow Secret Isolation:** `admin-accounts` now updates `password_enc` without corrupting the GoTrue shadow secret (`gotrue_secret_enc`).
- :hospital: **Automatic Self-Healing:** `auth-login` automatically detects and re-syncs GoTrue credentials on the fly if a shadow account secret ever diverged.
- :rocket: **Deployed & Live:** Redeployed `admin-accounts` and `auth-login` Edge Functions.

---

:heart: _FGF Guild Management Tool_
