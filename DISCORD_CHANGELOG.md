📢 **FGF Guild Management Tool Update — Discord Webhooks Reliability Fix — v93**

🛠️ **Fixed: Shadowfront & Guild Discord Webhooks**
All guild admins can now reliably share Shadowfront team compositions and receive event reminders on Discord without configuration friction!

✨ **What was changed:**
- **Smart Webhook Fallback**: If `webhook_shadowfront` is left empty, the tool automatically uses your guild's primary event webhook (e.g. Arms Race, SvS, GvG).
- **Expanded Discord URL Compatibility**: Added support for Discord webhooks from Canary (`canary.discord.com`), PTB (`ptb.discord.com`), API v10, and URLs copied with angle brackets (`<https://...>`).
- **Embed Safety & Role Mentions**: Rosters are automatically capped to Discord's embed limits and include your configured Discord role tag so members get notified instantly.

Feel free to test sharing squad compositions in the **Shadowfront** tab! 🎯
