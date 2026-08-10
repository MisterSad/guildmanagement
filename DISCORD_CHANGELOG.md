:rocket: **FIXED PORTAL QUERY ERROR `JSON object requested, multiple (or no) rows returned` — v24**

Resolved the database query issue causing `JSON object requested, multiple (or no) rows returned` when players attempt to log into their Player Portal.

---

:new: **What's new**

- :shield: **Resilient Edge Function Queries:** Replaced `.maybeSingle()` with `.limit(1)` + safe array indexing across the `member-portal` Edge Function, eliminating PostgREST `PGRST116` errors if duplicate member rows or transferred profiles exist.
- :cloud: **Redeployed `member-portal` Edge Function:** Deployed the updated Edge Function code to Supabase (`supabase functions deploy member-portal --no-verify-jwt`).

---

:bug: **What's fixed**

- :bug: **`JSON object requested, multiple (or no) rows returned` Error:** Fixed query failures during identity/profile resolution when fetching player info or active sessions.
- :wrench: **Frontend `.single()` Safety:** Converted `.single()` calls in `events.js`, `armsrace.js`, and `shadowfront.js` to `.maybeSingle()` to prevent errors when querying event start times.

---

:heart: _FGF Guild Management Tool_
