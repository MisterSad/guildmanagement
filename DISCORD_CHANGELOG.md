📢 **FGF Guild Management Tool Update — CHANG_V3.35.0**

**🧰 A big clean-up under the hood, and what it changes for you**

Over the last few days I rebuilt a lot of the tool's foundations. You won't see most of it, but you'll feel it.

**⚡ Faster to open**
• The sign-in page and the Player Portal now load about **3× less**. Players no longer download the officers' Command Center along with their own pages.
• On a phone or a slow connection, the first screen shows up noticeably sooner.
• In the Command Center, each tab now loads the first time you open it instead of everything at once.

**✅ No more half-saved changes**
These actions are now saved **in one go: completely, or not at all**:
• banning a player;
• adding or editing a member;
• moving or deleting an event;
• clearing history;
• importing an OCR scan;
• creating a migration group.

So a dropped connection can no longer leave a banned player on the roster, or a rename only half done.

---8<---

**⚔️ For officers: what you'll notice**

**📸 OCR imports are all or nothing**
If one row is refused, for example a UID already taken, a banned player, or an R5 who would be removed, **nothing is saved**. The tool tells you which row to fix, so you never end up with a half-imported roster.

**📅 Moving an SvS or GvG to another week**
The war results and daily scores now move with the event. They no longer stay stuck on the old date.

**🧹 Clear history**
It now leaves the event that's still running alone, and squads that haven't started yet.

**🔗 Discord webhooks**
• Once a webhook is saved, the tool no longer shows its link. The field just says **"Set — paste a URL to replace"**.
• Why: anyone who has that link can post in your channel. Now it never leaves the server.
• Need the link? Discord → **Server Settings → Integrations → Webhooks**.
• Only real Discord webhook links are accepted.

---8<---

**♿ Easier to use, for everyone**
• **Pop-ups behave properly.** **Escape** closes them, the keyboard stays inside the window, and you land back where you were when it closes.
• **Form fields have proper names**, so screen readers can announce them.
• **Easier to read:** red "danger" buttons and purple labels have stronger contrast.
• **Easier to tap:** the Privacy and Terms links are bigger on phones.

**🔒 Safer**
• **Stricter browser security rules.** Your browser now refuses any style or script that doesn't come from the tool itself. Injected content can't dress itself up as part of the interface.
• **One place for permissions.** Every check of who can do what now goes through one place on the server.
• **Tested before release.** Many more automated tests run the real code, database rules included, before anything goes live.

**What changes for you:** nothing to do. If a page looks odd right after the update, reload it once.

-# Something looks off? Tell me with the 🐞 **Report a bug** button. 💪
