:sparkles: **ARMS RACE PER-SESSION SCORING — v14**

Each Arms Race Stage now counts as its own event, so two Arms Race cycles in one week are no longer merged.

---

:new: **What's new**

- :crossed_swords: **Arms Race Stage A and Stage B are separate events.** Each session (ARA-x / ARB-x) counts once in participation, like DTR. A week with 2 x A + 2 x B now counts 4 events instead of 1. Applied in sync to the client scoring key, the SQL `gm_event_scoring_key` and the Player Portal.

---

:bug: **What's fixed**

- :arrows_counterclockwise: **Two Arms Race in a week were merged.** CLAW ran Arms Race on Aug 5 and Aug 8, but the scoring key grouped them by week, shrinking the participation denominator (5 instead of 8) and inflating rates. Now each Stage counts separately.
- :calendar: **Future-planned events** no longer leak into current stats (previous round).
- :bar_chart: **Stats 1000-row truncation** fixed via `gm_stats_data` (previous round).

---

:heart: _FGF Guild Management Tool_
