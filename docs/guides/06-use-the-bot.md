# ⚡ Guide 6: Get the most out of the bot

Type `/` in Discord to see all the commands. Most answers are **private**: only you can see them.

## 🔗 First: link your account (players, one time)

1. Type `/link`. The bot gives you a code (valid 10 minutes).
2. In the tool: **Player Portal** → **My Info** → **Link Discord** → paste the code → **Confirm**.

Without this, the player commands answer "*Run `/link` first*".

---8<---

## 🎮 Player commands

- `/myinfo`: your power, glory, role and timezone
- `/update-stats power:150000000 glory:4200`: update your power and/or your glory, without opening the tool
- `/mystats`: your attendance per event, compared with your guild. Add `weeks:8` to look further back.
- `/challenges`: your weekly challenges
- `/timezone offset:9.5`: your time zone in hours (examples: `-5`, `0`, `8`, `9.5`)
- `/absent start_date:2026-10-05 end_date:2026-10-12 reason:holidays`: declare an absence. Your officers are told right away.
- `/absence list`: see your absences. `/absence cancel id:…` cancels one.

-# Numbers only, no spaces or dots: `150000000`, not `150.000.000`.
-# Dates are written `YEAR-MONTH-DAY`.

---8<---

## 👀 Commands for everyone (public answers)

- `/top category:Glory Score`: the guild's top 10 (also *Overall Power* or *Fleet Rating*)
- `/absences`: who is away, picked from the list: *Today (Currently Active)* or *Upcoming (Next 7 Days)*
- `/profile user:@Someone`: a player's card (or `ingame_name:Name`)
- `/call-to-arms event_name:SvS Saturday description:Everyone on portal at 14:00`: a rally post with **Present / Late / Absent** buttons and the total power that is ready

-# 💡 Use `/call-to-arms` 1 hour before a big fight: you see at a glance who is coming.

---8<---

## 🛡️ Officer commands

- `/verifications`: players the bot put on hold (`[PENDING]`) in the last 7 days. Add them in **Members**, then ask them to post their screenshot again.
- `/reconcile-roles`: who still has your guild role but is **not** in your member list anymore (players who left). The bot shows the list first, and removes the role **only if you confirm**. It never kicks anyone.
  -# `/reconcile-roles` needs a special Discord setting. If it says so, ask the developer.

## 💡 Best practices

1. **Pin a message in your verification channel:** "Post a screenshot of your in-game profile here to get your role."
2. **Ask every player to `/link`**, so they update their stats themselves with `/update-stats`.
3. **Ask players to use `/absent`** instead of a DM. It lands in the tool, and your officers are told.
4. **Check `/verifications` once a week**, and run `/reconcile-roles` after a wave of departures.
5. **Set up the automatic reminders** (Guide 7). The bot and the reminders work together.

-# A new or updated command can take up to an hour to show up in Discord. That's normal.
