# ❓ FAQ: quick answers to common problems

Find your message below. Each answer tells you what to do.

## 🔑 Signing in and accounts

**"Your account is awaiting approval by a guild admin."**
An officer must approve you. Officers: **Accounts & access** → **Pending Account Validations** → **Approve**.

**"That UID is not on the guild roster. Ask an admin to add you first."**
Officers: add the player in **Members** → **Add a member**. Then the player tries **Join a guild** again.

**"That join code is not valid."**
Copy the code again from **Accounts & access** → **Guild Join Code** → **Copy Code**. It never changes.

**"That UID is already attached to another account."**
Someone already joined with this UID. Contact the developer, who can check who holds it.

**"This attempt expired — each one is single-use."**
You waited more than 15 minutes. Close the window and click **Sign in with Discord** again.

**We can't see an officer's password.**
Nobody can, on purpose. Make a new one: **Accounts & access** → the officer's account → 🔄 **Renew Password**. See Guide 2.

---8<---

## 📅 Events and scores

**"Please start the … session in Events before applying OCR updates."**
Click **Start** on the event first, then run the OCR again.

**The OCR missed some players.**
Check the table before applying. Names shown as **Other Guild / Non-Member** were not recognised: fix the name by hand, tick the line, then **Validate & Apply**. Clear screenshots of the **whole line** give the best results.

**"Video is too long (max 8 minutes)" or my iPhone video fails.**
Use a shorter recording, re-export it as **H.264**, or use screenshots.

**A player's line shows "Pending".**
The player submitted it from the Player Portal. Check the numbers, then click **Approve**.

**I made a mistake after ending the event.**
Open **History**, click the event, and fix it there.

**I started an event by mistake.**
The 🗑️ button deletes the session **and all its scores**. It cannot be undone.

---8<---

## 🎮 Player Portal

**"Submission failed" / "An officer has already recorded this event for you."**
An officer already filled in your line. Ask them if something is wrong.

**"Not in this squad" (Shadowfront).**
Only players picked for that squad can submit. Ask your officers.

**"This event has ended."**
Too late to submit. Ask an officer if something is missing.

**My time zone won't save.**
Pick your city in **My Info** → **My Timezone**, or click **Auto**, then **Save**. Half-hour zones (India, Adelaide…) work.

**The bot says my Discord account isn't linked.**
Press the **Continue with Discord** button in its answer and sign in. That links your account. Still using a password? **My Info** → **Switch to Discord sign-in**.

**A player asked to join, but nobody was told.**
Set an **Audit / Officers Channel ID** (Admin → Discord Notifications), or run `/setup-server`. Join requests and their **Approve** / **Reject** buttons are posted there.

---8<---

## 🤖 Discord bot and reminders

**"…an officer may need to check my role position."**
In *Server Settings → Roles*, drag the **bot's role above** `[TAG]`, `[VISITOR]` and `[PENDING]`.

**"I couldn't find a matching guild role or a "[VISITOR]" role on this server."**
Create the roles with the exact names, brackets included: `[PR1M]`, `[VISITOR]`, `[PENDING]`. Or run `/setup-server`. See Guide 5.

**A player got `[PENDING]` instead of the guild role.**
The roster protection is on, and the player is not in **Members** yet. Add them, then ask them to post their screenshot again.

**"Too many verification attempts."**
Wait a few minutes, then post again.

**No reminders arrive.**
1. **Discord notifications** → did you click **Save Configuration**?
2. Click **Test Webhook**.
3. Is the reminder's switch on?
4. Was the event **started** with the right **UTC** time?
See Guide 7.

**The Overview says "Discord reminders are not set up".**
Your guild has no Discord webhook yet. Click **Set up** and follow Guide 7.

**A new bot command doesn't show up.**
Discord can take up to an hour to show a new or changed command.

-# Still stuck? Report it with the bug button (see Guide 14).
