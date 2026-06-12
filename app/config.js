/**
 * config.js — configuration d'environnement (saas_strategy.md §14.1).
 *
 * Seules des valeurs PUBLIQUES vivent ici (clé publishable Supabase, clé
 * VAPID publique) : la sécurité des données repose sur RLS côté serveur.
 * En multi-environnements (staging/prod), ce fichier est remplacé au
 * déploiement — ne mettre aucune logique ici.
 */
window.GMT_CONFIG = {
    SUPABASE_URL: 'https://vgweufzwmfwplusskmuf.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo',
    VAPID_PUBLIC_KEY: 'BKJ-mf-as7Si__DvBVRPN8EdpqnjihviHfkHZSvB_HgK5V68dG85WT8oDLvkE9_AQQw7gQqs7jeOn_a2ofrpBvo'
};
