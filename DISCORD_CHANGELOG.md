📢 **FGF Guild Management Tool Update — CHANG_V3.34.1**

**🏷️ Changed your guild TAG in game? Change it in the tool too**

Until now, a new TAG in game meant asking me to delete your guild and create it again, and losing its history. Not anymore.

**⚔️ For guild leaders**
• Go to **Accounts & Access** → **Guild TAG** → **Change TAG**.
• Type the new TAG (2 to 12 letters, digits or `_`). Everything follows: members, scores, events, sanctions, absences, stats and settings. Your join code and invite links keep working.
• You can change it **once every 7 days**. The card shows your past TAGs and when the next change is possible.

**🤖 On Discord, one thing to do by hand**
• Rename your guild's **Discord role** to the new TAG (and your channels, if you like). The bot finds the role by its name.
• Screenshot verification picks up the new TAG within **5 minutes**.

**🎮 For players and other officers**
• Nothing to do. If you had the tool open during the change, just **reload the page**.

**🔒 Safety**
• Only the guild's admin (or me) can change its TAG.
• A TAG that is already taken, or that still holds data from a deleted guild, is refused, so nobody ever inherits another guild's history.

-# Something odd after changing your TAG? Tell me with the 🐞 **Report a bug** button. 💪

---8<---

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
