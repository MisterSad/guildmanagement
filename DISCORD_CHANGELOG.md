📢 **FGF Guild Management Tool Update: CHANG_V3.15**

New this time: the Discord bot can now verify players automatically from a screenshot. Post a picture of your in-game profile in the right channel and the bot handles your role, your nickname, and your roster entry on its own. Full explanation below, plus a couple of fixes since the last update.

### 🔍 New: automatic verification from a screenshot

**For guild leaders and officers: one-time setup**

This needs a bit of setup before your members can use it. A leader or officer has to do this once, on your own Discord server:

1. Make sure the bot has the `Manage Roles` and `Manage Nicknames` permissions. If you added the bot a while ago, you likely need to re-invite it with these permissions, since Discord never adds new permissions to a bot that's already in your server.
2. In Server Settings > Roles, drag the bot's own role above any role it will need to assign.
3. Create a role named exactly after your guild's tag, with brackets. For example `[PR1M]`.
4. Create a role named exactly `[VISITOR]`.
5. Create or pick the channel where members will post their screenshots. For example `🔐・verification`.
6. Turn on Developer Mode in your Discord settings (User Settings > Advanced), then right-click that channel and choose "Copy Channel ID."
7. In the web app, go to Admin > Discord Notifications > Player Verification (Screenshot OCR), paste that ID into "Verification Channel ID," and save.

Once that's saved, the feature is live for your guild.

**For everyone: how to use it**

1. Open your in-game profile screen, the one showing your pseudo, your guild tag, your Power, your Glory, and your UID.
2. Take a screenshot of it.
3. Post that screenshot in the server's designated verification channel.
4. The bot reads the screenshot with an AI vision model and replies in the channel within a few seconds to tell you what it did.

**What happens once the bot reads your screenshot**

If your guild tag matches the guild this channel is set up for, and a Discord role named after that tag already exists on the server, you get:
- That role, assigned automatically.
- Your Discord nickname set to your tag, your pseudo, and your server number. For example, `[PR1M] HawkEye #1058`.
- Your roster entry created if you're new to the guild, or updated with your current Power and Glory if you're already on the roster.

If your tag doesn't match this channel's guild, or the matching role hasn't been created yet, you get the **[VISITOR]** role instead and nothing changes on the roster. If the bot can still tell which guild you actually belong to, it still sets your nickname the same way. It just won't touch anyone's roster data unless it's fully sure who you are.

**A few practical notes**

- The bot only reads what's actually visible on the screenshot. Make sure your pseudo, your guild tag, your Power, your Glory, and your UID aren't cropped out or covered by another window.
- There's a limit on how many attempts you can make in a short window, so don't spam it if the first try doesn't work. Wait a few minutes and post a clearer picture.
- You don't need to have linked your account with `/link` first. The screenshot itself is treated as proof of who you are.

### 🤖 Reminder: the rest of the bot

If you haven't set it up yet, add the bot here: https://discord.com/oauth2/authorize?client_id=1544404813926768740, then run `/link` once to connect your Discord account to your in-game account. After that:

- `/myinfo` shows your stats.
- `/power <value>` and `/glory <value>` update your numbers.
- `/timezone <offset>` sets your timezone.
- `/challenges` shows your weekly checklist and season level.
- `/absence set/list/cancel` handles your absence declarations.

### Also in this update
- Fixed a bug where the daily GvG task reminder could go out several times in a row on the same day instead of once.
- Fixed Web Push notifications (the browser kind, not Discord) failing every single time they were sent, for everyone. They now work correctly.

*As always, thanks for the reports and feedback, keep them coming via the Report a Bug button!* 🚀🛡️
