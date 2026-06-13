# Runbook : activer la facturation Paddle (P5)

> Concerne : `supabase/functions_staged/billing-webhook/`, `app/billing.js`,
> la config Paddle dans `app/config.js`, et la table `guilds` (migration staged).
> Référence : saas_strategy.md §8. **Tout est livré mais inerte** tant que les
> étapes ci-dessous ne sont pas faites.

## Pré-requis (le blocage actuel)

Paddle exige une **URL de site live** pour valider le compte marchand. Il faut
donc d'abord :

1. Acheter le domaine et déployer le site (landing + `/app/`) dessus.
2. Effectuer la bascule multi-tenant (la table `guilds` doit exister :
   `docs/cutover-runbook.md`), car l'abonnement vit sur `guilds`.

Avant ça, l'UI de facturation affiche « Activé avec la mise à jour
multi-tenant » et le bouton « S’abonner » est désactivé (« facturation non
configurée »). Rien ne casse.

## Étapes côté Paddle (compte validé)

1. **Produit + prix** : créer un produit « Guild Management Tool », puis un
   **prix récurrent 9,99 € / mois** (`pri_…`). Configurer la **période d'essai
   de 14 jours** sur ce prix.
2. **Client-side token** : Developer Tools → Authentication → client-side token
   (`live_…` en prod, `test_…` en sandbox).
3. **Notification destination (webhook)** : Developer Tools → Notifications →
   nouvelle destination :
   - URL : `https://<projet>.supabase.co/functions/v1/billing-webhook`
   - Événements : au minimum `subscription.created`, `subscription.activated`,
     `subscription.updated`, `subscription.past_due`, `subscription.canceled`,
     `subscription.paused`, `subscription.resumed`.
   - Copier le **secret de signature** de la destination.

## Étapes côté projet

1. **Config front** (`app/config.js`) puis bump `config.js?v=` :
   ```js
   PADDLE_ENV: 'production',            // ou 'sandbox' pour tester
   PADDLE_CLIENT_TOKEN: 'live_xxx',
   PADDLE_PRICE_ID: 'pri_xxx'
   ```
2. **Secret webhook** (Supabase → Edge Functions → Secrets) :
   `PADDLE_WEBHOOK_SECRET = <secret de la destination>`.
3. **Déployer** la fonction (incluse dans la release multi-tenant) :
   `supabase functions deploy billing-webhook` (elle a `verify_jwt = false`
   dans `config.toml` : c'est Paddle qui appelle, la signature est vérifiée
   dans la fonction).

## Comment ça marche

- **Checkout** : `app/billing.js` charge Paddle.js à la demande, ouvre
  `Paddle.Checkout.open({ items:[{priceId}], customData:{ guild_id } })`.
  Le `guild_id` voyage dans `custom_data` et revient dans les webhooks.
- **Webhook** : `billing-webhook` vérifie la signature Paddle
  (`Paddle-Signature: ts=…;h1=HMAC-SHA256(ts:rawBody, secret)`, tolérance
  5 min anti-rejeu), puis met à jour `guilds` :
  `subscription_status` (mappé depuis le statut Paddle), `provider_customer_id`,
  `provider_subscription_id`, `management_url`, `trial_ends_at`.
- **Gating** : la RLS multi-tenant bloque déjà les écritures hors
  `trialing/active/past_due` via `guild_is_writable()` ; le bandeau in-app
  (`billing.js`) reflète l'état (essai restant, impayé, lecture seule).
- **Gestion** : « Gérer l’abonnement » ouvre `guilds.management_url` (portail
  client Paddle, fourni par le webhook).

## Test en sandbox (avant la prod)

1. `PADDLE_ENV='sandbox'` + token/price/secret de sandbox.
2. Carte de test Paddle au checkout.
3. Vérifier que le webhook arrive (logs de la fonction) et que
   `guilds.subscription_status` passe à `active`.
4. Simuler un échec de paiement → `past_due` → bandeau affiché.

## Statut de mapping Paddle -> interne

| Paddle | interne | écriture autorisée |
|--------|---------|--------------------|
| trialing | trialing | oui |
| active | active | oui |
| past_due | past_due | oui (période de grâce) |
| paused | read_only | non |
| canceled | canceled | non |
