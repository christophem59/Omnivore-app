# Backlog — Omnivore

_Dernière mise à jour : 2026-07-30_

## En cours de traitement

- Découpage de l'app en catégories (Séries / Animés / Films / Mangas-Scans), affichées en onglets au-dessus de la barre de recherche : phase de maquette design, la logique fonctionnelle derrière (filtrage réel des données par catégorie, etc.) sera abordée une fois la maquette validée.

## À faire

### 1. Fonctionnalités transverses

- Vue "cette semaine" façon calendrier.

### 2. Extension du périmètre

- Suivi des mangas via MangaDex, progression par chapitre.
- Support des films (vu/pas vu, note).
- Regroupement des films façon "Collection" (même principe que le regroupement de saisons anime) — nécessite d'abord la logique de suivi des films ci-dessus.
- Lecture vidéo intégrée : embarquer les flux de streaming pour visionner directement depuis l'app plutôt que de rediriger vers le service externe. À creuser (faisabilité technique/légale selon les plateformes).

### 3. Design

- Refonte graphique de l'app à partir du design en cours de création suite à l'obtention du logo.
- Affichage optimisé pour mobile.
- Barre de progression (section "En cours") : utiliser toute la largeur disponible plutôt qu'une largeur fixe.

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
- Déclencher la recherche de série via la touche Entrée.
- Blocs "Terminé" : bouton unique "Regarder à nouveau" (remplace "Reprendre"/"Marquer comme terminé"), remet la progression à 0 ; historique des passages en "Terminé" conservé et affiché en badge de rewatch sur la carte "En cours" résultante.
- "Terminé" scindé en deux sous-sections : "À jour (suite à venir)" et "Vraiment finies", avec distinction visuelle (bordures/badges colorés).
- Bascule automatique "En cours" → "Terminé" cohérente dans les deux sens de saisie (bouton "✓ Vu" et ajustement manuel du numéro d'épisode).
- Modale de détail étendue aux blocs "À regarder" et "Terminé" (résumé traduit en français, date de fin réelle, streaming) ; toute la carte (hors boutons/badge) l'ouvre au clic.
- Regroupement de plusieurs saisons (recherche anime) en une seule carte de suivi, avec numérotation d'épisode continue.
- Compteurs du nombre de séries par section/sous-section.
- Échap ferme les modales ouvertes.
- Nouvelle section "Abandonné" sous "Terminé" : la poubelle sur une carte "En cours" ouvre une boîte à 4 choix (Annuler / Mettre en pause / Abandonner / Supprimer définitivement) au lieu du simple confirm(). "Mettre en pause" et "Abandonner" conservent la progression ; carte "Abandonné" grisée (bordure pointillée, poster en niveaux de gris) avec bouton "Reprendre" qui repart de la progression conservée (pas de reset à l'épisode 1, contrairement à "Regarder à nouveau").
- Cartes "À regarder" mises en pause : affichent "Dernier épisode regardé : SxxExx" (ou "épisode N" pour un anime) au lieu de "Pas encore commencé".
- Bascule automatique "À jour" → "En cours" dès qu'un nouvel épisode non vu est diffusé (détecté au chargement, sans action de l'utilisateur).
- Cartes "En cours" affichant le dernier épisode connu (sans retard) : mention "Dernier pour l'instant, une suite est prévue" / "Dernier épisode (vraiment)" à la place du vide.
- Bascule automatique "En cours" → "Terminé"/"À jour" dès que le prochain épisode connu n'est pas encore diffusé (complément symétrique de la bascule ci-dessus) : "En cours" ne garde que les séries où il y a vraiment quelque chose à regarder maintenant.
- Blocs "À regarder" : affichage similaire aux blocs "En cours" — bouton "Episode 1 vu" qui valide le visionnage de l'épisode 1 et bascule la série en "En cours" ; "Reprendre" à la place si une progression existait déjà (pas de revalidation, simple bascule).
- Affichage détaillé saison/épisode dans la modale de détail série (calendrier épisode par épisode pour les séries TV ; niveau saison pour les animes, AniList ne donnant pas l'historique des dates passées).
- Ajout d'une saison depuis la modale de détail d'une série déjà ajoutée (anime), avec refus explicite si la saison choisie n'est pas plus récente que la dernière suivie.
- Suppression de la dernière saison depuis la même modale (anime, à partir de 2 saisons), avec ramène automatique de la progression si elle dépassait la saison retirée.
- Cartes "À jour (suite à venir)" : affichage de la date du prochain épisode connu au-dessus du bouton "Regarder à nouveau" ("Pas de date annoncée" si rien n'est encore programmé).
- Recherche/tri/filtre dans la watchlist : champ de recherche au-dessus des sections, filtre les cartes en temps réel sur le titre, déplie automatiquement "À regarder"/"Terminé" s'ils contiennent un résultat masqué.
- Bouton "Ignoré" à côté de "✓ Vu" (cartes "En cours") : passe à l'épisode suivant sans le compter comme vu (épisodes spéciaux), sans apparaître ✓ dans le détail saison/épisode.
- Ratings affichés à côté du streaming, dans la modale de détail (TVMaze /10, AniList /100) et dans les résultats de recherche du panneau d'ajout.
- Veille Sickrage/Sonarr/Radarr : a donné le statut "Ignoré", l'idée des ratings, et l'idée de regroupement "Collection" pour les films.
