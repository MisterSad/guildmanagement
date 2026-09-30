📢 **FGF Guild Management Tool Update — CHANG_V3.32.0**

A big day of fixes, most of them straight from your reports. Thank you, keep them coming! 🙏

**🕒 Half-hour time zones work (TICKET-0010)**
Adelaide, Darwin, India, Nepal, Iran, Newfoundland… could never be saved: the tool only accepted whole hours. Fixed everywhere: Admin portal, Player Portal, and `/timezone offset:9.5` in Discord.

**👑 Changing your guild leader**
Guild admins could crown a new R5 but not step the old one down. Now you can change the old R5's rank yourself.

**🔑 "Generate Access" shows the password**
Creating an officer account made a password nobody could see. It now appears on the new account, already copied for you. Remember: it's shown **only once**. Lost it? 🔄 **Renew Password**.

---8<---

**🎮 Players: submitting your scores works now**
Honest confession: the **Active Events** page in the Player Portal never actually saved anything. Every submission was either refused or silently lost. It works on every event now, and the card tells you where you stand: **Awaiting approval** ⏳, then **Confirmed by an officer** ✅.

**Officers:** player submissions show a **Pending** line. Check it, then click **Approve**. This now works on Arms Race and Shadowfront too. Pending lines don't count in Stats until you approve them!

**🏆 Glory lands where it should**
A Glory typed in the Player Portal (**My Info**) or in **Members → Edit** now also goes into this week's **Glory Tracker**, and ticks the weekly "Submit your Glory" challenge.

---8<---

**🤖 Discord bot**
• `/setup-server` can be run again safely: it only adds what's missing and never duplicates your channels. Its summary now shows the real numbers (5 roles, 35 channels).
• `/call-to-arms` no longer forgets who answered when I restart the bot.
• `/reconcile-roles` is switched on: officers can see who still wears the guild role after leaving, and remove it in one click.
• Bot invite link: https://discord.com/oauth2/authorize?client_id=1544404813926768740

**🔔 Discord reminders**
If your guild has no Discord webhook yet, the **Overview** now tells you: *"Discord reminders are not set up"*. Click **Set up** to fix it in 2 minutes.

---8<---

**🛡️ Safety first**
• **Transfers need both guilds.** An officer asking to take a player from another guild now needs **that guild's approval**. Whoever asks never decides. Check **Members → Pending Transfers** regularly: there is no notification.
• **Your R5 is protected.** A roster scan that misses the leader no longer offers to remove them, and the R5 can't be deleted or banned by mistake.
• **Bans ask first.** Banning someone on your list erases their history, and the tool now tells you so before doing it.
• **Migration Hub:** AI summaries only ever read notes you're allowed to see, and I closed a security hole in page deletion. Only a page's creator sees its **Delete** button.

---8<---

**✨ Small things**
• Event pages show **your** event weights, not a fixed "5×".
• The in-app help (ℹ️) is rewritten wherever it described old features.
• Stats: the Shadowfront details speak English again.

**📚 New: user guides**
I wrote 17 step-by-step guides: creating a guild, officer access, running events and OCR, the Player Portal, the bot, reminders, roster, stats, Glory, history, sanctions, transfers, the weekly routine, a FAQ… I'll post them here on Discord.

Found a bug? Use the 🐞 **Report a bug** button in the tool. Today's first fix came from exactly that. 💪
