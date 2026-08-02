:white_check_mark: **TRANSFER FIXED — FOLKEN**

Hi there! :wave:

You recently tried to transfer the player **Folken** from **OMEGA** to **IMK** and got the error:

> :x: **Error transferring member: permission_denied**

We looked into it and found the cause. Here is what happened and what we changed.

---

:mag: **What went wrong**

Folken was listed in the guild database **twice**, under two different names:

- **Tirex** (old name, still present in ALPHA)
- **Folken** (current name, in OMEGA)

Both rows shared the **same in-game UID**. When a transfer is requested, the system looks up the player by UID. Because of the duplicate, it found the ALPHA row first and concluded the caller was not allowed to transfer that player (the transfer permission is tied to the guild of the source row). That is why you saw **permission_denied**, even though Folken clearly belongs to your guild.

We also confirmed that the same situation existed for a few other players (Tirex/Folken being one of them), all left over from older roster changes.

---

:hammer_and_wrench: **What we fixed**

- The transfer now resolves the player **within your own guild**, so a duplicate row elsewhere can no longer block or misroute a transfer.
- New player entries with a UID that already exists in another guild are now **rejected**, so this situation cannot happen again.
- Folken's data was cleaned up: the old "Tirex" identity was merged into "Folken", and his participation history was kept.

---

:white_check_mark: **What it means for you**

- You can now transfer **Folken** (or any member) from **OMEGA** to another guild on the same server without errors.
- When a player transfers, their **full history (scores, participation, sanctions, squad records) follows them** to the new guild automatically.
- No data was lost during the cleanup.

Thank you for reporting it! :heart:

_FGF Guild Management Tool_
