:page_with_curl: **CHANGELOG — SHADOWFRONT** :page_with_curl:

**2026-08-02 — Refonte complète (UI/UX + partage Discord)**

L'outil suit désormais le déroulé réel de l'événement : les joueurs déclarent leur dispo **en jeu**, l'admin la saisit ici, compose les squads avec l'historique de fiabilité, puis suit la participation.

:one: **Nouveau parcours en 3 étapes guidées**

L'ancien écran (4 onglets plats) devient un parcours logique :
1. **Availability** — on saisit qui est disponible
2. **Squad Composition** — on compose les squads finaux
3. **Participation Tracking** — on suit la participation

Chaque étape se déverrouille dans l'ordre : impossible de composer sans joueurs saisis, ni de tracker sans squad lancé.

:two: **Étape 1 — Availability, pensée pour l'admin**

- La déclaration ne se fait plus dans l'outil mais **en jeu**. L'admin recueille ici les joueurs disponibles.
- **Deux pools côte à côte** (Squad One / Squad Two — Available) avec taux de participation et puissance : l'équilibrage se voit d'un coup d'œil.
- **Saisie en masse** : recherche + cases à cocher + « Add to Squad One/Two » en un clic.
- Le modèle « Both / None » disparaît : une déclaration en jeu concerne un créneau précis, donc un seul squad.

:three: **Étape 2 — Squad Composition, guidée par l'historique**

- **Seuls les joueurs déclarés** apparaissent dans le pool.
- **Tri par taux de participation par défaut** (bascule Taux / Puissance), catégories de fiabilité 🟢🔵🟡🔴 et filtres.
- **Récap en tête** : pool restant, participants /20, réserves /10, taux de participation moyen.
- Étoiles commandant (max 3) conservées.

:warning: **Composition avant lancement (correction importante)**

Assigner un joueur ne **lance plus l'événement par accident** (l'ancien code activait la session au premier assignement, avec notifications Discord prématurées).
- La session reste **inactive** pendant la composition ; seul « Start » active l'événement.
- Terminer un squad clôture la session ; le prochain lancement démarre une nouvelle session propre, l'historique reste intact.

:paperplane: **Partage de la composition sur Discord**

Nouveau bouton **« Share on Discord »** : un message avec les deux squads (participants, 👑 commandants, réserves, compteurs) envoyé sur le webhook Shadowfront configuré. Idéal pour annoncer les compositions à la guilde.

:chart_with_upwards_trend: **Étape 3 — Tracking rapide**

- Boutons **« All present » / « All absent »** pour les retours de masse.
- Indicateur **« Saved »** discret à chaque enregistrement.
- Flux « Pending / Approve » supprimé (il servait à des auto-déclarations qui n'existent plus).

:wastebasket: **Suppressions**

- **Running Tab** : matrice historique incomplète (l'historique n'était en fait jamais chargé) et redondante avec les badges de taux. L'historique vit désormais dans les badges de fiabilité.

:white_check_mark: **Tests** : 96 tests unitaires, dont 5 nouveaux dédiés à cette refonte.
