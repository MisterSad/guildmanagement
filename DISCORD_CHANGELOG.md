:sparkles: **STATS: FUTURE WEEKS EXCLUDED — v13**

Stats now count an event only for the week it actually takes place. A session planned for next week (even if launched this week) no longer leaks into the current stats.

---

:new: **What's new**

- :calendar: **Events count in their own week only.** Sessions dated for a later week (e.g. an Arms Race started now but planned for next Monday) are excluded from every stats mode until that week arrives: global, SvS/GvG, participation and Engagement. The week picker no longer shows future weeks as "current".

---

:bug: **What's fixed**

- :ghost: **Planned events inflated current stats.** With members pre-populated, a future-dated event was counted in the participation denominator and showed an empty "recent" week in Engagement. All modes now ignore weeks strictly after the current Monday.
- :bar_chart: **Stats 1000-row truncation** (from the previous round): the full dataset now loads via `gm_stats_data`, so recent scores always show.
- :electric_plug: **Stats freeze after a failed load** (previous round) stays fixed.

---

:heart: _FGF Guild Management Tool_
