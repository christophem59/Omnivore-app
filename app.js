"use strict";

/* =========================================================================
   Omnivore — PWA de suivi séries / animes / mangas
   Lit/écrit directement le repo GitHub (watchlist.json, state.json,
   progress.json) via l'API GitHub Contents, avec un token personnel stocké
   uniquement dans le localStorage du téléphone.
   ========================================================================= */

const LS = {
  owner: "sv_owner",
  repo: "sv_repo",
  branch: "sv_branch",
  token: "sv_token",
  tmdbKey: "sv_tmdb_key",
  posterCache: "sv_poster_cache",
  episodeCache: "sv_episode_cache",
  summaryCache: "sv_summary_cache",
  activeCategory: "sv_active_category",
};

/* ------------------------- Helpers purs (testables) ------------------------- */

function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64DecodeUnicode(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function groupByStatus(items) {
  const groups = { en_cours: [], a_regarder: [], termine: [] };
  for (const item of items) {
    if (groups[item.status]) groups[item.status].push(item);
  }
  return groups;
}

/** Delta (nb d'épisodes de retard) uniquement calculable quand les deux
 * valeurs sont des compteurs absolus comparables (cas des animes). Encore
 * utilisé pour l'affichage des cartes "Terminé" (dernier épisode connu). */
function computeDelta(progressEpisode, latestKnown) {
  if (typeof progressEpisode !== "number" || typeof latestKnown !== "number") {
    return null;
  }
  return latestKnown - progressEpisode;
}

function formatTvLatest(stateEntry) {
  if (!stateEntry) return "Pas encore de donnée";
  if (stateEntry.number !== null && stateEntry.number !== undefined) {
    const s = String(stateEntry.season).padStart(2, "0");
    const n = String(stateEntry.number).padStart(2, "0");
    return `Dernier diffusé : S${s}E${n}`;
  }
  return `Dernier diffusé : Saison ${stateEntry.season} (spécial)`;
}

function formatAnimeLatest(stateEntry) {
  if (!stateEntry || typeof stateEntry.number !== "number") return "Pas encore de donnée";
  return `Dernier diffusé : épisode ${stateEntry.number}`;
}

/** Équivalent film de formatTvLatest/formatAnimeLatest. Le bot de notif
 * externe qui alimente state.json ne connaît pas les films : ce cas
 * renverra donc presque toujours "Pas encore de donnée", et
 * formatLastKnownEpisode retombera sur findLastAiredFromRaw (calculé
 * directement depuis raw.episodes) — gardé pour la cohérence de l'API. */
function formatFilmLatest(stateEntry) {
  if (!stateEntry || typeof stateEntry.number !== "number") return "Pas encore de donnée";
  return `Dernier film vu : volet ${stateEntry.number}`;
}

/** Libellé "Dernier épisode regardé" pour une carte "À regarder" dont la
 * progression n'est pas nulle (ex. titre mis en pause depuis "En cours").
 * Générique ici (numéro brut) ; buildShowCard le complète en "SxxExx" une
 * fois la fiche récupérée pour les séries TV. */
function formatLastWatchedLabel(watchedCount) {
  if (watchedCount <= 0) return "Pas encore commencé";
  return `Dernier épisode regardé : épisode ${watchedCount}`;
}

/** Même logique que scripts/import_csv.py côté Python : id lisible et
 * stable dérivé du titre affiché. */
function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // retire les accents isolés par NFKD
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

/** Ajoute un suffixe -2, -3... si l'id existe déjà, pour ne jamais écraser
 * une entrée existante en cas de titre proche/dupliqué. */
function uniqueId(baseId, existingIds) {
  let id = baseId;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${n}`;
    n++;
  }
  return id;
}

/** Un résultat de recherche est considéré "déjà dans la watchlist" si :
 * - anime avec anilist_id épinglé des deux côtés : comparaison par id exact ;
 * - anime déjà présent en tant que saison d'un titre regroupé (voir
 *   addGroupedAnimeItem) : comparaison par id dans `anilist_seasons` ;
 * - sinon : même type + même search_title (insensible à la casse). */
function isAlreadyAdded(result, items) {
  return items.some((item) => {
    if (result.anilist_id && item.anilist_id) {
      return item.anilist_id === result.anilist_id;
    }
    if (result.anilist_id && Array.isArray(item.anilist_seasons)) {
      return item.anilist_seasons.some((s) => s.anilist_id === result.anilist_id);
    }
    if (result.tmdb_id && item.tmdb_id) {
      return item.tmdb_id === result.tmdb_id;
    }
    if (result.tmdb_id && Array.isArray(item.tmdb_seasons)) {
      return item.tmdb_seasons.some((s) => s.tmdb_id === result.tmdb_id);
    }
    return (
      item.type === result.type &&
      (item.search_title || "").trim().toLowerCase() === (result.search_title || "").trim().toLowerCase()
    );
  });
}

/* --------------------- Logique "prochain épisode" (pure) --------------------- */

/** À partir de la liste complète des épisodes TVmaze (dans l'ordre renvoyé
 * par l'API, qui est l'ordre de diffusion) et du nombre d'épisodes déjà
 * marqués comme vus, déduit tout ce qu'il faut pour afficher la carte
 * "prochain épisode" d'une série TV. `todayStr` est injecté (format
 * "YYYY-MM-DD") pour que la fonction reste pure et testable.
 *
 * raw attendu : { episodes: [...], status: "Ended"|"Running"|..., streaming } */
function deriveTvEpisodeInfo(raw, progressEpisode, todayStr) {
  const episodes = raw.episodes || [];
  const idx = progressEpisode; // 0-indexé : prochain épisode non vu
  const airedCount = episodes.filter((e) => e.airdate && e.airdate <= todayStr).length;

  if (idx >= episodes.length) {
    // Plus aucun épisode connu au-delà de ce qu'on a déjà vu : qu'il s'agisse
    // d'une série officiellement "Ended" ou d'une série "Running"/"To Be
    // Determined" dont TVmaze n'a pas encore listé de suite, on considère
    // qu'on est à jour et on propose de la marquer terminée (confirmation
    // manuelle côté UI, pas de bascule automatique).
    return { kind: "finished", airedCount, totalCount: episodes.length };
  }

  const ep = episodes[idx];
  const hasAired = !!ep.airdate && ep.airdate <= todayStr;
  const extraBehind = Math.max(0, airedCount - (idx + 1));

  return {
    kind: "episode",
    hasAired,
    unknown: false,
    season: ep.season,
    number: ep.number,
    name: ep.name || null,
    airdate: ep.airdate || null,
    summary: ep.summary || null,
    streaming: raw.streaming || null,
    extraBehind,
    airedCount,
    totalCount: episodes.length,
  };
}

/** Regroupe le tableau plat d'épisodes TVmaze (déjà trié par ordre de
 * diffusion) par saison, en conservant l'ordre de première apparition —
 * pour l'affichage détaillé saison/épisode de la modale de détail. Chaque
 * groupe garde l'index global (0-based) de ses épisodes dans le tableau
 * d'origine, pour pouvoir comparer directement à `progress[item.id].episode`
 * sans recalcul. */
function groupEpisodesBySeason(episodes) {
  const groups = [];
  const bySeasonNumber = new Map();
  (episodes || []).forEach((ep, globalIndex) => {
    let group = bySeasonNumber.get(ep.season);
    if (!group) {
      group = { season: ep.season, episodes: [] };
      bySeasonNumber.set(ep.season, group);
      groups.push(group);
    }
    group.episodes.push({ ...ep, globalIndex });
  });
  return groups;
}

/** Choisit, parmi les liens de streaming AniList (rarement structurés
 * précisément par épisode), celui qui correspond au numéro d'épisode visé ;
 * à défaut, le premier lien disponible (mieux que rien). */
function pickAnimeStreaming(streamingEpisodesRaw, targetEpisode) {
  if (!streamingEpisodesRaw || !streamingEpisodesRaw.length) return null;
  const match = streamingEpisodesRaw.find((s) => {
    const m = /episode\s*(\d+)/i.exec(s.title || "");
    return m && parseInt(m[1], 10) === targetEpisode;
  });
  const chosen = match || streamingEpisodesRaw[0];
  if (!chosen || !chosen.site) return null;
  return { name: chosen.site, kind: "streaming", url: chosen.url || null };
}

/** Équivalent anime de deriveTvEpisodeInfo. `nowSec` est injecté (secondes
 * epoch) pour rester testable. raw attendu : { status, totalEpisodes,
 * nextAiringEpisode, airingSchedule, streamingEpisodesRaw }. */
function deriveAnimeEpisodeInfo(raw, progressEpisode, nowSec) {
  const target = progressEpisode + 1;
  const { status, totalEpisodes, nextAiringEpisode, airingSchedule, streamingEpisodesRaw } = raw;

  if (typeof totalEpisodes === "number" && target > totalEpisodes) {
    return { kind: "finished" };
  }
  if (!totalEpisodes && status === "FINISHED" && !nextAiringEpisode && progressEpisode > 0) {
    return { kind: "finished" };
  }

  const scheduleNode = (airingSchedule || []).find((n) => n.episode === target);
  let hasAired;
  let airdate = null;

  if (scheduleNode) {
    hasAired = scheduleNode.airingAt <= nowSec;
    airdate = scheduleNode.airingAt;
  } else if (nextAiringEpisode && nextAiringEpisode.episode === target) {
    hasAired = false;
    airdate = nextAiringEpisode.airingAt;
  } else if (nextAiringEpisode && target < nextAiringEpisode.episode) {
    hasAired = true;
  } else if (!nextAiringEpisode && status === "FINISHED") {
    hasAired = true;
  } else {
    hasAired = false;
  }

  const airedCount = nextAiringEpisode
    ? nextAiringEpisode.episode - 1
    : status === "FINISHED" && totalEpisodes
    ? totalEpisodes
    : progressEpisode;
  const extraBehind = Math.max(0, (airedCount || 0) - target);

  return {
    kind: "episode",
    hasAired,
    unknown: false,
    season: null,
    number: target,
    name: null,
    airdate,
    summary: null, // pas de résumé par épisode disponible côté AniList
    streaming: pickAnimeStreaming(streamingEpisodesRaw, target),
    extraBehind,
    airedCount: airedCount || 0,
    totalCount: totalEpisodes || null,
  };
}

/** Libellé "S01E05" (séries), "Épisode 5" (animes), ou libellé de secours
 * pour les spéciaux / cas inconnus. */
function formatEpisodeTag(itemType, info) {
  if (info.unknown) return "Prochain épisode";
  if (itemType === "film") {
    // Un film ne se pense pas en numéro : le titre du volet lui-même est le
    // repère le plus utile (ex. "Dune : Deuxième Partie").
    return info.name || `Film ${info.number}`;
  }
  if (itemType === "tv") {
    if (info.number === null || info.number === undefined) {
      return info.season ? `Saison ${info.season} (spécial)` : "Épisode spécial";
    }
    return `S${String(info.season).padStart(2, "0")}E${String(info.number).padStart(2, "0")}`;
  }
  return `Épisode ${info.number}`;
}

/** Ligne d'affichage de la date de diffusion, avec gestion des cas où la
 * date exacte n'est pas connue. `airdate` est soit une chaîne "YYYY-MM-DD"
 * (TVmaze), soit un timestamp epoch en secondes (AniList), soit null. */
function formatAirdateDisplay(info, itemType) {
  const [pastWord, futureWord, unknownPast, unknownFuture] =
    itemType === "film"
      ? ["Sorti", "Sortie prévue", "Sorti (date exacte inconnue)", "Sortie prévue (date inconnue)"]
      : ["Diffusé", "À venir", "Diffusé (date exacte inconnue)", "À venir (date inconnue)"];

  if (info.unknown) return "Date inconnue pour l'instant";
  if (info.airdate === null || info.airdate === undefined) {
    return info.hasAired ? unknownPast : unknownFuture;
  }
  let d;
  if (typeof info.airdate === "number") {
    d = new Date(info.airdate * 1000);
  } else {
    d = new Date(`${info.airdate}T00:00:00`);
  }
  const formatted = formatDMY(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return info.hasAired ? `${pastWord} le ${formatted}` : `${futureWord} le ${formatted}`;
}

/** Correspondance nom de service -> icône (Simple Icons, CDN gratuit et
 * sans clé : https://cdn.simpleicons.org/<slug>/<couleur-hex>). Recherche
 * par sous-chaîne insensible à la casse, pour absorber les variantes de
 * nom renvoyées par TVmaze ("Amazon", "Prime Video"...) ou AniList
 * ("Crunchyroll", "Netflix"...). Liste volontairement limitée aux services
 * les plus courants ; les autres retombent sur un badge texte (voir
 * openEpisodeModal). */
const STREAMING_ICON_MAP = [
  { match: "netflix", slug: "netflix", color: "E50914" },
  { match: "disney", slug: "disneyplus", color: "113CCF" },
  { match: "amazon", slug: "primevideo", color: "1F2E4A" },
  { match: "prime video", slug: "primevideo", color: "1F2E4A" },
  { match: "hulu", slug: "hulu", color: "1CE783" },
  { match: "crunchyroll", slug: "crunchyroll", color: "F47521" },
  { match: "funimation", slug: "funimation", color: "5B0BB5" },
  { match: "apple", slug: "appletv", color: "000000" },
  { match: "paramount", slug: "paramountplus", color: "0064FF" },
  { match: "peacock", slug: "peacock", color: "000000" },
  { match: "hbo", slug: "hbo", color: "8B5CF6" },
  { match: "max", slug: "max", color: "002BE7" },
  { match: "youtube", slug: "youtube", color: "FF0000" },
  { match: "canal", slug: "canalplus", color: "000000" },
  { match: "arte", slug: "arte", color: "FF0000" },
];

function getStreamingIcon(serviceName) {
  if (!serviceName) return null;
  const lower = serviceName.toLowerCase();
  const found = STREAMING_ICON_MAP.find((entry) => lower.includes(entry.match));
  return found ? { slug: found.slug, color: found.color } : null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** "JJ/MM/AAAA" : format de date utilisé partout dans l'appli. */
function formatDMY(year, month, day) {
  return `${pad2(day)}/${pad2(month)}/${year}`;
}

/** Date du jour au format "AAAA-MM-JJ" (stockage), utilisée pour horodater
 * le moment où l'utilisateur marque une série "Terminé". */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** "AAAA-MM-JJ" (stockage) -> "JJ/MM/AAAA" (affichage). */
function isoToDMY(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return formatDMY(y, m, d);
}

/** Historique des dates auxquelles une série a été marquée "Terminé"
 * (`item.finished_history`), le plus ancien en premier — sert à la fois à
 * afficher la dernière date et à compter le nombre de fois où la série a
 * été (re)terminée. Compatible avec l'ancien champ `finished_at` (une
 * seule date, avant l'introduction de l'historique). */
function getFinishedHistory(item) {
  if (Array.isArray(item.finished_history)) return item.finished_history;
  if (item.finished_at) return [item.finished_at];
  return [];
}

/** Date de dernière diffusion réelle d'une série, à partir des données
 * brutes TVmaze (`ended`) ou AniList (`endDate`, fuzzy : année seule
 * possible si le jour/mois n'est pas connu). Renvoie `null` si la série
 * n'est en fait pas terminée côté API (ex. l'utilisateur l'a marquée
 * "Terminé" alors qu'elle est toujours en diffusion) : c'est au code
 * appelant de retomber sur le dernier épisode connu dans ce cas plutôt
 * que d'afficher une fausse info. */
function formatSeriesEndDate(itemType, raw) {
  if (itemType === "tv") {
    if (!raw.ended) return null;
    const [y, m, d] = raw.ended.split("-").map(Number);
    return `Diffusée jusqu'au ${formatDMY(y, m, d)}`;
  }
  if (itemType === "film") {
    // Pas d'équivalent au `show.ended` de TVMaze côté TMDb (pas de notion de
    // "franchise fermée") : on se base sur les volets eux-mêmes. Si la
    // collection en liste au moins un au-delà de ceux déjà sortis (annoncé,
    // avec ou sans date encore fixée — ex. Dune Part Three), la franchise
    // est considérée toujours active ("à jour"). Sinon, on la traite par
    // défaut comme réellement finie — limite honnête de ce que TMDb permet
    // de savoir (une franchise peut toujours repartir sans préavis).
    const episodes = raw.episodes || [];
    if (!episodes.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    const releasedCount = episodes.filter((e) => e.airdate && e.airdate <= today).length;
    if (episodes.length > releasedCount) return null;
    const last = episodes[releasedCount - 1] || episodes[episodes.length - 1];
    return last && last.airdate ? `Sortie jusqu'au ${isoToDMY(last.airdate)}` : "Sortie terminée";
  }
  const end = raw.endDate;
  if (!end || !end.year) return null;
  if (end.month && end.day) {
    return `Diffusée jusqu'au ${formatDMY(end.year, end.month, end.day)}`;
  }
  return `Diffusée jusqu'en ${end.year}`;
}

/** Dernier épisode réellement diffusé d'après les données brutes elles-
 * mêmes (indépendamment de state.json), pour les séries jamais suivies
 * "en cours" par le bot de notif (state.json n'a alors aucune entrée). */
function findLastAiredFromRaw(itemType, raw) {
  if (itemType !== "anime") {
    // tv et film partagent la même forme raw.episodes.
    const today = new Date().toISOString().slice(0, 10);
    const aired = (raw.episodes || []).filter((e) => e.airdate && e.airdate <= today);
    if (!aired.length) return null;
    const last = aired[aired.length - 1];
    return { season: last.season, number: last.number, airdateIso: last.airdate, name: last.name };
  }
  const nowSec = Date.now() / 1000;
  const aired = (raw.airingSchedule || []).filter((n) => n.airingAt <= nowSec);
  if (!aired.length) return null;
  const last = aired.reduce((a, b) => (a.episode > b.episode ? a : b));
  return { number: last.episode, airingAt: last.airingAt };
}

/** Libellé "Dernier diffusé : ..." (+ date si on peut la retrouver). Part
 * de state.json (alimenté par le bot de notif) quand il a une entrée pour
 * cette série ; sinon (série jamais suivie "en cours", ex. ajoutée
 * directement en "Terminé") retombe sur le dernier épisode réellement
 * diffusé calculé à partir des données brutes elles-mêmes, plutôt que de
 * rester bloqué sur "Pas encore de donnée" alors qu'on a l'info. */
function formatLastKnownEpisode(itemType, stateEntry, raw) {
  const base =
    itemType === "tv" ? formatTvLatest(stateEntry) : itemType === "film" ? formatFilmLatest(stateEntry) : formatAnimeLatest(stateEntry);

  if (base !== "Pas encore de donnée" && raw) {
    if (itemType !== "anime") {
      const ep = (raw.episodes || []).find(
        (e) => e.season === stateEntry.season && e.number === stateEntry.number
      );
      if (ep && ep.airdate) {
        const [y, m, d] = ep.airdate.split("-").map(Number);
        return `${base} - le ${formatDMY(y, m, d)}`;
      }
      return base;
    }
    const node = (raw.airingSchedule || []).find((n) => n.episode === stateEntry.number);
    if (node) {
      const d = new Date(node.airingAt * 1000);
      return `${base} - le ${formatDMY(d.getFullYear(), d.getMonth() + 1, d.getDate())}`;
    }
    return base;
  }

  if (!raw) return base;
  const found = findLastAiredFromRaw(itemType, raw);
  if (!found) return base;

  if (itemType === "film") {
    const label = `Dernier film vu : ${found.name || "volet " + found.number}`;
    if (!found.airdateIso) return label;
    const [y, m, d] = found.airdateIso.split("-").map(Number);
    return `${label} - le ${formatDMY(y, m, d)}`;
  }

  if (itemType === "tv") {
    const label = `Dernier diffusé : S${pad2(found.season)}E${pad2(found.number)}`;
    if (!found.airdateIso) return label;
    const [y, m, d] = found.airdateIso.split("-").map(Number);
    return `${label} - le ${formatDMY(y, m, d)}`;
  }

  const label = `Dernier diffusé : épisode ${found.number}`;
  if (!found.airingAt) return label;
  const d = new Date(found.airingAt * 1000);
  return `${label} - le ${formatDMY(d.getFullYear(), d.getMonth() + 1, d.getDate())}`;
}

/** Libellé affiché pour une carte/modale "Terminé" : si la série l'est
 * réellement côté API, combine sa date de dernière diffusion avec la date
 * la plus récente à laquelle l'utilisateur l'a lui-même marquée "Terminé"
 * (`item.finished_history`, absent pour les titres marqués avant l'ajout
 * de ce champ — dans ce cas on affiche juste la première partie plutôt
 * que d'inventer une date). Sinon (série toujours en diffusion dans la
 * vraie vie), retombe sur le dernier épisode connu. */
function computeFinishedStatusLabel(item, stateEntry, raw) {
  const endLabel = formatSeriesEndDate(item.type, raw);
  if (!endLabel) return formatLastKnownEpisode(item.type, stateEntry, raw);
  const history = getFinishedHistory(item);
  if (!history.length) return endLabel;
  return `${endLabel} - Terminée le ${isoToDMY(history[history.length - 1])}`;
}

/** Date du prochain épisode pour une carte "À jour (suite à venir)" :
 * n'est appelée que pour ce sous-groupe (voir renderFinishedGroups), où la
 * série est encore en diffusion dans la vraie vie mais où l'utilisateur a
 * déjà vu tout ce qui est connu. Deux cas selon deriveTvEpisodeInfo /
 * deriveAnimeEpisodeInfo : soit un prochain épisode est déjà programmé
 * (date connue), soit rien n'est encore annoncé au-delà (`kind: "finished"`
 * malgré une série toujours active). */
function formatNextEpisodeDate(item, raw) {
  const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
  // tv et film partagent deriveTvEpisodeInfo + un airdate en chaîne
  // "YYYY-MM-DD" (contrairement à l'anime, en secondes epoch) — voir le plan.
  const info =
    item.type !== "anime"
      ? deriveTvEpisodeInfo(raw, progressEpisode, new Date().toISOString().slice(0, 10))
      : deriveAnimeEpisodeInfo(raw, progressEpisode, Date.now() / 1000);
  const label = item.type === "film" ? "Prochain film" : "Prochain épisode";

  if (info.kind === "episode" && info.airdate) {
    if (item.type !== "anime") {
      const [y, m, d] = info.airdate.split("-").map(Number);
      return `${label} le ${formatDMY(y, m, d)}`;
    }
    const d = new Date(info.airdate * 1000);
    return `${label} le ${formatDMY(d.getFullYear(), d.getMonth() + 1, d.getDate())}`;
  }
  return "Pas de date annoncée";
}

/** Liste (dédupliquée) des services de streaming sur lesquels une série
 * "Terminé" est/était disponible. Pour les animes, dérivée des liens par
 * épisode d'AniList (seul endroit où l'info existe côté API) ; pour les
 * séries TV, TVmaze ne renvoie qu'un seul diffuseur/chaîne pour la fiche. */
function getSeriesStreamingList(itemType, raw) {
  if (itemType === "film") {
    return raw.streamingList || [];
  }
  if (itemType === "tv") {
    return raw.streaming ? [raw.streaming] : [];
  }
  const sites = new Set();
  (raw.streamingEpisodesRaw || []).forEach((s) => {
    if (s.site) sites.add(s.site);
  });
  return Array.from(sites).map((name) => ({ name, kind: "streaming" }));
}

/* ------------------------------ Traduction (résumés) ------------------------------ */

/** TVmaze/AniList ne renvoient les résumés qu'en anglais : on convertit le
 * HTML simple (<p>, <br>) en paragraphes de texte brut avant traduction,
 * pour ne pas envoyer de balises à l'API de traduction. */
function stripHtmlToParagraphs(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** L'API MyMemory limite la longueur d'une requête de traduction : on
 * découpe les paragraphes trop longs par phrase plutôt qu'au milieu d'un
 * mot. */
function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + sentence).length > maxLen) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Hash simple (non cryptographique) utilisé comme clé de cache pour les
 * traductions, pour ne jamais retraduire deux fois le même résumé. */
function hashText(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function loadSummaryCache() {
  try {
    return JSON.parse(localStorage.getItem(LS.summaryCache) || "{}");
  } catch {
    return {};
  }
}

function saveSummaryCache(cache) {
  localStorage.setItem(LS.summaryCache, JSON.stringify(cache));
}

async function translateChunk(text) {
  if (!text.trim()) return "";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Service de traduction indisponible");
  const data = await resp.json();
  return (data.responseData && data.responseData.translatedText) || text;
}

/** Traduit un résumé (HTML simple) vers le français via MyMemory, avec
 * mise en cache locale (les résumés ne changent pas) pour éviter de
 * retraduire à chaque ouverture de modale et de gaspiller le quota gratuit. */
async function translateToFrench(html) {
  if (!html) return "";
  const cache = loadSummaryCache();
  const key = hashText(html);
  if (cache[key]) return cache[key].fr;

  const paragraphs = stripHtmlToParagraphs(html);
  if (!paragraphs.length) return "";

  const translatedParagraphs = [];
  for (const paragraph of paragraphs) {
    const chunks = chunkText(paragraph, 480);
    const translatedChunks = [];
    for (const chunk of chunks) {
      translatedChunks.push(await translateChunk(chunk));
    }
    translatedParagraphs.push(translatedChunks.join(" "));
  }
  const result = translatedParagraphs.map((p) => `<p>${p}</p>`).join("");

  const freshCache = loadSummaryCache();
  freshCache[key] = { fr: result, ts: Date.now() };
  saveSummaryCache(freshCache);
  return result;
}

/* ------------------------------ Store GitHub ------------------------------ */

class GitHubStore {
  constructor(owner, repo, branch, token) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
    this.token = token;
    this._shas = {};
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
    };
  }

  async getFile(path) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`;
    const resp = await fetch(url, { headers: this._headers() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Erreur GitHub (${resp.status}) sur ${path} : ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    this._shas[path] = data.sha;
    const text = b64DecodeUnicode(data.content);
    return JSON.parse(text);
  }

  async putFile(path, obj, message) {
    const sha = this._shas[path];
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
    const content = b64EncodeUnicode(JSON.stringify(obj, null, 2) + "\n");
    const resp = await fetch(url, {
      method: "PUT",
      headers: { ...this._headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content, sha, branch: this.branch }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Erreur GitHub (${resp.status}) en écrivant ${path} : ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    this._shas[path] = data.content.sha;
  }
}

/* ------------------------------ Posters ------------------------------ */

function loadPosterCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(LS.posterCache) || "{}");
    // Nettoyage rétroactif : avant la correction de getPoster, un échec
    // pouvait être mis en cache avec `url: null` pour 7 jours (POSTER_TTL_MS)
    // — sans purge, ces entrées figées d'avant-correctif resteraient sans
    // affiche jusqu'à leur expiration naturelle. Le nouveau code n'écrit
    // plus jamais d'entrée sans url, donc ce filtre ne fait rien sur des
    // entrées créées après le correctif.
    let changed = false;
    for (const key of Object.keys(cache)) {
      if (!cache[key] || !cache[key].url) {
        delete cache[key];
        changed = true;
      }
    }
    if (changed) savePosterCache(cache);
    return cache;
  } catch {
    return {};
  }
}

function savePosterCache(cache) {
  localStorage.setItem(LS.posterCache, JSON.stringify(cache));
}

const POSTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function getPoster(item) {
  const cache = loadPosterCache();
  const cached = cache[item.id];
  if (cached && Date.now() - cached.ts < POSTER_TTL_MS) {
    return cached.url;
  }

  let url = null;
  try {
    if (item.type === "tv") {
      const resp = await fetch(
        `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(item.search_title)}`
      );
      if (resp.ok) {
        const show = await resp.json();
        url = show?.image?.medium || null;
      }
    } else if (item.type === "anime") {
      const query = `query($id: Int, $search: String){ Media(id: $id, search: $search, type: ANIME) { coverImage { medium } } }`;
      const variables = item.anilist_id ? { id: item.anilist_id } : { search: item.search_title };
      const resp = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (resp.ok) {
        const payload = await resp.json();
        url = payload?.data?.Media?.coverImage?.medium || null;
      }
    } else if (item.type === "film") {
      const apiKey = getTmdbKey();
      if (apiKey) {
        const tmdbId =
          Array.isArray(item.tmdb_seasons) && item.tmdb_seasons.length ? item.tmdb_seasons[0].tmdb_id : item.tmdb_id;
        const resp = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}`);
        if (resp.ok) {
          const data = await resp.json();
          url = data.poster_path ? `https://image.tmdb.org/t/p/w300${data.poster_path}` : null;
        } else {
          console.warn("TMDb poster : réponse non OK pour", item.id, resp.status);
        }
      }
    }
  } catch (e) {
    console.warn("poster fetch failed for", item.id, e);
  }

  // Ne met en cache qu'un succès : un échec (clé absente au moment du tout
  // premier ajout, panne réseau ponctuelle...) ne doit pas rester bloqué à
  // "pas d'affiche" pendant 7 jours (POSTER_TTL_MS) — on retente au rendu
  // suivant plutôt que de figer un résultat négatif.
  if (url) {
    cache[item.id] = { url, ts: Date.now() };
    savePosterCache(cache);
  }
  return url;
}

/* ------------------------------ Données épisode (réseau + cache) ------------------------------ */

function loadEpisodeCache() {
  try {
    return JSON.parse(localStorage.getItem(LS.episodeCache) || "{}");
  } catch {
    return {};
  }
}

function saveEpisodeCache(cache) {
  localStorage.setItem(LS.episodeCache, JSON.stringify(cache));
}

const EPISODE_TTL_MS = 6 * 60 * 60 * 1000; // 6h : assez frais pour les dates de diffusion

/** Récupère (et met en cache) les données brutes nécessaires au calcul du
 * "prochain épisode" pour un item TV. Épingle automatiquement tvmaze_id
 * dans watchlist.json au passage si l'item ne l'avait pas encore (même
 * esprit que l'épinglage manuel d'anilist_id, mais fait tout seul). */
async function fetchTvRaw(item) {
  let tvmazeId = item.tvmaze_id;
  if (!tvmazeId) {
    const resp = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(item.search_title)}`);
    if (!resp.ok) throw new Error(`TVmaze : recherche impossible pour ${item.display_title}`);
    const show = await resp.json();
    tvmazeId = show.id;
    item.tvmaze_id = tvmazeId;
    await store.putFile("watchlist.json", watchlist, `Épinglage tvmaze_id : ${item.id}`);
  }

  const resp2 = await fetch(`https://api.tvmaze.com/shows/${tvmazeId}?embed=episodes`);
  if (!resp2.ok) throw new Error(`TVmaze : détails indisponibles pour ${item.display_title}`);
  const show = await resp2.json();
  const episodes = (show._embedded && show._embedded.episodes) || [];
  const streaming = show.webChannel
    ? { name: show.webChannel.name, kind: "streaming" }
    : show.network
    ? { name: show.network.name, kind: "broadcast" }
    : null;
  const rating = show.rating && show.rating.average != null ? show.rating.average : null;

  return {
    episodes,
    status: show.status,
    streaming,
    summary: show.summary || null,
    ended: show.ended || null,
    rating,
  };
}

/** Requête AniList brute pour une seule fiche (une saison), par id ou par
 * recherche texte. Factorisé pour être réutilisé aussi bien pour un item
 * anime "simple" que pour chacune des saisons d'un item groupé (voir
 * fetchAnimeRawGrouped). */
async function queryAnilistMedia({ id, search, label }) {
  const query = `
    query ($id: Int, $search: String) {
      Media(id: $id, search: $search, type: ANIME) {
        id
        status
        episodes
        description
        seasonYear
        averageScore
        endDate { year month day }
        nextAiringEpisode { episode airingAt }
        airingSchedule(perPage: 50) { nodes { episode airingAt } }
        streamingEpisodes { title url site }
      }
    }`;
  const variables = id ? { id } : { search };
  const resp = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`AniList : indisponible pour ${label}`);
  const payload = await resp.json();
  const media = payload.data && payload.data.Media;
  if (!media) throw new Error(`AniList : aucune fiche trouvée pour ${label}`);
  return media;
}

function mapAnilistMediaToRaw(media) {
  return {
    status: media.status,
    totalEpisodes: media.episodes,
    description: media.description || null,
    seasonYear: media.seasonYear || null,
    rating: media.averageScore != null ? media.averageScore : null,
    endDate: media.endDate || null,
    nextAiringEpisode: media.nextAiringEpisode,
    airingSchedule: (media.airingSchedule && media.airingSchedule.nodes) || [],
    streamingEpisodesRaw: media.streamingEpisodes || [],
  };
}

/** Équivalent TV de fetchTvRaw pour un titre anime regroupant plusieurs
 * saisons (chacune une fiche AniList distincte, voir addGroupedAnimeItem) :
 * fusionne les saisons dans un seul objet "brut", avec une numérotation
 * d'épisode continue à travers les saisons (saison 2 épisode 1 = épisode
 * global N+1 où N est le total de la saison 1), pour que le reste du
 * calcul (deriveAnimeEpisodeInfo, etc.) n'ait pas à connaître la notion de
 * saison. Dès qu'une saison a un total d'épisodes inconnu (rare : saison
 * antérieure toujours listée "en cours" sur AniList), on arrête de fusionner
 * les données de planning des saisons suivantes plutôt que de placer des
 * épisodes à un numéro global potentiellement faux. */
async function fetchAnimeRawGrouped(item) {
  const seasonsMedia = await Promise.all(
    item.anilist_seasons.map((season) =>
      queryAnilistMedia({ id: season.anilist_id, label: season.search_title || item.display_title })
    )
  );
  const seasonsData = seasonsMedia.map(mapAnilistMediaToRaw);

  let offset = 0;
  let offsetReliable = true;
  const airingSchedule = [];
  const streamingEpisodesRaw = [];
  const seasons = [];
  let nextAiringEpisode = null;

  seasonsData.forEach((season, idx) => {
    const isLast = idx === seasonsData.length - 1;
    // offsetStart capturé avant le traitement de cette saison : tant que
    // offsetReliable tient, c'est le numéro d'épisode global (0-based) où
    // commence cette saison ; sinon (total d'une saison précédente inconnu)
    // impossible de dire à quel épisode global elle démarre.
    seasons.push({
      anilist_id: item.anilist_seasons[idx].anilist_id,
      label: item.anilist_seasons[idx].search_title,
      totalEpisodes: season.totalEpisodes,
      status: season.status,
      year: season.seasonYear,
      offsetStart: offsetReliable ? offset : null,
    });
    if (offsetReliable) {
      season.airingSchedule.forEach((node) => {
        airingSchedule.push({ episode: node.episode + offset, airingAt: node.airingAt });
      });
      if (isLast && season.nextAiringEpisode) {
        nextAiringEpisode = {
          episode: season.nextAiringEpisode.episode + offset,
          airingAt: season.nextAiringEpisode.airingAt,
        };
      }
    }
    streamingEpisodesRaw.push(...season.streamingEpisodesRaw);

    if (typeof season.totalEpisodes === "number") {
      offset += season.totalEpisodes;
    } else {
      offsetReliable = false;
    }
  });

  const last = seasonsData[seasonsData.length - 1];
  return {
    status: last.status,
    totalEpisodes: offsetReliable ? offset : null,
    description: last.description,
    rating: last.rating,
    endDate: last.status === "FINISHED" ? last.endDate : null,
    nextAiringEpisode,
    airingSchedule,
    streamingEpisodesRaw,
    seasons,
  };
}

/** Équivalent anime de fetchTvRaw. Épingle anilist_id automatiquement si
 * absent (titre "simple", une seule saison). Les titres regroupant
 * plusieurs saisons (`anilist_seasons`) passent par fetchAnimeRawGrouped. */
async function fetchAnimeRaw(item) {
  if (Array.isArray(item.anilist_seasons) && item.anilist_seasons.length) {
    return fetchAnimeRawGrouped(item);
  }

  const media = await queryAnilistMedia({
    id: item.anilist_id,
    search: item.search_title,
    label: item.display_title,
  });

  if (!item.anilist_id) {
    item.anilist_id = media.id;
    await store.putFile("watchlist.json", watchlist, `Épinglage anilist_id : ${item.id}`);
  }

  const raw = mapAnilistMediaToRaw(media);
  raw.seasons = [
    {
      anilist_id: item.anilist_id,
      label: item.search_title,
      totalEpisodes: raw.totalEpisodes,
      status: raw.status,
      year: raw.seasonYear,
      offsetStart: 0,
    },
  ];
  return raw;
}

/** Région utilisée pour les services de streaming des films (TMDb renvoie
 * les providers par pays). L'app est en français, donc France par défaut. */
const TMDB_REGION = "FR";

/** Catégories TMDb de services : `STREAM_CATS` = compris dans un abonnement
 * ou gratuit (avec ou sans pub) ; `RENT_BUY_CATS` = à louer / acheter. On
 * les affiche séparément (voir renderFilmStreaming) pour bien distinguer
 * "inclus" de "payant à l'acte". */
const STREAM_CATS = ["flatrate", "free", "ads"];
const RENT_BUY_CATS = ["rent", "buy"];

/** Extrait les noms de services d'un film TMDb récupéré avec
 * `append_to_response=watch/providers`, pour la région TMDB_REGION et les
 * catégories demandées. TMDb tire ces données de JustWatch ; on n'affiche
 * que le nom des services (pas de deep-link). */
function extractFilmProviders(movie, cats = STREAM_CATS) {
  const results = movie && movie["watch/providers"] && movie["watch/providers"].results;
  const region = results && results[TMDB_REGION];
  if (!region) return [];
  const names = [];
  for (const cat of cats) {
    (region[cat] || []).forEach((p) => {
      if (p && p.provider_name) names.push(p.provider_name);
    });
  }
  return names;
}

/** Transforme une liste de noms de services en entrées `{name, kind}`
 * dédupliquées (en préservant l'ordre), au format attendu par
 * renderStreamingList / getSeriesStreamingList. */
function dedupeStreaming(names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, kind: "streaming" });
    }
  }
  return out;
}

/** Équivalent film de fetchTvRaw/fetchAnimeRaw : renvoie EXACTEMENT la même
 * forme générique ({episodes, streaming, summary, rating}) pour que tout le
 * moteur déjà écrit pour la TV (deriveTvEpisodeInfo, applyEpisodeProgress,
 * groupByStatus, fillSeasonsSection...) fonctionne sans modification.
 * Chaque "episode" est un film, `season` toujours 1. Deux cas, exactement
 * comme pour l'anime : film seul (`item.tmdb_id`) ou regroupement manuel de
 * plusieurs films (`item.tmdb_seasons`, même principe qu'`anilist_seasons` —
 * recherche + case à cocher + "Regrouper en une série" à l'ajout, "+
 * Ajouter un film"/"Retirer le dernier film" ensuite dans la modale de
 * détail). L'ordre du tableau fait foi (pas de retri automatique derrière
 * le dos de l'utilisateur) : un nouvel ajout arrive toujours en fin de
 * liste, comme pour les saisons anime. */
async function fetchFilmRaw(item) {
  const apiKey = getTmdbKey();
  if (!apiKey) {
    throw new Error("Clé API TMDb manquante : ajoute-la dans Paramètres.");
  }

  // `append_to_response=watch/providers` : les services de streaming
  // arrivent dans le même appel que les détails du film (pas de requête
  // réseau supplémentaire par film).
  const detailUrl = (id) =>
    `https://api.themoviedb.org/3/movie/${id}?api_key=${apiKey}&language=fr-FR&append_to_response=watch/providers`;

  if (Array.isArray(item.tmdb_seasons) && item.tmdb_seasons.length) {
    const movies = await Promise.all(
      item.tmdb_seasons.map((s) =>
        fetch(detailUrl(s.tmdb_id)).then((resp) => {
          if (!resp.ok) throw new Error(`TMDb : détails indisponibles pour ${s.search_title || item.display_title}`);
          return resp.json();
        })
      )
    );
    const episodes = movies.map((movie, idx) => ({
      season: 1,
      number: idx + 1,
      airdate: movie.release_date || null,
      name: movie.title,
      summary: movie.overview || null,
      rating: typeof movie.vote_average === "number" ? movie.vote_average : null,
      streamingList: dedupeStreaming(extractFilmProviders(movie)),
      rentBuyList: dedupeStreaming(extractFilmProviders(movie, RENT_BUY_CATS)),
    }));
    const last = episodes[episodes.length - 1];
    return {
      episodes,
      streaming: null,
      // Union (dédupliquée) des services de tous les volets de la
      // collection — approximation volontaire : "la saga est dispo sur…".
      streamingList: dedupeStreaming(movies.flatMap((m) => extractFilmProviders(m))),
      rentBuyList: dedupeStreaming(movies.flatMap((m) => extractFilmProviders(m, RENT_BUY_CATS))),
      summary: (movies[movies.length - 1] && movies[movies.length - 1].overview) || null,
      rating: last ? last.rating : null,
    };
  }

  const resp = await fetch(detailUrl(item.tmdb_id));
  if (!resp.ok) throw new Error(`TMDb : détails indisponibles pour ${item.display_title}`);
  const movie = await resp.json();
  const streamingList = dedupeStreaming(extractFilmProviders(movie));
  const rentBuyList = dedupeStreaming(extractFilmProviders(movie, RENT_BUY_CATS));
  const episodes = [
    {
      season: 1,
      number: 1,
      airdate: movie.release_date || null,
      name: movie.title,
      summary: movie.overview || null,
      rating: typeof movie.vote_average === "number" ? movie.vote_average : null,
      streamingList,
      rentBuyList,
    },
  ];

  return {
    episodes,
    streaming: null,
    streamingList,
    rentBuyList,
    summary: movie.overview || null,
    rating: episodes[0].rating,
  };
}

async function fetchRawEpisodeData(item, { forceRefresh } = {}) {
  const cache = loadEpisodeCache();
  const cached = cache[item.id];
  if (!forceRefresh && cached && Date.now() - cached.ts < EPISODE_TTL_MS) {
    // Auto-cicatrisation : une fiche film mise en cache AVANT l'ajout des
    // services de streaming n'a pas de `streamingList` — on la refetch pour
    // l'alimenter (sinon il faudrait attendre l'expiration du TTL de 6h).
    const staleFilm = item.type === "film" && cached.data && cached.data.streamingList === undefined;
    if (!staleFilm) return cached.data;
  }
  const data =
    item.type === "tv" ? await fetchTvRaw(item) : item.type === "anime" ? await fetchAnimeRaw(item) : await fetchFilmRaw(item);
  const freshCache = loadEpisodeCache();
  freshCache[item.id] = { data, ts: Date.now() };
  saveEpisodeCache(freshCache);
  return data;
}

/** Calcule les infos du prochain épisode à regarder pour un item "en cours",
 * à partir des données réseau (éventuellement en cache) et de la
 * progression actuelle stockée dans progress.json. */
async function getNextEpisodeInfo(item, opts = {}) {
  const raw = await fetchRawEpisodeData(item, opts);
  const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
  if (item.type !== "anime") {
    // tv et film partagent deriveTvEpisodeInfo (même forme raw.episodes).
    const today = new Date().toISOString().slice(0, 10);
    return deriveTvEpisodeInfo(raw, progressEpisode, today);
  }
  return deriveAnimeEpisodeInfo(raw, progressEpisode, Date.now() / 1000);
}

/* ------------------------------ Recherche (ajout de titre) ------------------------------ */

/** Nombre de résultats affichés par recherche (relevé de 8 à 20 pour laisser
 * remonter des volets plus anciens/moins populaires, ex. les premiers Star
 * Wars, que l'API ne classe pas dans son top de pertinence). */
const SEARCH_RESULT_LIMIT = 20;

/** Comparateur de résultats de recherche par année de sortie croissante
 * (du plus ancien au plus récent) ; les résultats sans année connue sont
 * renvoyés en fin de liste. Utilisé pour classer par date les résultats de
 * recherche (panneau d'ajout et mini-recherche d'ajout de saison/film). */
function compareSearchResultsByYear(a, b) {
  const ya = parseInt(a.year, 10);
  const yb = parseInt(b.year, 10);
  const aMissing = isNaN(ya);
  const bMissing = isNaN(yb);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return ya - yb;
}

/** Recherche TVmaze multi-résultats (contrairement à singlesearch utilisé
 * ailleurs, qui ne renvoie qu'un seul "meilleur" résultat). */
async function searchTvmazeMulti(query) {
  const resp = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  // TVmaze renvoie déjà ses correspondances par pertinence : on garde les
  // 20 premières (les plus pertinentes) PUIS on les affiche triées par date,
  // pour ne pas masquer la bonne série derrière de vieux homonymes.
  return data
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((entry) => ({
      type: "tv",
      title: entry.show.name,
      search_title: entry.show.name,
      year: entry.show.premiered ? entry.show.premiered.slice(0, 4) : "",
      image: entry.show.image ? entry.show.image.medium : null,
      status: entry.show.status,
      rating: entry.show.rating && entry.show.rating.average != null ? entry.show.rating.average : null,
    }))
    .sort(compareSearchResultsByYear);
}

/** Recherche AniList multi-résultats via Page(media:...), pour laisser
 * choisir la bonne fiche parmi plusieurs saisons/films/OVA homonymes. */
async function searchAnilistMulti(query) {
  const q = `
    query ($search: String) {
      Page(page: 1, perPage: 20) {
        media(search: $search, type: ANIME) {
          id
          title { romaji english }
          coverImage { medium }
          status
          episodes
          seasonYear
          averageScore
        }
      }
    }`;
  const resp = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables: { search: query } }),
  });
  if (!resp.ok) return [];
  const payload = await resp.json();
  const list = (payload.data && payload.data.Page && payload.data.Page.media) || [];
  return list
    .map((m) => ({
      type: "anime",
      title: m.title.romaji || m.title.english,
      search_title: m.title.romaji || m.title.english,
      anilist_id: m.id,
      year: m.seasonYear || "",
      rating: m.averageScore != null ? m.averageScore : null,
      image: m.coverImage ? m.coverImage.medium : null,
      status: m.status,
    }))
    .sort(compareSearchResultsByYear)
    .slice(0, SEARCH_RESULT_LIMIT);
}

/** Nombre de pages TMDb agrégées par recherche (20 films/page). TMDb classe
 * `search/movie` par popularité et non par date : se limiter à la page 1
 * laissait de côté des volets anciens mais pertinents (ex. "Le Retour du
 * Jedi" sur la requête "Star Wars", noyé sous les séries/LEGO/spin-offs).
 * On agrège plusieurs pages pour élargir le vivier AVANT le tri par date. */
const TMDB_SEARCH_PAGES = 3;

/** Recherche TMDb multi-résultats (films). Renvoie la même forme générique
 * déjà consommée telle quelle par le rendu des résultats du panneau
 * d'ajout (title/year/image/status/rating) — voir searchTvmazeMulti /
 * searchAnilistMulti. Agrège jusqu'à TMDB_SEARCH_PAGES pages puis trie par
 * date : un film ancien mais pertinent (hors du top popularité) remonte. */
async function searchTmdbMulti(query) {
  const apiKey = getTmdbKey();
  if (!apiKey) return [];
  const base = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&language=fr-FR&query=${encodeURIComponent(query)}`;

  const first = await fetch(`${base}&page=1`);
  if (!first.ok) return [];
  const firstPayload = await first.json();

  // Pages supplémentaires (2..N) récupérées en parallèle, bornées par le
  // nombre réel de pages annoncé par TMDb.
  const totalPages = Math.min(firstPayload.total_pages || 1, TMDB_SEARCH_PAGES);
  const extraPages = [];
  for (let p = 2; p <= totalPages; p++) extraPages.push(p);
  const extraPayloads = await Promise.all(
    extraPages.map((p) =>
      fetch(`${base}&page=${p}`)
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .catch(() => ({ results: [] }))
    )
  );

  const rawResults = [firstPayload, ...extraPayloads].flatMap((pl) => pl.results || []);
  const today = new Date().toISOString().slice(0, 10);
  // On SÉLECTIONNE par popularité, pas par date : trier tout le vivier par
  // date ferait remonter les vieux documentaires/spéciaux (making-of 1977,
  // Holiday Special 1978, docs SPFX…) qui éjectaient les films principaux
  // (ex. "L'Empire contre-attaque" 1980, "Le Retour du Jedi" 1983) des 20
  // places affichées. On garde donc les 20 plus populaires (= les films de
  // la saga), PUIS on les affiche triés par date.
  return rawResults
    .filter((m) => m && m.id)
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((m) => ({
      type: "film",
      title: m.title,
      search_title: m.title,
      tmdb_id: m.id,
      year: m.release_date ? m.release_date.slice(0, 4) : "",
      status: !m.release_date || m.release_date > today ? "À venir" : null,
      rating: typeof m.vote_average === "number" && m.vote_average > 0 ? m.vote_average : null,
      image: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : null,
    }))
    .sort(compareSearchResultsByYear);
}

/** Note à afficher sous un résultat de recherche (panneau d'ajout / mini-
 * recherche d'ajout de saison), même échelle par source que
 * formatRatingLabel mais sans le nom de la source (déjà évident ici, tout
 * est côté TVmaze ou AniList selon l'onglet Série/Anime choisi). */
function formatSearchResultRating(r) {
  if (r.rating == null) return "";
  return r.type === "anime" ? ` · Note : ${r.rating}/100` : ` · Note : ${r.rating}/10`;
}

/* ------------------------------ App state ------------------------------ */

let store = null;
let watchlist = null;
let state = null;
let progress = null;

// Item actuellement affiché dans la modale de détail (episode-modal) : mémorisé
// pour que les actions "ajouter/retirer une saison" de cette même modale sachent
// sur quel item agir, sans avoir à le refaire remonter depuis chaque bouton.
let modalItem = null;

// Onglet de catégorie actuellement affiché ("series"/"animes" ont une vraie
// watchlist filtrée par type ; "films"/"manga" n'ont pas encore de support
// et affichent un simple message "Bientôt" — voir renderCategoryChrome.
let activeCategory = "series";

/** "series"/"animes" seulement : les deux seules catégories qui ont
 * réellement une logique de suivi aujourd'hui. */
function isRealCategory(category) {
  return category === "series" || category === "animes" || category === "films";
}

/** Type d'item (tv/anime/film) correspondant à une catégorie d'onglet.
 * Sert à scoper le panneau d'ajout sur la catégorie active : on n'ajoute
 * que dans la catégorie affichée (voir initAddPanel). Défaut "tv" pour
 * "series" (et pour toute valeur inattendue). */
function categoryToAddType(category) {
  if (category === "animes") return "anime";
  if (category === "films") return "film";
  return "tv";
}

/** Sous-ensemble de la watchlist à afficher pour l'onglet actif. Ne filtre
 * que par `item.type` (tv/anime) : le reste du pipeline de rendu (statuts,
 * sous-groupes, cartes...) est totalement inchangé, juste appliqué à un
 * sous-ensemble d'items. */
function itemsForActiveCategory() {
  if (activeCategory === "series") return watchlist.items.filter((i) => i.type === "tv");
  if (activeCategory === "animes") return watchlist.items.filter((i) => i.type === "anime");
  if (activeCategory === "films") return watchlist.items.filter((i) => i.type === "film");
  return [];
}

const CATEGORY_PLACEHOLDER = {
  manga: {
    icon: "📖",
    title: "Mangas/Scans arrive bientôt",
    text: "Le suivi des mangas/scans (progression par chapitre, MangaDex) est encore au backlog.",
  },
};

/** Bascule l'affichage entre les sections habituelles (Séries/Animés) et le
 * message "Bientôt" (Films/Mangas), et masque le bouton flottant d'ajout
 * pour ces deux dernières catégories (rien à y ajouter pour l'instant). */
function renderCategoryChrome() {
  const sectionsEl = document.getElementById("category-sections");
  const placeholderEl = document.getElementById("category-placeholder");
  const addBtn = document.getElementById("btn-add");
  const groupEnCours = document.getElementById("group-en-cours");
  const isReal = isRealCategory(activeCategory);

  sectionsEl.classList.toggle("hidden", !isReal);
  placeholderEl.classList.toggle("hidden", isReal);
  addBtn.classList.toggle("hidden", !isReal);

  // Pas de section "En cours" pour les films (voir le plan "Support des
  // films") : un film est soit "à regarder", soit "terminé", jamais entre
  // les deux — la carte reste dans "À regarder" tant que la collection
  // n'est pas entièrement vue (voir buildShowCard).
  groupEnCours.classList.toggle("hidden", activeCategory === "films");

  if (!isReal) {
    const meta = CATEGORY_PLACEHOLDER[activeCategory];
    placeholderEl.querySelector(".ph-icon").textContent = meta.icon;
    placeholderEl.querySelector(".ph-title").textContent = meta.title;
    placeholderEl.querySelector(".ph-text").textContent = meta.text;
  }
}

/* ------------------------------ Rendering ------------------------------ */

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Petite animation de confirmation sur la carte elle-même (indépendante
 * du toast, qui lui n'apparaît que quand on rattrape/termine une série) :
 * un ✓ vert qui pulse et s'efface, pour rendre visible le fait qu'on vient
 * de valider un épisode même si un autre suit immédiatement derrière. */
function flashWatched(cardEl, variant) {
  return new Promise((resolve) => {
    const badge = document.createElement("div");
    badge.className = variant === "ignored" ? "watched-flash-badge ignored-flash-badge" : "watched-flash-badge";
    badge.textContent = variant === "ignored" ? "⏭" : "✓";
    cardEl.appendChild(badge);
    cardEl.classList.add(variant === "ignored" ? "ignored-flash" : "watched-flash");
    setTimeout(resolve, 950);
  });
}

/** Petit message de succès temporaire, en haut de l'écran. */
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3500);
}

/** Toast affiché quand une série vient d'être marquée "Terminé" : distingue
 * si elle est réellement finie (rien de plus à venir, même critère que
 * pour le classement "Vraiment finies"/"À jour") ou si elle va atterrir en
 * "À jour" (une suite est prévue) — pour ne pas dire "terminé" alors que
 * la série continue. */
function showFinishedStatusToast(item, raw) {
  if (formatSeriesEndDate(item.type, raw)) {
    showToast(`"${item.display_title}" terminé !`);
  } else {
    showToast(`Vous êtes à jour sur "${item.display_title}", la suite arrive !`);
  }
}

/** Carte "série" classique (affiche + statut) pour la section À regarder.
 * Comme pour les cartes épisode, le corps de la carte est cliquable et
 * ouvre la modale de détail ; les boutons d'action internes stoppent la
 * propagation pour ne pas déclencher l'ouverture de la modale en même
 * temps. La section Terminé a sa propre carte (buildFinishedCard),
 * puisqu'elle a besoin de la fiche complète *avant* de savoir dans quel
 * sous-groupe elle va (voir renderFinishedGroups). */
async function buildShowCard(item) {
  const card = el("div", "card not-started card-clickable");
  card.addEventListener("click", () => openUpcomingModal(item));

  const img = el("img", "poster");
  img.alt = item.display_title;
  card.appendChild(img);
  getPoster(item).then((url) => {
    if (url) img.src = url;
  });

  const body = el("div", "card-body");
  body.appendChild(el("p", "card-title", item.display_title));

  // Une progression existante (titre mis en pause depuis "En cours", voir
  // pauseWatching) veut dire que ce n'est pas un premier démarrage : on
  // affiche le dernier épisode regardé plutôt que "Pas encore commencé".
  const watchedCount = (progress[item.id] && progress[item.id].episode) || 0;
  const subEl = el("p", "card-sub", formatLastWatchedLabel(watchedCount));
  body.appendChild(subEl);

  if (watchedCount > 0 && item.type === "tv") {
    // Numéro générique affiché tout de suite, remplacé par "SxxExx" une
    // fois la fiche récupérée (souvent déjà en cache si le titre était
    // "En cours" il y a peu).
    fetchRawEpisodeData(item)
      .then((raw) => {
        const ep = raw.episodes && raw.episodes[watchedCount - 1];
        if (ep) {
          subEl.textContent = `Dernier épisode regardé : S${pad2(ep.season)}E${pad2(ep.number)}`;
        }
      })
      .catch(() => {
        // on garde le libellé générique déjà affiché
      });
  } else if (watchedCount > 0 && item.type === "film") {
    // Même principe que TV, mais un film se repère par son titre plutôt
    // que par un numéro (voir formatEpisodeTag).
    fetchRawEpisodeData(item)
      .then((raw) => {
        const ep = raw.episodes && raw.episodes[watchedCount - 1];
        if (ep) {
          subEl.textContent = `Dernier film vu : ${ep.name}`;
        }
      })
      .catch(() => {
        // on garde le libellé générique déjà affiché
      });
  }

  card.appendChild(body);

  // Même colonne d'actions et même style (bordure rouge) que "Regarder à
  // nouveau" sur les cartes "Terminé" : les deux boutons font basculer
  // une carte vers "En cours" et méritent d'être visuellement cohérents.
  // Si une progression existait déjà (titre mis en pause), le bouton se
  // contente de reprendre là où on était, sans revalider l'épisode 1.
  // Exception film : pas de section "En cours" pour ce type (voir le plan),
  // donc pas de bascule de statut du tout ici — juste "Vu", qui marque le
  // prochain volet et ne fait passer en "Terminé" que quand tout est vu.
  const isFilm = item.type === "film";
  const actions = el("div", "card-actions");
  const startLabel = isFilm ? "Vu" : watchedCount > 0 ? "Reprendre" : "Episode 1 vu";
  const startBtn = el("button", "small-btn watch-again", startLabel);
  startBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    startBtn.textContent = "…";
    startBtn.disabled = true;
    try {
      if (isFilm) {
        await markEpisodeWatched(item);
        return; // markEpisodeWatched a déjà déclenché son propre renderAll()
      }
      await startWatching(item.id);
      if (watchedCount > 0) {
        showToast(`"${item.display_title}" : c'est parti !`);
      } else {
        await markEpisodeWatched(item);
        return; // markEpisodeWatched a déjà déclenché son propre renderAll()
      }
    } catch (e) {
      alert(e.message);
    }
    renderAll();
  });
  actions.appendChild(startBtn);
  card.appendChild(actions);

  const deleteBtn = el("button", "card-delete");
  deleteBtn.title = "Retirer ce titre";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = confirm(`Retirer "${item.display_title}" de la watchlist ?`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await removeItem(item.id);
      await renderAll();
    } catch (e) {
      alert(e.message);
      deleteBtn.disabled = false;
    }
  });
  card.appendChild(deleteBtn);

  return card;
}

/** Carte pour une série "Terminé". `raw` est déjà résolu au moment de
 * l'appel (voir renderFinishedGroups) puisqu'il faut savoir si la série
 * est réellement finie *avant* de choisir dans quel sous-groupe la
 * ranger ; `reallyFinished` pilote à la fois ce choix et le badge visuel
 * "À jour". */
async function buildFinishedCard(item, raw, reallyFinished) {
  const card = el("div", "card card-clickable");
  card.classList.add(reallyFinished ? "really-finished" : "awaiting-more");

  const stateEntry = state[item.id];
  card.addEventListener("click", () => openFinishedModal(item, stateEntry));

  const img = el("img", "poster");
  img.alt = item.display_title;
  card.appendChild(img);
  getPoster(item).then((url) => {
    if (url) img.src = url;
  });

  const body = el("div", "card-body");
  body.appendChild(el("p", "card-title", item.display_title));

  const label = raw
    ? computeFinishedStatusLabel(item, stateEntry, raw)
    : item.type === "tv"
    ? formatTvLatest(stateEntry)
    : item.type === "film"
    ? formatFilmLatest(stateEntry)
    : formatAnimeLatest(stateEntry);
  body.appendChild(el("p", "card-sub", label));

  if (reallyFinished) {
    body.appendChild(
      el("span", "badge reallyfinished", item.type === "film" ? "Film(s) vraiment fini(s)" : "Série vraiment finie")
    );
  } else {
    body.appendChild(el("span", "badge uptodate", "À jour · suite à venir"));
  }

  card.appendChild(body);

  // Colonne d'actions séparée du corps de la carte, comme sur les cartes
  // "En cours" (✓ Vu / ✎ Ajuster) : le bouton s'aligne ainsi sur la même
  // colonne verticale plutôt que d'être coincé sous le texte.
  const actions = el("div", "card-actions");
  if (!reallyFinished && raw) {
    actions.appendChild(el("p", "next-episode-date", formatNextEpisodeDate(item, raw)));
  }
  const watchAgainBtn = el("button", "small-btn watch-again", "Regarder à nouveau");
  watchAgainBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    watchAgainBtn.disabled = true;
    try {
      await watchAgain(item.id);
      showToast(`"${item.display_title}" : c'est reparti depuis l'épisode 1 !`);
      await renderAll();
    } catch (e) {
      alert(e.message);
      watchAgainBtn.disabled = false;
    }
  });
  actions.appendChild(watchAgainBtn);
  card.appendChild(actions);

  const deleteBtn = el("button", "card-delete");
  deleteBtn.title = "Retirer ce titre";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = confirm(`Retirer "${item.display_title}" de la watchlist ?`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await removeItem(item.id);
      await renderAll();
    } catch (e) {
      alert(e.message);
      deleteBtn.disabled = false;
    }
  });
  card.appendChild(deleteBtn);

  return card;
}

/** Carte pour un titre "Terminé" / "Abandonné". Contrairement aux deux
 * autres sous-groupes, l'abandon est un choix de l'utilisateur (pas une
 * fiche à vérifier auprès de l'API) : pas de fetch réseau, juste le
 * dernier épisode enregistré et un bouton pour reprendre là où on s'était
 * arrêté (contrairement à "Regarder à nouveau", qui repart de zéro). */
async function buildAbandonedCard(item) {
  const card = el("div", "card abandoned card-clickable");

  const stateEntry = state[item.id];
  card.addEventListener("click", () => openFinishedModal(item, stateEntry));

  const img = el("img", "poster");
  img.alt = item.display_title;
  card.appendChild(img);
  getPoster(item).then((url) => {
    if (url) img.src = url;
  });

  const body = el("div", "card-body");
  body.appendChild(el("p", "card-title", item.display_title));

  const watched = (progress[item.id] && progress[item.id].episode) || 0;
  const label = watched > 0 ? `Abandonnée à l'épisode ${watched}` : "Abandonnée avant le premier épisode";
  body.appendChild(el("p", "card-sub", label));
  body.appendChild(el("span", "badge abandoned-badge", "Abandonné"));

  card.appendChild(body);

  const actions = el("div", "card-actions");
  const resumeBtn = el("button", "small-btn watch-again", "Reprendre");
  resumeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    resumeBtn.disabled = true;
    try {
      await resumeAbandoned(item.id);
      showToast(`"${item.display_title}" : on reprend où tu t'étais arrêté !`);
      await renderAll();
    } catch (e) {
      alert(e.message);
      resumeBtn.disabled = false;
    }
  });
  actions.appendChild(resumeBtn);
  card.appendChild(actions);

  const deleteBtn = el("button", "card-delete");
  deleteBtn.title = "Retirer ce titre";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = confirm(`Retirer "${item.display_title}" de la watchlist ?`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await removeItem(item.id);
      await renderAll();
    } catch (e) {
      alert(e.message);
      deleteBtn.disabled = false;
    }
  });
  card.appendChild(deleteBtn);

  return card;
}

/** Carte "épisode à regarder" (section En cours). Façon TV Time : le bloc
 * représente le prochain épisode non vu, pas la série dans son ensemble. */
async function buildEpisodeCard(item) {
  const card = el("div", "card episode-card");
  // Référence à la barre de progression (si affichée), pour aligner le
  // badge de rewatch dessus une fois la carte attachée au DOM (voir plus
  // bas). Reste `null` quand il n'y a pas de retard à afficher.
  let progressBarEl = null;

  let info;
  try {
    info = await getNextEpisodeInfo(item);
  } catch (e) {
    const body = el("div", "card-body");
    body.appendChild(el("p", "card-title", item.display_title));
    body.appendChild(el("p", "card-sub error-inline", `Impossible de récupérer les épisodes : ${e.message}`));
    card.appendChild(body);
    const deleteBtn = el("button", "card-delete");
    deleteBtn.title = "Retirer ce titre";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteChoiceModal(item);
    });
    card.appendChild(deleteBtn);
    return card;
  }

  if (info.kind === "finished") {
    // La série n'a plus rien à proposer (bot ou API externe l'ont marquée
    // "Ended"/"FINISHED" entre deux ouvertures de l'appli) : on ne bascule
    // pas tout seul, on demande confirmation.
    const img = el("img", "poster");
    img.alt = item.display_title;
    card.appendChild(img);
    getPoster(item).then((url) => {
      if (url) img.src = url;
    });

    const body = el("div", "card-body");
    body.appendChild(el("p", "card-title", item.display_title));
    body.appendChild(el("p", "card-sub", "Tu es à jour, et la série est terminée."));
    const confirmBtn = el("button", "small-btn", "Marquer comme terminé");
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      try {
        const raw = await fetchRawEpisodeData(item); // déjà en cache, vient de servir à calculer `info`
        await markFinished(item.id);
        showFinishedStatusToast(item, raw);
        await renderAll();
      } catch (e) {
        alert(e.message);
        confirmBtn.disabled = false;
      }
    });
    body.appendChild(confirmBtn);
    card.appendChild(body);

    const deleteBtn = el("button", "card-delete");
    deleteBtn.title = "Retirer ce titre";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteChoiceModal(item);
    });
    card.appendChild(deleteBtn);
    return card;
  }

  if (!info.hasAired) card.classList.add("upcoming");
  if (!info.unknown) {
    card.classList.add("card-clickable");
    card.addEventListener("click", () => openEpisodeModal(item, info));
  }

  const img = el("img", "poster");
  img.alt = item.display_title;
  card.appendChild(img);
  getPoster(item).then((url) => {
    if (url) img.src = url;
  });

  const clickableArea = el("div", "card-body");
  clickableArea.appendChild(el("p", "card-title", item.display_title));

  const tag = el("span", "badge episode-tag", formatEpisodeTag(item.type, info));
  clickableArea.appendChild(tag);

  clickableArea.appendChild(el("p", "card-sub", formatAirdateDisplay(info, item.type)));

  if (info.extraBehind > 0) {
    const row = el("div", "episode-progress-row");
    row.appendChild(el("span", "badge behind", `${info.extraBehind} épisodes restants`));

    // Avancée globale sur la série (épisodes vus / total connu), pas
    // seulement le retard immédiat affiché ci-dessus. Repli sur le nombre
    // d'épisodes déjà diffusés si le total final n'est pas encore connu
    // (ex. anime toujours en cours de diffusion).
    const watchedCount = (progress[item.id] && progress[item.id].episode) || 0;
    const totalForBar =
      typeof info.totalCount === "number" && info.totalCount > 0 ? info.totalCount : info.airedCount;
    if (typeof totalForBar === "number" && totalForBar > 0) {
      const pct = Math.max(0, Math.min(100, (watchedCount / totalForBar) * 100));
      const bar = el("span", "episode-progress");
      bar.title = `${watchedCount} / ${totalForBar} épisode(s) vu(s)`;
      const fill = el("span", "episode-progress-fill");
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
      progressBarEl = bar;
    }

    clickableArea.appendChild(row);
  } else if (info.hasAired && !info.unknown) {
    // Aucun retard : l'épisode affiché est le dernier connu déjà diffusé.
    // Plutôt que de ne rien afficher, précise si une suite est prévue ou
    // si c'est vraiment la fin (même critère que "Vraiment finies" vs "À
    // jour" côté "Terminé").
    try {
      const raw = await fetchRawEpisodeData(item); // déjà en cache, vient de servir à calculer `info`
      const reallyFinished = formatSeriesEndDate(item.type, raw) !== null;
      clickableArea.appendChild(
        el(
          "span",
          reallyFinished ? "badge reallyfinished" : "badge uptodate",
          reallyFinished ? "Dernier épisode (vraiment)" : "Dernier pour l'instant, une suite est prévue"
        )
      );
    } catch {
      // pas de mention si la fiche n'est pas disponible, plutôt que planter la carte
    }
  }

  card.appendChild(clickableArea);

  const actions = el("div", "card-actions");

  if (!info.unknown) {
    const watchedBtn = el("button", "small-btn primary-inline", "✓ Vu");
    watchedBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      watchedBtn.disabled = true;
      try {
        // En parallèle plutôt qu'en séquence : l'animation ne doit pas
        // retarder la mise à jour du numéro d'épisode affiché.
        await Promise.all([flashWatched(card), markEpisodeWatched(item)]);
      } catch (err) {
        alert(err.message);
        watchedBtn.disabled = false;
      }
    });
    actions.appendChild(watchedBtn);

    // À côté de "✓ Vu" : passe à l'épisode suivant sans le compter comme vu
    // (épisode spécial qu'on ne regarde pas, par exemple) — voir ignoreEpisode.
    const ignoreBtn = el("button", "small-btn", "Ignoré");
    ignoreBtn.title = "Passer cet épisode sans le marquer comme vu (ex. épisode spécial)";
    ignoreBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      ignoreBtn.disabled = true;
      try {
        await Promise.all([flashWatched(card, "ignored"), ignoreEpisode(item)]);
      } catch (err) {
        alert(err.message);
        ignoreBtn.disabled = false;
      }
    });
    actions.appendChild(ignoreBtn);
  }

  const adjustBtn = el("button", "small-btn", "✎ Ajuster");
  adjustBtn.title = "Corriger manuellement le numéro d'épisode vu";
  adjustBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const current = (progress[item.id] && progress[item.id].episode) || 0;
    const maxAllowed = typeof info.airedCount === "number" ? info.airedCount : null;
    const promptLabel =
      maxAllowed !== null
        ? `Dernier épisode vu (nombre, ${maxAllowed} déjà diffusé(s) pour l'instant) :`
        : "Dernier épisode vu (nombre) :";
    const value = prompt(promptLabel, String(current));
    if (value === null) return;
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) return;
    if (maxAllowed !== null && parsed > maxAllowed) {
      alert(
        `"${item.display_title}" n'a pour l'instant que ${maxAllowed} épisode(s) diffusé(s) : impossible de passer à l'épisode ${parsed}.`
      );
      return;
    }
    try {
      // Même bascule automatique vers "Terminé" que le bouton "✓ Vu" si ce
      // numéro correspond à la fin de la série connue (ex. 180 pour une
      // série qui en compte exactement 180).
      const raw = await fetchRawEpisodeData(item);
      await applyEpisodeProgress(item, parsed, raw);
      await renderAll();
    } catch (err) {
      alert(err.message);
    }
  });
  actions.appendChild(adjustBtn);

  card.appendChild(actions);

  const deleteBtn = el("button", "card-delete");
  deleteBtn.title = "Retirer ce titre";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDeleteChoiceModal(item);
  });
  card.appendChild(deleteBtn);

  // Compteur de rewatchs : uniquement pour les séries réellement finies
  // (pas de sens pour une série "à jour" toujours en diffusion) déjà
  // marquées "Terminé" au moins une fois par le passé. Best effort : pas
  // de badge si la fiche complète n'est pas disponible, plutôt que de
  // planter la carte pour un détail secondaire.
  const history = getFinishedHistory(item);
  if (history.length) {
    try {
      const raw = await fetchRawEpisodeData(item);
      if (formatSeriesEndDate(item.type, raw)) {
        const badge = el("span", "rewatch-badge", String(history.length));
        badge.title = `Marquée "Terminé" le :\n${history.map(isoToDMY).join("\n")}`;
        // N'ouvre pas la modale : c'est une info secondaire, pas une action.
        badge.addEventListener("click", (e) => e.stopPropagation());
        card.appendChild(badge);

        // Alignement précis (même ligne que la barre de progression, même
        // colonne que l'icône poubelle) : dépend du rendu réel de la carte
        // une fois attachée au DOM, donc mesuré plutôt que deviné en CSS.
        // Sans barre de progression affichée, on garde le repli "coin
        // bas-droit" défini en CSS.
        requestAnimationFrame(() => {
          if (progressBarEl) {
            badge.style.top = `${
              progressBarEl.offsetTop + progressBarEl.offsetHeight / 2 - badge.offsetHeight / 2
            }px`;
            badge.style.bottom = "auto";
          }
          badge.style.left = `${
            deleteBtn.offsetLeft + deleteBtn.offsetWidth / 2 - badge.offsetWidth / 2
          }px`;
          badge.style.right = "auto";
        });
      }
    } catch {
      // ignore
    }
  }

  return card;
}

function showEpisodeModal() {
  document.getElementById("episode-modal").classList.remove("hidden");
}

/** Note moyenne d'une série/anime (échelle propre à chaque source, la
 * fiche ne donne accès qu'à celle-là) : TVmaze (`rating.average`, /10) ou
 * AniList (`averageScore`, /100). `null` si la fiche externe n'en fournit
 * pas (fréquent pour les titres très récents ou confidentiels). */
function formatRatingLabel(itemType, raw) {
  if (raw.rating == null) return null;
  if (itemType === "tv") return `Note : ${raw.rating}/10 sur TVMaze`;
  if (itemType === "film") return `Note : ${raw.rating}/10 sur TMDb`;
  return `Note : ${raw.rating}/100 sur AniList`;
}

/** Affiche une liste de services de streaming (0, 1 ou plusieurs) dans la
 * modale, suivie de la note moyenne si connue (voir formatRatingLabel).
 * Factorisé pour être réutilisé aussi bien par la modale "prochain épisode"
 * (0 ou 1 service) que par la modale "Terminé" (peut en avoir plusieurs,
 * côté anime). */
/** Ajoute les logos (ou repli texte) d'une liste de services à un élément,
 * sans le vider (utilisé par renderStreamingList et renderFilmStreaming). */
function appendStreamingEntries(target, list) {
  for (const entry of list) {
    const icon = getStreamingIcon(entry.name);
    if (icon) {
      const img = document.createElement("img");
      img.className = "streaming-logo";
      img.src = `https://cdn.simpleicons.org/${icon.slug}/${icon.color}`;
      img.alt = entry.name;
      img.title = entry.name;
      img.onerror = () => {
        const fallback = el("span", "streaming-fallback", entry.name);
        fallback.title = entry.name;
        img.replaceWith(fallback);
      };
      target.appendChild(img);
    } else {
      const fallback = el("span", "streaming-fallback", entry.name);
      fallback.title = entry.name;
      target.appendChild(fallback);
    }
  }
}

function renderStreamingList(streamingEl, list, ratingLabel) {
  streamingEl.innerHTML = "";
  if (!list.length) {
    streamingEl.appendChild(document.createTextNode("Streaming légal : non disponible"));
    if (ratingLabel) streamingEl.appendChild(document.createTextNode(` - ${ratingLabel}`));
    return;
  }

  const prefix = list.length === 1 && list[0].kind === "broadcast" ? "Diffusé sur : " : "Disponible sur : ";
  streamingEl.appendChild(document.createTextNode(prefix));
  appendStreamingEntries(streamingEl, list);
  if (ratingLabel) streamingEl.appendChild(document.createTextNode(` - ${ratingLabel}`));
}

/** Rendu streaming spécifique aux films : deux lignes distinctes —
 * "Disponible sur :" (abonnement/gratuit, voir STREAM_CATS) et
 * "Location / achat :" (rent/buy, voir RENT_BUY_CATS) — pour bien séparer
 * ce qui est inclus de ce qui est payant à l'acte. */
function renderFilmStreaming(streamingEl, raw, ratingLabel) {
  streamingEl.innerHTML = "";
  const stream = raw.streamingList || [];
  const rentBuy = raw.rentBuyList || [];

  const line1 = el("div", "streaming-line");
  if (!stream.length) {
    line1.appendChild(document.createTextNode("Streaming inclus : non disponible"));
  } else {
    line1.appendChild(document.createTextNode("Disponible sur : "));
    appendStreamingEntries(line1, stream);
  }
  if (ratingLabel) line1.appendChild(document.createTextNode(` - ${ratingLabel}`));
  streamingEl.appendChild(line1);

  if (rentBuy.length) {
    const line2 = el("div", "streaming-line streaming-rentbuy");
    line2.appendChild(document.createTextNode("Location / achat : "));
    appendStreamingEntries(line2, rentBuy);
    streamingEl.appendChild(line2);
  }
}

/** Traduit un résumé en anglais (HTML simple) et l'injecte dans la modale
 * une fois prêt, sans bloquer le reste de l'affichage (comme pour
 * l'affiche, chargée elle aussi de façon asynchrone). En cas d'échec de
 * traduction, retombe sur le résumé original plutôt que de rester bloqué
 * sur "Traduction…". */
function fillTranslatedSummary(summaryEl, rawSummary) {
  if (!rawSummary) {
    summaryEl.textContent = "";
    summaryEl.classList.add("hidden");
    return;
  }
  summaryEl.textContent = "Traduction…";
  summaryEl.classList.remove("hidden");
  translateToFrench(rawSummary)
    .then((fr) => {
      summaryEl.innerHTML = fr;
    })
    .catch(() => {
      summaryEl.innerHTML = rawSummary;
    });
}

/** Remplit la modale de détail avec les infos "prochain épisode" (utilisé
 * pour En cours, et pour À regarder une fois l'épisode 1 récupéré). Ne
 * gère volontairement pas l'affichage de la modale elle-même, pour pouvoir
 * l'ouvrir immédiatement avec un état "Chargement…" pendant le fetch.
 * `ratingLabel` (voir formatRatingLabel) est optionnel : absent quand cette
 * fonction sert au tout premier rendu synchrone, avant que `raw` (donc la
 * note) ne soit disponible — voir openEpisodeModal qui la réaffiche ensuite. */
function fillEpisodeModalContent(item, info, ratingLabel) {
  const titleEl = document.getElementById("episode-modal-title");
  const tagEl = document.getElementById("episode-modal-tag");
  const airdateEl = document.getElementById("episode-modal-airdate");
  const summaryEl = document.getElementById("episode-modal-summary");
  const streamingEl = document.getElementById("episode-modal-streaming");

  titleEl.textContent = item.display_title;
  tagEl.textContent = formatEpisodeTag(item.type, info);
  airdateEl.textContent = formatAirdateDisplay(info, item.type);

  fillTranslatedSummary(summaryEl, item.type !== "anime" ? info.summary : null);
  renderStreamingList(streamingEl, info.streaming ? [info.streaming] : [], ratingLabel);
}

function setModalPoster(item) {
  const posterEl = document.getElementById("episode-modal-poster");
  posterEl.src = "";
  getPoster(item).then((url) => {
    if (url) posterEl.src = url;
  });
}

/** Traduit un statut AniList en libellé français court, pour l'affichage
 * saison par saison côté anime. */
function formatAnilistStatus(status) {
  switch (status) {
    case "FINISHED":
      return "Terminée";
    case "RELEASING":
      return "En diffusion";
    case "NOT_YET_RELEASED":
      return "Pas encore diffusée";
    case "CANCELLED":
      return "Annulée";
    case "HIATUS":
      return "En pause";
    default:
      return status || "Statut inconnu";
  }
}

/** Affiche/masque les actions "+ Ajouter une saison" / "🗑 Retirer la
 * dernière saison" : propres aux fiches anime (le regroupement
 * multi-saisons est une notion AniList, voir anilist_seasons) ; le retrait
 * ne s'affiche qu'à partir de 2 saisons (avec une seule, "retirer la
 * dernière" reviendrait à supprimer tout le titre — déjà couvert par la
 * poubelle de la carte). */
function updateSeasonActionsVisibility(item) {
  const actionsEl = document.getElementById("episode-modal-season-actions");
  const addBtn = document.getElementById("btn-open-add-season");
  const removeBtn = document.getElementById("btn-remove-last-season");
  const isAnime = item.type === "anime";
  const isFilm = item.type === "film";
  const isGroupable = isAnime || isFilm;

  actionsEl.classList.toggle("hidden", !isGroupable);
  addBtn.classList.toggle("hidden", !isGroupable);
  addBtn.textContent = isFilm ? "+ Ajouter un film" : "+ Ajouter une saison";

  const hasMultipleSeasons = isFilm
    ? Array.isArray(item.tmdb_seasons) && item.tmdb_seasons.length >= 2
    : Array.isArray(item.anilist_seasons) && item.anilist_seasons.length >= 2;
  removeBtn.classList.toggle("hidden", !hasMultipleSeasons);
  // Même picto poubelle que les cartes (voir .btn-trash-ico) plutôt que
  // l'emoji, pour un rendu identique sur toutes les plateformes.
  removeBtn.innerHTML = `<img class="btn-trash-ico" src="icon-trash.png" alt="" /> ${
    isFilm ? "Retirer le dernier film" : "Retirer la dernière saison"
  }`;
}

/** Échange deux entrées adjacentes (voir swapUnwatchedEntries) puis
 * rafraîchit la section saisons de la modale et les cartes de fond —
 * factorisé ici puisque appelé depuis plusieurs boutons (▲/▼) construits
 * dynamiquement par fillSeasonsSection. */
async function reorderAndRefresh(item, arrayField, index, watchedBoundary, btn) {
  btn.disabled = true;
  try {
    await swapUnwatchedEntries(item.id, arrayField, index, watchedBoundary);
    const freshRaw = await fetchRawEpisodeData(item, { forceRefresh: true });
    const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
    fillSeasonsSection(item, freshRaw, progressEpisode, progress[item.id] && progress[item.id].ignored);
    await renderAll();
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  }
}

/** Remplit la section "détail saison/épisode" de la modale à partir de la
 * fiche brute déjà récupérée (`raw`, voir fetchTvRaw/fetchAnimeRaw). Pour
 * la TV, TVmaze fournit l'historique complet des épisodes (numéro + date) :
 * un vrai calendrier par saison est possible (groupEpisodesBySeason). Pour
 * l'anime, AniList (`airingSchedule`) ne fournit que le planning à venir,
 * jamais les dates des épisodes déjà diffusés : le détail reste au niveau
 * de la saison (libellé, total, statut, nombre vus), voir raw.seasons
 * (fetchAnimeRaw / fetchAnimeRawGrouped).
 *
 * Pour un regroupement à plusieurs entrées (item.tmdb_seasons côté film,
 * item.anilist_seasons côté anime), chaque entrée pas encore vue reçoit des
 * boutons ▲/▼ pour corriger l'ordre de visionnage (voir
 * swapUnwatchedEntries) — jamais sur ce qui est déjà vu. */
function fillSeasonsSection(item, raw, progressEpisode, ignoredIndices) {
  const container = document.getElementById("episode-modal-seasons");
  // Mémoriser quels <details> étaient ouverts avant de tout reconstruire :
  // sinon un rafraîchissement (notamment un déplacement ▲/▼) referme la
  // section, obligeant à la rouvrir entre chaque clic. Le nombre et l'ordre
  // des <details> sont stables sur un réordonnancement, donc l'index suffit.
  const wasOpen = Array.from(container.querySelectorAll("details.season-detail")).map((d) => d.open);
  container.innerHTML = "";
  const ignoredSet = new Set(ignoredIndices || []);

  if (item.type === "film" && (raw.episodes || []).length <= 1) {
    // Film seul (pas de collection) : rien à décomposer, la modale (note,
    // résumé, sortie) suffit déjà — voir le plan "Support des films".
    updateSeasonActionsVisibility(item);
    return;
  }

  if (item.type === "tv" || item.type === "film") {
    const isFilm = item.type === "film";
    // Un film n'a pas de notion de saison : tous ses "épisodes" partagent
    // season:1 (voir fetchFilmRaw), donc groupEpisodesBySeason produit un
    // seul groupe — le libellé est adapté en conséquence.
    const groups = groupEpisodesBySeason(raw.episodes);
    groups.forEach((group) => {
      const watchedInSeason = group.episodes.filter(
        (ep) => ep.globalIndex < progressEpisode && !ignoredSet.has(ep.globalIndex)
      ).length;
      const details = el("details", "season-detail");
      const heading = isFilm
        ? `Films de la collection (${watchedInSeason}/${group.episodes.length} vus)`
        : `Saison ${group.season} (${watchedInSeason}/${group.episodes.length} épisodes vus)`;
      details.appendChild(el("summary", null, heading));
      const body = el("div", "season-detail-body season-episode-list");
      const canReorder = isFilm && Array.isArray(item.tmdb_seasons) && item.tmdb_seasons.length > 1;
      group.episodes.forEach((ep) => {
        const reached = ep.globalIndex < progressEpisode;
        const isIgnored = reached && ignoredSet.has(ep.globalIndex);
        const watched = reached && !isIgnored;
        const row = el("p", `season-episode-row${watched ? " watched" : ""}`);
        const label = isFilm ? ep.name : `S${pad2(ep.season)}E${pad2(ep.number)}${ep.name ? " — " + ep.name : ""}`;
        row.appendChild(el("span", null, label));
        const badgeText = watched ? "✓" : isIgnored ? "Ignoré" : ep.airdate || "?";
        const badge = el("span", "season-episode-check", badgeText);
        if (isIgnored) badge.classList.add("ignored");
        row.appendChild(badge);

        // Réordonnancement : jamais sur ce qui est déjà vu (voir
        // swapUnwatchedEntries) — seule la partie "pas encore vue" peut être
        // réarrangée, pour corriger un ordre de sortie qui ne correspond pas
        // à l'ordre de visionnage voulu (ex. Star Wars, préquelles sorties
        // après coup).
        if (canReorder && !reached) {
          const moveControls = el("span", "season-reorder");
          const upBtn = el("button", "season-reorder-btn", "▲");
          upBtn.type = "button";
          upBtn.title = "Avancer ce film";
          upBtn.disabled = ep.globalIndex - 1 < progressEpisode;
          upBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            reorderAndRefresh(item, "tmdb_seasons", ep.globalIndex - 1, progressEpisode, upBtn);
          });
          const downBtn = el("button", "season-reorder-btn", "▼");
          downBtn.type = "button";
          downBtn.title = "Reculer ce film";
          downBtn.disabled = ep.globalIndex + 1 >= group.episodes.length;
          downBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            reorderAndRefresh(item, "tmdb_seasons", ep.globalIndex, progressEpisode, downBtn);
          });
          moveControls.appendChild(upBtn);
          moveControls.appendChild(downBtn);
          row.appendChild(moveControls);
        }

        body.appendChild(row);
      });
      details.appendChild(body);
      container.appendChild(details);
    });
  } else {
    const seasonsArr = raw.seasons || [];
    // Réordonnancement : seules les saisons entièrement pas-encore-abordées
    // peuvent être réarrangées (voir swapUnwatchedEntries) — la première
    // saison où la progression n'a même pas atteint son offset de départ,
    // et toutes celles d'après.
    const firstUnstartedSeasonIdx = seasonsArr.findIndex(
      (s) => s.offsetStart != null && progressEpisode <= s.offsetStart
    );
    const canReorderAnime = Array.isArray(item.anilist_seasons) && item.anilist_seasons.length > 1;

    seasonsArr.forEach((season, idx) => {
      const total = season.totalEpisodes;
      let watched =
        season.offsetStart == null || total == null
          ? null
          : Math.max(0, Math.min(total, progressEpisode - season.offsetStart));
      if (watched != null) {
        const ignoredInSeason = Array.from(ignoredSet).filter(
          (i) => i >= season.offsetStart && i < season.offsetStart + total
        ).length;
        watched = Math.max(0, watched - ignoredInSeason);
      }
      const countLabel =
        total != null && watched != null ? `${watched}/${total} épisodes vus` : "nombre d'épisodes inconnu";
      const label = season.label ? ` — ${season.label}` : "";
      const details = el("details", "season-detail");
      const summary = el("summary", null, `Saison ${idx + 1}${label} (${countLabel})`);

      if (canReorderAnime && firstUnstartedSeasonIdx !== -1 && idx >= firstUnstartedSeasonIdx) {
        const moveControls = el("span", "season-reorder");
        const upBtn = el("button", "season-reorder-btn", "▲");
        upBtn.type = "button";
        upBtn.title = "Avancer cette saison";
        upBtn.disabled = idx - 1 < firstUnstartedSeasonIdx;
        upBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          reorderAndRefresh(item, "anilist_seasons", idx - 1, firstUnstartedSeasonIdx, upBtn);
        });
        const downBtn = el("button", "season-reorder-btn", "▼");
        downBtn.type = "button";
        downBtn.title = "Reculer cette saison";
        downBtn.disabled = idx + 1 >= seasonsArr.length;
        downBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          reorderAndRefresh(item, "anilist_seasons", idx, firstUnstartedSeasonIdx, downBtn);
        });
        moveControls.appendChild(upBtn);
        moveControls.appendChild(downBtn);
        summary.appendChild(moveControls);
      }

      details.appendChild(summary);
      details.appendChild(el("div", "season-detail-body hint", formatAnilistStatus(season.status)));
      container.appendChild(details);
    });
  }

  // Restaurer l'état ouvert/fermé mémorisé au début (voir `wasOpen`).
  Array.from(container.querySelectorAll("details.season-detail")).forEach((d, i) => {
    if (wasOpen[i]) d.open = true;
  });

  updateSeasonActionsVisibility(item);
}

async function openEpisodeModal(item, info) {
  modalItem = item;
  fillEpisodeModalContent(item, info);
  setModalPoster(item);
  showEpisodeModal();

  try {
    const raw = await fetchRawEpisodeData(item); // déjà en cache, vient de servir à calculer `info`
    // Ré-affiche la ligne streaming pour y ajouter la note moyenne, absente
    // du premier rendu synchrone (fillEpisodeModalContent ne connaît que
    // `info`, pas encore `raw`) — mêmes services déjà affichés, donc rendu
    // idempotent, pas de flash visible pour l'utilisateur.
    renderStreamingList(
      document.getElementById("episode-modal-streaming"),
      info.streaming ? [info.streaming] : [],
      formatRatingLabel(item.type, raw)
    );
    const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
    fillSeasonsSection(item, raw, progressEpisode, progress[item.id] && progress[item.id].ignored);
  } catch {
    // Le reste de la modale (déjà rempli via `info`) reste utilisable même
    // si le détail saison/épisode ne peut pas se charger.
  }
}

/** Modale de détail pour une carte "À regarder" : montre les infos du tout
 * premier épisode (comme pour En cours, la progression n'existe pas encore
 * donc getNextEpisodeInfo renvoie naturellement l'épisode 1). Ouvre la
 * modale tout de suite avec un état "Chargement…" le temps du fetch réseau,
 * plutôt que de faire attendre le clic. */
async function openUpcomingModal(item) {
  modalItem = item;
  document.getElementById("episode-modal-title").textContent = item.display_title;
  document.getElementById("episode-modal-tag").textContent = "";
  document.getElementById("episode-modal-airdate").textContent = "Chargement…";
  document.getElementById("episode-modal-summary").classList.add("hidden");
  document.getElementById("episode-modal-streaming").textContent = "";
  document.getElementById("episode-modal-seasons").innerHTML = "";
  document.getElementById("episode-modal-season-actions").classList.add("hidden");
  setModalPoster(item);
  showEpisodeModal();

  try {
    const info = await getNextEpisodeInfo(item);
    const raw = await fetchRawEpisodeData(item); // déjà en cache, vient de servir à calculer `info`
    const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
    fillSeasonsSection(item, raw, progressEpisode, progress[item.id] && progress[item.id].ignored);

    if (info.kind === "finished") {
      // Cas rare : une série "à regarder" dont la fiche externe n'a déjà
      // plus rien à proposer (ex. série annulée après un seul épisode).
      document.getElementById("episode-modal-tag").textContent = "Terminé";
      document.getElementById("episode-modal-airdate").textContent = "Aucun épisode disponible.";
      return;
    }
    fillEpisodeModalContent(item, info, formatRatingLabel(item.type, raw));
    // Les films n'ont pas de `info.streaming` (single) : on affiche à la
    // place les services TMDb récupérés dans `raw`, en deux lignes
    // (streaming inclus / location-achat, voir renderFilmStreaming).
    if (item.type === "film") {
      renderFilmStreaming(
        document.getElementById("episode-modal-streaming"),
        raw,
        formatRatingLabel(item.type, raw)
      );
    }
  } catch (e) {
    document.getElementById("episode-modal-airdate").textContent = `Impossible de récupérer les épisodes : ${e.message}`;
  }
}

/** Modale de détail pour une carte "Terminé" : pas de notion de "prochain
 * épisode", donc pas de réutilisation de getNextEpisodeInfo. On récupère
 * directement la fiche complète (résumé, date de fin, diffuseur(s)) via
 * fetchRawEpisodeData, qui partage son cache avec le reste de l'appli. Le
 * dernier épisode connu (`stateEntry`, depuis state.json) s'affiche tout
 * de suite, remplacé par la bonne mention une fois le fetch résolu. */
async function openFinishedModal(item, stateEntry) {
  modalItem = item;
  const titleEl = document.getElementById("episode-modal-title");
  const tagEl = document.getElementById("episode-modal-tag");
  const airdateEl = document.getElementById("episode-modal-airdate");
  const summaryEl = document.getElementById("episode-modal-summary");
  const streamingEl = document.getElementById("episode-modal-streaming");

  titleEl.textContent = item.display_title;
  summaryEl.textContent = "";
  summaryEl.classList.add("hidden");
  streamingEl.textContent = "";
  document.getElementById("episode-modal-seasons").innerHTML = "";
  document.getElementById("episode-modal-season-actions").classList.add("hidden");
  setModalPoster(item);

  if (item.abandoned) {
    // Statut purement local (choix de l'utilisateur) : pas de fetch réseau
    // nécessaire, contrairement aux autres cartes "Terminé".
    tagEl.textContent = "Abandonné";
    const watched = (progress[item.id] && progress[item.id].episode) || 0;
    airdateEl.textContent =
      watched > 0 ? `Abandonnée à l'épisode ${watched}` : "Abandonnée avant le premier épisode";
    showEpisodeModal();
    return;
  }

  tagEl.textContent = "Terminé";
  airdateEl.textContent =
    item.type === "tv" ? formatTvLatest(stateEntry) : item.type === "film" ? formatFilmLatest(stateEntry) : formatAnimeLatest(stateEntry);
  showEpisodeModal();

  try {
    const raw = await fetchRawEpisodeData(item);
    airdateEl.textContent = computeFinishedStatusLabel(item, stateEntry, raw);
    if (item.type === "film") {
      renderFilmStreaming(streamingEl, raw, formatRatingLabel(item.type, raw));
    } else {
      renderStreamingList(streamingEl, getSeriesStreamingList(item.type, raw), formatRatingLabel(item.type, raw));
    }
    fillTranslatedSummary(summaryEl, item.type === "anime" ? raw.description : raw.summary);
    const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
    fillSeasonsSection(item, raw, progressEpisode, progress[item.id] && progress[item.id].ignored);
  } catch (e) {
    airdateEl.textContent = `Infos indisponibles (${e.message})`;
  }
}

async function renderList(containerId, items, builder) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (const item of items) {
    container.appendChild(await builder(item));
  }
}

/** Sépare les items "Terminé" en trois sous-groupes (voir buildFinishedCard
 * / buildAbandonedCard) avant de construire les cartes. Contrairement aux
 * autres listes, on ne peut pas répartir puis mettre à jour après coup :
 * il faut la fiche complète (résumé/dates) de chaque item pour savoir
 * dans quel sous-groupe le ranger — sauf pour les abandons, qui sont un
 * choix de l'utilisateur (donc déjà connu sans appel réseau). */
async function renderFinishedGroups(items) {
  const finishedContainer = document.getElementById("list-termine-fini");
  const upcomingContainer = document.getElementById("list-termine-attente");
  const abandonedContainer = document.getElementById("list-termine-abandonne");
  finishedContainer.innerHTML = "";
  upcomingContainer.innerHTML = "";
  abandonedContainer.innerHTML = "";

  const abandonedItems = items.filter((item) => item.abandoned);
  const otherItems = items.filter((item) => !item.abandoned);

  const classified = await Promise.all(
    otherItems.map(async (item) => {
      let raw = null;
      try {
        raw = await fetchRawEpisodeData(item);
      } catch {
        raw = null;
      }
      // Fiche indisponible : on ne peut pas affirmer que la suite arrive,
      // donc on range par défaut côté "Terminées" plutôt que d'inventer.
      const reallyFinished = raw ? formatSeriesEndDate(item.type, raw) !== null : true;
      return { item, raw, reallyFinished };
    })
  );

  for (const { item, raw, reallyFinished } of classified) {
    const container = reallyFinished ? finishedContainer : upcomingContainer;
    container.appendChild(await buildFinishedCard(item, raw, reallyFinished));
  }

  for (const item of abandonedItems) {
    abandonedContainer.appendChild(await buildAbandonedCard(item));
  }

  const upcomingCount = classified.filter((c) => !c.reallyFinished).length;
  const finishedCount = classified.length - upcomingCount;
  setSectionCount("count-termine-attente", upcomingCount);
  setSectionCount("count-termine-fini", finishedCount);
  setSectionCount("count-termine-abandonne", abandonedItems.length);
}

/** Affiche "(N)" à côté du titre d'une section/sous-section, pour un
 * repère rapide du nombre de cartes qu'elle contient. */
function setSectionCount(elId, count) {
  const el = document.getElementById(elId);
  if (el) el.textContent = `(${count})`;
}

/** Fait remonter automatiquement en "En cours" les titres "Terminé" / "À
 * jour" pour lesquels un nouvel épisode non vu est maintenant diffusé :
 * être "à jour" veut dire "rien de nouveau à voir", donc un nouvel
 * épisode diffusé change cette réalité, pas besoin d'attendre un clic.
 * Ne touche ni aux titres abandonnés (choix explicite qu'on ne défait pas
 * tout seul) ni aux titres réellement finis. Conserve la progression :
 * l'item réapparaît dans "En cours" pile là où il en était. */
async function autoPromoteUpToDateItems(items) {
  // Pas de section "En cours" pour les films (voir le plan "Support des
  // films") : un nouveau volet sorti les fait revenir en "À regarder",
  // jamais en "En cours" comme pour série/anime.
  const promotedToEnCours = [];
  const promotedToARegarder = [];
  for (const item of items) {
    if (item.abandoned) continue;
    let raw;
    try {
      raw = await fetchRawEpisodeData(item);
    } catch {
      continue;
    }
    if (formatSeriesEndDate(item.type, raw) !== null) continue; // réellement fini : rien à promouvoir

    const progressEpisode = (progress[item.id] && progress[item.id].episode) || 0;
    const info =
      item.type !== "anime"
        ? deriveTvEpisodeInfo(raw, progressEpisode, new Date().toISOString().slice(0, 10))
        : deriveAnimeEpisodeInfo(raw, progressEpisode, Date.now() / 1000);

    if (info.kind === "episode" && info.hasAired) {
      if (item.type === "film") {
        item.status = "a_regarder";
        promotedToARegarder.push(item);
      } else {
        item.status = "en_cours";
        promotedToEnCours.push(item);
      }
    }
  }

  const promoted = promotedToEnCours.concat(promotedToARegarder);
  if (promoted.length) {
    await store.putFile(
      "watchlist.json",
      watchlist,
      `Statut mis à jour (nouvel épisode disponible) : ${promoted.map((i) => i.id).join(", ")}`
    );
    if (promotedToEnCours.length === 1) {
      showToast(`"${promotedToEnCours[0].display_title}" : nouvel épisode disponible, de retour en "En cours" !`);
    } else if (promotedToEnCours.length > 1) {
      showToast(`${promotedToEnCours.length} séries ont un nouvel épisode disponible et repassent en "En cours" !`);
    } else if (promotedToARegarder.length === 1) {
      showToast(`"${promotedToARegarder[0].display_title}" : nouveau film disponible, de retour en "À regarder" !`);
    } else if (promotedToARegarder.length > 1) {
      showToast(`${promotedToARegarder.length} films ont un nouveau volet disponible et repassent en "À regarder" !`);
    }
  }
}

/** Fait basculer en "Terminé" / "À jour" les titres dont le prochain
 * épisode connu n'est pas encore diffusé : "En cours" (séries/animes) doit
 * vouloir dire "il y a quelque chose à regarder maintenant", pas "on
 * attend une date de diffusion connue" — ce qui est exactement la
 * définition de "À jour" (complément d'autoPromoteUpToDateItems, dans
 * l'autre sens). Ne s'applique qu'aux items dont le prochain épisode est
 * identifié ; le cas "plus aucun épisode connu du tout" est déjà géré par
 * markFinished au moment du clic "✓ Vu"/ajustement (voir
 * applyEpisodeProgress).
 *
 * Appelée à la fois sur le panier "En cours" (séries/animes) ET, pour les
 * films (qui n'ont pas de section "En cours", voir le plan "Support des
 * films"), sur les titres "À regarder" déjà entamés : sans ce deuxième cas,
 * une collection dont on a vu tous les volets sortis mais pas le suivant
 * (déjà annoncé, pas encore sorti) resterait coincée dans "À regarder" au
 * lieu de rejoindre "Terminé"/"À jour". */
async function autoDemoteWaitingItems(items) {
  for (const item of items) {
    let info;
    try {
      info = await getNextEpisodeInfo(item);
    } catch {
      continue;
    }
    if (info.kind === "episode" && !info.unknown && !info.hasAired) {
      await markFinished(item.id);
    }
  }
}

async function renderAll() {
  // Bascules de statut automatiques : sur TOUTE la watchlist, quel que soit
  // l'onglet de catégorie affiché à l'instant — sinon un titre d'une
  // catégorie non affichée ne serait jamais re-vérifié tant qu'on ne
  // rouvre pas son onglet.
  const initialGroups = groupByStatus(watchlist.items);
  // Films entamés dans "À regarder" (au moins un volet vu) : pas de section
  // "En cours" pour ce type, donc à vérifier ici en plus du panier "En
  // cours" (voir le commentaire d'autoDemoteWaitingItems).
  const startedFilmsAwaitingNext = initialGroups.a_regarder.filter(
    (item) => item.type === "film" && progress[item.id] && progress[item.id].episode > 0
  );
  await autoDemoteWaitingItems(initialGroups.en_cours.concat(startedFilmsAwaitingNext));
  await autoPromoteUpToDateItems(initialGroups.termine);

  renderCategoryChrome();
  if (!isRealCategory(activeCategory)) {
    return; // Films / Mangas-Scans : pas encore de suivi, le message "Bientôt" suffit
  }

  // Regroupe à nouveau après d'éventuelles promotions/rétrogradations, pour
  // que les items concernés apparaissent dans la bonne section dès ce
  // rendu — mais scopé à l'onglet actif seulement (voir itemsForActiveCategory).
  const groups = groupByStatus(itemsForActiveCategory());
  await renderList("list-en-cours", groups.en_cours, buildEpisodeCard);
  setSectionCount("count-en-cours", groups.en_cours.length);
  await renderList("list-a-regarder", groups.a_regarder, buildShowCard);
  setSectionCount("count-a-regarder", groups.a_regarder.length);
  await renderFinishedGroups(groups.termine);
  setSectionCount("count-termine", groups.termine.length);

  // Ré-applique la recherche en cours (si l'utilisateur a déjà tapé quelque
  // chose) sur les cartes fraîchement reconstruites, sinon un renderAll()
  // déclenché entre-temps (✓ Vu, bascule auto...) ferait réapparaître tout.
  applyWatchlistSearch();
}

/* ------------------------------ Actions ------------------------------ */

/** Démarre un titre "à regarder". Si une progression existe déjà (ex. un
 * titre mis en pause depuis "En cours", voir pauseWatching), on repart de
 * là plutôt que de réinitialiser à 0 — seul un tout premier démarrage
 * initialise la progression. */
async function startWatching(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "en_cours";
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> en_cours`);
  if (!progress[itemId]) {
    progress[itemId] = { episode: 0 };
    await store.putFile("progress.json", progress, `Progression : ${itemId} initialisée`);
  }
}

/** Met en pause un titre "en cours" : repasse en "à regarder" en
 * conservant la progression (contrairement à un abandon ou une
 * suppression, l'idée est de reprendre plus tard là où on s'était
 * arrêté). */
async function pauseWatching(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "a_regarder";
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> a_regarder (pause)`);
}

/** Abandonne un titre "en cours" : passe en "Terminé" / "Abandonné", en
 * conservant la progression (dernier épisode enregistré) pour la carte
 * abandonnée et pour une reprise ultérieure. */
async function abandonWatching(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "termine";
  item.abandoned = true;
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> abandonné`);
}

/** Reprend un titre abandonné là où il avait été laissé (contrairement à
 * "Regarder à nouveau" qui repart de l'épisode 1 pour un rewatch complet,
 * on conserve ici la progression existante). */
async function resumeAbandoned(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "en_cours";
  delete item.abandoned;
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> en_cours (reprise après abandon)`);
}

/** Bascule un titre "en cours" vers "terminé" (ne touche pas à sa
 * progression, qui reste consultable si jamais on reprend plus tard).
 * Chaque appel ajoute la date du jour à `finished_history`, qui sert à la
 * fois de date affichée (voir computeFinishedStatusLabel) et de compteur
 * de rewatchs une fois que la série est regardée à nouveau (voir
 * buildEpisodeCard). */
async function markFinished(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "termine";
  item.finished_history = [...getFinishedHistory(item), todayIso()];
  delete item.finished_at; // migration vers finished_history (tableau)
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> terminé`);
}

/** Repasse un titre "Terminé" en "En cours" (ou "À regarder" pour un film,
 * qui n'a pas de section "En cours" — voir le plan "Support des films")
 * pour le regarder à nouveau depuis le début — `finished_history` est
 * conservé, il sert de compteur de rewatchs affiché sur la carte
 * résultante. */
async function watchAgain(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = item.type === "film" ? "a_regarder" : "en_cours";
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> ${item.status} (revisionnage)`);
  progress[itemId] = { episode: 0 };
  await store.putFile("progress.json", progress, `Progression : ${itemId} réinitialisée (revisionnage)`);
}

/** Enregistre une nouvelle progression pour un item et regarde ce que ça
 * donne pour la suite (encore un épisode connu ? à jour mais série
 * vivante ? plus rien à venir ?) pour décider d'un message de succès et
 * d'un éventuel changement de statut automatique vers "Terminé".
 * Centralisé ici pour s'appliquer aussi bien au bouton "✓ Vu" qu'à un
 * ajustement manuel du numéro d'épisode (ex. "180" pour une série qui en
 * compte exactement 180 : la carte doit basculer en "Terminé" tout
 * autant que si on avait cliqué "✓ Vu" jusqu'au bout). */
async function applyEpisodeProgress(item, newEpisode, raw, { ignoreIndex } = {}) {
  // Liste des épisodes passés via "Ignoré" plutôt que "✓ Vu" (voir
  // ignoreEpisode) : préservée d'un appel à l'autre plutôt qu'écrasée, pour
  // que fillSeasonsSection continue à ne pas les compter comme vus même
  // après un ajustement manuel ultérieur du numéro d'épisode.
  const previousIgnored = (progress[item.id] && progress[item.id].ignored) || [];
  const ignored = ignoreIndex != null ? [...previousIgnored, ignoreIndex] : previousIgnored;
  progress[item.id] = ignored.length ? { episode: newEpisode, ignored } : { episode: newEpisode };
  await store.putFile(
    "progress.json",
    progress,
    `Progression : ${item.id} -> épisode ${newEpisode}${ignoreIndex != null ? " (ignoré)" : ""}`
  );

  const info =
    item.type !== "anime"
      ? deriveTvEpisodeInfo(raw, newEpisode, new Date().toISOString().slice(0, 10))
      : deriveAnimeEpisodeInfo(raw, newEpisode, Date.now() / 1000);

  if (info.kind === "finished") {
    await markFinished(item.id);
    showFinishedStatusToast(item, raw);
  } else if (!info.hasAired) {
    // Le passage effectif en "Terminé" / "À jour" est fait par
    // autoDemoteWaitingItems, appelé par le renderAll() qui suit toujours
    // cet appel (voir markEpisodeWatched / le bouton "✎ Ajuster") : pas de
    // markFinished ici pour éviter un double enregistrement dans
    // finished_history.
    showToast(`Vous êtes à jour sur "${item.display_title}", la suite arrive !`);
  }
}

/** Marque l'épisode actuellement affiché comme vu (bouton "✓ Vu" de la
 * carte épisode). */
async function markEpisodeWatched(item) {
  const raw = await fetchRawEpisodeData(item); // pas de refetch réseau : la donnée brute ne dépend pas de la progression
  const newEpisode = ((progress[item.id] && progress[item.id].episode) || 0) + 1;
  await applyEpisodeProgress(item, newEpisode, raw);
  await renderAll();
}

/** Ignore l'épisode actuellement affiché (bouton "Ignoré" de la carte
 * épisode, à côté de "✓ Vu") : avance le pointeur de progression exactement
 * comme "✓ Vu" (même bascule automatique vers "Terminé"/"À jour"), mais
 * sans compter cet épisode comme vu — pour les épisodes spéciaux qu'on
 * saute volontairement. L'index global de l'épisode ignoré est mémorisé
 * (progress[id].ignored) pour que fillSeasonsSection ne l'affiche pas ✓
 * dans le détail saison/épisode. */
async function ignoreEpisode(item) {
  const raw = await fetchRawEpisodeData(item);
  const currentIndex = (progress[item.id] && progress[item.id].episode) || 0;
  const newEpisode = currentIndex + 1;
  await applyEpisodeProgress(item, newEpisode, raw, { ignoreIndex: currentIndex });
  await renderAll();
}

/** Ajoute un nouveau titre à la watchlist (résultat de recherche + statut
 * choisis par l'utilisateur dans le panneau d'ajout). */
async function addNewItem({ title, type, searchTitle, anilistId, tmdbId, status }) {
  const existingIds = new Set(watchlist.items.map((i) => i.id));
  const id = uniqueId(slugify(title), existingIds);

  const newItem = {
    id,
    display_title: title,
    search_title: searchTitle,
    type,
    status,
  };
  if (anilistId) newItem.anilist_id = anilistId;
  if (tmdbId) newItem.tmdb_id = tmdbId;
  if (status === "termine") newItem.finished_history = [todayIso()];

  watchlist.items.push(newItem);
  await store.putFile("watchlist.json", watchlist, `Ajout : ${title}`);

  if (status === "en_cours") {
    progress[id] = { episode: 0 };
    await store.putFile("progress.json", progress, `Progression : ${id} initialisée`);
  }

  return id;
}

/** Ajoute un titre anime regroupant plusieurs saisons AniList (chacune
 * modélisée comme une fiche distincte côté API, ex. "La Voie du tablier")
 * en une seule carte de suivi, avec une numérotation d'épisode continue à
 * travers les saisons (voir fetchAnimeRawGrouped). `seasons` doit déjà
 * être trié dans l'ordre chronologique de diffusion.
 * NB : le bot de notif externe (hors de ce repo) attend un `anilist_id`
 * unique par titre pour repérer les nouveaux épisodes ; un item groupé
 * n'a pas ce champ et ne sera donc pas notifié tant que le bot n'aura pas
 * été adapté séparément — limitation acceptée pour l'instant. */
async function addGroupedAnimeItem({ title, seasons, status }) {
  const existingIds = new Set(watchlist.items.map((i) => i.id));
  const id = uniqueId(slugify(title), existingIds);

  const newItem = {
    id,
    display_title: title,
    search_title: seasons[0].search_title,
    type: "anime",
    status,
    anilist_seasons: seasons.map((s) => ({ anilist_id: s.anilist_id, search_title: s.search_title })),
  };
  if (status === "termine") newItem.finished_history = [todayIso()];

  watchlist.items.push(newItem);
  await store.putFile("watchlist.json", watchlist, `Ajout (groupé, ${seasons.length} saisons) : ${title}`);

  if (status === "en_cours") {
    progress[id] = { episode: 0 };
    await store.putFile("progress.json", progress, `Progression : ${id} initialisée`);
  }

  return id;
}

/** Équivalent film de addGroupedAnimeItem : ajoute un titre regroupant
 * plusieurs films TMDb (une saga sélectionnée à la main, façon regroupement
 * de saisons anime) en une seule carte de suivi. */
async function addGroupedFilmItem({ title, films, status }) {
  const existingIds = new Set(watchlist.items.map((i) => i.id));
  const id = uniqueId(slugify(title), existingIds);

  const newItem = {
    id,
    display_title: title,
    search_title: films[0].search_title,
    type: "film",
    status,
    tmdb_seasons: films.map((f) => ({ tmdb_id: f.tmdb_id, search_title: f.search_title })),
  };
  if (status === "termine") newItem.finished_history = [todayIso()];

  watchlist.items.push(newItem);
  await store.putFile("watchlist.json", watchlist, `Ajout (groupé, ${films.length} films) : ${title}`);

  if (status === "en_cours") {
    progress[id] = { episode: 0 };
    await store.putFile("progress.json", progress, `Progression : ${id} initialisée`);
  }

  return id;
}

/** Ajoute une nouvelle saison à un item anime existant (simple ou déjà
 * groupé), depuis la modale de détail. La saison est toujours ajoutée en
 * FIN de regroupement (push), même si elle est plus ancienne que les
 * précédentes : ajouter en fin préserve la numérotation continue et la
 * progression déjà enregistrée (une insertion au milieu les décalerait).
 * L'utilisateur remet ensuite l'ordre voulu à la main via les flèches ▲/▼
 * (sur la partie non encore vue). Si l'item n'était pas encore groupé, sa
 * propre fiche devient la première saison du regroupement. */
async function addSeasonToItem(itemId, seasonResult) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;

  if (!Array.isArray(item.anilist_seasons)) {
    item.anilist_seasons = [{ anilist_id: item.anilist_id, search_title: item.search_title }];
  }
  item.anilist_seasons.push({ anilist_id: seasonResult.anilist_id, search_title: seasonResult.search_title });
  await store.putFile(
    "watchlist.json",
    watchlist,
    `Saison ajoutée : ${itemId} (+${seasonResult.search_title || seasonResult.anilist_id})`
  );

  const cache = loadEpisodeCache();
  delete cache[itemId];
  saveEpisodeCache(cache);
}

/** Retire la dernière saison d'un item anime groupé (voir
 * updateSeasonActionsVisibility : uniquement proposé à partir de 2
 * saisons). Si la progression enregistrée dépassait déjà le début de
 * cette dernière saison, elle est ramenée à la fin de la saison
 * précédente (`clampedEpisode`) puisque les épisodes au-delà appartenaient
 * à la saison qu'on retire — c'est à l'appelant (voir initEpisodeModal) de
 * demander confirmation avant d'appeler cette fonction si un clamp réel va
 * avoir lieu. */
async function removeLastSeason(itemId, clampedEpisode) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item || !Array.isArray(item.anilist_seasons) || item.anilist_seasons.length < 2) return;

  item.anilist_seasons.pop();
  await store.putFile("watchlist.json", watchlist, `Saison retirée (dernière) : ${itemId}`);

  if (typeof clampedEpisode === "number" && progress[itemId] && progress[itemId].episode > clampedEpisode) {
    progress[itemId] = { episode: clampedEpisode };
    await store.putFile(
      "progress.json",
      progress,
      `Progression : ${itemId} ramenée à l'épisode ${clampedEpisode} (saison retirée)`
    );
  }

  const cache = loadEpisodeCache();
  delete cache[itemId];
  saveEpisodeCache(cache);
}

/** Équivalent film de addSeasonToItem : ajoute un film à un item déjà
 * groupé (ou initialise le regroupement à partir d'un film simple), depuis
 * la modale de détail. Comme pour les saisons anime, le film est ajouté en
 * FIN de regroupement (push) quel que soit son année de sortie ; l'ordre de
 * visionnage voulu se règle ensuite à la main via les flèches ▲/▼. */
async function addFilmToItem(itemId, filmResult) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;

  if (!Array.isArray(item.tmdb_seasons)) {
    item.tmdb_seasons = [{ tmdb_id: item.tmdb_id, search_title: item.search_title }];
  }
  item.tmdb_seasons.push({ tmdb_id: filmResult.tmdb_id, search_title: filmResult.search_title });
  await store.putFile(
    "watchlist.json",
    watchlist,
    `Film ajouté : ${itemId} (+${filmResult.search_title || filmResult.tmdb_id})`
  );

  const cache = loadEpisodeCache();
  delete cache[itemId];
  saveEpisodeCache(cache);
}

/** Équivalent film de removeLastSeason : retire le dernier film connu d'un
 * regroupement (item.tmdb_seasons), utile si le regroupement a été fait à
 * tort ou pour retirer un volet ajouté par erreur. */
async function removeLastFilmPart(itemId, clampedEpisode) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item || !Array.isArray(item.tmdb_seasons) || item.tmdb_seasons.length < 2) return;

  item.tmdb_seasons.pop();
  await store.putFile("watchlist.json", watchlist, `Film retiré (dernier) : ${itemId}`);

  if (typeof clampedEpisode === "number" && progress[itemId] && progress[itemId].episode > clampedEpisode) {
    progress[itemId] = { episode: clampedEpisode };
    await store.putFile(
      "progress.json",
      progress,
      `Progression : ${itemId} ramenée à l'épisode ${clampedEpisode} (volet retiré)`
    );
  }

  const cache = loadEpisodeCache();
  delete cache[itemId];
  saveEpisodeCache(cache);
}

/** Échange deux entrées adjacentes d'un regroupement (item.anilist_seasons
 * pour l'anime, item.tmdb_seasons pour un film) — pour corriger un ordre de
 * sortie qui ne correspond pas à l'ordre de visionnage voulu (ex.
 * préquelle sortie après coup, saison bonus à intercaler). Restriction
 * volontaire : `index` et `index + 1` doivent tous les deux être encore
 * NON vus (>= au seuil `watchedBoundary` fourni par l'appelant, qui sait
 * traduire la progression en position dans CE tableau précis — un index
 * brut pour un film, un seuil par offset de saison pour l'anime). Ne
 * jamais réordonner ce qui est déjà vu : la progression est un simple
 * curseur de position, pas un identifiant, donc rejouer l'ordre d'une
 * partie déjà regardée changerait rétroactivement ce qui compte comme vu. */
async function swapUnwatchedEntries(itemId, arrayField, index, watchedBoundary) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item || !Array.isArray(item[arrayField])) return;
  const arr = item[arrayField];
  if (index < 0 || index + 1 >= arr.length) return;
  if (index < watchedBoundary) return;

  [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
  await store.putFile("watchlist.json", watchlist, `Ordre modifié (${arrayField}) : ${itemId}`);

  const cache = loadEpisodeCache();
  delete cache[itemId];
  saveEpisodeCache(cache);
}

/** Retire un titre de la watchlist et nettoie sa progression associée
 * (l'entrée dans state.json, elle, reste orpheline mais inoffensive :
 * le bot de notif ne regarde que les ids présents dans watchlist.json). */
async function removeItem(itemId) {
  watchlist.items = watchlist.items.filter((i) => i.id !== itemId);
  await store.putFile("watchlist.json", watchlist, `Suppression : ${itemId}`);

  if (progress[itemId]) {
    delete progress[itemId];
    await store.putFile("progress.json", progress, `Suppression progression : ${itemId}`);
  }
}

/* ------------------------------ Bootstrap / setup ------------------------------ */

function getConfig() {
  return {
    owner: localStorage.getItem(LS.owner),
    repo: localStorage.getItem(LS.repo),
    branch: localStorage.getItem(LS.branch) || "main",
    token: localStorage.getItem(LS.token),
  };
}

function saveConfig(cfg) {
  localStorage.setItem(LS.owner, cfg.owner);
  localStorage.setItem(LS.repo, cfg.repo);
  localStorage.setItem(LS.branch, cfg.branch || "main");
  localStorage.setItem(LS.token, cfg.token);
}

/** Clé API TMDb (v3), indépendante de la config GitHub : optionnelle tant
 * qu'on n'essaie pas de charger un film (voir fetchFilmRaw), donc jamais
 * bloquante pour le reste de l'app. */
function getTmdbKey() {
  return localStorage.getItem(LS.tmdbKey) || null;
}

function saveTmdbKey(key) {
  if (key) localStorage.setItem(LS.tmdbKey, key);
  else localStorage.removeItem(LS.tmdbKey);
}

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) {
    s.classList.add("hidden");
  }
  document.getElementById(id).classList.remove("hidden");
}

/* Bascules d'id AniList programmées : certaines fiches AniList sont
   remplacées par une autre à une date connue (ex. l'Apothicaire, dont la
   suite bascule de 176301 vers 195516 à partir du 31/10/2026). Plutôt que
   d'attendre la date pour éditer la donnée à la main, on code la bascule ici
   et elle s'applique toute seule le jour venu. En mémoire uniquement et
   idempotente : rejouée à chaque chargement sans risque ; l'id corrigé se
   persistera naturellement à la prochaine écriture de watchlist.json. */
const SCHEDULED_ANILIST_ID_SWAPS = [
  { from: 176301, to: 195516, since: "2026-10-31" }, // Apothicaire (voir BACKLOG)
];

function applyScheduledAnilistIdSwaps() {
  if (!watchlist || !Array.isArray(watchlist.items)) return;
  const today = todayIso();
  const active = SCHEDULED_ANILIST_ID_SWAPS.filter((s) => today >= s.since);
  if (!active.length) return;

  const swapOf = (id) => {
    const match = active.find((s) => Number(id) === s.from);
    return match ? match.to : null;
  };

  const cache = loadEpisodeCache();
  let cacheDirty = false;
  for (const item of watchlist.items) {
    let changed = false;
    const top = swapOf(item.anilist_id);
    if (top !== null) {
      item.anilist_id = top;
      changed = true;
    }
    if (Array.isArray(item.anilist_seasons)) {
      for (const s of item.anilist_seasons) {
        const sw = swapOf(s.anilist_id);
        if (sw !== null) {
          s.anilist_id = sw;
          changed = true;
        }
      }
    }
    // L'id AniList a changé mais le cache épisodes est indexé par item.id :
    // on le vide pour cet item, sinon on continuerait à servir l'ancienne
    // fiche jusqu'à expiration du cache.
    if (changed && cache[item.id]) {
      delete cache[item.id];
      cacheDirty = true;
    }
  }
  if (cacheDirty) saveEpisodeCache(cache);
}

async function loadAll() {
  watchlist = await store.getFile("watchlist.json");
  state = await store.getFile("state.json");
  try {
    progress = await store.getFile("progress.json");
  } catch (e) {
    progress = {};
  }
  applyScheduledAnilistIdSwaps();
}

async function boot() {
  const cfg = getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    showScreen("setup-screen");
    return;
  }

  showScreen("loading-screen");
  store = new GitHubStore(cfg.owner, cfg.repo, cfg.branch, cfg.token);

  try {
    await loadAll();
    showScreen("main-screen");
    document.getElementById("load-error").classList.add("hidden");
    await renderAll();
  } catch (e) {
    showScreen("main-screen");
    const errBox = document.getElementById("load-error");
    errBox.textContent = e.message;
    errBox.classList.remove("hidden");
  }
}

function initSetupScreen() {
  const cfg = getConfig();
  if (cfg.owner) document.getElementById("input-owner").value = cfg.owner;
  if (cfg.repo) document.getElementById("input-repo").value = cfg.repo;
  if (cfg.branch) document.getElementById("input-branch").value = cfg.branch;
  const tmdbKey = getTmdbKey();
  if (tmdbKey) document.getElementById("input-tmdb-key").value = tmdbKey;

  document.getElementById("btn-save-setup").addEventListener("click", async () => {
    const owner = document.getElementById("input-owner").value.trim();
    const repo = document.getElementById("input-repo").value.trim();
    const branch = document.getElementById("input-branch").value.trim() || "main";
    const token = document.getElementById("input-token").value.trim();
    const errBox = document.getElementById("setup-error");
    errBox.classList.add("hidden");

    if (!owner || !repo || !token) {
      errBox.textContent = "Merci de remplir tous les champs.";
      errBox.classList.remove("hidden");
      return;
    }

    saveConfig({ owner, repo, branch, token });
    // Optionnelle : ne bloque jamais l'enregistrement du reste (voir
    // getTmdbKey/fetchFilmRaw, qui ne l'exige qu'au moment de charger un film).
    saveTmdbKey(document.getElementById("input-tmdb-key").value.trim());
    await boot();
  });
}

function initEpisodeModal() {
  const modal = document.getElementById("episode-modal");
  const closeBtn = document.getElementById("btn-episode-modal-close");
  const openAddSeasonBtn = document.getElementById("btn-open-add-season");
  const removeLastSeasonBtn = document.getElementById("btn-remove-last-season");
  const addSeasonPanel = document.getElementById("add-season-panel");
  const addSeasonInput = document.getElementById("add-season-input");
  const addSeasonStatus = document.getElementById("add-season-status");
  const addSeasonResults = document.getElementById("add-season-results");
  const addSeasonError = document.getElementById("add-season-error");

  function resetAddSeasonPanel() {
    addSeasonPanel.classList.add("hidden");
    addSeasonInput.value = "";
    addSeasonStatus.textContent = "";
    addSeasonResults.innerHTML = "";
    addSeasonError.classList.add("hidden");
  }

  function close() {
    modal.classList.add("hidden");
    resetAddSeasonPanel();
  }

  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      close();
    }
  });

  // "+ Ajouter une saison"/"+ Ajouter un film" bascule le petit panneau de
  // recherche (façon panneau d'ajout principal, mais scopé à la série/au
  // regroupement affiché).
  openAddSeasonBtn.addEventListener("click", () => {
    const wasHidden = addSeasonPanel.classList.contains("hidden");
    resetAddSeasonPanel();
    if (wasHidden) {
      addSeasonInput.placeholder =
        modalItem && modalItem.type === "film"
          ? "Titre d'un autre épisode de la collection à ajouter…"
          : "Titre de la saison à ajouter…";
      addSeasonPanel.classList.remove("hidden");
      addSeasonInput.focus();
    }
  });

  async function runAddSeasonSearch() {
    const query = addSeasonInput.value.trim();
    if (!query || !modalItem) return;
    const isFilm = modalItem.type === "film";
    addSeasonStatus.textContent = "Recherche…";
    addSeasonResults.innerHTML = "";
    addSeasonError.classList.add("hidden");

    try {
      const results = isFilm ? await searchTmdbMulti(query) : await searchAnilistMulti(query);
      const existingIds = new Set(
        isFilm
          ? Array.isArray(modalItem.tmdb_seasons)
            ? modalItem.tmdb_seasons.map((s) => s.tmdb_id)
            : modalItem.tmdb_id
              ? [modalItem.tmdb_id]
              : []
          : Array.isArray(modalItem.anilist_seasons)
            ? modalItem.anilist_seasons.map((s) => s.anilist_id)
            : modalItem.anilist_id
              ? [modalItem.anilist_id]
              : []
      );
      addSeasonStatus.textContent = results.length ? `${results.length} résultat(s)` : "Aucun résultat.";
      addSeasonResults.innerHTML = "";

      for (const r of results) {
        const already = existingIds.has(isFilm ? r.tmdb_id : r.anilist_id);
        const row = el("div", "result-item");
        if (already) row.classList.add("already-added");

        const img = document.createElement("img");
        img.src = r.image || "";
        img.alt = r.title;
        row.appendChild(img);

        const textWrap = el("div", "result-text");
        textWrap.appendChild(el("p", "result-title", r.title));
        textWrap.appendChild(
          el(
            "p",
            "result-sub",
            `${r.year || ""} ${r.status ? "· " + r.status : ""}${formatSearchResultRating(r)}`.trim()
          )
        );
        row.appendChild(textWrap);

        const addBtn = el("button", "result-add-btn", already ? "✓" : "+");
        addBtn.type = "button";
        if (already) {
          addBtn.classList.add("added");
          addBtn.disabled = true;
          addBtn.title = isFilm ? "Déjà un film de ce regroupement" : "Déjà une saison de ce titre";
        } else {
          addBtn.title = isFilm ? "Ajouter comme film suivant" : "Ajouter comme nouvelle saison";
          addBtn.addEventListener("click", async () => {
            addBtn.disabled = true; // avant tout await : évite un double-ajout sur double-clic
            addSeasonError.classList.add("hidden");
            try {
              // Le nouvel élément est ajouté en fin de regroupement (push,
              // voir addSeasonToItem/addFilmToItem), quel que soit son année :
              // on autorise désormais l'ajout d'un volet/saison plus ancien
              // (ex. les premiers Star Wars, absents de la recherche initiale)
              // et l'utilisateur remet l'ordre à la main via les flèches ▲/▼.
              const itemId = modalItem.id;
              if (isFilm) {
                await addFilmToItem(itemId, r);
              } else {
                await addSeasonToItem(itemId, r);
              }
              const freshRaw = await fetchRawEpisodeData(modalItem, { forceRefresh: true });
              const progressEpisode = (progress[itemId] && progress[itemId].episode) || 0;
              fillSeasonsSection(modalItem, freshRaw, progressEpisode, progress[itemId] && progress[itemId].ignored);
              resetAddSeasonPanel();
              showToast(
                isFilm
                  ? `Film ajouté à "${modalItem.display_title}" !`
                  : `Saison ajoutée à "${modalItem.display_title}" !`
              );
              await renderAll();
            } catch (e) {
              addBtn.disabled = false;
              addSeasonError.textContent = e.message;
              addSeasonError.classList.remove("hidden");
            }
          });
        }
        row.appendChild(addBtn);
        addSeasonResults.appendChild(row);
      }
    } catch (e) {
      addSeasonStatus.textContent = `Erreur de recherche : ${e.message}`;
    }
  }

  addSeasonInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runAddSeasonSearch();
    }
  });

  removeLastSeasonBtn.addEventListener("click", async () => {
    if (!modalItem) return;
    const itemId = modalItem.id;
    const isFilm = modalItem.type === "film";
    removeLastSeasonBtn.disabled = true;
    try {
      const raw = await fetchRawEpisodeData(modalItem);
      const currentProgress = (progress[itemId] && progress[itemId].episode) || 0;
      let clampedEpisode = null;
      let message;

      if (isFilm) {
        clampedEpisode = Math.max(0, (raw.episodes || []).length - 1);
        message = `Retirer le dernier film de "${modalItem.display_title}" ?`;
        if (currentProgress > clampedEpisode) {
          message += ` La progression enregistrée (${currentProgress} film(s) vu(s)) sera ramenée à ${clampedEpisode}, la suite appartenant au film retiré.`;
        }
      } else {
        const seasons = raw.seasons || [];
        const lastSeason = seasons[seasons.length - 1];
        clampedEpisode = lastSeason ? lastSeason.offsetStart : null;
        message = `Retirer la dernière saison de "${modalItem.display_title}" ?`;
        if (typeof clampedEpisode === "number" && currentProgress > clampedEpisode) {
          message += ` La progression enregistrée (épisode ${currentProgress}) sera ramenée à l'épisode ${clampedEpisode}, la suite appartenant à la saison retirée.`;
        }
      }
      if (!confirm(message)) return;

      if (isFilm) {
        await removeLastFilmPart(itemId, clampedEpisode);
      } else {
        await removeLastSeason(itemId, clampedEpisode);
      }
      const freshRaw = await fetchRawEpisodeData(modalItem, { forceRefresh: true });
      const progressEpisode = (progress[itemId] && progress[itemId].episode) || 0;
      fillSeasonsSection(modalItem, freshRaw, progressEpisode, progress[itemId] && progress[itemId].ignored);
      showToast(
        isFilm ? `Film retiré de "${modalItem.display_title}".` : `Saison retirée de "${modalItem.display_title}".`
      );
      await renderAll();
    } catch (e) {
      alert(e.message);
    } finally {
      removeLastSeasonBtn.disabled = false;
    }
  });
}

/* ------------------------------ Modale de choix (poubelle "En cours") ------------------------------ */

// Id de l'item concerné par la modale de choix actuellement ouverte (voir
// openDeleteChoiceModal / initDeleteChoiceModal juste en dessous).
let deleteChoiceItemId = null;

/** Ouvre la modale de choix (Annuler / Pause / Abandonner / Supprimer),
 * déclenchée par le picto poubelle sur une carte "En cours" — voir
 * buildEpisodeCard. Les cartes "À regarder" et "Terminé" gardent le
 * simple confirm() de suppression, pause/abandon n'ayant de sens que pour
 * un titre qu'on est en train de regarder. */
function openDeleteChoiceModal(item) {
  deleteChoiceItemId = item.id;
  document.getElementById("delete-choice-title").textContent = `"${item.display_title}"`;
  document.getElementById("delete-choice-modal").classList.remove("hidden");
}

function initDeleteChoiceModal() {
  const modal = document.getElementById("delete-choice-modal");
  const closeBtn = document.getElementById("btn-delete-choice-close");
  const cancelBtn = document.getElementById("btn-choice-cancel");
  const pauseBtn = document.getElementById("btn-choice-pause");
  const abandonBtn = document.getElementById("btn-choice-abandon");
  const deleteBtn = document.getElementById("btn-choice-delete");

  function close() {
    modal.classList.add("hidden");
    deleteChoiceItemId = null;
  }

  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });

  pauseBtn.addEventListener("click", async () => {
    const itemId = deleteChoiceItemId;
    if (!itemId) return;
    const item = watchlist.items.find((i) => i.id === itemId);
    pauseBtn.disabled = true;
    try {
      await pauseWatching(itemId);
      close();
      showToast(`"${item.display_title}" mis en pause.`);
      await renderAll();
    } catch (e) {
      alert(e.message);
    } finally {
      pauseBtn.disabled = false;
    }
  });

  abandonBtn.addEventListener("click", async () => {
    const itemId = deleteChoiceItemId;
    if (!itemId) return;
    const item = watchlist.items.find((i) => i.id === itemId);
    abandonBtn.disabled = true;
    try {
      await abandonWatching(itemId);
      close();
      showToast(`"${item.display_title}" marqué comme abandonné.`);
      await renderAll();
    } catch (e) {
      alert(e.message);
    } finally {
      abandonBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener("click", async () => {
    const itemId = deleteChoiceItemId;
    if (!itemId) return;
    const item = watchlist.items.find((i) => i.id === itemId);
    const ok = confirm(`Supprimer définitivement "${item.display_title}" de la watchlist ? Cette action est irréversible.`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await removeItem(itemId);
      close();
      await renderAll();
    } catch (e) {
      alert(e.message);
    } finally {
      deleteBtn.disabled = false;
    }
  });
}

/* ------------------------------ Panneau d'ajout ------------------------------ */

function initAddPanel() {
  const overlay = document.getElementById("add-overlay");
  const openBtn = document.getElementById("btn-add");
  const closeBtn = document.getElementById("btn-add-close");
  const typeButtons = document.querySelectorAll(".type-btn");
  const statusButtons = document.querySelectorAll(".status-btn");
  const searchInput = document.getElementById("input-add-search");
  const searchBtn = document.getElementById("btn-add-search");
  const statusEl = document.getElementById("add-search-status");
  const resultsEl = document.getElementById("add-results");
  const errorEl = document.getElementById("add-error");
  const groupBar = document.getElementById("add-group-bar");
  const groupCountEl = document.getElementById("add-group-count");
  const groupBtn = document.getElementById("btn-add-group");

  let currentType = "tv";
  let currentStatus = "a_regarder";
  // Sélection courante pour le regroupement (anime : plusieurs saisons AniList,
  // film : plusieurs volets TMDb — même mécanisme pour les deux), remise à
  // zéro à chaque nouvelle recherche/fermeture du panneau.
  // Clé : anilist_id ou tmdb_id -> résultat de recherche.
  let selectedForGroup = new Map();

  function updateGroupBar() {
    const count = selectedForGroup.size;
    if (count < 2) {
      groupBar.classList.add("hidden");
      return;
    }
    groupBar.classList.remove("hidden");
    const isFilm = Array.from(selectedForGroup.values())[0].type === "film";
    groupCountEl.textContent = `${count} ${isFilm ? "films sélectionnés" : "saisons sélectionnées"}`;
  }

  function resetPanel() {
    searchInput.value = "";
    statusEl.textContent = "";
    resultsEl.innerHTML = "";
    errorEl.classList.add("hidden");
    selectedForGroup = new Map();
    updateGroupBar();
  }

  function closePanel() {
    overlay.classList.add("hidden");
  }

  openBtn.addEventListener("click", () => {
    resetPanel();
    // Scope imposé par l'onglet courant : on ajoute dans la catégorie active
    // (Séries→tv, Animés→anime, Films→film). Le FAB d'ajout est masqué sur
    // les catégories sans suivi (voir renderCategoryChrome), donc
    // categoryToAddType reçoit toujours ici une vraie catégorie.
    applyType(categoryToAddType(activeCategory));
    overlay.classList.remove("hidden");
    searchInput.focus();
  });
  closeBtn.addEventListener("click", closePanel);

  // Clic sur le fond sombre (en dehors du panneau lui-même) = fermeture.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePanel();
  });

  // Touche Échap = fermeture, comme le clic sur le fond sombre.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
      closePanel();
    }
  });

  // Touche Entrée dans le champ de recherche = déclenche la recherche,
  // comme un clic sur "Chercher".
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchBtn.click();
    }
  });

  const enCoursStatusBtn = document.getElementById("status-btn-en-cours");
  const typeToggle = document.querySelector(".type-toggle");
  const panelTitle = overlay.querySelector(".overlay-header h2");

  // Le type d'ajout est désormais imposé par la catégorie active (voir
  // openBtn plus bas) : on n'ajoute que dans la catégorie affichée. Le
  // sélecteur Série/Anime/Film devient donc redondant et est masqué.
  if (typeToggle) typeToggle.classList.add("hidden");

  /** Applique un type d'ajout (tv/anime/film) : met à jour l'état interne,
   * le titre du panneau, et masque le statut "En cours" pour les films
   * (pas de section "En cours" côté film — voir renderCategoryChrome). */
  function applyType(type) {
    currentType = type;
    typeButtons.forEach((b) => b.classList.toggle("active", b.dataset.type === type));

    const isFilm = type === "film";
    enCoursStatusBtn.classList.toggle("hidden", isFilm);
    if (isFilm && currentStatus === "en_cours") {
      statusButtons.forEach((b) => b.classList.remove("active"));
      document.querySelector('.status-btn[data-status="a_regarder"]').classList.add("active");
      currentStatus = "a_regarder";
    }

    const labels = { tv: "une série", anime: "un anime", film: "un film" };
    if (panelTitle) panelTitle.textContent = `Ajouter ${labels[type] || "un titre"}`;
  }

  statusButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      statusButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentStatus = btn.dataset.status;
    });
  });

  searchBtn.addEventListener("click", async () => {
    const query = searchInput.value.trim();
    if (!query) return;
    statusEl.textContent = "Recherche…";
    resultsEl.innerHTML = "";
    errorEl.classList.add("hidden");
    selectedForGroup = new Map();
    updateGroupBar();

    try {
      const results =
        currentType === "tv"
          ? await searchTvmazeMulti(query)
          : currentType === "anime"
          ? await searchAnilistMulti(query)
          : await searchTmdbMulti(query);
      statusEl.textContent = results.length ? `${results.length} résultat(s)` : "Aucun résultat.";
      resultsEl.innerHTML = "";
      for (const r of results) {
        const item = el("div", "result-item");
        const already = isAlreadyAdded(r, watchlist.items);
        if (already) item.classList.add("already-added");

        // Case à cocher pour regrouper plusieurs saisons anime (ou plusieurs
        // films d'une même saga) en une seule carte de suivi : voir la barre
        // "Regrouper..." plus bas. Même mécanisme pour les deux types.
        const groupKey = r.anilist_id || r.tmdb_id;
        if ((r.type === "anime" || r.type === "film") && !already && groupKey) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "result-select";
          checkbox.title =
            r.type === "film" ? "Sélectionner pour regrouper avec d'autres films" : "Sélectionner pour regrouper avec d'autres saisons";
          checkbox.addEventListener("click", (e) => e.stopPropagation());
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              selectedForGroup.set(groupKey, r);
            } else {
              selectedForGroup.delete(groupKey);
            }
            updateGroupBar();
          });
          item.appendChild(checkbox);
        }

        const img = document.createElement("img");
        img.src = r.image || "";
        img.alt = r.title;
        item.appendChild(img);

        const textWrap = el("div", "result-text");
        textWrap.appendChild(el("p", "result-title", r.title));
        textWrap.appendChild(
          el(
            "p",
            "result-sub",
            `${r.year || ""} ${r.status ? "· " + r.status : ""}${formatSearchResultRating(r)}`.trim()
          )
        );
        item.appendChild(textWrap);

        // Icône "+" : ajoute directement ce résultat dans la liste choisie
        // en haut du panneau, sans étape de confirmation supplémentaire.
        // Si le titre est déjà dans la watchlist, on affiche directement
        // un "✓" non cliquable à la place, pour éviter les doublons.
        const addBtn = el("button", "result-add-btn", already ? "✓" : "+");
        addBtn.type = "button";

        if (already) {
          addBtn.classList.add("added");
          addBtn.disabled = true;
          addBtn.title = "Déjà dans ta watchlist";
        } else {
          addBtn.title = "Ajouter";
          addBtn.addEventListener("click", async () => {
            addBtn.disabled = true; // avant tout await : évite un double-ajout sur double-clic
            errorEl.classList.add("hidden");
            try {
              await addNewItem({
                title: r.title,
                type: r.type,
                searchTitle: r.search_title,
                anilistId: r.anilist_id,
                tmdbId: r.tmdb_id,
                status: currentStatus,
              });
              addBtn.textContent = "✓";
              addBtn.classList.add("added");
              item.classList.add("already-added");
              await renderAll();
            } catch (e) {
              addBtn.disabled = false;
              errorEl.textContent = e.message;
              errorEl.classList.remove("hidden");
            }
          });
        }
        item.appendChild(addBtn);

        resultsEl.appendChild(item);
      }
    } catch (e) {
      statusEl.textContent = `Erreur de recherche : ${e.message}`;
    }
  });

  groupBtn.addEventListener("click", async () => {
    const seasons = Array.from(selectedForGroup.values()).sort(
      (a, b) => (parseInt(a.year, 10) || 0) - (parseInt(b.year, 10) || 0)
    );
    if (seasons.length < 2) return;
    const isFilm = seasons[0].type === "film";

    const defaultTitle = seasons[0].title;
    const title = prompt(
      `Titre affiché pour ce regroupement de ${seasons.length} ${isFilm ? "films" : "saisons"} :`,
      defaultTitle
    );
    if (!title || !title.trim()) return;

    groupBtn.disabled = true;
    errorEl.classList.add("hidden");
    try {
      if (isFilm) {
        await addGroupedFilmItem({
          title: title.trim(),
          films: seasons.map((s) => ({ tmdb_id: s.tmdb_id, search_title: s.search_title })),
          status: currentStatus,
        });
      } else {
        await addGroupedAnimeItem({
          title: title.trim(),
          seasons: seasons.map((s) => ({ anilist_id: s.anilist_id, search_title: s.search_title })),
          status: currentStatus,
        });
      }
      showToast(`"${title.trim()}" ajouté (${seasons.length} ${isFilm ? "films regroupés" : "saisons regroupées"}) !`);
      selectedForGroup = new Map();
      updateGroupBar();
      await renderAll();
      searchBtn.click(); // rafraîchit les résultats affichés (coches "déjà ajouté")
    } catch (e) {
      errorEl.textContent = e.message;
      errorEl.classList.remove("hidden");
    } finally {
      groupBtn.disabled = false;
    }
  });
}

/** Filtre en temps réel les cartes de la watchlist (toutes sections
 * confondues) selon la recherche en cours, sur le titre affiché. Une
 * section repliée ("À regarder", "Terminé") contenant un résultat
 * correspondant est automatiquement dépliée, pour ne pas laisser un
 * résultat invisible derrière un <details> fermé — elle n'est en revanche
 * jamais repliée automatiquement quand la recherche est effacée, pour ne
 * pas surprendre l'utilisateur en refermant quelque chose qu'il a ouvert
 * lui-même entre-temps. */
function applyWatchlistSearch() {
  const input = document.getElementById("watchlist-search-input");
  if (!input) return;
  const query = input.value.trim().toLowerCase();

  document.querySelectorAll("#main-screen .card").forEach((card) => {
    const titleEl = card.querySelector(".card-title");
    const match = !query || (titleEl && titleEl.textContent.toLowerCase().includes(query));
    card.classList.toggle("search-hidden", !match);
  });

  if (query) {
    document.querySelectorAll("#main-screen details.group-collapsible").forEach((details) => {
      if (details.querySelector(".card:not(.search-hidden)")) {
        details.open = true;
      }
    });
  }
}

function initWatchlistSearch() {
  const input = document.getElementById("watchlist-search-input");
  input.addEventListener("input", applyWatchlistSearch);
}

/** Bascule d'onglet de catégorie (Séries/Animés/Films/Mangas-Scans) : ne
 * fait que changer `activeCategory` et redemander un rendu, tout le reste
 * (filtrage, statuts, cartes) est déjà géré par renderAll(). */
/** "En cours" n'a pas vraiment de sens pour les films (pas de notion
 * d'épisode en cours de diffusion) : sur cet onglet, "À regarder" passe
 * devant et reste ouvert par défaut, "En cours" repasse en second et se
 * replie. Appelé uniquement au changement d'onglet (pas à chaque
 * renderAll()), pour ne pas écraser un repli/dépli manuel de l'utilisateur
 * entre deux actions sur le même onglet. */
function applyCategoryDefaultOpenState(category) {
  // "En cours" n'existe pas pour les films (masquée entièrement, voir
  // renderCategoryChrome) : "À regarder" devient la section ouverte par
  // défaut sur cet onglet, comme "En cours" l'est pour Séries/Animés.
  document.getElementById("group-a-regarder").open = category === "films";
}

function initCategoryTabs() {
  const tabs = document.querySelectorAll(".category-tab");

  // Restaure la dernière catégorie choisie (persistée ci-dessous) pour ne
  // pas repartir systématiquement sur "Séries" à chaque rechargement de la
  // page (ex. cmd+maj+R en étant sur "Films"). initCategoryTabs s'exécute
  // avant boot()/renderAll(), donc activeCategory est déjà à jour au rendu.
  const stored = localStorage.getItem(LS.activeCategory);
  if (stored && (isRealCategory(stored) || stored === "manga")) {
    activeCategory = stored;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.category === stored));
    applyCategoryDefaultOpenState(activeCategory);
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activeCategory = tab.dataset.category;
      localStorage.setItem(LS.activeCategory, activeCategory);
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      applyCategoryDefaultOpenState(activeCategory);
      renderAll();
    });
  });
}

/* Le bootstrap réel ne s'exécute que dans un navigateur (pas lors des
   tests Node, où `document` n'existe pas). */
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    initSetupScreen();
    initAddPanel();
    initEpisodeModal();
    initDeleteChoiceModal();
    initWatchlistSearch();
    initCategoryTabs();

    document.getElementById("btn-refresh").addEventListener("click", boot);
    document.getElementById("btn-settings").addEventListener("click", () => {
      showScreen("setup-screen");
    });

    boot();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  });
}

/* Exposé pour les tests Node (ignoré dans le navigateur) */
if (typeof module !== "undefined") {
  module.exports = {
    groupByStatus,
    computeDelta,
    formatTvLatest,
    formatAnimeLatest,
    formatLastWatchedLabel,
    b64EncodeUnicode,
    b64DecodeUnicode,
    slugify,
    uniqueId,
    isAlreadyAdded,
    deriveTvEpisodeInfo,
    deriveAnimeEpisodeInfo,
    pickAnimeStreaming,
    formatEpisodeTag,
    formatAirdateDisplay,
    getStreamingIcon,
    formatSeriesEndDate,
    formatLastKnownEpisode,
    findLastAiredFromRaw,
    isoToDMY,
    getFinishedHistory,
    computeFinishedStatusLabel,
    getSeriesStreamingList,
    stripHtmlToParagraphs,
    chunkText,
    hashText,
  };
}
