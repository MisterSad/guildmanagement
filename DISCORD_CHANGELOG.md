:sparkles: **PAYMENTS SWITCH + PUBLIC DEMO ACCOUNTS — v8**

A per-guild payments switch and ready-to-share DEMO accounts, plus the Scouting removal from the last round.

---

:new: **What's new**

- :credit_card: **Per-guild payments switch.** Any guild can now disable its self-service subscription flow via the `payments_disabled` flag. The Subscription tab disappears from the sidebar, the page shows a "Payments are disabled" notice, and the order-creation edge function refuses checkout sessions.
- :robot: **Public DEMO accounts for previews.** `DemoAdmin` (guild admin) and `DemoPlayer` (Player Portal, linked to member KiraIX) let readers of a web article try the tool. Both use the easy password `demo1234`. Payments are off on DEMO so no real purchase is possible.

---

:bug: **What's fixed**

- :lock: **No real checkout from the public DEMO tenant.** Before, a DEMO admin could reach the Subscription tab and start a Stripe purchase. Now the nav entry, the plan tiles and the backend order creation are all gated by `payments_disabled`, so preview visitors can never trigger a payment.
- :wastebasket: **Scouting removed** (from the previous round): tab, module and backend objects dropped for every tenant.

---

:heart: _FGF Guild Management Tool_
