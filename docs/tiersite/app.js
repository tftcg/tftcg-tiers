(function () {
  const TIERS = ["A", "B", "C+", "C", "C-", "D+", "D", "F"];
  const ROWS = [
    { type: "single", tier: "A" },
    { type: "single", tier: "B" },
    { type: "split", tiers: ["C+", "C"] },
    { type: "split", tiers: ["C-", "D+"] },
    { type: "single", tier: "D" },
    { type: "single", tier: "F" },
  ];
  const ZONES = [...TIERS, "pool"];
  const BUCKET_ORDER = ["characters", "stratagems", "battle-cards"];
  const STORAGE_KEY_VERSION = 1;
  const STORAGE_ENTRY_VERSION = 1;
  const EXPORT_VERSION = 1;
  const SELECTED_SET_STORAGE_KEY = "tftcg-tier-site-selected-set-v1";
  const ALL_SETS_EXPORT_FILENAME = "tftcg-tier-lists-all-sets.json";

  const manifest = window.TFTCG_TIER_SITE_MANIFEST;
  const tabsRoot = document.getElementById("tabs");
  const appRoot = document.getElementById("app");
  const resetButton = document.getElementById("reset-tier");
  const resetAllButton = document.getElementById("reset-all-tiers");
  const exportButton = document.getElementById("export-json");
  const importButton = document.getElementById("import-json");
  const importFileInput = document.getElementById("import-file");
  const statusMessage = document.getElementById("status-message");
  const setSelector = document.getElementById("set-selector");
  const setEyebrow = document.getElementById("set-eyebrow");
  const pageTitle = document.getElementById("page-title");
  const pageSubhead = document.getElementById("page-subhead");
  const hoverPreview = createHoverPreview();

  let currentSetMeta = null;
  let currentRuntime = null;
  let activeViewKey = "bucket:characters";
  let state = null;
  let statusTimeoutId = null;
  let loadRequestToken = 0;
  let previewCardId = null;
  let previewPointer = null;
  let suppressClickUntil = 0;

  const setAssetPromises = new Map();

  if (!manifest || !Array.isArray(manifest.sets) || !manifest.sets.length) {
    renderAppMessage("No supported TFTCG waves were generated for this site.", true);
    disableControls(true);
    return;
  }

  bindEvents();
  populateSetSelector();
  renderAppMessage("Loading wave data…");
  void switchSet(resolveInitialSetId(), { replaceHistory: true, showStatus: false });

  function bindEvents() {
    resetButton.addEventListener("click", () => {
      state = createDefaultState();
      saveState();
      render();
      setStatus(`Reset tier placements for ${currentSetMeta.name}.`, "success");
    });
    resetAllButton.addEventListener("click", resetAllTierPlacements);
    exportButton.addEventListener("click", () => {
      void exportStateToJson();
    });
    importButton.addEventListener("click", () => importFileInput.click());
    importFileInput.addEventListener("change", handleImportFile);
    setSelector.addEventListener("change", () => {
      void switchSet(setSelector.value, { replaceHistory: true, showStatus: true });
    });
    window.addEventListener("resize", syncPoolPanelHeight);
  }

  function populateSetSelector() {
    setSelector.replaceChildren();
    for (const setMeta of manifest.sets) {
      const option = document.createElement("option");
      option.value = setMeta.id;
      option.textContent = setMeta.name;
      setSelector.appendChild(option);
    }
  }

  function resolveInitialSetId() {
    const requestedSetId = new URLSearchParams(window.location.search).get("set");
    if (requestedSetId && getSetMetaById(requestedSetId)) {
      return requestedSetId;
    }

    const persistedSetId = localStorage.getItem(SELECTED_SET_STORAGE_KEY);
    if (persistedSetId && getSetMetaById(persistedSetId)) {
      return persistedSetId;
    }

    return manifest.defaultSetId || manifest.sets.at(-1)?.id || manifest.sets[0].id;
  }

  async function switchSet(requestedSetId, options = {}) {
    const setMeta = getSetMetaById(requestedSetId) || manifest.sets[0];
    const requestToken = ++loadRequestToken;
    disableControls(true);
    hideHoverPreview();
    setSelector.value = setMeta.id;
    renderAppMessage(`Loading ${setMeta.name}…`);

    try {
      const runtime = await getRuntimeForSet(setMeta.id);
      if (requestToken !== loadRequestToken) {
        return;
      }

      currentSetMeta = runtime.meta;
      currentRuntime = runtime;
      initializeRuntime(runtime);
      updatePageCopy();
      updateSelectedSetState(options.replaceHistory !== false);
      render();
      disableControls(false);
      if (options.showStatus) {
        setStatus(`Loaded ${currentSetMeta.name}.`, "success");
      }
    } catch (error) {
      disableControls(false);
      renderAppMessage(error instanceof Error ? error.message : "Failed to load set data.", true);
      setStatus(error instanceof Error ? error.message : "Failed to load set data.", "error");
    }
  }

  function disableControls(disabled) {
    resetButton.disabled = disabled;
    resetAllButton.disabled = disabled;
    exportButton.disabled = disabled;
    importButton.disabled = disabled;
    importFileInput.disabled = disabled;
    setSelector.disabled = disabled;
  }

  function updatePageCopy() {
    setEyebrow.textContent = currentSetMeta.name;
    pageTitle.textContent = `${currentSetMeta.name} Tier Views`;
    pageSubhead.textContent =
      `Tier ${currentSetMeta.characterCount} Characters, ${currentSetMeta.stratagemCount} Stratagems, and `
      + `${currentSetMeta.battleCardCount} Battle Cards for ${currentSetMeta.name}. `
      + "Click multi-sided cards to cycle modes, and character tabs track common factions and traits for that wave.";
    document.title = `${currentSetMeta.name} · TFTCG Tier Views`;
  }

  function updateSelectedSetState(replaceHistory) {
    localStorage.setItem(SELECTED_SET_STORAGE_KEY, currentSetMeta.id);
    setSelector.value = currentSetMeta.id;
    const url = new URL(window.location.href);
    url.searchParams.set("set", currentSetMeta.id);
    if (replaceHistory) {
      window.history.replaceState({}, "", url);
    }
  }

  function getSetMetaById(setId) {
    return manifest.sets.find((candidate) => candidate.id === setId) || null;
  }

  function loadSetPayload(setMeta) {
    const existingPayload = window.TFTCG_TIER_SITE_SETS?.[setMeta.id];
    if (existingPayload) {
      return Promise.resolve(existingPayload);
    }

    if (setAssetPromises.has(setMeta.id)) {
      return setAssetPromises.get(setMeta.id);
    }

    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = setMeta.asset;
      script.async = true;
      script.dataset.setId = setMeta.id;
      script.onload = () => {
        const payload = window.TFTCG_TIER_SITE_SETS?.[setMeta.id];
        if (payload) {
          resolve(payload);
          return;
        }
        setAssetPromises.delete(setMeta.id);
        reject(new Error(`Loaded ${setMeta.asset} but no set payload was registered.`));
      };
      script.onerror = () => {
        setAssetPromises.delete(setMeta.id);
        reject(new Error(`Failed to load ${setMeta.asset}.`));
      };
      document.body.appendChild(script);
    });

    setAssetPromises.set(setMeta.id, promise);
    return promise;
  }

  async function getRuntimeForSet(setId) {
    const setMeta = getSetMetaById(setId);
    if (!setMeta) {
      throw new Error(`Unknown set ${setId}.`);
    }
    const payload = await loadSetPayload(setMeta);
    return buildSetRuntime(payload, setMeta);
  }

  function buildSetRuntime(payload, fallbackMeta) {
    const meta = payload?.meta || fallbackMeta;
    const cards = Array.isArray(payload?.cards) ? payload.cards.slice() : [];
    const cardsById = Object.fromEntries(cards.map((card) => [card.id, card]));
    const cardOrderIndex = Object.fromEntries(cards.map((card, index) => [card.id, index]));
    const cardsByBucket = BUCKET_ORDER.reduce((acc, bucket) => ({ ...acc, [bucket]: [] }), {});
    for (const card of cards) {
      if (!cardsByBucket[card.bucket]) {
        cardsByBucket[card.bucket] = [];
      }
      cardsByBucket[card.bucket].push(card);
    }

    const primaryViews = [
      { key: "bucket:characters", label: "Characters", type: "bucket", bucket: "characters" },
      { key: "bucket:stratagems", label: "Stratagems", type: "bucket", bucket: "stratagems" },
      { key: "bucket:battle-cards", label: "Battle Cards", type: "bucket", bucket: "battle-cards" },
    ];
    const characterFilters = payload?.characterFilters || { factions: [], traits: [] };
    const battleFilters = Array.isArray(payload?.battleFilters) ? payload.battleFilters.slice() : [];
    const viewDefs = [
      ...primaryViews,
      ...characterFilters.factions.map((view) => ({ ...view, type: "filter" })),
      ...characterFilters.traits.map((view) => ({ ...view, type: "filter" })),
      ...battleFilters.map((view) => ({ ...view, type: "filter" })),
    ];

    return {
      meta,
      cards,
      cardsById,
      cardOrderIndex,
      cardsByBucket,
      primaryViews,
      characterFilters,
      battleFilters,
      viewDefs,
    };
  }

  function initializeRuntime(runtime) {
    const persisted = loadPersistedState(runtime.meta.id);
    activeViewKey = isValidViewKeyFor(runtime, persisted.activeViewKey) ? persisted.activeViewKey : "bucket:characters";
    state = normalizeStateFor(runtime, persisted.state);
  }

  function getStorageKeyFor(setId) {
    return `tftcg-tier-site-set-${setId}-v${STORAGE_KEY_VERSION}`;
  }

  function loadPersistedState(setId) {
    try {
      const raw = localStorage.getItem(getStorageKeyFor(setId));
      if (!raw) {
        return { state: null, activeViewKey: null };
      }
      const parsed = JSON.parse(raw);
      return {
        state: parsed?.state || null,
        activeViewKey: typeof parsed?.activeViewKey === "string" ? parsed.activeViewKey : null,
      };
    } catch {
      return { state: null, activeViewKey: null };
    }
  }

  function saveSetState(setId, nextActiveViewKey, nextState) {
    localStorage.setItem(
      getStorageKeyFor(setId),
      JSON.stringify({
        version: STORAGE_ENTRY_VERSION,
        setId,
        activeViewKey: nextActiveViewKey,
        state: nextState,
      })
    );
  }

  function saveState() {
    saveSetState(currentSetMeta.id, activeViewKey, state);
  }

  function emptyBucketState() {
    return Object.fromEntries(ZONES.map((zone) => [zone, []]));
  }

  function createDefaultStateFor(runtime) {
    const buckets = {};
    for (const bucket of BUCKET_ORDER) {
      buckets[bucket] = emptyBucketState();
      buckets[bucket].pool = runtime.cardsByBucket[bucket].map((card) => card.id);
    }

    return {
      buckets,
      modes: {},
    };
  }

  function createDefaultState() {
    return createDefaultStateFor(currentRuntime);
  }

  function normalizeStateFor(runtime, rawState) {
    const normalized = createDefaultStateFor(runtime);
    const sourceBuckets = rawState?.buckets || rawState;
    const sourceModes = rawState?.modes;

    for (const bucket of BUCKET_ORDER) {
      const validIds = new Set(runtime.cardsByBucket[bucket].map((card) => card.id));
      const seen = new Set();
      const sourceBucket = sourceBuckets?.[bucket];
      const nextBucketState = emptyBucketState();

      for (const zone of ZONES) {
        const ids = Array.isArray(sourceBucket?.[zone]) ? sourceBucket[zone] : [];
        nextBucketState[zone] = ids.filter((id) => {
          if (!validIds.has(id) || seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        });
      }

      const missing = runtime.cardsByBucket[bucket]
        .map((card) => card.id)
        .filter((id) => !seen.has(id));
      nextBucketState.pool.push(...missing);
      normalized.buckets[bucket] = nextBucketState;
    }

    if (sourceModes && typeof sourceModes === "object") {
      for (const card of runtime.cards) {
        const rawModeIndex = sourceModes[card.id];
        if (!Number.isInteger(rawModeIndex)) {
          continue;
        }
        if (rawModeIndex >= 0 && rawModeIndex < card.modes.length) {
          normalized.modes[card.id] = rawModeIndex;
        }
      }
    }

    return normalized;
  }

  function resetAllTierPlacements() {
    disableControls(true);
    try {
      for (const setMeta of manifest.sets) {
        localStorage.removeItem(getStorageKeyFor(setMeta.id));
      }
      state = createDefaultState();
      saveState();
      render();
      setStatus("Reset tier placements for all waves.", "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to reset tier placements for all waves.", "error");
    } finally {
      disableControls(false);
    }
  }

  async function exportStateToJson() {
    disableControls(true);
    try {
      const payload = {
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        selectedSetId: currentSetMeta.id,
        sets: {},
      };

      for (const setMeta of manifest.sets) {
        const runtime = await getRuntimeForSet(setMeta.id);
        const persisted = loadPersistedState(setMeta.id);
        payload.sets[setMeta.id] = {
          setId: setMeta.id,
          setName: runtime.meta.name,
          activeViewKey: isValidViewKeyFor(runtime, persisted.activeViewKey) ? persisted.activeViewKey : "bucket:characters",
          state: normalizeStateFor(runtime, persisted.state),
        };
      }

      downloadJson(payload, ALL_SETS_EXPORT_FILENAME);
      setStatus("Exported tier lists for all waves.", "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to export tier list JSON.", "error");
    } finally {
      disableControls(false);
    }
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(event) {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    disableControls(true);
    try {
      const payload = JSON.parse(await file.text());
      if (!isPlainObject(payload) || !isPlainObject(payload.sets)) {
        throw new Error("File does not contain a TFTCG tier export.");
      }

      const importedSetIds = [];
      for (const [setId, entry] of Object.entries(payload.sets)) {
        if (!isPlainObject(entry) || !isPlainObject(entry.state)) {
          continue;
        }
        const runtime = await getRuntimeForSet(setId);
        const nextActiveViewKey = isValidViewKeyFor(runtime, entry.activeViewKey) ? entry.activeViewKey : "bucket:characters";
        const nextState = normalizeStateFor(runtime, entry.state);
        saveSetState(setId, nextActiveViewKey, nextState);
        importedSetIds.push(setId);
      }

      if (!importedSetIds.length) {
        throw new Error("File does not contain any recognized wave tier data.");
      }

      const restoredSetId = importedSetIds.includes(payload.selectedSetId) ? payload.selectedSetId : importedSetIds[0];
      await switchSet(restoredSetId, { replaceHistory: true, showStatus: false });
      setStatus(`Imported tier lists for ${importedSetIds.length} wave${importedSetIds.length === 1 ? "" : "s"} from ${file.name}.`, "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to import tier list JSON.", "error");
    } finally {
      importFileInput.value = "";
      disableControls(false);
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function setStatus(message, tone = "info") {
    statusMessage.textContent = message;
    statusMessage.className = "status-message";
    if (tone === "error") {
      statusMessage.classList.add("is-error");
    } else if (tone === "success") {
      statusMessage.classList.add("is-success");
    }

    if (statusTimeoutId) {
      clearTimeout(statusTimeoutId);
    }
    statusTimeoutId = window.setTimeout(() => {
      statusMessage.textContent = "";
      statusMessage.className = "status-message";
    }, 3500);
  }

  function render() {
    if (!currentRuntime) {
      return;
    }
    renderTabs();
    renderActiveBucket();
  }

  function renderTabs() {
    tabsRoot.replaceChildren();
    const activeView = getActiveView();

    const primarySection = document.createElement("section");
    primarySection.className = "tab-section";
    primarySection.appendChild(createTabSectionLabel("Card groups"));
    const primaryRow = document.createElement("div");
    primaryRow.className = "tab-row";
    for (const view of currentRuntime.primaryViews) {
      primaryRow.appendChild(createTabButton(view, activeView.bucket === view.bucket));
    }
    primarySection.appendChild(primaryRow);
    tabsRoot.appendChild(primarySection);

    if (activeView.bucket === "characters") {
      appendFilterSection("Factions", currentRuntime.characterFilters.factions);
      appendFilterSection("Traits", currentRuntime.characterFilters.traits);
    } else if (activeView.bucket === "battle-cards") {
      appendFilterSection("Battle card types", currentRuntime.battleFilters);
    }
  }

  function appendFilterSection(label, views) {
    if (!Array.isArray(views) || !views.length) {
      return;
    }
    const section = document.createElement("section");
    section.className = "tab-section";
    section.appendChild(createTabSectionLabel(label));
    const row = document.createElement("div");
    row.className = "tab-row";
    for (const view of views) {
      row.appendChild(createTabButton(view, view.key === activeViewKey));
    }
    section.appendChild(row);
    tabsRoot.appendChild(section);
  }

  function createTabSectionLabel(label) {
    const node = document.createElement("div");
    node.className = "tab-section-label";
    node.textContent = label;
    return node;
  }

  function createTabButton(view, isActive) {
    const button = document.createElement("button");
    const count = document.createElement("span");
    button.type = "button";
    button.className = isActive ? "tab-button active" : "tab-button";
    button.append(getTabLabel(view));
    count.textContent = `(${getViewCardCount(view)})`;
    button.appendChild(count);
    button.addEventListener("click", () => {
      activeViewKey = view.key;
      saveState();
      render();
    });
    return button;
  }

  function renderActiveBucket() {
    const view = getActiveView();
    const visibleState = getVisibleState(view);
    const viewCount = getViewCardCount(view);

    const meta = document.createElement("section");
    meta.className = "tab-meta";
    meta.append(
      createMetaText(`Showing `, createStrongText(viewCount), ` card${viewCount === 1 ? "" : "s"} in `, createStrongText(getTabLabel(view)), "."),
      createMetaText("Click a multi-sided card to cycle its modes."),
      createMetaText("Hover a thumbnail to magnify it, then drag it into place.")
    );

    const board = document.createElement("section");
    board.className = "tier-board";
    const showEmptyTierHint = visibleState.pool.length > 0;
    for (const rowDef of ROWS) {
      if (rowDef.type === "split") {
        board.appendChild(createSplitTierRow(rowDef.tiers, visibleState, showEmptyTierHint, view));
      } else {
        board.appendChild(createTierRow(rowDef.tier, visibleState[rowDef.tier], showEmptyTierHint, view));
      }
    }

    const pool = document.createElement("section");
    pool.className = "pool-panel";
    pool.appendChild(createPoolPanel(visibleState.pool, view));

    const layout = document.createElement("section");
    layout.className = "board-layout";
    layout.append(board, pool);

    appRoot.replaceChildren(meta, layout);
    requestAnimationFrame(syncPoolPanelHeight);
  }

  function renderAppMessage(message, isError = false) {
    const notice = document.createElement("section");
    notice.className = isError ? "app-message is-error" : "app-message";
    notice.textContent = message;
    appRoot.replaceChildren(notice);
  }

  function syncPoolPanelHeight() {
    const board = document.querySelector(".tier-board");
    const pool = document.querySelector(".pool-panel");
    if (!board || !pool) {
      return;
    }

    if (window.innerWidth <= 980) {
      pool.style.height = "";
      return;
    }

    pool.style.height = `${board.offsetHeight}px`;
  }

  function createTierRow(tier, cardIds, showEmptyHint, view) {
    const row = document.createElement("div");
    row.className = "tier-row";

    const badge = document.createElement("div");
    badge.className = "tier-badge";
    badge.dataset.tier = tier;
    badge.textContent = tier;

    row.append(badge, createTrack(tier, cardIds, view, { showEmptyHint }));
    return row;
  }

  function createSplitTierRow(tiers, bucketState, showEmptyHint, view) {
    const row = document.createElement("div");
    row.className = "tier-row tier-row-split";

    const badgeGroup = document.createElement("div");
    badgeGroup.className = "tier-badge-stack";
    for (const tier of tiers) {
      const badge = document.createElement("div");
      badge.className = "tier-badge tier-badge-split";
      badge.dataset.tier = tier;
      badge.textContent = tier;
      badgeGroup.appendChild(badge);
    }

    const trackGroup = document.createElement("div");
    trackGroup.className = "split-track-group";
    for (const tier of tiers) {
      trackGroup.appendChild(createTrack(tier, bucketState[tier], view, { showEmptyHint, className: "split-card-track" }));
    }

    row.append(badgeGroup, trackGroup);
    return row;
  }

  function createPoolPanel(cardIds, view) {
    const wrapper = document.createElement("div");
    wrapper.className = "pool-content";

    const header = document.createElement("div");
    header.className = "pool-header";

    const title = document.createElement("div");
    title.className = "pool-title";
    title.textContent = "Untiered Pool";

    const note = document.createElement("div");
    note.className = "pool-note";
    note.textContent = `${cardIds.length} card${cardIds.length === 1 ? "" : "s"} remaining`;

    header.append(title, note);
    wrapper.append(header, createTrack("pool", cardIds, view, { showEmptyHint: true }));
    return wrapper;
  }

  function createTrack(zone, cardIds, view, options = {}) {
    const track = document.createElement("div");
    track.className = zone === "pool" ? "card-track pool-track" : "card-track";
    if (options.className) {
      track.classList.add(options.className);
    }
    track.dataset.zone = zone;

    for (const cardId of cardIds) {
      track.appendChild(createCard(cardId, view));
    }

    if (!cardIds.length && options.showEmptyHint !== false) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = zone === "pool" ? "Drag cards here to remove them from tiers." : "Drop cards here.";
      track.appendChild(empty);
    }

    track.addEventListener("dragover", handleTrackDragOver);
    track.addEventListener("dragenter", () => track.classList.add("drag-target"));
    track.addEventListener("dragleave", (event) => {
      if (!track.contains(event.relatedTarget)) {
        track.classList.remove("drag-target");
      }
    });
    track.addEventListener("drop", handleTrackDrop);

    return track;
  }

  function createCard(cardId, view) {
    const card = currentRuntime.cardsById[cardId];
    const article = document.createElement("article");
    article.className = "card";
    article.draggable = true;
    article.dataset.cardId = card.id;

    const image = document.createElement("img");
    article.appendChild(image);
    updateCardFace(article, card);

    article.addEventListener("mouseenter", (event) => {
      if (document.body.classList.contains("is-dragging")) {
        return;
      }
      previewPointer = { clientX: event.clientX, clientY: event.clientY };
      showHoverPreview(card, event);
    });
    article.addEventListener("mousemove", (event) => {
      previewPointer = { clientX: event.clientX, clientY: event.clientY };
      if (previewCardId === card.id) {
        updateHoverPreviewPosition(event);
      }
    });
    article.addEventListener("mouseleave", () => {
      if (previewCardId === card.id) {
        hideHoverPreview();
      }
    });
    article.addEventListener("click", (event) => {
      if (Date.now() < suppressClickUntil || card.modes.length <= 1) {
        return;
      }
      event.preventDefault();
      advanceCardMode(card, article);
    });
    article.addEventListener("dragstart", (event) => {
      hideHoverPreview();
      document.body.classList.add("is-dragging");
      article.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.id);
    });
    article.addEventListener("dragend", () => {
      suppressClickUntil = Date.now() + 150;
      document.body.classList.remove("is-dragging");
      article.classList.remove("dragging");
      document.querySelectorAll(".card-track").forEach((track) => track.classList.remove("drag-target"));
      syncStateFromDom();
      saveState();
      renderActiveBucket();
    });

    return article;
  }

  function updateCardFace(article, card) {
    const modeIndex = getCurrentModeIndex(card);
    const mode = card.modes[modeIndex];
    const image = article.querySelector("img");
    image.src = mode.image;
    image.alt = `${card.name} (${mode.label})`;
    article.title = buildCardTitle(card, mode);

    article.querySelector(".card-badge")?.remove();
    article.querySelector(".card-face-count")?.remove();

    if (card.modes.length > 1) {
      const badge = document.createElement("div");
      badge.className = "card-badge";
      badge.textContent = mode.label;
      article.appendChild(badge);

      const count = document.createElement("div");
      count.className = "card-face-count";
      count.textContent = `${modeIndex + 1}/${card.modes.length}`;
      article.appendChild(count);
    }
  }

  function buildCardTitle(card, mode) {
    const lines = [
      card.name,
      [card.number, card.rarity, mode.label].filter(Boolean).join(" • "),
      formatModeStats(mode),
      mode.factions.join(", "),
      mode.traits.join(", "),
      mode.text,
    ].filter(Boolean);
    return lines.join("\n");
  }

  function formatModeStats(mode) {
    const stats = [];
    if (mode.stars) {
      stats.push(`${mode.stars}★`);
    }
    if (mode.atk) {
      stats.push(`ATK ${mode.atk}`);
    }
    if (mode.def) {
      stats.push(`DEF ${mode.def}`);
    }
    if (mode.hp) {
      stats.push(`HP ${mode.hp}`);
    }
    return stats.join(" • ");
  }

  function getCurrentModeIndex(card) {
    const modeIndex = state?.modes?.[card.id];
    return Number.isInteger(modeIndex) && modeIndex >= 0 && modeIndex < card.modes.length ? modeIndex : 0;
  }

  function advanceCardMode(card, article) {
    const nextModeIndex = (getCurrentModeIndex(card) + 1) % card.modes.length;
    state.modes[card.id] = nextModeIndex;
    saveState();
    updateCardFace(article, card);
    if (previewCardId === card.id && previewPointer) {
      showHoverPreview(card, previewPointer);
    }
  }

  function createHoverPreview() {
    const preview = document.createElement("div");
    const image = document.createElement("img");
    preview.className = "hover-preview";
    image.alt = "";
    preview.appendChild(image);
    document.body.appendChild(preview);
    return preview;
  }

  function showHoverPreview(card, event) {
    previewCardId = card.id;
    const mode = card.modes[getCurrentModeIndex(card)];
    const image = hoverPreview.querySelector("img");
    image.src = mode.image;
    image.alt = `${card.name} (${mode.label})`;
    updateHoverPreviewPosition(event);
    hoverPreview.classList.add("visible");
  }

  function updateHoverPreviewPosition(event) {
    const imageWidth = 360;
    const imageHeight = 520;
    const gap = 20;
    let left = event.clientX + gap;
    let top = event.clientY - imageHeight / 2;

    if (left + imageWidth > window.innerWidth - 12) {
      left = event.clientX - imageWidth - gap;
    }
    if (left < 12) {
      left = 12;
    }
    if (top < 12) {
      top = 12;
    }
    if (top + imageHeight > window.innerHeight - 12) {
      top = window.innerHeight - imageHeight - 12;
    }

    hoverPreview.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }

  function hideHoverPreview() {
    previewCardId = null;
    previewPointer = null;
    hoverPreview.classList.remove("visible");
  }

  function handleTrackDragOver(event) {
    event.preventDefault();
    const track = event.currentTarget;
    const draggingCard = document.querySelector(".card.dragging");
    if (!draggingCard) {
      return;
    }

    removeEmptyState(track);
    const afterElement = getAfterElement(track, event.clientX, event.clientY);
    if (afterElement) {
      track.insertBefore(draggingCard, afterElement);
    } else {
      track.appendChild(draggingCard);
    }
  }

  function handleTrackDrop(event) {
    event.preventDefault();
    const track = event.currentTarget;
    track.classList.remove("drag-target");
    syncStateFromDom();
    saveState();
    renderActiveBucket();
  }

  function syncStateFromDom() {
    const view = getActiveView();
    if (view.type === "filter") {
      syncFilterViewState(view);
      return;
    }

    const bucket = view.bucket;
    const nextBucketState = emptyBucketState();
    const validIds = new Set(currentRuntime.cardsByBucket[bucket].map((card) => card.id));
    document.querySelectorAll(".card-track").forEach((track) => {
      const zone = track.dataset.zone;
      nextBucketState[zone].push(
        ...Array.from(track.querySelectorAll(".card"))
          .map((cardNode) => cardNode.dataset.cardId)
          .filter((id, index, ids) => validIds.has(id) && ids.indexOf(id) === index)
      );
    });

    const assigned = new Set(ZONES.flatMap((zone) => nextBucketState[zone]));
    const missing = currentRuntime.cardsByBucket[bucket]
      .map((card) => card.id)
      .filter((id) => !assigned.has(id));
    nextBucketState.pool.push(...missing);
    state.buckets[bucket] = nextBucketState;
  }

  function syncFilterViewState(view) {
    const bucket = view.bucket;
    const filteredIds = new Set(getViewCards(view).map((card) => card.id));
    const nextBucketState = {};
    for (const zone of ZONES) {
      nextBucketState[zone] = state.buckets[bucket][zone].filter((id) => !filteredIds.has(id));
    }

    const assigned = new Set();
    document.querySelectorAll(".card-track").forEach((track) => {
      const zone = track.dataset.zone;
      const ids = Array.from(track.querySelectorAll(".card"))
        .map((cardNode) => cardNode.dataset.cardId)
        .filter((id) => filteredIds.has(id) && !assigned.has(id));
      for (const id of ids) {
        assigned.add(id);
        nextBucketState[zone].push(id);
      }
    });

    const missing = currentRuntime.cardsByBucket[bucket]
      .filter((card) => cardMatchesView(view, card))
      .map((card) => card.id)
      .filter((id) => !assigned.has(id))
      .sort((left, right) => currentRuntime.cardOrderIndex[left] - currentRuntime.cardOrderIndex[right]);
    nextBucketState.pool.push(...missing);
    state.buckets[bucket] = nextBucketState;
  }

  function removeEmptyState(track) {
    track.querySelector(".empty-state")?.remove();
  }

  function getAfterElement(track, x, y) {
    const cardsInTrack = [...track.querySelectorAll(".card:not(.dragging)")]
      .map((card) => ({ card, rect: card.getBoundingClientRect() }))
      .sort((left, right) => {
        const topDelta = left.rect.top - right.rect.top;
        if (Math.abs(topDelta) > 8) {
          return topDelta;
        }
        return left.rect.left - right.rect.left;
      });

    if (!cardsInTrack.length) {
      return null;
    }

    const rows = [];
    for (const item of cardsInTrack) {
      const currentRow = rows.at(-1);
      if (!currentRow || Math.abs(item.rect.top - currentRow.top) > 8) {
        rows.push({ top: item.rect.top, bottom: item.rect.bottom, items: [item] });
        continue;
      }
      currentRow.bottom = Math.max(currentRow.bottom, item.rect.bottom);
      currentRow.items.push(item);
    }

    const targetRowIndex = rows.findIndex((row, index) => {
      const nextRow = rows[index + 1];
      const boundary = nextRow ? row.bottom + (nextRow.top - row.bottom) / 2 : Number.POSITIVE_INFINITY;
      return y <= boundary;
    });

    if (targetRowIndex === -1) {
      return null;
    }

    const targetRow = rows[targetRowIndex];
    for (const item of targetRow.items) {
      if (x < item.rect.left + item.rect.width / 2) {
        return item.card;
      }
    }

    return rows[targetRowIndex + 1]?.items[0]?.card ?? null;
  }

  function getActiveView() {
    return currentRuntime.viewDefs.find((view) => view.key === activeViewKey) || currentRuntime.primaryViews[0];
  }

  function getViewCards(view) {
    if (view.type === "bucket") {
      return currentRuntime.cardsByBucket[view.bucket] || [];
    }
    return (currentRuntime.cardsByBucket[view.bucket] || []).filter((card) => cardMatchesView(view, card));
  }

  function getViewCardCount(view) {
    return getViewCards(view).length;
  }

  function cardMatchesView(view, card) {
    if (view.type === "bucket") {
      return card.bucket === view.bucket;
    }
    if (view.kind === "battle") {
      return card.battleFilters.includes(view.value);
    }
    if (view.kind === "faction") {
      return card.factions.includes(view.value);
    }
    if (view.kind === "trait") {
      return card.traits.includes(view.value);
    }
    return false;
  }

  function getVisibleState(view) {
    const visibleState = emptyBucketState();
    const bucketState = state.buckets[view.bucket];
    for (const zone of ZONES) {
      for (const id of bucketState[zone]) {
        if (cardMatchesView(view, currentRuntime.cardsById[id])) {
          visibleState[zone].push(id);
        }
      }
    }
    return visibleState;
  }

  function getTabLabel(view) {
    if (view.type === "bucket") {
      return view.label;
    }
    if (view.kind === "faction") {
      return view.label;
    }
    if (view.kind === "trait") {
      return view.label;
    }
    return view.label;
  }

  function createMetaText(...parts) {
    const node = document.createElement("div");
    for (const part of parts) {
      node.append(part);
    }
    return node;
  }

  function createStrongText(value) {
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    return strong;
  }

  function isValidViewKeyFor(runtime, viewKey) {
    return typeof viewKey === "string" && runtime.viewDefs.some((view) => view.key === viewKey);
  }
})();
