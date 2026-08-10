:trophy: **DRAFT MERCATO & SERVER TRANSFER DASHBOARD OVERHAUL — v26**

Completely redesigned the **Draft** page into a dedicated Mercato dashboard to support inter-server recruitment and guild transfer decisions.

---

:new: **What's new**

- :bar_chart: **Participation Rate Ranking:** Displays players ranked by participation in key events (**SvS**, **GvG**, **Shadowfront**, and **Overall**). Glory column has been removed.
- :globe_with_meridians: **Server Number & Guild Display:** Displays each player's **Server Number** (`#1058`, `#1064`, `#0000`, etc.) and **Guild** tag.
- :filter: **Dual Filter Controls:** Filter players by **Server** dropdown and **Guild** dropdown, plus live search by player name, guild, or server.
- :sort: **Full Sorting Support:** Click headers to sort by Member, Server, Guild, Power, SvS, GvG, Shadowfront, or Overall participation rate.
- :database: **Updated SQL RPC `gm_cross_guild_ranking`:** Migration `20260810120000_draft_cross_guild_ranking_server.sql` updated to return `server_number` directly from `public.guilds`.

---

:heart: _FGF Guild Management Tool_
