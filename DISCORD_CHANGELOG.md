📢 **FGF Guild Management Tool Update — CHANG_V3.32.1**

**🔒 A security update you won't see (and that's the point)**

After today's fixes, I went through the whole database door by door and locked everything that didn't need to be open.

**What I did:**
• **Visitors who aren't signed in can't touch your guild's data.** They never could read it, but the doors were still technically unlocked. Now they're shut, on every table.
• **Every change goes through the right checks.** Some of your data (war scores, daily scores, weekly scores…) could in theory be written without going through the rules that validate it. That path is closed: the tool itself is the only way in.
• **Private things stay private.** Sign-in codes, passkeys, Discord links and bug reports were already protected; now the browser has no way to even ask for them.
• **Safe by default.** Anything I add in the future starts locked to visitors, and I open only what's needed. Nobody has to remember to lock the door anymore.

**What changes for you:** nothing. Everything works exactly as before.

-# Something shows "permission denied" where it didn't before? Tell me with the 🐞 **Report a bug** button, and include the page and what you clicked. 💪
