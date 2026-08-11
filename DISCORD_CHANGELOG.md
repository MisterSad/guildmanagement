:shield: **FULL CODEBASE AUDIT & HARDENING PASS — v59**

Completed a comprehensive 5-domain audit and applied all identified fixes.

---

:wrench: **Fixed**

- :lock: **P0 Security: `guild_config` dual SELECT policy** - Replaced the `FOR ALL` policy that was doubling as a second SELECT policy (dangerous OR combination) with separate INSERT/UPDATE/DELETE policies. One permissive SELECT policy per table as required.
- :key: **SECURITY DEFINER `search_path` standardized** - Fixed `is_subscription_active`, `list_event_sessions`, `list_event_weeks`, and `is_super_admin` to use `SET search_path TO ''` with fully qualified table names and JWT `sub` fallback.
- :pencil: **Em-dashes removed from UI text** - Replaced all em-dashes with hyphens in user-visible strings across 15 JS files (toasts, labels, placeholders, help text).
- :shield: **`esc()` defense-in-depth** - Added HTML escaping to guild name `<option>` elements in `app.js` and `shell.js`.
- :sparkles: **`dev` script added** - `npm run dev` now starts a local dev server.

---

:heart: _FGF Guild Management Tool_
