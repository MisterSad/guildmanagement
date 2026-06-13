# Runbook : e-mails (Proton) — réception & envoi

> Référence : saas_strategy.md §9 (légal/contact) et §13 (e-mails d'onboarding).
> Adresse retenue : **`fgfguildmanagementtool@proton.me`**.

## Vue d'ensemble

Deux besoins distincts, deux mécanismes :

| Besoin | Adresse | Mécanisme | Disponible |
|--------|---------|-----------|------------|
| **Réception / support / contact** | `fgfguildmanagementtool@proton.me` | Boîte Proton, lue à la main | **Maintenant** (aucune intégration) |
| **Envoi applicatif** (relances, bienvenue) | `noreply@tondomaine` (ou test Resend) | **Resend** (API) via la fonction `send-email`, `Reply-To` = Proton | Fonction prête ; FROM prod = domaine vérifié |
| **E-mails Auth** (confirmation, reset R5) | idem | SMTP Resend dans Supabase Auth | À la mise en place du signup R5 |

> **Décision** : l'envoi applicatif passe par **Resend** (et non le SMTP Proton,
> qui aurait exigé un plan Business + domaine sur Proton). La boîte Proton reste
> l'adresse de **support et de `Reply-To`** : les réponses des utilisateurs y
> arrivent.

## Réception (fait)

`fgfguildmanagementtool@proton.me` est déjà l'adresse de contact dans la landing
(footer EN/FR) et la politique de confidentialité. Les réponses des utilisateurs
y arrivent directement. Rien à configurer.

## Envoi applicatif — Resend

La fonction Edge `supabase/functions/send-email/` envoie via l'**API Resend**.
Elle est livrée mais **non déployée / non câblée** : il manque le secret et un
expéditeur. Elle ne s'ouvre qu'aux appels serveur portant l'en-tête
`x-email-secret`.

### Secrets à régler (Supabase → Edge Functions → Secrets)

```
RESEND_API_KEY   = re_…                      (clé Resend — NE PAS committer)
EMAIL_FN_SECRET  = <chaîne aléatoire forte>   (protège l'endpoint)
EMAIL_FROM       = Guild Management Tool <noreply@tondomaine>   (après vérif domaine)
EMAIL_REPLY_TO   = fgfguildmanagementtool@proton.me            (défaut déjà en code)
```

> ⚠️ La clé fournie a transité par un canal de chat : **régénère-la** dans le
> dashboard Resend après l'avoir posée comme secret.

### Étapes

1. **Domaine Resend** : Resend → Domains → ajouter le domaine, publier les DNS
   (SPF/DKIM/DMARC). Tant que ce n'est pas fait, on ne peut envoyer que depuis le
   domaine de test `onboarding@resend.dev` (et uniquement vers l'e-mail du
   propriétaire du compte) — suffisant pour un premier test.
2. **Poser les secrets** ci-dessus, puis `supabase functions deploy send-email`.
3. **Tester** :
   ```sh
   curl -X POST https://<projet>.supabase.co/functions/v1/send-email \
     -H "x-email-secret: $EMAIL_FN_SECRET" -H "Content-Type: application/json" \
     -d '{"to":"toi@exemple.com","subject":"Test","text":"Hello"}'
   ```
4. **E-mails Auth (R5)** : dans Supabase Auth → SMTP, renseigner le **SMTP
   Resend** (`smtp.resend.com:465`, user `resend`, pass = `RESEND_API_KEY`,
   sender = `EMAIL_FROM`). Cela couvre confirmation d'e-mail + reset de mot de
   passe du R5 quand le signup sera en place.
5. **Câblage** : les flux P6 (bienvenue, relance fin d'essai J-3, échec de
   paiement) appelleront `send-email` (cron/edge), `Reply-To` = Proton.

## Notes

- Les adresses synthétiques `gm_<hash>@no-reply.guildmgmt.app` des comptes GoTrue
  (auth-login/admin-accounts) sont **internes** : elles ne reçoivent jamais d'e-mail
  et servent de clé. Inutile de les changer ; on pourra aligner le domaine plus
  tard (cosmétique) sans casser les comptes existants.
- `VAPID subject` (`event-reminders`) pourra pointer vers `mailto:fgfguildmanagementtool@proton.me`
  (contact pour les services de push) lors d'un prochain déploiement de la fonction.
- Sécurité : les e-mails envoyés via SMTP Proton ne sont pas chiffrés bout-en-bout
  (normal pour du transactionnel), mais stockés avec chiffrement zéro-accès côté
  Proton.
