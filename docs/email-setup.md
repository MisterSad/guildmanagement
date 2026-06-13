# Runbook : e-mails (Proton) — réception & envoi

> Référence : saas_strategy.md §9 (légal/contact) et §13 (e-mails d'onboarding).
> Adresse retenue : **`fgfguildmanagementtool@proton.me`**.

## Vue d'ensemble

Deux besoins distincts, deux mécanismes :

| Besoin | Adresse | Mécanisme | Disponible |
|--------|---------|-----------|------------|
| **Réception / support / contact** | `fgfguildmanagementtool@proton.me` | Boîte Proton, lue à la main | **Maintenant** (aucune intégration) |
| **Envoi applicatif** (confirmations, reset mot de passe, relances) | une adresse de **ton domaine** (ex. `noreply@tondomaine`) | SMTP Proton (jeton) → Supabase Auth + transactionnel | Quand domaine + plan Business existent |

## Réception (fait)

`fgfguildmanagementtool@proton.me` est déjà l'adresse de contact dans la landing
(footer EN/FR) et la politique de confidentialité. Les réponses des utilisateurs
y arrivent directement. Rien à configurer.

## Envoi applicatif — la contrainte Proton

Proton **ne permet pas** d'envoyer du mail applicatif depuis une adresse
`@proton.me` nue :

- Le **jeton SMTP** Proton (la seule voie serveur) exige un **plan Proton for
  Business** et doit être **associé à une adresse sur un domaine personnalisé**.
- Proton **Bridge** enverrait depuis `@proton.me`, mais c'est une appli desktop
  qui doit tourner en permanence → inutilisable pour un backend serverless.

Donc l'envoi applicatif attend l'achat du domaine (cohérent avec le reste : prod
+ Paddle aussi). En attendant, pour le **dev/test** du signup/reset, le SMTP
intégré de Supabase suffit (rate-limité, non destiné à la prod).

## Activation (quand domaine + plan Business)

1. **Domaine sur Proton** : ajouter le domaine à Proton Mail (Business),
   vérifier DNS (MX/SPF/DKIM/DMARC fournis par Proton). `fgfguildmanagementtool@proton.me`
   peut rester l'adresse de support/reply ; le domaine sert à l'envoi.
2. **Jeton SMTP** (proton.me/support/smtp-submission) : Settings → SMTP/IMAP →
   générer un jeton, l'associer à une adresse du domaine (ex. `noreply@tondomaine`).
   Noter l'hôte `smtp.protonmail.ch`, port `587` (STARTTLS), user = l'adresse,
   pass = le jeton.
3. **Supabase Auth → custom SMTP** (Dashboard → Authentication → SMTP) : renseigner
   host/port/user/pass ci-dessus, sender = `noreply@tondomaine`, sender name =
   « Guild Management Tool ». Cela couvre confirmation d'e-mail et reset de mot de
   passe du R5 (P2/P6).
4. **E-mails transactionnels** (relances essai/paiement — P6) : même SMTP via une
   petite fonction Edge `send-email`, ou un fournisseur dédié (Resend/Postmark) si
   on préfère des templates/déliverabilité avancés. `Reply-To` =
   `fgfguildmanagementtool@proton.me` pour centraliser les réponses.

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
