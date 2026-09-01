📢 **FGF Guild Management Tool Update — CHANG_V3.14**

Big one: I built a full Discord bot for the tool, so you can now update your stats and check your info straight from Discord — no need to open the web app for the everyday stuff. Full guide below. 🤖⚡

### 🤖 New: the FGF Guild Management Discord bot

**1. Add the bot to your server**
Any guild leader/officer can install it — click here: https://discord.com/oauth2/authorize?client_id=1544404813926768740

**2. Link your Discord account (one-time, do this first)**
- Run **`/link`** anywhere in the server. I'll DM-style reply (only you can see it) with a short 6-character code, valid for 10 minutes.
- Go to the web app → **Player Portal → My Info → "Link Discord"**, sign in if needed, and enter that code.
- That's it — your Discord account is now tied to your in-game account, for good. Every command below reads/writes that same account.

Every command's reply is **only visible to you** (nobody else in the channel sees it), so feel free to run these anywhere, even in a busy channel.

**3. The commands**

- **`/myinfo`** — Your current stats at a glance: Overall Power, Glory, Role, Fleet Rating, Tech Power, and your saved timezone.

- **`/power <value>`** — Update your overall power. Same number, same place as the "Update Power" button in the web Portal — updating it here updates it there too, instantly.

- **`/glory <value>`** — Submit your Glory score for the current week. One submission per week, same as the Portal.

- **`/timezone <offset>`** — Set your timezone as a UTC offset (anywhere from **-12** to **+14**). Discord shows you the valid range right in the command, so you can't mistype it.

- **`/challenges`** — Your weekly challenge checklist: attend 1/3/5 events this week, submit your Glory, refresh your power — plus your season level (Bronze/Silver/Gold, based on your last 4 weeks of event attendance).

- **`/absence`** — declare when you're away, in three parts:
  - **`/absence set <start_date> <end_date> [note]`** — dates in `YYYY-MM-DD` format (e.g. `2026-09-10`). The note is optional.
  - **`/absence list`** — shows every absence you've currently got declared, each with a short ID.
  - **`/absence cancel <id>`** — cancels one, using the ID from `/absence list`.

**Heads up**: linking is per Discord account, not per server — if you're active in multiple FGF Discords, you only ever need to run `/link` once, and it'll work from any of them.

### Also in this update
- 📖 Text sizes across the whole app are now fully consistent — a handful of near-duplicate font sizes have been unified into one clean scale, mostly invisible but a bit easier on the eyes.
- 🖱️ Fixed the sidebar footer (subscription badge, Buy Me a Coffee, Report a Bug, version info) feeling cramped on smaller desktop windows — more breathing room now.
- ☕ Fixed "Buy Me a Coffee" not showing up at all for some admins, and fixed a follow-up bug where it showed but the page behind it wrongly said "Admins only."

*As always, thanks for the reports and feedback — keep them coming via the Report a Bug button!* 🚀🛡️
