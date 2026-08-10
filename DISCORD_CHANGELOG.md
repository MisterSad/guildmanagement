:rocket: **PLAYER PORTAL ERROR RECOVERY & CONNECTIVITY FIX — v23**

Fixed an issue where stale browser sessions or Edge Function HTTP error statuses produced an unrecoverable "Edge Function returned a non-2xx status code" error screen.

---

:new: **What's new**

- :sign_in: **One-Click Reconnect Action:** Added an interactive **"Reconnect / Sign Out"** button to the Player Portal error screen (`portal.js`), allowing players with expired tokens or stale sessions to instantly clear their session and sign back in.
- :arrows_counterclockwise: **Retry Option:** Added a **"Retry"** button to quickly reload the portal if network or database latency occurs.
- :cloud: **Redeployed `member-portal` Edge Function:** Deployed the updated Edge Function to Supabase Edge Runtime (`supabase functions deploy member-portal --no-verify-jwt`), returning structured JSON error payloads instead of raw HTTP 500 status codes.

---

:bug: **What's fixed**

- :bug: **Error Masking Fix:** Prevented Supabase JS SDK from obscuring real API/database error details with generic `"Edge Function returned a non-2xx status code"` text.
- :shield: **Session Recovery:** Players stuck on a dark error screen can now immediately log out and re-authenticate with a single click.

---

:heart: _FGF Guild Management Tool_
