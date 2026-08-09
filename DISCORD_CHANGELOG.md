:sparkles: **UI, ACCOUNTS & EVENT HISTORY IMPROVEMENTS — v17**

Comprehensive update focusing on Overview account validation requests, Accounts & Access separation, password renewal on demand, Stats SvS/GvG score breakdown, Event History timeline formatting, and Glory participation calculation.

---

:new: **What's new**

- :inbox_tray: **Pending Account Validation Requests on Overview:** Player account approval requests registered via the Player Portal now appear directly on the Overview dashboard for instant officer action.
- :busts_in_silhouette: **Account Role Separation:** Split Accounts & Access into "Active Admin Accounts" and "Player Portal Member Accounts" (clearly tagged with a lilac `Member` chip).
- :key: **On-Demand Password Renewal:** Replaced static password reveal buttons with a secure one-click **Renew Password** action (`ph-arrows-clockwise`) that generates a 12-character random password, copies it to clipboard, and updates DB.
- :bar_chart: **SvS & GvG Detailed Scores in Stats:** Added Day 1-5 score, Day 6 score, and Total score columns to SvS and GvG tabs, while keeping the attendance column (`1/1`).
- :calendar: **Streamlined History Timeline:** Event History for weekly events (**SvS**, **GvG**, **Glory**) displays clean week numbers (`Week 32`) in the left column.

---

:bug: **What's fixed**

- :trophy: **Glory Participation Count (`0/165 (0%)` fix):** Fixed a bug where Glory history tiles showed 0 participants despite non-zero total scores. `gm_list_event_sessions` RPC and `history.js` now count any player with `score > 0` as a participant.
- :clock1: **Misleading `00:00 UTC` Event Times:** Unscheduled or older events in History no longer display artificial `00:00 UTC` times — timestamps (`19:30 UTC`) appear only when an admin explicitly scheduled a start time.
- :label: **DEMO Guild Server Number (`##0000` fix):** Fixed server number for DEMO tenant from `'#0000'` to `'0000'` in database and sanitized `shell.js` sidebar formatting to prevent double `#` symbols.
- :name_badge: **Inactive Members Text Truncation:** Redesigned inactive member cards in Stats > Engagement with larger containers and line wrapping to prevent player pseudos from truncating.
- :chart_with_upwards_trend: **`Glory Δ` Column Scoping:** Restricted `Glory Δ` column strictly to Global mode in Stats, hiding it in event-specific views like SvS and GvG.
- :globe_with_meridians: **100% English UI & Localization Audit:** Localized all UI text, empty states, date formats (`en-GB`), and toast notifications to 100% English across all modules.

---

:heart: _FGF Guild Management Tool_
