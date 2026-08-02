:page_with_curl: **CHANGELOG — SHADOWFRONT** :page_with_curl:

**2026-08-02 — Full rework (UI/UX + Discord sharing)**

The tool now follows the real in-game event flow: players declare their availability **in-game**, the admin records it here, composes the squads using the reliability history, then tracks participation.

:one: **New guided 3-step flow**

The old screen (4 flat tabs) is now a logical path:
1. **Availability** — record who is available
2. **Squad Composition** — build the final squads
3. **Participation Tracking** — track attendance

Each step unlocks in order: you cannot compose without recorded players, and you cannot track without a launched squad.

:two: **Step 1 — Availability, built for the admin**

- Availability is no longer declared in the tool, but **in-game**. The admin records the available players here.
- **Two side-by-side pools** (Squad One / Squad Two — Available) with participation rate and power: balancing both squads at a glance.
- **Bulk entry**: search + checkboxes + "Add to Squad One/Two" in one click.
- The "Both / None" model is gone: an in-game declaration is for a specific slot, so a single squad.

:three: **Step 2 — Squad Composition, guided by history**

- **Only declared players** appear in the pool.
- **Sorted by participation rate by default** (Rate / Power toggle), reliability categories 🟢🔵🟡🔴 and filters.
- **Summary bar on top**: remaining pool, participants /20, substitutes /10, average participation rate.
- Commander stars (max 3) kept.

:warning: **Compose before launch (important fix)**

Assigning a player **no longer starts the event by accident** (the old code activated the session on the first assignment, with premature Discord notifications).
- The session stays **inactive** while composing; only "Start" activates the event.
- Ending a squad closes the session; the next start begins a fresh session, history stays intact.

:paperplane: **Share the composition on Discord**

New **"Share on Discord"** button: one message with both squads (participants, 👑 commanders, substitutes, counters) sent to the configured Shadowfront webhook. Perfect for announcing the rosters to the guild.

:chart_with_upwards_trend: **Step 3 — Fast tracking**

- **"All present" / "All absent"** bulk buttons for mass updates.
- Subtle **"Saved"** indicator on every autosave.
- "Pending / Approve" flow removed (it handled player self-declarations that no longer exist).

:wastebasket: **Removals**

- **Running Tab**: incomplete history matrix (history was actually never loaded) and redundant with the rate badges. History now lives in the reliability badges.

:white_check_mark: **Tests**: 96 unit tests, including 5 new ones dedicated to this rework.
