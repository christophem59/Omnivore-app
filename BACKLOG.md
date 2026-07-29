# Backlog — Omnivore

_Dernière mise à jour : 2026-07-29_

## En cours de traitement

Rien actuellement.

## À faire

### 1. Statuts & cycle de vie d'une série

- **Blocs "Terminé" — nettoyage des actions**
  Retirer tout bouton de la carte elle-même. Dans la modale, ajouter un bouton "Recommencer à regarder" qui remet la progression à 0 et repasse la série en "En cours". Les boutons actuels "Reprendre" et "Marquer comme terminé" deviennent obsolètes et seront à retirer.
- **Distinguer, dans "Terminé", ce qui est définitivement fini de ce qui attend une suite.**
  UI à définir.
- **Ajuster/réinitialiser la progression même quand une série est "Terminé".**
  Probablement couvert par "Recommencer à regarder" ci-dessus — à confirmer une fois ce point traité.
- **Nouvelle section "Abandonné".**
  Règles à définir ; piste envisagée : bascule automatique quand une série "En cours" est supprimée.

### 2. Uniformisation des blocs (modale & interactions)

- **Étendre le fonctionnement "modale"** (déjà en place sur les blocs "En cours") aux blocs "À regarder" et "Terminé".
- **Blocs "À regarder" : affichage similaire aux blocs "En cours"**, pour valider le visionnage de l'épisode 1 directement depuis le bloc et basculer la série en "En cours".
- **Déplacer un titre par cliquer-glisser entre "En cours" et "À regarder".**
  Probablement redondant une fois le point ci-dessus traité — à réévaluer à ce moment-là.

### 3. Gestion des saisons

- **Gestion propre des saisons multiples** : affichage adapté, et vision des saisons/épisodes dans la modale de série.

### 4. Fonctionnalités transverses

- Vue "cette semaine" façon calendrier.
- Recherche / tri / filtre dans l'appli.
- Petites frictions à réduire : marquer "vu" en un tap, file d'attente hors-ligne, export/sauvegarde en un clic.

### 5. Extension du périmètre

- Suivi des mangas via MangaDex, progression par chapitre.
- Support des films (vu/pas vu, note).
- Étudier un découpage de l'app en plusieurs parties : Séries / Mangas / Livres.

### 6. Design

- Refonte graphique de l'app à partir du design en cours de création suite à l'obtention du logo.

## Hors scope pour l'instant

- Notifications push natives (Discord reste le canal).

## Rappel

- Remplacer l'anilist_id de l'Apothicaire (176301 → 195516) à partir du 31 octobre 2026.

## Fait récemment

- Fermeture du panneau d'ajout au clic extérieur.
- Affichage spécifique des résultats déjà dans la watchlist.
- Refonte "En cours" en cartes par épisode avec bouton "✓ Vu", messages de succès, modale de détail.
- Animation de validation adoucie.
- Validation de l'ajustement manuel contre les épisodes réellement diffusés.
- Correction du passage en "Terminé".
- Logos de plateformes de streaming avec infobulle.
- Correction d'un conflit d'écriture (409) sur watchlist.json quand deux titres sont ajoutés quasi simultanément (file d'attente d'écriture + retry automatique).
