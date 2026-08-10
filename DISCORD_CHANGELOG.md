:rocket: **SHADOWFRONT WORKFLOW OVERHAUL & SYSTEM IMPROVEMENTS — v19**

Streamlined Shadowfront Squad One & Squad Two management, eliminated double data entry, and updated participation rate badges across all member rosters.

---

:new: **What's new**

- :ghost: **Streamlined 2-Step Shadowfront Workflow:** Removed the redundant "Availability" step. Admins now directly compose squads from the complete member pool into Main Participants or Substitutes/Reserves (Step 1), followed by live Participation Tracking (Step 2).
- :chart_with_upwards_trend: **Unified Participation Rate Badges:** Historical participation rates (`100%`, `85%`, `50%`, `N/A`) are now rendered right in front of member names across all Shadowfront views (Member Pool, Main Participants, Substitutes/Reserves, and Tracking table).
- :inbox_tray: **Pending Account Validations in Overview:** Player Portal registration requests appear directly on the Overview dashboard (`#pending-accounts-card`) for instant officer approval.
- :busts_in_silhouette: **Account Role Separation:** Split Accounts & Access into "Active Admin Accounts" and "Player Portal Member Accounts" (clearly tagged with a lilac `Member` chip).
- :key: **On-Demand Password Renewal:** Replaced static password reveal buttons with a secure one-click **Renew Password** action (`ph-arrows-clockwise`).
- :bar_chart: **Detailed SvS & GvG Score Breakdown:** Added Day 1-5 score, Day 6 score, and Total score columns to SvS and GvG tabs in Stats.

---

:bug: **What's fixed**

- :no_entry_sign: **Double-Entry Removal in Shadowfront:** Eliminated double entry by removing the Availability step so squad assignments happen directly from the member pool.
- :bell: **Web Push Notifications Setup Fixes:** Fixed notification registration errors by adding a unique index on `push_subscriptions(endpoint)` and updating `save_push_subscription` RPC.
- :art: **Phosphor Icons Webfont CSP Fix:** Updated CSP in `index.html` to allow `cdn.jsdelivr.net` & `unpkg.com` fonts.
- :trophy: **Glory Participation Count Fix:** Fixed Glory history tiles counting players with `score > 0` as participants (`gm_list_event_sessions` RPC `20260810085000`).
- :clock1: **Misleading `00:00 UTC` Event Times:** Omitted default `00:00 UTC` timestamps for unscheduled events in History.
- :label: **DEMO Guild Server Number Fix:** Fixed DEMO tenant `server_number` from `'#0000'` to `'0000'` in database (`20260810095000`).

---

:heart: _FGF Guild Management Tool_
