:rocket: **SHADOWFRONT HISTORICAL PARTICIPATION RATE FIX — v21**

Resolved an issue across all tenants where player participation rate percentages in the Shadowfront member pool did not update after completed events.

---

:new: **What's new**

- :chart_with_upwards_trend: **Shadowfront Historical Participation Rate Calculation:** Past ended Shadowfront sessions are now properly aggregated into each player's participation history across all tenants (CLAW, ALPHA, OMEGA, BABE, IMK, YARR, DEMO), so participation % badges (`100%`, `85%`, `50%`) reflect all completed events.
- :ghost: **Cross-Squad Member Pool Exclusion:** When a member is assigned to Squad One (or Squad Two), they are automatically filtered out from the available member pool for the other squad. Unassigning them instantly restores them to the available pool for both squads.
- :sparkles: **Streamlined 2-Step Shadowfront Workflow:** Removed the redundant "Availability" step. Admins now directly compose squads from the complete member pool into Main Participants or Substitutes/Reserves (Step 1), followed by live Participation Tracking (Step 2).
- :inbox_tray: **Pending Account Validations in Overview:** Player Portal registration requests appear directly on the Overview dashboard (`#pending-accounts-card`) for instant officer approval.
- :busts_in_silhouette: **Account Role Separation:** Split Accounts & Access into "Active Admin Accounts" and "Player Portal Member Accounts" (clearly tagged with a lilac `Member` chip).
- :key: **On-Demand Password Renewal:** Replaced static password reveal buttons with a secure one-click **Renew Password** action (`ph-arrows-clockwise`).

---

:bug: **What's fixed**

- :bug: **Shadowfront Participation Rate Freeze:** Fixed `loadShadowfront()` history calculation by using `activeSids` (currently active sessions only) to exclude live sessions while incorporating all past ended sessions from both `shadowfront_squads` and `event_participants`.
- :shield: **Pre-Launch Squad Exclusion Fix:** Loaded assignment data across all current session IDs (`currentSids`), ensuring assigned members are properly hidden from the unassigned pool even when preparing squads before clicking "Start Event".
- :no_entry_sign: **Double-Entry Removal in Shadowfront:** Eliminated double entry by removing the Availability step so squad assignments happen directly from the member pool.
- :bell: **Web Push Notifications Setup Fixes:** Fixed notification registration errors by adding a unique index on `push_subscriptions(endpoint)` and updating `save_push_subscription` RPC.
- :art: **Phosphor Icons Webfont CSP Fix:** Updated CSP in `index.html` to allow `cdn.jsdelivr.net` & `unpkg.com` fonts.

---

:heart: _FGF Guild Management Tool_
