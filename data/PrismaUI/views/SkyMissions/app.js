(() => {
  const surface = document.body.dataset.surface || 'missions';
  const isMissionApp = surface === 'missions';
  const bridgeChannel = isMissionApp ? 'skymissions' : 'skyachievements';
  const filters = {
    'achievement-quest-plugin': 'all',
    'achievement-location-plugin': 'all',
    'achievement-item-plugin': 'all',
    'achievement-item-rarity': 'all',
    'achievement-marital-status': 'Single'
  };
  let data = { player: {}, history: {}, missionEvents: [], items: [], locations: [], storeOffers: [], gameStoreItems: [], assets: { playerCard: null, nameCards: [], achievements: [], properties: [], apiMissions: [], apiStoreOffers: [] }, playerLoaded: false, historyLoaded: false, itemsLoaded: false, locationsLoaded: false, assetsLoaded: false };
  let activeTab = isMissionApp ? 'dashboard' : 'achievements';
  let activeDashboardTab = 'overview';
  const settingsPrefix = isMissionApp ? 'skymissions.dashboard.v1' : 'skyachievements.dashboard.v1';
  const legacySettingsPrefix = 'skyachievements.dashboard.v1';
  let settingsKey = `${settingsPrefix}:pending`;
  const readSettings = (key) => {
    const defaults = { nameCard: '', defaultNameCardApplied: false, title: '', mainFaction: '', properties: [], mainProperty: '', maritalStatus: 'Single', spouse: '', missionState: null, purchasedStoreOffers: [], achievementProgress: {}, unlockedAchievements: [] };
    try {
      const legacyKey = isMissionApp ? key.replace(settingsPrefix, legacySettingsPrefix) : '';
      const saved = JSON.parse(localStorage.getItem(key) || (legacyKey ? localStorage.getItem(legacyKey) : '') || '{}');
      return { ...defaults, ...saved, properties: Array.isArray(saved.properties) ? saved.properties : [], purchasedStoreOffers: Array.isArray(saved.purchasedStoreOffers) ? saved.purchasedStoreOffers : [], achievementProgress: saved.achievementProgress && typeof saved.achievementProgress === 'object' ? saved.achievementProgress : {}, unlockedAchievements: Array.isArray(saved.unlockedAchievements) ? saved.unlockedAchievements : [] };
    } catch (_) { return defaults; }
  };
  let profileSettings = readSettings(settingsKey);
  let achievementCarouselOffset = 0;
  let nameCardListOffset = 0;
  let scheduledRenderTimer = 0;
  let renderScheduleCount = 0;
  let achievementDataRevision = 0;
  let achievementEvaluationCache = { revision: -1, settingsKey: '', results: new Map(), unlocked: [] };
  const byId = (id) => document.getElementById(id);
  let missionToastTimer = 0;
  const MISSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const MANUAL_MISSION_REFRESH_COST = 20;
  const MISSION_OFFER_COUNT = 12;
  const STORE_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
  const MANUAL_STORE_REFRESH_COST = 50;
  let pendingStoreRefresh = null;
  const pendingGameStorePurchases = new Map();
  const processedSkyAchievementsUpdateIds = new Set();
  const latestSkyAchievementsUpdateIds = new Map();
  let expectedHistoryChunkCount = 0;
  let receivedHistoryChunkCount = 0;
  function reportSkyAchievementsDiagnostic(message) {
    window.parent.postMessage({ channel: bridgeChannel, type: 'diagnostic', payload: { message: String(message || '').slice(0, 180) } }, '*');
  }
  function acknowledgeSkyAchievementsUpdate(id, kind, ok, detail = '') {
    const started = performance.now();
    window.parent.postMessage({ channel: bridgeChannel, type: 'update-ack', payload: { id, kind, ok, detail: String(detail || '').slice(0, 100) } }, '*');
    reportSkyAchievementsDiagnostic(`TRACE ack post returned id=${id} kind=${kind} ok=${ok} elapsedMs=${Math.round(performance.now() - started)}`);
  }
  function deferSkyAchievementsMissionProcessing(kind, process) {
    window.setTimeout(() => {
      const started = performance.now();
      reportSkyAchievementsDiagnostic(`${kind} mission processing started`);
      try {
        Promise.resolve(process()).then(() => {
          scheduleSkyAchievementsRender(`${kind} mission processing`);
          reportSkyAchievementsDiagnostic(`${kind} mission processing completed; elapsedMs=${Math.round(performance.now() - started)}`);
        }).catch((error) => {
          const detail = String(error?.message || error || 'unknown processing error').replace(/[\r\n\t]/g, ' ').slice(0, 100);
          reportSkyAchievementsDiagnostic(`${kind} mission processing failed: ${detail}`);
        });
      } catch (error) {
        const detail = String(error?.message || error || 'unknown processing error').replace(/[\r\n\t]/g, ' ').slice(0, 100);
        reportSkyAchievementsDiagnostic(`${kind} mission processing failed: ${detail}`);
      }
    }, 0);
  }
  window.addEventListener('error', (event) => {
    reportSkyAchievementsDiagnostic(`uncaught JS error: ${event.message || 'unknown'} at ${event.filename || 'inline'}:${event.lineno || 0}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason?.message || event.reason || 'unknown rejection';
    reportSkyAchievementsDiagnostic(`unhandled promise rejection: ${String(reason).slice(0, 120)}`);
  });
  reportSkyAchievementsDiagnostic('app.js started');

  // PrismaUI's embedded page receives smaller wheel deltas than the desktop browser.
  // Scale only wheel scrolling that can move a scrollable container in that direction.
  document.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.defaultPrevented || event.deltaY === 0) return;
    const direction = Math.sign(event.deltaY);
    let element = event.target instanceof Element ? event.target : event.target?.parentElement;
    while (element && element !== document.body && element !== document.documentElement) {
      const overflowY = window.getComputedStyle(element).overflowY;
      const isScrollable = /^(auto|scroll|overlay)$/.test(overflowY) && element.scrollHeight > element.clientHeight;
      const canMove = direction < 0
        ? element.scrollTop > 0
        : element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      if (isScrollable && canMove) {
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientHeight : 1;
        event.preventDefault();
        element.scrollTop += event.deltaY * unit * 2.25;
        return;
      }
      element = element.parentElement;
    }
    const pageScroller = document.scrollingElement;
    if (pageScroller) {
      const canMove = direction < 0
        ? pageScroller.scrollTop > 0
        : pageScroller.scrollTop + pageScroller.clientHeight < pageScroller.scrollHeight - 1;
      if (canMove) {
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? pageScroller.clientHeight : 1;
        event.preventDefault();
        pageScroller.scrollTop += event.deltaY * unit * 2.25;
      }
    }
  }, { capture: true, passive: false });

  function scheduleSkyAchievementsRender(reason) {
    renderScheduleCount++;
    if (scheduledRenderTimer) return;
    scheduledRenderTimer = window.setTimeout(() => {
      scheduledRenderTimer = 0;
      const started = performance.now();
      reportSkyAchievementsDiagnostic(`TRACE render started tab=${activeTab} reason=${reason}`);
      try { renderSkyAchievements(); }
      catch (error) {
        const detail = String(error?.message || error || 'unknown render error').replace(/[\r\n\t]/g, ' ').slice(0, 100);
        reportSkyAchievementsDiagnostic(`TRACE render failed tab=${activeTab}: ${detail}`);
        renderScheduleCount = 0;
        return;
      }
      const elapsed = Math.round(performance.now() - started);
      reportSkyAchievementsDiagnostic(`render complete: tab=${activeTab}, elapsedMs=${elapsed}, batchedUpdates=${renderScheduleCount}, reason=${reason}`);
      renderScheduleCount = 0;
    }, 30);
  }

  function missionState() {
    if (!profileSettings.missionState || typeof profileSettings.missionState !== 'object') {
      profileSettings.missionState = { completed: 0, points: 0, offers: [], seenEventKeys: [], baselineReady: false, unlockedCards: [], storeItems: [], nextStoreRefreshAt: 0, apiMissionProgress: {} };
    }
    const state = profileSettings.missionState;
    state.completed = Math.max(0, Math.floor(Number(state.completed) || 0));
    state.points = Math.max(0, Math.floor(Number(state.points) || 0));
    state.offers = Array.isArray(state.offers) ? state.offers.slice(0, MISSION_OFFER_COUNT) : [];
    state.seenEventKeys = Array.isArray(state.seenEventKeys) ? state.seenEventKeys.slice(0, 512) : [];
    state.unlockedCards = Array.isArray(state.unlockedCards) ? state.unlockedCards : [];
    state.baselineReady = Boolean(state.baselineReady);
    state.nextRefreshAt = Math.max(0, Number(state.nextRefreshAt) || 0);
    state.storeItems = Array.isArray(state.storeItems) ? state.storeItems.slice(0, 10) : [];
    state.nextStoreRefreshAt = Math.max(0, Number(state.nextStoreRefreshAt) || 0);
    state.apiMissionProgress = state.apiMissionProgress && typeof state.apiMissionProgress === 'object' && !Array.isArray(state.apiMissionProgress)
      ? state.apiMissionProgress : {};
    return state;
  }

  const enemyMissionTargets = [
    { id: 'afflicted', name: 'Afflicted', match: /afflicted/i },
    { id: 'bandits', name: 'Bandits', match: /bandit|marauder/i, flag: 'victimBandit' },
    { id: 'forsworn', name: 'Forsworn', match: /forsworn/i, flag: 'victimForsworn' },
    { id: 'ghosts', name: 'Ghosts', match: /ghost|shade|spectre|nightingale sentinel/i },
    { id: 'reavers', name: 'Reavers', match: /reaver/i },
    { id: 'draugr', name: 'Draugr', match: /draugr/i },
    { id: 'falmer', name: 'Falmer', match: /falmer/i },
    { id: 'vampires', name: 'Vampires', match: /vampire/i },
    { id: 'necromancers', name: 'Necromancers', match: /necromancer/i },
    { id: 'warlocks', name: 'Warlocks', match: /warlock|rogue wizard/i },
    { id: 'conjurers', name: 'Conjurers', match: /conjurer/i },
    { id: 'fire-mages', name: 'Fire Mages', match: /fire mage/i },
    { id: 'ice-mages', name: 'Ice Mages', match: /ice mage/i },
    { id: 'storm-mages', name: 'Storm Mages', match: /storm mage/i },
    { id: 'thalmor-justiciars', name: 'Thalmor Justiciars', match: /thalmor.?justiciar/i },
    { id: 'penitus-oculatus', name: 'Penitus Oculatus', match: /penitus.?oculatus/i },
    { id: 'witches', name: 'Witches and Hags', match: /glenmoril|witch|\bhag\b/i },
    { id: 'cultists', name: 'Cultists', match: /cultist|mythic dawn/i },
    { id: 'dremora', name: 'Dremora', match: /dremora/i },
    { id: 'dragon-priests', name: 'Dragon Priests', match: /dragon.?priest/i },
    { id: 'hagravens', name: 'Hagravens', match: /hagraven/i },
    { id: 'spriggans', name: 'Spriggans', match: /spriggan/i },
    { id: 'trolls', name: 'Trolls', match: /troll/i },
    { id: 'giants', name: 'Giants', match: /giant/i },
    { id: 'chaurus', name: 'Chaurus', match: /chaurus/i },
    { id: 'ice-wraiths', name: 'Ice Wraiths', match: /ice.?wraith/i },
    { id: 'werewolves', name: 'Werewolves and Werebears', match: /werewolf|werebear/i },
    { id: 'wispmothers', name: 'Wispmothers', match: /wisp.?mother|wispmother/i },
    { id: 'gargoyles', name: 'Gargoyles', match: /gargoyle/i },
    { id: 'death-hounds', name: 'Death Hounds', match: /death.?hound/i },
    { id: 'ash-spawn', name: 'Ash Spawn', match: /ash.?spawn/i },
    { id: 'sabre-cats', name: 'Sabre Cats', match: /sabre.?cat/i },
    { id: 'skeevers', name: 'Skeevers', match: /skeever/i },
    { id: 'mudcrabs', name: 'Mudcrabs', match: /mudcrab/i },
    { id: 'slaughterfish', name: 'Slaughterfish', match: /slaughterfish/i },
    { id: 'atronachs', name: 'Atronachs', match: /atronach/i },
    { id: 'dwarven-centurions', name: 'Dwarven Centurions', match: /centurion/i },
    { id: 'dwarven-spheres', name: 'Dwarven Spheres', match: /dwarven.?sphere|sphere guardian/i },
    { id: 'dwarven-spiders', name: 'Dwarven Spiders', match: /dwarven.?spider|spider guardian/i },
    { id: 'wolves', name: 'Wolves', match: /wolf/i, flag: 'victimWolf' },
    { id: 'bears', name: 'Bears', match: /bear/i, flag: 'victimBear' },
    { id: 'spiders', name: 'Spiders', match: /spider/i, flag: 'victimSpider' }
  ];
  const ingredientMissionTargets = [
    'Fire Salts', 'Falmer Ear', 'Frost Salts', 'Void Salts', 'Daedra Heart', 'Briar Heart',
    'Chaurus Eggs', 'Giant\'s Toe', 'Glow Dust', 'Hagraven Claw', 'Nirnroot', 'Crimson Nirnroot',
    'Nightshade', 'Vampire Dust', 'Troll Fat', 'Spriggan Sap', 'Canis Root', 'Deathbell',
    'Blue Mountain Flower', 'Dragon\'s Tongue', 'Ice Wraith Teeth', 'Moon Sugar', 'Human Heart', 'Wisp Wrappings'
  ].map((name) => ({ id: name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name }));
  const potionMissionTargets = [
    'Potion of Healing', 'Potion of Minor Healing', 'Potion of Plentiful Healing', 'Potion of Ultimate Healing',
    'Potion of Cure Disease', 'Potion of Resist Fire', 'Potion of Resist Frost', 'Potion of Invisibility',
    'Potion of Waterbreathing', 'Potion of Fortify Smithing', 'Poison of Damage Health', 'Poison of Paralysis'
  ].map((name) => ({ id: name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name }));
  const smithingMissionTargets = [
    'Iron Dagger', 'Iron Sword', 'Iron War Axe', 'Steel Dagger', 'Steel Sword', 'Steel War Axe',
    'Elven Bow', 'Dwarven Bow', 'Orcish Warhammer',
    'Glass Sword', 'Ebony War Axe', 'Daedric Dagger', 'Dragonbone Sword'
  ].map((name) => ({ id: name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name }));
  const missionKinds = [
    { kind: 'skeletons', label: 'Skeletons', action: 'Defeat', min: 3, max: 9 },
    { kind: 'dragons', label: 'Dragons', action: 'Defeat', min: 1, max: 3 },
    { kind: 'enemy-type', action: 'Defeat', min: 3, max: 10, targets: enemyMissionTargets },
    { kind: 'ingredients', label: 'ingredients', action: 'Collect', min: 3, max: 12 },
    { kind: 'ingredient-target', action: 'Collect', min: 1, max: 5, targets: ingredientMissionTargets },
    { kind: 'potions', label: 'potions', action: 'Craft', min: 1, max: 5 },
    { kind: 'potion-target', action: 'Craft', min: 1, max: 3, targets: potionMissionTargets },
    { kind: 'smithing', label: 'items', action: 'Smith', min: 1, max: 5 },
    { kind: 'smithing-target', action: 'Smith', min: 1, max: 2, targets: smithingMissionTargets },
    { kind: 'pelts', label: 'monster pelts or hides', action: 'Collect', min: 2, max: 8 }
  ];
  const missionNameParts = [
    ['Ashen', 'Frostbound', 'Silent', 'Hunter', 'Wandering', 'Forgotten', 'Dawnguard', 'Whiterun'],
    ['Purge', 'Hunt', 'Gathering', 'Forage', 'Extermination', 'Proving', 'Trail', 'Reckoning']
  ];

  function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  function createMission(excludedTitles = []) {
    const excluded = new Set(excludedTitles.filter(Boolean));
    const createCandidate = () => {
      const kind = missionKinds[randomInt(0, missionKinds.length - 1)];
      const goal = randomInt(kind.min, kind.max);
      const target = Array.isArray(kind.targets) ? kind.targets[randomInt(0, kind.targets.length - 1)] : null;
      const reward = Math.min(100, Math.max(5, Math.round(goal * randomInt(2, 7))));
      const description = kind.kind === 'enemy-type' ? `Defeat ${goal} ${target.name}.`
        : kind.kind === 'ingredient-target' ? `Collect ${goal} × ${target.name}.`
          : kind.kind === 'potion-target' ? `Craft ${goal} × ${target.name}.`
            : kind.kind === 'smithing-target' ? `Smith ${goal} × ${target.name}.`
              : `${kind.action} ${goal} ${kind.label}.`;
      const title = target
        ? `${missionNameParts[0][randomInt(0, missionNameParts[0].length - 1)]} ${target.name} ${missionNameParts[1][randomInt(0, missionNameParts[1].length - 1)]}`
        : `${missionNameParts[0][randomInt(0, missionNameParts[0].length - 1)]} ${missionNameParts[1][randomInt(0, missionNameParts[1].length - 1)]}`;
      return {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        kind: kind.kind, targetId: target?.id || '', targetName: target?.name || '', goal, progress: 0, reward, accepted: false,
        title, description
      };
    };
    let mission = createCandidate();
    for (let attempt = 0; attempt < 24 && excluded.has(mission.title); attempt++) mission = createCandidate();
    if (excluded.has(mission.title)) mission.title += ' Renewed';
    return mission;
  }

  function ensureMissionOffers() {
    const state = missionState();
    const isValidOffer = (mission) => {
      const definition = missionKinds.find((kind) => kind.kind === mission?.kind);
      return Boolean(definition && (!definition.targets || definition.targets.some((target) => target.id === mission.targetId)));
    };
    state.offers = state.offers.map((mission) => mission === null ? null : isValidOffer(mission) ? mission : createMission());
    while (state.offers.length < MISSION_OFFER_COUNT) state.offers.push(createMission());
    if (state.offers.length > MISSION_OFFER_COUNT) state.offers = state.offers.slice(0, MISSION_OFFER_COUNT);
    return state;
  }

  function refreshAvailableMissions(manual = false) {
    const state = ensureMissionOffers();
    const allSlotsOccupied = state.offers.every((mission) => mission?.accepted);
    if (allSlotsOccupied) {
      showMissionToast('No Offers to Refresh', 'Quit an active mission before refreshing the board.');
      return false;
    }
    if (manual && state.points < MANUAL_MISSION_REFRESH_COST) {
      showMissionToast('Not Enough SkyPoints', `Refreshing missions costs ${MANUAL_MISSION_REFRESH_COST} SkyPoints; you have ${state.points.toLocaleString()}.`);
      return false;
    }
    if (manual) state.points -= MANUAL_MISSION_REFRESH_COST;
    state.offers = state.offers.map((mission) => mission?.accepted ? mission : createMission());
    saveProfileSettings();
    if (manual) showMissionToast('Missions Refreshed', `${MANUAL_MISSION_REFRESH_COST} SkyPoints spent. Active missions were kept.`);
    if (activeTab === 'missions') renderMissions();
    return true;
  }

  function requestSkyStoreRefresh(reason = 'initial', manual = false) {
    if (!isMissionApp || pendingStoreRefresh) return false;
    const state = missionState();
    if (manual && state.points < MANUAL_STORE_REFRESH_COST) {
      showMissionToast('Not Enough SkyPoints', `Refreshing SkyStore costs ${MANUAL_STORE_REFRESH_COST} SkyPoints; you have ${state.points.toLocaleString()}.`);
      return false;
    }
    if (manual) {
      state.points -= MANUAL_STORE_REFRESH_COST;
      saveProfileSettings();
    }
    pendingStoreRefresh = { reason, manual, requestedAt: Date.now() };
    window.parent.postMessage({ channel: bridgeChannel, type: 'store-stock-request', payload: { reason } }, '*');
    const countdown = byId('achievement-store-refresh-countdown');
    if (countdown) countdown.textContent = 'Refreshing…';
    const button = byId('achievement-refresh-store');
    if (button) button.disabled = true;
    if (activeTab === 'store') renderStore();
    return true;
  }

  function requestSkyStoreItemIcons() {
    if (!isMissionApp) return;
    const formIDs = missionState().storeItems
      .filter((item) => item && !String(item.image || '').trim())
      .map((item) => String(item.formId || '').trim().toUpperCase())
      .filter((formID) => /^[0-9A-F]{8}$/.test(formID))
      .filter((formID, index, all) => all.indexOf(formID) === index)
      .slice(0, 10);
    if (!formIDs.length) return;
    reportSkyAchievementsDiagnostic(`SkyStore requesting icons for ${formIDs.length} persisted game items`);
    window.parent.postMessage({ channel: bridgeChannel, type: 'store-icons-request', payload: { formIDs } }, '*');
  }

  function receiveSkyStoreStock(stock) {
    const state = missionState();
    const requested = pendingStoreRefresh;
    const items = Array.isArray(stock?.items) ? stock.items.slice(0, 10).filter((item) =>
      item && typeof item.id === 'string' && item.id.startsWith('game-item:') &&
      typeof item.name === 'string' && Number.isFinite(Number(item.price)) &&
      Number(item.price) >= 500 && Number(item.price) <= 10000) : [];
    pendingStoreRefresh = null;
    const button = byId('achievement-refresh-store');
    if (button) button.disabled = false;
    if (items.length) {
      state.storeItems = items;
      state.nextStoreRefreshAt = Date.now() + STORE_REFRESH_INTERVAL_MS;
      saveProfileSettings();
      data.gameStoreItems = items;
      if (requested?.manual) showMissionToast('SkyStore Refreshed', `${MANUAL_STORE_REFRESH_COST} SkyPoints spent. New stock is available.`);
    } else {
      if (requested?.manual) {
        state.points += MANUAL_STORE_REFRESH_COST;
        showMissionToast('No Eligible Stock', 'No eligible game items were found, so the refresh cost was refunded.');
      }
      state.nextStoreRefreshAt = Date.now() + 60 * 1000;
      saveProfileSettings();
      data.gameStoreItems = state.storeItems;
    }
    if (activeTab === 'store') renderStore();
  }

  function receiveSkyStoreItemIcon(update) {
    const formID = String(update?.formID || '').trim().toUpperCase();
    const icon = String(update?.icon || '');
    if (!/^[0-9A-F]{8}$/.test(formID) || !icon) return;
    const state = missionState();
    const item = state.storeItems.find((entry) => String(entry?.formId || '').trim().toUpperCase() === formID);
    if (!item) return;
    item.image = icon;
    data.gameStoreItems = state.storeItems;
    saveProfileSettings();
    if (activeTab === 'store') renderStore();
  }

  function receiveSkyStorePurchaseResult(result) {
    const offerId = String(result?.offerId || '');
    const pending = pendingGameStorePurchases.get(offerId);
    if (!pending) return;
    pendingGameStorePurchases.delete(offerId);
    if (result?.success === true) return;
    const state = missionState();
    state.points += pending.price;
    profileSettings.purchasedStoreOffers = profileSettings.purchasedStoreOffers.filter((key) => key !== pending.offerKey);
    saveProfileSettings();
    showMissionToast('Purchase Failed', `${pending.name} could not be added to your inventory. Your SkyPoints were refunded.`);
    if (activeTab === 'store') renderStore();
  }

  function updateSkyStoreRefreshClock() {
    if (!isMissionApp) return;
    const state = missionState();
    const now = Date.now();
    if (pendingStoreRefresh && now - pendingStoreRefresh.requestedAt >= 30000) {
      const expiredRequest = pendingStoreRefresh;
      pendingStoreRefresh = null;
      if (expiredRequest.manual) {
        state.points += MANUAL_STORE_REFRESH_COST;
        showMissionToast('Refresh Timed Out', 'The store did not return new stock. Your SkyPoints were refunded; you can try again.');
      }
      state.nextStoreRefreshAt = now + 60 * 1000;
      saveProfileSettings();
      const button = byId('achievement-refresh-store');
      if (button) button.disabled = false;
    }
    // Delay the one-time loaded-form scan until the player opens SkyStore.
    // This keeps the missions/dashboard startup path free of catalog work.
    if (activeTab === 'store' && !state.storeItems.length && !pendingStoreRefresh && (!state.nextStoreRefreshAt || state.nextStoreRefreshAt <= now)) {
      requestSkyStoreRefresh('initial');
    } else if (state.storeItems.length && !state.nextStoreRefreshAt) {
      state.nextStoreRefreshAt = now + STORE_REFRESH_INTERVAL_MS;
      saveProfileSettings();
    } else if (activeTab === 'store' && state.nextStoreRefreshAt && state.nextStoreRefreshAt <= now && !pendingStoreRefresh) {
      requestSkyStoreRefresh('automatic');
    }
    const countdown = byId('achievement-store-refresh-countdown');
    if (!countdown) return;
    if (pendingStoreRefresh) {
      countdown.textContent = 'Refreshing…';
      return;
    }
    if (!state.storeItems.length || !state.nextStoreRefreshAt) {
      countdown.textContent = 'Stock unavailable';
      return;
    }
    const seconds = Math.max(0, Math.ceil((state.nextStoreRefreshAt - now) / 1000));
    const hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const remainder = (seconds % 60).toString().padStart(2, '0');
    countdown.textContent = `${hours}h ${minutes}m ${remainder}s`;
  }

  function updateMissionRefreshClock() {
    if (!isMissionApp) return;
    const state = missionState();
    const now = Date.now();
    if (!state.nextRefreshAt) {
      state.nextRefreshAt = now + MISSION_REFRESH_INTERVAL_MS;
      saveProfileSettings();
    } else if (state.nextRefreshAt <= now) {
      ensureMissionOffers();
      const refreshable = state.offers.some((mission) => !mission?.accepted);
      if (refreshable) state.offers = state.offers.map((mission) => mission?.accepted ? mission : createMission());
      state.nextRefreshAt = now + MISSION_REFRESH_INTERVAL_MS;
      saveProfileSettings();
      if (activeTab === 'missions') renderMissions();
    }
    updateSkyStoreRefreshClock();
    const countdown = byId('achievement-mission-refresh-countdown');
    if (!countdown) return;
    const remaining = Math.max(0, state.nextRefreshAt - now);
    const totalSeconds = Math.ceil(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    countdown.textContent = `${hours}h ${minutes}m ${seconds}s`;
  }

  function startMissionRefreshClock() {
    if (!isMissionApp) return;
    updateMissionRefreshClock();
    window.setInterval(updateMissionRefreshClock, 1000);
  }

  function showMissionToast(title, message) {
    let toast = byId('achievement-mission-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'achievement-mission-toast';
      toast.setAttribute('role', 'status');
      toast.hidden = true;
      toast.innerHTML = '<strong></strong><span></span>';
      document.body.appendChild(toast);
    }
    toast.querySelector('strong').textContent = title;
    toast.querySelector('span').textContent = message;
    toast.hidden = false;
    window.clearTimeout(missionToastTimer);
    missionToastTimer = window.setTimeout(() => { toast.hidden = true; }, 5200);
  }

  function reputationRank(scoreValue) {
    const score = Math.trunc(Number(scoreValue) || 0);
    if (score < 0) {
      if (score >= -50) return 'Unwelcome';
      if (score >= -150) return 'Shunned';
      if (score >= -200) return 'Hunted';
      if (score >= -350) return 'Outlaw';
      return 'Public Enemy';
    }
    if (score <= 50) return 'Nameless Wanderer';
    if (score <= 100) return 'Rumored Blade';
    if (score <= 150) return 'Hold-Known';
    if (score <= 200) return 'Songforged';
    if (score <= 250) return 'Shield of the Holds';
    if (score <= 300) return 'Dragonsworn Hero';
    if (score <= 350) return 'Oathkeeper of Ysgramor';
    if (score <= 400) return 'Voice of the North';
    if (score <= 450) return 'Saga-Born';
    if (score <= 500) return 'Pride of Skyrim';
    if (score <= 999) return 'Saga of the Living';
    return 'Eternal Song of Sovngarde';
  }

  function cardMissionCost(index, cards = data.assets?.nameCards || []) {
    const purchasableCount = Math.max(1, cards.filter((card) => !isDefaultNameCard(card)).length - 10);
    return 500 + Math.round((Math.max(0, index - 10) / Math.max(1, purchasableCount - 1)) * 9500);
  }

  function isDefaultNameCard(card) {
    return String(card?.name || '').trim().toLocaleLowerCase() === 'default name card';
  }

  function nameCardUnlockIndex(card, index, cards = data.assets?.nameCards || []) {
    if (isDefaultNameCard(card)) return -1;
    let unlockIndex = -1;
    for (let current = 0; current <= index; current++) {
      if (!isDefaultNameCard(cards[current])) unlockIndex++;
    }
    return unlockIndex;
  }

  function isNameCardUnlocked(card, index) {
    const state = missionState();
    if (isDefaultNameCard(card)) return true;
    if (state.unlockedCards.includes(card.url)) return true;
    const unlockIndex = nameCardUnlockIndex(card, index);
    return unlockIndex < 10 && state.completed >= (unlockIndex + 1) * 10;
  }

  function unlockNameCard(card, index) {
    const state = missionState();
    if (isNameCardUnlocked(card, index)) return true;
    const unlockIndex = nameCardUnlockIndex(card, index);
    if (unlockIndex < 10) {
      const required = (unlockIndex + 1) * 10;
      showMissionToast('Name Card Locked', `Complete ${required} missions to unlock ${card.name}.`);
      return false;
    }
    const cost = cardMissionCost(unlockIndex);
    if (state.points < cost) {
      showMissionToast('Not Enough SkyPoints', `${card.name} costs ${cost.toLocaleString()} SkyPoints; you have ${state.points.toLocaleString()} SkyPoints.`);
      return false;
    }
    state.points -= cost;
    state.unlockedCards.push(card.url);
    saveProfileSettings();
    showMissionToast('Name Card Unlocked', `${card.name} is now available to use.`);
    return true;
  }


  function historyEventKey(event) {
    return [event?.day, event?.eventType, event?.formID, event?.baseFormID, event?.stage,
      event?.kind, event?.identity, event?.subject, event?.detail, event?.location].map((value) => String(value ?? '')).join('|');
  }

  function missionEventAmount(mission, event) {
    if (!event || event.isTheft || event.kind === 'theft') return 0;
    if (event.kind === 'death' && event.detail === 'Player killed this actor' && event.victimHostile === true) {
      const name = String(event.subject || '') + ' ' + String(event.identity || '');
      if (mission.kind === 'skeletons') return /skeleton/i.test(name) ? 1 : 0;
      if (mission.kind === 'dragons') return event.victimDragon === true || /dragon(?! ?priest)/i.test(name) ? 1 : 0;
      if (mission.kind === 'enemy-type') {
        const target = enemyMissionTargets.find((entry) => entry.id === mission.targetId);
        if (!target) return 0;
        if (target.flag && event[target.flag] === true) return 1;
        return target.match.test(name) ? 1 : 0;
      }
    }
    if (event.kind === 'crafting') {
      const itemName = String(event.subject || '').trim().toLocaleLowerCase();
      if (mission.kind === 'potions' && Number(event.eventType) === 40) return 1;
      if (mission.kind === 'potion-target' && Number(event.eventType) === 40 && itemName.includes(String(mission.targetName || '').toLocaleLowerCase())) return 1;
      if (mission.kind === 'smithing' && Number(event.eventType) === 38) return 1;
      if (mission.kind === 'smithing-target' && Number(event.eventType) === 38 && itemName.includes(String(mission.targetName || '').toLocaleLowerCase())) return 1;
      return 0;
    }
    if (event.kind !== 'inventory' || Number(event.eventType) !== 4) return 0;
    const identity = String(event.identity || '');
    if (!/picked-up|looted-body|looted-container/.test(identity)) return 0;
    const itemName = String(event.subject || '');
    const normalizedName = itemName.trim().toLocaleLowerCase();
    const category = String(event.itemCategory || '').toLowerCase();
    if (mission.kind === 'ingredients' && (category === 'ingredient' || /ingredient/i.test(itemName))) return Math.max(1, Number(event.stage) || 1);
    if (mission.kind === 'ingredient-target' && category === 'ingredient' && normalizedName.includes(String(mission.targetName || '').toLocaleLowerCase())) return Math.max(1, Number(event.stage) || 1);
    if (mission.kind === 'pelts' && (category === 'pelthide' || /pelt|hide/i.test(itemName))) return Math.max(1, Number(event.stage) || 1);
    return 0;
  }

  function apiMissionEventAmount(mission, event) {
    if (!mission || !event || event.isTheft || event.kind === 'theft' || Number(event.eventType) !== Number(mission.eventType)) return 0;
    if (Number(mission.formID) && Number(event.formID) !== Number(mission.formID)) return 0;
    if (Number(mission.baseFormID) && Number(event.baseFormID) !== Number(mission.baseFormID)) return 0;
    if (mission.subjectContains && !String(event.subject || '').toLocaleLowerCase().includes(String(mission.subjectContains).toLocaleLowerCase())) return 0;
    if (mission.identityContains && !String(event.identity || '').toLocaleLowerCase().includes(String(mission.identityContains).toLocaleLowerCase())) return 0;
    return Number(mission.eventType) === 4 ? Math.max(1, Number(event.stage) || 1) : 1;
  }

  function processMissionEvents(events) {
    const state = ensureMissionOffers();
    const visibleEvents = Array.isArray(events) ? events.slice(0, 2048) : [];
    const keys = visibleEvents.map(historyEventKey);
    if (!state.baselineReady) {
      state.seenEventKeys = keys.slice(0, 512);
      state.baselineReady = true;
      saveProfileSettings();
      return;
    }

    const previouslySeen = new Set(state.seenEventKeys);
    const newEvents = [];
    for (const event of visibleEvents) {
      if (previouslySeen.has(historyEventKey(event))) break;
      newEvents.push(event);
    }

    let changed = false;
    for (const event of newEvents.reverse()) {
      for (let slot = 0; slot < state.offers.length; slot++) {
        const mission = state.offers[slot];
        if (!mission?.accepted) continue;
        const amount = missionEventAmount(mission, event);
        if (amount <= 0) continue;
        mission.progress = Math.min(mission.goal, (Number(mission.progress) || 0) + amount);
        changed = true;
        if (mission.progress >= mission.goal) {
          state.completed++;
          state.points += mission.reward;
          state.offers[slot] = createMission();
          window.parent.postMessage({
            channel: bridgeChannel,
            type: 'mission-completed',
            payload: { title: mission.title, reward: mission.reward }
          }, '*');
        }
      }
      const apiMissions = Array.isArray(data.assets?.apiMissions) ? data.assets.apiMissions.slice(0, 64) : [];
      for (const mission of apiMissions) {
        const missionKey = `${mission.ownerId || ''}:${mission.id || ''}`;
        if (!mission.ownerId || !mission.id || !missionKey || !mission.goal) continue;
        const progress = state.apiMissionProgress[missionKey] || (state.apiMissionProgress[missionKey] = { progress: 0, accepted: false, completed: false });
        if (!progress.accepted || progress.completed) continue;
        const amount = apiMissionEventAmount(mission, event);
        if (amount <= 0) continue;
        progress.progress = Math.min(Number(mission.goal), (Number(progress.progress) || 0) + amount);
        changed = true;
        if (progress.progress >= Number(mission.goal)) {
          progress.completed = true;
          state.completed++;
          const reward = Math.max(0, Math.floor(Number(mission.reward) || 0));
          state.points += reward;
          window.parent.postMessage({
            channel: bridgeChannel,
            type: 'mission-completed',
            payload: { title: String(mission.title || 'Custom mission'), reward }
          }, '*');
        }
      }
    }
    state.seenEventKeys = [...keys, ...state.seenEventKeys.filter((key) => !keys.includes(key))].slice(0, 512);
    if (changed || newEvents.length) saveProfileSettings();
  }

  function renderMissions() {
    const state = ensureMissionOffers();
    const host = byId('achievement-missions');
    const completed = byId('achievement-mission-completed');
    const points = byId('achievement-mission-points');
    if (completed) completed.textContent = state.completed.toLocaleString();
    if (points) points.textContent = state.points.toLocaleString();
    const completeBasic = byId('achievement-basic-missions');
    if (completeBasic) completeBasic.textContent = state.completed.toLocaleString();
    if (!host) return;
    host.replaceChildren();
    state.offers.forEach((mission, index) => {
      if (!mission) return;
      const card = document.createElement('article');
      card.className = `achievement-mission-card${mission.accepted ? ' accepted' : ''}`;
      card.dataset.missionStyle = ['gold', 'ember', 'frost'][index % 3];
      const title = document.createElement('h3'); title.textContent = mission.title;
      const description = document.createElement('p'); description.textContent = mission.description;
      const progress = document.createElement('strong'); progress.className = 'achievement-mission-count'; progress.textContent = `${mission.progress} / ${mission.goal}`;
      const bar = document.createElement('div'); bar.className = 'achievement-mission-progress'; bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(mission.goal)); bar.setAttribute('aria-valuenow', String(mission.progress));
      const fill = document.createElement('span'); fill.style.width = `${Math.min(100, (mission.progress / mission.goal) * 100)}%`; bar.appendChild(fill);
      const reward = document.createElement('div'); reward.className = 'achievement-mission-reward';
      const rewardIcon = document.createElement('img'); rewardIcon.src = 'skypoints.png'; rewardIcon.alt = '';
      const rewardAmount = document.createElement('strong'); rewardAmount.textContent = `${mission.reward} SkyPoints`;
      reward.append(rewardIcon, rewardAmount);
      const actions = document.createElement('div'); actions.className = 'achievement-mission-actions';
      const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'achievement-mission-accept'; accept.textContent = mission.accepted ? 'In Progress' : 'Accept Mission'; accept.disabled = mission.accepted;
      accept.addEventListener('click', () => {
        const current = missionState().offers[index]; if (!current || current.accepted) return;
        current.accepted = true;
        saveProfileSettings(); renderMissions();
      });
      actions.appendChild(accept);
      if (mission.accepted) {
        const quit = document.createElement('button'); quit.type = 'button'; quit.className = 'achievement-mission-quit'; quit.textContent = 'Quit Mission';
        quit.addEventListener('click', () => {
          const currentState = missionState();
          const current = currentState.offers[index];
          if (!current?.accepted) return;
          currentState.offers[index] = null;
          saveProfileSettings();
          showMissionToast('Mission Abandoned', `${current.title} was abandoned. This offer slot stays empty until the board refreshes.`);
          renderMissions();
        });
        actions.appendChild(quit);
      }
      card.append(title, description, progress, bar, reward, actions);
      host.appendChild(card);
    });
    const apiMissions = Array.isArray(data.assets?.apiMissions) ? data.assets.apiMissions.slice(0, 64) : [];
    apiMissions.forEach((mission, index) => {
      if (!mission || typeof mission.ownerId !== 'string' || typeof mission.id !== 'string' || !mission.title) return;
      const key = `${mission.ownerId}:${mission.id}`;
      const progress = state.apiMissionProgress[key] || (state.apiMissionProgress[key] = { progress: 0, accepted: false, completed: false });
      if (progress.completed) return;
      const goal = Math.max(1, Math.floor(Number(mission.goal) || 1));
      const rewardValue = Math.max(0, Math.floor(Number(mission.reward) || 0));
      const card = document.createElement('article');
      card.className = `achievement-mission-card${progress.accepted ? ' accepted' : ''}`;
      card.dataset.missionStyle = ['gold', 'ember', 'frost'][index % 3];
      const owner = document.createElement('span'); owner.className = 'achievement-mission-owner'; owner.textContent = mission.ownerId;
      const title = document.createElement('h3'); title.textContent = mission.title;
      const description = document.createElement('p'); description.textContent = mission.description || 'Complete this mission from an installed SkyOS app.';
      const count = Math.min(goal, Math.max(0, Number(progress.progress) || 0));
      const progressText = document.createElement('strong'); progressText.className = 'achievement-mission-count'; progressText.textContent = `${count} / ${goal}`;
      const bar = document.createElement('div'); bar.className = 'achievement-mission-progress'; bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(goal)); bar.setAttribute('aria-valuenow', String(count));
      const fill = document.createElement('span'); fill.style.width = `${Math.min(100, (count / goal) * 100)}%`; bar.appendChild(fill);
      const reward = document.createElement('div'); reward.className = 'achievement-mission-reward';
      const rewardIcon = document.createElement('img'); rewardIcon.src = 'skypoints.png'; rewardIcon.alt = '';
      const rewardAmount = document.createElement('strong'); rewardAmount.textContent = `${rewardValue.toLocaleString()} SkyPoints`;
      reward.append(rewardIcon, rewardAmount);
      const actions = document.createElement('div'); actions.className = 'achievement-mission-actions';
      const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'achievement-mission-accept';
      accept.textContent = progress.accepted ? 'In Progress' : 'Accept Mission'; accept.disabled = Boolean(progress.accepted);
      accept.addEventListener('click', () => {
        const current = missionState().apiMissionProgress[key];
        if (!current || current.accepted || current.completed) return;
        current.accepted = true;
        saveProfileSettings(); renderMissions();
      });
      actions.appendChild(accept);
      if (progress.accepted) {
        const abandon = document.createElement('button'); abandon.type = 'button'; abandon.className = 'achievement-mission-quit'; abandon.textContent = 'Abandon';
        abandon.addEventListener('click', () => {
          const current = missionState().apiMissionProgress[key];
          if (!current || !current.accepted || current.completed) return;
          current.accepted = false;
          saveProfileSettings(); renderMissions();
        });
        actions.appendChild(abandon);
      }
      card.append(owner, title, description, progressText, bar, reward, actions);
      host.appendChild(card);
    });
    if (!host.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'empty achievement-mission-empty';
      empty.textContent = 'No missions are available. Wait for the daily refresh or spend SkyPoints to refresh the board.';
      host.appendChild(empty);
    }
  }

  function applyStoreSearch() {
    const host = byId('achievement-store-grid');
    const query = String(byId('achievement-store-search')?.value || '').trim().toLocaleLowerCase();
    if (!host) return;
    const cards = Array.from(host.querySelectorAll('.achievement-store-card'));
    let visible = 0;
    for (const card of cards) {
      const matches = !query || card.dataset.storeSearch.includes(query);
      card.hidden = !matches;
      if (matches) visible++;
    }
    const count = byId('achievement-store-filter-summary');
    if (count) count.textContent = query ? `${visible} of ${cards.length} offers` : `${cards.length} offers`;
    const empty = byId('achievement-store-no-results');
    if (empty) empty.hidden = visible !== 0 || cards.length === 0;
  }

  function renderStore() {
    const host = byId('achievement-store-grid');
    const pointsNode = byId('achievement-store-points');
    const summary = byId('achievement-store-summary');
    const state = missionState();
    data.gameStoreItems = state.storeItems;
    if (pointsNode) pointsNode.textContent = state.points.toLocaleString();
    if (!host) return;
    host.replaceChildren();
    const cards = Array.isArray(data.assets?.nameCards) ? data.assets.nameCards : [];
    const cardOffers = cards.map((card, index) => ({
      id: `name-card:${card.url}`, name: card.name || 'Name Card', image: card.url,
      category: 'name-card', card, index
    })).filter((offer) => !isDefaultNameCard(offer.card));
    const contributed = [...(Array.isArray(data.storeOffers) ? data.storeOffers : []), ...(Array.isArray(data.assets?.apiStoreOffers) ? data.assets.apiStoreOffers : [])].filter((offer) =>
      offer && typeof offer.id === 'string' && typeof offer.name === 'string' && Number.isFinite(Number(offer.price)) && Number(offer.price) >= 0);
    const gameItems = (Array.isArray(state.storeItems) ? state.storeItems : []).map((item) => ({
      ...item, category: 'game-item', appId: 'SkyMissions', appName: item.itemType || 'Game Item'
    }));
    const offers = [...gameItems, ...cardOffers, ...contributed];
    if (summary) summary.textContent = `${gameItems.length} rotating game items · ${offers.length.toLocaleString()} total offers`;
    if (!offers.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = data.assetsLoaded ? 'No store offers are available yet.' : 'Waiting for the SkyMissions catalog…';
      host.appendChild(empty); return;
    }
    for (const offer of offers) {
      const card = document.createElement('article'); card.className = 'achievement-store-card';
      const offerType = document.createElement('span'); offerType.className = 'achievement-store-type';
      offerType.textContent = offer.category === 'name-card' ? 'Name Card' : offer.category === 'game-item'
        ? `Game Item · ${offer.itemType || 'Rare Find'}` : (offer.appName || offer.appId || 'SkyOS Offer');
      const priceLabel = document.createElement('strong'); priceLabel.className = 'achievement-store-price';
      let image;
      if (offer.image) {
        image = createImage(offer.image, offer.name);
      } else if (offer.category === 'game-item') {
        image = document.createElement('div');
        image.className = 'achievement-store-item-placeholder';
        image.setAttribute('role', 'img');
        image.setAttribute('aria-label', `${offer.name} icon is loading`);
        image.textContent = offer.itemType === 'Weapons' ? '⚔' : offer.itemType === 'Armor' ? '⬡' : '✦';
      } else {
        image = createImage('', offer.name);
        image.hidden = true;
        card.classList.add('without-image');
      }
      const title = document.createElement('h3'); title.textContent = offer.name;
      const unlockIndex = offer.category === 'name-card' ? nameCardUnlockIndex(offer.card, offer.index, cards) : 99;
      const missionLocked = offer.category === 'name-card' && unlockIndex < 10 && !isNameCardUnlocked(offer.card, offer.index);
      const offerKey = `${offer.appId || ''}:${offer.id}`;
      const owned = offer.category === 'name-card' ? isNameCardUnlocked(offer.card, offer.index) : profileSettings.purchasedStoreOffers.includes(offerKey);
      card.classList.toggle('is-owned', owned);
      card.classList.toggle('is-mission-reward', missionLocked);
      const price = offer.category === 'name-card' ? cardMissionCost(unlockIndex, cards) : Math.max(0, Math.floor(Number(offer.price) || 0));
      const description = document.createElement('p');
      description.textContent = missionLocked ? `Complete ${(unlockIndex + 1) * 10} missions to unlock.` : (offer.description || '');
      if (!owned && !missionLocked) {
        priceLabel.classList.add('has-sky-points');
        const pointIcon = document.createElement('img'); pointIcon.src = 'skypoints.png'; pointIcon.alt = '';
        const amount = document.createElement('span'); amount.textContent = `${price.toLocaleString()} SkyPoints`;
        priceLabel.append(pointIcon, amount);
      } else {
        priceLabel.textContent = owned ? 'Owned' : 'Mission reward';
      }
      const buy = document.createElement('button'); buy.type = 'button';
      buy.disabled = owned || missionLocked;
      buy.textContent = owned ? 'Owned' : missionLocked ? 'Mission reward' : 'Buy';
      buy.addEventListener('click', () => {
        if (offer.category === 'name-card') {
          if (unlockNameCard(offer.card, offer.index)) renderSkyAchievements();
          return;
        }
        const current = missionState();
        if (profileSettings.purchasedStoreOffers.includes(offerKey)) return;
        if (offer.category === 'game-item' && pendingGameStorePurchases.has(offer.id)) return;
        if (current.points < price) {
          showMissionToast('Not Enough SkyPoints', `You don't have enough SkyPoints to buy ${offer.name}. It costs ${price.toLocaleString()} SkyPoints; you have ${current.points.toLocaleString()}.`);
          return;
        }
        current.points -= price;
        profileSettings.purchasedStoreOffers.push(offerKey);
        saveProfileSettings();
        if (offer.category === 'game-item') {
          pendingGameStorePurchases.set(offer.id, { price, offerKey, name: offer.name });
          buy.disabled = true;
        }
        window.parent.postMessage({ channel: bridgeChannel, type: 'store-purchase', payload: { appId: String(offer.appId || ''), offerId: String(offer.id), name: String(offer.name), price } }, '*');
        renderSkyAchievements();
      });
      const copy = document.createElement('div'); copy.className = 'achievement-store-copy';
      copy.append(offerType, title, description, priceLabel, buy);
      card.dataset.storeSearch = [offer.name, offer.description, offer.itemType, offer.appName, offer.appId, offer.category, price].filter(Boolean).join(' ').toLocaleLowerCase();
      card.append(image, copy);
      host.appendChild(card);
    }
    applyStoreSearch();
  }


  const knownFactions = [
    { id: 'companions', name: 'The Companions', match: /companions|companionsfaction/i, jobs: ['Companion', 'Shield-Brother / Shield-Sister', 'Circle Member', 'Harbinger'] },
    { id: 'thieves-guild', name: 'Thieves Guild', match: /thieves.?guild|tg.*faction/i, jobs: ['Guild Member', 'Thief', 'Guild Member', 'Guild Master'] },
    { id: 'college-winterhold', name: 'College of Winterhold', match: /college.?of.?winterhold|winterhold.?college|mgcollegefaction/i, jobs: ['Apprentice', 'Mage', 'Senior Mage', 'Arch-Mage'] },
    { id: 'dark-brotherhood', name: 'Dark Brotherhood', match: /dark.?brotherhood|db.*faction/i, jobs: ['Initiate', 'Assassin', 'Assassin', 'Listener'] },
    { id: 'imperial-legion', name: 'Imperial Legion', match: /imperial.?legion|imperialarmy|imperialfaction/i, jobs: ['Legion Recruit', 'Legionnaire', 'Quaestor', 'Legate'] },
    { id: 'stormcloaks', name: 'Stormcloaks', match: /stormcloak/i, jobs: ['Stormcloak Recruit', 'Stormcloak Soldier', 'Stormcloak Officer', 'Stormcloak Commander'] },
    { id: 'dawnguard', name: 'Dawnguard', match: /dawnguard/i, jobs: ['Dawnguard Recruit', 'Dawnguard', 'Dawnguard Veteran', 'Dawnguard Leader'] },
    { id: 'volkihar', name: 'Volkihar Vampire Clan', match: /volkihar|vampire.?clan|vampirepcfaction/i, jobs: ['Volkihar Vampire', 'Vampire', 'Volkihar Vampire', 'Vampire Lord'] },
    { id: 'bards-college', name: 'Bards College', match: /bards.?college|bardcollegefaction/i, jobs: ['Bard Student', 'Bard', 'Bard', 'Bard'] },
    { id: 'blades', name: 'The Blades', match: /bladesfaction|the.?blades/i, jobs: ['Blade Recruit', 'Blade', 'Blade', 'Blade'] }
  ];
  const playerNameFonts = {
    cinzel: 'Cinzel, "Palatino Linotype", Georgia, serif',
    georgia: 'Georgia, serif',
    palatino: '"Palatino Linotype", "Book Antiqua", serif',
    times: '"Times New Roman", serif',
    cambria: 'Cambria, Georgia, serif',
    garamond: 'Garamond, "Times New Roman", serif',
    papyrus: 'Papyrus, fantasy',
    trebuchet: '"Trebuchet MS", sans-serif',
    segoe: '"Segoe UI", sans-serif',
    candara: 'Candara, sans-serif',
    copperplate: '"Copperplate Gothic Light", Copperplate, fantasy',
    impact: 'Impact, sans-serif'
  };
  const skyMissionTitles = [
    'Dragonborn', 'Thane of Whiterun', 'Arch-Mage', 'Harbinger', 'Guild Master', 'Listener', 'Dragon Slayer',
    'Wielder of the Thu’um', 'Bane of Alduin', 'Thane of Solitude', 'Thane of Windhelm', 'Thane of Riften',
    'Thane of Markarth', 'Thane of Falkreath', 'Thane of Dawnstar', 'Thane of Morthal', 'Thane of Winterhold',
    'Thane of Raven Rock', 'Champion of Skyrim', 'Hero of the Civil War', 'Hero of the Companions', 'Master Thief',
    'Nightingale', 'Agent of Nocturnal', 'Shadow of the Brotherhood', 'Dawnguard Sentinel', 'Vampire Lord',
    'Warden of the Rift', 'Slayer of the World-Eater', 'Dragonslayer of Skyrim', 'The Pale Blade', 'Stormcloak Hero',
    'Imperial Champion', 'Keeper of the Bards', 'Blade of the Blades', 'Voice of the Sky', 'Thu’um Master',
    'Dragon Hunter', 'Dragonfriend', 'Foe of the First Dragon', 'Tamer of the Unseen', 'Master of the Voice',
    'The Unbroken', 'The Unyielding', 'The Undaunted', 'The Unseen', 'The Unforgotten', 'The Unbowed',
    'The Relentless', 'The Unshaken', 'The Fearless', 'The Wanderer', 'The Wayfarer', 'The Pathfinder',
    'The Trailblazer', 'The World Walker', 'The Far-Seer', 'The Hearth Keeper', 'The Oathkeeper', 'The Peacemaker',
    'The Lawbringer', 'The Shield of the Hold', 'The Friend of the People', 'The Silver Tongue', 'The Spellbinder',
    'The Arcane Scholar', 'The Master Enchanter', 'The Master Alchemist', 'The Master Smith', 'The Master Archer',
    'The Master of Arms', 'The Blade Dancer', 'The Night Stalker', 'The Shadow Walker', 'The Ghost of Skyrim',
    'The Wolf of the North', 'The Bear of the Reach', 'The Hawk of Haafingar', 'The Fox of Riften',
    'The Lion of Whiterun', 'The Raven of Windhelm', 'The Serpent of Solstheim', 'The Frost Warden',
    'The Flame Keeper', 'The Stormcaller', 'The Dawnbreaker', 'The Star-Touched', 'The Moonlit',
    'The Oathbound', 'The Ironhearted', 'The Goldhearted', 'The Kindhearted', 'The Last Dragonborn',
    'The Savior of Skyrim', 'The Defender of Tamriel', 'The Keeper of Secrets', 'The Collector of Wonders',
    'The Legend Reborn', 'The Chosen of the Divines', 'The Friend of Dragons'
  ];

  function saveProfileSettings() {
    try { localStorage.setItem(settingsKey, JSON.stringify(profileSettings)); } catch (_) { /* keep this session usable if storage is unavailable */ }
  }

  function useCharacterSettings(name) {
    const owner = String(name || 'Unknown adventurer').trim().toLocaleLowerCase() || 'unknown-adventurer';
    const key = `${settingsPrefix}:${encodeURIComponent(owner)}`;
    if (key === settingsKey) return;
    settingsKey = key;
    profileSettings = readSettings(settingsKey);
    achievementEvaluationCache = { revision: -1, settingsKey: '', results: new Map(), unlocked: [] };
  }

  function evaluateDashboardAchievements(achievements) {
    const engine = window.SkyAchievementsRuleEngine;
    if (!engine || !data.assetsLoaded) return achievementEvaluationCache;
    if (achievementEvaluationCache.revision === achievementDataRevision && achievementEvaluationCache.settingsKey === settingsKey) return achievementEvaluationCache;
    const evaluated = engine.evaluate({
      achievements,
      player: data.player,
      history: data.history,
      items: data.items,
      locations: data.locations,
      playerLoaded: data.playerLoaded,
      historyLoaded: data.historyLoaded,
      itemsLoaded: data.itemsLoaded,
      locationsLoaded: data.locationsLoaded,
      storedProgress: profileSettings.achievementProgress,
      storedUnlocked: profileSettings.unlockedAchievements
    });
    profileSettings.achievementProgress = evaluated.progress;
    profileSettings.unlockedAchievements = evaluated.unlocked;
    achievementEvaluationCache = {
      revision: achievementDataRevision,
      settingsKey,
      results: evaluated.results,
      unlocked: achievements.filter((achievement) => evaluated.results.get(engine.normalize(achievement.name).replace(/\s/g, ''))?.unlocked)
    };
    return achievementEvaluationCache;
  }

  function createImage(url, alt = '') {
    const image = document.createElement('img');
    image.src = url;
    image.alt = alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    return image;
  }

  function followerCount(events) {
    const states = new Map();
    for (const event of [...events].reverse()) {
      if (event?.kind !== 'follower') continue;
      const id = Number(event.formID || event.baseFormID) || event.identity || event.subject;
      if (event.eventType === 36) states.set(id, true);
      else if (event.eventType === 37) states.set(id, false);
    }
    return [...states.values()].filter(Boolean).length;
  }

  function renderDashboard() {
    const player = data.player || {};
    useCharacterSettings(player.name);
    filters['achievement-marital-status'] = profileSettings.maritalStatus === 'Married' ? 'Married' : 'Single';
    renderFilterPicker('achievement-marital-status', [
      { value: 'Single', label: 'Single' }, { value: 'Married', label: 'Married' }
    ], filters['achievement-marital-status']);
    const history = data.history || {};
    const reputation = history.reputation || {};
    const assets = data.assets || {};
    const nameCards = Array.isArray(assets.nameCards) ? assets.nameCards : [];
    const allAchievements = Array.isArray(assets.achievements) ? assets.achievements : [];
    const achievements = evaluateDashboardAchievements(allAchievements).unlocked;
    const vanillaHomes = Array.isArray(assets.properties) ? assets.properties : [];
    const events = Array.isArray(history.events) ? history.events : [];
    let activeNameCard = nameCards.find((card, index) => card.url === profileSettings.nameCard && isNameCardUnlocked(card, index)) || null;
    if (data.assetsLoaded && !profileSettings.defaultNameCardApplied) {
      const defaultNameCard = nameCards.find((card) => isDefaultNameCard(card));
      if (defaultNameCard) {
        profileSettings.nameCard = defaultNameCard.url;
        profileSettings.defaultNameCardApplied = true;
        activeNameCard = defaultNameCard;
      }
    }
    if (data.assetsLoaded && !activeNameCard) {
      const defaultNameCard = nameCards.find((card) => isDefaultNameCard(card));
      profileSettings.nameCard = defaultNameCard?.url || '';
      activeNameCard = defaultNameCard || null;
    }
    const selectedVanillaHome = vanillaHomes.find((home) => String(home.name || '').trim() === profileSettings.mainProperty);
    if (data.assetsLoaded && selectedVanillaHome && (selectedVanillaHome.available === false || selectedVanillaHome.owned !== true)) profileSettings.mainProperty = '';
    const portrait = byId('achievement-player-portrait');
    const portraitFallback = byId('achievement-portrait-fallback');
    if (portrait && assets.playerCard) {
      if (portrait.getAttribute('src') !== assets.playerCard) portrait.src = assets.playerCard;
      portrait.hidden = false;
      portrait.onload = () => {
        const frame = byId('achievement-portrait-frame');
        if (!frame || !portrait.naturalWidth || !portrait.naturalHeight) return;
        const ratio = portrait.naturalWidth / portrait.naturalHeight;
        frame.classList.toggle('wrong-size', Math.abs(ratio - 0.75) > 0.04);
      };
      if (portrait.complete && portrait.naturalWidth) portrait.onload();
      if (portraitFallback) portraitFallback.hidden = true;
    } else if (portrait) {
      portrait.hidden = true;
      byId('achievement-portrait-frame')?.classList.remove('wrong-size');
      if (portraitFallback) portraitFallback.hidden = false;
    }
    const nameplate = byId('achievement-current-name-card');
    if (nameplate) {
      if (activeNameCard) { nameplate.src = activeNameCard.url; nameplate.hidden = false; }
      else nameplate.hidden = true;
    }
    const nameplateName = byId('achievement-nameplate-name');
    const nameColorCandidate = String(assets.playerNameColor || '');
    const nameColor = /^#[0-9a-f]{6}$/i.test(nameColorCandidate) ? nameColorCandidate : '#F4D28D';
    const nameFont = playerNameFonts[assets.playerNameFont] || playerNameFonts.cinzel;
    if (nameplateName) { nameplateName.style.color = nameColor; nameplateName.style.fontFamily = nameFont; nameplateName.style.textShadow = `0 0 8px ${nameColor}99, 0 2px 5px #08111bdd, 0 0 12px #101923`; }
    const playerName = player.name || 'Unknown adventurer';
    const setText = (id, value) => { const node = byId(id); if (node) node.textContent = String(value); };
    setText('achievement-player-name', playerName);
    setText('achievement-nameplate-name', playerName);
    setText('achievement-player-level', Number(player.level) || 0);
    setText('achievement-player-title', profileSettings.title || 'No title selected');
    setText('achievement-reputation', (Number(reputation.score) || 0).toLocaleString());
    setText('achievement-reputation-rank', reputationRank(reputation.score));
    setText('achievement-completed-missions', missionState().completed.toLocaleString());
    setText('achievement-owned-points', missionState().points.toLocaleString());
    const gender = String(player.gender || 'male').toLowerCase() === 'female' ? 'female' : 'male';
    setText('achievement-gender-icon', gender === 'female' ? '♀' : '♂');
    const genderIcon = byId('achievement-gender-icon');
    if (genderIcon) genderIcon.setAttribute('aria-label', gender === 'female' ? 'Female' : 'Male');
    for (const [id, value] of [['achievement-health', player.health], ['achievement-magicka', player.magicka], ['achievement-stamina', player.stamina]]) {
      const node = byId(id);
      if (node) node.textContent = Math.round(Number(value) || 0).toLocaleString();
    }
    setText('achievement-basic-name', playerName);
    setText('achievement-basic-health', Math.round(Number(player.health) || 0).toLocaleString());
    setText('achievement-basic-magicka', Math.round(Number(player.magicka) || 0).toLocaleString());
    setText('achievement-basic-stamina', Math.round(Number(player.stamina) || 0).toLocaleString());
    setText('achievement-basic-property', profileSettings.mainProperty || 'None selected');
    const spouse = String(profileSettings.spouse || '').trim();
    profileSettings.spouse = spouse;
    const marital = profileSettings.maritalStatus === 'Married' && spouse
      ? `Married to ${spouse}` : 'Single';
    setText('achievement-basic-marital', marital);
    const spouseName = byId('achievement-spouse-name');
    if (spouseName) { spouseName.value = spouse; spouseName.disabled = profileSettings.maritalStatus !== 'Married'; }
    setText('achievement-basic-achievements', achievements.length.toLocaleString());
    setText('achievement-basic-missions', missionState().completed.toLocaleString());
    const followers = Number.isFinite(Number(player.followers)) ? Number(player.followers) : followerCount(events);
    setText('achievement-basic-followers', Math.max(0, followers).toLocaleString());
    setText('achievement-basic-kills', (Math.max(0, Number(reputation.allHostile) || 0) + Math.max(0, Number(reputation.nonhostileKills) || 0)).toLocaleString());
    setText('achievement-basic-theft', (Number(reputation.thefts) || 0).toLocaleString());

    const memberships = Array.isArray(player.factions) ? player.factions : [];
    const factionStates = knownFactions.map((faction) => {
      const member = memberships.find((entry) => faction.match.test(`${entry.name || ''} ${entry.editorID || ''}`));
      return { ...faction, unlocked: Boolean(member), rank: member ? Math.max(0, Number(member.rank) || 0) : 0 };
    });
    const unlockedFactions = factionStates.filter((faction) => faction.unlocked);
    const chosenFaction = unlockedFactions.find((faction) => faction.id === profileSettings.mainFaction) || unlockedFactions[0] || null;
    if (data.playerLoaded && !profileSettings.mainFaction && chosenFaction) profileSettings.mainFaction = chosenFaction.id;
    if (data.playerLoaded && profileSettings.mainFaction && !unlockedFactions.some((faction) => faction.id === profileSettings.mainFaction)) profileSettings.mainFaction = chosenFaction?.id || '';
    const job = chosenFaction ? (chosenFaction.jobs[Math.min(chosenFaction.rank, chosenFaction.jobs.length - 1)] || chosenFaction.jobs[0]) : 'Adventurer';
    setText('achievement-basic-faction', chosenFaction?.name || 'None selected');
    setText('achievement-basic-job', job);
    if (activeDashboardTab === 'factions') {
      renderFactionList('achievement-locked-factions', factionStates.filter((faction) => !faction.unlocked), false);
      renderFactionList('achievement-unlocked-factions', unlockedFactions, true);
      setText('achievement-locked-faction-count', factionStates.filter((faction) => !faction.unlocked).length);
      setText('achievement-unlocked-faction-count', unlockedFactions.length);
    }

    const actionHost = byId('achievement-recent-actions');
    if (activeTab === 'dashboard' && activeDashboardTab === 'overview' && actionHost) {
      actionHost.replaceChildren();
      const recent = events.slice(0, 10);
      if (!recent.length) {
        const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = 'No SkyRewrite actions are available yet.'; actionHost.appendChild(empty);
      }
      for (const event of recent) {
        const row = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = event.detail || event.subject || `${event.kind || 'Recorded'} action`;
        const meta = document.createElement('small');
        meta.textContent = [event.detail && event.subject && event.detail !== event.subject ? event.subject : '', event.location || ''].filter(Boolean).join(' · ');
        row.append(title, meta); actionHost.appendChild(row);
      }
    }

    if (activeTab === 'dashboard' && activeDashboardTab === 'overview') {
      renderAchievementCarousel(achievements);
      renderNameCardList(nameCards);
    } else if (activeTab === 'dashboard' && activeDashboardTab === 'name-cards') renderNameCardGallery(nameCards);
    else if (activeTab === 'dashboard' && activeDashboardTab === 'titles') renderTitleGallery();
    else if (activeTab === 'dashboard' && activeDashboardTab === 'properties') renderProperties();
    setText('achievement-unlocked-summary', `${achievements.length} unlocked`);
    setText('achievement-catalog-unlocked-count', `${achievements.length} unlocked`);
    setText('achievement-name-card-summary', `${nameCards.filter((card, index) => isNameCardUnlocked(card, index)).length} unlocked`);
    setText('achievement-tab-summary', `${achievements.length} of ${allAchievements.length} unlocked`);
    saveProfileSettings();
  }

  function renderFactionList(hostId, factions, selectable) {
    const host = byId(hostId);
    if (!host) return;
    host.replaceChildren();
    if (!factions.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = selectable ? 'No recognized faction memberships found.' : 'No factions are locked.'; host.appendChild(empty); return; }
    for (const faction of factions) {
      const row = document.createElement('article'); row.className = 'achievement-choice-row';
      const copy = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = faction.name;
      const hint = document.createElement('small'); hint.textContent = selectable ? `Rank ${faction.rank} · ${faction.jobs[Math.min(faction.rank, faction.jobs.length - 1)] || faction.jobs[0]}` : 'Not joined';
      copy.append(title, hint); row.appendChild(copy);
      if (selectable) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = profileSettings.mainFaction === faction.id ? 'Main faction' : 'Use as main faction';
        button.disabled = profileSettings.mainFaction === faction.id;
        button.addEventListener('click', () => { profileSettings.mainFaction = faction.id; saveProfileSettings(); renderSkyAchievements(); });
        row.appendChild(button);
      }
      host.appendChild(row);
    }
  }

  function renderAchievementCarousel(achievements) {
    const host = byId('achievement-unlocked-carousel');
    if (!host) return;
    host.replaceChildren();
    if (!achievements.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No achievements are unlocked for this character yet.'; host.appendChild(empty); return; }
    const visibleCount = Math.min(6, achievements.length);
    for (let index = 0; index < visibleCount; index++) {
      const achievement = achievements[(achievementCarouselOffset + index) % achievements.length];
      const card = document.createElement('article'); card.className = 'achievement-showcase-card';
      card.appendChild(createImage(achievement.url, achievement.name));
      const label = document.createElement('span'); label.textContent = achievement.name; card.appendChild(label);
      host.appendChild(card);
    }
  }

  function renderAchievementCatalog(achievements) {
    const locked = byId('achievement-locked-grid');
    const unlocked = byId('achievement-unlocked-grid');
    if (locked) { locked.replaceChildren(); const note = document.createElement('p'); note.className = 'empty'; note.textContent = 'No locked achievements in this preview. Unlock requirements are not connected yet.'; locked.appendChild(note); }
    if (!unlocked) return;
    unlocked.replaceChildren();
    if (!achievements.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Add achievement artwork to the SkyAchievements/Achievements folder.'; unlocked.appendChild(empty); return; }
    for (const achievement of achievements) {
      const card = document.createElement('article'); card.className = 'achievement-catalog-card';
      card.appendChild(createImage(achievement.url, achievement.name));
      const title = document.createElement('strong'); title.textContent = achievement.name;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = profileSettings.title === achievement.name ? 'Current title' : 'Set as title'; button.disabled = profileSettings.title === achievement.name;
      button.addEventListener('click', () => { profileSettings.title = achievement.name; saveProfileSettings(); renderSkyAchievements(); });
      card.append(title, button); unlocked.appendChild(card);
    }
  }

  function renderNameCardList(nameCards) {
    const host = byId('achievement-name-card-list');
    if (!host) return;
    host.replaceChildren();
    const unlockedCards = nameCards.filter((card, index) => isNameCardUnlocked(card, index));
    if (!unlockedCards.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Complete missions to unlock your first name card.'; host.appendChild(empty); return; }
    const start = Math.min(nameCardListOffset, Math.max(0, unlockedCards.length - 4));
    for (const cardData of unlockedCards.slice(start, start + 4)) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'achievement-name-card-row';
      if (cardData.url === profileSettings.nameCard) card.classList.add('selected');
      const art = document.createElement('span'); art.className = 'achievement-name-card-art'; art.appendChild(createImage(cardData.url, cardData.name));
      const label = document.createElement('strong'); label.textContent = cardData.name;
      card.append(art, label);
      card.addEventListener('click', () => { profileSettings.nameCard = cardData.url; saveProfileSettings(); renderSkyAchievements(); });
      host.appendChild(card);
    }
  }

  function renderNameCardGallery(nameCards) {
    const host = byId('achievement-name-card-grid');
    if (!host) return;
    host.replaceChildren();
    if (!nameCards.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Place name-card image files in the SkyAchievements/Name Cards folder.'; host.appendChild(empty); return; }
    for (const [index, cardData] of nameCards.entries()) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'achievement-name-card-option';
      const unlocked = isNameCardUnlocked(cardData, index);
      if (!unlocked) card.classList.add('locked');
      if (unlocked && cardData.url === profileSettings.nameCard) card.classList.add('selected');
      const art = document.createElement('span'); art.className = 'achievement-name-card-art'; art.appendChild(createImage(cardData.url, cardData.name));
      const name = document.createElement('strong'); name.textContent = cardData.name;
      const action = document.createElement('span'); action.className = 'achievement-name-card-action';
      const unlockIndex = nameCardUnlockIndex(cardData, index, nameCards);
      action.textContent = unlocked ? (cardData.url === profileSettings.nameCard ? 'Currently selected' : 'Use this name card') : unlockIndex < 10 ? `Unlock after ${(unlockIndex + 1) * 10} completed missions` : `Unlock for ${cardMissionCost(unlockIndex).toLocaleString()} SkyPoints`;
      card.append(art, name, action);
      card.addEventListener('click', () => {
        if (!unlockNameCard(cardData, index)) return;
        profileSettings.nameCard = cardData.url;
        saveProfileSettings();
        renderSkyAchievements();
      });
      host.appendChild(card);
    }
  }

  function renderTitleGallery() {
    const host = byId('achievement-title-grid');
    if (!host) return;
    host.replaceChildren();
    const query = String(byId('skymissions-title-search')?.value || '').trim().toLocaleLowerCase();
    const titles = skyMissionTitles.filter((title) => !query || title.toLocaleLowerCase().includes(query));
    const count = byId('skymissions-title-count');
    if (count) count.textContent = query ? `${titles.length} of ${skyMissionTitles.length} titles` : `${skyMissionTitles.length} titles`;
    const current = byId('skymissions-current-title');
    if (current) current.textContent = profileSettings.title || 'No title selected';
    if (!titles.length) {
      const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No titles match your search.'; host.appendChild(empty); return;
    }
    for (const titleText of titles) {
      const title = document.createElement('button'); title.type = 'button'; title.className = 'skymissions-title-option';
      const selected = profileSettings.title === titleText;
      if (selected) title.classList.add('selected');
      const name = document.createElement('strong'); name.textContent = titleText;
      const action = document.createElement('span'); action.textContent = selected ? 'Currently selected' : 'Set as title';
      title.append(name, action);
      title.addEventListener('click', () => {
        profileSettings.title = titleText;
        saveProfileSettings();
        renderTitleGallery();
        const dashboardTitle = byId('achievement-player-title');
        if (dashboardTitle) dashboardTitle.textContent = titleText;
      });
      host.appendChild(title);
    }
  }

  function renderProperties() {
    const host = byId('achievement-properties');
    if (!host) return;
    host.replaceChildren();
    const stored = [...new Set(profileSettings.properties.map((name) => String(name).trim()).filter(Boolean))];
    profileSettings.properties = stored;
    const vanillaHomes = Array.isArray(data.assets?.properties) ? data.assets.properties : [];
    const vanillaNames = new Set(vanillaHomes.map((home) => String(home.name || '').trim().toLocaleLowerCase()));
    const homes = [
      ...vanillaHomes,
      ...stored.filter((name) => !vanillaNames.has(name.toLocaleLowerCase())).map((name) => ({ name, owned: true, available: true, manual: true }))
    ];
    if (!homes.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Waiting for the active save’s home ownership data…'; host.appendChild(empty); return; }
    for (const home of homes) {
      const name = String(home.name || 'Unnamed home').trim();
      const isOwned = home.manual === true || home.owned === true;
      const row = document.createElement('article'); row.className = 'achievement-choice-row';
      const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = name;
      const hint = document.createElement('small');
      hint.textContent = profileSettings.mainProperty === name ? 'Displayed on the dashboard' : home.available === false ? 'Home record not found; check that its DLC is installed' : isOwned ? (home.manual ? 'Added as an owned modded home' : 'Owned') : 'Not owned';
      copy.append(title, hint);
      const controls = document.createElement('div'); controls.className = 'achievement-choice-controls';
      const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = profileSettings.mainProperty === name ? 'Main property' : 'Set as main'; choose.disabled = profileSettings.mainProperty === name;
      choose.disabled = choose.disabled || !isOwned || home.available === false;
      choose.addEventListener('click', () => { if (!isOwned || home.available === false) return; profileSettings.mainProperty = name; saveProfileSettings(); renderSkyAchievements(); });
      controls.append(choose);
      if (home.manual) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'subtle'; remove.textContent = 'Remove';
        remove.addEventListener('click', () => { profileSettings.properties = profileSettings.properties.filter((entry) => entry !== name); if (profileSettings.mainProperty === name) profileSettings.mainProperty = ''; saveProfileSettings(); renderSkyAchievements(); });
        controls.append(remove);
      }
      row.append(copy, controls); host.appendChild(row);
    }
  }

  function renderFilterPicker(name, options, selectedValue) {
    const picker = document.querySelector(`[data-skyachievement-picker="${name}"]`);
    if (!picker) return;
    const triggerLabel = picker.querySelector('.skyachievement-picker-trigger span');
    const optionHost = picker.querySelector('.skyachievement-picker-options');
    const search = picker.querySelector('.skyachievement-picker-search input');
    const selected = options.find((option) => option.value === String(selectedValue)) || options[0];
    if (triggerLabel) triggerLabel.textContent = selected?.label || '';
    if (!optionHost) return;
    const needle = name === 'achievement-marital-status' ? '' : (search?.value || '').trim().toLocaleLowerCase();
    const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(needle));
    const signature = JSON.stringify({ matches, selectedValue: String(selectedValue), needle });
    if (optionHost.dataset.signature === signature) return;
    optionHost.replaceChildren();
    optionHost.dataset.signature = signature;
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'skyachievement-picker-empty';
      empty.textContent = 'No matching filters';
      optionHost.appendChild(empty);
      return;
    }
    for (const option of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'skyachievement-picker-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', option.value === String(selectedValue) ? 'true' : 'false');
      if (option.value === String(selectedValue)) button.classList.add('selected');
      button.textContent = option.label;
      optionHost.appendChild(button);
    }
  }

  function renderAchievementRecords(host, records, emptyMessage, type) {
    if (!host) return;
    host.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = emptyMessage;
      host.appendChild(empty);
      return;
    }
    for (const record of records) {
      const card = document.createElement('article');
      card.className = type === 'quest' ? 'achievement-record achievement-quest-record' : 'achievement-record';
      if (type === 'item') card.classList.add(`rarity-${String(record.rarity || 'Common').toLowerCase()}`);
      const title = document.createElement('strong');
      title.textContent = record.name || 'Unknown record';
      const image = document.createElement('div');
      image.className = 'achievement-record-art';
      const imagePath = type === 'location' ? record.image : type === 'item' ? record.icon : '';
      if (imagePath) {
        const img = document.createElement('img');
        img.src = imagePath;
        img.alt = '';
        image.appendChild(img);
      } else {
        const placeholder = document.createElement('small');
        placeholder.textContent = type === 'location' ? 'SCREENSHOT PENDING' : type === 'item' ? 'NO ICON YET' : (record.plugin || 'COMPLETED');
        image.appendChild(placeholder);
      }
      const meta = document.createElement('div');
      meta.className = 'achievement-record-meta';
      if (type === 'item') {
        const rarity = document.createElement('span');
        rarity.className = 'achievement-rarity';
        rarity.textContent = record.rarity || 'Common';
        meta.appendChild(rarity);
      }
      const plugin = document.createElement('small');
      plugin.textContent = record.plugin || 'Unknown plugin';
      meta.appendChild(plugin);
      card.append(title, image, meta);
      host.appendChild(card);
    }
  }

  function achievementCounterValue(history, key, fallbackPattern, summaryValue) {
    const states = Array.isArray(history?.regionalCreatureStates) ? history.regionalCreatureStates : [];
    const saved = states.find((entry) => String(entry.holdKey || '').toLowerCase() === 'all' && String(entry.category || '').toLowerCase() === key);
    if (saved) return Math.max(0, Number(saved.count) || 0);
    if (Number.isFinite(Number(summaryValue))) return Math.max(0, Number(summaryValue) || 0);
    const events = Array.isArray(history?.events) ? history.events : [];
    return events.filter((event) => event?.kind === 'death' && event?.detail === 'Player killed this actor' && fallbackPattern.test(`${event.subject || ''} ${event.identity || ''}`)).length;
  }

  function renderSkyAchievements() {
    if (isMissionApp) {
      renderDashboard();
      if (activeTab === 'missions') renderMissions();
      if (activeTab === 'store') renderStore();
      return;
    }
    if (activeTab === 'achievements') {
      const achievements = Array.isArray(data.assets?.achievements) ? data.assets.achievements : [];
      renderAchievementCatalog(achievements);
      const summary = byId('achievement-tab-summary');
      if (summary) summary.textContent = `${achievements.length} achievements · all unlocked for preview`;
      const count = byId('achievement-catalog-unlocked-count');
      if (count) count.textContent = `${achievements.length} unlocked`;
      return;
    }
    const player = data.player || {};
    const history = data.history || {};
    const reputation = history.reputation || {};
    const playerName = byId('achievement-player-name');
    const level = byId('achievement-player-level');
    if (playerName) playerName.textContent = player.name || 'Unknown adventurer';
    if (level) level.textContent = String(Number(player.level) || 0);
    for (const [id, value] of [['achievement-health', player.health], ['achievement-magicka', player.magicka], ['achievement-stamina', player.stamina]]) {
      const node = byId(id);
      if (node) node.textContent = Math.round(Number(value) || 0).toLocaleString();
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const locations = Array.isArray(data.locations) ? data.locations : [];
    const events = Array.isArray(history.events) ? history.events : [];
    const completedQuestRecords = [
      ...(Array.isArray(history.completedQuests) ? history.completedQuests.map((quest) => ({
        formID: quest.formID, name: quest.name, plugin: quest.plugin, day: null
      })) : []),
      ...events.filter((event) => event.questCompleted === true || Number(event.eventType) === 19).map((event) => ({
        formID: event.formID, name: event.subject || event.identity, plugin: event.formPlugin, day: Number(event.day)
      }))
    ];
    const quests = [...new Map(completedQuestRecords.map((quest) => [
      `${quest.plugin || ''}|${quest.formID || ''}`,
      { name: quest.name || 'Completed quest', plugin: quest.plugin || 'Unknown plugin', day: Number(quest.day) }
    ])).values()]
      .sort((a, b) => (Number.isFinite(b.day) ? b.day : -1) - (Number.isFinite(a.day) ? a.day : -1) || a.name.localeCompare(b.name));
    const pluginList = (records) => [...new Set(records.map((entry) => entry.plugin).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const pluginOptions = (records) => [{ value: 'all', label: 'All plugins' }, ...pluginList(records).map((plugin) => ({ value: plugin, label: plugin }))];
    const pickerOptions = {
      'achievement-quest-plugin': pluginOptions(quests),
      'achievement-location-plugin': pluginOptions(locations),
      'achievement-item-plugin': pluginOptions(items),
      'achievement-marital-status': [
        { value: 'Single', label: 'Single' }, { value: 'Married', label: 'Married' }
      ],
      'achievement-item-rarity': [
        { value: 'all', label: 'All rarities' }, { value: 'Common', label: 'Common' },
        { value: 'Uncommon', label: 'Uncommon' }, { value: 'Rare', label: 'Rare' },
        { value: 'Epic', label: 'Epic' }, { value: 'Legendary', label: 'Legendary' }
      ]
    };
    for (const [name, options] of Object.entries(pickerOptions)) {
      if (!document.querySelector(`[data-skyachievement-picker="${name}"]`)) continue;
      if (!options.some((option) => option.value === filters[name])) filters[name] = 'all';
      renderFilterPicker(name, options, filters[name]);
    }
    const visibleQuests = quests.filter((entry) => filters['achievement-quest-plugin'] === 'all' || entry.plugin === filters['achievement-quest-plugin']);
    const visibleLocations = locations.filter((entry) => filters['achievement-location-plugin'] === 'all' || entry.plugin === filters['achievement-location-plugin']).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const visibleItems = items.filter((entry) => (filters['achievement-item-plugin'] === 'all' || entry.plugin === filters['achievement-item-plugin']) && (filters['achievement-item-rarity'] === 'all' || entry.rarity === filters['achievement-item-rarity'])).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const updateCount = (id, count, noun) => {
      const node = byId(id);
      if (node) node.textContent = `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
    };
    updateCount('achievement-quest-count', visibleQuests.length, 'quest');
    updateCount('achievement-location-count', visibleLocations.length, 'location');
    updateCount('achievement-item-count', visibleItems.length, 'item');
    if (activeTab === 'quests') renderAchievementRecords(byId('achievement-quests'), visibleQuests, 'No completed quests were found in the active save.', 'quest');
    if (activeTab === 'locations') renderAchievementRecords(byId('achievement-locations'), visibleLocations, 'Discover a map marker to add its location and first-visit screenshot.', 'location');
    if (activeTab === 'items') renderAchievementRecords(byId('achievement-items'), visibleItems, 'Discovered items will appear here.', 'item');

    if (activeTab !== 'lifetime') return;
    const counterGroups = byId('achievement-counter-groups');
    const note = byId('achievement-record-note');
    if (!counterGroups) return;
    if (note) note.textContent = 'Save-backed totals · completed quests read from the active save';
    const creature = (key, pattern, value) => achievementCounterValue(history, key, pattern, value);
    const groups = [
      ['Hostile kills', [
        ['All hostile kills', Number(reputation.allHostile) || 0], ['Bandits', creature('bandit', /bandit|marauder/i, reputation.bandits)],
        ['Forsworns', creature('forsworn', /forsworn/i, reputation.forsworn)], ['Rogues & Warlocks', creature('roguewarlock', /rogue|warlock/i)],
        ['Necromancers', creature('necromancer', /necromancer/i)], ['Pyromancers', creature('pyromancer', /pyromancer/i)],
        ['Cryomancers', creature('cryomancer', /cryomancer/i)], ['Electromancers', creature('electromancer', /electromancer/i)],
        ['Conjurers', creature('conjurer', /conjurer/i)], ['Thalmor Justiciars', creature('thalmorjusticiar', /thalmor.?justiciar/i)],
        ['Afflicted', creature('afflicted', /afflicted/i)], ['Glenmoril Witches', creature('witch', /glenmoril|witch/i)],
        ['Dagon Cultists', creature('dagoncultist', /dagon cultist|mythic dawn/i)], ['Vampires', creature('vampire', /vampire/i, reputation.vampires)],
        ['Reavers', creature('reaver', /reaver/i)]
      ]],
      ['Non-hostile kills', [['Non-hostile kills', creature('nonhostile', /./, reputation.nonhostileKills)]]],
      ['Monster kills', [
        ['All monster kills', Number(reputation.monsters) || 0], ['Chaurus', creature('chaurus', /chaurus/i)],
        ['Dragons', creature('dragon', /dragon(?! ?priest)/i, reputation.dragons)], ['Falmers', creature('falmer', /falmer/i, reputation.falmers)],
        ['Frostbite Spiders', creature('spider', /spider/i, reputation.spiders)], ['Giants', creature('giant', /giant/i)],
        ['Hagravens', creature('hagraven', /hagraven/i, reputation.hagravens)], ['Ice Wraiths', creature('icewraith', /ice.?wraith/i)],
        ['Magic Anomalies', creature('magicanomaly', /magic(al)? anomaly/i)], ['Spriggans', creature('spriggan', /spriggan/i)],
        ['Trolls', creature('troll', /troll/i)], ['Werewolves', creature('werewolf', /werewolf|werebear/i)],
        ['Wispmothers & Wisps', creature('wispmother', /wisp.?mother|wispmother|wisp/i)], ['Gargoyles', creature('gargoyle', /gargoyle/i)],
        ['Death Hounds', creature('deathhound', /death.?hound/i)], ['Ash Spawns', creature('ashspawn', /ash.?spawn/i)],
        ['Draugrs', creature('draugr', /draugr/i, reputation.draugrs)], ['Dragon Priests', creature('dragonpriest', /dragon.?priest/i, reputation.dragonPriests)],
        ['Skeletons', creature('skeleton', /skeleton/i, reputation.skeletons)], ['Ghosts & Shades', creature('ghost', /ghost|shade/i)],
        ['Dwarven Centurions', creature('dwarvencenturion', /centurion/i)], ['Dwarven Spheres', creature('dwarvensphere', /dwarven.?sphere|sphere guardian/i)],
        ['Dwarven Spiders', creature('dwarvenspider', /dwarven.?spider|spider guardian/i)],
        ['Dwarven Machines', creature('dwarven', /dwarven|dwemer|centurion|sphere guardian|spider guardian|ballista/i, reputation.dwarvenCreatures)],
        ['Bears', creature('bear', /bear/i, reputation.bears)], ['Sabre Cats', creature('sabrecat', /sabre.?cat/i)],
        ['Wolves', creature('wolf', /wolf/i, reputation.wolves)], ['Skeevers', creature('skeever', /skeever/i)],
        ['Slaughterfish', creature('slaughterfish', /slaughterfish/i)], ['Mudcrabs', creature('mudcrab', /mudcrab/i)],
        ['Dremora', creature('dremora', /dremora/i)], ['Atronachs', creature('atronach', /atronach/i)]
      ]],
      ['Theft', [['Theft events', Number(reputation.thefts) || 0]]],
      ['Discoveries', [
        ['All items discovered', items.length], ['Locations discovered', locations.length],
        ...['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'].map((rarity) => [`${rarity} items discovered`, items.filter((item) => item.rarity === rarity).length])
      ]]
    ];
    counterGroups.replaceChildren();
    for (const [heading, entries] of groups) {
      const section = document.createElement('section');
      section.className = 'achievement-counter-group';
      const title = document.createElement('h3');
      title.textContent = heading;
      const grid = document.createElement('div');
      grid.className = 'achievement-counter-grid';
      for (const [label, value] of entries) {
        const card = document.createElement('article');
        card.className = 'achievement-counter-card';
        const amount = document.createElement('strong');
        amount.textContent = Math.max(0, Number(value) || 0).toLocaleString();
        const caption = document.createElement('span');
        caption.textContent = label;
        card.append(amount, caption);
        grid.appendChild(card);
      }
      section.append(title, grid);
      counterGroups.appendChild(section);
    }
  }

  document.querySelectorAll('[data-achievements-tab]').forEach((button) => button.addEventListener('click', () => {
    activeTab = button.dataset.achievementsTab || (isMissionApp ? 'dashboard' : 'achievements');
    document.querySelectorAll('[data-achievements-tab]').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-achievements-panel]').forEach((panel) => { panel.hidden = panel.dataset.achievementsPanel !== activeTab; });
    if (activeTab === 'store') requestSkyStoreItemIcons();
    renderSkyAchievements();
  }));
  document.querySelectorAll('[data-dashboard-tab]').forEach((button) => button.addEventListener('click', () => {
    activeDashboardTab = button.dataset.dashboardTab || 'overview';
    document.querySelectorAll('[data-dashboard-tab]').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-dashboard-panel]').forEach((panel) => { panel.hidden = panel.dataset.dashboardPanel !== activeDashboardTab; });
    renderSkyAchievements();
  }));
  byId('skymissions-title-search')?.addEventListener('input', renderTitleGallery);
  byId('achievement-store-search')?.addEventListener('input', applyStoreSearch);

  document.querySelectorAll('[data-achievement-carousel]').forEach((button) => button.addEventListener('click', () => {
    const allAchievements = Array.isArray(data.assets?.achievements) ? data.assets.achievements : [];
    const achievements = evaluateDashboardAchievements(allAchievements).unlocked;
    if (!achievements.length) return;
    const step = Math.min(6, achievements.length);
    achievementCarouselOffset = (achievementCarouselOffset + (button.dataset.achievementCarousel === 'next' ? step : -step) + achievements.length) % achievements.length;
    renderAchievementCarousel(achievements);
  }));
  document.querySelectorAll('[data-name-card-scroll]').forEach((button) => button.addEventListener('click', () => {
    const cards = (Array.isArray(data.assets?.nameCards) ? data.assets.nameCards : []).filter((card, index) => isNameCardUnlocked(card, index));
    const max = Math.max(0, cards.length - 4);
    nameCardListOffset = Math.max(0, Math.min(max, nameCardListOffset + (button.dataset.nameCardScroll === 'down' ? 1 : -1)));
    renderNameCardList(cards);
  }));
  byId('achievement-add-property')?.addEventListener('click', () => {
    const input = byId('achievement-property-input');
    const name = input?.value.trim();
    if (!name) return;
    if (!profileSettings.properties.some((property) => property.toLocaleLowerCase() === name.toLocaleLowerCase())) profileSettings.properties.push(name);
    if (input) input.value = '';
    saveProfileSettings();
    renderSkyAchievements();
  });
  byId('achievement-property-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); byId('achievement-add-property')?.click(); }
  });
  const spouseName = byId('achievement-spouse-name');
  if (spouseName) { spouseName.value = profileSettings.spouse || ''; spouseName.disabled = profileSettings.maritalStatus !== 'Married'; }
  byId('achievement-save-marital')?.addEventListener('click', () => {
    profileSettings.maritalStatus = profileSettings.maritalStatus === 'Married' ? 'Married' : 'Single';
    profileSettings.spouse = profileSettings.maritalStatus === 'Married' ? (spouseName?.value.trim() || '') : '';
    saveProfileSettings();
    renderSkyAchievements();
  });

  document.querySelectorAll('.skyachievement-picker').forEach((picker) => {
    const name = picker.dataset.skyachievementPicker;
    const trigger = picker.querySelector('.skyachievement-picker-trigger');
    const popover = picker.querySelector('.skyachievement-picker-popover');
    const search = picker.querySelector('.skyachievement-picker-search input');
    trigger.addEventListener('click', () => {
      const opening = popover.hidden;
      document.querySelectorAll('.skyachievement-picker-popover').forEach((menu) => {
        menu.hidden = true;
        menu.parentElement.querySelector('.skyachievement-picker-trigger')?.setAttribute('aria-expanded', 'false');
      });
      popover.hidden = !opening;
      trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening && search) { search.value = ''; renderSkyAchievements(); search.focus(); }
    });
    if (search) {
      search.addEventListener('input', renderSkyAchievements);
      search.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        popover.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
      });
    }
    picker.querySelector('.skyachievement-picker-options').addEventListener('click', (event) => {
      const option = event.target.closest('.skyachievement-picker-option');
      if (!option) return;
      filters[name] = option.dataset.value;
      if (name === 'achievement-marital-status') {
        profileSettings.maritalStatus = option.dataset.value === 'Married' ? 'Married' : 'Single';
        if (profileSettings.maritalStatus === 'Single') profileSettings.spouse = '';
        saveProfileSettings();
      }
      popover.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      renderSkyAchievements();
    });
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('.skyachievement-picker')) return;
    document.querySelectorAll('.skyachievement-picker-popover:not([hidden])').forEach((menu) => {
      menu.hidden = true;
      menu.parentElement.querySelector('.skyachievement-picker-trigger')?.setAttribute('aria-expanded', 'false');
    });
  });

  byId('achievement-refresh-missions')?.addEventListener('click', () => refreshAvailableMissions(true));
  byId('achievement-refresh-store')?.addEventListener('click', () => requestSkyStoreRefresh('manual', true));

  window.addEventListener('message', (event) => {
    const rawMessage = event.data;
    if (rawMessage?.channel === bridgeChannel && rawMessage.type === 'update') {
      const rawPayload = rawMessage.payload && typeof rawMessage.payload === 'object' ? rawMessage.payload : {};
      const rawData = rawPayload.data && typeof rawPayload.data === 'object' ? rawPayload.data : {};
      const eventCount = Array.isArray(rawData.events) ? rawData.events.length : 0;
      reportSkyAchievementsDiagnostic(`TRACE message event entered id=${Number(rawPayload.id) || 0} kind=${String(rawPayload.kind || 'unknown')} sourceIsParent=${event.source === window.parent} events=${eventCount}`);
    }
    if (event.source !== window.parent) {
      if (event.data?.channel === bridgeChannel && event.data.type === 'update') {
        reportSkyAchievementsDiagnostic(`ignored update from unexpected message source; id=${Number(event.data.payload?.id) || 0}`);
      }
      return;
    }
    let message = event.data;
    const receivedType = typeof message;
    const receivedLength = typeof message === 'string' ? message.length : 0;
    if (typeof message === 'string') reportSkyAchievementsDiagnostic(`parent message received; type=${receivedType}; chars=${receivedLength}`);
    if (typeof message === 'string') {
      try { message = JSON.parse(message); }
      catch (error) {
        reportSkyAchievementsDiagnostic(`could not parse message from SkyOS: ${String(error?.message || error).slice(0, 100)}`);
        return;
      }
    }
    if (message?.channel !== bridgeChannel) return;
    if (message.type === 'host-ready') {
      reportSkyAchievementsDiagnostic('app.js acknowledged host-ready');
      window.parent.postMessage({ channel: bridgeChannel, type: 'ready' }, '*');
      return;
    }
    if (message.type !== 'update') return;
    const update = message.payload && typeof message.payload === 'object' ? message.payload : {};
    const updateId = Number(update.id);
    const kind = String(update.kind || 'unknown');
    reportSkyAchievementsDiagnostic(`update envelope parsed id=${updateId}; kind=${kind}; dataType=${typeof update.data}`);
    if (!Number.isSafeInteger(updateId) || updateId <= 0) {
      reportSkyAchievementsDiagnostic(`received ${kind} update with invalid id=${update.id}`);
      acknowledgeSkyAchievementsUpdate(updateId || 0, kind, false, 'invalid update id');
      return;
    }
    if (processedSkyAchievementsUpdateIds.has(updateId)) {
      reportSkyAchievementsDiagnostic(`duplicate ${kind} update id=${updateId}; acknowledging without reprocessing`);
      acknowledgeSkyAchievementsUpdate(updateId, kind, true, 'duplicate already processed');
      return;
    }
    const latestId = latestSkyAchievementsUpdateIds.get(kind) || 0;
    if (updateId < latestId) {
      reportSkyAchievementsDiagnostic(`stale ${kind} update id=${updateId}; latest processed id=${latestId}`);
      acknowledgeSkyAchievementsUpdate(updateId, kind, true, 'stale update ignored');
      return;
    }
    const updateStarted = performance.now();
    reportSkyAchievementsDiagnostic(`native ${kind} update arrived id=${updateId}`);
    try {
      if (kind === 'player') {
        data.player = update.data && typeof update.data === 'object' ? update.data : {};
        data.playerLoaded = true;
        achievementDataRevision++;
      }
      else if (kind.startsWith('history-chunk-')) {
        const chunkIndex = Number(kind.slice('history-chunk-'.length));
        const chunk = update.data && typeof update.data === 'object' ? update.data : {};
        if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Array.isArray(chunk.events)) {
          acknowledgeSkyAchievementsUpdate(updateId, kind, false, 'invalid history chunk');
          return;
        }
        if (chunkIndex === 0) {
          data.history = { ...(chunk.metadata && typeof chunk.metadata === 'object' ? chunk.metadata : {}), events: [] };
          data.historyLoaded = false;
          expectedHistoryChunkCount = Math.max(1, Math.floor(Number(chunk.chunkCount) || 1));
          receivedHistoryChunkCount = 0;
        }
        if (chunkIndex !== receivedHistoryChunkCount || expectedHistoryChunkCount <= 0) {
          acknowledgeSkyAchievementsUpdate(updateId, kind, false, 'history chunks arrived out of order');
          return;
        }
        const appendStarted = performance.now();
        reportSkyAchievementsDiagnostic(`TRACE chunk append started index=${chunkIndex}/${expectedHistoryChunkCount - 1} priorEvents=${data.history.events.length} appendEvents=${chunk.events.length}`);
        data.history.events.push(...chunk.events);
        receivedHistoryChunkCount++;
        data.historyLoaded = receivedHistoryChunkCount === expectedHistoryChunkCount;
        achievementDataRevision++;
        reportSkyAchievementsDiagnostic(`TRACE chunk append complete index=${chunkIndex} totalEvents=${data.history.events.length} appendMs=${Math.round(performance.now() - appendStarted)}`);
      }
      else if (kind === 'history') {
        data.history = update.data && typeof update.data === 'object' ? update.data : {};
        data.historyLoaded = true;
        expectedHistoryChunkCount = 0;
        receivedHistoryChunkCount = 0;
        achievementDataRevision++;
      }
      else if (kind === 'mission-events') {
        const events = update.data && typeof update.data === 'object' && Array.isArray(update.data.events) ? update.data.events : [];
        data.missionEvents = events.slice(0, 64);
        if (isMissionApp) deferSkyAchievementsMissionProcessing(kind, () => processMissionEvents(data.missionEvents));
      }
      else if (kind === 'assets') { data.assets = update.data && typeof update.data === 'object' ? update.data : { playerCard: null, nameCards: [], achievements: [] }; data.assetsLoaded = true; achievementDataRevision++; }
      else if (kind === 'items') { data.items = Array.isArray(update.data) ? update.data : []; data.itemsLoaded = true; achievementDataRevision++; }
      else if (kind === 'locations') { data.locations = Array.isArray(update.data) ? update.data : []; data.locationsLoaded = true; achievementDataRevision++; }
      else if (kind === 'store') data.storeOffers = Array.isArray(update.data) ? update.data : [];
      else if (kind === 'game-store') receiveSkyStoreStock(update.data && typeof update.data === 'object' ? update.data : {});
      else if (kind.startsWith('game-store-icon:')) receiveSkyStoreItemIcon(update.data && typeof update.data === 'object' ? update.data : {});
      else if (kind === 'game-store-purchase-result') receiveSkyStorePurchaseResult(update.data && typeof update.data === 'object' ? update.data : {});
      else {
        reportSkyAchievementsDiagnostic(`cannot process update id=${updateId}; unsupported kind=${kind}`);
        acknowledgeSkyAchievementsUpdate(updateId, kind, false, 'unsupported update kind');
        return;
      }
      const recordCount = kind === 'history' ? (Array.isArray(data.history.events) ? data.history.events.length : 0)
        : kind === 'mission-events' ? data.missionEvents.length
        : kind.startsWith('history-chunk-') ? `${receivedHistoryChunkCount}/${expectedHistoryChunkCount} history chunks`
        : kind === 'items' ? data.items.length
          : kind === 'locations' ? data.locations.length
            : kind === 'store' ? `${data.storeOffers.length} offers`
              : kind === 'game-store' ? `${Array.isArray(update.data?.items) ? update.data.items.length : 0} random game items`
                : kind.startsWith('game-store-icon:') ? 'random game item icon'
                : kind === 'game-store-purchase-result' ? 'purchase result'
              : kind === 'assets' ? `${data.assets.achievements?.length || 0} achievements/${data.assets.nameCards?.length || 0} name cards` : '';
      const historyComplete = kind.startsWith('history-chunk-') && receivedHistoryChunkCount === expectedHistoryChunkCount;
      if (!kind.startsWith('history-chunk-') || historyComplete) {
        scheduleSkyAchievementsRender(`${kind} update`);
      }
      latestSkyAchievementsUpdateIds.set(kind, updateId);
      processedSkyAchievementsUpdateIds.add(updateId);
      if (processedSkyAchievementsUpdateIds.size > 128) processedSkyAchievementsUpdateIds.delete(processedSkyAchievementsUpdateIds.values().next().value);
      reportSkyAchievementsDiagnostic(`processed ${kind} update id=${updateId}${recordCount ? ` (${recordCount})` : ''}; elapsedMs=${Math.round(performance.now() - updateStarted)}`);
      acknowledgeSkyAchievementsUpdate(updateId, kind, true);
    } catch (error) {
      const detail = String(error?.message || error || 'unknown processing error').replace(/[\r\n\t]/g, ' ').slice(0, 100);
      reportSkyAchievementsDiagnostic(`processing ${kind} update id=${updateId} failed: ${detail}`);
      acknowledgeSkyAchievementsUpdate(updateId, kind, false, detail);
    }
  });
  window.addEventListener('messageerror', () => reportSkyAchievementsDiagnostic('browser reported a message deserialization error from SkyOS'));

  const startupRenderStarted = performance.now();
  reportSkyAchievementsDiagnostic('TRACE initial render started');
  startMissionRefreshClock();
  renderSkyAchievements();
  reportSkyAchievementsDiagnostic(`initial render complete: elapsedMs=${Math.round(performance.now() - startupRenderStarted)}`);
  window.parent.postMessage({ channel: bridgeChannel, type: 'ready' }, '*');
})();
