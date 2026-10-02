📢 **FGF Guild Management Tool Update — CHANG_V3.34.0**

**🚀 Signing in with Discord, rebuilt — and the bot walks your players in**

This update covers two releases: a new sign-in (V3.33) and a bot that now works hand in hand with it (V3.34).

**🔑 Signing in (V3.33)**
• **One button for everyone:** **Continue with Discord**. Officers land in the Command Center, players in their Player Portal, automatically. Old identifier and password? Tucked underneath, and it opens by itself if that's how you signed in last time.
• **First time here?** Pick **join my guild**, **I already have an account** or **create a guild**. Each says what you'll need.
• **A typo no longer sends you back to Discord.** The form stays filled in, the error shows under the field, and you just fix it.
• **Invite links:** in **Accounts & Access**, **Copy invite link** sits next to your join code. Players open it and the code is already filled in; all they type is their UID.
• **No more waiting in the dark:** after asking to join, players see a clear **"Waiting for approval"** screen, and get a Discord DM once an officer decides.

---8<---

**🤖 The bot (V3.34)**

**⚔️ For officers**
• **New `/invite` command.** Run it in your welcome channel: the bot posts a **Join [TAG]** button. Players press it, continue with Discord, and only type their UID. The join code is already filled in.
• **Approve new players without leaving Discord.** When someone asks to join, the request lands in your officers channel with **Approve** and **Reject** buttons. Reject asks you to confirm, the player gets a DM either way, and the buttons disappear once it's decided.
• Only an officer of that player's guild can decide, exactly like in the tool. A Discord role alone isn't enough.
• No officers channel set? The tool now warns you in **Admin → Discord Notifications**: without one, join requests aren't announced anywhere. `/setup-server` creates it for you.

**🎮 For players**
• **`/link` is gone.** Signing in to the tool with **Continue with Discord** links your account, and that's all the bot needs.
• Not linked yet? The bot's answer comes with a **Continue with Discord** button. One tap, done.
• Still signing in with a password? **My Info → Switch to Discord sign-in** moves you over in one step.
• Got your guild role after posting your screenshot? The welcome DM now has a button to your Player Portal. If you're not in the tool yet, it opens with your guild's code filled in.

**🔒 Under the hood**
• `/link` could keep an old password alive next to Discord. That door is closed: Discord sign-in is the only way to link an account now.
• Every approval or rejection, from the tool or from Discord, now leaves a trace of who decided.

**What changes for you:** nothing to do. Next time you sign in, it's just smoother.

-# Something feels off with the sign-in or the bot? Tell me with the 🐞 **Report a bug** button, and say which step, command or button you used. 💪
