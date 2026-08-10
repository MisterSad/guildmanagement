:bug: **FIXED PL/PGSQL AMBIGUOUS COLUMN ERROR ON DRAFT PAGE — v29**

Fixed the database error `column reference "guild" is ambiguous` when opening the **Draft** page.

---

:new: **What's new**

- :wrench: **Disambiguated SQL Column Names:** Migration `20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql` uses explicit `guild_id` column aliases across all intermediate CTEs in `gm_cross_guild_ranking()`.
- :rocket: **Seamless Draft Load:** The Draft Mercato dashboard now loads instantly without PL/pgSQL SQL variable collision errors.

---

:heart: _FGF Guild Management Tool_
