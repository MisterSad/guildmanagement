# FGF Guild Management Tool

> Guild management for Foundation Galactic Frontier, open to every guild, each with its own space.

FGF Guild Management Tool is a web app I built to make running a guild in **Foundation Galactic Frontier** simple and organized. It is not tied to any single guild. Any guild of the game can use it, and every guild gets its own isolated space with its own members, events, and settings. It is **free**, for everyone, with no paid tier of any kind.

---

## What this project is

Running a competitive guild in Foundation Galactic Frontier is a lot of work. Recurring events with strict rules (SvS, GvG, Shadowfront, DTR, Arms Race, Glory), limited squad slots, commanders to choose, availability that changes by the hour, and players to keep accountable.

This tool replaces spreadsheets and chat threads with a purpose-built workspace where guild leaders and officers can:

- plan and run every event with a workflow adapted to its own rules,
- build fair squads based on real participation history,
- track attendance live,
- keep the whole guild informed through Discord,
- manage members, sanctions, banned players, and accounts,
- rank players across the guild with statistics based on actual participation.

Every guild is fully isolated from the others, and creating one is self-service.

---

## Features

### Event management
Dedicated workflows for every recurring event, each following its own rules:

- **SvS, GvG & DTR.** Start and close sessions, auto-import the roster as participants, track participation and scores (prep phase and PvP day for SvS/GvG, appointments for DTR), and approve scores submitted by players.
- **Shadowfront.** A guided three-step flow: record who declared availability in-game, compose the two squads (20 participants and 10 reserves each, up to 3 commanders per squad), then track participation live. Rosters can be prepared in advance and published to Discord in one click.
- **Arms Race.** Two independent stages (A and B), participation-only tracking.
- **Glory.** A weekly tracker with per-member input, evolution percentages, and guild totals.

### Squad composition, guided by history
When composing squads, every player's **participation rate** is shown at a glance (Excellent, Good, Average, Poor, or new), with category filters and per-squad summaries. The players who show up are the players who get picked.

### Live participation tracking
Mark players Present, Late, Excused, or Substitute Present with color-coded toggles. Stats update instantly, with "everyone present / everyone absent" actions and autosave.

### Rankings & statistics
A full leaderboard with a 3D podium for the top three players. Browse global rankings, per-event scores, participation, and periods from one week to all time, including consistency and glory bonuses and badges such as Iron Man, MVP, Glory Climber, Loyal Soldier, and Consistency Master.

### Member management
Add members with in-game role, UID, and power. Search, filter by power tier (S to D), sort, and group by role. Edit details with a full name-history audit trail, transfer players between sister guilds on the same server, and approve or reject pending transfer requests.

### Sanctions & banned players
Record sanctions with reason and author, with an automatic alert for repeat offenders (3+ sanctions). Ban a UID permanently. Banned players are removed from the roster and can never be added back.

### Discord integration
Paste a webhook URL and the guild's Discord is wired in: per-event webhooks, role mentions, notification toggles, and fully customizable message templates. Automated reminders cover every event (30 minutes before, 5 minutes before, at start), plus the complex schedules of GvG Saturday and SvS PvP day.

### Player portal
Players don't need an account. They enter their in-game UID and can update their power, request a guild transfer, and submit their scores for active events. Submissions arrive as pending for officers to approve.

### Roster scanning (OCR)
Rather than retyping a roster, officers upload a screenshot of the in-game member list or a metrics panel. It is transcribed automatically, matched against the existing roster, and presented as a diff — joins, departures, renames and power changes — for the officer to accept or reject. The image itself is never stored; only the transcribed text is cached, briefly, so re-submitting the same screenshot costs nothing.

### Migration Hub
A wiki for cross-server intelligence during server migrations: pages scoped to a guild or to a whole server, categorised (recruitment, diplomacy, intel), with comments and live updates. It is the largest feature in the app and, until now, the least documented.

### Badges
A catalog of 45 badges computed from real participation and progression — earned state, progress, and what is left to do for each one.

### Bug tickets
Anyone can file a bug report from inside the app; it lands in a console the super admin triages, and is relayed to Discord.

### Audit log
Administrative actions are recorded with who, what, when and which guild, and are browsable by the super admin. Entries are kept for 12 months.

### Contextual help
Small (i) buttons throughout the interface open plain-English guidance in place, so a new officer does not need a manual.

### Multi-guild support
One platform, many guilds — 26 of them today, sharing nothing. Each guild is completely isolated, with its own members, events and settings, enforced in the database rather than only in the interface. Creating a guild is self-service.

### Free, with no payment surface
The app is free for every guild. There is no checkout, no subscription, no donation mechanism, and no payment data is held or transmitted anywhere. Nothing is, or ever has been, gated behind a paid tier.

---

## How an event comes to life

1. **Availability.** Players declare in-game; officers record who is available, per squad.
2. **Composition.** Participants and reserves are chosen from the available pool, guided by participation rates.
3. **Share.** The finalized roster is posted to Discord so everyone knows who is committed.
4. **Start & track.** The event runs and attendance is logged live (present, late, excused, substitute).
5. **Review.** Scores come in from the player portal and are approved by officers.
6. **Rank.** Every session feeds the statistics engine, the badges, and the next event's decisions.

---

## Roles

| Role | What they can do |
|------|------------------|
| **Super Admin** | Platform-wide: every guild, account provisioning, the audit log and the bug-ticket console. |
| **Server Admin** | Every guild on one game server. |
| **Guild Admin** | Full management of their guild: events, squads, members, sanctions, Discord settings. |
| **Member** | Read-only access: overview, members, stats, history. |
| **Player (portal)** | No account needed. Submits scores, updates power, requests transfers via their in-game UID. |

A role is never read from the browser. It is resolved from the signed session token and re-checked in the database on every read and write, so changing it locally changes nothing.

---

## About the project

This project was developed entirely by me, with no third-party assets. It is a web app built in plain TypeScript with no UI framework, a custom design system, a Postgres database with serverless functions, and an automated test suite covering the core logic — statistics, rankings, access control, tenant isolation — plus end-to-end tests that drive the real production bundle rather than a development server.

It is also deliberately light on the browser: no cookies, no analytics, no tracking of any kind, and no service worker. What it stores about players and how long it keeps it is set out in the [Privacy Policy](privacy.html).

---

## License

FGF Guild Management Tool is licensed under the **Business Source License 1.1**. See [`LICENSE`](LICENSE) for the full text.

- The project is fully self-developed; no game publisher assets are used.
- You may read, study, and adapt the code for non-production and internal purposes.
- Operating the app as a service for third parties, or reselling it, requires a commercial license. Contact the maintainer to arrange one.
- On the Change Date (**2029-08-02**), the software becomes available under the **Apache License, Version 2.0**.

This is an unofficial, community-developed project and is not affiliated with or endorsed by the publisher of Foundation Galactic Frontier.
