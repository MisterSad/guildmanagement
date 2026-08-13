📢 **FGF Guild Management Tool Update — Server-Side Webhook Resilience — v95**

🛠️ **Fixed: Cross-Tenant Discord Webhook Delivery**

✨ **What was changed:**
- **Server-Side Webhook Resolution**: `discord-webhook-proxy` now automatically resolves your guild's webhook URL on the server using service role permissions if local browser storage or RLS policies block client-side reading.
- **Unstoppable Delivery**: Webhook pings (Shadowfront compositions, event notifications) now deliver reliably across all tenants and browser session states!

Feel free to test sharing squad compositions in the **Shadowfront** tab! 🎯
