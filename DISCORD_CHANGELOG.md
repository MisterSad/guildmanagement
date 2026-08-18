📢 **FGF Guild Management Tool Update — CHANG_V3.27**

Hey commanders! 👋

I have rolled out a major enhancement for the **DEMO tenant**, introducing a rich, fully populated dynamic dataset with an automated daily reset! 🚀🛡️

---

### 🎮 1. Dynamic, Up-to-Date Fictional DEMO Dataset
For anyone exploring or showcasing the FGF Guild Management platform with demo credentials:
* **Full 7 Military Metrics**: 60 fictional commanders with realistic ratings across Overall Power, Tech Power, Champions, Crew, Flagship, Fleet Rating, and Glory Score.
* **Live Dynamic History & Progression Charts**: 5 consecutive weeks of historical data computed dynamically relative to the current date, so graphs and performance benchmarks are always active, fresh, and visually engaging.
* **All Combat & Battle Events**: Full participation and score histories for SvS (Prep + PvP), GvG, Glory, Defend Trade Route, Arms Race A/B, and Shadowfront squads.
* **Roster Management Showcase**: Includes realistic disciplinary sanctions, player absences, Shadowfront signups, and name change histories.

---

### 🔄 2. Automated Daily Database Reset
* **Zero Disruption for Testers**: Feel free to test any action in the DEMO tenant — kick members, change permissions, modify scores, create sanctions, or adjust join codes!
* **Automated Nightly Restore**: A scheduled database cron job (`daily-demo-tenant-reset`) runs every night at 03:00 UTC to automatically restore the DEMO tenant back to its pristine state.

---

### 🧪 3. Quality & Verification
* **274/274 Automated Unit Tests Passing** 🟢
* Strict Zero-Trust access control and multi-tenant isolation preserved.

*Give the demo a spin anytime to explore the full power of the FGF Guild Management Command Center and Player Portal!* ⚔️✨
