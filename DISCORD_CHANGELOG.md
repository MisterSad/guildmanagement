📢 **FGF Guild Management Tool Update: CHANG_V3.17.0**

This update fixes Discord event notification pings, introduces dedicated role alerts for Shadowfront squads, and cleans up event schedules. Full breakdown below.

### 🔔 Fixed: Discord Notification Pings & Sound Alerts
- **What happened**: Several guild leaders reported that Discord event reminders were arriving silently — the message appeared in the channel, but members didn't get an actual ping, bell notification, or push alert.
- **The fix**: Discord webhooks suppress mentions unless explicitly commanded to parse them. I've updated all notification payloads so that `@everyone`, `@here`, and custom role mentions (`<@&role_id>`) now properly trigger notifications and ping your members every time.

### 🛡️ Separate Discord Roles for Shadowfront Squad 1 & Squad 2
- You can now assign **dedicated Discord Role IDs** for **Squad 1** and **Squad 2** independently in **Guild Settings**!
- If your guild splits players into two squads with different Discord roles, each squad reminder will ping only its respective members.
- If you prefer a single role for both squads, you can continue using the default Shadowfront role ID as before.

### ⏰ Cleaner Event Schedules & Stale Session Auto-Expiry
- Fixed an issue where events that weren't manually marked as ended could linger as "Active" in the background across weeks while disappearing from the Upcoming Events overview.
- Stale event sessions now automatically expire, ensuring your event dashboard and squad rosters are always up to date and ready for the next battle.

### 🏰 SvS Garrison Defense Reminder Tagging
- The SvS base defense reminder now properly tags your guild's configured role instead of an unconfigurable default tag.

*As always, thank you for reporting issues and sharing feedback! Keep it coming via the Report a Bug button.* 🚀⚔️
