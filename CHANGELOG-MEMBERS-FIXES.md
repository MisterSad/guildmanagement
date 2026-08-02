:wrench: **UPDATE — THANKS FOR YOUR REPORTS**

Several of you reported errors over the last few days. We investigated every single one, found the root causes, and fixed them. Here is what happened and what changed. :pray:

---

:one: **"Invalid guild join code" when creating an account**

:mag: **The cause:** the join code is stored as a secure fingerprint (hash) to keep it private. The check was case-sensitive, so typing the code in lowercase (or letting your phone autocorrect it) produced a different fingerprint and the code was rejected.

:white_check_mark: **The fix:** join codes now work in **uppercase or lowercase** — it does not matter anymore. If you still see this error, ask your guild admin to check the current code in the Accounts tab.

---

:two: **Being signed out when refreshing the portal**

:mag: **The cause:** the session was not being restored properly when the page reloaded, so the portal sent you back to the login screen.

:white_check_mark: **The fix:** the session now survives page refreshes. You stay in the Player Portal when you reload or come back later.

---

:three: **Security hardening — this is the big one**

:mag: **The cause:** we found that player accounts could, under certain conditions, reach interfaces and data that are reserved for guild officers (member lists, scores, sanctions, Discord settings). This was a security flaw, not a feature.

:white_check_mark: **The fix:**
- Player accounts can now only access the **Player Portal**. Nothing else.
- All guild data (members, scores, sanctions, Discord webhooks, configurations) is strictly **off-limits** for player accounts at the database level.
- Guild officers of every guild were affected by an unrelated bug that made their guild appear "read-only" — that is fixed too; officers see and manage their own guild again.

:lock: **Bottom line:** your personal data is yours. Officers only see what they need to run the guild.

---

:four: **What you can do in the portal now**

- :trophy: Submit your scores for active events (SvS, GvG, DTR, Shadowfront)
- :muscle: Update your combat power
- :calendar: Declare periods of **absence or reduced activity** — officers can see it and plan around it
- :clock3: Set your **UTC timezone** so events can be scheduled when most players are available
- :arrows_counterclockwise: Request a guild transfer to another guild on the same server
- :chart_with_upwards_trend: Follow your **score evolution** with charts, per event type

---

If you still see an error after this update, please include the **exact message** shown on screen. It helps us fix it in one go. :heart:

_FGF Guild Management Tool_
