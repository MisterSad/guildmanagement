:rocket: **ALL-IN-ONE SYSTEM FIXES, ACCOUNTS & UI OVERHAUL — v18**

Complete breakdown of today's fixes and feature upgrades: Edge functions, web push notifications, CSP font icons, Stats SvS/GvG score breakdown, Player Portal pending approvals in Overview, Account role separation, password renewal on demand, Event History timeline formatting, Glory participation fix, DEMO server number fix, and 100% English UI localization.

---

:new: **What's new**

- :inbox_tray: **Pending Account Validations in Overview:** Player Portal registration requests now appear directly on the Overview dashboard (`#pending-accounts-card`) for instant officer approval upon logging in.
- :busts_in_silhouette: **Account Role Separation & Member Tagging:** Split Accounts & Access into "Active Admin Accounts" and "Player Portal Member Accounts" (clearly tagged with a lilac `Member` chip).
- :key: **On-Demand Password Renewal:** Replaced static password reveal buttons with a secure one-click **Renew Password** action (`ph-arrows-clockwise`) that generates a random 12-char password, updates DB, copies to clipboard, and shows an English toast.
- :bar_chart: **Detailed SvS & GvG Score Breakdown in Stats:** Added Day 1-5 score, Day 6 score, and Total score columns to SvS and GvG tabs, while keeping the attendance column (`1/1`).
- :calendar: **Streamlined History Timeline:** Event History for weekly events (**SvS**, **GvG**, **Glory**) displays clean week numbers (`Week 32`) in the left column.

---

:bug: **What's fixed**

- :bell: **Web Push Notifications Setup Fixes:** Fixed notification registration errors (`updated_at` column, missing `ON CONFLICT` constraint, `p_ua` parameter) by adding a unique index on `push_subscriptions(endpoint)` and updating `save_push_subscription` RPC.
- :art: **Phosphor Icons Webfont CSP Fix:** Updated Content-Security-Policy (CSP) in `index.html` to allow `cdn.jsdelivr.net` & `unpkg.com` fonts, restoring event and menu icons.
- :trophy: **Glory Participation Count (`0/165 (0%)` fix):** Fixed a bug where Glory history tiles showed 0 participants despite non-zero total scores (5.8B Glory). `gm_list_event_sessions` RPC (`20260810085000`) and `history.js` now count any player with `score > 0` as a participant.
- :clock1: **Misleading `00:00 UTC` Event Times:** Unscheduled or older events in History no longer display artificial `00:00 UTC` times — timestamps (`19:30 UTC`) appear only when an admin explicitly scheduled a start time.
- :label: **DEMO Guild Server Number (`##0000` fix):** Fixed server number for DEMO tenant from `'#0000'` to `'0000'` in database (`20260810095000`) and sanitized `shell.js` sidebar formatting to prevent double `#` symbols.
- :chart_with_upwards_trend: **`Glory Δ` Column Scoping:** Restricted `Glory Δ` column strictly to Global mode in Stats, hiding it in event-specific views like SvS and GvG.
- :name_badge: **Inactive Members Card Truncation:** Redesigned inactive member cards in Stats > Engagement with larger containers and line wrapping to prevent player pseudos from truncating.
- :gear: **`admin-accounts` Edge Function Fix:** Fixed `ReferenceError: info is not defined` and network call failures in account management.
- :repeat: **Event History RPC Query & Order Fix:** Fixed event history loading issues ("No session for this filter") caused by invalid `GROUP BY` and unsafe timestamp casts in `gm_list_event_sessions` (`20260810040000` & `20260810070000`).
- :globe_with_meridians: **100% English UI & Localization Audit:** Localized all UI text, empty states, date formats (`en-GB`), and toast notifications to 100% English across all modules.

---

:heart: _FGF Guild Management Tool_
