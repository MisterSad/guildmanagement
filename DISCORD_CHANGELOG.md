:rocket: **SHADOWFRONT CROSS-SQUAD MEMBER POOL EXCLUSION — v20**

Assigning a player to any Shadowfront Squad (Squad One or Squad Two) now automatically hides them from the available member pool of both squads, preventing double bookings.

---

:new: **What's new**

- :ghost: **Cross-Squad Member Pool Exclusion:** When a member is assigned to Squad One (or Squad Two), they are automatically filtered out from the available member pool for the other squad. Unassigning them instantly restores them to the available pool for both squads.
- :sparkles: **Streamlined 2-Step Shadowfront Workflow:** Removed the redundant "Availability" step. Admins now directly compose squads from the complete member pool into Main Participants or Substitutes/Reserves (Step 1), followed by live Participation Tracking (Step 2).
- :chart_with_upwards_trend: **Unified Participation Rate Badges:** Historical participation rates (`100%`, `85%`, `50%`, `N/A`) are rendered right in front of member names across all Shadowfront views (Member Pool, Main Participants, Substitutes/Reserves, and Tracking table).
- :inbox_tray: **Pending Account Validations in Overview:** Player Portal registration requests appear directly on the Overview dashboard (`#pending-accounts-card`) for instant officer approval.
- :busts_in_silhouette: **Account Role Separation:** Split Accounts & Access into "Active Admin Accounts" and "Player Portal Member Accounts" (clearly tagged with a lilac `Member` chip).
- :key: **On-Demand Password Renewal:** Replaced static password reveal buttons with a secure one-click **Renew Password** action (`ph-arrows-clockwise`).

---

:bug: **What's fixed**

- :shield: **Pre-Launch Squad Exclusion Fix:** Updated `loadShadowfront()` to load assignment data across all current session IDs (`currentSids`), ensuring assigned members are properly hidden from the unassigned pool even when preparing squads before clicking "Start Event".
- :no_entry_sign: **Double-Entry Removal in Shadowfront:** Eliminated double entry by removing the Availability step so squad assignments happen directly from the member pool.
- :bell: **Web Push Notifications Setup Fixes:** Fixed notification registration errors by adding a unique index on `push_subscriptions(endpoint)` and updating `save_push_subscription` RPC.
- :art: **Phosphor Icons Webfont CSP Fix:** Updated CSP in `index.html` to allow `cdn.jsdelivr.net` & `unpkg.com` fonts.
- :trophy: **Glory Participation Count Fix:** Fixed Glory history tiles counting players with `score > 0` as participants (`gm_list_event_sessions` RPC `20260810085000`).

---

:heart: _FGF Guild Management Tool_
