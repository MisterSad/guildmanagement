📢 **FGF Guild Management Tool Update — Discord Webhook Proxy Fix — v92**

🛠️ **Fixed: Shadowfront Team Discord Sharing**
Guild admins can now smoothly share Shadowfront squad compositions directly to Discord!

✨ **What was changed:**
- **CORS & Proxy Resolution**: Webhook requests now route through the secure Supabase Edge Function proxy (`discord-webhook-proxy`), bypassing browser CORS and network restriction blocks.
- **Rich Embed Support**: Upgraded the Edge Function proxy to forward full Discord payload objects, including rich embed cards, squad rosters, reserve lists, and status colors.

Feel free to test sharing your squad compositions in the **Shadowfront** tab! 🎯
