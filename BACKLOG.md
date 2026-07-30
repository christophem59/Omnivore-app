# Backlog — Omnivore

_Dernière mise à jour : 2026-07-30_

## En cours de traitement

Rien actuellement.

## À faire

### 1. Uniformisation des blocs (modale & interactions)

- **Blocs "À regarder" : affichage similaire aux blocs "En cours"**, pour valider le visionnage de l'épisode 1 directement depuis le bloc et basculer la série en "En cours".
- **Déplacer un titre par cliquer-glisser entre "En cours" et "À regarder".**
  Probablement redondant une fois le point ci-dessus traité — à réévaluer à ce moment-là.

### 2. Gestion des saisons

- **Vision des saisons/épisodes dans la modale de série** (le regroupement de plusieurs saisons à l'ajout est fait ; reste l'affichage détaillé saison/épisode dans la modale de détail).

### 3. Fonctionnalités transverses

- Vue "cette semaine" façon calendrier.
- Recherche / tri / filtre parmi les séries déjà dans la watchlist (distinct de la recherche d'ajout de titre).
- Petites frictions à réduire : marquer "vu" en un tap, file d'attente hors-ligne, export/sauvegarde en un clic.

### 4. Extension du périmètre

- Suivi des mangas via MangaDex, progression par chapitre.
- Support des films (vu/pas vu, note).
- Étudier un découpage de l'app en plusieurs parties : Séries / Mangas / Livres.
- Lecture vidéo intégrée : embarquer les flux de streaming pour visionner directement depuis l'app plutôt que de rediriger vers le service externe. À creuser (faisabilité technique/légale selon les plateformes).

### 5. Design

- Refonte graphique de l'app à partir du design en cours de création suite à l'obtention du logo.
- Affichage optimisé pour mobile.
- Barre de progression (section "En cours") : utiliser toute la largeur disponible plutôt qu'une largeur fixe.

### 6. Recherche / inspiration

- Regarder l'outil Sickrage (suivi de séries) pour voir ce qui pourrait compléter/inspirer Omnivore.

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
