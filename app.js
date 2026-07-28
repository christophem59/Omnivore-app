"use strict";

/* =========================================================================
   Suivi séries / animes — PWA
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
  const groups = { en_cours: [], suivi: [], a_regarder: [] };
  for (const item of items) {
    if (groups[item.status]) groups[item.status].push(item);
  }
  return groups;
}

/** Delta (nb d'épisodes de retard) uniquement calculable quand les deux
 * valeurs sont des compteurs absolus comparables (cas des animes). */
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
