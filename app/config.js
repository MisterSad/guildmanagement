/**
 * config.js : configuration d'environnement (saas_strategy.md §14.1).
 *
 * Seules des valeurs PUBLIQUES vivent ici (clé publishable Supabase, clé
 * VAPID publique) : la sécurité des données repose sur RLS côté serveur.
 * En multi-environnements (staging/prod), ce fichier est remplacé au
 * déploiement ; ne mettre aucune logique ici.
 */
window.GMT_CONFIG = {
    SUPABASE_URL: 'https://vgweufzwmfwplusskmuf.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo',
    VAPID_PUBLIC_KEY: 'BKJ-mf-as7Si__DvBVRPN8EdpqnjihviHfkHZSvB_HgK5V68dG85WT8oDLvkE9_AQQw7gQqs7jeOn_a2ofrpBvo',

    // Paddle Billing (saas_strategy.md §8). Empty until the merchant account and
    // domain exist: while empty, the in-app billing UI shows a "not configured"
    // state and the checkout button stays disabled — nothing activates. Fill in
    // per docs/paddle-setup.md, then bump config.js?v=.
    PADDLE_ENV: 'sandbox',          // 'sandbox' | 'production'
    PADDLE_CLIENT_TOKEN: '',        // Paddle.js client-side token (test_… / live_…)
    PADDLE_PRICE_ID: ''             // recurring 9.99 EUR/mo price (pri_…)
};
