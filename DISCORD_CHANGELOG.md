:sparkles: **STATS FIXED: 1000-ROW TRUNCATION — v12**

The Stats page was silently ignoring recent scores on any tenant with more than 1000 event rows (CLAW, BABE, OMEGA, DEMO, ALPHA). Now fixed.

---

:new: **What's new**

- :floppy_disk: **Stats load via a server RPC.** Members, participation, Glory and squads are fetched through `gm_stats_data` (SECURITY DEFINER) instead of raw REST reads, removing the silent 1000-row cap. Admins see their own guild only, super admin any guild, members nothing.

---

:bug: **What's fixed**

- :bar_chart: **Stats looked stuck after entering scores.** Supabase truncates `event_participants` at 1000 rows and the client had no ORDER BY, so only the oldest rows came back. Any tenant over 1000 rows lost recent events on the Stats page — exactly what CLAW reported. The full dataset now always loads.
- :electric_plug: **A failed Stats load froze the page.** `isLoading` only cleared on success; an error left it stuck, silently blocking every later reload. It now always clears.
- :trophy: **BABE Glory session ids** and :shield: **legacy populate RPC grants** (previous rounds) remain in place.

---

:heart: _FGF Guild Management Tool_
