📢 **FGF Guild Management Tool Update — CHANG_V2.4**

Hey commanders! 👋

I've just rolled out a database cleanup and an accuracy hardening pass for **Guild Participation & Event Denominators**!

Here is what's new:

---

### 🧹 Clean Event History & Accurate Participation Rates
- **Purged Legacy Test Artifacts**: I removed 16 old dummy test sessions from early development that were artificially inflating the event denominator (e.g. showing 28 events instead of the 14 actual guild battles).
- **Accurate Global Event Count**:
  - **ALPHA Tenant**: Now accurately shows **14 real event sessions** across all active weeks (Shadowfront, SvS, GvG, Arms Race A/B, and DTR).
  - **Future Events Protection**: Scheduled upcoming events for next week are excluded from current attendance rates until their battle date arrives.
- **100% Synced Stats**: Your attendance rate in the **Player Portal** and the **Guild Leaderboard** is now accurate to the single battle.

### ⚡ Blazing Fast Speed & Ironclad Security
- **Snappier Load Times & Instant Navigation**: Modern modular frontend bundling and optimized database indexing.

---

Everything is live in production right now. If you run into any issues or have feedback, feel free to ping me on Discord! 🚀

Enjoy the upgrade and good luck in your upcoming battles! ⚔️
