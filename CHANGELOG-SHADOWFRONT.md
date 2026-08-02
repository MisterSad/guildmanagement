# Changelog — Shadowfront

> L'outil suit désormais le déroulé réel de l'événement dans le jeu :
> les joueurs déclarent leur disponibilité **en jeu**, l'admin la saisit ici,
> compose les squads en s'appuyant sur l'historique de fiabilité, puis suit la participation.

## 2026-08-02 — Refonte complète (UI/UX + partage Discord)

### Nouveau parcours en 3 étapes guidées

L'ancien écran (4 onglets plats, sans logique de flux) est remplacé par un
parcours en 3 étapes qui suit l'ordre naturel de l'événement :

1. **Availability** — on saisit qui est disponible
2. **Squad Composition** — on compose les squads finaux
3. **Participation Tracking** — on suit la participation

Chaque étape se déverrouille dans l'ordre : impossible de composer sans joueurs
saisis, impossible de tracker sans squad lancé. Fini la navigation à l'aveugle.

### Étape 1 — Availability : la saisie est pensée pour l'admin

La déclaration ne se fait **plus dans l'outil** mais **en jeu** (dans le jeu,
sur le créneau de l'événement). Le rôle de l'outil est donc de recueillir ces
déclarations :

- **Deux pools côte à côte** : « Squad One — Available » et « Squad Two — Available »,
  avec le taux de participation et la puissance de chaque joueur. L'équilibrage
  entre les deux squads se fait d'un coup d'œil.
- **Saisie en masse** : recherche, cases à cocher, puis « Add to Squad One » /
  « Add to Squad Two » en un clic. Fini la grille à 4 boutons par joueur.
- Le modèle « Both / None » disparaît : une déclaration en jeu concerne un
  créneau précis, donc un seul squad.

### Étape 2 — Squad Composition : l'historique guide la décision

- **Seuls les joueurs déclarés** apparaissent dans le pool (les autres membres
  ne polluent plus la vue).
- **Tri par taux de participation par défaut** (bascule Taux / Puissance) :
  le taux de présence passé devient l'outil de décision principal, avec les
  catégories 🟢 🔵 🟡 🔴 et les filtres par fiabilité.
- **Récapitulatif en tête** : pool restant, participants /20, réserves /10,
  et le taux de participation moyen du squad en cours de composition.
- Étoiles commandant (max 3) conservées.

### Composition avant lancement

Correction de fond importante : assigner un joueur ne **lance plus l'événement**
par accident (l'ancien code activait la session au premier assignement, ce qui
pouvait déclencher notifications et rappels Discord prématurément).

- La session est créée **inactive** pendant la composition ; seul le bouton
  « Start » active l'événement (et envoie la notification Discord au bon moment).
- Terminer un squad clôture la session ; le prochain lancement démarre une
  nouvelle session propre (l'historique de participation reste intact).

### Partage de la composition sur Discord

Nouveau bouton **« Share on Discord »** dans l'étape Composition : un message
unique avec les deux squads — participants (👑 pour les commandants), réserves
et compteurs — envoyé sur le webhook Shadowfront configuré dans les réglages
Discord (ou le webhook général si aucun webhook dédié). Le message respecte le
formatage Discord (échappement des pseudos, mentions sûres).

Utile pour : annoncer les compositions à la guilde, ou les reporter sur un
canal de coordination.

### Étape 3 — Participation Tracking : rapide, sans friction

- **« All present » / « All absent »** pour les retours de masse.
- **Indicateur « Saved »** discret à chaque enregistrement automatique.
- Suppression du flux d'approbation « Pending / Approve », qui ne servait plus
  (il gérait des auto-déclarations de joueurs qui n'existent plus).

### Suppressions

- **Running Tab** : matrice historique incomplète (l'historique n'était en fait
  jamais chargé, seules les sessions en cours s'affichaient) et redondante avec
  les badges de taux. Supprimé ; l'historique vit désormais dans les badges de
  fiabilité des étapes 1 et 2.

### Détail technique

- Nouveau helper partagé `GM.sendDiscordWebhook()` (résolution du webhook par
  événement avec repli sur le webhook général), réutilisé par les notifications
  d'événements existantes.
- Cycle de vie des sessions révisé : session inactive pendant la composition,
  activation au « Start », clôture au « End ».
- 30+ clés de traduction ajoutées/remaniées, styles du stepper, responsivité
  mobile conservée (colonnes empilées sous 900px).
- 5 nouveaux tests unitaires (stepper, saisie, composition, tracking, Discord) —
  96 tests au total.
