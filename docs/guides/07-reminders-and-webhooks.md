# 🔔 Guide 7: Automatic Discord reminders

The tool can post in your Discord **by itself**: "event starts in 30 minutes!", GvG daily tasks, SvS portal reminders… Your players never miss an event again.

It works with a **webhook**: a small "mailbox address" for one of your Discord channels. No bot needed.

## Step 1: Create a webhook in Discord (2 minutes)

1. In Discord, open **Server Settings → Integrations → Webhooks**.
2. Click **New Webhook**.
3. Pick the **channel** where the reminders should go (for example `#event-reminders`).
4. Give it a name (for example `FGF Reminders`).
5. Click **Copy Webhook URL**.

-# 🔒 Keep this URL private: anyone who has it can post in that channel.

---8<---

## Step 2: Paste it in the tool

Go to **Discord notifications** (left menu) and find **Global Discord Notifications & Webhook**:
- **Default Discord Webhook URL**: paste your URL. All reminders use it, unless you set another channel for an event.
- **Default Discord Role ID / Mention**: the role to ping, for example your members' role. Leave it empty to ping **@everyone**.

Click **Save Configuration**, **then** click **Test Webhook**. A "✅ *Discord Webhook Test Successful*" message should appear in your channel. 🎉

-# How to get a Role ID: turn on **Developer Mode** (*Settings → Advanced*), then *Server Settings → Roles →* right-click the role → **Copy Role ID**.
-# Test before saving? The test uses what is **saved**, so save first.

---8<---

## Step 3: Choose your reminders

In **Event Channels & Reminders**, each event has its own switches:

**Arms Race, Defend Trade Route, Shadowfront**
- **Creation & Updates**: a post when an officer starts the event or changes its time
- **30 min before**, **5 min before**, **Event Start**
-# These use the start time you enter when you click **Start** (Guide 3).

**Calamity Befalls**
- **10 min reminder (Rounds)**: a ping 10 minutes before each round

**GvG**
- **Daily Tasks breakdown**: the day's tasks, posted every day at 00:01 UTC
- **Enable Day 6**: reminders for the Saturday War Prism and War Fortress fights
- **Send Today's GvG Tasks Now**: post today's tasks right away

**SvS** (only in a week where you started SvS)
- **Garrison reminder**: Friday evening
- **Enable Day 6**: portal and battle reminders on Saturday
- **Won Day 1 to 5**: turn it on when your server **won** the preparation days. Saturday's reminders then say "we **attack**" instead of "we **defend**".

⚠️ When you are done, click **Save Configuration**. **Even if the switches already look right, save at least once**: until then, no reminder is sent.

---8<---

## 🎯 Optional: one channel per event

Want GvG in `#guild-vs-guild` and Arms Race in `#arms-race`? Create one webhook per channel (Step 1), then paste each one in the **Webhook URL** box of that event. You can also set a **Role ID** per event.
- Shadowfront has two role boxes: one for **Squad 1** and one for **Squad 2**.

-# An event with no webhook of its own uses the default one.

## ✏️ Optional: write your own messages

Click the ✎ (**Customize messages**) next to an event. For each reminder you can change:
- **Notification Text (Ping)**: the line that pings
- the **title** and the **description**

Handy words that are filled in for you: `{guild_tag}` (the role you ping), `{event_name}`, `{date}`, and `{round}` for Calamity.
Changed your mind? **Reset to default template**.

---8<---

## 😕 Nothing arrives?

1. Did you click **Save Configuration**? (Most common cause!)
2. Click **Test Webhook**. If it fails, create a new webhook and paste the new URL. The old one may have been deleted.
3. Is the switch for that reminder **on**?
4. For Arms Race, DTR and Shadowfront: was the event **started** in the tool, with the right **time (UTC)**?
5. SvS reminders only come in a week where **SvS was started** in the tool.

-# Don't see GvG, SvS or Calamity on the page? Ask the developer: these can be turned off for a guild.
-# All times are **UTC** (game time).
