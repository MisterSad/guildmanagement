:sparkles: **E2E TEST SUITE + CI — v6**

Automated browser tests now cover the login and the Player Portal, and the CI pipeline runs them on every push.

---

:new: **What's new**

- :test_tube: **Playwright e2e suite.** 7 browser tests launch the real app locally:
  - Login page: title, footer, Discord button, identifier/password/sign-in, empty-submit validation, and the switch to the player registration form and back.
  - Player Portal: dashboard boots after lookup, sidebar shows My Info / My Progress / Challenges, and the Challenges tab renders weekly goals, progress bars and the Bronze/Silver/Gold season rank.
  - The backend is stubbed with route interception, so the suite runs without touching the live project.
- :building_construction: **CI pipeline.** A new `e2e` job installs the Chromium browser and runs the full Playwright suite on every push and pull request, alongside the existing unit tests and edge-function typecheck.
- :wrench: **`npm run test:e2e`** script added; test artifacts (`test-results/`, `playwright-report/`) are gitignored.

---

:bug: **What's fixed**

- Nothing fixed this round; this closes the analytics batch (scouting, challenges, push prefs, benchmark) and adds its test coverage.

---

:heart: _FGF Guild Management Tool_
