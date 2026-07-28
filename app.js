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

async function buildCard(item) {
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

  if (item.status === "en_cours") {
    const latestLabel = item.type === "tv" ? formatTvLatest(stateEntry) : formatAnimeLatest(stateEntry);
    body.appendChild(el("p", "card-sub", latestLabel));

    const progEntry = progress[item.id] || { episode: 0 };
    const row = el("div", "progress-row");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = progEntry.episode;
    row.appendChild(input);

    const saveBtn = el("button", "small-btn", "Mettre à jour");
    saveBtn.addEventListener("click", async () => {
      const newVal = parseInt(input.value, 10);
      if (Number.isNaN(newVal) || newVal < 0) return;
      saveBtn.textContent = "…";
      saveBtn.disabled = true;
      try {
        await updateProgress(item.id, newVal);
      } catch (e) {
        alert(e.message);
      }
      saveBtn.textContent = "Mettre à jour";
      saveBtn.disabled = false;
      renderAll();
    });
    row.appendChild(saveBtn);
    body.appendChild(row);

    if (item.type === "anime" && stateEntry) {
      const delta = computeDelta(progEntry.episode, stateEntry.number);
      if (delta !== null) {
        const badge = el(
          "span",
          `badge ${delta > 0 ? "behind" : "uptodate"}`,
          delta > 0 ? `En retard de ${delta}` : "À jour"
        );
        body.appendChild(badge);
      }
    }
  } else if (item.status === "suivi") {
    const latestLabel = item.type === "tv" ? formatTvLatest(stateEntry) : formatAnimeLatest(stateEntry);
    body.appendChild(el("p", "card-sub", latestLabel));
  } else if (item.status === "a_regarder") {
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

async function renderList(containerId, items) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (const item of items) {
    container.appendChild(await buildCard(item));
  }
}

async function renderAll() {
  const groups = groupByStatus(watchlist.items);
  await renderList("list-en-cours", groups.en_cours);
  await renderList("list-suivi", groups.suivi);
  await renderList("list-a-regarder", groups.a_regarder);
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

  openBtn.addEventListener("click", () => {
    resetPanel();
    overlay.classList.remove("hidden");
  });
  closeBtn.addEventListener("click", () => overlay.classList.add("hidden"));

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
        const addBtn = el("button", "result-add-btn", "+");
        addBtn.type = "button";
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
            await renderAll();
          } catch (e) {
            addBtn.disabled = false;
            errorEl.textContent = e.message;
            errorEl.classList.remove("hidden");
          }
        });
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
  };
}
