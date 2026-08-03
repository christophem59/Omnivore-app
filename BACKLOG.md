# Backlog — Omnivore

_Dernière mise à jour : 2026-08-03_

## En cours de traitement

Rien actuellement.

## À faire

### 1. Fonctionnalités transverses

- Vue "cette semaine" façon calendrier.

### 2. Extension du périmètre

- Suivi des mangas via MangaDex, progression par chapitre.
- Lecture intégrée via serveur média perso (piste ouverte, sans échéance) : intégration Jellyfin/Plex pour lire depuis Omnivore une bibliothèque **de contenu qu'on possède légalement** (fichiers perso, rips de ses propres Blu-ray/DVD), avec marquage "vu" automatique par scrobbling (webhook Jellyfin ou Trakt). Conditionné au fait d'avoir un jour la motivation de constituer cette bibliothèque numérique. Écarté : capter/agréger des flux de streaming externes (illégal, instable) et les serveurs Jellyfin/Plex "partagés" publics (piratage). Le besoin courant "où regarder" est déjà couvert par l'affichage des services de streaming officiels.

_(Section Design vidée : interface mobile et refonte graphique validées — voir "Fait récemment".)_

## Hors scope pour l'instant

- Notifications push natives (Discord reste le canal).

## Fait récemment

- Services de streaming pour les films : récupérés via TMDb (`watch/providers`, région FR) dans le même appel que les détails du film, affichés dans la modale de détail ("Disponible sur : …") comme pour les séries/animes. Abonnement/gratuit/pub uniquement (location/achat exclus). Pour une collection, union des services de tous les volets. Canal+/Arte ajoutés à la table d'icônes.
- Pictogrammes custom (indépendants des polices emoji des plateformes) : picto poubelle néon sur les boutons de suppression des cartes + boutons "Retirer la dernière saison/film" de la modale (variante bleue sur le bouton rouge "Supprimer définitivement" pour le contraste) ; pictos custom pour les 4 onglets de catégorie (Séries, Animés, Films, Mangas/Scans) à la place des emojis, avec libellés agrandis (0.72rem → 0.85rem). Détourés sur fond transparent, servis en local + précachés par le service worker.
- Refonte graphique — palette dérivée de l'icône : fond indigo profond (dégradé) au lieu du gris neutre, rouge crimson en accent (#e21d3c), bleu lentille en secondaire (badges d'info), surfaces de cartes en dégradé, lueur rouge discrète sur carte "En cours"/onglet actif/boutons principaux/FAB, topbar et modales translucides. Uniquement variables `:root` + styles ciblés, logique inchangée. Sauvegarde de l'état précédent sur la branche `sauvegarde-avant-refonte-graphique`.
- Bascule d'id AniList de l'Apothicaire (176301 → 195516) programmée dans le code : s'applique automatiquement au chargement à partir du 31 octobre 2026, sans intervention manuelle (bascule en mémoire, idempotente ; cache épisodes de l'item invalidé pour re-fetch ; l'id corrigé se persiste à la prochaine écriture). Voir SCHEDULED_ANILIST_ID_SWAPS dans app.js.
- Cartes responsives mobile-first : sous ~560px, le corps de la carte prend toute la largeur à côté du poster et les boutons d'action passent sur une ligne dédiée en dessous (au lieu d'être tassés dans une colonne fixe de 170px qui écrasait titre/badges/barre de progression). La poubelle passe en coin haut-droit. Au-dessus de 560px, l'ancienne mise en page en une rangée est conservée.
- Recherche/ajout scopés à la catégorie active : le panneau d'ajout suit désormais l'onglet courant (Séries→série, Animés→anime, Films→film), n'affiche que des résultats de ce type et n'ajoute que dans cette catégorie ; l'ancien sélecteur de type est masqué. La recherche d'ajout dans une collection était déjà scopée par le type de l'item.
- Persistance de la catégorie active (Séries/Animés/Films/Mangas) au rechargement de la page : un cmd+maj+R conserve l'onglet courant au lieu de repartir sur "Séries".
- Ajout d'un volet/saison plus ancien dans une collection : suppression de la règle "doit être plus récent" (ex. les premiers Star Wars, absents de la recherche initiale). Le nouvel élément est ajouté en fin de regroupement, l'ordre se règle ensuite à la main via les flèches ▲/▼.
- Recherche : tri des résultats par date et passage à 20 résultats. Sélection des résultats par popularité (films/TMDb, sur plusieurs pages agrégées) / pertinence (séries) pour éviter que de vieux documentaires/homonymes ne masquent les volets principaux.
- La section de détail d'une collection reste ouverte pendant un réordonnancement ▲/▼ (l'état ouvert/fermé des sections est préservé au rafraîchissement).
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
- Découpage de l'app en catégories (Séries/Animés/Films/Mangas-Scans), affichées en onglets au-dessus de la barre de recherche : Séries/Animés/Films filtrent la vraie watchlist (mêmes sections/cartes/comportements qu'avant, juste scopés par type), Mangas-Scans reste "Bientôt" en attendant ce suivi.
- Support des films (vu/pas vu, note TMDb) + regroupement "Collection" pour les sagas, à la main façon regroupement de saisons anime (recherche + case à cocher + "Regrouper en une série", "+ Ajouter un film"/"🗑 Retirer le dernier film" ensuite dans la modale). Pas de section "En cours" pour les films : une carte reste "À regarder" (même après plusieurs volets vus) jusqu'à bascule directe en "Terminé" ; passe aussi en "À jour (suite à venir)" dès que le prochain volet est annoncé mais pas encore sorti (ex. Dune Part Three), même si on n'a pas tout regardé d'un coup. Correction au passage : le cache d'affiche ne retient plus un échec (auto-guérison), avec nettoyage rétroactif des entrées déjà figées.
- Réordonnancement manuel des volets/saisons d'une collection (films ET animes) : boutons ▲/▼ dans la modale de détail, sur la partie pas encore vue uniquement (jamais sur ce qui est déjà marqué vu, pour ne pas fausser la progression enregistrée) — utile quand l'ordre de sortie ne correspond pas à l'ordre de visionnage voulu (préquelles, etc.).
