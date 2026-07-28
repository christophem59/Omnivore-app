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
  posterCache: "sv_poster_cache",
  episodeCache: "sv_episode_cache",
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
 * - sinon : même type + même search_title (insensible à la casse). */
function isAlreadyAdded(result, items) {
  return items.some((item) => {
    if (result.anilist_id && item.anilist_id) {
      return item.anilist_id === result.anilist_id;
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
function formatAirdateDisplay(info) {
  if (info.unknown) return "Date inconnue pour l'instant";
  if (info.airdate === null || info.airdate === undefined) {
    return info.hasAired ? "Diffusé (date exacte inconnue)" : "À venir (date inconnue)";
  }
  let d;
  if (typeof info.airdate === "number") {
    d = new Date(info.airdate * 1000);
  } else {
    d = new Date(`${info.airdate}T00:00:00`);
  }
  const formatted = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  return info.hasAired ? `Diffusé le ${formatted}` : `À venir le ${formatted}`;
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
];

function getStreamingIcon(serviceName) {
  if (!serviceName) return null;
  const lower = serviceName.toLowerCase();
  const found = STREAMING_ICON_MAP.find((entry) => lower.includes(entry.match));
  return found ? { slug: found.slug, color: found.color } : null;
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
    return JSON.parse(localStorage.getItem(LS.posterCache) || "{}");
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
    }
  } catch (e) {
    console.warn("poster fetch failed for", item.id, e);
  }

  cache[item.id] = { url, ts: Date.now() };
  savePosterCache(cache);
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

  return { episodes, status: show.status, streaming };
}

/** Équivalent anime. Épingle anilist_id automatiquement si absent. */
async function fetchAnimeRaw(item) {
  const anilistId = item.anilist_id;
  const query = `
    query ($id: Int, $search: String) {
      Media(id: $id, search: $search, type: ANIME) {
        id
        status
        episodes
        nextAiringEpisode { episode airingAt }
        airingSchedule(perPage: 50) { nodes { episode airingAt } }
        streamingEpisodes { title url site }
      }
    }`;
  const variables = anilistId ? { id: anilistId } : { search: item.search_title };
  const resp = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`AniList : indisponible pour ${item.display_title}`);
  const payload = await resp.json();
  const media = payload.data && payload.data.Media;
  if (!media) throw new Error(`AniList : aucune fiche trouvée pour ${item.display_title}`);

  if (!anilistId) {
    item.anilist_id = media.id;
    await store.putFile("watchlist.json", watchlist, `Épinglage anilist_id : ${item.id}`);
  }

  return {
    status: media.status,
    totalEpisodes: media.episodes,
    nextAiringEpisode: media.nextAiringEpisode,
    airingSchedule: (media.airingSchedule && media.airingSchedule.nodes) || [],
    streamingEpisodesRaw: media.streamingEpisodes || [],
  };
}

async function fetchRawEpisodeData(item, { forceRefresh } = {}) {
  const cache = loadEpisodeCache();
  const cached = cache[item.id];
  if (!forceRefresh && cached && Date.now() - cached.ts < EPISODE_TTL_MS) {
    return cached.data;
  }
  const data = item.type === "tv" ? await fetchTvRaw(item) : await fetchAnimeRaw(item);
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
  if (item.type === "tv") {
    const today = new Date().toISOString().slice(0, 10);
    return deriveTvEpisodeInfo(raw, progressEpisode, today);
  }
  return deriveAnimeEpisodeInfo(raw, progressEpisode, Date.now() / 1000);
}

/* ------------------------------ Recherche (ajout de titre) ------------------------------ */

/** Recherche TVmaze multi-résultats (contrairement à singlesearch utilisé
 * ailleurs, qui ne renvoie qu'un seul "meilleur" résultat). */
async function searchTvmazeMulti(query) {
  const resp = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.slice(0, 8).map((entry) => ({
    type: "tv",
    title: entry.show.name,
    search_title: entry.show.name,
    year: entry.show.premiered ? entry.show.premiered.slice(0, 4) : "",
    image: entry.show.image ? entry.show.image.medium : null,
    status: entry.show.status,
  }));
}

/** Recherche AniList multi-résultats via Page(media:...), pour laisser
 * choisir la bonne fiche parmi plusieurs saisons/films/OVA homonymes. */
async function searchAnilistMulti(query) {
  const q = `
    query ($search: String) {
      Page(page: 1, perPage: 8) {
        media(search: $search, type: ANIME) {
          id
          title { romaji english }
          coverImage { medium }
          status
          episodes
          seasonYear
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
  return list.map((m) => ({
    type: "anime",
    title: m.title.romaji || m.title.english,
    search_title: m.title.romaji || m.title.english,
    anilist_id: m.id,
    year: m.seasonYear || "",
    image: m.coverImage ? m.coverImage.medium : null,
    status: m.status,
  }));
}

/* ------------------------------ App state ------------------------------ */

let store = null;
let watchlist = null;
let state = null;
let progress = null;

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
function flashWatched(cardEl) {
  return new Promise((resolve) => {
    const badge = document.createElement("div");
    badge.className = "watched-flash-badge";
    badge.textContent = "✓";
    cardEl.appendChild(badge);
    cardEl.classList.add("watched-flash");
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

/** Carte "série" classique (affiches + statut), utilisée pour les sections
 * À regarder et Terminé. La section En cours utilise buildEpisodeCard. */
async function buildShowCard(item) {
  const card = el("div", "card");

  const img = el("img", "poster");
  img.alt = item.display_title;
  card.appendChild(img);
  getPoster(item).then((url) => {
    if (url) img.src = url;
  });

  const body = el("div", "card-body");
  body.appendChild(el("p", "card-title", item.display_title));

  const stateEntry = state[item.id];

  if (item.status === "a_regarder") {
    body.appendChild(el("p", "card-sub", "Pas encore commencé"));
    const startBtn = el("button", "small-btn", "Commencer");
    startBtn.addEventListener("click", async () => {
      startBtn.textContent = "…";
      startBtn.disabled = true;
      try {
        await startWatching(item.id);
      } catch (e) {
        alert(e.message);
      }
      renderAll();
    });
    body.appendChild(startBtn);
  } else if (item.status === "termine") {
    const latestLabel = item.type === "tv" ? formatTvLatest(stateEntry) : formatAnimeLatest(stateEntry);
    body.appendChild(el("p", "card-sub", latestLabel));
    const resumeBtn = el("button", "small-btn", "Reprendre");
    resumeBtn.addEventListener("click", async () => {
      resumeBtn.disabled = true;
      try {
        await resumeWatching(item.id);
        await renderAll();
      } catch (e) {
        alert(e.message);
        resumeBtn.disabled = false;
      }
    });
    body.appendChild(resumeBtn);
  }

  card.appendChild(body);

  const deleteBtn = el("button", "card-delete", "🗑");
  deleteBtn.title = "Retirer ce titre";
  deleteBtn.addEventListener("click", async () => {
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

  let info;
  try {
    info = await getNextEpisodeInfo(item);
  } catch (e) {
    const body = el("div", "card-body");
    body.appendChild(el("p", "card-title", item.display_title));
    body.appendChild(el("p", "card-sub error-inline", `Impossible de récupérer les épisodes : ${e.message}`));
    card.appendChild(body);
    const deleteBtn = el("button", "card-delete", "🗑");
    deleteBtn.title = "Retirer ce titre";
    deleteBtn.addEventListener("click", async () => {
      const ok = confirm(`Retirer "${item.display_title}" de la watchlist ?`);
      if (!ok) return;
      await removeItem(item.id);
      await renderAll();
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
        await markFinished(item.id);
        showToast(`"${item.display_title}" terminé !`);
        await renderAll();
      } catch (e) {
        alert(e.message);
        confirmBtn.disabled = false;
      }
    });
    body.appendChild(confirmBtn);
    card.appendChild(body);

    const deleteBtn = el("button", "card-delete", "🗑");
    deleteBtn.title = "Retirer ce titre";
    deleteBtn.addEventListener("click", async () => {
      const ok = confirm(`Retirer "${item.display_title}" de la watchlist ?`);
      if (!ok) return;
      await removeItem(item.id);
      await renderAll();
    });
    card.appendChild(deleteBtn);
    return card;
  }

  if (!info.hasAired) card.classList.add("upcoming");

  const img = el("img", "poster");
  img.alt = item.display_title;
  card.appendChild(img);
  getPoster(item).then((url) => {
    if (url) img.src = url;
  });

  const clickableArea = el("div", "card-body card-body-clickable");
  clickableArea.appendChild(el("p", "card-title", item.display_title));

  const tag = el("span", "badge episode-tag", formatEpisodeTag(item.type, info));
  clickableArea.appendChild(tag);

  clickableArea.appendChild(el("p", "card-sub", formatAirdateDisplay(info)));

  if (info.extraBehind > 0) {
    clickableArea.appendChild(el("span", "badge behind", `+${info.extraBehind} autres épisodes en attente`));
  }

  if (!info.unknown) {
    clickableArea.addEventListener("click", () => openEpisodeModal(item, info));
  }
  card.appendChild(clickableArea);

  const actions = el("div", "card-actions");

  if (!info.unknown) {
    const watchedBtn = el("button", "small-btn primary-inline", "✓ Vu");
    watchedBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      watchedBtn.disabled = true;
      try {
        await flashWatched(card);
        await markEpisodeWatched(item);
      } catch (err) {
        alert(err.message);
        watchedBtn.disabled = false;
      }
    });
    actions.appendChild(watchedBtn);
  }

  const adjustBtn = el("button", "small-btn", "✎ Ajuster");
  adjustBtn.title = "Corriger manuellement le numéro d'épisode vu";
  adjustBtn.addEventListener("click", (e) => {
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
    updateProgress(item.id, parsed)
      .then(renderAll)
      .catch((err) => alert(err.message));
  });
  actions.appendChild(adjustBtn);

  card.appendChild(actions);

  const deleteBtn = el("button", "card-delete", "🗑");
  deleteBtn.title = "Retirer ce titre";
  deleteBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = confirm(`Retirer "${item.display_title}" de la watchlist ?`);
    if (!ok) return;
    deleteBtn.disabled = true;
    try {
      await removeItem(item.id);
      await renderAll();
    } catch (err) {
      alert(err.message);
      deleteBtn.disabled = false;
    }
  });
  card.appendChild(deleteBtn);

  return card;
}

function openEpisodeModal(item, info) {
  const modal = document.getElementById("episode-modal");
  const posterEl = document.getElementById("episode-modal-poster");
  const titleEl = document.getElementById("episode-modal-title");
  const tagEl = document.getElementById("episode-modal-tag");
  const airdateEl = document.getElementById("episode-modal-airdate");
  const summaryEl = document.getElementById("episode-modal-summary");
  const streamingEl = document.getElementById("episode-modal-streaming");

  titleEl.textContent = item.display_title;
  tagEl.textContent = formatEpisodeTag(item.type, info);
  airdateEl.textContent = formatAirdateDisplay(info);

  if (item.type === "tv" && info.summary) {
    // Le résumé TVmaze est du HTML simple (souvent juste des <p>).
    summaryEl.innerHTML = info.summary;
    summaryEl.classList.remove("hidden");
  } else {
    summaryEl.textContent = "";
    summaryEl.classList.add("hidden");
  }

  streamingEl.innerHTML = "";
  if (info.streaming) {
    const prefix = info.streaming.kind === "broadcast" ? "Diffusé sur : " : "Disponible sur : ";
    streamingEl.appendChild(document.createTextNode(prefix));

    const icon = getStreamingIcon(info.streaming.name);
    if (icon) {
      const img = document.createElement("img");
      img.className = "streaming-logo";
      img.src = `https://cdn.simpleicons.org/${icon.slug}/${icon.color}`;
      img.alt = info.streaming.name;
      img.title = info.streaming.name;
      img.onerror = () => {
        const fallback = el("span", "streaming-fallback", info.streaming.name);
        fallback.title = info.streaming.name;
        img.replaceWith(fallback);
      };
      streamingEl.appendChild(img);
    } else {
      const fallback = el("span", "streaming-fallback", info.streaming.name);
      fallback.title = info.streaming.name;
      streamingEl.appendChild(fallback);
    }
  } else {
    streamingEl.textContent = "Streaming légal : non disponible";
  }

  posterEl.src = "";
  getPoster(item).then((url) => {
    if (url) posterEl.src = url;
  });

  modal.classList.remove("hidden");
}

async function renderList(containerId, items, builder) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (const item of items) {
    container.appendChild(await builder(item));
  }
}

async function renderAll() {
  const groups = groupByStatus(watchlist.items);
  await renderList("list-en-cours", groups.en_cours, buildEpisodeCard);
  await renderList("list-a-regarder", groups.a_regarder, buildShowCard);
  await renderList("list-termine", groups.termine, buildShowCard);
}

/* ------------------------------ Actions ------------------------------ */

async function updateProgress(itemId, newEpisode) {
  progress[itemId] = { ...(progress[itemId] || {}), episode: newEpisode };
  await store.putFile("progress.json", progress, `Progression : ${itemId} -> épisode ${newEpisode}`);
}

async function startWatching(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "en_cours";
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> en_cours`);
  progress[itemId] = { episode: 0 };
  await store.putFile("progress.json", progress, `Progression : ${itemId} initialisée`);
}

/** Bascule un titre "en cours" vers "terminé" (ne touche pas à sa
 * progression, qui reste consultable si jamais on reprend plus tard). */
async function markFinished(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "termine";
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> terminé`);
}

/** Fait l'inverse : un titre "terminé" redevient "en cours" (ex. on
 * recommence la série, ou une nouvelle saison sort). */
async function resumeWatching(itemId) {
  const item = watchlist.items.find((i) => i.id === itemId);
  if (!item) return;
  item.status = "en_cours";
  await store.putFile("watchlist.json", watchlist, `Statut : ${itemId} -> en_cours (repris)`);
}

/** Marque l'épisode actuellement affiché comme vu (bouton "✓ Vu" de la
 * carte épisode) : incrémente la progression, puis regarde ce que ça donne
 * pour la suite (encore un épisode connu ? à jour mais série vivante ?
 * série terminée ?) pour décider du message de succès et d'un éventuel
 * changement de statut. */
async function markEpisodeWatched(item) {
  const raw = await fetchRawEpisodeData(item); // pas de refetch réseau : la donnée brute ne dépend pas de la progression
  const newEpisode = ((progress[item.id] && progress[item.id].episode) || 0) + 1;
  progress[item.id] = { episode: newEpisode };
  await store.putFile("progress.json", progress, `Progression : ${item.id} -> épisode ${newEpisode}`);

  const info =
    item.type === "tv"
      ? deriveTvEpisodeInfo(raw, newEpisode, new Date().toISOString().slice(0, 10))
      : deriveAnimeEpisodeInfo(raw, newEpisode, Date.now() / 1000);

  if (info.kind === "finished") {
    await markFinished(item.id);
    showToast(`"${item.display_title}" terminé !`);
  } else if (!info.hasAired) {
    showToast(`À jour sur "${item.display_title}" !`);
  }

  await renderAll();
}

/** Ajoute un nouveau titre à la watchlist (résultat de recherche + statut
 * choisis par l'utilisateur dans le panneau d'ajout). */
async function addNewItem({ title, type, searchTitle, anilistId, status }) {
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

  watchlist.items.push(newItem);
  await store.putFile("watchlist.json", watchlist, `Ajout : ${title}`);

  if (status === "en_cours") {
    progress[id] = { episode: 0 };
    await store.putFile("progress.json", progress, `Progression : ${id} initialisée`);
  }

  return id;
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

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) {
    s.classList.add("hidden");
  }
  document.getElementById(id).classList.remove("hidden");
}

async function loadAll() {
  watchlist = await store.getFile("watchlist.json");
  state = await store.getFile("state.json");
  try {
    progress = await store.getFile("progress.json");
  } catch (e) {
    progress = {};
  }
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
    await boot();
  });
}

function initEpisodeModal() {
  const modal = document.getElementById("episode-modal");
  const closeBtn = document.getElementById("btn-episode-modal-close");
  closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
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

  let currentType = "tv";
  let currentStatus = "a_regarder";

  function resetPanel() {
    searchInput.value = "";
    statusEl.textContent = "";
    resultsEl.innerHTML = "";
    errorEl.classList.add("hidden");
  }

  function closePanel() {
    overlay.classList.add("hidden");
  }

  openBtn.addEventListener("click", () => {
    resetPanel();
    overlay.classList.remove("hidden");
  });
  closeBtn.addEventListener("click", closePanel);

  // Clic sur le fond sombre (en dehors du panneau lui-même) = fermeture.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePanel();
  });

  typeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      typeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentType = btn.dataset.type;
    });
  });

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

    try {
      const results = currentType === "tv" ? await searchTvmazeMulti(query) : await searchAnilistMulti(query);
      statusEl.textContent = results.length ? `${results.length} résultat(s)` : "Aucun résultat.";
      resultsEl.innerHTML = "";
      for (const r of results) {
        const item = el("div", "result-item");
        const already = isAlreadyAdded(r, watchlist.items);
        if (already) item.classList.add("already-added");

        const img = document.createElement("img");
        img.src = r.image || "";
        img.alt = r.title;
        item.appendChild(img);

        const textWrap = el("div", "result-text");
        textWrap.appendChild(el("p", "result-title", r.title));
        textWrap.appendChild(el("p", "result-sub", `${r.year || ""} ${r.status ? "· " + r.status : ""}`.trim()));
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
            addBtn.disabled = true;
            errorEl.classList.add("hidden");
            try {
              await addNewItem({
                title: r.title,
                type: r.type,
                searchTitle: r.search_title,
                anilistId: r.anilist_id,
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
}

/* Le bootstrap réel ne s'exécute que dans un navigateur (pas lors des
   tests Node, où `document` n'existe pas). */
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    initSetupScreen();
    initAddPanel();
    initEpisodeModal();

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
  };
}
