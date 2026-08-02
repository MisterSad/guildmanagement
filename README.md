# FGF Guild Management Tool

> **Guild management for Foundation Galactic Frontier — open to every guild, each with its own space.**

Hi, I'm the developer behind this project. FGF Guild Management Tool is a web app I built to make running a guild in **Foundation Galactic Frontier** simple and organized. It is not tied to any single guild: any guild of the game can use it, and every guild gets its own isolated tenant with its own members, events, settings, and subscription.

---

## What this project is

Running a competitive guild in Foundation Galactic Frontier is a lot of work: recurring events with strict rules (SvS, GvG, Shadowfront, DTR, Arms Race, Glory), limited squad slots, commanders to choose, availability that changes by the hour, and players to keep accountable.

This tool replaces the spreadsheets and the chat-thread chaos with a complete, purpose-built workspace where guild leaders and officers can:

- plan and run every event with a workflow adapted to its own rules,
- build fair squads based on real participation history,
- track attendance live, with one click,
- keep the whole guild informed through Discord and push notifications,
- manage members, sanctions, banned players, and accounts,
- rank players across the guild with transparent, meaningful statistics.

Every guild is fully isolated from the others, and each one can subscribe independently.

---

## Features

### Event management
Dedicated workflows for every recurring event, each following its own rules:

- **SvS, GvG & DTR** — start and close sessions, auto-import the roster as participants, track participation and scores (prep phase and PvP day for SvS/GvG, appointments for DTR), and approve scores submitted by players.
- **Shadowfront** — a guided three-step flow: record who declared availability in-game, compose the two squads (20 participants + 10 reserves each, up to 3 commanders per squad), then track participation live. Rosters can be prepared in advance, and published to Discord with one click.
- **Arms Race** — two independent stages (A and B), participation-only tracking.
- **Glory** — a weekly tracker with per-member input, evolution percentages, and guild totals.

### Squad composition, guided by history
When composing squads, every player's **participation rate** is shown at a glance — Excellent, Good, Average, Poor, or new — with category filters and per-squad summaries. No more guesswork: the players who show up are the players who get picked.

### Live participation tracking
Mark players Present, Late, Excused, or Substitute Present with color-coded toggles. Stats update instantly, with one-click "everyone present / everyone absent" actions and autosave.

### Rankings & statistics
A full leaderboard with a 3D podium for the top three players. Browse global rankings, per-event scores, participation, and periods from one week to all time — with consistency and glory bonuses, and badges such as Iron Man, MVP, Glory Climber, Loyal Soldier, and Consistency Master.

### Member management
Add members with in-game role, UID, and power; search, filter by power tier (S to D), sort, and group by role. Edit details with a full name-history audit trail, transfer players between sister guilds on the same server, and approve or reject pending transfer requests.

### Sanctions & banned players
Record sanctions with reason and author, with an automatic alert for repeat offenders (3+ sanctions). Ban a UID permanently — banned players are removed from the roster and can never be added back.

### Discord integration
Paste a webhook URL and the guild's Discord is wired in: per-event webhooks, role mentions, notification toggles, and fully customizable message templates. Automated reminders cover every event (30 minutes before, 5 minutes before, at start), plus the complex schedules of GvG Saturday and SvS PvP day.

### Player portal
Players don't need an account: they enter their in-game UID and can update their power, request a guild transfer, and submit their scores for active events. Submissions arrive as pending for officers to approve.

### Push notifications
Members can opt in to push notifications on their device and receive event reminders even when they're not in the app.

### Multi-guild support
One platform, many guilds. Each guild is completely isolated, and super admins can switch between guilds, manage accounts, and consult a cross-guild leaderboard of every player's power and participation.

### Subscriptions
Each guild subscribes independently, with plans from one month to lifetime, purchased securely in the app. Renewals stack on the remaining time, and if a subscription expires the guild switches to read-only until it renews.

---

## How an event comes to life

1. **Availability** — players declare in-game; officers record who is available, per squad.
2. **Composition** — participants and reserves are chosen from the available pool, guided by participation rates.
3. **Share** — the finalized roster is posted to Discord so everyone knows who is committed.
4. **Start & track** — the event runs and attendance is logged live (present, late, excused, substitute).
5. **Review** — scores come in from the player portal and are approved by officers.
6. **Rank** — every session feeds the statistics engine, the badges, and the next event's decisions.

---

## Roles

| Role | What they can do |
|------|------------------|
| **Super Admin** | Oversees all guilds, creates guilds, manages accounts, grants subscriptions, cross-guild leaderboard. |
| **Guild Admin** | Full management of their guild: events, squads, members, sanctions, Discord settings, subscription. |
| **Member** | Read-only access: overview, members, stats, history. |
| **Player (portal)** | No account needed — submits scores, updates power, requests transfers via their in-game UID. |

---

## About the project

This project was developed entirely by me, with no third-party assets. It is a lightweight web app — plain JavaScript with a custom design system, a database and serverless backend, and an automated test suite for the core logic (statistics, rankings, subscriptions, access control). It is designed to be fast, easy to maintain, and simple to deploy.

---

## License

FGF Guild Management Tool is licensed under the **Business Source License 1.1** — see [`LICENSE`](LICENSE) for the full text.

- The project is fully self-developed; no game publisher assets are used.
- You may read, study, and adapt the code for non-production and internal purposes.
- Operating the app as a service for third parties, or reselling it, requires a commercial license — contact the maintainer to arrange one.
- On the Change Date (**2029-08-02**), the software becomes available under the **Apache License, Version 2.0**.

This is an unofficial, community-developed project and is not affiliated with or endorsed by the publisher of Foundation Galactic Frontier.
