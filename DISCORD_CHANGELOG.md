:sparkles: **RLS SECURITY DEFINER HARDENING — v69**

---

:wrench: **Fixed**

- :shield: **RLS Policy Standardized** - Purged inline `auth.jwt()` queries on `accounts` and `guilds` tables in favor of `SECURITY DEFINER` helpers (`gm_can_read_account`, `gm_can_read_guilds`, `is_super_admin`). Prevents PostgREST permission errors when reading account/guild details after sign-in.

---

:heart: _FGF Guild Management Tool_
