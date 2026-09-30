# 🤖 Guide 5: Install the FGF bot on your Discord server

The bot checks your players' in-game profile, gives them the right role and nickname, and adds bot commands to your server.

**Before you start:**
- Your guild must already exist in the tool (see Guide 1).
- You must be an **Administrator** of your Discord server.

## Step 1: Invite the bot

1. Open this link and pick your server:
https://discord.com/oauth2/authorize?client_id=1544404813926768740
2. Keep **all the permissions** it asks for, then click **Authorize**.

-# The simplest setup is to give the bot **Administrator**. Without it, `/setup-server` cannot work, and you must give it **Manage Roles**, **Manage Nicknames** and **Manage Messages** yourself.

Now pick **ONE** of the two ways below.

---8<---

## 🚀 Way A: Let the bot build your server (new or empty server)

In any channel, type:
`/setup-server guild:PR1M`
(use **your** guild tag)

1. The bot shows what it will create. Click **🚀 Confirmer et Déployer**.
2. Wait for the progress bar to finish.

✅ You get 5 roles (`[VISITOR]`, `[PR1M]`, `[PENDING]`, `⭐ [PR1M] R4`, `👑 [PR1M] R5`), your categories and channels (verification, r4-chat, event channels, voice…). The verification and officer channels are **connected to the tool for you**.

-# Something missing or deleted by mistake? Run `/setup-server` again: it only adds what is missing and keeps what is already there.
⚠️ **Do not use `clean_mode`** on a server you already use: it **deletes all your channels**.

-# Refused with "not registered" or "no game-server number"? Check the tag, or ask the developer.

---8<---

## 🛠️ Way B: Keep your own server (you already have channels)

**1. Create 3 roles** in *Server Settings → Roles*. The names must be exact, with the brackets:
- `[PR1M]` → your guild tag: your members get this one
- `[VISITOR]` → for players from other guilds
- `[PENDING]` → for players waiting for your approval

**2. Connect your channels in the tool.** Go to **Discord notifications** → **Player Verification (Screenshot OCR)**:
- **Verification Channel ID** → the channel where players post their screenshot
- **Audit / Officers Channel ID** → your officers-only channel. The bot posts its notes there.

Click **Save Configuration**.

-# How to copy an ID: in Discord, *Settings → Advanced →* turn on **Developer Mode**. Then right-click the channel → **Copy Channel ID**.
-# The bot must be able to **see and write** in the officers channel.

---8<---

## ⚠️ Step 2: Move the bot's role up (very important!)

In *Server Settings → Roles*, **drag the bot's role ABOVE** `[PR1M]`, `[VISITOR]` and `[PENDING]`.

If you forget, the bot cannot give roles. Players will see: "*…an officer may need to check my role position*".

## ✅ Step 3: Test it

Ask a player (or post yourself) a **screenshot of the in-game profile** in the verification channel:
- ⏳ the bot is reading…
- ✅ done: the player gets `[PR1M]`, and a nickname like `[PR1M] Name #1058`
- ❌ the screenshot could not be read. Try a clearer one.

-# The bot deletes the screenshot after a few seconds. That's normal.

---8<---

## 🔒 Optional: only let in players you added

By default, a player who posts a valid screenshot with your tag is **added to your member list automatically**.

Want to control who gets in? In **Discord notifications**, turn on **Only grant the guild role to players already on the roster**, then **Save Configuration**.

Now a player who is not in your **Members** list gets `[PENDING]`, and your officers channel gets a message with their name. Add them in **Members**, then ask them to post their screenshot again. Done! ✅

-# Next: **Guide 6**, to get the most out of the bot.
