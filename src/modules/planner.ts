// ==========================================================================
// Planner Mode Overview: [B] Batch Management | [M] Moments Organizer
// ==========================================================================

import type {
  AppleMonthSelectionDetailResponse,
  BatchDeviceSummary,
  CliStep2ConsoleMomentRow,
  CliStep2PendingPublishingRow,
  CliStep2Simulation,
  CreateMomentResponse,
  DisjointDetailAsset,
  DisjointDetailResponse,
  DisjointNameSuggestion,
  MemoriesFolderItem,
  MemoriesFoldersResponse,
  ModeMDedupApplyResponse,
  AllGroupingsResponse,
  GroupingAssetsResponse,
  ModeMDedupDuplicate,
  ModeMDedupPreviewResponse,
  MomentAssetsPreviewResponse,
  MomentTagItem,
  MomentTagSessionSummary,
  PlannerBatchCandidate,
  PlannerModeB,
  PlannerModeM,
  PlannerOverviewResponse,
  PublishMomentAssetItem,
  PublishMomentInfoResponse,
  PublishMomentResponse,
  ResolveDisjointResponse,
  SaveMomentTagsResponse,
  SearchMomentItem,
  SearchMomentsResponse,
  TagCatalogItem,
  TagLookupResponse,
  TimeframeDeviceAssetItem,
  TimeframeDevicesResponse,
  UnifiedGroupingAssetItem,
  UnifiedGroupingItem
} from '../types/api.ts';
import { candidateAssetMeta, escapeHtml, formatBytes, formatDuration } from '../utils/formatters.ts';
import { openCleanupPreviewModal } from './cleanup.ts';

let plannerOverviewData: PlannerOverviewResponse | null = null;
type PlannerModeTarget = 'b' | 'm' | 'all';
const activePlannerFetchByMode: Partial<Record<PlannerModeTarget, Promise<void>>> = {};
const pendingPlannerRefreshByMode: Partial<Record<PlannerModeTarget, boolean>> = {};
let activePlannerModeView: 'b' | 'm' | 'g' | 'c' = 'b';
let modeBLoaded = false;
let modeMLoaded = false;
let foldersLoaded = false;
let allGroupingsLoaded = false;
let isFetchingAllGroupings = false;
let allGroupingsData: AllGroupingsResponse | null = null;
let allGroupingsSortMode: 'avg_score' | 'qual_avg' | 'count' | 'rank_score' | 'date' = 'avg_score';
let allGroupingsStatusFilter = 'all';
let allGroupingsBatchFilter: 'all' | '600_plus' | 'under_600' = 'all';
let allGroupingsLibraryFilter: 'all' | 'organizer' | 'source_only' = 'all';
let allGroupingsSearchQuery = '';
const expandedUnifiedGroupingIds = new Set<string>();
const unifiedGroupingAssetsCache = new Map<string, UnifiedGroupingAssetItem[]>();
const unifiedGroupingSelectedIds = new Map<string, Set<string>>();
const unifiedGroupingCuratedOnly = new Set<string>();
let editingUnifiedGroupingPubUrlId: string | null = null;
let unassignedSortMode: 'size' | 'score' | 'date' = 'size';
let unassignedSearchQuery = '';
const expandedUnassignedFolders = new Set<string>();
const clusterPreviewAssetIds = new Map<string, string[]>();
const clusterAssetSelection = new Map<string, Set<string>>();
let dedupPreviewData: ModeMDedupPreviewResponse | null = null;
const selectedDedupAssetIds = new Set<string>();
let isRunningDedupPreview = false;
let isApplyingDedupIgnore = false;
let plannerRefreshExecutorCb: (() => void) | undefined;
let plannerRefreshMediaMetricsCb: (() => void) | undefined;

let memoriesFoldersScope: 'moments' | 'curated' | 'to_be_curated' | 'folders' | 'all' = 'moments';
let memoriesFoldersQuery = '';
let memoriesFoldersSort: 'name' | 'recent' | 'assets' = 'name';
let memoriesFoldersData: MemoriesFoldersResponse | null = null;
let memoriesFoldersCollapsed = false;
let memoriesFoldersSearchTimer: number | null = null;
let cliStep2bCollapsed = false;
const collapsedCliStep2bBuckets = new Set<string>();

interface CreateMomentContext {
  sourceClusterFolder?: string;
  uniqueAssetIds: string[];
  allAssetIds: string[];
  duplicateCount: number;
}
let createMomentCtx: CreateMomentContext = { uniqueAssetIds: [], allAssetIds: [], duplicateCount: 0 };
let isSubmittingCreateMoment = false;
let createMomentCompleted = false;
let createMomentCheckTimer: number | null = null;
let groupingRulesPanelCollapsed = true;
let isUpdatingGroupingRules = false;

let publishMomentName = '';
let publishMomentAssets: PublishMomentAssetItem[] = [];
const publishSelectedAssetIds = new Set<string>();
const publishSkippedAssetIds = new Set<string>();
const publishAutoPromotedIds = new Set<string>();
let publishInitialSelectedKey = '';
let publishTargetBatchSize = 9;
let publishFilterCuratedOnly = false;
let disjointFilterCuratedOnly = false;
let isApplyingPublishCuration = false;
let isSubmittingPublishMoment = false;
let publishMomentCompleted = false;

interface TaggingEngineState {
  mountId: string;
  momentName: string;
  titleLabel: string;
  tags: MomentTagItem[];
  lastSession: MomentTagSessionSummary | null;
  tagDbCounts: Record<string, { assets: number; moments: number }>;
  tagCatalogByCategory: Record<string, TagCatalogItem[]>;
  familyPool: string[];
  removedTagValues: Set<string>;
  activeQueriedTagKey: string;
  isSaving: boolean;
  saveStatusMsg: string;
  saveStatusOk: boolean;
  queryTitle: string;
  queryData: TagLookupResponse | null;
  isQueryOpen: boolean;
  showCopyFromDisjointBtn: boolean;
  hideSaveUseBtn?: boolean;
  getSelectedAssetIds: () => string[];
  onTagsChanged: () => void;
  onUseForName: (composedName: string) => void;
  onCopyFromDisjoint?: () => void;
}

let resolveDisjointMomentName = '';
let resolveDisjointIsUnassignedCluster = false;
let resolveDisjointIsHistoricalMoment = false;
let resolveDisjointIsCurateM200 = false;
let resolveDisjointExplicitAssetIds: string[] = [];
let resolveDisjointAssets: DisjointDetailAsset[] = [];
const resolveDisjointSelectedIds = new Set<string>();
let isSubmittingResolveDisjoint = false;
let resolveDisjointCompleted = false;
let combinedExtraMoments = new Map<
  string,
  {
    momentName: string;
    assetIds: Set<string>;
    totalAssets: number;
    tags: MomentTagItem[];
    isTimeframeDeviceSelection?: boolean;
    allAssets?: Array<{ asset_id: string; score_normalized: number; original_filename?: string; is_duplicate_copy?: boolean }>;
  }
>();
const candidateTagsCache = new Map<string, { tags: MomentTagItem[]; lastSession: MomentTagSessionSummary | null }>();
let previewedCandidateMomentName = '';
let previewedCandidateAssets: DisjointDetailAsset[] = [];
const previewedCandidateSelectedIds = new Set<string>();
let nearbyMomentCandidatesList: Array<{ moment_name: string; qualified_count: number; rel_label: string; is_suggested: boolean }> = [];
let displayedCandidateMomentsList: Array<{ moment_name: string; qualified_count: number; total_count?: number; rel_label: string; is_suggested?: boolean }> = [];
let momentSearchTimer: number | null = null;
let disjointTimeframeWindowDays = 1;
let disjointTimeframeData: TimeframeDevicesResponse | null = null;
let disjointTimeframeActiveDeviceKey: string | null = null;
let disjointTimeframeQualOnly = false;
const disjointTimeframeCheckedIds = new Set<string>();
let lastAutoSyncedTargetName = '';
let targetNameManuallyEdited = false;
const existingTargetAlbumsMap = new Map<string, number>();
let existingAlbumsList: Array<{ album_name: string; parent_folder_name: string; asset_count: number }> = [];

function getExistingTargetAlbumInfo(parentFolder: string, targetName: string): { exists: boolean; assetCount: number } {
  const cleanName = targetName.trim().toLowerCase();
  if (!cleanName) return { exists: false, assetCount: 0 };
  const key = `${(parentFolder || 'Moments').trim().toLowerCase()}::${cleanName}`;
  if (existingTargetAlbumsMap.has(key)) {
    return { exists: true, assetCount: existingTargetAlbumsMap.get(key) ?? 0 };
  }
  return { exists: false, assetCount: 0 };
}

function applyTargetMomentName(name: string, manualOverride: boolean): void {
  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  if (targetInp) {
    targetInp.value = name;
  }
  targetNameManuallyEdited = manualOverride;
  if (!manualOverride) {
    lastAutoSyncedTargetName = name;
  }
  updateResolveDisjointTargetPreview();
  updateSingleAssetWarningVisibility();
  refreshExpectedCuratedUI();
}

function createEmptyTaggingState(
  mountId: string,
  titleLabel: string,
  showCopyFromDisjointBtn: boolean,
  getSelectedAssetIds: () => string[]
): TaggingEngineState {
  return {
    mountId,
    momentName: '',
    titleLabel,
    tags: [],
    lastSession: null,
    tagDbCounts: {},
    tagCatalogByCategory: {},
    familyPool: ['Niki', 'Milena', 'Roberto', 'Eva', 'Benny'],
    removedTagValues: new Set<string>(),
    activeQueriedTagKey: '',
    isSaving: false,
    saveStatusMsg: '',
    saveStatusOk: true,
    queryTitle: '',
    queryData: null,
    isQueryOpen: false,
    showCopyFromDisjointBtn,
    getSelectedAssetIds,
    onTagsChanged: () => renderPropagateTagsPreview(),
    onUseForName: (composedName: string) => {
      if (composedName) {
        applyTargetMomentName(composedName, false);
      }
    }
  };
}

const sourceTagState: TaggingEngineState = createEmptyTaggingState(
  'resolve-disjoint-source-tagging-mount',
  '🏷️ Memory Tagging & Naming Engine',
  false,
  () => Array.from(resolveDisjointSelectedIds)
);
sourceTagState.onTagsChanged = () => {
  renderPropagateTagsPreview();
  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const curVal = (targetInp?.value || '').trim();
  if (!targetNameManuallyEdited || curVal === '' || curVal === lastAutoSyncedTargetName) {
    const fallback = resolveDisjointIsUnassignedCluster && /uncategorized/i.test(resolveDisjointMomentName)
      ? ''
      : resolveDisjointMomentName;
    const composed = composeMomentNameFromTags(sourceTagState.tags, fallback);
    if (composed) {
      applyTargetMomentName(composed, false);
    }
  }
};

const candidateTagState: TaggingEngineState = createEmptyTaggingState(
  'resolve-disjoint-candidate-tagging-mount',
  '🏷️ Existing Moment Tagging & Naming Engine',
  true,
  () => Array.from(previewedCandidateSelectedIds)
);
candidateTagState.onCopyFromDisjoint = () => {
  let skippedDups = 0;
  sourceTagState.tags.forEach(srcT => {
    const exists = candidateTagState.tags.some(
      ct => ct.tag_value.toLowerCase() === srcT.tag_value.toLowerCase()
    );
    if (!exists) {
      candidateTagState.removedTagValues.delete(srcT.tag_value.toLowerCase());
      candidateTagState.tags.push({ ...srcT });
    } else {
      skippedDups += 1;
    }
  });
  candidateTagState.saveStatusOk = true;
  candidateTagState.saveStatusMsg =
    skippedDups > 0
      ? `ℹ️ Copied new tags from Disjoint (${skippedDups} duplicate tag(s) skipped).`
      : 'ℹ️ Copied tags from Disjoint Moment.';
  candidateTagState.onTagsChanged();
  renderTaggingEngineCard(candidateTagState);
};
candidateTagState.onTagsChanged = () => {
  if (candidateTagState.momentName) {
    candidateTagsCache.set(candidateTagState.momentName, {
      tags: candidateTagState.tags.map(t => ({ ...t })),
      lastSession: candidateTagState.lastSession
    });
    const combined = combinedExtraMoments.get(candidateTagState.momentName);
    if (combined) {
      combined.tags = candidateTagState.tags.map(t => ({ ...t }));
    }
  }
  renderPropagateTagsPreview();
};

let publishTagsDirty = false;
const publishTagState: TaggingEngineState = createEmptyTaggingState(
  'publish-moment-tagging-mount',
  '🏷️ Memory Tagging & Naming Engine',
  false,
  () => Array.from(publishSelectedAssetIds)
);
publishTagState.hideSaveUseBtn = true;
publishTagState.onTagsChanged = () => {
  publishTagsDirty = true;
};

type ClustersSyncLockMode = 'idle' | 'running' | 'awaiting' | 'reloading';
let clustersSyncLockMode: ClustersSyncLockMode = 'idle';
let clustersSyncLockMessage = '';
let clustersLastUpdatedTime = '';
let appleSyncBaselineRefreshUtc = '';
let appleSyncAwaitingSinceMs = 0;
let appleSyncPollInterval: ReturnType<typeof setInterval> | null = null;
let latestBgSyncStateInfo: {
  isRunning: boolean;
  syncState: string;
  latestRefreshUtc: string;
} = { isRunning: false, syncState: 'UNKNOWN', latestRefreshUtc: '' };

const POST_APPLE_RELOAD_STORAGE_KEY = 'agy_post_apple_reload_state';
const ACTIVE_PLANNER_MODE_STORAGE_KEY = 'agy_active_planner_mode_view';

function loadSavedPlannerModeView(): 'b' | 'm' | 'g' | 'c' {
  try {
    const v = window.localStorage.getItem(ACTIVE_PLANNER_MODE_STORAGE_KEY);
    if (v === 'm' || v === 'g' || v === 'c' || v === 'b') return v;
  } catch {
    // ignore storage errors
  }
  return 'b';
}

function savePostAppleReloadState(): void {
  try {
    const activeTab = document.querySelector<HTMLElement>('.nav-tab.active')?.dataset.tab || 'media';
    window.sessionStorage.setItem(
      POST_APPLE_RELOAD_STORAGE_KEY,
      JSON.stringify({
        tab: activeTab,
        modeView: activePlannerModeView,
        at: Date.now()
      })
    );
  } catch {
    // ignore storage errors
  }
}

let cachedPostAppleReloadState: { tab: string; modeView: 'b' | 'm' | 'g' | 'c' } | null | undefined;

export function consumePostAppleReloadState(): { tab: string; modeView: 'b' | 'm' | 'g' | 'c' } | null {
  if (cachedPostAppleReloadState !== undefined) {
    return cachedPostAppleReloadState;
  }
  try {
    const raw = window.sessionStorage.getItem(POST_APPLE_RELOAD_STORAGE_KEY);
    if (!raw) {
      cachedPostAppleReloadState = null;
      return null;
    }
    window.sessionStorage.removeItem(POST_APPLE_RELOAD_STORAGE_KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number' || Date.now() - parsed.at > 45000) {
      cachedPostAppleReloadState = null;
      return null;
    }
    const modeView =
      parsed.modeView === 'm' || parsed.modeView === 'g' || parsed.modeView === 'c' ? parsed.modeView : 'b';
    const tab = typeof parsed.tab === 'string' && parsed.tab ? parsed.tab : 'media';
    cachedPostAppleReloadState = { tab, modeView };
    return cachedPostAppleReloadState;
  } catch {
    cachedPostAppleReloadState = null;
    return null;
  }
}

function ensureAppleSyncFastPolling(active: boolean): void {
  if (active) {
    if (!appleSyncPollInterval) {
      appleSyncPollInterval = setInterval(() => {
        if (plannerRefreshExecutorCb) plannerRefreshExecutorCb();
      }, 2500);
    }
  } else if (appleSyncPollInterval) {
    clearInterval(appleSyncPollInterval);
    appleSyncPollInterval = null;
  }
}

function triggerPostSyncBrowserRefresh(): void {
  clustersSyncLockMode = 'reloading';
  clustersSyncLockMessage =
    '✅ Background DB Copy & Sync complete — re-enabling UI and refreshing browser…';
  ensureAppleSyncFastPolling(false);
  renderClustersSyncUI();
  savePostAppleReloadState();
  window.setTimeout(() => {
    setClustersSyncLock('idle');
    window.location.reload();
  }, 450);
}

function formatClusterDbSyncShort(utcStr: string): string {
  const s = (utcStr || '').trim();
  if (!s || s === '—') return '';
  const m = s.match(/(\d{2}:\d{2})(?::\d{2})?/);
  return m ? `DB ${m[1]} UTC` : `DB ${s.slice(0, 16)}`;
}

function renderClustersSyncUI(): void {
  const tabMediaEl = document.getElementById('tab-media');
  const globalBannerEl = document.getElementById('apple-photos-sync-banner');
  const globalTextEl = document.getElementById('apple-photos-sync-banner-text');
  const globalPillEl = document.getElementById('apple-photos-sync-pill');
  const btnStartBg = document.getElementById('btn-apple-sync-start-bg');
  const sectionEl = document.getElementById('mode-m-unassigned-section');
  const bannerEl = document.getElementById('mode-m-clusters-sync-banner');
  const bannerTextEl = document.getElementById('mode-m-clusters-sync-banner-text');
  const badgeEl = document.getElementById('mode-m-clusters-updated-badge');

  const isLocked = clustersSyncLockMode !== 'idle' && clustersSyncLockMode !== 'reloading';
  tabMediaEl?.classList.toggle('apple-photos-workspace-locked', isLocked);
  sectionEl?.classList.toggle('clusters-awaiting-sync', isLocked);

  const showBanner = clustersSyncLockMode !== 'idle';
  if (globalBannerEl) {
    globalBannerEl.style.display = showBanner ? 'flex' : 'none';
  }
  if (bannerEl) {
    bannerEl.style.display = showBanner ? 'flex' : 'none';
  }

  let statusMsg = clustersSyncLockMessage;
  if (clustersSyncLockMode === 'running') {
    statusMsg =
      clustersSyncLockMessage ||
      'Running Apple Photos update — UI is grayed out until update and Background DB Sync complete…';
  } else if (clustersSyncLockMode === 'awaiting') {
    if (!latestBgSyncStateInfo.isRunning) {
      statusMsg =
        '⚠️ Apple Photos updated, but Background DB Copy & Sync Service is stopped — start the service or click Force Refresh & Unlock.';
    } else if (latestBgSyncStateInfo.syncState === 'SOURCE_OFFLINE') {
      statusMsg =
        '⚠️ Apple Photos updated, but source Photos volume is offline — click Force Refresh & Unlock when ready.';
    } else if (latestBgSyncStateInfo.syncState === 'REFRESHING') {
      statusMsg =
        '🔄 Background DB Copy & Sync Service is refreshing SQLite metadata — UI will re-enable & reload browser when finished…';
    } else {
      statusMsg =
        clustersSyncLockMessage ||
        '⏳ Apple Photos updated — awaiting Background DB Copy & Sync Service to refresh before re-enabling UI and refreshing browser…';
    }
  } else if (clustersSyncLockMode === 'reloading') {
    statusMsg =
      '✅ Background DB Copy & Sync complete — re-enabling UI and refreshing browser…';
  }

  if (globalTextEl && showBanner) {
    globalTextEl.textContent = statusMsg;
  }
  if (bannerTextEl && showBanner) {
    bannerTextEl.textContent = statusMsg;
  }
  if (btnStartBg) {
    btnStartBg.style.display =
      clustersSyncLockMode === 'awaiting' && !latestBgSyncStateInfo.isRunning ? 'inline-flex' : 'none';
  }
  if (globalPillEl && showBanner) {
    if (clustersSyncLockMode === 'running') {
      globalPillEl.className = 'badge badge-xs badge-purple pulse font-mono';
      globalPillEl.textContent = '🍎 Updating Photos…';
    } else if (clustersSyncLockMode === 'reloading') {
      globalPillEl.className = 'badge badge-xs badge-green font-mono';
      globalPillEl.textContent = '✅ Reloading Browser…';
    } else if (!latestBgSyncStateInfo.isRunning) {
      globalPillEl.className = 'badge badge-xs badge-red font-mono';
      globalPillEl.textContent = '⚠️ BG Service Stopped';
    } else if (latestBgSyncStateInfo.syncState === 'REFRESHING') {
      globalPillEl.className = 'badge badge-xs badge-purple pulse font-mono';
      globalPillEl.textContent = '🔄 BG Syncing DB…';
    } else {
      globalPillEl.className = 'badge badge-xs badge-amber pulse font-mono';
      globalPillEl.textContent = '⏳ Awaiting BG Refresh…';
    }
  }

  if (badgeEl) {
    const updPart = clustersLastUpdatedTime ? `Updated ${clustersLastUpdatedTime}` : 'Updated: —';
    const dbPart = formatClusterDbSyncShort(latestBgSyncStateInfo.latestRefreshUtc);
    if (clustersSyncLockMode === 'running') {
      badgeEl.className = 'badge badge-xs badge-purple pulse font-mono';
      badgeEl.textContent = '🍎 Updating Apple Photos…';
    } else if (clustersSyncLockMode === 'awaiting') {
      if (latestBgSyncStateInfo.syncState === 'REFRESHING') {
        badgeEl.className = 'badge badge-xs badge-purple pulse font-mono';
        badgeEl.textContent = '🔄 Syncing Photos DB…';
      } else {
        badgeEl.className = 'badge badge-xs badge-amber pulse font-mono';
        badgeEl.textContent = '⏳ Awaiting DB Sync…';
      }
    } else if (clustersSyncLockMode === 'reloading') {
      badgeEl.className = 'badge badge-xs badge-green font-mono';
      badgeEl.textContent = '✅ Synced · Reloading…';
    } else if (latestBgSyncStateInfo.syncState === 'REFRESHING') {
      badgeEl.className = 'badge badge-xs badge-purple pulse font-mono';
      badgeEl.textContent = `${updPart} · 🔄 Syncing DB`;
    } else if (latestBgSyncStateInfo.syncState === 'SYNC_PENDING') {
      badgeEl.className = 'badge badge-xs badge-amber font-mono';
      badgeEl.textContent = `${updPart} · ⏳ Sync Pending`;
    } else {
      badgeEl.className = 'badge badge-xs badge-outline font-mono';
      badgeEl.textContent = dbPart ? `${updPart} · ${dbPart}` : updPart;
    }
  }
}

function setClustersSyncLock(mode: ClustersSyncLockMode, message = ''): void {
  clustersSyncLockMode = mode;
  clustersSyncLockMessage = message;
  ensureAppleSyncFastPolling(mode === 'awaiting');
  renderClustersSyncUI();
}

export function beginApplePhotosSyncLock(message = ''): void {
  appleSyncBaselineRefreshUtc = latestBgSyncStateInfo.latestRefreshUtc || '';
  setClustersSyncLock(
    'running',
    message || '🍎 Updating Apple Photos — UI paused until Background DB Sync refreshes…'
  );
}

export function cancelApplePhotosSyncLock(): void {
  appleSyncBaselineRefreshUtc = '';
  appleSyncAwaitingSinceMs = 0;
  setClustersSyncLock('idle');
}

export function finishApplePhotosActionSyncLock(awaitingMessage: string): void {
  appleSyncAwaitingSinceMs = Date.now();
  setClustersSyncLock('awaiting', awaitingMessage);
  if (plannerRefreshExecutorCb) plannerRefreshExecutorCb();
}

export function updateClustersBgSyncStatus(bg: {
  isRunning?: boolean;
  syncState?: string;
  latestRefreshUtc?: string;
  syncJustCompleted?: boolean;
}): void {
  const prevLatest = latestBgSyncStateInfo.latestRefreshUtc;
  latestBgSyncStateInfo = {
    isRunning: Boolean(bg.isRunning),
    syncState: bg.syncState || 'UNKNOWN',
    latestRefreshUtc: bg.latestRefreshUtc || ''
  };

  if (clustersSyncLockMode === 'awaiting') {
    const refreshAdvanced =
      Boolean(bg.syncJustCompleted) ||
      (Boolean(prevLatest) && Boolean(bg.latestRefreshUtc) && bg.latestRefreshUtc !== prevLatest) ||
      (Boolean(appleSyncBaselineRefreshUtc) &&
        Boolean(bg.latestRefreshUtc) &&
        bg.latestRefreshUtc !== appleSyncBaselineRefreshUtc &&
        latestBgSyncStateInfo.syncState === 'UP_TO_DATE');
    const noOpSettled =
      latestBgSyncStateInfo.isRunning &&
      latestBgSyncStateInfo.syncState === 'UP_TO_DATE' &&
      appleSyncAwaitingSinceMs > 0 &&
      Date.now() - appleSyncAwaitingSinceMs >= 4000;

    if (refreshAdvanced || noOpSettled) {
      triggerPostSyncBrowserRefresh();
      return;
    }
  }
  renderClustersSyncUI();
}

function applyPlannerModeView(view: 'b' | 'm' | 'g' | 'c'): void {
  activePlannerModeView = view;
  try {
    window.localStorage.setItem(ACTIVE_PLANNER_MODE_STORAGE_KEY, view);
  } catch {
    // ignore storage errors
  }

  document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.modeView === view);
  });

  const grid = document.getElementById('planner-modes-grid');
  const cardB = document.getElementById('planner-mode-b-card');
  const cardM = document.getElementById('planner-mode-m-card');
  const cardG = document.getElementById('all-groupings-card');
  const cardC = document.getElementById('media-cleanup-card');
  const cardPub = document.getElementById('published-memories-card');
  const cardFolders = document.getElementById('mode-m-folders-block');

  if (view === 'b') {
    closeIntakeDedupModal();
    closeCreateMomentModal();
    closePublishMomentModal();
    closeResolveDisjointModal();
    if (grid) {
      grid.style.display = 'grid';
      grid.classList.add('single-col');
    }
    if (cardB) cardB.style.display = 'flex';
    if (cardM) cardM.style.display = 'none';
    if (cardG) cardG.style.display = 'none';
    if (cardC) cardC.style.display = 'none';
    if (cardPub) cardPub.style.display = 'none';
    if (cardFolders) cardFolders.style.display = 'none';
    if (!modeBLoaded) {
      void fetchPlannerOverview(false, 'b');
    }
  } else if (view === 'm') {
    if (grid) {
      grid.style.display = 'grid';
      grid.classList.add('single-col');
    }
    if (cardB) cardB.style.display = 'none';
    if (cardM) cardM.style.display = 'flex';
    if (cardG) cardG.style.display = 'none';
    if (cardC) cardC.style.display = 'none';
    if (cardPub) cardPub.style.display = 'block';
    if (cardFolders) cardFolders.style.display = 'block';
    if (!modeMLoaded) {
      void fetchPlannerOverview(false, 'm');
    }
    if (!foldersLoaded) {
      void fetchMemoriesFolders();
    }
  } else if (view === 'g') {
    closeIntakeDedupModal();
    if (grid) grid.style.display = 'none';
    if (cardB) cardB.style.display = 'none';
    if (cardM) cardM.style.display = 'none';
    if (cardC) cardC.style.display = 'none';
    if (cardPub) cardPub.style.display = 'none';
    if (cardFolders) cardFolders.style.display = 'none';
    if (cardG) cardG.style.display = 'block';
    if (!allGroupingsLoaded) {
      void fetchAllUnifiedGroupings(false);
    }
  } else if (view === 'c') {
    closeIntakeDedupModal();
    closeCreateMomentModal();
    closePublishMomentModal();
    closeResolveDisjointModal();
    if (grid) grid.style.display = 'none';
    if (cardG) cardG.style.display = 'none';
    if (cardPub) cardPub.style.display = 'none';
    if (cardFolders) cardFolders.style.display = 'none';
    if (cardC) {
      cardC.style.display = 'block';
    }
  }
}

export function setupPlannerOverview(onRefreshExecutor?: () => void, onRefreshMediaMetrics?: () => void): void {
  plannerRefreshExecutorCb = onRefreshExecutor;
  plannerRefreshMediaMetricsCb = onRefreshMediaMetrics;

  // Mode view tabs ([B] | [M] | [G] | [C])
  document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = (tab.dataset.modeView as 'b' | 'm' | 'g' | 'c') || 'b';
      applyPlannerModeView(view);
    });
  });

  // Restore planner branch view after post-Apple-Photos reload or last saved localStorage selection
  const restoredReload = consumePostAppleReloadState();
  applyPlannerModeView(restoredReload ? restoredReload.modeView : loadSavedPlannerModeView());

  // Unassigned High-Rank Assets cluster sort buttons
  document.querySelectorAll<HTMLElement>('.unassigned-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.unassigned-sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      unassignedSortMode = (btn.dataset.unassignedSort as 'size' | 'score' | 'date') || 'size';
      renderUnassignedClustersList();
    });
  });

  // Unassigned cluster search input
  const unassignedSearchInput = document.getElementById('mode-m-unassigned-search') as HTMLInputElement | null;
  if (unassignedSearchInput) {
    unassignedSearchInput.addEventListener('input', (e) => {
      unassignedSearchQuery = ((e.target as HTMLInputElement).value || '').trim().toLowerCase();
      renderUnassignedClustersList();
    });
  }

  // Media-Intake Dedup & Ignore (replaces Apple Photos Merge before Proposed Moment grouping)
  document.getElementById('btn-intake-dedup-ignore')?.addEventListener('click', () => {
    void openIntakeDedupModal();
  });

  document.querySelectorAll<HTMLElement>('.btn-close-dedup-modal').forEach(btn => {
    btn.addEventListener('click', () => closeIntakeDedupModal());
  });

  document.getElementById('modal-intake-dedup')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'modal-intake-dedup') {
      closeIntakeDedupModal();
    }
  });

  document.getElementById('btn-rescan-intake-dedup')?.addEventListener('click', () => {
    void runIntakeDedupPreview();
  });

  document.getElementById('dedup-select-all-checkbox')?.addEventListener('change', (e) => {
    const isChecked = (e.target as HTMLInputElement).checked;
    const dups = dedupPreviewData?.duplicates || [];
    dups.forEach(d => {
      if (isChecked) selectedDedupAssetIds.add(d.duplicate_asset_id);
      else selectedDedupAssetIds.delete(d.duplicate_asset_id);
    });
    document.querySelectorAll<HTMLInputElement>('.dedup-item-checkbox').forEach(cb => {
      cb.checked = isChecked;
      cb.closest('.dedup-pair-card')?.classList.toggle('selected', isChecked);
    });
    updateDedupSelectionUI();
  });

  document.getElementById('btn-apply-intake-dedup-ignore')?.addEventListener('click', () => {
    void applyIntakeDedupIgnore();
  });

  // Expand / Collapse all unassigned clusters
  const btnToggleAllClusters = document.getElementById('btn-toggle-all-unassigned-clusters');
  if (btnToggleAllClusters) {
    btnToggleAllClusters.addEventListener('click', () => {
      const clusters = plannerOverviewData?.mode_m?.unassigned_clusters || [];
      if (!clusters.length) return;
      const allExpanded = clusters.every(c => expandedUnassignedFolders.has(c.folder));
      if (allExpanded) {
        expandedUnassignedFolders.clear();
        btnToggleAllClusters.textContent = '⊞ Expand All';
      } else {
        clusters.forEach(c => expandedUnassignedFolders.add(c.folder));
        btnToggleAllClusters.textContent = '⊟ Collapse All';
      }
      renderUnassignedClustersList();
    });
  }

  document.getElementById('btn-refresh-planner-overview')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh-planner-overview') as HTMLButtonElement | null;
    if (activePlannerModeView === 'm') {
      void refreshModeMFull(btn);
    } else if (activePlannerModeView === 'g') {
      void fetchAllUnifiedGroupings(true);
    } else if (activePlannerModeView === 'b') {
      void fetchPlannerOverview(true, 'b');
    }
  });

  setupAllGroupingsListeners();

  document.getElementById('btn-refresh-unassigned-clusters')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh-unassigned-clusters') as HTMLButtonElement | null;
    setClustersSyncLock('idle');
    void refreshModeMFull(btn);
  });

  document.getElementById('btn-unlock-refresh-clusters-sync')?.addEventListener('click', () => {
    triggerPostSyncBrowserRefresh();
  });
  document.getElementById('btn-apple-sync-force-unlock')?.addEventListener('click', () => {
    triggerPostSyncBrowserRefresh();
  });
  document.getElementById('btn-apple-sync-start-bg')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-apple-sync-start-bg') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting...';
    }
    try {
      await fetch('/api/media/bg-service/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' })
      });
      if (plannerRefreshExecutorCb) plannerRefreshExecutorCb();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '▶ Start BG Service';
      }
    }
  });

  // Moments Organizer: Query existing folders under Moments (local DB copy)
  document.querySelectorAll<HTMLElement>('.memories-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = (btn.dataset.foldersScope || 'moments') as typeof memoriesFoldersScope;
      memoriesFoldersScope = scope;
      document.querySelectorAll<HTMLElement>('.memories-scope-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.foldersScope === scope);
      });
      void fetchMemoriesFolders();
    });
  });

  const foldersSearchEl = document.getElementById('mode-m-folders-search') as HTMLInputElement | null;
  if (foldersSearchEl) {
    foldersSearchEl.addEventListener('input', () => {
      memoriesFoldersQuery = foldersSearchEl.value.trim();
      if (memoriesFoldersSearchTimer !== null) window.clearTimeout(memoriesFoldersSearchTimer);
      memoriesFoldersSearchTimer = window.setTimeout(() => {
        void fetchMemoriesFolders();
      }, 160);
    });
  }

  const foldersSortEl = document.getElementById('mode-m-folders-sort') as HTMLSelectElement | null;
  if (foldersSortEl) {
    foldersSortEl.addEventListener('change', () => {
      memoriesFoldersSort = (foldersSortEl.value as 'name' | 'recent' | 'assets') || 'name';
      void fetchMemoriesFolders();
    });
  }

  document.getElementById('btn-refresh-memories-folders')?.addEventListener('click', () => {
    void fetchMemoriesFolders();
  });

  const wireStepToggle = (btnId: string, bodyId: string): void => {
    const btn = document.getElementById(btnId);
    btn?.addEventListener('click', () => {
      const bodyEl = document.getElementById(bodyId);
      if (!bodyEl) return;
      const collapsed = bodyEl.classList.toggle('collapsed');
      btn.textContent = collapsed ? '▾ Expand' : '▴ Collapse';
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  };
  wireStepToggle('btn-toggle-mode-m-step-1', 'mode-m-step-1-body');
  wireStepToggle('btn-toggle-mode-m-step-2', 'mode-m-step-2-body');
  wireStepToggle('btn-toggle-mode-m-cli-sim', 'mode-m-cli-sim-body');

  const btnToggleFolders = document.getElementById('btn-toggle-memories-folders');
  if (btnToggleFolders) {
    btnToggleFolders.addEventListener('click', () => {
      memoriesFoldersCollapsed = !memoriesFoldersCollapsed;
      const bodyEl = document.getElementById('mode-m-folders-body');
      bodyEl?.classList.toggle('collapsed', memoriesFoldersCollapsed);
      btnToggleFolders.textContent = memoriesFoldersCollapsed ? '▾ Expand' : '▴ Collapse';
    });
  }

  // Create Moment via AppleScript Modal wiring
  document.getElementById('btn-open-create-moment-header')?.addEventListener('click', () => {
    openCreateMomentModal();
  });

  document.querySelectorAll<HTMLElement>('.btn-close-create-moment-modal').forEach(btn => {
    btn.addEventListener('click', () => closeCreateMomentModal());
  });

  document.getElementById('modal-create-moment')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'modal-create-moment') {
      closeCreateMomentModal();
    }
  });

  const cmNameInput = document.getElementById('create-moment-name-input') as HTMLInputElement | null;
  const cmParentSelect = document.getElementById('create-moment-parent-select') as HTMLSelectElement | null;
  if (cmNameInput) {
    cmNameInput.addEventListener('input', () => {
      updateCreateMomentTargetPath();
      if (createMomentCheckTimer !== null) window.clearTimeout(createMomentCheckTimer);
      createMomentCheckTimer = window.setTimeout(() => {
        void checkExistingMemoriesMatch(cmNameInput.value.trim());
      }, 180);
    });
  }
  if (cmParentSelect) {
    cmParentSelect.addEventListener('change', () => {
      updateCreateMomentTargetPath();
    });
  }

  document.getElementById('create-moment-exclude-dups')?.addEventListener('change', () => updateCreateMomentAssetsUI());
  document.getElementById('create-moment-ignore-dups')?.addEventListener('change', () => updateCreateMomentAssetsUI());
  document.getElementById('create-moment-empty-only')?.addEventListener('change', () => updateCreateMomentAssetsUI());
  document.getElementById('btn-submit-create-moment')?.addEventListener('click', () => {
    void submitCreateMoment();
  });

  // Publish / Republish Moment Modal wiring
  document.querySelectorAll<HTMLElement>('.btn-close-publish-moment-modal').forEach(btn => {
    btn.addEventListener('click', () => closePublishMomentModal());
  });
  document.getElementById('modal-publish-moment')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'modal-publish-moment') {
      closePublishMomentModal();
    }
  });
  document.getElementById('btn-publish-toggle-all')?.addEventListener('click', () => {
    if (!publishMomentAssets.length) return;
    resetPublishInitialTopSelection();
    renderPublishMomentAssets();
  });
  document.getElementById('btn-publish-hide-unselected')?.addEventListener('click', () => {
    publishFilterCuratedOnly = !publishFilterCuratedOnly;
    renderPublishMomentAssets();
  });
  document.getElementById('btn-disjoint-hide-unselected')?.addEventListener('click', () => {
    disjointFilterCuratedOnly = !disjointFilterCuratedOnly;
    renderResolveDisjointAssets();
  });
  document.getElementById('btn-publish-apply-curation')?.addEventListener('click', () => {
    void applyPublishBatchCuration(true);
  });
  document.getElementById('btn-publish-open-folder')?.addEventListener('click', async () => {
    if (!publishMomentName) return;
    if (isPublishCurationDirty()) {
      const ok = await applyPublishBatchCuration(false);
      if (!ok) return;
    }
    void openCuratedFolderForPublish(publishMomentName, 'pub_rec');
  });
  document.getElementById('btn-publish-open-curated')?.addEventListener('click', () => {
    if (!publishMomentName) return;
    void openCuratedFolderForPublish(publishMomentName, 'curated');
  });
  document.getElementById('btn-open-all-pub-rec-folder')?.addEventListener('click', () => {
    void openCuratedFolderForPublish('', 'pub_rec');
  });
  document.getElementById('btn-sync-all-pub-rec-folder')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const prev = btn.textContent || '🔄 Sync Pub. Rec Folder';
    btn.disabled = true;
    btn.textContent = '🔄 Syncing...';
    try {
      const res = await fetch('/api/media/memories/sync-publishing-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Sync failed: ${data.error || 'Unknown error'}`);
        return;
      }
      btn.textContent = `✅ Synced ${data.active_folders ?? 0} folders (+${data.copied ?? 0})`;
      window.setTimeout(() => {
        btn.textContent = prev;
      }, 3200);
    } catch (err: any) {
      alert(`Error syncing Publishing Recommendation folder: ${err?.message || 'Unknown error'}`);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('btn-publish-export-curated')?.addEventListener('click', () => {
    if (!publishMomentName) return;
    void window.triggerTask('media_export_curated', [publishMomentName] as any, true, null, () => {
      void openPublishMomentModal(publishMomentName);
    });
  });
  document.getElementById('publish-moment-sf-url')?.addEventListener('input', () => syncPublishOpenLinks());
  document.getElementById('publish-moment-yt-url')?.addEventListener('input', () => syncPublishOpenLinks());
  document.getElementById('btn-submit-publish-moment')?.addEventListener('click', () => {
    void submitPublishMoment();
  });

  // Resolve Disjoint Moment Modal wiring
  document.querySelectorAll<HTMLElement>('.btn-close-resolve-disjoint-modal').forEach(btn => {
    btn.addEventListener('click', () => closeResolveDisjointModal());
  });
  document.getElementById('modal-resolve-disjoint')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'modal-resolve-disjoint') {
      closeResolveDisjointModal();
    }
  });
  document.getElementById('resolve-disjoint-target-input')?.addEventListener('input', (e) => {
    const curVal = ((e.target as HTMLInputElement)?.value || '').trim();
    targetNameManuallyEdited = curVal !== '' && curVal !== lastAutoSyncedTargetName;
    updateResolveDisjointTargetPreview();
    updateSingleAssetWarningVisibility();
  });
  document.getElementById('resolve-disjoint-parent-select')?.addEventListener('change', () => {
    updateResolveDisjointTargetPreview();
  });
  document.getElementById('resolve-disjoint-save-per-source-tags')?.addEventListener('change', () => {
    renderPropagateTagsPreview();
  });
  document.getElementById('resolve-disjoint-share-disjoint-tags')?.addEventListener('change', () => {
    renderPropagateTagsPreview();
  });
  document.getElementById('btn-submit-resolve-disjoint')?.addEventListener('click', () => {
    if (resolveDisjointCompleted) {
      closeResolveDisjointModal();
      return;
    }
    openResolveActionConfirmDialog(resolveDisjointIsCurateM200 ? 'curate' : 'merge_new');
  });
  document.getElementById('resolve-disjoint-manual-curate-toggle')?.addEventListener('change', (e) => {
    const chk = e.target as HTMLInputElement | null;
    resolveDisjointIsCurateM200 = Boolean(chk?.checked);
    const curateBoxEl = document.getElementById('resolve-disjoint-curate-box');
    if (curateBoxEl) curateBoxEl.style.display = resolveDisjointIsCurateM200 ? 'flex' : 'none';
    updateResolveDisjointSelectionSummary();
    updateResolveDisjointTargetPreview();
  });
  document.getElementById('btn-disjoint-select-expected')?.addEventListener('click', () => {
    selectTopExpectedKeepersInDialog();
  });
  document.getElementById('btn-disjoint-select-qualified')?.addEventListener('click', () => {
    selectAllQualifiedKeepersInDialog();
  });
  document.getElementById('curate-m200-export-lacie')?.addEventListener('change', () => {
    if (resolveDisjointIsCurateM200) updateResolveDisjointTargetPreview();
  });
  document.getElementById('curate-m200-handle-unselected')?.addEventListener('change', () => {
    if (resolveDisjointIsCurateM200) updateResolveDisjointSelectionSummary();
  });
  document.getElementById('btn-resolve-disjoint-legacy-merge')?.addEventListener('click', () => {
    openResolveActionConfirmDialog('merge_legacy');
  });
  document.getElementById('btn-resolve-disjoint-skip')?.addEventListener('click', () => {
    openResolveActionConfirmDialog('skip_publishing');
  });
  document.getElementById('btn-resolve-disjoint-ignore')?.addEventListener('click', () => {
    openResolveActionConfirmDialog('ignore');
  });
  document.querySelectorAll<HTMLElement>('.btn-close-resolve-confirm-modal').forEach(btn => {
    btn.addEventListener('click', () => closeResolveActionConfirmDialog());
  });
  document.getElementById('modal-resolve-action-confirm')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'modal-resolve-action-confirm') {
      closeResolveActionConfirmDialog();
    }
  });
  document.getElementById('btn-resolve-confirm-proceed')?.addEventListener('click', () => {
    const act = pendingResolveConfirmAction;
    closeResolveActionConfirmDialog();
    if (act) {
      void submitResolveDisjoint(act);
    }
  });
  document.getElementById('resolve-disjoint-moment-search')?.addEventListener('input', (e) => {
    const q = ((e.target as HTMLInputElement)?.value || '').trim();
    if (momentSearchTimer !== null) window.clearTimeout(momentSearchTimer);
    momentSearchTimer = window.setTimeout(() => {
      void searchMomentsForConsolidationUI(q);
    }, 200);
  });
  document.getElementById('btn-close-candidate-preview-panel')?.addEventListener('click', () => {
    previewedCandidateMomentName = '';
    const panel = document.getElementById('resolve-disjoint-candidate-preview-panel');
    if (panel) panel.style.display = 'none';
    renderCandidateMomentChips(displayedCandidateMomentsList);
  });

  document.querySelectorAll<HTMLButtonElement>('.disjoint-tf-window-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('.disjoint-tf-window-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      disjointTimeframeWindowDays = Number(btn.dataset.tfDays || '1');
      void fetchDisjointTimeframeDevices();
    });
  });

  document.getElementById('btn-disjoint-device-qual-toggle')?.addEventListener('click', () => {
    disjointTimeframeQualOnly = !disjointTimeframeQualOnly;
    renderDisjointTimeframeDevicesUI();
  });

  document.getElementById('btn-close-disjoint-device-panel')?.addEventListener('click', () => {
    disjointTimeframeActiveDeviceKey = null;
    renderDisjointTimeframeDevicesUI();
  });

  document.getElementById('btn-disjoint-device-add-checked')?.addEventListener('click', () => {
    addCheckedTimeframeDeviceAssetsToConsolidation();
  });
  document.getElementById('btn-candidate-add-combine')?.addEventListener('click', () => {
    addPreviewedCandidateToCombined();
  });
  document.getElementById('btn-candidate-use-legacy-target')?.addEventListener('click', () => {
    if (!previewedCandidateMomentName) return;
    applyTargetMomentName(previewedCandidateMomentName, true);
  });

  // Grouping Rules Panel toggle & reset
  const btnToggleRulesPanel = document.getElementById('btn-toggle-grouping-rules-panel');
  if (btnToggleRulesPanel) {
    btnToggleRulesPanel.addEventListener('click', () => {
      groupingRulesPanelCollapsed = !groupingRulesPanelCollapsed;
      document.getElementById('mode-m-rules-body')?.classList.toggle('collapsed', groupingRulesPanelCollapsed);
      btnToggleRulesPanel.textContent = groupingRulesPanelCollapsed ? '▾ Show Rules' : '▴ Hide Rules';
    });
  }
  document.getElementById('btn-reset-grouping-rules')?.addEventListener('click', () => {
    void updateGroupingRules({ reset_defaults: true });
  });

  let msDialogMonth = '';
  let msDialogSourceStep: 'step2' | 'step3' = 'step3';
  let msDialogQueueBlocked = false;
  let msDialogActionPending = false;

  const setMsDialogOpen = (open: boolean) => {
    const modal = document.getElementById('modal-month-selection-detail');
    if (modal) modal.classList.toggle('open', open);
  };

  const renderMsDialogBody = (data: AppleMonthSelectionDetailResponse) => {
    const ms = data.month_selection;
    const badgeEl = document.getElementById('ms-detail-status-badge');
    const bannerEl = document.getElementById('ms-detail-banner');
    const metaEl = document.getElementById('ms-detail-meta');
    const liveEl = document.getElementById('ms-detail-live-box');
    const assetsHeadEl = document.getElementById('ms-detail-assets-heading');
    const syncNoteEl = document.getElementById('ms-detail-sync-note');
    const assetsListEl = document.getElementById('ms-detail-assets-list');
    const btnClose = document.getElementById('btn-ms-detail-close');
    const btnCreateEmpty = document.getElementById('btn-ms-detail-create-empty') as HTMLButtonElement | null;
    const btnQueueReady = document.getElementById('btn-ms-detail-queue-ready');
    const btnOverride = document.getElementById('btn-ms-detail-override');

    if (badgeEl) {
      badgeEl.className = `badge badge-xs font-mono ${ms.ready ? 'badge-green' : ms.exists ? 'badge-amber' : 'badge-red'
        }`;
      const albLabel = ms.matched_album_name || ms.expected_album;
      badgeEl.textContent = ms.ready
        ? `✓ Ready (${ms.asset_count})`
        : ms.exists
          ? `⚠️ ${albLabel} Folder is empty`
          : `⚠️ Missing Album`;
    }

    if (bannerEl) {
      if (!ms.ready) {
        bannerEl.style.display = 'block';
        const isStep3Block = msDialogSourceStep === 'step3' || msDialogQueueBlocked || data.status_code === '500' || data.status_code === '550';
        bannerEl.style.borderColor = isStep3Block ? 'rgba(239, 68, 68, 0.45)' : 'rgba(245, 158, 11, 0.45)';
        bannerEl.style.background = isStep3Block ? 'rgba(239, 68, 68, 0.1)' : 'rgba(245, 158, 11, 0.1)';
        bannerEl.style.color = isStep3Block ? '#fecaca' : '#fde68a';
        const problemText = ms.exists
          ? `Album <code>${escapeHtml(ms.matched_album_name || ms.expected_album)}</code> exists under <code>Apple Photos Month Selection</code>, but currently has <strong>0 assets</strong>.`
          : `Album <code>${escapeHtml(ms.expected_album)}</code> was <strong>not found</strong> under <code>Media Organizer on LaCie / Apple Photos Month Selection</code>.`;
        bannerEl.innerHTML = `
          <div><strong>${msDialogQueueBlocked ? '🚫 Step 3 Queue Blocked' : '⚠️ Apple Photos Month Selection Incomplete'}:</strong> ${problemText}</div>
          <div style="margin-top: 0.35rem; opacity: 0.92;">
            Why Step 3 blocks: assets in <strong>Apple Photos Month Selection</strong> receive the <code>+0.15</code> ranking boost before Google Favorites pull &amp; AI ranking (Stage 600). Creating and populating <code>${escapeHtml(ms.expected_album)}</code> in Apple Photos is a one-step action that unlocks this batch and prevents unexpected lower-tier photos from surfacing later.
          </div>
        `;
      } else {
        bannerEl.style.display = 'block';
        bannerEl.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        bannerEl.style.background = 'rgba(16, 185, 129, 0.09)';
        bannerEl.style.color = '#a7f3d0';
        bannerEl.innerHTML = `✅ <strong>Unlocked &amp; Ready:</strong> Album <code>${escapeHtml(
          ms.matched_album_name || ms.expected_album
        )}</code> exists with <strong>${ms.asset_count}</strong> asset(s) synced.`;
      }
    }

    if (metaEl) {
      metaEl.innerHTML = `
        <div><span class="text-muted">Batch / Stage:</span> <strong class="font-mono">${escapeHtml(data.month)}</strong> · <span class="badge badge-xs badge-outline font-mono">${escapeHtml(data.status_code)}</span></div>
        <div><span class="text-muted">Batch Assets:</span> <strong class="font-mono">${(data.batch_assets_count || 0).toLocaleString()}</strong> (flagged: <strong class="font-mono">${ms.batch_selected_count || 0}</strong>)</div>
        <div style="grid-column: 1 / -1;"><span class="text-muted">Expected Path:</span> <code style="word-break: break-word;">${escapeHtml(data.expected_path)}</code></div>
      `;
    }

    if (liveEl) {
      if (data.live_photos_app && data.live_photos_app.checked) {
        liveEl.style.display = 'block';
        if (data.live_photos_app.error) {
          liveEl.style.borderColor = 'rgba(245, 158, 11, 0.4)';
          liveEl.style.background = 'rgba(245, 158, 11, 0.1)';
          liveEl.style.color = '#fde68a';
          liveEl.innerHTML = `⚠️ <strong>Live Apple Photos Check:</strong> ${escapeHtml(data.live_photos_app.error)}`;
        } else if (data.live_photos_app.exists && data.live_photos_app.count > 0) {
          liveEl.style.borderColor = 'rgba(16, 185, 129, 0.4)';
          liveEl.style.background = 'rgba(16, 185, 129, 0.1)';
          liveEl.style.color = '#a7f3d0';
          liveEl.innerHTML = ms.ready
            ? `📸 <strong>Live Photos.app Check:</strong> Found <code>${escapeHtml(data.live_photos_app.matched_name || ms.expected_album)}</code> (${data.live_photos_app.count} item(s)) — matches synced DB.`
            : `📸 <strong>Live Photos.app Check:</strong> Found <code>${escapeHtml(data.live_photos_app.matched_name || ms.expected_album)}</code> (${data.live_photos_app.count} item(s)) in Apple Photos! Wait for <strong>Background DB Copy &amp; Sync</strong> to refresh <code>media_organizer.db</code>, then click Re-check.`;
        } else if (data.live_photos_app.exists) {
          liveEl.style.borderColor = 'rgba(245, 158, 11, 0.4)';
          liveEl.style.background = 'rgba(245, 158, 11, 0.1)';
          liveEl.style.color = '#fde68a';
          liveEl.innerHTML = `📸 <strong>Live Photos.app Check:</strong> Album <code>${escapeHtml(data.live_photos_app.matched_name || ms.expected_album)}</code> exists in Photos.app with <strong>0 items</strong>.`;
        } else {
          liveEl.style.borderColor = 'rgba(239, 68, 68, 0.4)';
          liveEl.style.background = 'rgba(239, 68, 68, 0.08)';
          liveEl.style.color = '#fecaca';
          liveEl.innerHTML = `📸 <strong>Live Photos.app Check:</strong> Album <code>${escapeHtml(ms.expected_album)}</code> is still missing in Photos.app.`;
        }
      } else {
        liveEl.style.display = 'none';
      }
    }

    if (assetsHeadEl) {
      assetsHeadEl.textContent = `Album Assets (${data.assets.length})`;
    }
    if (syncNoteEl) {
      syncNoteEl.textContent = data.db_synced_at_utc ? `DB album sync: ${data.db_synced_at_utc} UTC` : '';
    }
    if (assetsListEl) {
      if (!data.assets.length) {
        assetsListEl.innerHTML = `<div class="text-muted font-mono" style="grid-column: 1 / -1; font-size: 0.72rem; padding: 0.4rem 0;">No synced assets recorded in this Month Selection album yet.</div>`;
      } else {
        assetsListEl.innerHTML = data.assets
          .map(a => {
            const thumb = `/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}`;
            return `
            <div style="display: flex; align-items: center; gap: 0.45rem; padding: 0.32rem; border-radius: 6px; background: rgba(255,255,255,0.03); border: 1px solid rgba(148,163,184,0.14);">
              <img src="${thumb}" alt="" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; flex-shrink: 0; background: #0f172a;" loading="lazy" />
              <div style="min-width: 0; flex: 1;">
                <div class="font-mono" style="font-size: 0.68rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(a.original_filename)}">${escapeHtml(a.original_filename)}</div>
                <div class="font-mono text-muted" style="font-size: 0.63rem;">${escapeHtml((a.date_created_utc || '').slice(0, 10))} · ★ ${a.score_normalized.toFixed(3)}</div>
              </div>
            </div>`;
          })
          .join('');
      }
    }

    const isStage500 = data.status_code === '500' || data.status_code === '550' || msDialogSourceStep === 'step3';
    if (btnClose) {
      btnClose.textContent = !ms.ready && isStage500 && msDialogQueueBlocked ? 'Close (Keep Blocked)' : 'Close';
    }
    if (btnCreateEmpty) {
      btnCreateEmpty.style.display = !ms.exists ? 'inline-flex' : 'none';
      btnCreateEmpty.dataset.expectedAlbum = ms.expected_album || data.month;
      btnCreateEmpty.textContent = `📁 Create Empty "${ms.expected_album || data.month}" Folder`;
    }
    if (btnQueueReady) {
      btnQueueReady.style.display = ms.ready && isStage500 && !data.in_queue ? 'inline-flex' : 'none';
    }
    if (btnOverride) {
      btnOverride.style.display = !ms.ready && isStage500 && !data.in_queue ? 'inline-flex' : 'none';
    }
  };

  const loadMonthSelectionDialogData = async (month: string, live = false) => {
    const titleEl = document.getElementById('ms-detail-title');
    const badgeEl = document.getElementById('ms-detail-status-badge');
    const statusEl = document.getElementById('ms-detail-action-status');
    const metaEl = document.getElementById('ms-detail-meta');
    const assetsListEl = document.getElementById('ms-detail-assets-list');
    if (titleEl) titleEl.textContent = `📅 Apple Photos Month Selection · ${month}`;
    if (badgeEl) {
      badgeEl.className = 'badge badge-xs badge-outline font-mono';
      badgeEl.textContent = live ? 'Checking Photos.app...' : 'Loading...';
    }
    if (statusEl) {
      statusEl.style.display = 'none';
      statusEl.innerHTML = '';
    }
    if (!live && metaEl) metaEl.innerHTML = '<div class="text-muted font-mono">Checking database...</div>';
    if (!live && assetsListEl) assetsListEl.innerHTML = '';

    try {
      const qs = new URLSearchParams({ month, live: live ? 'true' : 'false' });
      const res = await fetch(`/api/media/planner/month-selection-detail?${qs.toString()}`);
      const data: AppleMonthSelectionDetailResponse = await res.json();
      if (!data.ok) {
        if (statusEl) {
          statusEl.style.display = 'block';
          statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || 'Failed to inspect Month Selection album')}</span>`;
        }
        return;
      }
      renderMsDialogBody(data);
      if (live) {
        await fetchPlannerOverview(true, 'b');
      }
    } catch (err: any) {
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
      }
    }
  };

  window.openMonthSelectionDialog = async function (
    month: string,
    opts?: { sourceStep?: 'step2' | 'step3'; queueBlocked?: boolean }
  ): Promise<void> {
    msDialogMonth = month;
    msDialogSourceStep = opts?.sourceStep || 'step3';
    msDialogQueueBlocked = Boolean(opts?.queueBlocked);
    setMsDialogOpen(true);
    await loadMonthSelectionDialogData(month, false);
  };

  window.createEmptyMonthSelectionFolder = async function (
    month: string,
    expectedAlbum?: string
  ): Promise<void> {
    if (msDialogActionPending) return;
    msDialogActionPending = true;
    const label = expectedAlbum || month;
    setMsDialogOpen(false);
    beginApplePhotosSyncLock(
      `🍎 Creating empty "${label}" folder in Apple Photos Month Selection — UI paused until sync…`
    );
    try {
      const res = await fetch('/api/media/planner/month-selection/create-empty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month })
      });
      const data = await res.json();
      if (!data.ok) {
        cancelApplePhotosSyncLock();
        alert(`Failed to create Apple Photos folder: ${data.error || 'Unknown error'}`);
        return;
      }
      finishApplePhotosActionSyncLock(
        `✅ ${data.message || `Created '${label}' in Apple Photos`}. Waiting for Background DB Sync to refresh and reload UI…`
      );
      await fetchPlannerOverview(true, 'b');
    } catch (err: any) {
      cancelApplePhotosSyncLock();
      alert(`Network error creating folder: ${err?.message || 'Unknown error'}`);
    } finally {
      msDialogActionPending = false;
    }
  };

  document.getElementById('btn-ms-detail-create-empty')?.addEventListener('click', async e => {
    if (!msDialogMonth) return;
    const btn = e.currentTarget as HTMLButtonElement;
    await window.createEmptyMonthSelectionFolder(msDialogMonth, btn.dataset.expectedAlbum);
  });

  document.querySelectorAll('.btn-close-ms-detail-modal').forEach(btn => {
    btn.addEventListener('click', () => setMsDialogOpen(false));
  });
  document.getElementById('btn-ms-detail-recheck')?.addEventListener('click', async () => {
    if (!msDialogMonth || msDialogActionPending) return;
    msDialogActionPending = true;
    try {
      await loadMonthSelectionDialogData(msDialogMonth, true);
    } finally {
      msDialogActionPending = false;
    }
  });
  document.getElementById('btn-ms-detail-queue-ready')?.addEventListener('click', async () => {
    if (!msDialogMonth || msDialogActionPending) return;
    msDialogActionPending = true;
    try {
      await window.runPlannerBatchAction(msDialogMonth, 'queue', false);
      setMsDialogOpen(false);
    } finally {
      msDialogActionPending = false;
    }
  });
  document.getElementById('btn-ms-detail-override')?.addEventListener('click', async () => {
    if (!msDialogMonth || msDialogActionPending) return;
    const statusEl = document.getElementById('ms-detail-action-status');
    msDialogActionPending = true;
    try {
      await window.runPlannerBatchAction(msDialogMonth, 'queue', true);
      setMsDialogOpen(false);
    } catch (err: any) {
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(err?.message || 'Failed to override')}</span>`;
      }
    } finally {
      msDialogActionPending = false;
    }
  });

  window.runPlannerBatchAction = async function (
    month: string,
    action: string,
    confirmMissingMonthSelection = false
  ): Promise<void> {
    try {
      const res = await fetch('/api/media/planner/batch-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month,
          action,
          confirm_missing_month_selection: confirmMissingMonthSelection
        })
      });
      const data = await res.json();
      if (!data.ok && data.requires_confirmation && !confirmMissingMonthSelection) {
        await window.openMonthSelectionDialog(month, {
          sourceStep: 'step3',
          queueBlocked: true
        });
        return;
      }
      if (!data.ok) {
        alert(`Action failed: ${data.error || 'Unknown error'}`);
        return;
      }
      await fetchPlannerOverview(true, 'b');
      if (onRefreshExecutor) onRefreshExecutor();
    } catch (err: any) {
      console.error('Error running planner batch action:', err);
      alert(`Network error: ${err.message || 'Unknown error'}`);
    }
  };

  document.getElementById('btn-mode-b-return-all-400')?.addEventListener('click', async e => {
    const btn = e.currentTarget as HTMLButtonElement;
    const months = (btn.dataset.months || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (!months.length) return;
    if (
      !window.confirm(
        `Return all ${months.length} Step 3 batch(es) (${months.join(', ')}) back to Step 2 (status 400 · Google curation incomplete) and remove from active queue if queued?`
      )
    ) {
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch('/api/media/planner/batch-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: months[0], months, action: 'demote_400' })
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Action failed: ${data.error || 'Unknown error'}`);
        return;
      }
      await fetchPlannerOverview(true, 'b');
      if (onRefreshExecutor) onRefreshExecutor();
    } catch (err: any) {
      alert(`Network error: ${err.message || 'Unknown error'}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Load initial Mode [B] Batch Management overview only when starting on [B]
  if (activePlannerModeView === 'b' && !modeBLoaded) {
    void fetchPlannerOverview(false, 'b');
  }
}

const queuedPlannerFetchByMode: Partial<Record<PlannerModeTarget, Promise<void>>> = {};

export async function fetchPlannerOverview(force = false, targetMode?: PlannerModeTarget): Promise<void> {
  if (!targetMode && (activePlannerModeView === 'c' || activePlannerModeView === 'g')) {
    if (force) {
      modeBLoaded = false;
      modeMLoaded = false;
      foldersLoaded = false;
      if (activePlannerModeView === 'g') {
        await fetchAllUnifiedGroupings(true);
      } else {
        allGroupingsLoaded = false;
      }
    }
    return;
  }
  const mode: PlannerModeTarget = targetMode || (activePlannerModeView === 'm' ? 'm' : 'b');
  if (force) {
    if (mode === 'b') {
      modeMLoaded = false;
      foldersLoaded = false;
    } else if (mode === 'm') {
      modeBLoaded = false;
    }
  }

  const inFlight = activePlannerFetchByMode[mode];
  if (inFlight) {
    if (!force) {
      return inFlight;
    }
    pendingPlannerRefreshByMode[mode] = true;
    if (!queuedPlannerFetchByMode[mode]) {
      queuedPlannerFetchByMode[mode] = inFlight
        .catch(() => { })
        .then(() => {
          delete queuedPlannerFetchByMode[mode];
          pendingPlannerRefreshByMode[mode] = false;
          return fetchPlannerOverview(true, mode);
        });
    }
    return queuedPlannerFetchByMode[mode];
  }

  const runPromise = (async () => {
    try {
      const bust = force ? `&_t=${Date.now()}` : '';
      const res = await fetch(`/api/media/planner-overview?mode=${encodeURIComponent(mode)}${bust}`, {
        cache: 'no-store'
      });
      const data: PlannerOverviewResponse = await res.json();

      if (!data.connected) return;
      plannerOverviewData = {
        connected: data.connected,
        mode: data.mode || mode,
        mode_b: data.mode_b ?? plannerOverviewData?.mode_b ?? null,
        mode_m: data.mode_m ?? plannerOverviewData?.mode_m ?? null,
      };

      const nowStr = new Date().toLocaleTimeString();
      const updatedEl = document.getElementById('planner-overview-updated');
      if (updatedEl) {
        updatedEl.textContent = `Updated: ${nowStr}`;
      }
      if (data.mode_m) {
        clustersLastUpdatedTime = nowStr;
        renderClustersSyncUI();
      }

      if (data.mode_b) {
        modeBLoaded = true;
        renderModeBOverview(data.mode_b as PlannerModeB);
      }
      if (data.mode_m) {
        modeMLoaded = true;
        renderModeMOverview(data.mode_m as PlannerModeM);
      }
    } catch (err) {
      console.error(`Error fetching planner overview (${mode}):`, err);
    } finally {
      delete activePlannerFetchByMode[mode];
      if (pendingPlannerRefreshByMode[mode] && !queuedPlannerFetchByMode[mode]) {
        pendingPlannerRefreshByMode[mode] = false;
        void fetchPlannerOverview(false, mode);
      }
    }
  })();

  activePlannerFetchByMode[mode] = runPromise;
  return runPromise;
}

interface PlannerPathFocusItem {
  containerId: string;
  itemName: string;
  isCluster?: boolean;
}

interface PlannerPathCard {
  num: string;
  numTone: 'blue' | 'amber' | 'purple' | 'green';
  title: string;
  badgeText: string;
  badgeClass: string;
  badgeTitle?: string;
  description: string;
  footerMeta: string;
  targetId: string;
  linkLabel: string;
  active: boolean;
  focusItem?: PlannerPathFocusItem;
}

const MODE_M_COLLAPSIBLE_STEPS: Record<string, { bodyId: string; btnId: string }> = {
  'mode-m-step-1': { bodyId: 'mode-m-step-1-body', btnId: 'btn-toggle-mode-m-step-1' },
  'mode-m-step-2': { bodyId: 'mode-m-step-2-body', btnId: 'btn-toggle-mode-m-step-2' }
};

function ensureModeMStepExpanded(stepId: string): void {
  const cfg = MODE_M_COLLAPSIBLE_STEPS[stepId];
  if (!cfg) return;
  const bodyEl = document.getElementById(cfg.bodyId);
  const toggleBtn = document.getElementById(cfg.btnId);
  if (bodyEl?.classList.contains('collapsed')) {
    bodyEl.classList.remove('collapsed');
    if (toggleBtn) {
      toggleBtn.textContent = '▴ Collapse';
      toggleBtn.setAttribute('aria-expanded', 'true');
    }
  }
}

function jumpToPlannerStep(targetId: string): void {
  const el = document.getElementById(targetId);
  if (!el) return;
  ensureModeMStepExpanded(targetId);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('subblock-highlight');
  window.setTimeout(() => el.classList.remove('subblock-highlight'), 2000);
}

function focusPlannerPathItem(focus: PlannerPathFocusItem | undefined, fallbackTargetId: string): void {
  ensureModeMStepExpanded(fallbackTargetId);
  if (focus?.isCluster && focus.itemName) {
    jumpToUnassignedCluster(focus.itemName);
    return;
  }
  if (focus?.containerId && focus.itemName) {
    const container = document.getElementById(focus.containerId);
    if (container) {
      const targetName = focus.itemName.trim().toLowerCase();
      const children = Array.from(container.querySelectorAll<HTMLElement>('[data-moment-name]'));
      const matched = children.find(el => (el.dataset.momentName || '').trim().toLowerCase() === targetName);
      if (matched) {
        matched.scrollIntoView({ behavior: 'smooth', block: 'center' });
        matched.classList.add('planner-item-highlight');
        window.setTimeout(() => matched.classList.remove('planner-item-highlight'), 2200);
        return;
      }
    }
  }
  jumpToPlannerStep(fallbackTargetId);
}

function renderPlannerPathsSummary(containerId: string, paths: PlannerPathCard[]): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = paths
    .map((p, idx) => {
      const toneClass = `num-${p.numTone}`;
      const stateClass = p.active ? 'path-active' : 'path-muted';
      const titleAttr = p.badgeTitle ? ` title="${escapeHtml(p.badgeTitle)}"` : '';
      const badgeEl = p.focusItem
        ? `<button type="button" class="badge badge-xs ${p.badgeClass} font-mono planner-path-badge-link" data-path-focus-idx="${idx}"${titleAttr}>${escapeHtml(p.badgeText)}</button>`
        : `<span class="badge badge-xs ${p.badgeClass} font-mono"${titleAttr}>${escapeHtml(p.badgeText)}</span>`;
      return `
        <div class="planner-path-card ${stateClass}">
          <div>
            <div class="planner-path-card-head">
              <div class="planner-path-card-title-row">
                <span class="planner-path-num ${toneClass}">${escapeHtml(p.num)}</span>
                <span class="planner-path-title">${escapeHtml(p.title)}</span>
              </div>
              ${badgeEl}
            </div>
            <p class="planner-path-desc" style="margin-top: 0.4rem;">${escapeHtml(p.description)}</p>
          </div>
          <div class="planner-path-footer">
            <span class="font-mono text-muted" style="font-size: 0.67rem;">${escapeHtml(p.footerMeta)}</span>
            <a href="#${escapeHtml(p.targetId)}" class="planner-path-jump-link" data-jump-step="${escapeHtml(p.targetId)}" data-path-focus-idx="${idx}">${escapeHtml(p.linkLabel)}</a>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll<HTMLElement>('[data-path-focus-idx]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = Number(el.dataset.pathFocusIdx ?? -1);
      const card = paths[idx];
      if (!card) return;
      focusPlannerPathItem(card.focusItem, card.targetId);
    });
  });
}

function renderModeBOverview(modeB: Partial<PlannerModeB>): void {
  const sb = modeB.status_breakdown || {};
  const qList = modeB.active_queue || [];
  const c400 = modeB.manual_400_candidates || [];
  const c500 = modeB.pipeline_500_candidates || [];
  const c000 = modeB.pipeline_000_candidates || [];
  const primary = modeB.primary_suggestion || null;

  const qPill = document.getElementById('mode-b-queue-pill');
  const compPill = document.getElementById('mode-b-completed-pill');
  if (qPill) {
    qPill.textContent =
      qList.length > 0 ? `${qList.length} Queued (${qList.map(q => q.month).join(', ')})` : '0 Queued';
  }
  const cnt650 = sb['650']?.count || 0;
  const assets650 = sb['650']?.assets || 0;
  if (compPill) {
    compPill.textContent = `${cnt650} Finalized (${assets650.toLocaleString()} assets)`;
  }

  const cnt000 = sb['000']?.count || 0;
  const assets000 = sb['000']?.assets || 0;
  const cnt400 = sb['400']?.count || 0;
  const assets400 = sb['400']?.assets || 0;
  const cnt500 = (sb['500']?.count || 0) + (sb['550']?.count || 0);
  const assets500 = (sb['500']?.assets || 0) + (sb['550']?.assets || 0);

  const el000 = document.getElementById('mode-b-cnt-000');
  const el400 = document.getElementById('mode-b-cnt-400');
  const el500 = document.getElementById('mode-b-cnt-500');
  const el650 = document.getElementById('mode-b-cnt-650');

  if (el000) el000.textContent = `${cnt000} batches (${assets000.toLocaleString()})`;
  if (el400) el400.textContent = `${cnt400} batches (${assets400.toLocaleString()})`;
  if (el500) el500.textContent = `${cnt500} batches (${assets500.toLocaleString()})`;
  if (el650) el650.textContent = `${cnt650} batches (${assets650.toLocaleString()})`;

  const headlineEl = document.getElementById('mode-b-primary-headline');
  const detailEl = document.getElementById('mode-b-primary-detail');
  const secEl = document.getElementById('mode-b-primary-secondary');

  const total000Batches = modeB.total_000_batches || cnt000;
  const unlockInfo = modeB.month_ingestion_unlock || null;
  const isIntakeUnlocked = Boolean(unlockInfo?.unlocked && unlockInfo.pending_months?.length);
  const pendingIntakeMonths = unlockInfo?.pending_months || [];
  if (headlineEl) {
    const unlockPrefix = isIntakeUnlocked
      ? `${pendingIntakeMonths.length} unlocked for 050 Intake (${pendingIntakeMonths.join(', ')}) · `
      : '';
    headlineEl.textContent = `Summary: ${unlockPrefix}${c400.length} at 400 (Path 2 Confirm) · ${c500.length} in 500/550 (Path 3 Schedule) · ${total000Batches} unprocessed in 000 (Path 1 Upload)`;
  }
  if (primary) {
    if (detailEl) detailEl.textContent = `👉 Recommended Next Step: ${primary.headline} — ${primary.detail}`;
    if (secEl) secEl.textContent = primary.secondary || '';
  } else {
    if (detailEl) detailEl.textContent = 'No pending manual or pipeline transitions detected across Paths 1–3.';
    if (secEl) secEl.textContent = '';
  }

  const c400MonthsPreview = c400.slice(0, 3).map(x => x.month).join(', ') + (c400.length > 3 ? '…' : '');
  const c500MonthsPreview = c500.slice(0, 3).map(x => x.month).join(', ') + (c500.length > 3 ? '…' : '');
  const modeBPathCards: PlannerPathCard[] = [];
  if (isIntakeUnlocked && unlockInfo) {
    const devPreview = unlockInfo.active_devices?.length
      ? ` Active sources: ${unlockInfo.active_devices.join(', ')}.`
      : '';
    modeBPathCards.push({
      num: '0',
      numTone: 'green',
      title: 'Ingest Completed Month (050 Intake)',
      badgeText: `🔓 ${unlockInfo.target_month} Unlocked`,
      badgeClass: 'badge-green',
      description: `Completed month ${pendingIntakeMonths.join(', ')} has not been ingested yet.${devPreview}`,
      footerMeta: 'New month unlocked for ingestion',
      targetId: 'mode-b-step-0',
      linkLabel: `Go to 0️⃣ Ingest ${unlockInfo.target_month} ↓`,
      active: true
    });
  }
  modeBPathCards.push(
    {
      num: '1',
      numTone: 'blue',
      title: 'Ingest & Google Upload (000 ➜ 399)',
      badgeText: `${total000Batches} batch${total000Batches === 1 ? '' : 'es'}`,
      badgeClass: total000Batches > 0 ? 'badge-blue' : 'badge-outline',
      description: `Schedule an unprocessed batch${c000[0] ? ` (top: ${c000[0].month}, ${c000[0].total_assets.toLocaleString()} assets)` : ''} to verify DB, export originals, dedupe, and upload to Google Photos.`,
      footerMeta: qList.length > 0 ? `${qList.length} currently queued` : total000Batches > 0 ? 'Ready to queue' : 'All uploaded',
      targetId: 'mode-b-step-1',
      linkLabel: 'Go to 1️⃣ Ingest & Upload ↓',
      active: total000Batches > 0
    },
    {
      num: '2',
      numTone: 'amber',
      title: 'Confirm Google AI–Rated Batches (400 ➜ 500)',
      badgeText: `${c400.length} at 400`,
      badgeClass: c400.length > 0 ? 'badge-amber' : 'badge-outline',
      description: `Confirm batches rated by Google AI${c400MonthsPreview ? ` (${c400MonthsPreview})` : ''} after confirming Best-of lists are generated and Favorites are manually added (Confirm 500).`,
      footerMeta: c400.length > 0 ? 'Awaiting confirmation / bypass' : 'None in 400',
      targetId: 'mode-b-step-2',
      linkLabel: 'Go to 2️⃣ Confirm 400➜500 ↓',
      active: c400.length > 0
    },
    {
      num: '3',
      numTone: 'purple',
      title: 'Schedule Favorites Pull & Ranking (500 ➜ 650)',
      badgeText: `${c500.length} in 500/550`,
      badgeClass: c500.length > 0 ? 'badge-purple' : 'badge-outline',
      description: `Schedule any batch currently in status 500/550${c500MonthsPreview ? ` (${c500MonthsPreview})` : ''} to pull Favorites (550), run AI ranking (600), and finalize cleanup (650).`,
      footerMeta: c500.length > 0 ? `${c500.filter(x => x.in_queue).length} scheduled` : '0 batches in 500/550',
      targetId: 'mode-b-step-3',
      linkLabel: 'Go to 3️⃣ Schedule 500➜650 ↓',
      active: c500.length > 0
    }
  );
  renderPlannerPathsSummary('mode-b-paths-summary', modeBPathCards);

  // 0. Step 0: Month Ingestion Unlocked (only visible when a completed calendar month has un-ingested assets)
  const step0Block = document.getElementById('mode-b-step-0');
  const b050Badge = document.getElementById('mode-b-050-badge');
  const b050Tbody = document.getElementById('mode-b-050-tbody');
  if (step0Block) {
    step0Block.style.display = isIntakeUnlocked ? 'block' : 'none';
  }
  if (isIntakeUnlocked && unlockInfo) {
    if (b050Badge) {
      b050Badge.textContent = `${pendingIntakeMonths.length} unlocked`;
    }
    if (b050Tbody) {
      const devicesLabel = unlockInfo.active_devices?.length
        ? unlockInfo.active_devices.join(', ')
        : 'All configured active sources';
      b050Tbody.innerHTML = pendingIntakeMonths
        .map(m => `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(m)}</strong></td>
            <td><span class="badge badge-xs badge-green font-mono">🔓 Unlocked</span></td>
            <td style="font-size: 0.72rem;">${escapeHtml(devicesLabel)}</td>
            <td style="font-size: 0.72rem;">Completed calendar month has not been ingested yet — run 050 Managed Intake to import assets.</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="btn btn-xs btn-green" onclick="window.openManagedIntakeModal('${escapeHtml(m)}')" title="Open Managed Intake (050) pre-filled for ${escapeHtml(m)}">
                📥 Ingest ${escapeHtml(m)} (050)
              </button>
            </td>
          </tr>
        `)
        .join('');
    }
  }

  const renderAppleMonthSelectionCell = (
    item: PlannerBatchCandidate,
    sourceStep: 'step2' | 'step3'
  ): string => {
    const ms = item.month_selection;
    if (!ms) {
      return `<button type="button" class="badge badge-xs badge-outline font-mono" style="cursor: pointer;" onclick="window.openMonthSelectionDialog('${escapeHtml(
        item.month
      )}', { sourceStep: '${sourceStep}' })" title="Inspect Apple Photos Month Selection folder">Check</button>`;
    }
    const albLabel = ms.matched_album_name || ms.expected_album;
    const cls = ms.ready ? 'badge-green' : ms.exists ? 'badge-amber' : sourceStep === 'step3' ? 'badge-red' : 'badge-amber';
    const label = ms.ready
      ? `✓ ${albLabel} (${ms.asset_count})`
      : ms.exists
        ? `⚠️ ${albLabel} Folder is empty`
        : `⚠️ Missing (${ms.expected_album})`;
    const title = ms.ready
      ? `Click for details: Apple Photos Month Selection / ${albLabel} (${ms.asset_count} assets)`
      : ms.exists
        ? `Click for details: ${albLabel} Folder exists under Apple Photos Month Selection with 0 assets`
        : `Click for details: Missing folder '${ms.expected_album}' under Apple Photos Month Selection`;
    const mainBtn = `<button type="button" class="badge badge-xs ${cls} font-mono" style="cursor: pointer;" onclick="window.openMonthSelectionDialog('${escapeHtml(
      item.month
    )}', { sourceStep: '${sourceStep}' })" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
    if (!ms.exists) {
      const createBtn = `<button type="button" class="btn btn-xs btn-outline" onclick="window.createEmptyMonthSelectionFolder('${escapeHtml(
        item.month
      )}', '${escapeHtml(
        ms.expected_album
      )}')" title="Create empty folder '${escapeHtml(
        ms.expected_album
      )}' in Apple Photos under Media Organizer on LaCie / Apple Photos Month Selection">📁 Create Folder</button>`;
      return `<div style="display: inline-flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">${mainBtn}${createBtn}</div>`;
    }
    return mainBtn;
  };

  // 1. Manual 400 -> 500 Table
  const b400Badge = document.getElementById('mode-b-400-badge');
  const b400Tbody = document.getElementById('mode-b-400-tbody');
  if (b400Badge) b400Badge.textContent = `${c400.length} batch${c400.length === 1 ? '' : 'es'}`;

  if (b400Tbody) {
    if (!c400.length) {
      b400Tbody.innerHTML =
        '<tr><td colspan="7" class="text-center text-muted">No batches currently awaiting manual Google Photos curation (400).</td></tr>';
    } else {
      b400Tbody.innerHTML = c400
        .map(item => {
          const favBadge =
            (item.fav_assets || 0) > 0
              ? `<span class="badge badge-xs badge-green font-mono">⭐ ${item.fav_assets}</span>`
              : `<span class="text-muted font-mono">0</span>`;
          const msCell = renderAppleMonthSelectionCell(item, 'step2');
          const elapsedStr =
            item.elapsed_days !== null && item.elapsed_days !== undefined ? ` (${item.elapsed_days}d ago)` : '';
          return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-amber font-mono">400</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td style="text-align: right;">${favBadge}</td>
            <td>${msCell}</td>
            <td style="font-size: 0.72rem;">${escapeHtml(item.next_step)}${escapeHtml(elapsedStr)}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button class="btn btn-xs btn-green" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'confirm_500')" title="Confirm Google Photos curation complete (400 ➜ 500)">
                ✓ Confirm 500
              </button>
              <button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'bypass_500')" title="Bypass manual starring & proceed with AI aesthetic ranking (400 ➜ 500)">
                ⚡ Bypass
              </button>
            </td>
          </tr>
        `;
        })
        .join('');
    }
  }

  // 2. Pipeline 500 -> 550 -> 600 -> 650 Table
  const b500Badge = document.getElementById('mode-b-500-badge');
  const b500Tbody = document.getElementById('mode-b-500-tbody');
  const btnReturnAll400 = document.getElementById('btn-mode-b-return-all-400') as HTMLButtonElement | null;
  if (b500Badge) b500Badge.textContent = `${c500.length} batch${c500.length === 1 ? '' : 'es'}`;
  if (btnReturnAll400) {
    if (c500.length > 0) {
      btnReturnAll400.style.display = 'inline-flex';
      btnReturnAll400.dataset.months = c500.map(item => item.month).join(',');
      btnReturnAll400.textContent = c500.length > 1 ? `↩ Return All to 400 (${c500.length})` : '↩ Return to 400';
    } else {
      btnReturnAll400.style.display = 'none';
      btnReturnAll400.dataset.months = '';
    }
  }

  if (b500Tbody) {
    if (!c500.length) {
      b500Tbody.innerHTML =
        '<tr><td colspan="7" class="text-center text-muted">No batches at stage 500 waiting for favorites pull & ranking.</td></tr>';
    } else {
      b500Tbody.innerHTML = c500
        .map(item => {
          const favBadge =
            (item.fav_assets || 0) > 0
              ? `<span class="badge badge-xs badge-green font-mono">⭐ ${item.fav_assets}</span>`
              : item.is_bypassed
                ? `<span class="badge badge-xs badge-outline">Bypassed</span>`
                : `<span class="text-muted font-mono">0</span>`;
          const msBadge = renderAppleMonthSelectionCell(item, 'step3');
          const actionBtn = item.in_queue
            ? `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'remove_queue')" title="Remove from planned_execution queue">✓ Queued (Dequeue)</button>`
            : `<button class="btn btn-xs btn-purple" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'queue')" title="Add ${escapeHtml(item.month)} to planned_execution queue">➕ Queue (500➜650)</button>`;
          const demoteBtn = `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'demote_400')" style="border-color: rgba(245, 158, 11, 0.4); color: #fbbf24; margin-left: 0.35rem;" title="Curating incomplete at Google: dequeue if needed and move ${escapeHtml(item.month)} back to Step 2 (status 400)">↩ Back to 400</button>`;

          return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-purple font-mono">${escapeHtml(item.status_code)}</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td style="text-align: right;">${favBadge}</td>
            <td>${msBadge}</td>
            <td class="font-mono" style="font-size: 0.7rem; color: var(--text-secondary);">500 ➜ 550 (Pull Favs) ➜ 600 (Rank) ➜ 650</td>
            <td style="text-align: right; white-space: nowrap;">${actionBtn}${demoteBtn}</td>
          </tr>
        `;
        })
        .join('');
    }
  }

  // 3. Pipeline 000 -> 100 -> 200 -> 210 -> 399 Table
  const b000Badge = document.getElementById('mode-b-000-badge');
  const b000Tbody = document.getElementById('mode-b-000-tbody');
  if (b000Badge) {
    b000Badge.textContent = `Top ${c000.length} of ${modeB.total_000_batches || 0} batches`;
  }

  if (b000Tbody) {
    if (!c000.length) {
      b000Tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No unprocessed 000 batches remaining.</td></tr>';
    } else {
      b000Tbody.innerHTML = c000
        .map(item => {
          const actionBtn = item.in_queue
            ? `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'remove_queue')">✓ Queued (Remove)</button>`
            : `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'queue')" title="Queue ${escapeHtml(item.month)} for Verify, Export & Google Upload">➕ Queue (000➜399)</button>`;

          const deviceCellHtml = formatDeviceSummaryCell(item.device_summary);

          return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-outline font-mono">${escapeHtml(item.status_code)}</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td class="batch-device-cell">${deviceCellHtml}</td>
            <td class="font-mono" style="font-size: 0.7rem; color: var(--text-muted);">000 ➜ 100 ➜ 200 ➜ 210 ➜ 399 (Upload)</td>
            <td style="text-align: right; white-space: nowrap;">${actionBtn}</td>
          </tr>
        `;
        })
        .join('');
    }
  }
}

function formatDeviceSummaryCell(ds: BatchDeviceSummary | null | undefined): string {
  if (!ds) {
    return '<span class="text-muted font-mono" style="font-size: 0.72rem;">—</span>';
  }

  let badgeClass = 'badge-green';
  if (ds.active_family_count === 0) {
    badgeClass = 'badge-outline';
  } else if (ds.matched_family_count === ds.active_family_count) {
    badgeClass = 'badge-green';
  } else if (ds.coverage_percent >= 50) {
    badgeClass = 'badge-blue';
  } else if (ds.matched_family_count > 0) {
    badgeClass = 'badge-amber';
  } else {
    badgeClass = 'badge-red';
  }

  const coverageBadge = ds.active_family_count > 0
    ? `<span class="badge badge-xs ${badgeClass} font-mono">${ds.matched_family_count}/${ds.active_family_count} Active Family (${ds.coverage_percent.toFixed(0)}%)</span>`
    : `<span class="badge badge-xs badge-outline font-mono">No registered family devices</span>`;

  const matchedPills = ds.matched_family_devices.map(d => `
    <span class="batch-dev-chip chip-matched" title="${escapeHtml(d.camera_model)} • Owner: ${escapeHtml(d.owner_name)} • ${d.count.toLocaleString()} assets">
      <span>${escapeHtml(d.camera_model)}</span>
      <span class="batch-dev-owner">(${escapeHtml(d.owner_name)})</span>
      <span class="batch-dev-count">${d.count.toLocaleString()}</span>
    </span>
  `).join('');

  let missingPill = '';
  if (ds.missing_family_devices && ds.missing_family_devices.length > 0) {
    const missingTitle = ds.missing_family_devices.map(d => `${d.camera_model} (${d.owner_name})`).join(', ');
    const missingShort = ds.missing_family_devices.map(d => `${d.camera_model.replace(/\s*\([^)]*\)/g, '')} (${d.owner_name})`).join(', ');
    missingPill = `
      <span class="batch-dev-chip chip-missing" title="Active family devices with 0 assets in this batch: ${escapeHtml(missingTitle)}">
        ⚠️ Missing (${ds.missing_family_devices.length}): ${escapeHtml(missingShort)}
      </span>
    `;
  }

  let otherPill = '';
  if (ds.other_devices && ds.other_devices.length > 0) {
    const otherDetails = ds.other_devices.map(d => `${d.camera_model}${d.owner_name ? ` (${d.owner_name})` : ''}: ${d.count}`).join(', ');
    otherPill = `
      <span class="batch-dev-chip chip-other" title="${escapeHtml(otherDetails)}">
        +${ds.other_assets_count.toLocaleString()} other (${ds.other_devices.length} dev)
      </span>
    `;
  }

  return `
    <div class="batch-device-header">${coverageBadge}</div>
    <div class="batch-device-list">
      ${matchedPills}
      ${missingPill}
      ${otherPill}
    </div>
  `;
}

export function renderMomentTaggedBadge(
  isTagged?: boolean,
  paradigmConfirmed?: boolean,
  tagSummary?: string,
  extraLabel = ''
): string {
  if (!isTagged) return '';
  const cls = paradigmConfirmed ? 'badge-green' : 'badge-purple';
  const label = paradigmConfirmed
    ? `✓ Tagged${extraLabel ? ` · ${extraLabel}` : ''}`
    : `🏷️ Tagged${extraLabel ? ` · ${extraLabel}` : ''}`;
  const titleParts: string[] = [];
  if (paradigmConfirmed) {
    titleParts.push('Passed New Tagging Paradigm');
  } else {
    titleParts.push('Tags saved in DB');
  }
  if (tagSummary) titleParts.push(tagSummary);
  return `<span class="badge badge-xs ${cls} font-mono" style="margin-left: 0.35rem;" title="${escapeHtml(titleParts.join(' — '))}">${escapeHtml(label)}</span>`;
}

function cliStageBadgeClass(stage: string): string {
  switch (stage) {
    case 'M500':
      return 'badge-green';
    case 'M450':
    case 'M400':
      return 'badge-blue';
    case 'M300':
      return 'badge-purple';
    case 'M200':
      return 'badge-amber';
    default:
      return 'badge-muted';
  }
}

function renderCliSimPendingSection(
  sim: CliStep2Simulation,
  startIdx: number
): string {
  const pp = sim.pending_publishing || {
    publishable_tbc: [],
    publishable_clean: [],
    pending_curation: [],
    pending_cooldown: [],
    disjoint: []
  };
  const c = sim.counts;
  const subsections: Array<{
    key: string;
    shortLabel: string;
    badgeCls: string;
    title: string;
    rows: CliStep2PendingPublishingRow[];
    totalCount: number;
    showTbc: boolean;
  }> = [
      {
        key: 'publishable_tbc',
        shortLabel: '⚠️ TBC',
        badgeCls: 'badge-amber',
        title: '⚠️ 🚀 Ready for Publishing (Action Required: Assets in ToBeCurated Need Review & Move to Curated)',
        rows: pp.publishable_tbc || [],
        totalCount: c.publishable_tbc_total ?? (pp.publishable_tbc || []).length,
        showTbc: true
      },
      {
        key: 'publishable_clean',
        shortLabel: '🚀 Clean',
        badgeCls: 'badge-green',
        title: '🚀 Ready for Publishing (Fully Curated — No Assets in ToBeCurated, Ready to Export)',
        rows: pp.publishable_clean || [],
        totalCount: c.publishable_clean_total ?? (pp.publishable_clean || []).length,
        showTbc: false
      },
      {
        key: 'pending_curation',
        shortLabel: '⏳ Curation',
        badgeCls: 'badge-purple',
        title: '⏳ Pending Curation (New Assets in ToBeCurated)',
        rows: pp.pending_curation || [],
        totalCount: c.pending_curation_total ?? (pp.pending_curation || []).length,
        showTbc: true
      },
      {
        key: 'pending_cooldown',
        shortLabel: '⏱️ Cooldown',
        badgeCls: 'badge-outline',
        title: '⏱️ Pending Time Restriction (Cooldown Delay < 30d)',
        rows: pp.pending_cooldown || [],
        totalCount: c.pending_cooldown_total ?? (pp.pending_cooldown || []).length,
        showTbc: false
      },
      {
        key: 'disjoint',
        shortLabel: '🔀 Disjoint',
        badgeCls: 'badge-red',
        title: '🔀 Disjoint Moments (< 2 Qualified Assets)',
        rows: pp.disjoint || [],
        totalCount: c.disjoint_pending_total ?? (pp.disjoint || []).length,
        showTbc: false
      }
    ];

  const totalPendingRows = subsections.reduce((acc, s) => acc + s.rows.length, 0);
  const totalPendingAll = subsections.reduce((acc, s) => acc + s.totalCount, 0);
  const headingTitle = sim.has_pending_curation
    ? '🔒 Step 2B Preview: Curated Moments Pending Publishing (Unlocks After M200/M300 Queue Clears)'
    : '🌟 Curated Moments Pending Publishing (Active CLI Step 2B Output)';

  const summaryPills = subsections
    .filter(s => s.totalCount > 0)
    .map(
      s =>
        `<span class="badge badge-xs ${s.badgeCls} font-mono">${escapeHtml(s.shortLabel)}: ${s.rows.length}${s.totalCount > s.rows.length ? `/${s.totalCount}` : ''
        }</span>`
    )
    .join(' ');

  if (totalPendingRows === 0) {
    return `
      <div class="cli-sim-section-block">
        <div class="cli-sim-section-heading">
          <span>${escapeHtml(headingTitle)}</span>
          <span class="badge badge-xs badge-muted font-mono">0 pending</span>
        </div>
        <div class="text-muted" style="font-size: 0.72rem; padding: 0.35rem 0;">
          No M400/M450 moments currently have pending unpublished curated assets.
        </div>
      </div>
    `;
  }

  let seq = startIdx;
  const bodyRows = subsections
    .filter(sub => sub.rows.length > 0)
    .map(sub => {
      const isBucketCollapsed = collapsedCliStep2bBuckets.has(sub.key);
      const countText = sub.totalCount > sub.rows.length ? `Top ${sub.rows.length} of ${sub.totalCount}` : `${sub.rows.length}`;
      const divider = `
        <tr class="cli-sim-subdivider-row cli-step2b-bucket-toggle" data-bucket-key="${escapeHtml(sub.key)}"
          style="cursor: pointer;" title="Click to expand or collapse this subsection">
          <td colspan="11">
            <span>${isBucketCollapsed ? '▸' : '▾'}</span>
            ${escapeHtml(sub.title)} · <strong>${escapeHtml(countText)}</strong>
          </td>
        </tr>
      `;
      const bucketRowsStartSeq = seq;
      seq += sub.rows.length;
      if (isBucketCollapsed) {
        return divider;
      }
      const rowsHtml = sub.rows
        .map((entry, idx) => {
          const rowNo = bucketRowsStartSeq + idx;
          const scoresStr = (entry.proposed_scores || []).map(s => s.toFixed(4)).join(', ') || '—';
          const filesStr = (entry.proposed_filenames || []).slice(0, 4).join(', ') +
            ((entry.proposed_filenames || []).length > 4 ? ` (+${entry.proposed_filenames.length - 4})` : '');
          const tbcPrefix =
            sub.showTbc && entry.to_be_curated_count > 0
              ? `ToBeCurated: ${entry.to_be_curated_count} ${entry.to_be_curated_count === 1 ? 'asset' : 'assets'} | `
              : '';
          const combinedDetail = filesStr ? `${tbcPrefix}${filesStr} · [${scoresStr}]` : `${tbcPrefix}${scoresStr}`;

          let actionCellHtml = `<span class="text-muted font-mono" style="font-size: 0.68rem;">Wait</span>`;
          if (sub.key === 'publishable_tbc') {
            actionCellHtml = `<div style="display: inline-flex; gap: 0.3rem; flex-wrap: nowrap;">
              <button type="button" class="btn btn-xs btn-purple btn-cli-sim-curate" data-moment-name="${escapeHtml(
              entry.moment_name
            )}" title="Curate ToBeCurated (${entry.to_be_curated_count}) into Curated & Ignore/Skip rejects">🎨 Curate (${entry.to_be_curated_count})</button>
              <button type="button" class="btn btn-xs ${entry.published > 0 ? 'btn-purple' : 'btn-green'
              } btn-cli-sim-publish" data-moment-name="${escapeHtml(
                entry.moment_name
              )}" title="Review & publish batch for '${escapeHtml(entry.moment_name)}'">🚀 Publish</button>
            </div>`;
          } else if (sub.key === 'publishable_clean') {
            actionCellHtml = `<button type="button" class="btn btn-xs ${entry.published > 0 ? 'btn-purple' : 'btn-green'
              } btn-cli-sim-publish" data-moment-name="${escapeHtml(
                entry.moment_name
              )}" title="Review & publish batch for '${escapeHtml(entry.moment_name)}'">🚀 Publish</button>`;
          } else if (sub.key === 'disjoint') {
            actionCellHtml = `<button type="button" class="btn btn-xs btn-amber btn-cli-sim-merge" data-moment-name="${escapeHtml(
              entry.moment_name
            )}" title="Merge or resolve disjoint moment '${escapeHtml(entry.moment_name)}'">🔀 Resolve</button>`;
          } else if (sub.key === 'pending_curation') {
            actionCellHtml = `<button type="button" class="btn btn-xs btn-purple btn-cli-sim-curate" data-moment-name="${escapeHtml(
              entry.moment_name
            )}" title="Curate ToBeCurated (${entry.to_be_curated_count}) assets into Curated & Ignore/Skip rejects">🎨 Curate (${entry.to_be_curated_count})</button>`;
          } else if (sub.key === 'pending_cooldown') {
            actionCellHtml = `<span class="badge badge-xs badge-outline font-mono">${escapeHtml(entry.can_publish_str)}</span>`;
          }

          return `
            <tr>
              <td class="font-mono text-muted">${rowNo}</td>
              <td><strong class="text-primary">${escapeHtml(entry.moment_name)}</strong></td>
              <td><span class="badge badge-xs ${cliStageBadgeClass(entry.display_stage)} font-mono">${escapeHtml(entry.display_stage)}</span></td>
              <td style="text-align: right;" class="font-mono text-amber">${entry.avg_proposed.toFixed(4)}</td>
              <td style="text-align: right;" class="font-mono">${entry.curated}</td>
              <td style="text-align: right;" class="font-mono">${entry.published}</td>
              <td style="text-align: right;" class="font-mono">${entry.pending}</td>
              <td class="font-mono" style="white-space: nowrap;">${escapeHtml(entry.can_publish_str)}</td>
              <td class="font-mono" style="white-space: nowrap;">${escapeHtml(entry.propose_str)}</td>
              <td class="font-mono text-muted" style="font-size: 0.68rem; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(combinedDetail)}">
                ${escapeHtml(combinedDetail)}
              </td>
              <td style="white-space: nowrap;">${actionCellHtml}</td>
            </tr>
          `;
        })
        .join('');
      return divider + rowsHtml;
    })
    .join('');

  return `
    <div class="cli-sim-section-block">
      <div class="cli-sim-section-heading">
        <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
          <span>${escapeHtml(headingTitle)}</span>
          ${summaryPills}
        </div>
        <div style="display: flex; align-items: center; gap: 0.4rem;">
          <span class="badge badge-xs badge-purple font-mono">${totalPendingRows}${totalPendingAll > totalPendingRows ? ` / ${totalPendingAll}` : ''} shown</span>
          <button type="button" class="btn btn-xs btn-outline" id="btn-toggle-mode-m-cli-step2b"
            aria-expanded="${String(!cliStep2bCollapsed)}" title="Expand or collapse Step 2B Pending Publishing breakdown">
            ${cliStep2bCollapsed ? '▾ Expand' : '▴ Collapse'}
          </button>
        </div>
      </div>
      <div id="mode-m-cli-step2b-body" class="mode-m-step-body${cliStep2bCollapsed ? ' collapsed' : ''}">
        <div class="planner-table-wrap">
          <table class="cleanup-table planner-compact-table">
            <thead>
              <tr>
                <th>No.</th>
                <th>Moment Name</th>
                <th>Status</th>
                <th style="text-align: right;">Avg Score</th>
                <th style="text-align: right;">Curated</th>
                <th style="text-align: right;">Pub.</th>
                <th style="text-align: right;">Pending</th>
                <th>Can Publish?</th>
                <th>Propose Next</th>
                <th>Proposed Assets &amp; Scores</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderModeMCliStep2Sim(sim?: CliStep2Simulation | null): void {
  const badgeEl = document.getElementById('mode-m-cli-sim-gate-badge');
  const bannerEl = document.getElementById('mode-m-cli-sim-gate-banner');
  const contentEl = document.getElementById('mode-m-cli-sim-content');
  if (!badgeEl || !bannerEl || !contentEl) return;

  if (!sim) {
    badgeEl.className = 'badge badge-xs badge-muted font-mono';
    badgeEl.textContent = 'Unavailable';
    bannerEl.className = 'cli-sim-gate-banner';
    bannerEl.textContent = 'CLI Step 2 simulation telemetry not available.';
    contentEl.innerHTML = '';
    return;
  }

  let badgeClass = 'badge-amber';
  let bannerClass = 'gate-curation';
  if (sim.gate === 'unlocked_publishing_candidates') {
    badgeClass = 'badge-green';
    bannerClass = 'gate-unlocked';
  } else if (sim.gate === 'auto_option_2_export') {
    badgeClass = 'badge-blue';
    bannerClass = 'gate-auto-export';
  }
  badgeEl.className = `badge badge-xs ${badgeClass} font-mono`;
  badgeEl.textContent = sim.gate_label;

  const c = sim.counts;
  const lacieChip = sim.lacie_mounted
    ? '<span class="badge badge-xs badge-green font-mono">LaCie: Mounted</span>'
    : '<span class="badge badge-xs badge-amber font-mono">LaCie: Offline (DB Estimate)</span>';
  bannerEl.className = `cli-sim-gate-banner ${bannerClass}`;
  bannerEl.innerHTML = `
    <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.3rem;">
      <strong>Simulated CLI Gate:</strong>
      <span class="badge badge-xs ${badgeClass} font-mono">${escapeHtml(sim.gate_label)}</span>
      <span class="badge badge-xs badge-muted font-mono">Ranked Moments: ${c.ranked_total}</span>
      <span class="badge badge-xs badge-muted font-mono">M200: ${c.m200} · M300: ${c.m300} · M100: ${c.m100}</span>
      <span class="badge badge-xs badge-muted font-mono">Option [1] Sync Needed: ${c.needs_sync_option1}</span>
      ${lacieChip}
    </div>
    <div>👉 <strong>CLI Next Behavior:</strong> ${escapeHtml(sim.next_prompt)}</div>
  `;

  const consoleRows = sim.console_moments || [];
  let needsUpdateHeaderPrinted = false;
  let upToDateHeaderPrinted = false;

  const consoleBodyHtml = !consoleRows.length
    ? '<tr><td colspan="13" class="text-center text-muted">No ranked moments in CLI Step 2 console table.</td></tr>'
    : consoleRows
      .map((m: CliStep2ConsoleMomentRow) => {
        let divider = '';
        if (m.needs_update && !needsUpdateHeaderPrinted) {
          needsUpdateHeaderPrinted = true;
          divider = `
              <tr class="cli-sim-divider-row">
                <td colspan="13">--- Moments Requiring Curation Updates (Run Option [1] to sync proposed assets to ToBeCurated) ---</td>
              </tr>
            `;
        } else if (!m.needs_update && !upToDateHeaderPrinted) {
          upToDateHeaderPrinted = true;
          divider = `
              <tr class="cli-sim-divider-row">
                <td colspan="13">--- Up-To-Date Moments (All qualified assets are already curated or in ToBeCurated) ---</td>
              </tr>
            `;
        }
        const scoreRange = `${m.avg_score.toFixed(4)} (${m.min_score.toFixed(3)}..${m.max_score.toFixed(3)})`;
        const pubAvgDisplay = m.pub_count > 0 ? `${m.pub_avg_str} (${m.pub_range_str})` : '—';
        const showCurateBtn = m.display_stage === 'M200' || m.display_stage === 'M300' || m.to_be_curated_exists;
        const rowActionHtml = showCurateBtn
          ? `<button type="button" class="btn btn-xs btn-purple btn-cli-sim-curate" data-moment-name="${escapeHtml(
            m.moment_name
          )}" title="Open Tagging & M200 Curation dialog (approve keepers ➜ Curated, Ignore/Skip rejects, delete ToBeCurated, export)">🎨 Curate</button>`
          : '<span class="text-muted font-mono" style="font-size: 0.68rem;">—</span>';
        return `${divider}
            <tr>
              <td class="font-mono text-muted">${m.no}</td>
              <td><strong class="text-primary">${escapeHtml(m.moment_name)}</strong></td>
              <td><span class="badge badge-xs ${cliStageBadgeClass(m.display_stage)} font-mono">${escapeHtml(m.display_stage)}</span></td>
              <td style="text-align: right;" class="font-mono text-amber">${m.rank_score.toFixed(4)}</td>
              <td style="text-align: right;" class="font-mono" title="Avg (Min..Max unpublished)">${escapeHtml(scoreRange)}</td>
              <td style="text-align: right;" class="font-mono">${m.assets_display}</td>
              <td style="text-align: right;" class="font-mono">${m.pub_count > 0 ? m.pub_count : '—'}</td>
              <td class="font-mono text-muted" style="font-size: 0.68rem;">${escapeHtml(pubAvgDisplay)}</td>
              <td class="font-mono" style="white-space: nowrap;">${escapeHtml(m.to_be_curated_str)}</td>
              <td class="font-mono" style="white-space: nowrap;">${escapeHtml(m.curated_str)}</td>
              <td class="font-mono" style="white-space: nowrap;">${escapeHtml(m.published_str)}</td>
              <td class="font-mono" style="white-space: nowrap;" title="Last Published: ${escapeHtml(m.last_pub_str)}">${escapeHtml(m.can_publish_str)}</td>
              <td style="white-space: nowrap;">${rowActionHtml}</td>
            </tr>
          `;
      })
      .join('');

  const consoleSectionHtml = `
    <div class="cli-sim-section-block">
      <div class="cli-sim-section-heading">
        <span>${escapeHtml(sim.table_title)}</span>
        <span class="badge badge-xs badge-blue font-mono">${c.console_total} moments (${c.needs_update} Option [1] · ${c.up_to_date} up-to-date)</span>
      </div>
      <div class="planner-table-wrap">
        <table class="cleanup-table planner-compact-table">
          <thead>
            <tr>
              <th>No.</th>
              <th>Moment Name</th>
              <th>Status</th>
              <th style="text-align: right;">Rank Score</th>
              <th style="text-align: right;">Avg (Range)</th>
              <th style="text-align: right;">Assets</th>
              <th style="text-align: right;">Pub.</th>
              <th>Pub. Avg (Range)</th>
              <th>ToBeCurated?</th>
              <th>Curated?</th>
              <th>Published?</th>
              <th>Can Publish?</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>${consoleBodyHtml}</tbody>
        </table>
      </div>
    </div>
  `;

  const pendingStartIdx = Math.max(1, c.console_total + 1);
  contentEl.innerHTML = consoleSectionHtml + renderCliSimPendingSection(sim, pendingStartIdx);

  document.getElementById('btn-toggle-mode-m-cli-step2b')?.addEventListener('click', btnEv => {
    cliStep2bCollapsed = !cliStep2bCollapsed;
    const bodyEl = document.getElementById('mode-m-cli-step2b-body');
    const toggleBtn = btnEv.currentTarget as HTMLButtonElement | null;
    bodyEl?.classList.toggle('collapsed', cliStep2bCollapsed);
    if (toggleBtn) {
      toggleBtn.textContent = cliStep2bCollapsed ? '▾ Expand' : '▴ Collapse';
      toggleBtn.setAttribute('aria-expanded', String(!cliStep2bCollapsed));
    }
  });

  contentEl.querySelectorAll<HTMLElement>('.cli-step2b-bucket-toggle').forEach(rowEl => {
    rowEl.addEventListener('click', () => {
      const bKey = rowEl.dataset.bucketKey || '';
      if (!bKey) return;
      if (collapsedCliStep2bBuckets.has(bKey)) {
        collapsedCliStep2bBuckets.delete(bKey);
      } else {
        collapsedCliStep2bBuckets.add(bKey);
      }
      renderModeMCliStep2Sim(sim);
    });
  });

  contentEl.querySelectorAll<HTMLButtonElement>('.btn-cli-sim-publish').forEach(btn => {
    btn.addEventListener('click', () => {
      const momentName = btn.dataset.momentName || '';
      if (momentName) void openPublishMomentModal(momentName);
    });
  });

  contentEl.querySelectorAll<HTMLButtonElement>('.btn-cli-sim-merge').forEach(btn => {
    btn.addEventListener('click', () => {
      const momentName = btn.dataset.momentName || '';
      if (momentName) void openResolveDisjointModal(momentName, '', { isHistoricalMoment: true });
    });
  });

  contentEl.querySelectorAll<HTMLButtonElement>('.btn-cli-sim-curate').forEach(btn => {
    btn.addEventListener('click', () => {
      const momentName = btn.dataset.momentName || '';
      if (momentName) void openResolveDisjointModal(momentName, '', { isHistoricalMoment: true, isCurateM200: true });
    });
  });
}

function renderModeMOverview(modeM: Partial<PlannerModeM>): void {
  const th: any = modeM.threshold || {};
  const sc: any = modeM.stage_counts || {};
  const needsSync = modeM.needs_sync_moments || [];
  const recs = modeM.actionable_recommendations || [];
  const disjoint = modeM.disjoint_recommendations || [];

  const thPill = document.getElementById('mode-m-threshold-pill');
  const momPill = document.getElementById('mode-m-moments-pill');

  if (thPill) {
    if (th.aligned) {
      thPill.className = 'badge badge-xs badge-green font-mono';
      thPill.textContent = `🎉 Threshold Aligned (${(th.current || 0.5315).toFixed(4)})`;
      thPill.title = '';
    } else {
      thPill.className = 'badge badge-xs badge-amber font-mono';
      thPill.textContent = `⚠️ Threshold ${(th.current || 0).toFixed(4)} > ${(th.historical_min || 0).toFixed(4)}`;
      thPill.title = '';
    }
  }
  if (momPill) {
    momPill.textContent = `${sc.total_moments || 163} Moments (${sc.published_assets_total || 0} pub. assets)`;
  }

  const elSync = document.getElementById('mode-m-cnt-sync');
  const elM400 = document.getElementById('mode-m-cnt-m400');
  const elM450 = document.getElementById('mode-m-cnt-m450');
  const elM500 = document.getElementById('mode-m-cnt-m500');

  if (elSync) elSync.textContent = `${needsSync.length} moment${needsSync.length === 1 ? '' : 's'}`;
  if (elM400) elM400.textContent = `${sc.M400 || 0} moments`;
  if (elM450) elM450.textContent = `${sc.M450 || 0} moments`;
  if (elM500) elM500.textContent = `${sc.M500 || 0} moments`;

  const headlineEl = document.getElementById('mode-m-primary-headline');
  const detailEl = document.getElementById('mode-m-primary-detail');

  if (needsSync.length > 0) {
    const names = needsSync.map(m => m.moment_name).join(', ');
    if (headlineEl) {
      headlineEl.textContent = `Step 1: Sync ${needsSync.length} Moment(s) Requiring Curation Updates (${names}) ➜ Step 2: Publish Top ${recs.length} Ready Moments`;
    }
    if (detailEl) {
      detailEl.textContent = `👉 Run Option [1] to sync new qualified assets to ToBeCurated in Apple Photos, or publish top ready candidate: ${recs[0] ? `${recs[0].moment_name} (${recs[0].action})` : '—'
        }`;
    }
  } else if (!th.aligned) {
    if (headlineEl) {
      headlineEl.textContent = `Step 1: Resolve Threshold Mismatch (${(th.current || 0).toFixed(4)} > ${(th.historical_min || 0).toFixed(4)}) before Step 2 Publishing`;
    }
    if (detailEl) {
      const unassignedCount = modeM.unassigned_total_assets || 0;
      const clusterCount = modeM.unassigned_total_clusters || (modeM.unassigned_clusters || []).length;
      detailEl.textContent = `👉 ToBeCurated sync is complete. Assign Moments to top unassigned assets (${unassignedCount} across ${clusterCount} clusters) to align threshold${recs[0] ? `; next ready candidate once aligned: ${recs[0].moment_name}` : ''
        }.`;
    }
  } else if (recs.length > 0) {
    if (headlineEl) {
      headlineEl.textContent = `Threshold Aligned (${(th.current || 0.5315).toFixed(4)}) · Top Next Candidate: "${recs[0].moment_name}" (${recs[0].action})`;
    }
    if (detailEl) {
      detailEl.textContent = `👉 ${recs.length} actionable moments ready for Shutterfly/YouTube publishing (up to 9 assets per batch) and ${disjoint.length} disjoint moments ready for merge.`;
    }
  } else {
    if (headlineEl) {
      headlineEl.textContent = `Threshold Aligned (${(th.current || 0.5315).toFixed(4)}) · ToBeCurated Synced`;
    }
    if (detailEl) {
      detailEl.textContent = `👉 No actionable moments currently ready for publishing${disjoint.length > 0 ? ` (${disjoint.length} disjoint moments ready for merge)` : ''}.`;
    }
  }

  const rawClustersForSummary = modeM.unassigned_clusters || [];
  const outstandingGroupsCount = rawClustersForSummary.filter(c => {
    const cnt = (c.assets || []).length || c.asset_count || 0;
    return Math.max(0, cnt - (c.duplicate_copy_count || 0)) > 0;
  }).length;
  const thDriverSummary = th.driver?.folder ? `#${th.driver.position} ${th.driver.folder}` : '';
  const formatMomentScoreBadge = (momentName: string, score: number) => {
    const shortName = momentName.length > 28 ? `${momentName.slice(0, 26)}…` : momentName;
    return `${shortName} · ${score.toFixed(4)}`;
  };

  const topRec = recs[0];
  const topDisjoint = disjoint[0];
  const topPublished = sc.top_published || null;
  const pubMomentsTotal = Number(sc.published_moments_total || 0);
  const pubUntaggedTotal = Number(sc.published_untagged_total ?? pubMomentsTotal);
  const pubAssetsTotal = Number(sc.published_assets_total || 0);
  const m450Count = Number(sc.M450 || 0);
  const m500Count = Number(sc.M500 || 0);

  renderPlannerPathsSummary('mode-m-paths-summary', [
    {
      num: '1',
      numTone: th.aligned && needsSync.length === 0 ? 'green' : 'amber',
      title: 'Sync ToBeCurated & Align Threshold',
      badgeText: th.aligned
        ? `Aligned · ${(th.current || 0.5315).toFixed(4)}`
        : `${(th.current || 0).toFixed(4)} > ${(th.historical_min || 0.5315).toFixed(4)}`,
      badgeClass: th.aligned && needsSync.length === 0 ? 'badge-green' : 'badge-amber',
      badgeTitle: thDriverSummary ? `Click to jump & expand driver group: ${thDriverSummary}` : undefined,
      description: `Run Option [1] (${needsSync.length} moment(s) needing sync) and assign/ignore ${outstandingGroupsCount} outstanding unassigned group(s) until threshold aligns.`,
      footerMeta: thDriverSummary ? `Driver: ${thDriverSummary}` : `${rawClustersForSummary.length} total groups`,
      targetId: 'mode-m-step-1',
      linkLabel: 'Go to 1️⃣ Threshold & Groups ↓',
      active: !th.aligned || needsSync.length > 0 || outstandingGroupsCount > 0,
      focusItem: th.driver?.folder
        ? { containerId: 'mode-m-unassigned-list', itemName: th.driver.folder, isCluster: true }
        : undefined
    },
    {
      num: '2',
      numTone: 'green',
      title: 'Publish Top Ready Moments',
      badgeText: topRec ? formatMomentScoreBadge(topRec.moment_name, Number(topRec.avg_score || 0)) : '0 actionable',
      badgeClass: recs.length > 0 ? 'badge-green' : 'badge-outline',
      badgeTitle: topRec ? `Click to jump to publishing candidate: ${topRec.moment_name} (${Number(topRec.avg_score || 0).toFixed(4)})` : undefined,
      description: `Publish threshold-aligned Moments ready for Shutterfly / YouTube in curated batches (up to 9 assets).`,
      footerMeta: `${recs.length} actionable${th.aligned ? '' : ' · after Path 1'}`,
      targetId: 'mode-m-step-2',
      linkLabel: 'Go to 2️⃣ Publishing ↓',
      active: recs.length > 0,
      focusItem: topRec ? { containerId: 'mode-m-recs-tbody', itemName: topRec.moment_name } : undefined
    },
    {
      num: '3',
      numTone: 'purple',
      title: 'Consolidate Disjoint Moments (< 2)',
      badgeText: topDisjoint ? formatMomentScoreBadge(topDisjoint.moment_name, Number(topDisjoint.avg_score || 0)) : '0 disjoint',
      badgeClass: disjoint.length > 0 ? 'badge-amber' : 'badge-outline',
      badgeTitle: topDisjoint ? `Click to jump to disjoint Moment: ${topDisjoint.moment_name} (${Number(topDisjoint.avg_score || 0).toFixed(4)})` : undefined,
      description: `Review small single-asset disjoint Moments and merge them into neighboring chronological Moments.`,
      footerMeta: disjoint.length > 0 ? `${disjoint.length} disjoint` : '0 disjoint',
      targetId: 'mode-m-step-3',
      linkLabel: 'Go to 3️⃣ Disjoint Merge ↓',
      active: disjoint.length > 0,
      focusItem: topDisjoint ? { containerId: 'mode-m-disjoint-tbody', itemName: topDisjoint.moment_name } : undefined
    },
    {
      num: '4',
      numTone: 'blue',
      title: 'Published History',
      badgeText: topPublished
        ? formatMomentScoreBadge(topPublished.moment_name, Number(topPublished.avg_score || 0))
        : pubMomentsTotal > 0
          ? '✓ All tagged'
          : '0 published',
      badgeClass: topPublished ? 'badge-blue' : pubMomentsTotal > 0 ? 'badge-green' : 'badge-outline',
      badgeTitle: topPublished
        ? `Click to jump to top untagged published Moment: ${topPublished.moment_name} (${Number(topPublished.avg_score || 0).toFixed(4)}) · ${pubUntaggedTotal} untagged / ${pubMomentsTotal} Moments (${pubAssetsTotal} pub.)`
        : pubMomentsTotal > 0
          ? `All ${pubMomentsTotal} published Moments (${pubAssetsTotal} pub.) have been tagged`
          : undefined,
      description: 'Review Shutterfly & YouTube published albums, search history, or open live platform links.',
      footerMeta: `${pubUntaggedTotal} untagged · ${m500Count} M500 · ${m450Count} M450`,
      targetId: 'published-memories-card',
      linkLabel: 'Go to 4️⃣ Published History ↓',
      active: pubUntaggedTotal > 0,
      focusItem: topPublished ? { containerId: 'featured-moments-list', itemName: topPublished.moment_name } : undefined
    }
  ]);

  // Step 1: Sync Box
  const syncBox = document.getElementById('mode-m-sync-box');
  if (syncBox) {
    const thText = th.aligned
      ? `<span class="text-green">✅ <strong>Curation Threshold Aligned:</strong> Current <code>${(th.current || 0.5315).toFixed(4)}</code> matches target <code>${(th.historical_min || 0.5315).toFixed(4)}</code>.</span>`
      : `<span class="text-amber">⚠️ <strong>Threshold Mismatch:</strong> Current <code>${(th.current || 0).toFixed(4)}</code> exceeds target <code>${(th.historical_min || 0).toFixed(4)}</code> — assign Moments to top unassigned assets first.</span><span id="mode-m-threshold-driver-slot"></span>`;

    let syncMomentsHtml = '';
    if (needsSync.length > 0) {
      syncMomentsHtml =
        `<div style="margin-top: 0.35rem;">🔄 <strong>Moments Requiring Option [1] Sync to <code>ToBeCurated</code>:</strong> ` +
        needsSync
          .map(
            m =>
              `<span class="badge badge-xs badge-amber font-mono">${escapeHtml(m.moment_name)} (${m.stage} · ${m.assets} assets · Rank ${m.rank_score.toFixed(2)})</span>`
          )
          .join(' ') +
        `</div>`;
    } else {
      syncMomentsHtml = `<div style="margin-top: 0.3rem;" class="text-muted">All qualified assets are synced to <code>ToBeCurated</code> or <code>Curated</code>.</div>`;
    }
    syncBox.innerHTML = thText + syncMomentsHtml;
  }

  // Step 1b: Unassigned High-Rank Assets Above Threshold Clusters
  const unassignedClusters = modeM.unassigned_clusters || [];
  const totalUnassignedAssets = modeM.unassigned_total_assets || 0;
  const totalUnassignedClusters = modeM.unassigned_total_clusters || unassignedClusters.length;

  const unassignedSummaryBadge = document.getElementById('mode-m-unassigned-summary-badge');
  const unassignedSection = document.getElementById('mode-m-unassigned-section');
  const unassignedTitleEl = document.getElementById('mode-m-unassigned-title');

  unassignedClusters.forEach(cluster => {
    (cluster.assets || []).forEach(a => {
      if (a.asset_id) {
        candidateAssetMeta.set(a.asset_id, {
          ...a,
          bytes: a.file_size_bytes || 0,
          filename: a.original_filename,
          score_quartile: `Top (>${(th.historical_min || 0.5315).toFixed(4)})`,
          assigned_moment: `Proposed: ${cluster.folder} [${cluster.group_type}]`
        });
      }
    });
  });

  if (unassignedClusters.length > 0) {
    const totalDupFlagged = unassignedClusters.reduce((sum, c) => sum + (c.duplicate_copy_count || 0), 0);
    const totalUniqueAssets = Math.max(0, totalUnassignedAssets - totalDupFlagged);
    if (unassignedSummaryBadge) {
      unassignedSummaryBadge.style.display = 'inline-flex';
      unassignedSummaryBadge.textContent = `${totalUniqueAssets} unique · ${totalUnassignedAssets} unassigned · ${totalUnassignedClusters} folders`;
    }
    if (unassignedSection) {
      unassignedSection.style.display = 'block';
    }
    if (unassignedTitleEl) {
      unassignedTitleEl.textContent = `⚠️ Unassigned High-Rank Assets Above Threshold > ${(th.historical_min || 0.5315).toFixed(4)} (${totalUniqueAssets} Unique / ${totalUnassignedAssets} Total Grouped into ${totalUnassignedClusters} Proposed Moment Folder(s))`;
    }

    renderGroupingRulesPanel();
    renderUnassignedClustersList();
  } else {
    if (unassignedSummaryBadge) unassignedSummaryBadge.style.display = 'none';
    if (unassignedSection) unassignedSection.style.display = 'none';
    renderUnassignedClustersStatsBar([], []);
    updateThresholdDriverDisplay([], []);
  }

  // Step 2: Top Actionable Recommendations Table
  const recBadge = document.getElementById('mode-m-rec-badge');
  const recStatusSummary = document.getElementById('mode-m-rec-status-summary');
  const recTbody = document.getElementById('mode-m-recs-tbody');
  if (recBadge) recBadge.textContent = `${recs.length} actionable`;

  if (recStatusSummary) {
    if (!recs.length) {
      recStatusSummary.innerHTML = '';
    } else {
      const m400Cnt = recs.filter(r => r.display_stage === 'M400').length;
      const m450Cnt = recs.filter(r => r.display_stage === 'M450').length;
      const tbcReviewCnt = recs.filter(r => r.to_be_curated_exists).length;
      const cleanCnt = recs.length - tbcReviewCnt;
      const pills: string[] = [];
      if (cleanCnt > 0) {
        pills.push(`<span class="badge badge-xs badge-green font-mono" title="Fully curated with no pending ToBeCurated review">🚀 ${cleanCnt} clean</span>`);
      }
      if (tbcReviewCnt > 0) {
        pills.push(`<span class="badge badge-xs badge-amber font-mono" title="Also has uncurated assets in ToBeCurated needing review">⚠️ ${tbcReviewCnt} TBC</span>`);
      }
      if (m400Cnt > 0 || m450Cnt > 0) {
        pills.push(`<span class="badge badge-xs badge-blue font-mono">M400: ${m400Cnt} · M450: ${m450Cnt}</span>`);
      }
      recStatusSummary.innerHTML = pills.join('');
    }
  }

  if (recTbody) {
    if (!recs.length) {
      recTbody.innerHTML =
        '<tr><td colspan="10" class="text-center text-muted">No actionable publishing recommendations currently ready.</td></tr>';
    } else {
      recTbody.innerHTML = recs
        .map(r => {
          const isRepub = r.action.startsWith('Republish');
          const actionBtnClass = isRepub ? 'btn-purple' : 'btn-green';
          const actionBtn = `<button type="button" class="btn btn-xs ${actionBtnClass} btn-open-publish-moment" data-moment-name="${escapeHtml(r.moment_name)}" title="Open Publish / Republish workflow for '${escapeHtml(r.moment_name)}'">${escapeHtml(r.action)}</button>`;
          const tagBadgeHtml = renderMomentTaggedBadge(r.is_tagged, r.paradigm_confirmed, r.tag_summary);
          const stage = r.display_stage || 'M400';
          const tbcStr = r.to_be_curated_exists && (r.to_be_curated_count || 0) > 0
            ? `⚠️ ${r.to_be_curated_count}`
            : r.to_be_curated_str || '❌ No';
          const curStr = r.curated_str || '✅ Yes';
          const canPubStr = r.can_publish_str || '✅ Yes';
          return `
          <tr data-moment-name="${escapeHtml(r.moment_name)}">
            <td><strong class="text-primary">${escapeHtml(r.moment_name)}</strong>${tagBadgeHtml}</td>
            <td><span class="badge badge-xs ${cliStageBadgeClass(stage)} font-mono">${escapeHtml(stage)}</span></td>
            <td style="text-align: right;" class="font-mono text-amber">${r.avg_score.toFixed(4)}</td>
            <td style="text-align: right;" class="font-mono">${r.files}</td>
            <td style="text-align: right;" class="font-mono">${r.published}</td>
            <td class="font-mono" style="white-space: nowrap;" title="ToBeCurated status: ${escapeHtml(r.to_be_curated_str || '❌ No')}">${escapeHtml(tbcStr)}</td>
            <td class="font-mono" style="white-space: nowrap;" title="Curated LaCie/Photos folder status">${escapeHtml(curStr)}</td>
            <td class="font-mono" style="white-space: nowrap;" title="Publish readiness / cooldown">${escapeHtml(canPubStr)}</td>
            <td>${actionBtn}</td>
            <td class="font-mono text-muted" style="font-size: 0.69rem; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(r.details)}">
              ${escapeHtml(r.details)}
            </td>
          </tr>
        `;
        })
        .join('');
      recTbody.querySelectorAll<HTMLButtonElement>('.btn-open-publish-moment').forEach(btn => {
        btn.addEventListener('click', () => {
          const momentName = btn.dataset.momentName || '';
          if (momentName) void openPublishMomentModal(momentName);
        });
      });
    }
  }
  renderModeMCliStep2Sim(modeM.cli_step2_sim);

  // Step 3: Disjoint Moments Table
  const disjBadge = document.getElementById('mode-m-disjoint-badge');
  const disjTbody = document.getElementById('mode-m-disjoint-tbody');
  if (disjBadge) disjBadge.textContent = `${disjoint.length} disjoint`;

  if (disjTbody) {
    if (!disjoint.length) {
      disjTbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No disjoint moments (&lt;2 assets) detected.</td></tr>';
    } else {
      disjTbody.innerHTML = disjoint
        .map(d => {
          const assetIds = d.asset_ids || [];
          const firstAssetId = assetIds[0] || '';
          const thumbHtml = firstAssetId
            ? `<button type="button" class="disjoint-row-thumb-btn btn-preview-disjoint-asset" data-asset-id="${escapeHtml(firstAssetId)}" data-moment-name="${escapeHtml(d.moment_name)}" title="Preview assets in ${escapeHtml(d.moment_name)}">
                <img src="/api/media/cleanup/thumbnail/${encodeURIComponent(firstAssetId)}" alt="${escapeHtml(d.moment_name)}" loading="lazy" />
              </button>`
            : '';
          const sugTarget = d.suggested_target || '';
          const taggedBadgeHtml = renderMomentTaggedBadge(
            d.is_tagged,
            d.paradigm_confirmed,
            d.tag_summary,
            'awaiting merge'
          );
          return `
            <tr data-moment-name="${escapeHtml(d.moment_name)}"${d.is_tagged ? ' style="opacity: 0.84;"' : ''}>
              <td>
                <div class="disjoint-row-title">
                  ${thumbHtml}
                  <strong class="text-primary">${escapeHtml(d.moment_name)}</strong>
                  ${taggedBadgeHtml}
                </div>
              </td>
              <td style="text-align: right;" class="font-mono">${d.avg_score.toFixed(4)}</td>
              <td style="text-align: right;" class="font-mono">${d.files}</td>
              <td style="font-size: 0.72rem; color: var(--accent-amber);">${escapeHtml(d.details)}</td>
              <td>
                <button
                  type="button"
                  class="btn btn-xs btn-amber btn-open-resolve-disjoint"
                  data-moment-name="${escapeHtml(d.moment_name)}"
                  data-suggested-target="${escapeHtml(sugTarget)}"
                  title="Inspect &amp; merge, skip publishing, or ignore '${escapeHtml(d.moment_name)}'"
                >🔀 Resolve</button>
              </td>
            </tr>
          `;
        })
        .join('');

      disjTbody.querySelectorAll<HTMLButtonElement>('.btn-open-resolve-disjoint').forEach(btn => {
        btn.addEventListener('click', () => {
          const momentName = btn.dataset.momentName || '';
          const suggestedTarget = btn.dataset.suggestedTarget || '';
          if (momentName) void openResolveDisjointModal(momentName, suggestedTarget);
        });
      });

      disjTbody.querySelectorAll<HTMLButtonElement>('.btn-preview-disjoint-asset').forEach(btn => {
        btn.addEventListener('click', () => {
          const aid = btn.dataset.assetId || '';
          const momentName = btn.dataset.momentName || '';
          const match = disjoint.find(item => item.moment_name === momentName);
          const ids = match?.asset_ids?.length ? match.asset_ids : aid ? [aid] : [];
          if (aid) {
            openCleanupPreviewModal(aid, {
              assetIds: ids,
              groupLabel: momentName,
              hideMarkRemoved: true
            });
          }
        });
      });
    }
  }
}

type UnassignedClusterItem = NonNullable<NonNullable<PlannerModeM>['unassigned_clusters']>[number];

function sortNormalizedClusters(clusters: UnassignedClusterItem[]): UnassignedClusterItem[] {
  const getClusterSortTier = (c: UnassignedClusterItem): number => {
    const cnt = c.assets.length || c.asset_count || 0;
    const uniqueCnt = Math.max(0, cnt - (c.duplicate_copy_count || 0));
    if (uniqueCnt === 0) return 2;
    if (c.rule_id === 'misdated_duplicate_triage') return 1;
    return 0;
  };

  return [...clusters].sort((a, b) => {
    const tierA = getClusterSortTier(a);
    const tierB = getClusterSortTier(b);
    if (tierA !== tierB) return tierA - tierB;
    const cntA = (a.assets || []).length || a.asset_count || 0;
    const cntB = (b.assets || []).length || b.asset_count || 0;
    const uniqueA = Math.max(0, cntA - (a.duplicate_copy_count || 0));
    const uniqueB = Math.max(0, cntB - (b.duplicate_copy_count || 0));
    if (unassignedSortMode === 'size') {
      if (uniqueB !== uniqueA) return uniqueB - uniqueA;
      if (cntB !== cntA) return cntB - cntA;
      if (b.max_score !== a.max_score) return b.max_score - a.max_score;
      return (a.folder || '').localeCompare(b.folder || '');
    } else if (unassignedSortMode === 'score') {
      if (b.max_score !== a.max_score) return b.max_score - a.max_score;
      if (uniqueB !== uniqueA) return uniqueB - uniqueA;
      if (cntB !== cntA) return cntB - cntA;
      return (a.folder || '').localeCompare(b.folder || '');
    } else {
      return (a.folder || '').localeCompare(b.folder || '');
    }
  });
}

function jumpToUnassignedCluster(folder: string): void {
  if (!folder) return;
  ensureModeMStepExpanded('mode-m-step-1');
  if (unassignedSearchQuery) {
    unassignedSearchQuery = '';
    const searchEl = document.getElementById('mode-m-unassigned-search') as HTMLInputElement | null;
    if (searchEl) searchEl.value = '';
    expandedUnassignedFolders.add(folder);
    renderUnassignedClustersList();
  } else {
    expandedUnassignedFolders.add(folder);
  }
  const listEl = document.getElementById('mode-m-unassigned-list');
  const cards = listEl?.querySelectorAll<HTMLElement>('.unassigned-cluster-card') || [];
  let targetCard: HTMLElement | null = null;
  cards.forEach(card => {
    if (card.dataset.clusterFolder === folder) targetCard = card;
  });
  if (targetCard) {
    const card = targetCard as HTMLElement;
    card.classList.add('expanded');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('cluster-highlight');
    window.setTimeout(() => card.classList.remove('cluster-highlight'), 2200);
  }
}

function updateThresholdDriverDisplay(
  allSorted: UnassignedClusterItem[],
  visibleSorted: UnassignedClusterItem[]
): void {
  const th = plannerOverviewData?.mode_m?.threshold;
  const thPill = document.getElementById('mode-m-threshold-pill');
  const driverSlot = document.getElementById('mode-m-threshold-driver-slot');
  if (!th || th.aligned) {
    if (driverSlot) driverSlot.innerHTML = '';
    return;
  }

  const backendDriver = th.driver || null;
  const findIn = (arr: UnassignedClusterItem[]) => {
    if (backendDriver?.asset_id) {
      const byAidIdx = arr.findIndex(c => (c.assets || []).some(a => a.asset_id === backendDriver.asset_id));
      if (byAidIdx >= 0) return { idx: byAidIdx + 1, cluster: arr[byAidIdx] };
    }
    if (backendDriver?.folder) {
      const byFolderIdx = arr.findIndex(c => c.folder === backendDriver.folder);
      if (byFolderIdx >= 0) return { idx: byFolderIdx + 1, cluster: arr[byFolderIdx] };
    }
    if (arr.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < arr.length; i++) {
        if ((arr[i].max_score || 0) > (arr[bestIdx].max_score || 0)) bestIdx = i;
      }
      return { idx: bestIdx + 1, cluster: arr[bestIdx] };
    }
    return null;
  };

  const visibleMatch = findIn(visibleSorted);
  const fullMatch = findIn(allSorted);
  const resolved = visibleMatch || fullMatch;

  const folderName = resolved?.cluster.folder || backendDriver?.folder || '';
  const posNum = visibleMatch?.idx ?? fullMatch?.idx ?? backendDriver?.position ?? 0;
  const isFilteredOut = !visibleMatch && Boolean(unassignedSearchQuery) && Boolean(fullMatch);

  const cnt = resolved
    ? (resolved.cluster.assets || []).length || resolved.cluster.asset_count || 0
    : backendDriver?.asset_count || 0;
  const uniqueCnt = resolved
    ? Math.max(0, cnt - (resolved.cluster.duplicate_copy_count || 0))
    : backendDriver?.unique_count || 0;
  const filenameNote = backendDriver?.filename ? ` (${backendDriver.filename})` : '';

  if (thPill && folderName && posNum > 0) {
    const shortName = folderName.length > 26 ? `${folderName.slice(0, 24)}…` : folderName;
    thPill.textContent = `⚠️ Threshold ${(th.current || 0).toFixed(4)} > ${(th.historical_min || 0).toFixed(4)} · #${posNum} ${shortName}`;
    thPill.title = `Caused by group #${posNum}: ${folderName}${filenameNote} — ${uniqueCnt} unique / ${cnt} asset(s)`;
  }

  if (driverSlot) {
    if (!folderName || posNum <= 0) {
      driverSlot.innerHTML = '';
      return;
    }
    const statusNote = uniqueCnt === 0 ? `0 unique · ${cnt} dup` : `${uniqueCnt} unique`;
    const filterTag = isFilteredOut ? ' · hidden by filter' : '';
    driverSlot.innerHTML = `<button type="button" class="threshold-driver-pill" id="btn-jump-threshold-driver" title="Driven by${escapeHtml(filenameNote)} in cluster #${posNum} (${escapeHtml(folderName)}). Click to jump &amp; expand.">📌 #${posNum} ${escapeHtml(folderName)} (${escapeHtml(statusNote)}${escapeHtml(filterTag)})</button>`;
    document.getElementById('btn-jump-threshold-driver')?.addEventListener('click', () => {
      jumpToUnassignedCluster(folderName);
    });
  }
}

function renderUnassignedClustersStatsBar(
  allSorted: UnassignedClusterItem[],
  visibleSorted: UnassignedClusterItem[]
): void {
  const bar = document.getElementById('mode-m-clusters-stats-bar');
  if (!bar) return;
  if (!allSorted.length) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  const outstanding = allSorted.filter(c => {
    const cnt = c.assets.length || c.asset_count || 0;
    return Math.max(0, cnt - (c.duplicate_copy_count || 0)) > 0;
  });
  const completeCount = allSorted.length - outstanding.length;
  const sourceForMonths = outstanding.length > 0 ? outstanding : allSorted;

  const monthStats = new Map<string, { groups: number; assets: number }>();
  for (const c of sourceForMonths) {
    const clusterMonths = new Set<string>();
    for (const a of c.assets || []) {
      const m = (a.month || '').trim();
      if (!m) continue;
      clusterMonths.add(m);
      const cur = monthStats.get(m) || { groups: 0, assets: 0 };
      cur.assets += 1;
      monthStats.set(m, cur);
    }
    if (clusterMonths.size === 0 && c.months) {
      for (const m of c.months.split(',').map(x => x.trim()).filter(Boolean)) {
        clusterMonths.add(m);
        if (!monthStats.has(m)) monthStats.set(m, { groups: 0, assets: 0 });
      }
    }
    clusterMonths.forEach(m => {
      const cur = monthStats.get(m);
      if (cur) cur.groups += 1;
    });
  }

  const sortedMonths = Array.from(monthStats.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const filterNote = unassignedSearchQuery
    ? `<span class="badge badge-xs badge-purple font-mono">Showing ${visibleSorted.length}/${allSorted.length}</span>`
    : '';
  const completeNote =
    completeCount > 0 ? `<span class="badge badge-xs badge-green font-mono">+${completeCount} complete</span>` : '';

  const monthChipsHtml = sortedMonths
    .map(([m, st]) => {
      const isActive = unassignedSearchQuery === m.toLowerCase();
      return `<button type="button" class="unassigned-month-chip${isActive ? ' active' : ''}" data-filter-month="${escapeHtml(m)}" title="Month batch ${escapeHtml(m)}: ${st.groups} group(s), ${st.assets} asset(s) — click to filter">${escapeHtml(m)} <span>(${st.groups})</span></button>`;
    })
    .join('');

  bar.style.display = 'flex';
  bar.innerHTML = `
    <div class="unassigned-stats-summary">
      <span>📁 <strong class="text-amber">${outstanding.length}</strong> outstanding group${outstanding.length === 1 ? '' : 's'}</span>
      ${completeNote}
      ${filterNote}
      <span>•</span>
      <span>📅 <strong>${sortedMonths.length}</strong> month batch${sortedMonths.length === 1 ? '' : 'es'}:</span>
    </div>
    <div class="unassigned-months-chips">${monthChipsHtml}</div>
  `;

  bar.querySelectorAll<HTMLButtonElement>('[data-filter-month]').forEach(btn => {
    btn.addEventListener('click', () => {
      const month = (btn.dataset.filterMonth || '').trim();
      if (!month) return;
      const nextQuery = unassignedSearchQuery === month.toLowerCase() ? '' : month;
      unassignedSearchQuery = nextQuery.toLowerCase();
      const searchEl = document.getElementById('mode-m-unassigned-search') as HTMLInputElement | null;
      if (searchEl) searchEl.value = nextQuery;
      renderUnassignedClustersList();
    });
  });
}

function renderUnassignedClustersList(): void {
  const listEl = document.getElementById('mode-m-unassigned-list');
  if (!listEl) return;

  const rawClusters = plannerOverviewData?.mode_m?.unassigned_clusters || [];

  if (!rawClusters.length) {
    listEl.innerHTML = '<div class="text-center text-muted" style="padding: 1rem;">No unassigned high-rank asset clusters found.</div>';
    renderUnassignedClustersStatsBar([], []);
    updateThresholdDriverDisplay([], []);
    return;
  }

  const normalizedClusters = rawClusters
    .map(c => {
      const visibleAssets = c.assets || [];
      const dupCount = visibleAssets.filter(a => a.is_duplicate_copy).length;
      const maxScore = visibleAssets.length ? Math.max(...visibleAssets.map(a => a.score_normalized)) : c.max_score;
      const minScore = visibleAssets.length ? Math.min(...visibleAssets.map(a => a.score_normalized)) : c.min_score;
      const scoreSpan =
        visibleAssets.length <= 1 ? maxScore.toFixed(4) : `${maxScore.toFixed(4)} .. ${minScore.toFixed(4)}`;
      return {
        ...c,
        assets: visibleAssets,
        asset_count: visibleAssets.length,
        duplicate_copy_count: dupCount,
        max_score: maxScore,
        min_score: minScore,
        score_span: visibleAssets.length ? scoreSpan : c.score_span
      };
    })
    .filter(c => c.assets.length > 0);

  const allSorted = sortNormalizedClusters(normalizedClusters);

  let sorted = allSorted;
  if (unassignedSearchQuery) {
    sorted = allSorted.filter(c => {
      if ((c.folder || '').toLowerCase().includes(unassignedSearchQuery)) return true;
      if ((c.group_type || '').toLowerCase().includes(unassignedSearchQuery)) return true;
      if ((c.rule_label || '').toLowerCase().includes(unassignedSearchQuery)) return true;
      if ((c.rule_reason || '').toLowerCase().includes(unassignedSearchQuery)) return true;
      if ((c.months || '').toLowerCase().includes(unassignedSearchQuery)) return true;
      return (c.assets || []).some(
        a =>
          (a.original_filename || '').toLowerCase().includes(unassignedSearchQuery) ||
          (a.notes || '').toLowerCase().includes(unassignedSearchQuery) ||
          (a.camera_model || '').toLowerCase().includes(unassignedSearchQuery)
      );
    });
  }

  renderUnassignedClustersStatsBar(allSorted, sorted);
  updateThresholdDriverDisplay(allSorted, sorted);

  if (!sorted.length) {
    listEl.innerHTML = unassignedSearchQuery
      ? `<div class="text-center text-muted" style="padding: 1rem;">No clusters match "${escapeHtml(unassignedSearchQuery)}".</div>`
      : '<div class="text-center text-muted" style="padding: 1rem;">All visible assets in these clusters are secondary Photos duplicate copies.</div>';
    return;
  }

  clusterPreviewAssetIds.clear();

  listEl.innerHTML = sorted
    .map((cluster, idx) => {
      const assets = cluster.assets || [];
      const count = assets.length || cluster.asset_count || 0;
      const uniqueCount = Math.max(0, count - (cluster.duplicate_copy_count || 0));
      const isCompleteGroup = uniqueCount === 0;
      const isExpanded = expandedUnassignedFolders.has(cluster.folder);
      const previewableAssets = assets.filter(a => a.asset_id);
      clusterPreviewAssetIds.set(
        cluster.folder,
        previewableAssets.map(a => a.asset_id)
      );

      let typeBadgeClass = 'badge-amber';
      if (cluster.rule_id === 'misdated_duplicate_triage') {
        typeBadgeClass = 'badge-red';
      } else if ((cluster.group_type || '').includes('Proposed New')) {
        typeBadgeClass = 'badge-purple';
      } else if ((cluster.group_type || '').includes('Existing')) {
        typeBadgeClass = 'badge-green';
      }

      const sizeBadgeClass = count >= 10 ? 'badge-purple' : count >= 3 ? 'badge-amber' : 'badge-outline';

      const previewAssets = previewableAssets.slice(0, 5);
      const nextExtraAsset = previewableAssets[5];
      const extraCount = Math.max(0, previewableAssets.length - previewAssets.length);
      const extraThumbHtml =
        extraCount > 0 && nextExtraAsset
          ? `<span class="unassigned-more-thumbs" data-preview-asset-id="${escapeHtml(nextExtraAsset.asset_id)}" style="cursor: pointer;" title="Preview remaining ${extraCount} asset(s) in ${escapeHtml(cluster.folder)}">+${extraCount}</span>`
          : extraCount > 0
            ? `<span class="unassigned-more-thumbs">+${extraCount}</span>`
            : '';
      const thumbStripHtml =
        previewAssets
          .map(a => {
            const thumbUrl = `/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}`;
            const isVideo = a.media_type === 'video';
            return `
        <div class="unassigned-mini-thumb" data-preview-asset-id="${escapeHtml(a.asset_id)}" title="${escapeHtml(a.original_filename)} · Score ${a.score_normalized.toFixed(4)} · ${escapeHtml(a.capture_timestamp)} (Click to preview)">
          <img src="${thumbUrl}" loading="lazy" alt="${escapeHtml(a.original_filename)}" onerror="this.style.display='none'" />
          ${isVideo ? '<span class="mini-play-dot">▶</span>' : ''}
        </div>
      `;
          })
          .join('') + extraThumbHtml;

      const selectedInCluster = clusterAssetSelection.get(cluster.folder) || new Set<string>();
      const dateMatch = (cluster.folder || '').match(/^(\d{4}-\d{2}-\d{2})/);
      const defaultSplitPlaceholder = dateMatch
        ? `${dateMatch[1]} - New Event Name`
        : 'New Moment / Event Name';

      const rowsHtml = assets
        .map((a, aIdx) => {
          const hasUuid = Boolean(a.asset_id);
          const isRowChecked = hasUuid && selectedInCluster.has(a.asset_id);
          const isVideo = a.media_type === 'video';
          const ext = (a.original_filename.split('.').pop() || '').toUpperCase();
          const thumbUrl = hasUuid ? `/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}` : '';
          const durStr = isVideo && a.duration_sec > 0 ? formatDuration(a.duration_sec) : '';
          const sizeStr =
            a.file_size_mb > 0
              ? a.file_size_mb >= 1024
                ? `${(a.file_size_mb / 1024).toFixed(2)} GB`
                : `${a.file_size_mb.toFixed(1)} MB`
              : '—';
          const resStr = a.width && a.height ? `${a.width}×${a.height}` : '';
          const devStr = a.camera_model
            ? `${a.camera_model}${a.primary_owner && a.primary_owner !== 'Unassigned' ? ' · ' + a.primary_owner : ''}`
            : '';

          const thumbCell = hasUuid
            ? `
        <div class="cleanup-thumb-wrap" data-preview-asset-id="${escapeHtml(a.asset_id)}" title="Click to preview ${escapeHtml(a.original_filename)}" style="width: 52px; height: 38px;">
          <img class="cleanup-thumb-img" src="${thumbUrl}" loading="lazy" alt="${escapeHtml(a.original_filename)}" onerror="this.style.display='none';" />
          <span class="cleanup-thumb-badge">${escapeHtml(ext.slice(0, 4))}</span>
          ${isVideo ? '<span class="cleanup-thumb-play">▶</span>' : ''}
        </div>
      `
            : `<span class="badge badge-xs badge-outline font-mono">${escapeHtml(ext)}</span>`;

          const notesHtml = a.notes
            ? `<span class="text-amber" style="font-size: 0.68rem;">⟵ ${escapeHtml(a.notes)}</span>`
            : `<span class="text-muted" style="font-size: 0.68rem;">—</span>`;

          const actionBtn = hasUuid
            ? `<button class="btn btn-xs btn-outline btn-cleanup-preview" data-asset-id="${escapeHtml(a.asset_id)}" title="Preview full asset">👁️ Preview</button>`
            : `<span class="text-muted">—</span>`;

          const dupBadgeHtml = a.is_duplicate_copy
            ? `<span class="badge badge-xs badge-amber" style="font-size: 0.58rem; margin-left: 0.3rem;" title="Flagged by Media-Intake Dedup — click 'Intake Dedup &amp; Ignore' to move to Ignore album">♻️ Dup Copy</span>`
            : '';

          const checkboxCell =
            count > 1 && hasUuid
              ? `<td style="width: 28px;"><input type="checkbox" class="cluster-asset-checkbox" data-cluster-folder="${escapeHtml(cluster.folder)}" data-asset-id="${escapeHtml(a.asset_id)}" ${isRowChecked ? 'checked' : ''} /></td>`
              : count > 1
                ? `<td style="width: 28px;"></td>`
                : '';

          return `
        <tr>
          ${checkboxCell}
          <td class="text-muted font-mono" style="width: 28px;">${aIdx + 1}</td>
          <td style="width: 56px;">${thumbCell}</td>
          <td>
            <div class="font-mono" style="font-weight: 600; color: var(--text-primary); font-size: 0.75rem;">${escapeHtml(a.original_filename)}${dupBadgeHtml}</div>
            <div class="font-mono text-muted" style="font-size: 0.65rem;">
              ${escapeHtml([resStr, devStr].filter(Boolean).join(' · ') || a.month)}
            </div>
          </td>
          <td style="text-align: right;" class="font-mono text-amber"><strong>${a.score_normalized.toFixed(4)}</strong></td>
          <td class="font-mono" style="font-size: 0.71rem; white-space: nowrap;">${escapeHtml(a.capture_timestamp)}</td>
          <td class="font-mono" style="font-size: 0.7rem; white-space: nowrap;">
            ${isVideo ? `<span class="text-purple">🎥 ${escapeHtml(durStr || ext)}</span>` : `<span class="text-secondary">📷 ${escapeHtml(ext)}</span>`}
            <span class="text-muted"> · ${escapeHtml(sizeStr)}</span>
          </td>
          <td>${notesHtml}</td>
          <td style="text-align: right;">${actionBtn}</td>
        </tr>
      `;
        })
        .join('');

      const splitToolbarHtml =
        count > 1
          ? `
        <div class="cluster-split-toolbar" data-split-toolbar="${escapeHtml(cluster.folder)}">
          <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
            <span class="badge badge-xs ${selectedInCluster.size > 0 ? 'badge-purple' : 'badge-outline'} font-mono cluster-selected-count">${selectedInCluster.size} selected</span>
            <input
              type="text"
              class="form-control form-control-sm cluster-split-name-input"
              placeholder="${escapeHtml(defaultSplitPlaceholder)}"
              value="${dateMatch ? escapeHtml(`${dateMatch[1]} - `) : ''}"
              style="width: 250px; padding: 0.2rem 0.5rem; font-size: 0.72rem;"
            />
          </div>
          <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
            <button
              type="button"
              class="btn btn-xs btn-outline btn-split-selected-assets"
              data-split-source="${escapeHtml(cluster.folder)}"
              title="Move checked assets into a separate Proposed Moment cluster with the name above"
              ${selectedInCluster.size === 0 ? 'disabled' : ''}
            >
              ✂️ Split to Event
            </button>
            <button
              type="button"
              class="btn btn-xs btn-outline btn-remove-selected-assets"
              data-split-source="${escapeHtml(cluster.folder)}"
              title="Refuse grouping for checked assets and break them out individually"
              style="color: #fca5a5; border-color: rgba(239,68,68,0.35);"
              ${selectedInCluster.size === 0 ? 'disabled' : ''}
            >
              🚫 Remove from Group
            </button>
            <button
              type="button"
              class="btn btn-xs btn-danger btn-ignore-selected-assets"
              data-split-source="${escapeHtml(cluster.folder)}"
              title="Move checked assets directly to Apple Photos Ignore album"
              ${selectedInCluster.size === 0 ? 'disabled' : ''}
            >
              🗑️ Move Selected to Ignore
            </button>
            <button
              type="button"
              class="btn btn-xs btn-purple btn-create-moment-selected"
              data-split-source="${escapeHtml(cluster.folder)}"
              title="Apply or create an Apple Photos Moment directly from only the checked assets"
              ${selectedInCluster.size === 0 ? 'disabled' : ''}
            >
              ✨ Apply Moment (Selected)
            </button>
          </div>
        </div>
      `
          : '';

      return `
      <div class="unassigned-cluster-card ${isExpanded ? 'expanded' : ''}${isCompleteGroup ? ' cluster-complete' : ''}" data-cluster-folder="${escapeHtml(cluster.folder)}">
        <div class="unassigned-cluster-header" data-toggle-cluster="${escapeHtml(cluster.folder)}">
          <div class="unassigned-cluster-left">
            <span class="unassigned-cluster-chevron">▶</span>
            <span class="unassigned-cluster-rank font-mono">#${idx + 1}</span>
            <div class="unassigned-cluster-info">
              <div class="unassigned-cluster-title-row">
                <span class="unassigned-cluster-folder">${count === 1 && (cluster.rule_id === 'ungrouped' || cluster.rule_id === 'refused_cluster') ? '🖼️' : '📁'} ${escapeHtml(cluster.folder)}</span>
                ${isCompleteGroup
          ? `<span class="badge badge-xs badge-green font-mono" style="font-size: 0.62rem;" title="Complete — all ${count} assets in this group are flagged as duplicate copies (no unique assets remain)">✅ Complete (0 unique)</span>`
          : `<span class="badge badge-xs badge-green font-mono" style="font-size: 0.62rem;" title="Unique files identified after Media-Intake dedup (${count} total - ${cluster.duplicate_copy_count || 0} dup flagged)">✓ ${uniqueCount} unique</span>`
        }
                <span class="badge badge-xs ${sizeBadgeClass} font-mono">${count} asset${count === 1 ? '' : 's'}</span>
                <span class="badge badge-xs ${typeBadgeClass}" style="font-size: 0.64rem;">${escapeHtml(cluster.group_type)}</span>
                ${cluster.rule_label
          ? `<span class="badge badge-xs badge-outline font-mono" style="font-size: 0.61rem;" title="${escapeHtml(cluster.rule_reason || cluster.rule_label)}">⚖️ ${escapeHtml(cluster.rule_label)}</span>`
          : ''
        }
                ${(cluster.duplicate_copy_count || 0) > 0
          ? `<span class="badge badge-xs badge-amber font-mono" style="font-size: 0.62rem;" title="Potential duplicate copy flagged — review via Intake Dedup & Ignore">♻️ ${cluster.duplicate_copy_count} Dup Flagged</span>`
          : ''
        }
              </div>
              <div class="unassigned-cluster-meta-row font-mono">
                <span>Score: <strong class="text-amber">${escapeHtml(cluster.score_span)}</strong></span>
                <span>•</span>
                <span>Month(s): <strong>${escapeHtml(cluster.months)}</strong></span>
                ${cluster.rule_reason
          ? `<span>•</span><span class="text-secondary">${escapeHtml(cluster.rule_reason)}</span>`
          : ''
        }
                <span>•</span>
                <span>Log #[${cluster.orig_rank}]</span>
              </div>
            </div>
          </div>
          <div class="unassigned-cluster-right">
            <div class="unassigned-thumb-strip">
              ${thumbStripHtml}
            </div>
            ${cluster.rule_id === 'custom_split'
          ? `<button
              class="btn btn-xs btn-outline btn-clear-split-group"
              data-clear-split-group="${escapeHtml(cluster.folder)}"
              title="Undo manual event split and return assets to automatic grouping"
              style="white-space: nowrap; flex-shrink: 0;"
            >
              ↩️ Undo Split
            </button>`
          : ''
        }
            ${count > 1
          ? `<button
              class="btn btn-xs btn-outline btn-refuse-cluster-group"
              data-refuse-cluster="${escapeHtml(cluster.folder)}"
              title="Refuse '${escapeHtml(cluster.rule_label || 'grouping')}' rule for this group and split into individual assets"
              style="white-space: nowrap; flex-shrink: 0; color: #fca5a5; border-color: rgba(239,68,68,0.35);"
            >
              🚫 Refuse Group
            </button>`
          : cluster.refused_from_group
            ? `<button
              class="btn btn-xs btn-outline btn-restore-cluster-group"
              data-restore-cluster="${escapeHtml(cluster.refused_from_group)}"
              title="Restore grouping for '${escapeHtml(cluster.refused_from_group)}'"
              style="white-space: nowrap; flex-shrink: 0;"
            >
              ↩️ Re-group
            </button>`
            : ''
        }
            ${cluster.rule_id === 'misdated_duplicate_triage' || isCompleteGroup
          ? `<button
              class="btn btn-xs btn-danger btn-ignore-triage-cluster"
              data-ignore-cluster="${escapeHtml(cluster.folder)}"
              title="Move all ${count} duplicate/flagged assets into Apple Photos Ignore album"
              style="white-space: nowrap; flex-shrink: 0;"
            >
              🗑️ Ignore All (${count})
            </button>`
          : ''
        }
            <button
              class="btn btn-xs btn-purple btn-create-moment-from-cluster"
              data-cluster-folder="${escapeHtml(cluster.folder)}"
              title="Apply or create this Moment album in Apple Photos via AppleScript"
              style="white-space: nowrap; flex-shrink: 0;"
            >
              ✨ Apply Moment
            </button>
          </div>
        </div>
        <div class="unassigned-cluster-body">
          ${splitToolbarHtml}
          <table class="cleanup-table planner-compact-table">
            <thead>
              <tr>
                ${count > 1 ? `<th style="width: 28px;"><input type="checkbox" class="cluster-select-all-checkbox" data-cluster-folder="${escapeHtml(cluster.folder)}" title="Select all assets in this cluster" /></th>` : ''}
                <th>#</th>
                <th>Preview</th>
                <th>Filename &amp; Device</th>
                <th style="text-align: right;">Score</th>
                <th>Captured Timestamp</th>
                <th>Type / Length</th>
                <th>Proximity / Notes</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
    })
    .join('');

  listEl.querySelectorAll<HTMLElement>('[data-toggle-cluster]').forEach(headerEl => {
    headerEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-preview-asset-id], .btn-create-moment-from-cluster, .btn-refuse-cluster-group, .btn-restore-cluster-group, .btn-clear-split-group, .btn-ignore-triage-cluster')) return;
      const folder = headerEl.dataset.toggleCluster;
      if (!folder) return;
      if (expandedUnassignedFolders.has(folder)) {
        expandedUnassignedFolders.delete(folder);
      } else {
        expandedUnassignedFolders.add(folder);
      }
      const card = headerEl.closest('.unassigned-cluster-card');
      card?.classList.toggle('expanded', expandedUnassignedFolders.has(folder));
    });
  });

  const syncClusterToolbarUI = (cardEl: Element | null, folder: string) => {
    if (!cardEl) return;
    const sel = clusterAssetSelection.get(folder) || new Set<string>();
    const countBadge = cardEl.querySelector('.cluster-selected-count');
    if (countBadge) {
      countBadge.textContent = `${sel.size} selected`;
      countBadge.className = `badge badge-xs ${sel.size > 0 ? 'badge-purple' : 'badge-outline'} font-mono cluster-selected-count`;
    }
    cardEl.querySelectorAll<HTMLButtonElement>('.btn-split-selected-assets, .btn-remove-selected-assets, .btn-ignore-selected-assets, .btn-create-moment-selected').forEach(b => {
      b.disabled = sel.size === 0;
    });
  };

  listEl.querySelectorAll<HTMLInputElement>('.cluster-asset-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const folder = cb.dataset.clusterFolder || '';
      const aid = cb.dataset.assetId || '';
      if (!folder || !aid) return;
      if (!clusterAssetSelection.has(folder)) clusterAssetSelection.set(folder, new Set());
      const sel = clusterAssetSelection.get(folder)!;
      if (cb.checked) sel.add(aid);
      else sel.delete(aid);
      syncClusterToolbarUI(cb.closest('.unassigned-cluster-card'), folder);
    });
  });

  listEl.querySelectorAll<HTMLInputElement>('.cluster-select-all-checkbox').forEach(masterCb => {
    masterCb.addEventListener('change', () => {
      const folder = masterCb.dataset.clusterFolder || '';
      const cardEl = masterCb.closest('.unassigned-cluster-card');
      if (!folder || !cardEl) return;
      const sel = new Set<string>();
      cardEl.querySelectorAll<HTMLInputElement>('.cluster-asset-checkbox').forEach(cb => {
        cb.checked = masterCb.checked;
        if (masterCb.checked && cb.dataset.assetId) sel.add(cb.dataset.assetId);
      });
      clusterAssetSelection.set(folder, sel);
      syncClusterToolbarUI(cardEl, folder);
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-split-selected-assets').forEach(btn => {
    btn.addEventListener('click', () => {
      const folder = btn.dataset.splitSource || '';
      const sel = Array.from(clusterAssetSelection.get(folder) || []);
      if (!folder || !sel.length) return;
      const toolbar = btn.closest('.cluster-split-toolbar');
      const inputEl = toolbar?.querySelector<HTMLInputElement>('.cluster-split-name-input');
      const rawName = (inputEl?.value || '').trim();
      const targetGroup = rawName && !rawName.endsWith(' -')
        ? rawName
        : `${rawName.replace(/\s*-\s*$/, '') || 'Separate Event'} - Split Event`;
      clusterAssetSelection.delete(folder);
      expandedUnassignedFolders.add(targetGroup);
      void updateGroupingRules({
        split_asset_ids: sel,
        split_target_group: targetGroup,
        split_source_group: folder
      });
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-remove-selected-assets').forEach(btn => {
    btn.addEventListener('click', () => {
      const folder = btn.dataset.splitSource || '';
      const sel = Array.from(clusterAssetSelection.get(folder) || []);
      if (!folder || !sel.length) return;
      clusterAssetSelection.delete(folder);
      void updateGroupingRules({
        split_asset_ids: sel,
        split_target_group: '__INDIVIDUAL__',
        split_source_group: folder
      });
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ignore-selected-assets').forEach(btn => {
    btn.addEventListener('click', () => {
      const folder = btn.dataset.splitSource || '';
      const sel = Array.from(clusterAssetSelection.get(folder) || []);
      if (!folder || !sel.length) return;
      if (!window.confirm(`Move ${sel.length} selected asset(s) from "${folder}" to Apple Photos 'Ignore' album?`)) return;
      clusterAssetSelection.delete(folder);
      void moveAssetsToIgnoreAlbum(sel, btn);
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ignore-triage-cluster').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folder = btn.dataset.ignoreCluster || '';
      const cluster = (plannerOverviewData?.mode_m?.unassigned_clusters || []).find(c => c.folder === folder);
      if (!cluster) return;
      const allIds = (cluster.assets || []).map(a => a.asset_id).filter(Boolean);
      if (!allIds.length) return;
      if (!window.confirm(`Move all ${allIds.length} duplicate/flagged asset(s) in "${folder}" to Apple Photos 'Ignore' album?`)) return;
      clusterAssetSelection.delete(folder);
      void moveAssetsToIgnoreAlbum(allIds, btn);
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-create-moment-selected').forEach(btn => {
    btn.addEventListener('click', () => {
      const folder = btn.dataset.splitSource || '';
      const selSet = clusterAssetSelection.get(folder);
      const cluster = (plannerOverviewData?.mode_m?.unassigned_clusters || []).find(c => c.folder === folder);
      if (!cluster || !selSet || !selSet.size) return;
      const selectedAssets = (cluster.assets || []).filter(a => a.asset_id && selSet.has(a.asset_id));
      const allIds = selectedAssets.map(a => a.asset_id);
      const toolbar = btn.closest('.cluster-split-toolbar');
      const typedName = (toolbar?.querySelector<HTMLInputElement>('.cluster-split-name-input')?.value || '').trim();
      const prefillName = typedName && !typedName.endsWith(' -') && !/uncategorized/i.test(typedName) ? typedName : '';
      void openResolveDisjointModal(folder, prefillName, {
        assetIds: allIds,
        isUnassignedCluster: true
      });
    });
  });

  listEl.querySelectorAll<HTMLElement>('.btn-clear-split-group').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cg = btn.dataset.clearSplitGroup;
      if (cg) {
        void updateGroupingRules({ clear_split_group: cg });
      }
    });
  });

  listEl.querySelectorAll<HTMLElement>('.btn-refuse-cluster-group').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const clusterKey = btn.dataset.refuseCluster;
      if (clusterKey) {
        void updateGroupingRules({ refuse_cluster: clusterKey });
      }
    });
  });

  listEl.querySelectorAll<HTMLElement>('.btn-restore-cluster-group').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const clusterKey = btn.dataset.restoreCluster;
      if (clusterKey) {
        void updateGroupingRules({ restore_cluster: clusterKey });
      }
    });
  });

  listEl.querySelectorAll<HTMLElement>('.btn-create-moment-from-cluster').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folder = btn.dataset.clusterFolder || '';
      const cluster = (plannerOverviewData?.mode_m?.unassigned_clusters || []).find(c => c.folder === folder);
      if (!cluster) return;
      const allIds = (cluster.assets || []).map(a => a.asset_id).filter(Boolean);
      const isUncategorized = /uncategorized/i.test(cluster.folder);
      const prefillName = isUncategorized ? '' : cluster.folder;
      void openResolveDisjointModal(cluster.folder, prefillName, {
        assetIds: allIds,
        isUnassignedCluster: true
      });
    });
  });

  listEl.querySelectorAll<HTMLElement>('[data-preview-asset-id], .btn-cleanup-preview').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const aid = el.dataset.previewAssetId || el.dataset.assetId;
      if (!aid) return;
      const cardEl = el.closest<HTMLElement>('.unassigned-cluster-card');
      const folder = cardEl?.dataset.clusterFolder;
      const groupAssetIds = folder ? clusterPreviewAssetIds.get(folder) : undefined;
      if (folder && !clusterAssetSelection.has(folder)) {
        clusterAssetSelection.set(folder, new Set());
      }
      const selSet = folder ? clusterAssetSelection.get(folder) : undefined;
      const onSelectionChange =
        folder && cardEl && selSet
          ? (changedId: string, checked: boolean) => {
            const cb = cardEl.querySelector<HTMLInputElement>(
              `.cluster-asset-checkbox[data-asset-id="${CSS.escape(changedId)}"]`
            );
            if (cb) cb.checked = checked;
            const masterCb = cardEl.querySelector<HTMLInputElement>('.cluster-select-all-checkbox');
            if (masterCb) {
              const allCbs = Array.from(cardEl.querySelectorAll<HTMLInputElement>('.cluster-asset-checkbox'));
              masterCb.checked = allCbs.length > 0 && allCbs.every(item => item.checked);
            }
            syncClusterToolbarUI(cardEl, folder);
          }
          : undefined;
      openCleanupPreviewModal(
        aid,
        groupAssetIds && groupAssetIds.length > 0
          ? {
            assetIds: groupAssetIds,
            groupLabel: folder,
            hideMarkRemoved: true,
            selectedIds: selSet,
            onSelectionChange,
            onRemoveFromGroup:
              groupAssetIds.length > 1 && folder
                ? async (removingAid: string) => {
                  const activeSet = clusterAssetSelection.get(folder);
                  if (activeSet) activeSet.delete(removingAid);
                  return await updateGroupingRules({
                    split_asset_ids: [removingAid],
                    split_target_group: '__INDIVIDUAL__',
                    split_source_group: folder
                  });
                }
                : undefined
          }
          : { assetIds: [aid], hideMarkRemoved: true, selectedIds: selSet, onSelectionChange }
      );
    });
  });
}

async function moveAssetsToIgnoreAlbum(assetIds: string[], triggerBtn?: HTMLButtonElement | null): Promise<void> {
  if (!assetIds.length) return;
  const prevText = triggerBtn?.textContent || '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = `Ignoring ${assetIds.length}...`;
  }
  beginApplePhotosSyncLock(`🍎 Moving ${assetIds.length} asset(s) to Apple Photos Ignore album — UI paused until sync…`);
  try {
    const res = await fetch('/api/media/mode-m/dedup-apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_ids: assetIds })
    });
    const data: ModeMDedupApplyResponse = await res.json();
    if (!res.ok || !data.ok) {
      cancelApplePhotosSyncLock();
      window.alert(`Failed moving assets to Ignore album: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    applyOptimisticClusterRemoval(new Set(assetIds));
    await refreshModeMFull();
    finishApplePhotosActionSyncLock(
      `⏳ Moved ${assetIds.length} asset(s) to Ignore — awaiting Background DB Copy & Sync Service refresh to re-enable UI & reload browser…`
    );
  } catch (err) {
    cancelApplePhotosSyncLock();
    window.alert(`Failed moving assets to Ignore album: ${String(err)}`);
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = prevText;
    }
  }
}

async function openIntakeDedupModal(): Promise<void> {
  if (activePlannerModeView !== 'm') return;
  const modal = document.getElementById('modal-intake-dedup');
  if (!modal) return;
  modal.classList.add('open');
  await runIntakeDedupPreview();
}

function closeIntakeDedupModal(): void {
  document.getElementById('modal-intake-dedup')?.classList.remove('open');
}

async function runIntakeDedupPreview(): Promise<void> {
  if (isRunningDedupPreview) return;
  isRunningDedupPreview = true;

  const statusEl = document.getElementById('dedup-modal-status');
  const controlsBar = document.getElementById('dedup-controls-bar');
  const listEl = document.getElementById('dedup-pairs-list');
  const btnRescan = document.getElementById('btn-rescan-intake-dedup') as HTMLButtonElement | null;
  const btnApply = document.getElementById('btn-apply-intake-dedup-ignore') as HTMLButtonElement | null;

  if (btnRescan) btnRescan.disabled = true;
  if (btnApply) btnApply.disabled = true;
  if (controlsBar) controlsBar.style.display = 'none';
  if (listEl) listEl.innerHTML = '';
  if (statusEl) {
    statusEl.innerHTML = `
      <div class="spinner-sm"></div>
      <span>Running Media-Intake perceptual &amp; metadata dedup scan across unassigned assets...</span>
    `;
  }

  try {
    const res = await fetch('/api/media/mode-m/dedup-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data: ModeMDedupPreviewResponse = await res.json();

    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-red">❌ Scan failed: ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    dedupPreviewData = data;
    selectedDedupAssetIds.clear();
    (data.duplicates || []).forEach(d => selectedDedupAssetIds.add(d.duplicate_asset_id));

    renderDedupModalResults(data);
  } catch (err: any) {
    console.error('Error running intake dedup preview:', err);
    if (statusEl) {
      statusEl.innerHTML = `<span class="text-red">❌ Network error running intake dedup: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isRunningDedupPreview = false;
    if (btnRescan) btnRescan.disabled = false;
  }
}

function renderDedupModalResults(data: ModeMDedupPreviewResponse): void {
  const statusEl = document.getElementById('dedup-modal-status');
  const controlsBar = document.getElementById('dedup-controls-bar');
  const listEl = document.getElementById('dedup-pairs-list');
  const selectAllCb = document.getElementById('dedup-select-all-checkbox') as HTMLInputElement | null;

  const dups = data.duplicates || [];
  const phashNote = data.has_imagehash ? 'pHash + metadata' : 'metadata only (install imagehash for visual pHash)';

  if (statusEl) {
    statusEl.innerHTML = `
      <span>
        Scanned <strong>${data.scanned_unassigned}</strong> unassigned assets (&gt; ${data.threshold.toFixed(4)}) against
        <strong>${data.pool_size.toLocaleString()}</strong> library peers in <strong>${data.duration_sec.toFixed(2)}s</strong>
        (${escapeHtml(phashNote)}).
        Found <strong class="text-amber">${dups.length}</strong> duplicate${dups.length === 1 ? '' : 's'}
        (${formatBytes(data.reclaimable_bytes || 0)}).
      </span>
    `;
  }

  if (!dups.length) {
    if (controlsBar) controlsBar.style.display = 'none';
    if (listEl) {
      listEl.innerHTML = `
        <div class="text-center text-muted" style="padding: 2.5rem 1rem;">
          <div style="font-size: 1.6rem; margin-bottom: 0.4rem;">✅</div>
          No duplicates found among unassigned assets above cutoff ${data.threshold.toFixed(4)}.
        </div>
      `;
    }
    updateDedupSelectionUI();
    return;
  }

  if (controlsBar) controlsBar.style.display = 'flex';
  if (selectAllCb) selectAllCb.checked = true;

  if (listEl) {
    listEl.innerHTML = dups
      .map((d: ModeMDedupDuplicate) => {
        const isChecked = selectedDedupAssetIds.has(d.duplicate_asset_id);
        const dupThumb = `/api/media/cleanup/thumbnail/${encodeURIComponent(d.duplicate_asset_id)}`;
        const keepThumb = `/api/media/cleanup/thumbnail/${encodeURIComponent(d.keeper_asset_id)}`;
        const simLabel =
          typeof d.similarity_pct === 'number'
            ? `${d.similarity_pct.toFixed(1)}%${d.hamming_distance !== null ? ` · d=${d.hamming_distance}` : ''}`
            : d.match_tier;
        const keeperMomentBadge = d.keeper_moment
          ? `<span class="badge badge-xs badge-green" style="font-size: 0.62rem;">Moment: ${escapeHtml(d.keeper_moment)}</span>`
          : `<span class="badge badge-xs badge-outline" style="font-size: 0.62rem;">Unassigned Keeper</span>`;

        // Seed minimal preview metadata so clicking thumbnails opens full preview modal cleanly
        const seedMeta = (
          assetId: string,
          filename: string,
          sizeBytes: number,
          sizeMb: number,
          res: string,
          dateStr: string,
          score: number,
          momentName: string
        ): void => {
          if (candidateAssetMeta.has(assetId)) return;
          const [wStr, hStr] = (res || '').split('x');
          const extLower = (filename.split('.').pop() || '').toLowerCase();
          const isVideoExt = ['mov', 'mp4', 'm4v', 'avi'].includes(extLower);
          candidateAssetMeta.set(assetId, {
            asset_id: assetId,
            filename,
            original_filename: filename,
            camera_model: 'Library',
            primary_owner: '',
            month: dateStr.slice(0, 7),
            capture_timestamp: dateStr,
            file_size_bytes: sizeBytes,
            bytes: sizeBytes,
            file_size_mb: sizeMb,
            score_normalized: score,
            score_quartile: score > 0.5315 ? 'Top (>0.5315)' : 'Library',
            assigned_moment: momentName,
            media_type: isVideoExt ? 'video' : 'photo',
            duration_sec: 0,
            width: Number(wStr) || 0,
            height: Number(hStr) || 0,
            fps: 0
          });
        };

        seedMeta(
          d.duplicate_asset_id,
          d.duplicate_filename,
          d.duplicate_size_bytes,
          d.duplicate_size_mb,
          d.duplicate_resolution,
          d.duplicate_date,
          d.duplicate_score,
          'Duplicate (→ Ignore)'
        );
        seedMeta(
          d.keeper_asset_id,
          d.keeper_filename,
          d.keeper_size_bytes,
          d.keeper_size_mb,
          d.keeper_resolution,
          d.keeper_date,
          d.keeper_score,
          d.keeper_moment || 'Unassigned Keeper'
        );

        return `
          <div class="dedup-pair-card ${isChecked ? 'selected' : ''}" data-dup-id="${escapeHtml(d.duplicate_asset_id)}">
            <input type="checkbox" class="dedup-item-checkbox" data-dup-id="${escapeHtml(d.duplicate_asset_id)}" ${isChecked ? 'checked' : ''} />

            <div class="dedup-side">
              <img class="dedup-thumb" src="${dupThumb}" alt="${escapeHtml(d.duplicate_filename)}" loading="lazy"
                   data-dedup-preview="${escapeHtml(d.duplicate_asset_id)}"
                   data-dedup-pair="${escapeHtml(d.duplicate_asset_id)},${escapeHtml(d.keeper_asset_id)}"
                   title="Click to preview Duplicate vs Keeper" />
              <div class="dedup-side-info">
                <div style="display:flex; align-items:center; gap:0.35rem;">
                  <span class="badge badge-xs badge-red" style="font-size: 0.6rem;">DUPLICATE → IGNORE</span>
                  <span class="dedup-side-meta">Score ${d.duplicate_score.toFixed(4)}</span>
                </div>
                <div class="dedup-side-filename" title="${escapeHtml(d.duplicate_filename)}">${escapeHtml(d.duplicate_filename)}</div>
                <div class="dedup-side-meta">${d.duplicate_size_mb.toFixed(2)} MB · ${escapeHtml(d.duplicate_resolution)} · ${escapeHtml(d.duplicate_date)}</div>
              </div>
            </div>

            <div class="dedup-match-middle">
              <span class="badge badge-xs badge-purple font-mono" style="font-size: 0.62rem;">${escapeHtml(d.match_tier)}</span>
              <span class="font-mono text-muted" style="font-size: 0.66rem;">${escapeHtml(simLabel)}</span>
            </div>

            <div class="dedup-side">
              <img class="dedup-thumb" src="${keepThumb}" alt="${escapeHtml(d.keeper_filename)}" loading="lazy"
                   data-dedup-preview="${escapeHtml(d.keeper_asset_id)}"
                   data-dedup-pair="${escapeHtml(d.duplicate_asset_id)},${escapeHtml(d.keeper_asset_id)}"
                   title="Click to preview Keeper vs Duplicate" />
              <div class="dedup-side-info">
                <div style="display:flex; align-items:center; gap:0.35rem; flex-wrap:wrap;">
                  <span class="badge badge-xs badge-blue" style="font-size: 0.6rem;">KEEPER</span>
                  ${keeperMomentBadge}
                  <span class="dedup-side-meta">Score ${d.keeper_score.toFixed(4)}</span>
                </div>
                <div class="dedup-side-filename" title="${escapeHtml(d.keeper_filename)}">${escapeHtml(d.keeper_filename)}</div>
                <div class="dedup-side-meta">${d.keeper_size_mb.toFixed(2)} MB · ${escapeHtml(d.keeper_resolution)} · ${escapeHtml(d.keeper_date)}</div>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll<HTMLInputElement>('.dedup-item-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const dupId = cb.dataset.dupId;
        if (!dupId) return;
        const checked = (e.target as HTMLInputElement).checked;
        if (checked) selectedDedupAssetIds.add(dupId);
        else selectedDedupAssetIds.delete(dupId);
        cb.closest('.dedup-pair-card')?.classList.toggle('selected', checked);
        updateDedupSelectionUI();
      });
    });

    listEl.querySelectorAll<HTMLElement>('[data-dedup-preview]').forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const aid = img.dataset.dedupPreview;
        const pairIds = (img.dataset.dedupPair || '').split(',').filter(Boolean);
        if (aid) {
          openCleanupPreviewModal(aid, {
            assetIds: pairIds,
            groupLabel: 'Duplicate vs Keeper',
            hideMarkRemoved: true,
            selectedIds: selectedDedupAssetIds,
            selectableAssetIds: pairIds.length > 0 ? new Set([pairIds[0]]) : undefined,
            onSelectionChange: (changedId, checked) => {
              const cb = listEl.querySelector<HTMLInputElement>(
                `.dedup-item-checkbox[data-dup-id="${CSS.escape(changedId)}"]`
              );
              if (cb) {
                cb.checked = checked;
                cb.closest('.dedup-pair-card')?.classList.toggle('selected', checked);
              }
              updateDedupSelectionUI();
            }
          });
        }
      });
    });
  }

  updateDedupSelectionUI();
}

function updateDedupSelectionUI(): void {
  const summaryEl = document.getElementById('dedup-selection-summary');
  const btnApply = document.getElementById('btn-apply-intake-dedup-ignore') as HTMLButtonElement | null;
  const selectAllCb = document.getElementById('dedup-select-all-checkbox') as HTMLInputElement | null;

  const dups = dedupPreviewData?.duplicates || [];
  let selectedBytes = 0;
  dups.forEach(d => {
    if (selectedDedupAssetIds.has(d.duplicate_asset_id)) {
      selectedBytes += d.duplicate_size_bytes || 0;
    }
  });

  const count = selectedDedupAssetIds.size;
  if (summaryEl) {
    summaryEl.textContent = `${count} of ${dups.length} selected (${formatBytes(selectedBytes)})`;
  }
  if (btnApply) {
    btnApply.disabled = count === 0 || isApplyingDedupIgnore;
    btnApply.textContent = count > 0 ? `🚫 Add (${count}) to Ignore Album` : '🚫 Add Selected to Ignore Album';
  }
  if (selectAllCb && dups.length > 0) {
    selectAllCb.checked = dups.every(d => selectedDedupAssetIds.has(d.duplicate_asset_id));
  }
}

async function applyIntakeDedupIgnore(): Promise<void> {
  if (isApplyingDedupIgnore || !selectedDedupAssetIds.size) return;
  isApplyingDedupIgnore = true;

  const btnApply = document.getElementById('btn-apply-intake-dedup-ignore') as HTMLButtonElement | null;
  const statusEl = document.getElementById('dedup-modal-status');
  const assetIds = Array.from(selectedDedupAssetIds);

  if (btnApply) {
    btnApply.disabled = true;
    btnApply.textContent = `Adding ${assetIds.length} to Ignore...`;
  }
  beginApplePhotosSyncLock(`🍎 Adding ${assetIds.length} duplicate(s) to Apple Photos Ignore album — UI paused until sync…`);
  if (statusEl) {
    statusEl.innerHTML = `
      <div class="spinner-sm"></div>
      <span>Adding <strong>${assetIds.length}</strong> duplicate(s) to Apple Photos <code>Ignore</code> album and syncing database...</span>
    `;
  }

  try {
    const res = await fetch('/api/media/mode-m/dedup-apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_ids: assetIds })
    });
    const data: ModeMDedupApplyResponse = await res.json();

    if (!res.ok || !data.ok) {
      cancelApplePhotosSyncLock();
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-red">❌ Failed adding to Ignore album: ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    const errNote = data.errors?.length ? ` (${data.errors.length} warning(s))` : '';
    if (statusEl) {
      statusEl.innerHTML = `
        <span class="text-green">
          ✅ Added <strong>${data.photos_added}</strong> asset(s) to Apple Photos <code>${escapeHtml(data.ignore_album_path || 'Ignore')}</code>
          and updated <strong>${data.db_updated}</strong> DB record(s)${escapeHtml(errNote)}. Waiting on Background DB Sync…
        </span>
      `;
    }

    // Remove applied duplicates from local list immediately and refresh Mode [M]
    if (dedupPreviewData?.duplicates) {
      dedupPreviewData.duplicates = dedupPreviewData.duplicates.filter(d => !selectedDedupAssetIds.has(d.duplicate_asset_id));
    }
    selectedDedupAssetIds.clear();

    await refreshModeMFull();
    closeIntakeDedupModal();
    finishApplePhotosActionSyncLock(
      `⏳ Added ${assetIds.length} duplicate(s) to Ignore — awaiting Background DB Copy & Sync Service refresh to re-enable UI & reload browser…`
    );
  } catch (err: any) {
    console.error('Error applying intake dedup ignore:', err);
    cancelApplePhotosSyncLock();
    if (statusEl) {
      statusEl.innerHTML = `<span class="text-red">❌ Network error adding to Ignore: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isApplyingDedupIgnore = false;
    updateDedupSelectionUI();
  }
}

async function fetchMemoriesFolders(): Promise<void> {
  const countBadge = document.getElementById('mode-m-folders-count-badge');
  const syncBadge = document.getElementById('mode-m-folders-sync-badge');
  const tbody = document.getElementById('mode-m-folders-tbody');

  try {
    const params = new URLSearchParams({
      scope: memoriesFoldersScope,
      q: memoriesFoldersQuery,
      sort: memoriesFoldersSort,
      limit: '300'
    });
    const res = await fetch(`/api/media/memories/folders?${params.toString()}`);
    const data: MemoriesFoldersResponse = await res.json();
    foldersLoaded = true;
    memoriesFoldersData = data;

    if (!data.connected) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red">${escapeHtml(data.error || 'Database unavailable')}</td></tr>`;
      }
      return;
    }

    const sc = data.scope_counts || {};
    const scopeLabels: Record<string, string> = {
      moments: `Moments (${sc.moments ?? 0})`,
      curated: `Curated (${sc.curated ?? 0})`,
      to_be_curated: `ToBeCurated (${sc.to_be_curated ?? 0})`,
      folders: `Top Folders (${sc.folders ?? 0})`,
      all: `All (${sc.all ?? 0})`
    };
    document.querySelectorAll<HTMLElement>('.memories-scope-btn').forEach(btn => {
      const k = btn.dataset.foldersScope || '';
      if (scopeLabels[k]) btn.textContent = scopeLabels[k];
    });

    if (countBadge) {
      countBadge.textContent = `${data.total ?? data.items.length} folder${(data.total ?? data.items.length) === 1 ? '' : 's'}`;
    }
    if (syncBadge) {
      const ts = data.synced_at_utc ? data.synced_at_utc.replace('T', ' ').slice(0, 16) : 'local';
      syncBadge.textContent = `DB Copy · ${ts}`;
    }

    renderMemoriesFolders(data.items || []);
  } catch (err: any) {
    console.error('Error querying Memories/Moments folders:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red">Error querying folders: ${escapeHtml(err?.message || 'Unknown')}</td></tr>`;
    }
  }
}

function computeExpectedCuratedStats(totalCount: number): { expected: number; lnRaw: number } {
  if (!totalCount || totalCount <= 0) return { expected: 0, lnRaw: 0 };
  const lnRaw = Math.log(Math.max(1, totalCount));
  const expected = Math.min(totalCount, Math.max(1, Math.round(lnRaw)));
  return { expected, lnRaw };
}

function renderMemoriesFolders(items: MemoriesFolderItem[]): void {
  const tbody = document.getElementById('mode-m-folders-tbody');
  if (!tbody) return;

  if (!items.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="text-center text-muted">No matching folders/albums found in <code>media_organizer.db</code>.</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map(item => {
      const icon = item.is_folder ? '📁' : '📚';
      let stageHtml = '<span class="text-muted font-mono" style="font-size: 0.68rem;">—</span>';
      if (item.memory_stage) {
        const stLower = item.memory_stage.toLowerCase();
        const cls =
          stLower === 'deleted'
            ? 'badge-red'
            : item.memory_stage === 'M500'
              ? 'badge-green'
              : item.memory_stage === 'M450'
                ? 'badge-purple'
                : 'badge-blue';
        const pubNote = item.published_count > 0 ? ` · ${item.published_count} pub` : '';
        stageHtml = `<span class="badge badge-xs ${cls} font-mono">${escapeHtml(item.memory_stage)}${escapeHtml(pubNote)}</span>`;
      } else if (item.is_folder) {
        stageHtml = `<span class="badge badge-xs badge-outline font-mono">Folder</span>`;
      }

      const targetParent = item.is_folder
        ? item.album_name
        : item.parent_folder_name || 'Moments';
      const prefillName = item.is_folder ? '' : item.album_name;

      const taggedBadgeHtml = !item.is_folder
        ? renderMomentTaggedBadge(item.is_tagged, item.paradigm_confirmed, item.tag_summary)
        : '';

      return `
        <tr>
          <td>
            <div style="font-weight: 600; color: var(--text-primary); font-size: 0.76rem; display: flex; align-items: center; flex-wrap: wrap; gap: 0.2rem;">
              <span>${icon} ${escapeHtml(item.album_name)}</span>${taggedBadgeHtml}
            </div>
            <div class="memories-folder-path">${escapeHtml(item.full_path)}</div>
          </td>
          <td class="font-mono" style="font-size: 0.7rem; color: var(--text-secondary);">
            ${escapeHtml(item.parent_folder_name || 'Root')}
          </td>
          <td style="text-align: right;" class="font-mono">
            <strong>${item.asset_count}</strong>
            ${
              !item.is_folder && item.asset_count > 0
                ? `<div class="text-muted" style="font-size: 0.63rem;" title="Expected curated count = round(ln(${item.asset_count})) = ${computeExpectedCuratedStats(item.asset_count).lnRaw.toFixed(2)}">🎯 exp ${computeExpectedCuratedStats(item.asset_count).expected}</div>`
                : ''
            }
          </td>
          <td>${stageHtml}</td>
          <td style="text-align: right;">
            <div style="display: inline-flex; align-items: center; gap: 0.35rem;">
              <button
                type="button"
                class="btn btn-xs btn-outline btn-retag-memories-folder"
                data-moment-name="${escapeHtml(item.album_name)}"
                title="Inspect, tag, or retag '${escapeHtml(item.album_name)}' in DB"
              >🏷️ Tag</button>
              <button
                type="button"
                class="btn btn-xs btn-outline btn-use-memories-folder"
                data-folder-name="${escapeHtml(prefillName)}"
                data-parent-folder="${escapeHtml(targetParent)}"
                title="Open AppleScript Create/Update Moment with this folder/album pre-selected"
              >
                ${item.is_folder ? '+ New Inside' : '✨ Select'}
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll<HTMLElement>('.btn-retag-memories-folder').forEach(btn => {
    btn.addEventListener('click', () => {
      const mName = btn.dataset.momentName || '';
      if (mName) void openResolveDisjointModal(mName, '', { isHistoricalMoment: true });
    });
  });

  tbody.querySelectorAll<HTMLElement>('.btn-use-memories-folder').forEach(btn => {
    btn.addEventListener('click', () => {
      openCreateMomentModal({
        prefillName: btn.dataset.folderName || '',
        parentFolder: btn.dataset.parentFolder || 'Moments'
      });
    });
  });
}

function openCreateMomentModal(opts?: {
  prefillName?: string;
  parentFolder?: string;
  sourceClusterFolder?: string;
  uniqueAssetIds?: string[];
  allAssetIds?: string[];
  duplicateCount?: number;
}): void {
  const modal = document.getElementById('modal-create-moment');
  if (!modal) return;

  const nameInput = document.getElementById('create-moment-name-input') as HTMLInputElement | null;
  const parentSelect = document.getElementById('create-moment-parent-select') as HTMLSelectElement | null;
  const statusEl = document.getElementById('create-moment-status');
  const excludeDupsCb = document.getElementById('create-moment-exclude-dups') as HTMLInputElement | null;
  const ignoreDupsCb = document.getElementById('create-moment-ignore-dups') as HTMLInputElement | null;
  const emptyOnlyCb = document.getElementById('create-moment-empty-only') as HTMLInputElement | null;

  createMomentCtx = {
    sourceClusterFolder: opts?.sourceClusterFolder,
    uniqueAssetIds: opts?.uniqueAssetIds || [],
    allAssetIds: opts?.allAssetIds || [],
    duplicateCount: opts?.duplicateCount || 0
  };

  if (parentSelect) {
    const desired = opts?.parentFolder || 'Moments';
    const hasOption = Array.from(parentSelect.options).some(o => o.value === desired);
    if (!hasOption && desired) {
      const opt = document.createElement('option');
      opt.value = desired;
      opt.textContent = desired;
      parentSelect.appendChild(opt);
    }
    parentSelect.value = desired;
  }

  if (nameInput) {
    nameInput.value = opts?.prefillName ?? '';
  }
  if (excludeDupsCb) excludeDupsCb.checked = true;
  if (ignoreDupsCb) ignoreDupsCb.checked = true;
  if (emptyOnlyCb) emptyOnlyCb.checked = false;
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.innerHTML = '';
  }

  updateCreateMomentTargetPath();
  updateCreateMomentAssetsUI();
  setCreateMomentModalCompletedState(false);
  modal.classList.add('open');
  void checkExistingMemoriesMatch((nameInput?.value || '').trim());
  window.setTimeout(() => nameInput?.focus(), 40);
}

function setCreateMomentModalCompletedState(completed: boolean): void {
  createMomentCompleted = completed;
  const btnCancel = document.getElementById('btn-cancel-create-moment') as HTMLButtonElement | null;
  const btnSubmit = document.getElementById('btn-submit-create-moment') as HTMLButtonElement | null;
  if (btnCancel) {
    btnCancel.style.display = completed ? 'none' : '';
    btnCancel.disabled = false;
  }
  if (btnSubmit) {
    btnSubmit.disabled = false;
    if (completed) {
      btnSubmit.className = 'btn btn-green';
      btnSubmit.textContent = '✅ OK';
    } else {
      btnSubmit.className = 'btn btn-purple';
      btnSubmit.textContent = '🍎 Apply Moment via AppleScript';
    }
  }
}

async function refreshModeMFull(triggerBtn?: HTMLButtonElement | null): Promise<void> {
  const prevText = triggerBtn?.textContent || '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = '🔄 Refreshing...';
  }
  try {
    await Promise.all([fetchMemoriesFolders(), fetchPlannerOverview(true, 'm')]);
    if (plannerRefreshExecutorCb) plannerRefreshExecutorCb();
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = prevText;
    }
  }
}

function closeCreateMomentModal(): void {
  document.getElementById('modal-create-moment')?.classList.remove('open');
}

function updateCreateMomentTargetPath(): void {
  const nameInput = document.getElementById('create-moment-name-input') as HTMLInputElement | null;
  const parentSelect = document.getElementById('create-moment-parent-select') as HTMLSelectElement | null;
  const pathEl = document.getElementById('create-moment-target-path');
  if (!pathEl) return;
  const p = (parentSelect?.value || 'Moments').trim();
  const n = (nameInput?.value || '<Moment Name>').trim() || '<Moment Name>';
  pathEl.textContent =
    p === 'Media Organizer on LaCie' ? `Path: ${p}/${n}` : `Path: Media Organizer on LaCie/${p}/${n}`;
}

function getSelectedAssetIdsForCreateMoment(): string[] {
  const emptyOnlyCb = document.getElementById('create-moment-empty-only') as HTMLInputElement | null;
  const excludeDupsCb = document.getElementById('create-moment-exclude-dups') as HTMLInputElement | null;
  if (emptyOnlyCb?.checked) return [];
  if (excludeDupsCb?.checked) return createMomentCtx.uniqueAssetIds;
  return createMomentCtx.allAssetIds;
}

function getExcludedDuplicateIdsForCreateMoment(): string[] {
  const emptyOnlyCb = document.getElementById('create-moment-empty-only') as HTMLInputElement | null;
  const excludeDupsCb = document.getElementById('create-moment-exclude-dups') as HTMLInputElement | null;
  const ignoreDupsCb = document.getElementById('create-moment-ignore-dups') as HTMLInputElement | null;
  if (emptyOnlyCb?.checked || !excludeDupsCb?.checked || !ignoreDupsCb?.checked) return [];
  const uniqueSet = new Set(createMomentCtx.uniqueAssetIds);
  return createMomentCtx.allAssetIds.filter(id => !uniqueSet.has(id));
}

function updateCreateMomentAssetsUI(): void {
  const box = document.getElementById('create-moment-assets-box');
  const summaryEl = document.getElementById('create-moment-cluster-summary');
  const countPill = document.getElementById('create-moment-asset-count-pill');
  const dupLabel = document.getElementById('create-moment-exclude-dups-label');
  const excludeDupsCb = document.getElementById('create-moment-exclude-dups') as HTMLInputElement | null;
  const ignoreDupsRow = document.getElementById('create-moment-ignore-dups-row');
  const ignoreDupsCb = document.getElementById('create-moment-ignore-dups') as HTMLInputElement | null;
  const ignoreDupsLabel = document.getElementById('create-moment-ignore-dups-label');
  const emptyOnlyCb = document.getElementById('create-moment-empty-only') as HTMLInputElement | null;
  if (!box) return;

  if (!createMomentCtx.allAssetIds.length) {
    box.style.display = 'none';
    return;
  }

  box.style.display = 'block';
  const totalCount = createMomentCtx.allAssetIds.length;
  const uniqueCount = createMomentCtx.uniqueAssetIds.length;
  const dupCount = Math.max(createMomentCtx.duplicateCount, totalCount - uniqueCount);

  if (summaryEl) {
    summaryEl.textContent = createMomentCtx.sourceClusterFolder
      ? `Cluster: ${createMomentCtx.sourceClusterFolder} (${uniqueCount} unique / ${totalCount} total)`
      : `${uniqueCount} unique / ${totalCount} selected assets`;
  }
  if (dupLabel) {
    dupLabel.textContent =
      dupCount > 0
        ? `Exclude ${dupCount} duplicate-flagged asset(s) (add ${uniqueCount} unique only)`
        : `All ${totalCount} asset(s) are unique`;
  }
  if (excludeDupsCb) {
    excludeDupsCb.disabled = Boolean(emptyOnlyCb?.checked);
  }
  if (ignoreDupsRow) {
    const showIgnore = dupCount > 0 && Boolean(excludeDupsCb?.checked) && !emptyOnlyCb?.checked;
    ignoreDupsRow.style.display = showIgnore ? 'flex' : 'none';
    if (ignoreDupsCb) ignoreDupsCb.disabled = !showIgnore;
    if (ignoreDupsLabel) {
      ignoreDupsLabel.textContent = `Also move ${dupCount} excluded duplicate(s) to Apple Photos Ignore album`;
    }
  }

  const willAdd = getSelectedAssetIdsForCreateMoment().length;
  if (countPill) {
    countPill.textContent = willAdd > 0 ? `+${willAdd} asset${willAdd === 1 ? '' : 's'}` : '0 assets (empty album)';
  }
}

async function checkExistingMemoriesMatch(query: string): Promise<void> {
  const hintEl = document.getElementById('create-moment-existing-hint');
  if (!hintEl) return;

  const q = query.trim();
  if (!q) {
    const sampleCount = memoriesFoldersData?.scope_counts?.moments ?? memoriesFoldersData?.total ?? 0;
    hintEl.innerHTML = `Type a Moment name to match against <strong>${sampleCount}</strong> synced Moments folders in <code>media_organizer.db</code> (no Apple Photos DB query).`;
    return;
  }

  try {
    const params = new URLSearchParams({ scope: 'moments', q, limit: '8' });
    const res = await fetch(`/api/media/memories/folders?${params.toString()}`);
    const data: MemoriesFoldersResponse = await res.json();
    const matches = data.items || [];
    const exactMatch = matches.find(m => m.album_name.toLowerCase() === q.toLowerCase());

    if (exactMatch) {
      hintEl.innerHTML = `
        <span class="text-amber">
          ⚠️ Existing folder match in <code>media_organizer.db</code>:
          <strong>${escapeHtml(exactMatch.full_path)}</strong> (${exactMatch.asset_count} assets)
        </span>
      `;
    } else if (matches.length > 0) {
      const chips = matches
        .slice(0, 4)
        .map(
          m =>
            `<button type="button" class="create-moment-match-chip" data-pick-moment="${escapeHtml(m.album_name)}" title="${escapeHtml(m.full_path)}">${escapeHtml(m.album_name)} (${m.asset_count})</button>`
        )
        .join(' ');
      hintEl.innerHTML = `
        <div style="display:flex; align-items:center; gap:0.35rem; flex-wrap:wrap;">
          <span class="text-muted">Similar synced folders:</span> ${chips}
        </div>
      `;
      hintEl.querySelectorAll<HTMLElement>('[data-pick-moment]').forEach(chip => {
        chip.addEventListener('click', () => {
          const inp = document.getElementById('create-moment-name-input') as HTMLInputElement | null;
          if (inp && chip.dataset.pickMoment) {
            inp.value = chip.dataset.pickMoment;
            updateCreateMomentTargetPath();
            void checkExistingMemoriesMatch(inp.value);
          }
        });
      });
    } else {
      hintEl.innerHTML = `<span class="text-green">✨ New Moment — no existing album named "<strong>${escapeHtml(q)}</strong>" found in <code>media_organizer.db</code>.</span>`;
    }
  } catch {
    // non-fatal hint check
  }
}

function applyOptimisticClusterRemoval(removedIds: Set<string>): void {
  if (!removedIds.size || !plannerOverviewData?.mode_m?.unassigned_clusters) return;
  const clusters = plannerOverviewData.mode_m.unassigned_clusters;
  const nextClusters = [];
  for (const c of clusters) {
    const remainingAssets = (c.assets || []).filter(a => !removedIds.has(a.asset_id));
    if (!remainingAssets.length) continue;
    const dupCnt = remainingAssets.filter(a => a.is_duplicate_copy).length;
    nextClusters.push({
      ...c,
      assets: remainingAssets,
      asset_count: remainingAssets.length,
      duplicate_copy_count: dupCnt
    });
  }
  plannerOverviewData.mode_m.unassigned_clusters = nextClusters;
  plannerOverviewData.mode_m.unassigned_total_clusters = nextClusters.length;
  plannerOverviewData.mode_m.unassigned_total_assets = nextClusters.reduce(
    (sum, c) => sum + (c.assets?.length || c.asset_count || 0),
    0
  );
  renderModeMOverview(plannerOverviewData.mode_m);
}

async function submitCreateMoment(): Promise<void> {
  if (createMomentCompleted) {
    closeCreateMomentModal();
    return;
  }
  if (isSubmittingCreateMoment) return;
  const nameInput = document.getElementById('create-moment-name-input') as HTMLInputElement | null;
  const parentSelect = document.getElementById('create-moment-parent-select') as HTMLSelectElement | null;
  const allowExistingCb = document.getElementById('create-moment-allow-existing') as HTMLInputElement | null;
  const statusEl = document.getElementById('create-moment-status');
  const btnCancel = document.getElementById('btn-cancel-create-moment') as HTMLButtonElement | null;
  const btnSubmit = document.getElementById('btn-submit-create-moment') as HTMLButtonElement | null;

  const momentName = (nameInput?.value || '').trim();
  const parentFolder = (parentSelect?.value || 'Moments').trim() || 'Moments';
  const allowExisting = allowExistingCb ? allowExistingCb.checked : true;
  const assetIds = getSelectedAssetIdsForCreateMoment();
  const ignoreAssetIds = getExcludedDuplicateIdsForCreateMoment();

  if (!momentName) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">⚠️ Please enter a Moment album name.</span>';
    }
    nameInput?.focus();
    return;
  }

  isSubmittingCreateMoment = true;
  if (btnCancel) btnCancel.disabled = true;
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Running AppleScript...';
  }
  beginApplePhotosSyncLock(`🍎 Updating Apple Photos (${momentName}) — UI paused until sync…`);
  if (statusEl) {
    statusEl.style.display = 'flex';
    const ignNote = ignoreAssetIds.length ? ` and moving ${ignoreAssetIds.length} duplicate(s) to Ignore` : '';
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>Applying Moment <code>${escapeHtml(momentName)}</code> in Apple Photos via AppleScript${assetIds.length ? ` and adding ${assetIds.length} asset(s)` : ''}${escapeHtml(ignNote)}...</span>`;
  }

  let succeeded = false;
  try {
    const res = await fetch('/api/media/memories/create-moment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moment_name: momentName,
        parent_folder: parentFolder,
        asset_ids: assetIds,
        ignore_asset_ids: ignoreAssetIds,
        allow_existing: allowExisting
      })
    });
    const data: CreateMomentResponse = await res.json();

    if (!res.ok || !data.ok) {
      cancelApplePhotosSyncLock();
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    // Clear selection and immediately update UI cluster list while authoritative DB refresh runs
    if (createMomentCtx.sourceClusterFolder) {
      clusterAssetSelection.delete(createMomentCtx.sourceClusterFolder);
    }
    applyOptimisticClusterRemoval(new Set([...assetIds, ...ignoreAssetIds]));

    await refreshModeMFull();
    unifiedGroupingAssetsCache.clear();
    allGroupingsLoaded = false;
    if (activePlannerModeView === 'g') {
      await fetchAllUnifiedGroupings(true);
    }
    closeCreateMomentModal();
    if ((data as any).library_target === 'organizer') {
      cancelApplePhotosSyncLock();
    } else {
      finishApplePhotosActionSyncLock(
        `⏳ Apple Photos updated (${momentName}) — awaiting Background DB Copy & Sync Service refresh to re-enable UI & reload browser…`
      );
    }
    succeeded = true;
  } catch (err: any) {
    console.error('Error creating Moment via AppleScript:', err);
    cancelApplePhotosSyncLock();
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isSubmittingCreateMoment = false;
    setCreateMomentModalCompletedState(succeeded);
  }
}

function renderGroupingRulesPanel(): void {
  const gr = plannerOverviewData?.mode_m?.grouping_rules;
  const gridEl = document.getElementById('mode-m-rules-grid');
  const summaryBadge = document.getElementById('mode-m-rules-summary-badge');
  const resetBtn = document.getElementById('btn-reset-grouping-rules') as HTMLButtonElement | null;
  const refusedBar = document.getElementById('mode-m-refused-clusters-bar');
  if (!gridEl || !gr) return;

  const rules = gr.rules || [];
  const refusedClusters = gr.refused_clusters || [];
  const customSplitGroups = gr.custom_split_groups || [];
  const activeCount = rules.filter(r => r.enabled).length;
  const refusedRuleCount = rules.length - activeCount;

  if (summaryBadge) {
    const parts = [`${activeCount}/${rules.length} active`];
    if (refusedRuleCount > 0) parts.push(`${refusedRuleCount} rule refused`);
    if (refusedClusters.length + customSplitGroups.length > 0) {
      parts.push(`${refusedClusters.length + customSplitGroups.length} group override`);
    }
    summaryBadge.textContent = parts.join(' · ');
  }

  const hasNonDefault =
    rules.some(r => {
      const def = r.id === 'time_gps_session' ? false : true;
      return r.enabled !== def;
    }) ||
    refusedClusters.length > 0 ||
    customSplitGroups.length > 0;
  if (resetBtn) {
    resetBtn.style.display = hasNonDefault ? 'inline-flex' : 'none';
  }

  gridEl.innerHTML = rules
    .map(r => {
      const stateBadge = r.enabled
        ? `<span class="badge badge-xs badge-green font-mono" style="font-size: 0.6rem;">ACTIVE</span>`
        : `<span class="badge badge-xs badge-red font-mono" style="font-size: 0.6rem;">REFUSED</span>`;
      const actionBtn = r.enabled
        ? `<button class="btn btn-xs btn-outline btn-toggle-grouping-rule" data-rule-id="${escapeHtml(r.id)}" data-next-enabled="0" title="Refuse this rule and re-evaluate groupings" style="color: #fca5a5; border-color: rgba(239,68,68,0.35);">🚫 Refuse Rule</button>`
        : `<button class="btn btn-xs btn-outline btn-toggle-grouping-rule" data-rule-id="${escapeHtml(r.id)}" data-next-enabled="1" title="Accept / enable this grouping rule" style="color: #6ee7b7; border-color: rgba(16,185,129,0.35);">✅ Enable Rule</button>`;
      const matchSummary =
        r.enabled && r.asset_count > 0
          ? `${r.cluster_count} group${r.cluster_count === 1 ? '' : 's'} · ${r.asset_count} assets`
          : r.enabled
            ? '0 matches'
            : 'Refused (disabled)';

      return `
        <div class="grouping-rule-card ${r.enabled ? 'rule-enabled' : 'rule-refused'}">
          <div>
            <div class="grouping-rule-top">
              <span class="grouping-rule-name">
                <span class="font-mono text-muted" style="font-size: 0.68rem;">#${r.priority}</span>
                ${escapeHtml(r.name)}
              </span>
              ${stateBadge}
            </div>
            <div class="grouping-rule-desc">${escapeHtml(r.description)}</div>
          </div>
          <div class="grouping-rule-footer">
            <span class="font-mono text-muted" style="font-size: 0.66rem;">${escapeHtml(matchSummary)}</span>
            ${actionBtn}
          </div>
        </div>
      `;
    })
    .join('');

  gridEl.querySelectorAll<HTMLButtonElement>('.btn-toggle-grouping-rule').forEach(btn => {
    btn.addEventListener('click', () => {
      const ruleId = btn.dataset.ruleId;
      const nextEnabled = btn.dataset.nextEnabled === '1';
      if (!ruleId) return;
      void updateGroupingRules({ rules: { [ruleId]: nextEnabled } });
    });
  });

  if (refusedBar) {
    if (!refusedClusters.length && !customSplitGroups.length) {
      refusedBar.style.display = 'none';
      refusedBar.innerHTML = '';
    } else {
      refusedBar.style.display = 'flex';
      const refusedHtml = refusedClusters
        .map(
          ck =>
            `<button type="button" class="grouping-refused-chip" data-restore-refused="${escapeHtml(ck)}" title="Click to restore grouping for ${escapeHtml(ck)}">🚫 ${escapeHtml(ck)} ✕</button>`
        )
        .join('');
      const splitHtml = customSplitGroups
        .map(
          sg =>
            `<button type="button" class="grouping-refused-chip grouping-split-chip" data-clear-split="${escapeHtml(sg)}" title="Click to undo split event '${escapeHtml(sg)}'">✂️ ${escapeHtml(sg)} ✕</button>`
        )
        .join('');
      refusedBar.innerHTML =
        `<span class="text-muted">Group Overrides:</span>` + refusedHtml + splitHtml;
      refusedBar.querySelectorAll<HTMLElement>('[data-restore-refused]').forEach(chip => {
        chip.addEventListener('click', () => {
          const ck = chip.dataset.restoreRefused;
          if (ck) void updateGroupingRules({ restore_cluster: ck });
        });
      });
      refusedBar.querySelectorAll<HTMLElement>('[data-clear-split]').forEach(chip => {
        chip.addEventListener('click', () => {
          const sg = chip.dataset.clearSplit;
          if (sg) void updateGroupingRules({ clear_split_group: sg });
        });
      });
    }
  }
}

async function updateGroupingRules(payload: {
  rules?: Record<string, boolean>;
  refuse_cluster?: string;
  restore_cluster?: string;
  split_asset_ids?: string[];
  split_target_group?: string;
  split_source_group?: string;
  clear_split_group?: string;
  clear_split_asset_ids?: string[];
  reset_defaults?: boolean;
}): Promise<boolean> {
  if (isUpdatingGroupingRules) return false;
  isUpdatingGroupingRules = true;
  const badge = document.getElementById('mode-m-rules-summary-badge');
  if (badge) badge.textContent = 'Updating rules...';

  try {
    const res = await fetch('/api/media/mode-m/grouping-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert(`Failed updating grouping rules: ${data.error || `HTTP ${res.status}`}`);
      return false;
    }
    await fetchPlannerOverview(true, 'm');
    return true;
  } catch (err: any) {
    console.error('Error updating grouping rules:', err);
    alert(`Network error updating grouping rules: ${err?.message || 'Unknown error'}`);
    return false;
  } finally {
    isUpdatingGroupingRules = false;
  }
}

function setPublishModalCompletedState(completed: boolean): void {
  publishMomentCompleted = completed;
  const btnCancel = document.getElementById('btn-cancel-publish-moment') as HTMLButtonElement | null;
  const btnSubmit = document.getElementById('btn-submit-publish-moment') as HTMLButtonElement | null;
  if (btnCancel) {
    btnCancel.style.display = completed ? 'none' : '';
    btnCancel.disabled = false;
  }
  if (btnSubmit) {
    btnSubmit.disabled = false;
    if (completed) {
      btnSubmit.className = 'btn btn-green';
      btnSubmit.textContent = '✅ OK';
    } else {
      btnSubmit.className = 'btn btn-purple';
      btnSubmit.textContent = '✅ Record Publication';
    }
  }
}

function closePublishMomentModal(): void {
  document.getElementById('modal-publish-moment')?.classList.remove('open');
}

function syncPublishOpenLinks(): void {
  const sfInp = document.getElementById('publish-moment-sf-url') as HTMLInputElement | null;
  const ytInp = document.getElementById('publish-moment-yt-url') as HTMLInputElement | null;
  const sfLink = document.getElementById('publish-sf-open-link') as HTMLAnchorElement | null;
  const ytLink = document.getElementById('publish-yt-open-link') as HTMLAnchorElement | null;
  if (sfLink) {
    const val = (sfInp?.value || '').trim();
    sfLink.href = /^https?:\/\//i.test(val) ? val : 'https://photos.shutterfly.com/';
  }
  if (ytLink) {
    const val = (ytInp?.value || '').trim();
    ytLink.href = /^https?:\/\//i.test(val) ? val : 'https://www.youtube.com/';
  }
}

function getPublishSelectedKey(): string {
  return publishMomentAssets
    .filter(a => publishSelectedAssetIds.has(a.asset_id))
    .map(a => a.asset_id)
    .join(',');
}

function isPublishCurationDirty(): boolean {
  return publishSkippedAssetIds.size > 0 || getPublishSelectedKey() !== publishInitialSelectedKey;
}

function resetPublishInitialTopSelection(): void {
  publishSelectedAssetIds.clear();
  publishSkippedAssetIds.clear();
  publishAutoPromotedIds.clear();
  const targetN = Math.min(9, publishMomentAssets.length);
  publishTargetBatchSize = targetN || 9;
  publishMomentAssets.slice(0, targetN).forEach(a => publishSelectedAssetIds.add(a.asset_id));
  publishInitialSelectedKey = getPublishSelectedKey();
}

function applyPublishAssetToggle(aid: string, nextChecked: boolean): void {
  if (!aid) return;
  const targetGoal = Math.min(9, publishMomentAssets.length);
  if (!nextChecked) {
    publishSelectedAssetIds.delete(aid);
    publishAutoPromotedIds.delete(aid);
    publishSkippedAssetIds.add(aid);
    // Propose next available asset(s) from the ranked queue to stay at target (9)
    for (const cand of publishMomentAssets) {
      if (publishSelectedAssetIds.size >= targetGoal) break;
      if (!publishSelectedAssetIds.has(cand.asset_id) && !publishSkippedAssetIds.has(cand.asset_id)) {
        publishSelectedAssetIds.add(cand.asset_id);
        publishAutoPromotedIds.add(cand.asset_id);
      }
    }
  } else {
    publishSkippedAssetIds.delete(aid);
    publishSelectedAssetIds.add(aid);
    // If restoring a higher-ranked asset pushed selection above 9, return the lowest-ranked auto-promoted item to standby queue
    while (publishSelectedAssetIds.size > targetGoal && publishAutoPromotedIds.size > 0) {
      let lowestPromotedId = '';
      for (let i = publishMomentAssets.length - 1; i >= 0; i--) {
        const candId = publishMomentAssets[i].asset_id;
        if (candId !== aid && publishAutoPromotedIds.has(candId) && publishSelectedAssetIds.has(candId)) {
          lowestPromotedId = candId;
          break;
        }
      }
      if (!lowestPromotedId) break;
      publishSelectedAssetIds.delete(lowestPromotedId);
      publishAutoPromotedIds.delete(lowestPromotedId);
    }
  }
  renderPublishMomentAssets();
}

function updatePublishMomentSelectionSummary(): void {
  const headingEl = document.getElementById('publish-moment-assets-heading');
  const pill = document.getElementById('publish-moment-selected-pill');
  const skippedPill = document.getElementById('publish-moment-skipped-pill');
  const queuePill = document.getElementById('publish-moment-queue-pill');
  const applyCurBtn = document.getElementById('btn-publish-apply-curation') as HTMLButtonElement | null;
  const breakdownEl = document.getElementById('publish-moment-breakdown');

  const selected = publishMomentAssets.filter(a => publishSelectedAssetIds.has(a.asset_id));
  const skippedCount = publishSkippedAssetIds.size;
  const standbyCount = publishMomentAssets.filter(
    a => !publishSelectedAssetIds.has(a.asset_id) && !publishSkippedAssetIds.has(a.asset_id)
  ).length;
  const targetGoal = Math.min(9, Math.max(0, publishMomentAssets.length - skippedCount));

  if (headingEl) {
    headingEl.textContent = `Curate Next Publishing Batch (Target: ${Math.min(9, publishMomentAssets.length || 9)} Assets)`;
  }
  const photosCnt = selected.filter(a => a.media_type !== 'video').length;
  const videosCnt = selected.filter(a => a.media_type === 'video').length;
  if (pill) {
    pill.textContent = `${selected.length}${targetGoal > 0 ? ` / ${targetGoal}` : ''} selected`;
  }
  if (skippedPill) {
    skippedPill.style.display = skippedCount > 0 ? 'inline-flex' : 'none';
    skippedPill.textContent = `⏭️ ${skippedCount} ➜ SkipPublishing`;
  }
  if (queuePill) {
    queuePill.style.display = standbyCount > 0 ? 'inline-flex' : 'none';
    queuePill.textContent = `⏳ ${standbyCount} in queue`;
  }
  if (applyCurBtn) {
    const dirty = isPublishCurationDirty();
    applyCurBtn.style.display = dirty && !publishMomentCompleted ? 'inline-flex' : 'none';
    applyCurBtn.disabled = isApplyingPublishCuration || isSubmittingPublishMoment;
    if (!isApplyingPublishCuration) {
      applyCurBtn.textContent =
        skippedCount > 0
          ? `✅ Apply Curation (${skippedCount} ➜ SkipPublishing)`
          : '🔄 Sync Selected to Pub. Rec';
    }
  }
  if (breakdownEl) {
    const skipSuffix = skippedCount > 0 ? ` · ⏭️ ${skippedCount} unselected ➜ SkipPublishing` : '';
    breakdownEl.textContent = selected.length
      ? `📷 ${photosCnt} Photo(s) → Shutterfly · 🎥 ${videosCnt} Video(s) → YouTube${skipSuffix}`
      : 'Select at least 1 asset to record';
  }
}

function registerPublishAssetsForPreview(assets: PublishMomentAssetItem[], momentName: string): void {
  assets.forEach(a => {
    const bytes = a.file_size_bytes || 0;
    candidateAssetMeta.set(a.asset_id, {
      asset_id: a.asset_id,
      filename: a.filename,
      original_filename: a.filename,
      camera_model: a.camera_model || 'Library',
      primary_owner: a.primary_owner || '',
      month: (a.date_created_utc || '').slice(0, 7),
      date_created_utc: a.date_created_utc || '',
      capture_timestamp: a.date_created_utc || '',
      file_size_bytes: bytes,
      bytes,
      file_size_mb: bytes / (1024 * 1024),
      score_normalized: a.score,
      score_quartile: 'Curated',
      assigned_moment: momentName,
      asset_tags: a.asset_tags,
      media_type: a.media_type,
      duration_sec: a.duration || 0,
      width: a.width || 0,
      height: a.height || 0,
      fps: 0
    });
  });
}

function renderPublishMomentAssets(): void {
  const listEl = document.getElementById('publish-moment-asset-list');
  if (!listEl) return;

  if (!publishMomentAssets.length) {
    listEl.innerHTML =
      '<div class="text-center text-muted" style="padding: 1rem;">No unpublished curated assets remain for this Moment.</div>';
    updatePublishMomentSelectionSummary();
    return;
  }

  const allAssetIds = publishMomentAssets.map(a => a.asset_id);
  const activeRows: Array<{ asset: PublishMomentAssetItem; idx: number }> = [];
  const standbyRows: Array<{ asset: PublishMomentAssetItem; idx: number }> = [];
  const keeperRankMap = new Map<string, number>();
  let kCounter = 0;
  publishMomentAssets.forEach(a => {
    if (publishSelectedAssetIds.has(a.asset_id)) {
      kCounter += 1;
      keeperRankMap.set(a.asset_id, kCounter);
    }
  });
  const targetDenom = Math.min(9, Math.max(1, publishMomentAssets.length - publishSkippedAssetIds.size));

  const filterBtn = document.getElementById('btn-publish-hide-unselected');
  if (filterBtn) {
    filterBtn.classList.toggle('btn-purple', publishFilterCuratedOnly);
    filterBtn.classList.toggle('btn-outline', !publishFilterCuratedOnly);
    filterBtn.textContent = publishFilterCuratedOnly
      ? `★ Curated Only (${publishSelectedAssetIds.size})`
      : '👁️ Curated Only';
  }

  publishMomentAssets.forEach((a, idx) => {
    if (publishFilterCuratedOnly && !publishSelectedAssetIds.has(a.asset_id)) {
      return;
    }
    if (publishSelectedAssetIds.has(a.asset_id) || publishSkippedAssetIds.has(a.asset_id)) {
      activeRows.push({ asset: a, idx });
    } else {
      standbyRows.push({ asset: a, idx });
    }
  });

  const renderRow = (a: PublishMomentAssetItem, idx: number, isStandby: boolean): string => {
    const checked = publishSelectedAssetIds.has(a.asset_id);
    const isSkipped = publishSkippedAssetIds.has(a.asset_id);
    const isPromoted = checked && publishAutoPromotedIds.has(a.asset_id);
    const kRank = keeperRankMap.get(a.asset_id) || 0;
    const rowCls = checked ? ' is-selected' : isSkipped ? ' is-skip-pending' : isStandby ? ' is-standby' : '';
    const keeperBadge = checked
      ? `<span class="badge badge-xs badge-green font-mono" style="font-weight: 700;">★ Keeper ${kRank}/${targetDenom}</span>`
      : '';
    const typeBadge =
      a.media_type === 'video'
        ? '<span class="badge badge-xs badge-purple font-mono">VIDEO</span>'
        : '<span class="badge badge-xs badge-green font-mono">PHOTO</span>';
    const localNote =
      a.local_files && a.local_files.length > 0
        ? `<span class="badge badge-xs badge-outline font-mono" title="Exported on LaCie: ${escapeHtml(a.local_files.join(', '))}">✓ LaCie</span>`
        : '<span class="badge badge-xs badge-amber font-mono" title="Not yet exported in LaCie Curated folder">Not exported</span>';
    const statusBadge = isSkipped
      ? '<span class="badge badge-xs badge-amber font-mono" title="Unselected — will move to Moments / SkipPublishing">⏭️ ➜ SkipPublishing</span>'
      : isPromoted
        ? '<span class="badge badge-xs badge-purple font-mono" title="Auto-promoted from queue to keep 9 selected">✨ Promoted</span>'
        : isStandby
          ? '<span class="badge badge-xs badge-outline font-mono" title="Waiting in queue — auto-promotes if an asset above is unselected">⏳ Queue</span>'
          : '';
    const tagsHtml =
      a.asset_tags && a.asset_tags.length > 0
        ? `<div style="display: flex; align-items: center; gap: 0.25rem; margin-top: 0.16rem; flex-wrap: wrap;">${a.asset_tags
          .map(
            t =>
              `<span class="badge badge-xs badge-outline font-mono" style="font-size: 0.6rem;">🏷️ ${escapeHtml(t.tag_value)}</span>`
          )
          .join('')}</div>`
        : '';
    return `
      <div class="publish-asset-row${rowCls}">
        <div class="publish-asset-left">
          <input type="checkbox" class="publish-asset-checkbox" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} style="cursor: pointer;" />
          <button type="button" class="disjoint-row-thumb-btn btn-preview-publish-asset" data-asset-id="${escapeHtml(a.asset_id)}" title="Click to open Curation Lightbox (Space toggles selection)" style="width: 40px; height: 40px;">
            <img src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.filename)}" loading="lazy" />
          </button>
          <div style="min-width: 0; flex: 1;">
            <div class="font-mono" style="font-size: 0.75rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              #${idx + 1} · ${escapeHtml(a.filename || a.asset_id)}
            </div>
            <div style="display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap;">
              ${keeperBadge}
              ${typeBadge}
              <span class="font-mono text-amber" style="font-size: 0.69rem;">Score ${a.score.toFixed(4)}</span>
              ${localNote}
              ${statusBadge}
            </div>
            ${tagsHtml}
          </div>
        </div>
      </div>
    `;
  };

  const activeHtml = activeRows.map(r => renderRow(r.asset, r.idx, false)).join('');
  const standbyDivider =
    standbyRows.length > 0
      ? `<div class="publish-queue-divider">⏳ Next in Queue (${standbyRows.length} standby — next item auto-promotes when an asset above is unselected)</div>`
      : '';
  const standbyHtml = standbyRows.map(r => renderRow(r.asset, r.idx, true)).join('');

  listEl.innerHTML = `${activeHtml}${standbyDivider}${standbyHtml}`;

  listEl.querySelectorAll<HTMLInputElement>('.publish-asset-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const aid = cb.dataset.assetId || '';
      if (!aid) return;
      applyPublishAssetToggle(aid, cb.checked);
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-preview-publish-asset').forEach(btn => {
    btn.addEventListener('click', () => {
      const aid = btn.dataset.assetId || '';
      if (!aid) return;
      openCleanupPreviewModal(aid, {
        assetIds: allAssetIds,
        groupLabel: `${publishMomentName} · Publish Queue`,
        hideMarkRemoved: true,
        selectedIds: publishSelectedAssetIds,
        targetSelectionCount: Math.min(9, Math.max(1, publishMomentAssets.length - publishSkippedAssetIds.size)),
        defaultSort: 'score',
        onSelectionChange: (changedId, checked) => {
          applyPublishAssetToggle(changedId, checked);
        }
      });
    });
  });

  updatePublishMomentSelectionSummary();
}

async function applyPublishBatchCuration(showStatusBanner = true): Promise<boolean> {
  if (!publishMomentName || isApplyingPublishCuration) return false;
  const selIds = publishMomentAssets
    .filter(a => publishSelectedAssetIds.has(a.asset_id))
    .map(a => a.asset_id);
  const skipIds = Array.from(publishSkippedAssetIds);
  const statusEl = document.getElementById('publish-moment-status');
  const applyBtn = document.getElementById('btn-publish-apply-curation') as HTMLButtonElement | null;
  const summaryEl = document.getElementById('publish-moment-summary-banner');
  const stageBadgeEl = document.getElementById('publish-moment-stage-badge');
  const openFolderBtn = document.getElementById('btn-publish-open-folder') as HTMLButtonElement | null;

  isApplyingPublishCuration = true;
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';
  }
  if (statusEl) {
    statusEl.style.display = 'flex';
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>${skipIds.length > 0
      ? `Moving ${skipIds.length} unselected asset(s) to SkipPublishing & syncing ${selIds.length} selected to Pub. Rec folder...`
      : `Syncing ${selIds.length} selected asset(s) to Publishing Recommendation folder...`
      }</span>`;
  }

  try {
    const res = await fetch('/api/media/memories/curate-publish-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moment_name: publishMomentName,
        selected_asset_ids: selIds,
        skip_publishing_asset_ids: skipIds
      })
    });
    const data: PublishMomentInfoResponse = await res.json();
    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return false;
    }

    if (stageBadgeEl && data.memory_stage) stageBadgeEl.textContent = data.memory_stage;
    if (openFolderBtn) openFolderBtn.disabled = !(data.pub_rec_dir_exists || data.curated_dir_exists);

    const prevSelectedOrder = new Set(selIds);
    publishMomentAssets = data.assets || [];
    registerPublishAssetsForPreview(publishMomentAssets, publishMomentName);
    publishSelectedAssetIds.clear();
    publishSkippedAssetIds.clear();
    publishAutoPromotedIds.clear();

    publishMomentAssets.forEach(a => {
      if (prevSelectedOrder.has(a.asset_id)) {
        publishSelectedAssetIds.add(a.asset_id);
      }
    });
    const goal = Math.min(9, publishMomentAssets.length);
    for (const a of publishMomentAssets) {
      if (publishSelectedAssetIds.size >= goal) break;
      publishSelectedAssetIds.add(a.asset_id);
    }
    publishInitialSelectedKey = getPublishSelectedKey();
    renderPublishMomentAssets();

    if (summaryEl) {
      const pubCount = data.published_count ?? 0;
      const curCount = data.curated_count ?? 0;
      const unpubCount = data.unpublished_count ?? 0;
      const syncInfo = data.pub_rec_sync;
      const syncNote = syncInfo?.synced
        ? ` · <span class="text-green">✓ Pub. Rec Synced (${syncInfo.expected_files?.length ?? 0} files)</span>`
        : '';
      summaryEl.innerHTML = `
        <span>
          <strong>${pubCount > 0 ? '🔄 Republish' : '✨ First Publish'}</strong> ·
          Curated: <strong>${curCount}</strong> ·
          Already Published: <strong>${pubCount}</strong> ·
          Remaining Queue: <strong>${unpubCount}</strong>${syncNote}
        </span>
      `;
    }

    if (statusEl && showStatusBanner) {
      const movedMsg =
        (data.skip_publishing_moved ?? 0) > 0
          ? `Moved <strong>${data.skip_publishing_moved}</strong> unselected asset(s) to <code>Moments / SkipPublishing</code> · `
          : '';
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-green">✅ ${movedMsg}Synced <strong>${publishSelectedAssetIds.size}</strong> curated asset(s) into Publishing Recommendation folder.</span>`;
    }
    void Promise.all([fetchPlannerOverview(true, 'm'), fetchMemoriesFolders()]);
    if (plannerRefreshMediaMetricsCb) plannerRefreshMediaMetricsCb();
    return true;
  } catch (err: any) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
    return false;
  } finally {
    isApplyingPublishCuration = false;
    updatePublishMomentSelectionSummary();
  }
}

async function openCuratedFolderForPublish(
  momentName: string,
  folderKind: 'pub_rec' | 'curated' = 'pub_rec'
): Promise<void> {
  try {
    const res = await fetch('/api/media/memories/open-curated-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moment_name: momentName, folder_kind: folderKind })
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Could not open folder: ${data.error || 'Unknown error'}`);
    }
  } catch (err: any) {
    alert(`Error opening folder: ${err?.message || 'Unknown error'}`);
  }
}

async function openPublishMomentModal(momentName: string): Promise<void> {
  const modal = document.getElementById('modal-publish-moment');
  const titleEl = document.getElementById('publish-moment-modal-title');
  const stageBadgeEl = document.getElementById('publish-moment-stage-badge');
  const summaryEl = document.getElementById('publish-moment-summary-banner');
  const folderBarEl = document.getElementById('publish-moment-folder-bar');
  const curatedDirEl = document.getElementById('publish-moment-curated-dir');
  const sfInp = document.getElementById('publish-moment-sf-url') as HTMLInputElement | null;
  const ytInp = document.getElementById('publish-moment-yt-url') as HTMLInputElement | null;
  const statusEl = document.getElementById('publish-moment-status');
  const openFolderBtn = document.getElementById('btn-publish-open-folder') as HTMLButtonElement | null;
  const exportBtn = document.getElementById('btn-publish-export-curated') as HTMLButtonElement | null;
  if (!modal) return;

  publishMomentName = momentName;
  publishMomentAssets = [];
  publishSelectedAssetIds.clear();
  publishSkippedAssetIds.clear();
  publishAutoPromotedIds.clear();
  publishInitialSelectedKey = '';
  publishTargetBatchSize = 9;
  publishFilterCuratedOnly = false;
  publishTagsDirty = false;
  publishTagState.momentName = momentName;
  publishTagState.tags = [];
  publishTagState.removedTagValues.clear();
  publishTagState.lastSession = null;
  publishTagState.tagDbCounts = {};
  publishTagState.tagCatalogByCategory = {};
  publishTagState.activeQueriedTagKey = '';
  publishTagState.saveStatusMsg = '';
  publishTagState.isQueryOpen = false;
  publishTagState.queryData = null;
  setPublishModalCompletedState(false);

  if (titleEl) titleEl.textContent = `📢 Publish / Republish: ${momentName}`;
  if (stageBadgeEl) stageBadgeEl.textContent = '…';
  if (summaryEl) {
    summaryEl.innerHTML = '<div class="spinner-sm"></div><span>Loading curated assets and publication URLs...</span>';
  }
  if (folderBarEl) folderBarEl.style.display = 'none';
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.innerHTML = '';
  }
  renderPublishMomentAssets();
  renderTaggingEngineCard(publishTagState);
  modal.classList.add('open');

  try {
    const params = new URLSearchParams({ moment_name: momentName });
    const [res, tagRes] = await Promise.all([
      fetch(`/api/media/memories/publish-info?${params.toString()}`),
      fetch(`/api/media/memories/moment-assets?${params.toString()}`).catch(() => null)
    ]);
    const data: PublishMomentInfoResponse = await res.json();
    if (!data.ok) {
      if (summaryEl) {
        summaryEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || 'Failed to load publish info')}</span>`;
      }
      return;
    }

    if (stageBadgeEl) stageBadgeEl.textContent = data.memory_stage || 'M400';
    if (sfInp) sfInp.value = data.shutterfly_url || '';
    if (ytInp) ytInp.value = data.youtube_url || '';
    syncPublishOpenLinks();

    if (summaryEl) {
      const pubCount = data.published_count ?? 0;
      const curCount = data.curated_count ?? 0;
      const unpubCount = data.unpublished_count ?? 0;
      const isRepublish = pubCount > 0;
      const syncInfo = data.pub_rec_sync;
      const syncNote = syncInfo?.synced
        ? ` · <span class="text-green">✓ Pub. Rec Synced (${syncInfo.expected_files?.length ?? 0} files${syncInfo.copied ? `, +${syncInfo.copied} copied` : ''}${syncInfo.removed ? `, -${syncInfo.removed} removed` : ''})</span>`
        : syncInfo?.reason
          ? ` · <span class="text-amber">⚠️ ${escapeHtml(syncInfo.reason)}</span>`
          : '';
      summaryEl.innerHTML = `
        <span>
          <strong>${isRepublish ? '🔄 Republish' : '✨ First Publish'}</strong> ·
          Curated: <strong>${curCount}</strong> ·
          Already Published: <strong>${pubCount}</strong> ·
          Remaining Queue: <strong>${unpubCount}</strong>${syncNote}
        </span>
      `;
    }

    if (folderBarEl && curatedDirEl) {
      folderBarEl.style.display = 'flex';
      curatedDirEl.textContent = data.pub_rec_dir || data.curated_dir || '—';
      if (openFolderBtn) openFolderBtn.disabled = !(data.pub_rec_dir_exists || data.curated_dir_exists);
      const openCuratedBtn = document.getElementById('btn-publish-open-curated') as HTMLButtonElement | null;
      if (openCuratedBtn) openCuratedBtn.disabled = !data.curated_dir_exists;
      if (exportBtn) {
        exportBtn.textContent = data.curated_dir_exists ? '🔄 Re-export Curated [2]' : '📤 Export Curated [2]';
      }
    }

    publishMomentAssets = data.assets || [];
    registerPublishAssetsForPreview(publishMomentAssets, momentName);
    resetPublishInitialTopSelection();
    renderPublishMomentAssets();

    if (tagRes && tagRes.ok) {
      try {
        const tagData: MomentAssetsPreviewResponse = await tagRes.json();
        if (tagData.ok) {
          publishTagState.tagDbCounts = tagData.tag_db_counts || {};
          publishTagState.tagCatalogByCategory = tagData.tag_catalog_by_category || {};
          publishTagState.lastSession = tagData.last_tag_session ?? null;
          if (tagData.name_suggestion?.family_member_pool?.length) {
            publishTagState.familyPool = tagData.name_suggestion.family_member_pool;
          }
          publishTagState.tags = buildTagListFromSuggestion(tagData.saved_tags, tagData.name_suggestion);
          publishTagsDirty = false;
          renderTaggingEngineCard(publishTagState);
        }
      } catch {
        // Non-fatal: publish workflow still succeeds if tag preview fails to parse
      }
    }
  } catch (err: any) {
    if (summaryEl) {
      summaryEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  }
}

async function submitPublishMoment(): Promise<void> {
  if (publishMomentCompleted) {
    closePublishMomentModal();
    return;
  }
  if (isSubmittingPublishMoment || !publishMomentName) return;

  const assetIds = publishMomentAssets
    .filter(a => publishSelectedAssetIds.has(a.asset_id))
    .map(a => a.asset_id);
  const skipIds = Array.from(publishSkippedAssetIds);
  const statusEl = document.getElementById('publish-moment-status');
  const btnCancel = document.getElementById('btn-cancel-publish-moment') as HTMLButtonElement | null;
  const btnSubmit = document.getElementById('btn-submit-publish-moment') as HTMLButtonElement | null;
  const sfInp = document.getElementById('publish-moment-sf-url') as HTMLInputElement | null;
  const ytInp = document.getElementById('publish-moment-yt-url') as HTMLInputElement | null;
  const accInp = document.getElementById('publish-moment-account') as HTMLInputElement | null;

  if (!assetIds.length) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">⚠️ Select at least one asset to record as published.</span>';
    }
    return;
  }

  isSubmittingPublishMoment = true;
  if (btnCancel) btnCancel.disabled = true;
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Recording...';
  }
  if (statusEl) {
    statusEl.style.display = 'flex';
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>${skipIds.length > 0
      ? `Moving ${skipIds.length} unselected asset(s) to SkipPublishing & recording publication of ${assetIds.length} asset(s)...`
      : `Recording publication of ${assetIds.length} asset(s) for <code>${escapeHtml(publishMomentName)}</code>...`
      }</span>`;
  }

  let succeeded = false;
  try {
    if (publishTagsDirty && (publishTagState.tags.length > 0 || publishTagState.removedTagValues.size > 0)) {
      await saveMomentTagsForState(publishTagState, false);
    }
    const res = await fetch('/api/media/memories/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moment_name: publishMomentName,
        asset_ids: assetIds,
        skip_publishing_asset_ids: skipIds,
        shutterfly_url: (sfInp?.value || '').trim() || null,
        youtube_url: (ytInp?.value || '').trim() || null,
        account: (accInp?.value || 'nickolay.cohen@gmail.com').trim() || 'nickolay.cohen@gmail.com'
      })
    });
    const data: PublishMomentResponse = await res.json();
    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    publishSkippedAssetIds.clear();
    unifiedGroupingAssetsCache.clear();
    allGroupingsLoaded = false;
    await Promise.all([
      fetchPlannerOverview(true, 'm'),
      fetchMemoriesFolders(),
      ...(activePlannerModeView === 'g' ? [fetchAllUnifiedGroupings(true)] : [])
    ]);
    if (plannerRefreshMediaMetricsCb) plannerRefreshMediaMetricsCb();

    if (statusEl) {
      const syncInfo = data.pub_rec_sync;
      const skipNote =
        (data.skip_publishing_moved ?? 0) > 0 ? ` · ${data.skip_publishing_moved} unselected ➜ SkipPublishing` : '';
      const syncSuffix = syncInfo?.removed_folder
        ? ' · Pub. Rec folder removed (M500 complete)'
        : syncInfo?.synced
          ? ` · Pub. Rec folder updated (+${syncInfo.copied ?? 0} copied, -${syncInfo.removed ?? 0} removed)`
          : '';
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `
        <span class="text-green">
          ✅ Recorded <strong>${data.inserted_count ?? 0}</strong> asset(s) for
          <code>${escapeHtml(data.moment_name || publishMomentName)}</code>
          (Stage: <strong>${escapeHtml(data.new_stage || 'M450')}</strong> · Total Published: ${data.total_published ?? 0}/${data.curated_total ?? 0}${escapeHtml(skipNote)}${escapeHtml(syncSuffix)}).
        </span>
      `;
    }
    succeeded = true;
  } catch (err: any) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isSubmittingPublishMoment = false;
    setPublishModalCompletedState(succeeded);
  }
}

// ==========================================================================
// Resolve Disjoint Moment Modal (Merge / SkipPublishing / Ignore)
// ==========================================================================

function closeResolveDisjointModal(): void {
  document.getElementById('modal-resolve-disjoint')?.classList.remove('open');
}

function setResolveDisjointCompletedState(completed: boolean): void {
  resolveDisjointCompleted = completed;
  const btnCancel = document.getElementById('btn-cancel-resolve-disjoint') as HTMLButtonElement | null;
  const btnSubmit = document.getElementById('btn-submit-resolve-disjoint') as HTMLButtonElement | null;
  const btnLegacy = document.getElementById('btn-resolve-disjoint-legacy-merge') as HTMLButtonElement | null;
  const btnSkip = document.getElementById('btn-resolve-disjoint-skip') as HTMLButtonElement | null;
  const btnIgnore = document.getElementById('btn-resolve-disjoint-ignore') as HTMLButtonElement | null;
  if (btnCancel) {
    btnCancel.style.display = completed ? 'none' : '';
    btnCancel.disabled = false;
  }
  if (btnLegacy) {
    btnLegacy.style.display = completed || resolveDisjointIsCurateM200 ? 'none' : '';
    btnLegacy.disabled = false;
  }
  if (btnSkip) {
    btnSkip.style.display = completed ? 'none' : '';
    btnSkip.disabled = false;
  }
  if (btnIgnore) {
    btnIgnore.style.display = completed ? 'none' : '';
    btnIgnore.disabled = false;
  }
  if (btnSubmit) {
    btnSubmit.disabled = false;
    if (completed) {
      btnSubmit.className = 'btn btn-green';
      btnSubmit.textContent = '✅ OK';
    } else {
      btnSubmit.className = 'btn btn-purple';
      updateResolveDisjointTargetPreview();
    }
  }
}

function getCombinedPoolTotalCount(): number {
  let pool = resolveDisjointAssets.length;
  combinedExtraMoments.forEach(entry => {
    pool += Math.max(entry.totalAssets || 0, entry.assetIds.size);
  });
  return pool;
}

function selectTopExpectedKeepersInDialog(): void {
  if (!resolveDisjointAssets.length) return;
  const poolTotal = getCombinedPoolTotalCount();
  const { expected } = computeExpectedCuratedStats(poolTotal);
  let extraSelected = 0;
  combinedExtraMoments.forEach(entry => {
    extraSelected += entry.assetIds.size;
  });
  const primaryQuota = Math.max(1, expected - extraSelected);
  const nonDups = resolveDisjointAssets.filter(a => !a.is_duplicate_copy);
  const ranked = [...(nonDups.length ? nonDups : resolveDisjointAssets)].sort(
    (a, b) => b.score_normalized - a.score_normalized
  );
  resolveDisjointSelectedIds.clear();
  ranked.slice(0, primaryQuota).forEach(a => resolveDisjointSelectedIds.add(a.asset_id));
  renderResolveDisjointAssets();
  updateResolveDisjointSelectionSummary();
}

function selectAllQualifiedKeepersInDialog(): void {
  if (!resolveDisjointAssets.length) return;
  resolveDisjointSelectedIds.clear();
  resolveDisjointAssets.forEach(a => {
    if (a.qualified && !a.is_duplicate_copy) {
      resolveDisjointSelectedIds.add(a.asset_id);
    }
  });
  if (resolveDisjointSelectedIds.size === 0) {
    const nonDups = resolveDisjointAssets.filter(a => !a.is_duplicate_copy);
    (nonDups.length ? nonDups : resolveDisjointAssets).forEach(a => resolveDisjointSelectedIds.add(a.asset_id));
  }
  renderResolveDisjointAssets();
  updateResolveDisjointSelectionSummary();
}

function computeHighratedUnselectedPreview(): {
  maxKeeperScore: number;
  highratedIds: Set<string>;
  highratedAssets: Array<{ asset_id: string; score_normalized: number; original_filename?: string }>;
  otherUnselectedCount: number;
  allUnselectedIds: string[];
} {
  const selectedScores: number[] = [];
  const unselectedItems: Array<{ asset_id: string; score_normalized: number; original_filename?: string }> = [];
  const seenUnsel = new Set<string>();

  resolveDisjointAssets.forEach(a => {
    if (resolveDisjointSelectedIds.has(a.asset_id)) {
      selectedScores.push(a.score_normalized ?? 0);
    } else if (!seenUnsel.has(a.asset_id)) {
      seenUnsel.add(a.asset_id);
      unselectedItems.push({
        asset_id: a.asset_id,
        score_normalized: a.score_normalized ?? 0,
        original_filename: a.original_filename
      });
    }
  });

  combinedExtraMoments.forEach(entry => {
    (entry.allAssets || []).forEach(a => {
      if (entry.assetIds.has(a.asset_id)) {
        selectedScores.push(a.score_normalized ?? 0);
      } else if (!entry.isTimeframeDeviceSelection && !seenUnsel.has(a.asset_id)) {
        seenUnsel.add(a.asset_id);
        unselectedItems.push({
          asset_id: a.asset_id,
          score_normalized: a.score_normalized ?? 0,
          original_filename: a.original_filename
        });
      }
    });
  });

  const poolTotal = getCombinedPoolTotalCount();
  if (!selectedScores.length || !unselectedItems.length || poolTotal < 2) {
    return {
      maxKeeperScore: selectedScores.length ? Math.max(...selectedScores) : 0,
      highratedIds: new Set<string>(),
      highratedAssets: [],
      otherUnselectedCount: unselectedItems.length,
      allUnselectedIds: unselectedItems.map(x => x.asset_id)
    };
  }

  const maxKeeperScore = Math.max(...selectedScores);
  const highratedAssets = unselectedItems
    .filter(a => a.score_normalized > maxKeeperScore)
    .sort((a, b) => b.score_normalized - a.score_normalized);
  const highratedIds = new Set(highratedAssets.map(a => a.asset_id));
  return {
    maxKeeperScore,
    highratedIds,
    highratedAssets,
    otherUnselectedCount: Math.max(0, unselectedItems.length - highratedAssets.length),
    allUnselectedIds: unselectedItems.map(x => x.asset_id)
  };
}

function refreshExpectedCuratedUI(): void {
  const pill = document.getElementById('resolve-disjoint-selected-pill');
  const selectedCount = resolveDisjointAssets.filter(a => resolveDisjointSelectedIds.has(a.asset_id)).length;
  const unselectedCount = Math.max(0, resolveDisjointAssets.length - selectedCount);
  let extraSel = 0;
  combinedExtraMoments.forEach(entry => {
    extraSel += entry.assetIds.size;
  });
  const totalSel = selectedCount + extraSel;
  const poolTotal = getCombinedPoolTotalCount();
  const { expected, lnRaw } = computeExpectedCuratedStats(poolTotal);
  const hrPreview = computeHighratedUnselectedPreview();

  if (pill) {
    pill.textContent = `${selectedCount} / ${resolveDisjointAssets.length} selected (🎯 exp ${expected})`;
  }

  const expTextEl = document.getElementById('resolve-disjoint-expected-curated-text');
  if (expTextEl) {
    const diff = totalSel - expected;
    const matchCls =
      totalSel === 0
        ? 'badge-red'
        : diff === 0
          ? 'badge-green'
          : resolveDisjointIsCurateM200
            ? 'badge-red'
            : 'badge-amber';
    const mismatchNote =
      resolveDisjointIsCurateM200 && diff !== 0 && poolTotal > 0
        ? `<span class="text-amber">⚠️ Must match ${expected} keeper${expected === 1 ? '' : 's'} to mark Curated &amp; unlock Publish</span>`
        : '';
    const hrNote =
      resolveDisjointIsCurateM200 && hrPreview.highratedAssets.length > 0
        ? `<span class="badge badge-xs badge-purple font-mono" title="Unselected event assets scoring higher than highest curated keeper (${hrPreview.maxKeeperScore.toFixed(4)}) will be copied to Moments / Highrated assets in Media Organizer">⚡ ${hrPreview.highratedAssets.length} (&gt; ${hrPreview.maxKeeperScore.toFixed(3)}) ➜ Moments/Highrated assets</span>`
        : '';
    expTextEl.innerHTML =
      poolTotal > 0
        ? `<span>🎯 <strong>Expected Curated: ${expected}</strong> <span class="text-muted">(ln(${poolTotal}) = ${lnRaw.toFixed(2)})</span></span>
           <span class="badge badge-xs ${matchCls} font-mono">${diff === 0 ? '✓' : '⚠️'} ${totalSel} keeper${totalSel === 1 ? '' : 's'} selected${diff === 0 ? ' (matches ln target ✓)' : diff > 0 ? ` (+${diff} vs exp)` : ` (${diff} vs exp)`}</span>
           <span class="text-muted">· Total Event Pool: <strong>${poolTotal}</strong></span>
           ${hrNote}
           ${mismatchNote}`
        : '<span>🎯 <strong>Expected Curated Target (ln N):</strong> —</span>';
  }

  const selExpBtn = document.getElementById('btn-disjoint-select-expected');
  if (selExpBtn) {
    selExpBtn.textContent = expected > 0 ? `🎯 Select Top ${expected} (ln ${poolTotal})` : '🎯 Select Top ln(N)';
  }

  const manCurTargetPill = document.getElementById('resolve-disjoint-manual-curate-target-pill');
  if (manCurTargetPill) {
    manCurTargetPill.textContent =
      poolTotal > 0
        ? `🎯 Exp: ${expected} (ln ${poolTotal}) · Selected: ${totalSel}`
        : `Selected: ${totalSel}`;
  }

  const curateCountsEl = document.getElementById('curate-m200-counts-summary');
  if (curateCountsEl) {
    const destLabel = resolveDisjointIsCurateM200 ? 'Curated' : 'Moments (M100)';
    if (resolveDisjointIsCurateM200 && hrPreview.highratedAssets.length > 0) {
      curateCountsEl.textContent = `${totalSel} keeper(s) (🎯 exp ${expected}) ➜ ${destLabel} · ⚡ ${hrPreview.highratedAssets.length} (> ${hrPreview.maxKeeperScore.toFixed(3)}) ➜ Moments/Highrated assets · ${hrPreview.otherUnselectedCount} other unselected`;
    } else {
      curateCountsEl.textContent = `${totalSel} keeper(s) (🎯 exp ${expected}) ➜ ${destLabel} · ${unselectedCount} unselected`;
    }
  }
}

function updateResolveDisjointSelectionSummary(): void {
  refreshExpectedCuratedUI();
  renderResolveDisjointCombineTray();
  if (!resolveDisjointCompleted) {
    updateResolveDisjointTargetPreview();
  }
}

function renderResolveDisjointAssets(): void {
  const listEl = document.getElementById('resolve-disjoint-asset-list');
  if (!listEl) return;

  if (!resolveDisjointAssets.length) {
    listEl.innerHTML = '<div class="text-center text-muted" style="padding: 1rem;">No active assets found in DB for this Moment.</div>';
    updateResolveDisjointSelectionSummary();
    return;
  }

  const allAssetIds = resolveDisjointAssets.map(a => a.asset_id);
  const keeperRankMap = new Map<string, number>();
  let kCounter = 0;
  resolveDisjointAssets.forEach(a => {
    if (resolveDisjointSelectedIds.has(a.asset_id)) {
      kCounter += 1;
      keeperRankMap.set(a.asset_id, kCounter);
    }
  });
  const totalSelected = keeperRankMap.size;

  const disjFilterBtn = document.getElementById('btn-disjoint-hide-unselected');
  if (disjFilterBtn) {
    disjFilterBtn.classList.toggle('btn-purple', disjointFilterCuratedOnly);
    disjFilterBtn.classList.toggle('btn-outline', !disjointFilterCuratedOnly);
    disjFilterBtn.textContent = disjointFilterCuratedOnly
      ? `★ Curated Only (${totalSelected})`
      : '👁️ Curated Only';
  }

  const hrPreviewForCards = resolveDisjointIsCurateM200 ? computeHighratedUnselectedPreview() : null;

  listEl.innerHTML = resolveDisjointAssets
    .map((a, idx) => {
      const checked = resolveDisjointSelectedIds.has(a.asset_id);
      if (disjointFilterCuratedOnly && !checked) {
        return '';
      }
      const kRank = keeperRankMap.get(a.asset_id) || 0;
      const isHighratedUnselected = !checked && Boolean(hrPreviewForCards?.highratedIds.has(a.asset_id));
      const keeperBadge = checked
        ? `<span class="badge badge-xs badge-green font-mono" style="font-weight: 700;">★ Keeper ${kRank}/${totalSelected}</span>`
        : isHighratedUnselected
          ? `<span class="badge badge-xs badge-purple font-mono" title="Score ${a.score_normalized.toFixed(4)} &gt; highest curated keeper (${(hrPreviewForCards?.maxKeeperScore ?? 0).toFixed(4)}) — will be copied to Moments / Highrated assets in Media Organizer">⚡ ➜ Moments/Highrated assets</span>`
          : '<span class="badge badge-xs badge-amber font-mono">⏭️ Unselected</span>';
      const qualBadge = a.qualified
        ? '<span class="badge badge-xs badge-green font-mono">★ QUALIFIED</span>'
        : '<span class="badge badge-xs badge-outline font-mono">Below Threshold</span>';
      const typeBadge =
        a.media_type === 'video'
          ? `<span class="badge badge-xs badge-purple font-mono">VIDEO${a.duration ? ` ${formatDuration(a.duration)}` : ''}</span>`
          : '<span class="badge badge-xs badge-blue font-mono">PHOTO</span>';
      const dupTip = a.is_duplicate_copy
        ? `Duplicate of ${a.duplicate_keeper_filename || 'another asset'}${a.duplicate_keeper_moment ? ` in "${a.duplicate_keeper_moment}"` : ''} (${a.duplicate_match_tier || 'Match'}${a.duplicate_similarity_pct ? ` · ${a.duplicate_similarity_pct}%` : ''}) — unchecked by default`
        : '';
      const dupBadge = a.is_duplicate_copy
        ? `<span class="badge badge-xs badge-amber font-mono" title="${escapeHtml(dupTip)}">♻️ Dup Copy</span>`
        : '';
      const sizeStr = a.file_size_bytes ? ` · ${formatBytes(a.file_size_bytes)}` : '';
      const dateStr = a.date_created_utc ? a.date_created_utc.slice(0, 10) : a.month || '';
      const assetTagsHtml =
        a.asset_tags && a.asset_tags.length > 0
          ? `<div style="display: flex; align-items: center; gap: 0.25rem; margin-top: 0.18rem; flex-wrap: wrap;">${a.asset_tags
            .map(
              t =>
                `<span class="badge badge-xs ${t.category === 'family_member'
                  ? 'badge-green'
                  : t.category === 'people'
                    ? 'badge-purple'
                    : t.category === 'activity'
                      ? 'badge-blue'
                      : t.category === 'location'
                        ? 'badge-amber'
                        : 'badge-outline'
                } font-mono" style="font-size: 0.62rem;">🏷️ ${escapeHtml(t.tag_value)}</span>`
            )
            .join('')}</div>`
          : '';
      const rowStateCls = checked ? ' is-selected' : ' is-unselected-grey';
      return `
        <div class="publish-asset-row${rowStateCls}${a.is_duplicate_copy ? ' is-dup-copy' : ''}" ${dupTip ? `title="${escapeHtml(dupTip)}"` : ''}>
          <div class="publish-asset-left">
            <input type="checkbox" class="resolve-disjoint-asset-cb" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} style="cursor: pointer;" />
            <button type="button" class="disjoint-row-thumb-btn btn-preview-disjoint-modal-asset" data-asset-id="${escapeHtml(a.asset_id)}" title="Open Curation Lightbox (Space toggles selection)" style="width: 40px; height: 40px;">
              <img src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.original_filename)}" loading="lazy" />
            </button>
            <div style="min-width: 0; flex: 1;">
              <div class="font-mono" style="font-size: 0.75rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                #${idx + 1} · ${escapeHtml(a.original_filename || a.asset_id)}
              </div>
              <div style="display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap;">
                ${keeperBadge}
                ${qualBadge}
                ${typeBadge}
                ${dupBadge}
                <span class="font-mono text-amber" style="font-size: 0.69rem;">Score ${a.score_normalized.toFixed(4)}</span>
                <span class="font-mono text-muted" style="font-size: 0.68rem;">${escapeHtml(dateStr)}${escapeHtml(sizeStr)}</span>
              </div>
              ${assetTagsHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll<HTMLInputElement>('.resolve-disjoint-asset-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const aid = cb.dataset.assetId || '';
      if (!aid) return;
      if (cb.checked) resolveDisjointSelectedIds.add(aid);
      else resolveDisjointSelectedIds.delete(aid);
      renderResolveDisjointAssets();
      updateResolveDisjointSelectionSummary();
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-preview-disjoint-modal-asset').forEach(btn => {
    btn.addEventListener('click', () => {
      const aid = btn.dataset.assetId || '';
      if (aid) {
        openCleanupPreviewModal(aid, {
          assetIds: allAssetIds,
          groupLabel: resolveDisjointMomentName,
          hideMarkRemoved: true,
          selectedIds: resolveDisjointSelectedIds,
          onSelectionChange: () => {
            renderResolveDisjointAssets();
            updateResolveDisjointSelectionSummary();
          }
        });
      }
    });
  });

  updateResolveDisjointSelectionSummary();
}

function composeMomentNameFromTags(tags: MomentTagItem[], fallbackName: string): string {
  const picked = (cat: MomentTagItem['category']): string[] =>
    tags.filter(t => t.category === cat && t.include_in_name).map(t => t.tag_value);

  const fam = picked('family_member').join(' & ');
  const act = picked('activity').join(' & ');
  const loc = picked('location')
    .map(v => v.replace(/,/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
  const ppl = picked('people').join(', ');
  const when = picked('when').join(' / ');

  const parts: string[] = [];
  if (act) parts.push(act);
  if (loc) {
    if (!act || /\s+(to|at)$/i.test(act)) {
      parts.push(loc);
    } else {
      const prep = /\btrips?\b/i.test(act) ? 'to' : 'at';
      parts.push(`${prep} ${loc}`);
    }
  }
  if (ppl) parts.push(`with ${ppl}`);
  const body = parts.join(' ').trim();
  const head = fam && body ? `${fam} — ${body}` : fam || body;
  if (!head) return when || fallbackName;
  return when ? `${head} - ${when}` : head;
}

function buildTagListFromSuggestion(
  savedTags?: MomentTagItem[],
  sug?: DisjointNameSuggestion | null
): MomentTagItem[] {
  const out: MomentTagItem[] = [];
  const pushUniqueGlobal = (category: MomentTagItem['category'], val: string, include: boolean, taggedCnt?: number): void => {
    const clean = (val || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const existing = out.find(x => x.tag_value.toLowerCase() === clean.toLowerCase());
    if (!existing) {
      out.push({ category, tag_value: clean, include_in_name: include, tagged_asset_count: taggedCnt });
    } else if (category === 'family_member' && existing.category === 'people') {
      existing.category = 'family_member';
    }
  };

  if (savedTags && savedTags.length > 0) {
    savedTags.forEach(t => pushUniqueGlobal(t.category, t.tag_value, t.include_in_name, t.tagged_asset_count));
    return out;
  }

  if (sug) {
    if (sug.activity) pushUniqueGlobal('activity', sug.activity, true);
    if (sug.location) pushUniqueGlobal('location', sug.location, true);
    (sug.location_candidates || []).forEach(lc => {
      if (lc && lc.toLowerCase() !== (sug.location || '').toLowerCase()) {
        pushUniqueGlobal('location', lc, false);
      }
    });
    (sug.family_members || []).forEach(fm => pushUniqueGlobal('family_member', fm, false));
    (sug.people_candidates || []).forEach((pc, idx) => {
      if (pc.short_name) pushUniqueGlobal('people', pc.short_name, idx < 3);
    });
    if (!sug.people_candidates?.length && sug.people) {
      sug.people.split(',').forEach(p => pushUniqueGlobal('people', p, true));
    }
    if (sug.when) pushUniqueGlobal('when', sug.when, true);
  }
  return out;
}

function renderPropagateTagsPreview(): void {
  const boxEl = document.getElementById('resolve-disjoint-propagate-tags-list');
  if (!boxEl) return;
  const savePerSource = (document.getElementById('resolve-disjoint-save-per-source-tags') as HTMLInputElement | null)?.checked ?? true;
  const shareDisjoint = (document.getElementById('resolve-disjoint-share-disjoint-tags') as HTMLInputElement | null)?.checked ?? false;

  if (!savePerSource && !shareDisjoint) {
    boxEl.innerHTML = '<span class="text-muted font-mono" style="font-size: 0.65rem;">No merge-time DB tags will be written (you can still save per-Moment tags independently above).</span>';
    return;
  }

  const lines: string[] = [];
  if (sourceTagState.tags.length) {
    const pills = sourceTagState.tags.map(t => `${escapeHtml(t.category)}: ${escapeHtml(t.tag_value)}`).join(' · ');
    lines.push(`<span class="disjoint-mini-chip" style="border-color: rgba(245, 158, 11, 0.5); color: #fef3c7;">${escapeHtml(resolveDisjointMomentName)} → ${pills}</span>`);
  }
  combinedExtraMoments.forEach((entry, mName) => {
    const mTags = shareDisjoint
      ? [...entry.tags, ...sourceTagState.tags.filter(st => !entry.tags.some(et => et.tag_value.toLowerCase() === st.tag_value.toLowerCase()))]
      : entry.tags;
    const pills = mTags.length
      ? mTags.map(t => `${escapeHtml(t.category)}: ${escapeHtml(t.tag_value)}`).join(' · ')
      : 'no tags';
    lines.push(`<span class="disjoint-mini-chip">${escapeHtml(mName)} (${entry.assetIds.size}) → ${pills}</span>`);
  });
  boxEl.innerHTML = lines.join('');
}

function getConsolidatedTotalCount(): number {
  let total = resolveDisjointSelectedIds.size;
  combinedExtraMoments.forEach(entry => {
    total += entry.assetIds.size;
  });
  return total;
}

function updateSingleAssetWarningVisibility(): void {
  const warnEl = document.getElementById('resolve-disjoint-single-warning');
  const countBadge = document.getElementById('resolve-disjoint-combine-count-badge');
  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const parentSel = document.getElementById('resolve-disjoint-parent-select') as HTMLSelectElement | null;
  const totalCount = getConsolidatedTotalCount();
  const targetVal = (targetInp?.value || '').trim();
  const existingInfo = getExistingTargetAlbumInfo(parentSel?.value || 'Moments', targetVal);
  const isKnownExistingMulti =
    combinedExtraMoments.size > 0 ||
    (existingInfo.exists && existingInfo.assetCount >= 2) ||
    nearbyMomentCandidatesList.some(c => c.moment_name.toLowerCase() === targetVal.toLowerCase() && c.qualified_count >= 2);

  if (countBadge) {
    if (combinedExtraMoments.size > 0 || totalCount >= 2) {
      countBadge.className = 'badge badge-xs badge-green font-mono';
      countBadge.textContent = `${totalCount} assets combined (${1 + combinedExtraMoments.size} moments ✓)`;
    } else {
      countBadge.className = 'badge badge-xs badge-amber font-mono';
      countBadge.textContent = `${totalCount} asset (single-asset)`;
    }
  }
  if (warnEl) {
    warnEl.style.display = totalCount < 2 && !isKnownExistingMulti ? 'flex' : 'none';
  }
}

function renderResolveDisjointCombineTray(): void {
  const trayEl = document.getElementById('resolve-disjoint-combine-tray');
  if (!trayEl) return;
  const chips: string[] = [
    `<span class="disjoint-target-chip active" title="Primary disjoint source Moment">📌 ${escapeHtml(resolveDisjointMomentName)} (${resolveDisjointSelectedIds.size})</span>`
  ];
  combinedExtraMoments.forEach((entry, name) => {
    chips.push(
      `<span class="disjoint-target-chip suggested" style="gap: 0.35rem;">
        <span>+ ${escapeHtml(name)} (${entry.assetIds.size})</span>
        <button type="button" class="tag-pill-remove-btn btn-remove-combine-moment" data-moment-name="${escapeHtml(name)}" title="Remove from consolidation list" aria-label="Remove combined Moment">×</button>
      </span>`
    );
  });
  trayEl.innerHTML = chips.join('');
  trayEl.querySelectorAll<HTMLButtonElement>('.btn-remove-combine-moment').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.momentName || '';
      combinedExtraMoments.delete(m);
      renderResolveDisjointCombineTray();
      renderCandidateMomentChips(displayedCandidateMomentsList);
      renderPropagateTagsPreview();
      updateResolveDisjointTargetPreview();
    });
  });
  updateSingleAssetWarningVisibility();
  refreshExpectedCuratedUI();
}

function renderCandidateMomentChips(
  candidates: Array<{ moment_name: string; qualified_count: number; total_count?: number; rel_label: string; is_suggested?: boolean }>
): void {
  displayedCandidateMomentsList = candidates;
  const chipsEl = document.getElementById('resolve-disjoint-nearby-chips');
  if (!chipsEl) return;
  if (!candidates.length) {
    chipsEl.innerHTML =
      '<span class="text-muted font-mono" style="font-size: 0.69rem;">No matching Moments found — try another search term above.</span>';
    return;
  }
  chipsEl.innerHTML = candidates
    .map(c => {
      const isAdded = combinedExtraMoments.has(c.moment_name);
      const isPreviewed = previewedCandidateMomentName === c.moment_name;
      const cntLabel = c.total_count !== undefined && c.total_count !== c.qualified_count
        ? `${c.qualified_count}/${c.total_count}`
        : `${c.qualified_count}`;
      const relStr = c.rel_label ? ` · ${escapeHtml(c.rel_label)}` : '';
      return `<button type="button" class="disjoint-target-chip${isAdded ? ' suggested' : ''}${isPreviewed ? ' active' : ''}" data-candidate-moment="${escapeHtml(c.moment_name)}" title="Click to preview assets &amp; edit DB tags for '${escapeHtml(c.moment_name)}'">
        ${isAdded ? '✓ ' : c.is_suggested ? '★ ' : ''}${escapeHtml(c.moment_name)} <span style="opacity: 0.75;">(${cntLabel}${relStr})</span>
      </button>`;
    })
    .join('');

  chipsEl.querySelectorAll<HTMLButtonElement>('[data-candidate-moment]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mName = btn.dataset.candidateMoment || '';
      if (mName) void openCandidateMomentPreview(mName);
    });
  });
}

async function searchMomentsForConsolidationUI(query: string): Promise<void> {
  if (!query) {
    renderCandidateMomentChips(nearbyMomentCandidatesList);
    return;
  }
  try {
    const qs = new URLSearchParams({
      q: query,
      exclude_moment: resolveDisjointMomentName,
      anchor_moment: resolveDisjointMomentName,
      limit: '24'
    });
    const res = await fetch(`/api/media/memories/search-moments?${qs.toString()}`);
    const data: SearchMomentsResponse = await res.json();
    if (!res.ok || !data.ok) return;
    const mapped = (data.moments || []).map((m: SearchMomentItem) => ({
      moment_name: m.moment_name,
      qualified_count: m.qualified_count,
      total_count: m.total_count,
      rel_label: m.rel_label,
      is_suggested: false
    }));
    renderCandidateMomentChips(mapped);
  } catch (err) {
    console.warn('Error searching moments:', err);
  }
}

async function openCandidateMomentPreview(momentName: string): Promise<void> {
  const panel = document.getElementById('resolve-disjoint-candidate-preview-panel');
  const titleEl = document.getElementById('resolve-disjoint-candidate-preview-title');
  const gridEl = document.getElementById('resolve-disjoint-candidate-assets-grid');
  const candMountEl = document.getElementById('resolve-disjoint-candidate-tagging-mount');
  if (!panel || !titleEl || !gridEl) return;

  previewedCandidateMomentName = momentName;
  previewedCandidateAssets = [];
  previewedCandidateSelectedIds.clear();
  candidateTagState.momentName = momentName;
  candidateTagState.tags = [];
  candidateTagState.removedTagValues.clear();
  candidateTagState.lastSession = null;
  candidateTagState.saveStatusMsg = '';
  candidateTagState.isQueryOpen = false;
  candidateTagState.activeQueriedTagKey = '';
  renderCandidateMomentChips(displayedCandidateMomentsList);

  panel.style.display = 'flex';
  titleEl.textContent = `📂 Loading "${momentName}" assets...`;
  gridEl.innerHTML = '<div class="text-muted font-mono" style="font-size: 0.7rem;">Loading asset previews...</div>';
  if (candMountEl) candMountEl.innerHTML = '<div class="text-muted font-mono" style="font-size: 0.7rem;">Loading Tagging &amp; Naming Engine...</div>';

  try {
    const qs = new URLSearchParams({ moment_name: momentName });
    const res = await fetch(`/api/media/memories/moment-assets?${qs.toString()}`);
    const data: MomentAssetsPreviewResponse = await res.json();
    if (!res.ok || !data.ok) {
      titleEl.textContent = `❌ Failed loading "${momentName}": ${data.error || `HTTP ${res.status}`}`;
      gridEl.innerHTML = '';
      if (candMountEl) candMountEl.innerHTML = '';
      return;
    }

    const assets = data.assets || [];
    previewedCandidateAssets = assets;
    const existingCombined = combinedExtraMoments.get(momentName);
    if (existingCombined) {
      existingCombined.assetIds.forEach(id => previewedCandidateSelectedIds.add(id));
    } else {
      const nonDups = assets.filter(a => !a.is_duplicate_copy);
      (nonDups.length ? nonDups : assets).forEach(a => previewedCandidateSelectedIds.add(a.asset_id));
    }

    const qualCnt = assets.filter(a => a.qualified).length;
    const candDupCnt = assets.filter(a => a.is_duplicate_copy).length;
    titleEl.textContent = `📂 "${momentName}" · ${assets.length} asset(s) (${qualCnt} qualified${candDupCnt > 0 ? ` · ♻️ ${candDupCnt} dup unchecked` : ''})`;

    const cached = candidateTagsCache.get(momentName);
    candidateTagState.tagDbCounts = data.tag_db_counts || sourceTagState.tagDbCounts || {};
    candidateTagState.tagCatalogByCategory = data.tag_catalog_by_category || sourceTagState.tagCatalogByCategory || {};
    if (data.name_suggestion?.family_member_pool?.length) {
      candidateTagState.familyPool = data.name_suggestion.family_member_pool;
    }
    candidateTagState.lastSession = cached?.lastSession ?? data.last_tag_session ?? null;
    candidateTagState.tags = cached?.tags?.length
      ? cached.tags.map(t => ({ ...t }))
      : buildTagListFromSuggestion(data.saved_tags, data.name_suggestion);
    renderTaggingEngineCard(candidateTagState);

    if (!assets.length) {
      gridEl.innerHTML = '<div class="text-muted font-mono" style="font-size: 0.7rem;">No active assets found in DB for this Moment.</div>';
      return;
    }

    const allIds = assets.map(a => a.asset_id);
    const histMinVal = data.historical_min ?? 0.5315;
    assets.forEach(a => {
      candidateAssetMeta.set(a.asset_id, {
        asset_id: a.asset_id,
        filename: a.original_filename,
        original_filename: a.original_filename,
        camera_model: a.camera_model || 'Library',
        primary_owner: a.primary_owner || '',
        month: a.month || (a.date_created_utc || '').slice(0, 7),
        date_created_utc: a.date_created_utc || '',
        capture_timestamp: a.date_created_utc || '',
        file_size_bytes: a.file_size_bytes || 0,
        bytes: a.file_size_bytes || 0,
        file_size_mb: (a.file_size_bytes || 0) / (1024 * 1024),
        score_normalized: a.score_normalized,
        score_quartile: a.qualified ? `Top (>${histMinVal.toFixed(4)})` : 'Below Threshold',
        assigned_moment: momentName,
        asset_tags: a.asset_tags,
        media_type: a.media_type,
        duration_sec: a.duration || 0,
        width: a.width || 0,
        height: a.height || 0,
        fps: 0,
        is_duplicate_copy: Boolean(a.is_duplicate_copy)
      });
    });

    gridEl.innerHTML = assets
      .map(a => {
        const checked = previewedCandidateSelectedIds.has(a.asset_id);
        const dupTip = a.is_duplicate_copy
          ? ` · ♻️ Dup of ${a.duplicate_keeper_filename || 'keeper'}${a.duplicate_keeper_moment ? ` (${a.duplicate_keeper_moment})` : ''}`
          : '';
        const dupTag = a.is_duplicate_copy
          ? `<span class="badge badge-xs badge-amber font-mono" style="font-size: 0.56rem; margin-left: 0.25rem;" title="${escapeHtml(dupTip)}">♻️ Dup</span>`
          : '';
        return `
          <div class="tag-db-asset-card${a.is_duplicate_copy ? ' is-dup-copy' : ''}" title="${escapeHtml(a.original_filename)} · Score ${a.score_normalized.toFixed(4)}${escapeHtml(dupTip)}">
            <input type="checkbox" class="candidate-preview-cb" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} style="cursor: pointer; flex-shrink: 0;" />
            <img class="tag-db-asset-thumb btn-preview-cand-asset" data-asset-id="${escapeHtml(a.asset_id)}" src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.original_filename)}" loading="lazy" />
            <div class="btn-preview-cand-asset" data-asset-id="${escapeHtml(a.asset_id)}" style="min-width: 0; flex: 1;">
              <div class="font-mono" style="font-size: 0.68rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(a.original_filename)}
              </div>
              <div class="font-mono text-muted" style="font-size: 0.62rem; display: flex; align-items: center; gap: 0.2rem; flex-wrap: wrap;">
                <span>${a.qualified ? '★ ' : ''}${a.score_normalized.toFixed(4)} · ${escapeHtml((a.date_created_utc || '').slice(0, 10))}</span>${dupTag}
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    gridEl.querySelectorAll<HTMLInputElement>('.candidate-preview-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const aid = cb.dataset.assetId || '';
        if (!aid) return;
        if (cb.checked) previewedCandidateSelectedIds.add(aid);
        else previewedCandidateSelectedIds.delete(aid);
      });
    });

    gridEl.querySelectorAll<HTMLElement>('.btn-preview-cand-asset').forEach(el => {
      el.addEventListener('click', () => {
        const aid = el.dataset.assetId || '';
        if (aid) {
          openCleanupPreviewModal(aid, {
            assetIds: allIds,
            groupLabel: momentName,
            hideMarkRemoved: true,
            selectedIds: previewedCandidateSelectedIds,
            onSelectionChange: (changedId, checked) => {
              const cb = gridEl.querySelector<HTMLInputElement>(
                `.candidate-preview-cb[data-asset-id="${CSS.escape(changedId)}"]`
              );
              if (cb) cb.checked = checked;
            }
          });
        }
      });
    });
  } catch (err: any) {
    titleEl.textContent = `❌ Error previewing "${momentName}"`;
    gridEl.innerHTML = `<div class="text-red font-mono" style="font-size: 0.7rem;">${escapeHtml(err?.message || 'Unknown error')}</div>`;
  }
}

function addTagToEngineState(
  state: TaggingEngineState,
  category: MomentTagItem['category'],
  rawValue: string,
  includeInName?: boolean
): void {
  const clean = rawValue.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const effInclude = includeInName !== undefined ? includeInName : category !== 'family_member';
  const existing = state.tags.find(t => t.tag_value.toLowerCase() === clean.toLowerCase());
  if (existing) {
    const catNames: Record<MomentTagItem['category'], string> = {
      activity: 'Activity',
      location: 'Location',
      people: 'People',
      when: 'When',
      family_member: 'Family Member'
    };
    const existingCatLabel = catNames[existing.category] || existing.category;
    state.saveStatusOk = false;
    state.saveStatusMsg =
      existing.category === category
        ? `⚠️ "${existing.tag_value}" is already in ${existingCatLabel} — duplicate blocked.`
        : `⚠️ "${existing.tag_value}" is already tagged under ${existingCatLabel} — remove it there first to move it (duplicate blocked).`;
    renderTaggingEngineCard(state);
    return;
  }
  state.removedTagValues.delete(clean.toLowerCase());
  state.tags.push({
    category,
    tag_value: clean,
    include_in_name: effInclude
  });
  state.saveStatusOk = true;
  state.saveStatusMsg = '';
  state.onTagsChanged();
  renderTaggingEngineCard(state);
}

function formatUnifiedMetadataSummary(tags: MomentTagItem[]): string {
  const order: Array<{ key: MomentTagItem['category']; label: string }> = [
    { key: 'activity', label: 'Activity' },
    { key: 'location', label: 'Location' },
    { key: 'people', label: 'People' },
    { key: 'when', label: 'When' },
    { key: 'family_member', label: 'Family Member' }
  ];
  const parts: string[] = [];
  order.forEach(({ key, label }) => {
    const vals = tags.filter(t => t.category === key).map(t => t.tag_value);
    if (!vals.length) return;
    parts.push(vals.length === 1 ? `${label}: ${vals[0]}` : `${label}: [${vals.join(', ')}]`);
  });
  return `{${parts.join(', ')}}`;
}

function populateTagCategoryDropdownMenu(
  menuEl: HTMLElement,
  state: TaggingEngineState,
  category: MomentTagItem['category'],
  catLabel: string,
  filterText: string
): void {
  const catalog = state.tagCatalogByCategory[category] || [];
  const filterLc = filterText.trim().toLowerCase();
  const presentLc = new Set(state.tags.map(t => t.tag_value.toLowerCase()));

  const matching = catalog
    .filter(item => !filterLc || item.tag_value.toLowerCase().includes(filterLc))
    .sort((a, b) => {
      const aAdded = presentLc.has(a.tag_value.toLowerCase()) ? 1 : 0;
      const bAdded = presentLc.has(b.tag_value.toLowerCase()) ? 1 : 0;
      if (aAdded !== bAdded) return aAdded - bAdded;
      return b.moments - a.moments || b.assets - a.assets || a.tag_value.localeCompare(b.tag_value);
    });

  if (!matching.length) {
    menuEl.innerHTML = `<div class="tag-category-dropdown-empty">${catalog.length
      ? `No applied ${escapeHtml(catLabel)} tag matches "${escapeHtml(filterText.trim())}"`
      : `No applied DB tags in ${escapeHtml(catLabel)} yet`
      }</div>`;
    return;
  }

  const headerHtml = `<div class="tag-category-dropdown-header">Applied ${escapeHtml(catLabel)} tags (${matching.length})</div>`;
  const itemsHtml = matching
    .map(item => {
      const isAdded = presentLc.has(item.tag_value.toLowerCase());
      const metaText = isAdded
        ? `✓ · ${item.moments}m/${item.assets}a`
        : `${item.moments}m · ${item.assets}a`;
      return `
        <button type="button" class="tag-category-dropdown-item${isAdded ? ' already-added' : ''}" data-cat="${category}" data-val="${escapeHtml(item.tag_value)}">
          <span class="tag-category-dropdown-label">${escapeHtml(item.tag_value)}</span>
          <span class="tag-category-dropdown-meta">${metaText}</span>
        </button>
      `;
    })
    .join('');
  menuEl.innerHTML = `${headerHtml}${itemsHtml}`;

  menuEl.querySelectorAll<HTMLButtonElement>('.tag-category-dropdown-item').forEach(itemBtn => {
    itemBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const val = itemBtn.dataset.val || '';
      if (!val) return;
      menuEl.classList.remove('open');
      addTagToEngineState(state, category, val);
    });
  });
}

function renderTaggingEngineCard(state: TaggingEngineState): void {
  const mountEl = document.getElementById(state.mountId);
  if (!mountEl) return;

  const cats: Array<{ key: MomentTagItem['category']; label: string; placeholder: string; optional?: boolean }> = [
    { key: 'activity', label: 'Activity', placeholder: '+ add activity' },
    { key: 'location', label: 'Location', placeholder: '+ add location' },
    { key: 'people', label: 'People', placeholder: '+ add person' },
    { key: 'when', label: 'When', placeholder: '+ add when' },
    { key: 'family_member', label: 'Family Member', placeholder: '+ add family', optional: true }
  ];

  const sessBadgeClass = state.lastSession ? 'badge-green' : 'badge-outline';
  const sessMetaSummary = state.lastSession
    ? state.lastSession.metadata_summary || formatUnifiedMetadataSummary(state.tags)
    : '';
  const sessBadgeText = state.lastSession
    ? state.lastSession.apply_to_folder_name
      ? `✓ Session #${state.lastSession.session_id} · Used in name (${state.lastSession.created_at_utc.slice(0, 10)})${sessMetaSummary ? ` · ${sessMetaSummary}` : ''}`
      : `✓ Session #${state.lastSession.session_id} · DB only (${state.lastSession.created_at_utc.slice(0, 10)})${sessMetaSummary ? ` · ${sessMetaSummary}` : ''}`
    : 'Not tagged yet (auto-suggested)';

  const composed = composeMomentNameFromTags(state.tags, state.momentName);

  const colsHtml = cats
    .map(c => {
      const catTags = state.tags.filter(t => t.category === c.key);
      const pillsHtml = !catTags.length
        ? `<span class="text-muted font-mono" style="font-size: 0.64rem; opacity: 0.7;">${c.optional ? 'Optional' : 'No tags'}</span>`
        : catTags
          .map(tag => {
            const dbStat = state.tagDbCounts[tag.tag_value.toLowerCase()];
            const dbCount = dbStat?.assets ?? tag.tagged_asset_count ?? 0;
            const dbMoments = dbStat?.moments ?? 0;
            const dbTitle =
              dbCount > 0
                ? `In DB (${dbCount} asset(s)${dbMoments > 0 ? ` across ${dbMoments} moment(s)` : ''}) — click to query DB assets tagged '${tag.tag_value}'`
                : `Query assets in DB tagged '${tag.tag_value}'`;
            const dbBadge = dbCount > 0 ? `<span class="tag-pill-db-count">DB</span>` : '';
            const queryKey = `${c.key}:${tag.tag_value.toLowerCase()}`;
            const isActive = state.activeQueriedTagKey === queryKey;
            return `
                <span class="tag-pill-card${tag.include_in_name ? ' included' : ''}${isActive ? ' active-query' : ''}">
                  <input type="checkbox" class="tag-pill-check" data-cat="${c.key}" data-val="${escapeHtml(tag.tag_value)}" ${tag.include_in_name ? 'checked' : ''} title="Include '${escapeHtml(tag.tag_value)}' when composing folder name" />
                  <button type="button" class="tag-pill-query-btn" data-cat="${c.key}" data-val="${escapeHtml(tag.tag_value)}" title="${escapeHtml(dbTitle)}">
                    <span>${escapeHtml(tag.tag_value)}</span>${dbBadge}
                  </button>
                  <button type="button" class="tag-pill-remove-btn" data-cat="${c.key}" data-val="${escapeHtml(tag.tag_value)}" aria-label="Remove tag" title="Remove tag">×</button>
                </span>
              `;
          })
          .join('');

      let extraHtml = '';
      if (c.key === 'family_member') {
        const presentAllTags = new Set(state.tags.map(t => t.tag_value.toLowerCase()));
        const remaining = state.familyPool.filter(f => !presentAllTags.has(f.toLowerCase()));
        extraHtml = `<div class="disjoint-mini-chips">${remaining
          .map(
            f =>
              `<button type="button" class="disjoint-mini-chip btn-quick-add-family" data-family="${escapeHtml(f)}" title="Add ${escapeHtml(f)} to Family Member tags (not added to folder name by default)">+ ${escapeHtml(f)}</button>`
          )
          .join('')}</div>`;
      }

      const labelHtml = c.optional
        ? `<label class="font-mono text-muted" style="font-size: 0.66rem; display: flex; align-items: center; justify-content: space-between; gap: 0.25rem; margin-bottom: 0.25rem;"><span>${c.label}</span><span style="font-size: 0.57rem; opacity: 0.78;">opt · DB only</span></label>`
        : `<label class="font-mono text-muted" style="font-size: 0.66rem; display: block; margin-bottom: 0.25rem;">${c.label}</label>`;

      const catCatalog = state.tagCatalogByCategory[c.key] || [];
      return `
        <div class="tag-category-col${c.optional ? ' tag-category-optional' : ''}">
          ${labelHtml}
          <div class="tag-pills-list">${pillsHtml}</div>
          ${extraHtml}
          <div class="tag-add-row">
            <input type="text" class="form-control tag-add-input tag-engine-add-input" data-cat="${c.key}" placeholder="${c.placeholder}" autocomplete="off" />
            <button type="button" class="btn btn-xs btn-outline tag-category-dropdown-toggle" data-cat="${c.key}" title="Show all applied tags in ${c.label} (${catCatalog.length})" aria-label="Show applied ${c.label} tags">▾</button>
            <button type="button" class="btn btn-xs btn-outline tag-engine-add-btn" data-cat="${c.key}">+</button>
            <div class="tag-category-dropdown-menu" data-cat="${c.key}"></div>
          </div>
        </div>
      `;
    })
    .join('');

  const copyBtnHtml = state.showCopyFromDisjointBtn
    ? `<button type="button" class="btn btn-xs btn-outline btn-engine-copy-disjoint" title="Copy tags from the Disjoint Moment box above into this existing Moment">📋 Copy from Disjoint</button>`
    : '';

  const saveStatusHtml = state.saveStatusMsg
    ? `<div class="font-mono ${state.saveStatusOk ? 'text-green' : 'text-red'}" style="font-size: 0.7rem;">${escapeHtml(state.saveStatusMsg)}</div>`
    : '';

  let queryPanelHtml = '';
  if (state.isQueryOpen) {
    const moments = state.queryData?.moments || [];
    const assets = state.queryData?.assets || [];
    const momentsHtml = moments
      .map(m => {
        const curNote = m.is_current ? ' · current' : ' · → fill target';
        return `<button type="button" class="disjoint-target-chip${m.is_current ? '' : ' suggested'} btn-query-fill-moment" data-tag-moment="${escapeHtml(m.moment_name)}" title="Click to set '${escapeHtml(m.moment_name)}' as Target Moment">
          ${escapeHtml(m.moment_name)} <span style="opacity:0.75;">(${m.asset_count}${curNote})</span>
        </button>`;
      })
      .join('');
    const assetsHtml = !state.queryData
      ? '<div class="text-muted font-mono" style="font-size: 0.7rem;">Loading matching DB assets...</div>'
      : !assets.length
        ? '<div class="text-muted font-mono" style="font-size: 0.7rem;">No assets in the DB are saved under this tag yet. Click "💾 Save Tags Only" to record it for future lookups.</div>'
        : assets
          .map(
            a => `
                <div class="tag-db-asset-card btn-query-preview-asset" data-asset-id="${escapeHtml(a.asset_id)}" title="${escapeHtml(a.moment_name)} · ${escapeHtml(a.original_filename)}">
                  <img class="tag-db-asset-thumb" src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.original_filename)}" loading="lazy" />
                  <div style="min-width: 0; flex: 1;">
                    <div class="font-mono" style="font-size: 0.69rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                      ${escapeHtml(a.original_filename)}
                    </div>
                    <div class="font-mono text-muted" style="font-size: 0.63rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                      ${escapeHtml(a.moment_name)} · ${a.score_normalized.toFixed(4)}
                    </div>
                  </div>
                </div>
              `
          )
          .join('');

    queryPanelHtml = `
      <div class="tag-db-query-panel">
        <div class="tag-db-query-header">
          <span class="font-mono" style="font-size: 0.72rem; font-weight: 600;">${escapeHtml(state.queryTitle)}</span>
          <button type="button" class="btn btn-xs btn-icon btn-engine-close-query" aria-label="Close DB Matches">✕</button>
        </div>
        ${momentsHtml ? `<div class="tag-db-moments-row">${momentsHtml}</div>` : ''}
        <div class="tag-db-assets-grid">${assetsHtml}</div>
      </div>
    `;
  }

  const saveOnlyLabel = state.hideSaveUseBtn ? '💾 Save DB Tags (This Batch)' : '💾 Save Tags Only (Keep Name)';
  const saveUseBtnHtml = state.hideSaveUseBtn
    ? ''
    : `<button type="button" class="btn btn-xs btn-purple btn-engine-save-use" ${state.isSaving ? 'disabled' : ''} title="Record tagging session into DB AND copy checked tags into Target Moment Album Name">
            ✨ Save Tags &amp; Use for Name
          </button>`;

  mountEl.innerHTML = `
    <div class="disjoint-suggestion-box">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
          <strong style="font-size: 0.84rem; color: #f5f3ff;">${escapeHtml(state.titleLabel)} · <code>${escapeHtml(state.momentName || '—')}</code></strong>
          <span class="badge badge-xs ${sessBadgeClass} font-mono" style="white-space: normal; text-align: left; line-height: 1.35;">${escapeHtml(sessBadgeText)}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
          ${copyBtnHtml}
          <button type="button" class="btn btn-xs btn-outline btn-engine-save-only" ${state.isSaving ? 'disabled' : ''} title="Record tagging session into media_organizer.db for ONLY this Moment's selected assets without changing folder names">
            ${saveOnlyLabel}
          </button>
          ${saveUseBtnHtml}
        </div>
      </div>
      <div class="disjoint-suggested-headline">
        <span class="font-mono text-muted" style="font-size: 0.66rem; font-weight: 400; display: block; margin-bottom: 0.12rem;">Picked Tags (✓) → Flat Folder Name Preview · Click any pill text to query DB assets already tagged</span>
        <span>${escapeHtml(composed || '—')}</span>
      </div>
      <div class="disjoint-paradigm-grid">${colsHtml}</div>
      ${saveStatusHtml}
      ${queryPanelHtml}
    </div>
  `;

  // Wire all interactive events cleanly on this rendered card
  mountEl.querySelectorAll<HTMLInputElement>('.tag-pill-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const c = cb.dataset.cat as MomentTagItem['category'];
      const v = cb.dataset.val || '';
      const item = state.tags.find(t => t.category === c && t.tag_value === v);
      if (item) item.include_in_name = cb.checked;
      state.onTagsChanged();
      renderTaggingEngineCard(state);
    });
  });

  mountEl.querySelectorAll<HTMLButtonElement>('.tag-pill-query-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = (btn.dataset.cat as MomentTagItem['category']) || 'activity';
      const v = btn.dataset.val || '';
      if (v) void queryDbAssetsForEngineState(state, v, c);
    });
  });

  mountEl.querySelectorAll<HTMLButtonElement>('.tag-pill-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.cat as MomentTagItem['category'];
      const v = btn.dataset.val || '';
      state.tags = state.tags.filter(t => !(t.category === c && t.tag_value === v));
      if (v) {
        state.removedTagValues.add(v.toLowerCase());
      }
      if (state.activeQueriedTagKey === `${c}:${v.toLowerCase()}`) {
        state.activeQueriedTagKey = '';
        state.isQueryOpen = false;
      }
      state.onTagsChanged();
      renderTaggingEngineCard(state);
    });
  });

  mountEl.querySelectorAll<HTMLButtonElement>('.btn-quick-add-family').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.family || '';
      if (f) addTagToEngineState(state, 'family_member', f, false);
    });
  });

  mountEl.querySelectorAll<HTMLButtonElement>('.tag-engine-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = (btn.dataset.cat as MomentTagItem['category']) || 'activity';
      const inp = mountEl.querySelector<HTMLInputElement>(`.tag-engine-add-input[data-cat="${c}"]`);
      const val = (inp?.value || '').trim();
      if (!val) return;
      addTagToEngineState(state, c, val);
    });
  });

  const closeAllDropdowns = (exceptMenu?: HTMLElement | null): void => {
    mountEl.querySelectorAll<HTMLElement>('.tag-category-dropdown-menu.open').forEach(m => {
      if (m !== exceptMenu) m.classList.remove('open');
    });
  };

  const openCatDropdown = (catKey: MomentTagItem['category'], filterVal: string): void => {
    const menuEl = mountEl.querySelector<HTMLElement>(`.tag-category-dropdown-menu[data-cat="${catKey}"]`);
    if (!menuEl) return;
    closeAllDropdowns(menuEl);
    const catMeta = cats.find(c => c.key === catKey);
    populateTagCategoryDropdownMenu(menuEl, state, catKey, catMeta?.label || catKey, filterVal);
    menuEl.classList.remove('open-upward');
    menuEl.style.maxHeight = '';
    menuEl.classList.add('open');

    const anchorEl = menuEl.parentElement || menuEl;
    const rect = anchorEl.getBoundingClientRect();
    const clipEl = menuEl.closest<HTMLElement>('.modal-body');
    const clipRect = clipEl ? clipEl.getBoundingClientRect() : null;
    const visibleBottom = clipRect ? Math.min(window.innerHeight, clipRect.bottom) : window.innerHeight;
    const visibleTop = clipRect ? Math.max(0, clipRect.top) : 0;
    const spaceBelow = visibleBottom - rect.bottom - 10;
    const spaceAbove = rect.top - visibleTop - 10;
    if (spaceBelow < 180 && spaceAbove > spaceBelow) {
      menuEl.classList.add('open-upward');
      menuEl.style.maxHeight = `${Math.max(120, Math.min(280, Math.floor(spaceAbove)))}px`;
    } else {
      menuEl.style.maxHeight = `${Math.max(120, Math.min(280, Math.floor(spaceBelow)))}px`;
    }
  };

  mountEl.querySelectorAll<HTMLElement>('.tag-category-dropdown-menu').forEach(menuEl => {
    menuEl.addEventListener('mousedown', (e) => {
      // Prevent input blur when clicking or dragging the dropdown scrollbar
      e.preventDefault();
    });
  });

  mountEl.querySelectorAll<HTMLButtonElement>('.tag-category-dropdown-toggle').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const c = (btn.dataset.cat as MomentTagItem['category']) || 'activity';
      const menuEl = mountEl.querySelector<HTMLElement>(`.tag-category-dropdown-menu[data-cat="${c}"]`);
      const inp = mountEl.querySelector<HTMLInputElement>(`.tag-engine-add-input[data-cat="${c}"]`);
      if (menuEl?.classList.contains('open')) {
        menuEl.classList.remove('open');
      } else {
        openCatDropdown(c, inp?.value || '');
        inp?.focus();
      }
    });
  });

  mountEl.querySelectorAll<HTMLInputElement>('.tag-engine-add-input').forEach(inp => {
    const c = (inp.dataset.cat as MomentTagItem['category']) || 'activity';
    inp.addEventListener('focus', () => {
      openCatDropdown(c, inp.value);
    });
    inp.addEventListener('input', () => {
      openCatDropdown(c, inp.value);
    });
    inp.addEventListener('blur', () => {
      const menuEl = mountEl.querySelector<HTMLElement>(`.tag-category-dropdown-menu[data-cat="${c}"]`);
      if (menuEl) menuEl.classList.remove('open');
    });
    inp.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      const menuEl = mountEl.querySelector<HTMLElement>(`.tag-category-dropdown-menu[data-cat="${c}"]`);
      if (ke.key === 'Escape') {
        menuEl?.classList.remove('open');
        return;
      }
      if (ke.key === 'ArrowDown' || ke.key === 'ArrowUp') {
        ke.preventDefault();
        if (menuEl && !menuEl.classList.contains('open')) {
          openCatDropdown(c, inp.value);
        }
        const items = Array.from(
          menuEl?.querySelectorAll<HTMLButtonElement>('.tag-category-dropdown-item:not(.already-added)') || []
        );
        if (!items.length) return;
        const curIdx = items.findIndex(el => el.classList.contains('highlighted'));
        items.forEach(el => el.classList.remove('highlighted'));
        const nextIdx =
          ke.key === 'ArrowDown'
            ? (curIdx + 1) % items.length
            : (curIdx - 1 + items.length) % items.length;
        items[nextIdx].classList.add('highlighted');
        items[nextIdx].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (ke.key === 'Enter') {
        ke.preventDefault();
        const highlighted = menuEl?.querySelector<HTMLButtonElement>('.tag-category-dropdown-item.highlighted');
        const val = (highlighted?.dataset.val || inp.value).trim();
        if (!val) return;
        menuEl?.classList.remove('open');
        addTagToEngineState(state, c, val);
      }
    });
  });

  mountEl.querySelector('.btn-engine-save-only')?.addEventListener('click', () => {
    void saveMomentTagsForState(state, false);
  });
  mountEl.querySelector('.btn-engine-save-use')?.addEventListener('click', () => {
    void saveMomentTagsForState(state, true);
  });
  mountEl.querySelector('.btn-engine-copy-disjoint')?.addEventListener('click', () => {
    if (state.onCopyFromDisjoint) state.onCopyFromDisjoint();
  });
  mountEl.querySelector('.btn-engine-close-query')?.addEventListener('click', () => {
    state.activeQueriedTagKey = '';
    state.isQueryOpen = false;
    renderTaggingEngineCard(state);
  });

  mountEl.querySelectorAll<HTMLButtonElement>('.btn-query-fill-moment').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetName = btn.dataset.tagMoment || '';
      if (targetName && targetName.toLowerCase() !== resolveDisjointMomentName.toLowerCase()) {
        applyTargetMomentName(targetName, true);
      }
    });
  });

  const qAssets = state.queryData?.assets || [];
  const qIdsList = qAssets.map(a => a.asset_id);
  mountEl.querySelectorAll<HTMLElement>('.btn-query-preview-asset').forEach(card => {
    card.addEventListener('click', () => {
      const aid = card.dataset.assetId || '';
      if (aid) {
        openCleanupPreviewModal(aid, {
          assetIds: qIdsList,
          groupLabel: state.queryTitle || 'DB Tag Assets',
          hideMarkRemoved: true
        });
      }
    });
  });
}

async function queryDbAssetsForEngineState(
  state: TaggingEngineState,
  tagValue: string,
  category: MomentTagItem['category']
): Promise<void> {
  state.activeQueriedTagKey = `${category}:${tagValue.toLowerCase()}`;
  state.isQueryOpen = true;
  state.queryTitle = `🔎 Querying DB for tag "${tagValue}"...`;
  state.queryData = null;
  renderTaggingEngineCard(state);

  try {
    const qs = new URLSearchParams({
      tag_value: tagValue,
      category,
      exclude_moment: state.momentName
    });
    const res = await fetch(`/api/media/memories/tags/by-tag?${qs.toString()}`);
    const data: TagLookupResponse = await res.json();
    if (!res.ok || !data.ok) {
      state.queryTitle = `🔎 DB Query Error: ${data.error || `HTTP ${res.status}`}`;
      state.queryData = { ok: false, assets: [], moments: [] };
      renderTaggingEngineCard(state);
      return;
    }

    (data.assets || []).forEach(a => {
      if (!candidateAssetMeta.has(a.asset_id)) {
        candidateAssetMeta.set(a.asset_id, {
          asset_id: a.asset_id,
          filename: a.original_filename,
          original_filename: a.original_filename,
          camera_model: 'Library',
          primary_owner: '',
          month: (a.date_created_utc || '').slice(0, 7),
          date_created_utc: a.date_created_utc || '',
          capture_timestamp: a.date_created_utc || '',
          file_size_bytes: 0,
          bytes: 0,
          file_size_mb: 0,
          score_normalized: a.score_normalized,
          score_quartile: a.score_normalized > 0.5315 ? 'Top (>0.5315)' : 'Library',
          assigned_moment: a.moment_name,
          media_type: a.media_type,
          duration_sec: 0,
          width: 0,
          height: 0,
          fps: 0
        });
      }
    });

    const totalAssets = data.total_assets ?? 0;
    const totalMoments = data.total_moments ?? 0;
    state.queryTitle = `🔎 DB Assets Tagged "${tagValue}" · ${totalAssets} asset(s) across ${totalMoments} moment(s)`;
    state.queryData = data;
    renderTaggingEngineCard(state);
  } catch (err: any) {
    state.queryTitle = `🔎 Error querying tag "${tagValue}": ${err?.message || 'Unknown'}`;
    state.queryData = { ok: false, assets: [], moments: [] };
    renderTaggingEngineCard(state);
  }
}

async function saveMomentTagsForState(state: TaggingEngineState, applyToFolderName: boolean): Promise<void> {
  if (!state.momentName || state.isSaving) return;
  const composed = composeMomentNameFromTags(state.tags, state.momentName);
  const assetIds = state.getSelectedAssetIds();

  state.isSaving = true;
  state.saveStatusMsg = `Saving DB tags for "${state.momentName}"...`;
  state.saveStatusOk = true;
  renderTaggingEngineCard(state);

  try {
    const res = await fetch('/api/media/memories/tags/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moment_name: state.momentName,
        tags: state.tags.map(t => ({
          category: t.category,
          tag_value: t.tag_value,
          include_in_name: t.include_in_name
        })),
        asset_ids: assetIds,
        apply_to_folder_name: applyToFolderName,
        composed_name: applyToFolderName ? composed : null,
        merge_existing: true,
        removed_tags: Array.from(state.removedTagValues),
        include_all_moment_assets: state === sourceTagState && resolveDisjointIsHistoricalMoment
      })
    });
    const rawText = await res.text();
    let data: SaveMomentTagsResponse;
    try {
      data = rawText ? JSON.parse(rawText) : { ok: false };
    } catch {
      state.saveStatusOk = false;
      state.saveStatusMsg = `❌ Server returned HTTP ${res.status}: ${rawText.slice(0, 140) || 'Invalid JSON'}`;
      return;
    }
    if (!res.ok || !data.ok) {
      state.saveStatusOk = false;
      state.saveStatusMsg = `❌ Failed saving tags: ${data.error || `HTTP ${res.status}`}`;
      return;
    }

    state.removedTagValues.clear();
    if (Array.isArray(data.saved_tags)) {
      state.tags = data.saved_tags.map(t => ({ ...t }));
    }
    state.lastSession = {
      session_id: data.session_id || 0,
      moment_name: state.momentName,
      apply_to_folder_name: applyToFolderName,
      composed_name: applyToFolderName ? composed : '',
      asset_count: data.assets_tagged ?? assetIds.length,
      created_at_utc: data.created_at_utc || '',
      metadata_summary: data.metadata_summary || formatUnifiedMetadataSummary(state.tags)
    };
    if (state === candidateTagState && state.momentName) {
      candidateTagsCache.set(state.momentName, {
        tags: state.tags.map(t => ({ ...t })),
        lastSession: state.lastSession
      });
    }
    if (data.tag_db_counts || data.tag_catalog_by_category) {
      if (data.tag_db_counts) {
        sourceTagState.tagDbCounts = data.tag_db_counts;
        candidateTagState.tagDbCounts = data.tag_db_counts;
        publishTagState.tagDbCounts = data.tag_db_counts;
      }
      if (data.tag_catalog_by_category) {
        sourceTagState.tagCatalogByCategory = data.tag_catalog_by_category;
        candidateTagState.tagCatalogByCategory = data.tag_catalog_by_category;
        publishTagState.tagCatalogByCategory = data.tag_catalog_by_category;
      }
      if (state === candidateTagState && sourceTagState.momentName) {
        renderTaggingEngineCard(sourceTagState);
      } else if (state === sourceTagState && candidateTagState.momentName) {
        renderTaggingEngineCard(candidateTagState);
      }
    }

    const updatedComposed = composeMomentNameFromTags(state.tags, state.momentName);
    if (applyToFolderName && (updatedComposed || composed)) {
      state.onUseForName(updatedComposed || composed);
    }
    state.onTagsChanged();
    if (state === publishTagState) {
      publishTagsDirty = false;
    }
    void Promise.all([fetchPlannerOverview(true, 'm'), fetchMemoriesFolders()]);
    if (plannerRefreshMediaMetricsCb) plannerRefreshMediaMetricsCb();
    const mergedNote = (data.merged_existing_count ?? 0) > 0 ? ` · merged ${data.merged_existing_count} existing DB tag(s)` : '';
    state.saveStatusOk = true;
    state.saveStatusMsg = applyToFolderName
      ? `✅ Session #${data.session_id}: ${data.tags_saved} tag(s) saved for ${data.assets_tagged} "${state.momentName}" asset(s)${mergedNote} & applied "${updatedComposed || composed}" to Target.`
      : `✅ Session #${data.session_id}: ${data.tags_saved} tag(s) saved in DB for "${state.momentName}" (${data.assets_tagged} asset(s)${mergedNote}, folder name unchanged).`;
  } catch (err: any) {
    state.saveStatusOk = false;
    state.saveStatusMsg = `❌ Network error saving tags: ${err?.message || 'Unknown error'}`;
  } finally {
    state.isSaving = false;
    renderTaggingEngineCard(state);
  }
}

function isM200DirectCurateTarget(_rawTarget?: string): boolean {
  return resolveDisjointIsCurateM200;
}

function getCombinedSelectedAssetCount(): number {
  let total = resolveDisjointAssets.filter(a => resolveDisjointSelectedIds.has(a.asset_id)).length;
  combinedExtraMoments.forEach(entry => {
    total += entry.assetIds.size;
  });
  return total;
}

function updateResolveDisjointTargetPreview(): void {
  const previewEl = document.getElementById('resolve-disjoint-target-path-preview');
  const statusNoteEl = document.getElementById('resolve-disjoint-target-status-note');
  const parentSel = document.getElementById('resolve-disjoint-parent-select') as HTMLSelectElement | null;
  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const btnSubmit = document.getElementById('btn-submit-resolve-disjoint') as HTMLButtonElement | null;
  const rawTarget = (targetInp?.value || '').trim();
  const targetName = rawTarget || '—';

  const manualCurateActive = resolveDisjointIsCurateM200;
  const existingCurated = rawTarget ? getExistingTargetAlbumInfo('Curated', rawTarget).exists : false;

  if (parentSel) {
    const curatedOpt = parentSel.querySelector<HTMLOptionElement>('option[value="Curated"]');
    if (curatedOpt) {
      curatedOpt.disabled = !manualCurateActive && !existingCurated;
    }
    if (manualCurateActive) {
      parentSel.value = 'Curated';
      parentSel.disabled = true;
    } else {
      parentSel.disabled = false;
      if (!existingCurated && parentSel.value === 'Curated') {
        parentSel.value = 'Moments';
      }
    }
  }

  const srcGrouping = allGroupingsData?.groupings.find(
    g => g.name.toLowerCase() === (resolveDisjointMomentName || '').trim().toLowerCase()
  );
  const srcIsOrganizerAlbum = Boolean(srcGrouping?.in_organizer_library);
  const delSrcRowEl = document.getElementById('resolve-disjoint-delete-source-row');
  const roSrcNoteEl = document.getElementById('resolve-disjoint-readonly-source-note');
  const delTbcRowEl = document.getElementById('curate-m200-delete-tbc-row');
  const exportRowEl = document.getElementById('curate-m200-export-row');
  const boxTitleEl = document.getElementById('curate-m200-box-title');
  const curateCountsEl = document.getElementById('curate-m200-counts-summary');

  if (delSrcRowEl) delSrcRowEl.style.display = !manualCurateActive && srcIsOrganizerAlbum ? 'flex' : 'none';
  if (roSrcNoteEl) roSrcNoteEl.style.display = !srcIsOrganizerAlbum ? 'flex' : 'none';

  if (manualCurateActive) {
    if (delTbcRowEl) delTbcRowEl.style.display = srcIsOrganizerAlbum ? 'flex' : 'none';
    if (exportRowEl) exportRowEl.style.display = 'flex';
    if (boxTitleEl) {
      boxTitleEl.textContent = '🎨 Manual Curation Workflow (Approve Keepers ➜ Curated ➜ Ready to Publish)';
    }
    if (curateCountsEl) {
      const selPri = resolveDisjointAssets.filter(a => resolveDisjointSelectedIds.has(a.asset_id)).length;
      const unselPri = Math.max(0, resolveDisjointAssets.length - selPri);
      const totalSel = getCombinedSelectedAssetCount();
      const { expected } = computeExpectedCuratedStats(getCombinedPoolTotalCount());
      curateCountsEl.className = 'badge badge-xs badge-green font-mono';
      curateCountsEl.textContent = `${totalSel} keeper(s) (🎯 exp ${expected}) ➜ Curated · ${unselPri} unselected`;
    }
  }

  const parentName = parentSel?.value || (manualCurateActive ? 'Curated' : 'Moments');
  const existingInfo = targetName !== '—' ? getExistingTargetAlbumInfo(parentName, targetName) : { exists: false, assetCount: 0 };

  if (statusNoteEl) {
    if (targetName === '—') {
      statusNoteEl.textContent = '';
    } else if (existingInfo.exists) {
      statusNoteEl.style.color = '#a7f3d0';
      statusNoteEl.textContent = `(existing folder · ${existingInfo.assetCount} asset(s) — copies missing only)`;
    } else {
      statusNoteEl.style.color = '';
      statusNoteEl.textContent = '(new folder)';
    }
  }

  if (previewEl) {
    const statusNote =
      targetName === '—'
        ? ''
        : existingInfo.exists
          ? ` <span class="font-mono" style="font-size: 0.74rem; font-weight: 500; color: #a7f3d0;">(existing folder · ${existingInfo.assetCount} asset(s) — copies missing only)</span>`
          : ` <span class="font-mono text-muted" style="font-size: 0.74rem; font-weight: 500;">(new folder)</span>`;
    previewEl.innerHTML = `${escapeHtml(`Media Organizer.photoslibrary / ${parentName} / `)}<span class="target-path-leaf">${escapeHtml(targetName)}</span>${statusNote}`;
  }

  if (btnSubmit && !resolveDisjointCompleted) {
    const totalSelCount = getCombinedSelectedAssetCount();
    const poolTotalVal = getCombinedPoolTotalCount();
    const { expected } = computeExpectedCuratedStats(poolTotalVal);
    if (manualCurateActive) {
      const matchesLogTarget = poolTotalVal > 0 && totalSelCount === expected;
      btnSubmit.disabled = !matchesLogTarget && !isSubmittingResolveDisjoint;
      const exportChecked = (document.getElementById('curate-m200-export-lacie') as HTMLInputElement | null)?.checked ?? true;
      if (!matchesLogTarget && poolTotalVal > 0) {
        btnSubmit.textContent = `⚠️ Select ${expected} Keeper${expected === 1 ? '' : 's'} (ln ${poolTotalVal}) to Curate — Currently ${totalSelCount}`;
        btnSubmit.title = `Curated count must match logarithmic target round(ln(${poolTotalVal})) = ${expected} to mark Moment as Curated & unlock Publish (click "🎯 Select Top ${expected}" above or uncheck Manual Curation to save uncurated into Moments)`;
      } else {
        btnSubmit.textContent = exportChecked
          ? `🎨 Curate & Export ➜ Ready to Publish (${totalSelCount} / exp ${expected} ✓)`
          : `🎨 Approve Keepers into Curated (${totalSelCount} / exp ${expected} ✓)`;
        btnSubmit.title =
          'Import/place selected keepers into Media Organizer.photoslibrary / Curated / [Target], save DB tags, handle unselected items, and export to LaCie so the Moment is ready to Publish';
      }
    } else {
      btnSubmit.disabled = isSubmittingResolveDisjoint;
      if (existingInfo.exists) {
        btnSubmit.textContent = `➕ Add Missing Assets & Tag Existing (${totalSelCount})`;
        btnSubmit.title = 'Destination folder already exists — copy only missing assets into Media Organizer and update DB tags';
      } else {
        btnSubmit.textContent = `✨ Merge & Tag into Moments (${totalSelCount})`;
        btnSubmit.title = 'Consolidate source(s) + apply DB tags into Media Organizer.photoslibrary / Moments / [Target]';
      }
    }
  }
}

export async function openResolveDisjointModal(
  momentName: string,
  suggestedTarget = '',
  options?: { assetIds?: string[]; isUnassignedCluster?: boolean; isHistoricalMoment?: boolean; isCurateM200?: boolean }
): Promise<void> {
  const isUnassigned = Boolean(options?.isUnassignedCluster);
  const isHistorical = Boolean(options?.isHistoricalMoment);
  const isCurateM200 = Boolean(options?.isCurateM200);
  const explicitIds = (options?.assetIds || []).map(s => (s || '').trim()).filter(Boolean);
  resolveDisjointMomentName = momentName;
  resolveDisjointIsUnassignedCluster = isUnassigned;
  resolveDisjointIsHistoricalMoment = isHistorical;
  resolveDisjointIsCurateM200 = isCurateM200;
  resolveDisjointExplicitAssetIds = explicitIds;
  resolveDisjointAssets = [];
  resolveDisjointSelectedIds.clear();
  disjointFilterCuratedOnly = false;
  sourceTagState.momentName = momentName;
  sourceTagState.tags = [];
  sourceTagState.removedTagValues.clear();
  sourceTagState.lastSession = null;
  sourceTagState.tagDbCounts = {};
  sourceTagState.tagCatalogByCategory = {};
  sourceTagState.activeQueriedTagKey = '';
  sourceTagState.saveStatusMsg = '';
  sourceTagState.isQueryOpen = false;
  sourceTagState.queryData = null;

  candidateTagState.momentName = '';
  candidateTagState.tags = [];
  candidateTagState.removedTagValues.clear();
  candidateTagState.lastSession = null;
  candidateTagState.tagDbCounts = {};
  candidateTagState.tagCatalogByCategory = {};
  candidateTagState.isQueryOpen = false;
  candidateTagState.saveStatusMsg = '';

  combinedExtraMoments.clear();
  candidateTagsCache.clear();
  previewedCandidateMomentName = '';
  previewedCandidateAssets = [];
  previewedCandidateSelectedIds.clear();
  nearbyMomentCandidatesList = [];
  displayedCandidateMomentsList = [];
  existingTargetAlbumsMap.clear();
  existingAlbumsList = [];
  lastAutoSyncedTargetName = '';
  targetNameManuallyEdited = false;
  setResolveDisjointCompletedState(false);

  const modal = document.getElementById('modal-resolve-disjoint');
  const titleEl = document.getElementById('resolve-disjoint-modal-title');
  const badgeEl = document.getElementById('resolve-disjoint-badge');
  const summaryEl = document.getElementById('resolve-disjoint-summary-banner');
  const albumsBarEl = document.getElementById('resolve-disjoint-albums-bar');
  const listEl = document.getElementById('resolve-disjoint-asset-list');
  const chipsEl = document.getElementById('resolve-disjoint-nearby-chips');
  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const parentSel = document.getElementById('resolve-disjoint-parent-select') as HTMLSelectElement | null;
  const delSrcCb = document.getElementById('resolve-disjoint-delete-source') as HTMLInputElement | null;
  const savePerSrcCb = document.getElementById('resolve-disjoint-save-per-source-tags') as HTMLInputElement | null;
  const shareDisjointCb = document.getElementById('resolve-disjoint-share-disjoint-tags') as HTMLInputElement | null;
  const searchInp = document.getElementById('resolve-disjoint-moment-search') as HTMLInputElement | null;
  const candPreviewEl = document.getElementById('resolve-disjoint-candidate-preview-panel');
  const statusEl = document.getElementById('resolve-disjoint-status');

  if (titleEl) {
    titleEl.textContent = isCurateM200
      ? `🎨 Curate M200 Moment (Tag & Approve ➜ Curated) · ${momentName}`
      : isUnassigned
        ? `🏷️ Tag & Consolidate Unassigned Group · ${momentName}`
        : isHistorical
          ? `🏷️ Tag Historical Moment (All Assets) · ${momentName}`
          : `🏷️ Tag & Consolidate Moment · ${momentName}`;
  }
  if (badgeEl) badgeEl.textContent = 'loading...';
  if (summaryEl) {
    summaryEl.innerHTML = isCurateM200
      ? '<div class="spinner-sm"></div><span>Inspecting proposed ToBeCurated Moment assets, DB tags, and Curated destination...</span>'
      : isUnassigned
        ? '<div class="spinner-sm"></div><span>Inspecting unassigned group assets, duplicates, DB tags, and nearby Moment candidates...</span>'
        : '<div class="spinner-sm"></div><span>Inspecting Moment assets, DB tags, and consolidation candidates...</span>';
  }
  const curateBoxEl = document.getElementById('resolve-disjoint-curate-box');
  const manCurToggle = document.getElementById('resolve-disjoint-manual-curate-toggle') as HTMLInputElement | null;
  const delSrcRowEl = document.getElementById('resolve-disjoint-delete-source-row');
  const roSrcNoteEl = document.getElementById('resolve-disjoint-readonly-source-note');
  const handleUnselCb = document.getElementById('curate-m200-handle-unselected') as HTMLInputElement | null;
  const unselActionSel = document.getElementById('curate-m200-unselected-action') as HTMLSelectElement | null;
  const delTbcCb = document.getElementById('curate-m200-delete-tbc') as HTMLInputElement | null;
  const exportLacieCb = document.getElementById('curate-m200-export-lacie') as HTMLInputElement | null;
  const srcGrouping = allGroupingsData?.groupings.find(g => g.name.toLowerCase() === momentName.trim().toLowerCase());
  const srcIsOrganizerAlbum = Boolean(srcGrouping?.in_organizer_library);
  if (manCurToggle) manCurToggle.checked = isCurateM200;
  if (curateBoxEl) curateBoxEl.style.display = isCurateM200 ? 'flex' : 'none';
  if (delSrcRowEl) delSrcRowEl.style.display = !isCurateM200 && srcIsOrganizerAlbum ? 'flex' : 'none';
  if (roSrcNoteEl) roSrcNoteEl.style.display = !isCurateM200 && !srcIsOrganizerAlbum ? 'flex' : 'none';
  if (handleUnselCb) handleUnselCb.checked = true;
  if (unselActionSel) unselActionSel.value = 'ignore';
  if (delTbcCb) delTbcCb.checked = srcIsOrganizerAlbum;
  if (exportLacieCb) exportLacieCb.checked = true;

  if (albumsBarEl) albumsBarEl.style.display = 'none';
  if (listEl) listEl.innerHTML = '';
  if (chipsEl) chipsEl.innerHTML = '<span class="text-muted font-mono" style="font-size: 0.69rem;">Searching nearby Moments...</span>';
  if (targetInp) targetInp.value = '';
  if (parentSel) {
    parentSel.value = isCurateM200 ? 'Curated' : 'Moments';
    parentSel.disabled = isCurateM200;
  }
  if (delSrcCb) delSrcCb.checked = true;
  if (savePerSrcCb) savePerSrcCb.checked = true;
  if (shareDisjointCb) shareDisjointCb.checked = false;
  if (searchInp) searchInp.value = '';
  if (candPreviewEl) candPreviewEl.style.display = 'none';
  renderTaggingEngineCard(sourceTagState);
  renderPropagateTagsPreview();
  renderResolveDisjointCombineTray();
  updateResolveDisjointTargetPreview();
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.innerHTML = '';
  }

  modal?.classList.add('open');

  try {
    let res: Response;
    if (explicitIds.length > 0) {
      res = await fetch('/api/media/memories/disjoint-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moment_name: momentName,
          suggested_target: suggestedTarget,
          asset_ids: explicitIds
        })
      });
    } else {
      const qs = new URLSearchParams({ moment_name: momentName });
      if (suggestedTarget) qs.set('suggested_target', suggestedTarget);
      res = await fetch(`/api/media/memories/disjoint-detail?${qs.toString()}`);
    }
    const data: DisjointDetailResponse = await res.json();
    if (!res.ok || !data.ok) {
      if (summaryEl) {
        summaryEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    const assets = data.assets || [];
    resolveDisjointAssets = assets;
    const histMinVal = data.historical_min ?? 0.5315;
    assets.forEach(a => {
      if ((isHistorical ? !a.is_duplicate_copy : a.qualified && !a.is_duplicate_copy)) {
        resolveDisjointSelectedIds.add(a.asset_id);
      }
      const sizeBytes = a.file_size_bytes || 0;
      candidateAssetMeta.set(a.asset_id, {
        asset_id: a.asset_id,
        filename: a.original_filename,
        original_filename: a.original_filename,
        camera_model: a.camera_model || 'Library',
        primary_owner: a.primary_owner || '',
        month: a.month || (a.date_created_utc || '').slice(0, 7),
        date_created_utc: a.date_created_utc || '',
        capture_timestamp: a.date_created_utc || '',
        file_size_bytes: sizeBytes,
        bytes: sizeBytes,
        file_size_mb: sizeBytes / (1024 * 1024),
        score_normalized: a.score_normalized,
        score_quartile: a.qualified ? `Top (>${histMinVal.toFixed(4)})` : 'Below Threshold',
        assigned_moment: momentName,
        asset_tags: a.asset_tags,
        media_type: a.media_type,
        duration_sec: a.duration || 0,
        width: a.width || 0,
        height: a.height || 0,
        fps: 0,
        is_duplicate_copy: Boolean(a.is_duplicate_copy)
      });
    });
    if (isCurateM200 && assets.length > 0 && !srcGrouping?.manually_curated) {
      // In Manual Curation mode, default keeper selection to the top ln(N) highest-scoring non-duplicate assets
      const { expected } = computeExpectedCuratedStats(assets.length);
      const nonDups = assets.filter(a => !a.is_duplicate_copy);
      const ranked = [...(nonDups.length ? nonDups : assets)].sort(
        (a, b) => b.score_normalized - a.score_normalized
      );
      resolveDisjointSelectedIds.clear();
      ranked.slice(0, expected).forEach(a => resolveDisjointSelectedIds.add(a.asset_id));
    } else if (resolveDisjointSelectedIds.size === 0) {
      const nonDups = assets.filter(a => !a.is_duplicate_copy);
      (nonDups.length ? nonDups : assets).forEach(a => resolveDisjointSelectedIds.add(a.asset_id));
    }

    const qualCount = assets.filter(a => a.qualified).length;
    const belowCount = assets.length - qualCount;
    const histMin = data.historical_min ?? 0.5315;
    const { expected: initExp, lnRaw: initLn } = computeExpectedCuratedStats(assets.length);
    if (badgeEl) {
      badgeEl.textContent = `${qualCount} qual · ${assets.length} total · 🎯 exp ${initExp} (ln=${initLn.toFixed(2)})`;
    }
    if (summaryEl) {
      summaryEl.innerHTML = isUnassigned
        ? `
          <span>
            Unassigned group <strong>${escapeHtml(momentName)}</strong> has <strong>${qualCount}</strong> qualified asset(s) (&gt; ${histMin.toFixed(4)})
            ${belowCount > 0 ? `and <strong>${belowCount}</strong> lower-rated asset(s)` : ''}.
            Review duplicates, tag in DB, click any existing Moment pill to preview &amp; merge, or create a New Format Moment.
          </span>
        `
        : `
          <span>
            <strong>${escapeHtml(momentName)}</strong> has <strong>${qualCount}</strong> qualified asset(s) (&gt; ${histMin.toFixed(4)})
            ${belowCount > 0 ? `and <strong>${belowCount}</strong> lower-rated asset(s) inside Apple Photos albums` : ''}.
            Tag independently in DB, click any existing Moment pill to preview &amp; tag its assets identically, or consolidate into a New Format Moment.
          </span>
        `;
    }

    sourceTagState.tagDbCounts = data.tag_db_counts || {};
    sourceTagState.tagCatalogByCategory = data.tag_catalog_by_category || {};
    sourceTagState.lastSession = data.last_tag_session ?? null;
    if (data.name_suggestion?.family_member_pool?.length) {
      sourceTagState.familyPool = data.name_suggestion.family_member_pool;
    }
    sourceTagState.tags = buildTagListFromSuggestion(data.saved_tags, data.name_suggestion);
    renderTaggingEngineCard(sourceTagState);

    const albumsPresent = data.albums_present || [];
    if (albumsBarEl) {
      if (albumsPresent.length) {
        albumsBarEl.style.display = 'flex';
        albumsBarEl.innerHTML = `
          <div>
            <span class="font-mono text-muted" style="font-size: 0.68rem; display: block;">Apple Photos Albums Containing This Moment</span>
            <span class="font-mono" style="font-size: 0.72rem;">${albumsPresent
            .map(al => `${escapeHtml(al.parent)} (${al.asset_count})`)
            .join(' · ')}</span>
          </div>
        `;
      } else {
        albumsBarEl.style.display = 'none';
      }
    }

    existingTargetAlbumsMap.clear();
    existingAlbumsList = data.existing_albums || [];
    existingAlbumsList.forEach(al => {
      const k = `${(al.parent_folder_name || 'Moments').trim().toLowerCase()}::${(al.album_name || '').trim().toLowerCase()}`;
      existingTargetAlbumsMap.set(k, al.asset_count ?? 0);
    });

    const fallbackName = isUnassigned && /uncategorized/i.test(momentName) ? '' : momentName;
    const defaultNewName = composeMomentNameFromTags(sourceTagState.tags, fallbackName);
    const hasCustomTypedTarget = Boolean(
      isUnassigned && suggestedTarget && !/uncategorized/i.test(suggestedTarget) && !(data.saved_tags?.length)
    );
    const effectiveDefault = hasCustomTypedTarget
      ? suggestedTarget
      : (defaultNewName || data.suggested_target || suggestedTarget || '');
    if (effectiveDefault) {
      applyTargetMomentName(effectiveDefault, false);
    }

    nearbyMomentCandidatesList = data.nearby_candidates || [];
    renderCandidateMomentChips(nearbyMomentCandidatesList);
    renderResolveDisjointCombineTray();
    renderPropagateTagsPreview();
    updateResolveDisjointTargetPreview();
    renderResolveDisjointAssets();

    disjointTimeframeData = null;
    disjointTimeframeActiveDeviceKey = null;
    disjointTimeframeCheckedIds.clear();
    void fetchDisjointTimeframeDevices();
  } catch (err: any) {
    if (summaryEl) {
      summaryEl.innerHTML = `<span class="text-red">❌ Error loading disjoint details: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  }
}

type ResolveDisjointAction = 'merge_new' | 'merge_legacy' | 'skip_publishing' | 'ignore' | 'curate';
let pendingResolveConfirmAction: ResolveDisjointAction | null = null;

function addPreviewedCandidateToCombined(): boolean {
  if (!previewedCandidateMomentName) return false;
  const chosenIds = new Set(
    previewedCandidateSelectedIds.size > 0
      ? Array.from(previewedCandidateSelectedIds)
      : previewedCandidateAssets.map(a => a.asset_id)
  );
  const clonedTags = candidateTagState.tags.map(t => ({ ...t }));
  candidateTagsCache.set(previewedCandidateMomentName, {
    tags: clonedTags,
    lastSession: candidateTagState.lastSession
  });
  combinedExtraMoments.set(previewedCandidateMomentName, {
    momentName: previewedCandidateMomentName,
    assetIds: chosenIds,
    totalAssets: previewedCandidateAssets.length || chosenIds.size,
    tags: clonedTags,
    allAssets: previewedCandidateAssets.map(a => ({
      asset_id: a.asset_id,
      score_normalized: a.score_normalized,
      original_filename: a.original_filename,
      is_duplicate_copy: a.is_duplicate_copy
    }))
  });
  renderResolveDisjointCombineTray();
  renderCandidateMomentChips(displayedCandidateMomentsList);
  renderPropagateTagsPreview();
  updateSingleAssetWarningVisibility();
  updateResolveDisjointTargetPreview();
  return true;
}

function closeResolveActionConfirmDialog(): void {
  pendingResolveConfirmAction = null;
  document.getElementById('modal-resolve-action-confirm')?.classList.remove('open');
}

function openResolveActionConfirmDialog(action: ResolveDisjointAction, skipAutoInclude = false): void {
  if (!resolveDisjointMomentName || isSubmittingResolveDisjoint) return;

  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const parentSel = document.getElementById('resolve-disjoint-parent-select') as HTMLSelectElement | null;
  const delSrcCb = document.getElementById('resolve-disjoint-delete-source') as HTMLInputElement | null;
  const savePerSource = (document.getElementById('resolve-disjoint-save-per-source-tags') as HTMLInputElement | null)?.checked ?? true;
  const shareDisjoint = (document.getElementById('resolve-disjoint-share-disjoint-tags') as HTMLInputElement | null)?.checked ?? false;
  const statusEl = document.getElementById('resolve-disjoint-status');

  const isMerge = action === 'merge_new' || action === 'merge_legacy';
  const isCurate = action === 'curate';
  const targetMoment = (targetInp?.value || '').trim();
  const resolvedParent = parentSel?.value || 'Moments';
  const assetIds = Array.from(resolveDisjointSelectedIds);
  const delSrc = Boolean(delSrcCb?.checked ?? true);

  let autoIncludedName = '';
  const previewPanelEl = document.getElementById('resolve-disjoint-candidate-preview-panel');
  if (
    !skipAutoInclude &&
    (isMerge || isCurate) &&
    previewPanelEl &&
    previewPanelEl.style.display !== 'none' &&
    previewedCandidateMomentName &&
    previewedCandidateMomentName.toLowerCase() !== resolveDisjointMomentName.toLowerCase() &&
    !combinedExtraMoments.has(previewedCandidateMomentName)
  ) {
    if (addPreviewedCandidateToCombined()) {
      autoIncludedName = previewedCandidateMomentName;
    }
  }

  if ((isMerge || isCurate) && !targetMoment) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Enter or compose a Target Moment Album Name first.</span>';
    }
    return;
  }
  if (isCurate && !assetIds.length) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Select at least 1 keeper asset to approve into Curated (or use Ignore / Skip Publishing).</span>';
    }
    return;
  }
  if ((action === 'skip_publishing' || action === 'ignore') && !assetIds.length) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Select at least 1 asset first.</span>';
    }
    return;
  }

  const modal = document.getElementById('modal-resolve-action-confirm');
  const titleEl = document.getElementById('resolve-confirm-title');
  const subEl = document.getElementById('resolve-confirm-subtitle');
  const stepsEl = document.getElementById('resolve-confirm-steps-list');
  const noteEl = document.getElementById('resolve-confirm-note');
  const proceedBtn = document.getElementById('btn-resolve-confirm-proceed') as HTMLButtonElement | null;
  if (!modal || !titleEl || !subEl || !stepsEl || !noteEl || !proceedBtn) {
    void submitResolveDisjoint(action);
    return;
  }

  const stepsHtml: string[] = [];
  if (isCurate) {
    const extraEntries = Array.from(combinedExtraMoments.values());
    const extraAssetCount = extraEntries.reduce((acc, e) => acc + e.assetIds.size, 0);
    const totalKeeperCount = assetIds.length + extraAssetCount;
    const hrConf = computeHighratedUnselectedPreview();
    const handleUnsel = (document.getElementById('curate-m200-handle-unselected') as HTMLInputElement | null)?.checked ?? true;
    const unselMode = (document.getElementById('curate-m200-unselected-action') as HTMLSelectElement | null)?.value || 'ignore';
    const delTbc = (document.getElementById('curate-m200-delete-tbc') as HTMLInputElement | null)?.checked ?? true;
    const exportLacie = (document.getElementById('curate-m200-export-lacie') as HTMLInputElement | null)?.checked ?? true;

    const poolTotalConf = getCombinedPoolTotalCount();
    const { expected: expCurConf, lnRaw: expLnConf } = computeExpectedCuratedStats(poolTotalConf);
    titleEl.textContent = '🎨 Confirm Manual Curation & Tagging Plan';
    subEl.innerHTML = `Curate <code>${escapeHtml(resolveDisjointMomentName)}</code> ➜ <code>Media Organizer.photoslibrary / Curated / ${escapeHtml(targetMoment)}</code> <span class="badge badge-xs badge-purple font-mono">Selected ${totalKeeperCount} · 🎯 Expected ${expCurConf} (ln ${poolTotalConf} = ${expLnConf.toFixed(2)})</span>`;

    const srcParts = [
      `<code>${escapeHtml(resolveDisjointMomentName)}</code> (${assetIds.length})`,
      ...extraEntries.map(e => `<code>${escapeHtml(e.momentName)}</code> (${e.assetIds.size})`)
    ];
    stepsHtml.push(
      `<strong>Import &amp; approve ${totalKeeperCount} keeper asset(s) into Curated (🎯 expected ln(${poolTotalConf}) = ${expCurConf}):</strong> Copy selected keepers from ${srcParts.join(' + ')} into <code>Media Organizer.photoslibrary / Curated / ${escapeHtml(
        targetMoment
      )}</code> (<code>All-Media</code> remains 100% read-only).`
    );
    if (hrConf.highratedAssets.length > 0) {
      stepsHtml.push(
        `<strong>Copy ${hrConf.highratedAssets.length} higher-scored unselected asset(s) to Highrated assets:</strong> Copy unselected event asset(s) scoring above highest curated keeper (<code>${hrConf.maxKeeperScore.toFixed(4)}</code>) into <code>Media Organizer.photoslibrary / Moments / Highrated assets</code>.`
      );
    }
    if (hrConf.otherUnselectedCount > 0 && handleUnsel) {
      stepsHtml.push(
        unselMode === 'skip_publishing'
          ? `<strong>Mark ${hrConf.otherUnselectedCount} remaining unselected asset(s) as SkipPublishing in DB:</strong> Record unselected items under <code>Moments / SkipPublishing</code> (excluded from queues) without modifying <code>All-Media</code>.`
          : `<strong>Mark ${hrConf.otherUnselectedCount} remaining unselected asset(s) as Ignore in DB:</strong> Exclude unselected items from future queues without modifying <code>All-Media</code>.`
      );
    }
    if (delTbc) {
      stepsHtml.push(
        `<strong>Clean up superseded staging album (if any):</strong> Remove any prior <code>Moments / ToBeCurated</code> album inside <code>Media Organizer.photoslibrary</code>.`
      );
    }
    if (sourceTagState.tags.length > 0 || extraEntries.some(e => e.tags.length > 0)) {
      stepsHtml.push(
        `<strong>Persist DB tags:</strong> Save Moment and asset tags onto <code>${escapeHtml(targetMoment)}</code> and its curated keepers.`
      );
    }
    if (exportLacie) {
      stepsHtml.push(
        `<strong>Export to LaCie &amp; Unlock Publishing (Step 2B):</strong> Export curated originals into <code>/Volumes/LaCie/Media Organizer/Curated/${escapeHtml(
          targetMoment
        )}</code>, sync <code>Publishing Recommendation</code>, and promote stage to <code>M400</code> so <strong>🚀 Publish</strong> unlocks immediately.`
      );
    }
    noteEl.innerHTML = '✅ Once curated, this Moment immediately surfaces the 🚀 Publish workflow (matching Step 2B Curated Moments Pending Publishing).';
    proceedBtn.className = 'btn btn-purple';
    proceedBtn.textContent = exportLacie ? '🎨 Confirm Curate & Unlock Publishing' : '🎨 Confirm Approve into Curated';
  } else if (isMerge) {
    const existingInfo = getExistingTargetAlbumInfo(resolvedParent, targetMoment);
    const fullTargetPath = `Media Organizer.photoslibrary / ${resolvedParent} / ${targetMoment}`;
    const extraEntries = Array.from(combinedExtraMoments.values());
    const totalAssetSel = assetIds.length + extraEntries.reduce((acc, e) => acc + e.assetIds.size, 0);

    titleEl.textContent = existingInfo.exists
      ? '➕ Confirm Add Missing Assets & Merge Plan'
      : '✨ Confirm New Moment Merge Plan';
    subEl.innerHTML = `Target: <code>${escapeHtml(fullTargetPath)}</code>`;

    stepsHtml.push(
      existingInfo.exists
        ? `<strong>Destination folder (already exists):</strong> Open existing album <code>${escapeHtml(fullTargetPath)}</code> (${existingInfo.assetCount} asset(s) currently tracked).`
        : `<strong>Destination folder (create new):</strong> Create new Apple Photos album <code>${escapeHtml(fullTargetPath)}</code>.`
    );

    const sourceListParts = [
      `<code>${escapeHtml(resolveDisjointMomentName)}</code> (${assetIds.length} asset(s))`,
      ...extraEntries.map(e => `<code>${escapeHtml(e.momentName)}</code> (${e.assetIds.size} asset(s))`)
    ];
    const skippedDups: string[] = [];
    resolveDisjointAssets.forEach(a => {
      if (!resolveDisjointSelectedIds.has(a.asset_id) && a.is_duplicate_copy) {
        skippedDups.push(a.original_filename || a.asset_id);
      }
    });
    if (previewedCandidateMomentName && extraEntries.some(e => e.momentName === previewedCandidateMomentName)) {
      previewedCandidateAssets.forEach(a => {
        if (!previewedCandidateSelectedIds.has(a.asset_id) && a.is_duplicate_copy) {
          skippedDups.push(a.original_filename || a.asset_id);
        }
      });
    }
    const skipNote = skippedDups.length
      ? ` <span style="color: #fde68a;">(Skipping ${skippedDups.length} duplicate copy/copies: ${skippedDups.map(fn => `<code>${escapeHtml(fn)}</code>`).join(', ')})</span>`
      : '';
    stepsHtml.push(
      `<strong>Copy only missing non-duplicate assets (${totalAssetSel} selected):</strong> Inspect items from ${sourceListParts.join(' + ')} and add only unique assets not already in destination.${skipNote}`
    );

    const realExtraMoments = extraEntries.filter(e => !e.isTimeframeDeviceSelection);
    const allSourceNamesLc = new Set(
      [
        ...(resolveDisjointIsUnassignedCluster ? [] : [resolveDisjointMomentName]),
        ...realExtraMoments.map(e => e.momentName)
      ].map(s => s.trim().toLowerCase())
    );
    const priorAlbumsToRemove = existingAlbumsList.filter(al => {
      const nmLc = (al.album_name || '').trim().toLowerCase();
      const parLc = (al.parent_folder_name || 'Moments').trim().toLowerCase();
      if (!allSourceNamesLc.has(nmLc)) return false;
      return !(nmLc === targetMoment.toLowerCase() && parLc === resolvedParent.toLowerCase());
    });
    const deletableSources = [
      ...(resolveDisjointIsUnassignedCluster ? [] : [resolveDisjointMomentName]),
      ...realExtraMoments.map(e => e.momentName)
    ].filter(s => s.toLowerCase() !== targetMoment.toLowerCase());

    const organizerSourcesToClean = deletableSources.filter(s =>
      Boolean(allGroupingsData?.groupings.find(g => g.name.toLowerCase() === s.toLowerCase())?.in_organizer_library)
    );

    if (delSrc && organizerSourcesToClean.length) {
      stepsHtml.push(
        `<strong>Clean up superseded Media Organizer album(s):</strong> Remove obsolete <code>Media Organizer.photoslibrary</code> album(s) ${organizerSourcesToClean.map(s => `<code>${escapeHtml(s)}</code>`).join(', ')} after copying keeper assets (<code>All-Media</code> remains 100% read-only).`
      );
    } else if (resolveDisjointIsUnassignedCluster) {
      stepsHtml.push(
        `<strong>Omit migrated Unassigned Cluster:</strong> Selected assets will be imported into <code>Media Organizer.photoslibrary / ${escapeHtml(resolvedParent)} / ${escapeHtml(targetMoment)}</code> and omitted from unassigned staging.`
      );
    } else {
      stepsHtml.push(
        `<strong>Preserve All-Media read-only &amp; omit migrated source item:</strong> <code>All-Media.photoslibrary</code> is never modified or deleted from UI. Once migrated into <code>Media Organizer.photoslibrary</code>, source items are automatically omitted as separate line items (and optionally linked to <code>All-Media</code> if you ever wish to delete them manually in Photos).`
      );
    }

    const parentLcForStage = resolvedParent.trim().toLowerCase();
    const newFolderResetStage =
      parentLcForStage === 'tobecurated'
        ? 'M200'
        : parentLcForStage === 'curated'
          ? 'M300'
          : 'M100';
    if (!existingInfo.exists) {
      stepsHtml.push(
        `<strong>Reset Moment Status (treat as new folder):</strong> Initialize/reset <code>${escapeHtml(targetMoment)}</code> stage in <code>curated_moments</code> to <code>${newFolderResetStage}</code> so it runs through Mode [M] as a new folder and assets moved from any <code>Deleted</code> folder can be re-published.`
      );
    }

    if (action === 'merge_new' && (savePerSource || shareDisjoint)) {
      const tagSummary = formatUnifiedMetadataSummary(sourceTagState.tags);
      stepsHtml.push(
        `<strong>Update DB &amp; active JSON tag metadata (assets):</strong> Reassign kept assets' <code>MomentsAlbumName</code> to <code>${escapeHtml(targetMoment)}</code>, sync <code>media_organizer_album_assets</code>, and record active tags/flags ${shareDisjoint ? '(copied across combined assets)' : '(saved per source Moment)'} <code>${escapeHtml(tagSummary)}</code>.`
      );
    } else {
      stepsHtml.push(
        `<strong>Update local DB:</strong> Reassign kept assets' <code>MomentsAlbumName</code> to <code>${escapeHtml(targetMoment)}</code> and sync <code>media_organizer_album_assets</code>.`
      );
    }

    const unionMap = new Map<string, MomentTagItem>();
    const pushUnion = (list: MomentTagItem[]) => {
      list.forEach(t => {
        const k = t.tag_value.trim().toLowerCase();
        if (k && !unionMap.has(k)) unionMap.set(k, t);
      });
    };
    if (action === 'merge_new' && (savePerSource || shareDisjoint)) {
      pushUnion(sourceTagState.tags);
      if (savePerSource) {
        extraEntries.forEach(e => pushUnion(e.tags));
      }
    } else {
      pushUnion(
        sourceTagState.tags.filter(
          t => (t.tagged_asset_count ?? 0) > 0 || Boolean(sourceTagState.tagDbCounts[t.tag_value.toLowerCase()]?.assets)
        )
      );
      extraEntries.forEach(e =>
        pushUnion(
          e.tags.filter(
            t => (t.tagged_asset_count ?? 0) > 0 || Boolean(sourceTagState.tagDbCounts[t.tag_value.toLowerCase()]?.assets)
          )
        )
      );
    }
    const unionTags = Array.from(unionMap.values());
    const unionSummary = unionTags.length ? formatUnifiedMetadataSummary(unionTags) : '';
    stepsHtml.push(
      unionTags.length
        ? `<strong>Tag Moment folder itself (New Tagging Paradigm):</strong> Save union of all asset tags onto <code>${escapeHtml(fullTargetPath)}</code> in <code>moments</code> &amp; <code>media_organizer_albums</code> (<code>tagging_paradigm = new_paradigm_v1</code>) as secondary confirmation: <code>${escapeHtml(unionSummary)}</code>.`
        : `<strong>Tag Moment folder itself (New Tagging Paradigm):</strong> Aggregate any DB asset tags onto <code>${escapeHtml(fullTargetPath)}</code> in <code>moments</code> &amp; <code>media_organizer_albums</code> once tags are present.`
    );

    if (autoIncludedName) {
      const incCnt = combinedExtraMoments.get(autoIncludedName)?.assetIds.size ?? 0;
      noteEl.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; flex-wrap: wrap; width: 100%;">
          <span>✅ Auto-included previewed Moment <code>${escapeHtml(autoIncludedName)}</code> (${incCnt} non-duplicate asset(s)) into this merge.</span>
          <button type="button" class="btn btn-xs btn-outline" id="btn-confirm-exclude-previewed">✕ Exclude "${escapeHtml(autoIncludedName)}"</button>
        </div>
      `;
    } else {
      noteEl.innerHTML = '✅ Already-present assets in destination and skipped duplicate copies will not be re-added.';
    }
    proceedBtn.className = 'btn btn-purple';
    proceedBtn.textContent = existingInfo.exists ? '➕ Confirm & Add Missing Assets' : '✨ Confirm & Merge Moment';
  } else if (action === 'skip_publishing') {
    titleEl.textContent = '⏭️ Confirm SkipPublishing Action';
    subEl.innerHTML = `Source Moment: <code>${escapeHtml(resolveDisjointMomentName)}</code>`;
    stepsHtml.push(
      `<strong>Mark SkipPublishing in DB:</strong> Record ${assetIds.length} selected asset(s) under <code>Moments / SkipPublishing</code> in <code>media_organizer.db</code> without modifying <code>All-Media.photoslibrary</code>.`
    );
    stepsHtml.push('<strong>Sync DB &amp; folders:</strong> Exclude these assets from Publishing Recommendations and remove any local recommendation export folder if present.');
    noteEl.innerHTML = 'ℹ️ All-Media.photoslibrary remains untouched (read-only); assets are excluded from Publishing Recommendations.';
    proceedBtn.className = 'btn btn-purple';
    proceedBtn.textContent = '⏭️ Confirm SkipPublishing';
  } else {
    titleEl.textContent = '🗑️ Confirm Ignore Selected Action';
    subEl.innerHTML = `Source Moment: <code>${escapeHtml(resolveDisjointMomentName)}</code>`;
    stepsHtml.push(
      `<strong>Ignore assets in DB:</strong> Mark ${assetIds.length} selected asset(s) as <code>Ignore</code> in <code>media_organizer.db</code> (<code>All-Media.photoslibrary</code> remains 100% read-only).`
    );
    noteEl.innerHTML = '⚠️ Selected assets will be marked ignored and omitted from the Media Organizer queue (All-Media is never modified).';
    proceedBtn.className = 'btn btn-purple';
    proceedBtn.textContent = '🗑️ Confirm Ignore Selected';
  }

  stepsEl.innerHTML = stepsHtml.map(s => `<li>${s}</li>`).join('');
  document.getElementById('btn-confirm-exclude-previewed')?.addEventListener('click', () => {
    if (autoIncludedName) {
      combinedExtraMoments.delete(autoIncludedName);
      renderResolveDisjointCombineTray();
      renderCandidateMomentChips(displayedCandidateMomentsList);
      renderPropagateTagsPreview();
      updateSingleAssetWarningVisibility();
      updateResolveDisjointTargetPreview();
      openResolveActionConfirmDialog(action, true);
    }
  });
  pendingResolveConfirmAction = action;
  modal.classList.add('open');
}

async function submitResolveDisjoint(action: ResolveDisjointAction): Promise<void> {
  if (!resolveDisjointMomentName || isSubmittingResolveDisjoint) return;

  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const parentSel = document.getElementById('resolve-disjoint-parent-select') as HTMLSelectElement | null;
  const delSrcCb = document.getElementById('resolve-disjoint-delete-source') as HTMLInputElement | null;
  const savePerSource = (document.getElementById('resolve-disjoint-save-per-source-tags') as HTMLInputElement | null)?.checked ?? true;
  const shareDisjoint = (document.getElementById('resolve-disjoint-share-disjoint-tags') as HTMLInputElement | null)?.checked ?? false;
  const statusEl = document.getElementById('resolve-disjoint-status');
  const btnSubmit = document.getElementById('btn-submit-resolve-disjoint') as HTMLButtonElement | null;
  const btnLegacy = document.getElementById('btn-resolve-disjoint-legacy-merge') as HTMLButtonElement | null;
  const btnSkip = document.getElementById('btn-resolve-disjoint-skip') as HTMLButtonElement | null;
  const btnIgnore = document.getElementById('btn-resolve-disjoint-ignore') as HTMLButtonElement | null;

  const isMerge = action === 'merge_new' || action === 'merge_legacy';
  const isCurate = action === 'curate';
  const targetMoment = (targetInp?.value || '').trim();
  if ((isMerge || isCurate) && !targetMoment) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Enter or compose a Target Moment Album Name first.</span>';
    }
    return;
  }

  const resolvedParent = parentSel?.value || 'Moments';
  const assetIds = resolveDisjointAssets
    .filter(a => resolveDisjointSelectedIds.has(a.asset_id))
    .map(a => a.asset_id);
  const hrSubmitPreview = computeHighratedUnselectedPreview();
  const unselectedIds = hrSubmitPreview.allUnselectedIds;
  if ((action === 'skip_publishing' || action === 'ignore' || isCurate) && !assetIds.length) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Select at least 1 asset first.</span>';
    }
    return;
  }

  const additionalMoments =
    isMerge || isCurate
      ? Array.from(combinedExtraMoments.entries())
          .filter(([, entry]) => !entry.isTimeframeDeviceSelection)
          .map(([k]) => k)
      : [];
  const additionalAssetIds: string[] = [];
  if (isMerge || isCurate) {
    combinedExtraMoments.forEach(entry => {
      entry.assetIds.forEach(aid => additionalAssetIds.push(aid));
    });
  }

  const toCleanTags = (tags: MomentTagItem[]) =>
    tags.map(t => ({ category: t.category, tag_value: t.tag_value, include_in_name: t.include_in_name }));

  const momentTagGroups: Array<{ moment_name: string; asset_ids: string[]; tags: Array<{ category: string; tag_value: string; include_in_name: boolean }> }> = [];
  if ((action === 'merge_new' || isCurate) && savePerSource) {
    if (sourceTagState.tags.length && assetIds.length) {
      momentTagGroups.push({
        moment_name: resolveDisjointMomentName,
        asset_ids: assetIds,
        tags: toCleanTags(sourceTagState.tags)
      });
    }
    combinedExtraMoments.forEach(entry => {
      if (entry.tags.length && entry.assetIds.size > 0) {
        momentTagGroups.push({
          moment_name: entry.momentName,
          asset_ids: Array.from(entry.assetIds),
          tags: toCleanTags(entry.tags)
        });
      }
    });
  }

  const applyTags =
    (action === 'merge_new' || isCurate) && (shareDisjoint || isCurate) ? toCleanTags(sourceTagState.tags) : [];

  isSubmittingResolveDisjoint = true;
  if (btnSubmit) btnSubmit.disabled = true;
  if (btnLegacy) btnLegacy.disabled = true;
  if (btnSkip) btnSkip.disabled = true;
  if (btnIgnore) btnIgnore.disabled = true;

  const actionLabel = isCurate
    ? `Curating "${resolveDisjointMomentName}" -> Curated/${targetMoment}...`
    : action === 'merge_new'
      ? `Consolidating ${1 + additionalMoments.length} Moment(s) & tagging into "${resolvedParent}/${targetMoment}"...`
      : action === 'merge_legacy'
        ? `Merging into existing target "${resolvedParent}/${targetMoment}" via AppleScript...`
        : action === 'skip_publishing'
          ? 'Moving selected asset(s) to Moments/SkipPublishing...'
          : 'Excluding selected asset(s) via ignore pipeline...';

  beginApplePhotosSyncLock(`🍎 Updating Apple Photos (${resolveDisjointMomentName}) — UI paused until sync…`);
  if (statusEl) {
    statusEl.style.display = 'flex';
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>${escapeHtml(actionLabel)}</span>`;
  }

  let succeeded = false;
  try {
    let res: Response;
    const handleUnsel = (document.getElementById('curate-m200-handle-unselected') as HTMLInputElement | null)?.checked ?? true;
    const unselAction = handleUnsel
      ? ((document.getElementById('curate-m200-unselected-action') as HTMLSelectElement | null)?.value || 'ignore')
      : 'none';
    if (isCurate) {
      const delTbc = (document.getElementById('curate-m200-delete-tbc') as HTMLInputElement | null)?.checked ?? true;
      const exportLacie = (document.getElementById('curate-m200-export-lacie') as HTMLInputElement | null)?.checked ?? true;
      res = await fetch('/api/media/memories/curate-moment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_moment: resolveDisjointMomentName,
          target_moment: targetMoment,
          selected_asset_ids: assetIds,
          additional_moments: additionalMoments,
          additional_asset_ids: additionalAssetIds,
          unselected_asset_ids: unselectedIds,
          unselected_action: unselAction,
          delete_tbc_album: delTbc,
          export_to_lacie: exportLacie,
          is_unassigned_cluster: resolveDisjointIsUnassignedCluster,
          event_total_assets: getCombinedPoolTotalCount(),
          apply_tags: applyTags,
          moment_tag_groups: momentTagGroups
        })
      });
    } else {
      res = await fetch('/api/media/memories/resolve-disjoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_moment: resolveDisjointMomentName,
          action: isMerge ? 'merge' : action,
          target_moment: isMerge ? targetMoment : null,
          target_parent_folder: resolvedParent,
          asset_ids: assetIds,
          additional_moments: additionalMoments,
          additional_asset_ids: additionalAssetIds,
          unselected_asset_ids: isMerge && (resolveDisjointIsCurateM200 || resolvedParent.toLowerCase() === 'curated') ? unselectedIds : [],
          unselected_action: isMerge && resolveDisjointIsCurateM200 ? unselAction : 'none',
          apply_tags: applyTags,
          moment_tag_groups: momentTagGroups,
          delete_source_albums: Boolean(delSrcCb?.checked ?? true),
          is_unassigned_cluster: resolveDisjointIsUnassignedCluster
        })
      });
    }
    const rawText = await res.text();
    let data: ResolveDisjointResponse;
    try {
      data = rawText ? JSON.parse(rawText) : { ok: false };
    } catch {
      cancelApplePhotosSyncLock();
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ Server returned HTTP ${res.status}: ${escapeHtml(rawText.slice(0, 180) || 'Invalid JSON response')}</span>`;
      }
      return;
    }
    if (!res.ok || !data.ok) {
      cancelApplePhotosSyncLock();
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    if (
      (isCurate || (isMerge && (resolveDisjointIsCurateM200 || resolvedParent.toLowerCase() === 'curated'))) &&
      ((data as any).export_error || (data as any).unselected_error || (data as any).highrated_error)
    ) {
      const warnParts: string[] = [];
      if ((data as any).highrated_error) warnParts.push(`Moments/Highrated assets step: ${(data as any).highrated_error}`);
      if ((data as any).unselected_error) warnParts.push(`Unselected step: ${(data as any).unselected_error}`);
      if ((data as any).export_error) warnParts.push(`LaCie export step: ${(data as any).export_error}`);
      alert(`Apple Photos action saved, with warning:\n${warnParts.join('\n')}`);
    }

    if (resolveDisjointIsUnassignedCluster) {
      applyOptimisticClusterRemoval(new Set([...assetIds, ...additionalAssetIds]));
      clusterAssetSelection.delete(resolveDisjointMomentName);
    }
    unifiedGroupingAssetsCache.clear();
    allGroupingsLoaded = false;
    await Promise.all([
      fetchPlannerOverview(true, 'm'),
      fetchMemoriesFolders(),
      ...(activePlannerModeView === 'g' ? [fetchAllUnifiedGroupings(true)] : [])
    ]);
    if (plannerRefreshMediaMetricsCb) plannerRefreshMediaMetricsCb();

    closeResolveDisjointModal();
    if ((data as any).library_target === 'organizer') {
      cancelApplePhotosSyncLock();
    } else {
      finishApplePhotosActionSyncLock(
        `⏳ Apple Photos updated (${isMerge ? targetMoment : resolveDisjointMomentName}) — awaiting Background DB Copy & Sync Service refresh to re-enable UI & reload browser…`
      );
    }
    succeeded = true;
  } catch (err: any) {
    cancelApplePhotosSyncLock();
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isSubmittingResolveDisjoint = false;
    setResolveDisjointCompletedState(succeeded);
  }
}

// ==========================================================================
// Mode [G]: Unified All Groupings Explorer (Moments + Unassigned Clusters)
// ==========================================================================

let showAllMediaSourceLinks = localStorage.getItem('agy_show_all_media_source_links') !== '0';

function setupAllGroupingsListeners(): void {
  const showAmChk = document.getElementById('chk-show-all-media-links') as HTMLInputElement | null;
  if (showAmChk) {
    showAmChk.checked = showAllMediaSourceLinks;
    showAmChk.addEventListener('change', () => {
      showAllMediaSourceLinks = showAmChk.checked;
      try {
        localStorage.setItem('agy_show_all_media_source_links', showAllMediaSourceLinks ? '1' : '0');
      } catch {
        // ignore storage quota errors
      }
      renderAllUnifiedGroupings();
    });
  }

  document.getElementById('btn-refresh-all-groupings')?.addEventListener('click', () => {
    unifiedGroupingAssetsCache.clear();
    void fetchAllUnifiedGroupings(true);
  });

  document.getElementById('btn-collapse-all-groupings')?.addEventListener('click', () => {
    expandedUnifiedGroupingIds.clear();
    renderAllUnifiedGroupings();
  });

  document.querySelectorAll<HTMLElement>('.all-groupings-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.all-groupings-sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.grpSort;
      if (mode === 'qual_avg' || mode === 'count' || mode === 'rank_score' || mode === 'date') {
        allGroupingsSortMode = mode;
      } else {
        allGroupingsSortMode = 'avg_score';
      }
      renderAllUnifiedGroupings();
    });
  });

  const batchSel = document.getElementById('all-groupings-batch-filter') as HTMLSelectElement | null;
  batchSel?.addEventListener('change', () => {
    const v = batchSel.value;
    allGroupingsBatchFilter = v === '600_plus' || v === 'under_600' ? v : 'all';
    renderAllUnifiedGroupings();
  });

  const libSel = document.getElementById('all-groupings-library-filter') as HTMLSelectElement | null;
  libSel?.addEventListener('change', () => {
    const v = libSel.value;
    allGroupingsLibraryFilter = v === 'organizer' || v === 'source_only' ? v : 'all';
    renderAllUnifiedGroupings();
  });

  document.getElementById('btn-activate-organizer-library')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-activate-organizer-library') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Connecting Photos.app...';
    }
    try {
      const res = await fetch('/api/media/photos-libraries/activate-organizer', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(`Could not activate Media Organizer library:\n${data.error || `HTTP ${res.status}`}`);
      } else if (data.mode === 'chooser_launched') {
        alert(data.message);
      }
      await fetchAllUnifiedGroupings(true);
    } catch (err: any) {
      alert(`Network error: ${err?.message || 'Unknown error'}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  const searchInp = document.getElementById('all-groupings-search') as HTMLInputElement | null;
  searchInp?.addEventListener('input', () => {
    allGroupingsSearchQuery = (searchInp.value || '').trim().toLowerCase();
    renderAllUnifiedGroupings();
  });
}

function batchStatusBadgeClass(code: string): string {
  const num = parseInt(code, 10);
  if (Number.isNaN(num)) return 'badge-outline';
  if (num >= 600) return 'badge-green';
  if (num >= 400) return 'badge-amber';
  return 'badge-purple';
}

function groupingMomentStatusBadgeClass(status: string): string {
  switch (status) {
    case 'M500':
      return 'badge-green';
    case 'M450':
    case 'M400':
      return 'badge-blue';
    case 'M300':
      return 'badge-purple';
    case 'M200':
      return 'badge-amber';
    case 'Unassigned':
      return 'badge-purple';
    default:
      return 'badge-outline';
  }
}

function registerUnifiedAssetsForPreview(assets: UnifiedGroupingAssetItem[], groupName: string, histMin: number): void {
  assets.forEach(a => {
    const bytes = a.file_size_bytes || 0;
    candidateAssetMeta.set(a.asset_id, {
      asset_id: a.asset_id,
      filename: a.original_filename,
      original_filename: a.original_filename,
      camera_model: a.camera_model || 'Library',
      primary_owner: a.primary_owner || '',
      month: a.month || (a.date_created_utc || '').slice(0, 7),
      date_created_utc: a.date_created_utc || '',
      capture_timestamp: a.date_created_utc || '',
      file_size_bytes: bytes,
      bytes,
      file_size_mb: bytes / (1024 * 1024),
      score_normalized: a.score_normalized,
      score_quartile: a.qualified ? `Qualified (>${histMin.toFixed(4)})` : 'Below Threshold',
      assigned_moment: groupName,
      asset_tags: a.asset_tags,
      media_type: a.media_type,
      duration_sec: a.duration || 0,
      width: a.width || 0,
      height: a.height || 0,
      fps: 0,
      is_duplicate_copy: Boolean(a.is_duplicate_copy)
    });
  });
}

async function fetchAllUnifiedGroupings(force = false): Promise<void> {
  if (isFetchingAllGroupings) return;
  if (allGroupingsLoaded && !force && allGroupingsData) {
    renderAllUnifiedGroupings();
    return;
  }

  const listEl = document.getElementById('all-groupings-list');
  const totalBadge = document.getElementById('all-groupings-badge-total');
  isFetchingAllGroupings = true;
  if (totalBadge) totalBadge.textContent = 'Loading...';
  if (listEl && !allGroupingsData) {
    listEl.innerHTML =
      '<div class="text-center text-muted font-mono" style="padding: 1.5rem; font-size: 0.78rem;"><div class="spinner-sm" style="display: inline-block; margin-right: 0.45rem;"></div>Loading unified groupings across all Moment &amp; Batch statuses...</div>';
  }

  try {
    const res = await fetch('/api/media/planner/all-groupings');
    const data: AllGroupingsResponse = await res.json();
    if (!res.ok || !data.ok) {
      if (listEl) {
        listEl.innerHTML = `<div class="text-red font-mono" style="padding: 1rem;">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</div>`;
      }
      return;
    }
    allGroupingsData = data;
    allGroupingsLoaded = true;
    const histMin = data.historical_min || 0.5315;
    (data.groupings || []).forEach(g => {
      if (g.inline_assets?.length) {
        unifiedGroupingAssetsCache.set(g.grouping_id, g.inline_assets);
        registerUnifiedAssetsForPreview(g.inline_assets, g.name, histMin);
      } else if (g.preview_assets?.length) {
        g.preview_assets.forEach(pa => {
          if (!candidateAssetMeta.has(pa.asset_id)) {
            candidateAssetMeta.set(pa.asset_id, {
              asset_id: pa.asset_id,
              filename: pa.filename,
              original_filename: pa.filename,
              camera_model: 'Library',
              primary_owner: '',
              month: '',
              date_created_utc: '',
              capture_timestamp: '',
              file_size_bytes: 0,
              bytes: 0,
              file_size_mb: 0,
              score_normalized: pa.score,
              score_quartile: pa.score > histMin ? `Qualified (>${histMin.toFixed(4)})` : 'Below Threshold',
              assigned_moment: g.name,
              media_type: pa.media_type,
              duration_sec: 0,
              width: 0,
              height: 0,
              fps: 0
            });
          }
        });
      }
    });
    renderAllUnifiedGroupings();
  } catch (err: any) {
    if (listEl) {
      listEl.innerHTML = `<div class="text-red font-mono" style="padding: 1rem;">❌ Network error loading groupings: ${escapeHtml(err?.message || 'Unknown error')}</div>`;
    }
  } finally {
    isFetchingAllGroupings = false;
  }
}

async function ensureGroupingAssetsLoaded(g: UnifiedGroupingItem): Promise<UnifiedGroupingAssetItem[]> {
  if (unifiedGroupingAssetsCache.has(g.grouping_id)) {
    return unifiedGroupingAssetsCache.get(g.grouping_id) || [];
  }
  if (g.inline_assets) {
    unifiedGroupingAssetsCache.set(g.grouping_id, g.inline_assets);
    return g.inline_assets;
  }
  const qs = new URLSearchParams({ moment_name: g.name });
  const res = await fetch(`/api/media/planner/grouping-assets?${qs.toString()}`);
  const data: GroupingAssetsResponse = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const assets = data.assets || [];
  unifiedGroupingAssetsCache.set(g.grouping_id, assets);
  registerUnifiedAssetsForPreview(assets, g.name, data.historical_min || allGroupingsData?.historical_min || 0.5315);
  return assets;
}

function getOrInitGroupingSelectedSet(gid: string, assets: UnifiedGroupingAssetItem[]): Set<string> {
  if (!unifiedGroupingSelectedIds.has(gid)) {
    const sel = new Set<string>();
    assets.forEach(a => {
      if (!a.is_duplicate_copy && (a.qualified || assets.every(x => !x.qualified))) {
        sel.add(a.asset_id);
      }
    });
    if (sel.size === 0) {
      assets.filter(a => !a.is_duplicate_copy).forEach(a => sel.add(a.asset_id));
    }
    unifiedGroupingSelectedIds.set(gid, sel);
  }
  return unifiedGroupingSelectedIds.get(gid)!;
}

function renderExpandedGroupingBodyHtml(g: UnifiedGroupingItem, assets: UnifiedGroupingAssetItem[]): string {
  if (!assets.length) {
    return '<div class="text-muted font-mono" style="padding: 0.6rem;">No active assets found in this grouping.</div>';
  }
  const selSet = getOrInitGroupingSelectedSet(g.grouping_id, assets);
  const curatedOnly = unifiedGroupingCuratedOnly.has(g.grouping_id);
  const keeperRankMap = new Map<string, number>();
  let kCounter = 0;
  assets.forEach(a => {
    if (selSet.has(a.asset_id)) {
      kCounter += 1;
      keeperRankMap.set(a.asset_id, kCounter);
    }
  });
  const selCount = keeperRankMap.size;
  const allChecked = assets.length > 0 && assets.every(a => selSet.has(a.asset_id));

  const evTotExp = g.event_total_assets || g.total_assets;
  const { expected: expCurExp, lnRaw: expLnExp } = computeExpectedCuratedStats(evTotExp);
  const effectiveExpExp = g.expected_curated_count ?? expCurExp;
  const effectiveLnExp = g.expected_curated_ln ?? expLnExp;
  const isCuratedExp =
    Boolean(g.curation_matches_log) &&
    (g.moment_status === 'M300' ||
      g.moment_status === 'M400' ||
      g.moment_status === 'M450' ||
      g.moment_status === 'M500' ||
      g.curated_count > 0);
  const isCompletedM500Exp = g.moment_status === 'M500' && g.published_count > 0;
  const pendingPubExp = isCuratedExp ? (g.pending_publish_count ?? Math.max(0, g.curated_count - g.published_count)) : 0;

  const expAllMediaFolder =
    (g.photos_folders || []).find(pf => pf.library_scope !== 'organizer') || (g.source_all_media_folders || [])[0];
  const expRemoveAlbum = expAllMediaFolder?.album_name || g.name;
  const expRemovePath = expAllMediaFolder?.full_path || '';
  const expSampleAid = assets[0]?.asset_id || g.preview_assets?.[0]?.asset_id || '';
  const expDedupBtn =
    g.is_duplicate_group && !g.is_deduped_group && g.duplicate_of_moment
      ? `<button type="button" class="btn btn-xs btn-amber btn-ugrp-exp-dedup" data-grouping-id="${escapeHtml(g.grouping_id)}" title="${escapeHtml(`Deduplicate against '${g.duplicate_of_moment}' — merges DB tags & switches button to Remove (All-Media link)`)}">♻️ Dedup</button>`
      : '';

  const primaryActionBtn = g.is_deduped_group
    ? `<button type="button" class="btn btn-xs btn-red btn-ugrp-exp-open-photos" data-is-remove-link="1" data-library-scope="all_media" data-album-name="${escapeHtml(expRemoveAlbum)}" data-full-path="${escapeHtml(expRemovePath)}" data-sample-aid="${escapeHtml(expSampleAid)}" title="${escapeHtml(`Deduped into '${g.duplicate_of_moment || ''}' — open '${expRemoveAlbum}' in All-Media.photoslibrary to manually delete this Moment in Photos`)}">🗑️ Remove in All-Media ↗</button>`
    : isCuratedExp && pendingPubExp > 0
      ? `<button type="button" class="btn btn-xs ${g.published_count > 0 ? 'btn-purple' : 'btn-green'} btn-ugrp-publish" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Review & publish curated batch (Step 2B)">🚀 Publish (${g.propose_next_str || pendingPubExp})</button>
         <button type="button" class="btn btn-xs btn-outline btn-ugrp-curate" data-grouping-id="${escapeHtml(g.grouping_id)}">🎨 Re-Curate / Tag</button>`
      : isCompletedM500Exp
        ? `<button type="button" class="btn btn-xs btn-outline btn-ugrp-publish" data-grouping-id="${escapeHtml(g.grouping_id)}">🔄 Republish</button>
           <button type="button" class="btn btn-xs btn-outline btn-ugrp-curate" data-grouping-id="${escapeHtml(g.grouping_id)}">🎨 Re-Curate / Tag</button>`
        : g.kind === 'unassigned'
          ? `${g.is_tagged ? '' : `<button type="button" class="btn btn-xs btn-cyan btn-ugrp-assign-selected" data-grouping-id="${escapeHtml(g.grouping_id)}">✨ Tag &amp; Assign (${selCount})</button>`}
             <button type="button" class="btn btn-xs btn-purple btn-ugrp-curate-selected" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Open Tagging Dialog with Manual Curation Step enabled (target ${effectiveExpExp} keepers)">🎨 Manual Curate (${effectiveExpExp})</button>`
          : `${expDedupBtn}
             ${g.is_tagged ? '' : `<button type="button" class="btn btn-xs btn-cyan btn-ugrp-tag-merge" data-grouping-id="${escapeHtml(g.grouping_id)}">🏷️ Tag / Consolidate</button>`}
             <button type="button" class="btn btn-xs btn-purple btn-ugrp-curate" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Open Tagging Dialog with Manual Curation Step enabled (target ${effectiveExpExp} keepers)">🎨 Manual Curate (${effectiveExpExp})</button>`;

  const rowsHtml = assets
    .map((a, idx) => {
      const checked = selSet.has(a.asset_id);
      if (curatedOnly && !checked) return '';
      const kRank = keeperRankMap.get(a.asset_id) || 0;
      const keeperBadge = checked
        ? `<span class="badge badge-xs badge-green font-mono" style="font-weight: 700;">★ Keeper ${kRank}/${selCount}</span>`
        : '<span class="badge badge-xs badge-amber font-mono">⏭️ Unselected</span>';
      const qualBadge = a.qualified
        ? '<span class="badge badge-xs badge-green font-mono">★ QUALIFIED</span>'
        : '<span class="badge badge-xs badge-outline font-mono">Below Thresh</span>';
      const typeBadge =
        a.media_type === 'video'
          ? `<span class="badge badge-xs badge-purple font-mono">VIDEO${a.duration ? ` ${formatDuration(a.duration)}` : ''}</span>`
          : '<span class="badge badge-xs badge-blue font-mono">PHOTO</span>';
      const batchBadge = a.month
        ? `<span class="badge badge-xs ${batchStatusBadgeClass(a.batch_status)} font-mono" title="Month batch ${escapeHtml(a.month)} · Status ${escapeHtml(a.batch_status)}">📅 ${escapeHtml(a.month)} [${escapeHtml(a.batch_status)}]</span>`
        : '';
      const folderChips: string[] = [];
      if (a.in_organizer_library || (a.organizer_folders && a.organizer_folders.length > 0)) {
        const orgPaths = a.organizer_folders && a.organizer_folders.length > 0 ? a.organizer_folders.join(' + ') : 'Media Organizer';
        folderChips.push(
          `<span class="badge badge-xs badge-green font-mono" title="Copied into Media Organizer.photoslibrary: ${escapeHtml(orgPaths)}">⚡ Media Organizer: ${escapeHtml(orgPaths)}</span>`
        );
      }
      if (a.is_published) folderChips.push('<span class="badge badge-xs badge-green font-mono">📢 Published</span>');
      if (a.in_curated) folderChips.push('<span class="badge badge-xs badge-blue font-mono">✅ Curated</span>');
      if (a.in_to_be_curated) folderChips.push('<span class="badge badge-xs badge-amber font-mono">🟡 TBC</span>');
      if (a.in_moments && !a.in_curated && !a.in_to_be_curated) {
        folderChips.push('<span class="badge badge-xs badge-outline font-mono">📁 Moments</span>');
      }
      const dupBadge = a.is_duplicate_copy
        ? `<span class="badge badge-xs badge-amber font-mono" title="Duplicate of ${escapeHtml(a.duplicate_keeper_filename || 'keeper')}">♻️ Dup</span>`
        : '';
      const sizeStr = a.file_size_bytes ? ` · ${formatBytes(a.file_size_bytes)}` : '';
      const dateStr = a.date_created_utc ? a.date_created_utc.slice(0, 10) : '';
      const tagsHtml =
        a.asset_tags && a.asset_tags.length > 0
          ? `<div style="display: flex; align-items: center; gap: 0.25rem; margin-top: 0.16rem; flex-wrap: wrap;">${a.asset_tags
              .map(t => `<span class="badge badge-xs badge-outline font-mono" style="font-size: 0.6rem;">🏷️ ${escapeHtml(t.tag_value)}</span>`)
              .join('')}</div>`
          : '';
      const rowStateCls = checked ? ' is-selected' : ' is-unselected-grey';
      return `
        <div class="publish-asset-row${rowStateCls}${a.is_duplicate_copy ? ' is-dup-copy' : ''}">
          <div class="publish-asset-left">
            <input type="checkbox" class="ugrp-asset-cb" data-grouping-id="${escapeHtml(g.grouping_id)}" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} style="cursor: pointer;" />
            <button type="button" class="disjoint-row-thumb-btn btn-ugrp-preview-asset" data-grouping-id="${escapeHtml(g.grouping_id)}" data-asset-id="${escapeHtml(a.asset_id)}" title="Open Curation Lightbox (Space toggles selection)" style="width: 40px; height: 40px;">
              <img src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.original_filename)}" loading="lazy" />
            </button>
            <div style="min-width: 0; flex: 1;">
              <div class="font-mono" style="font-size: 0.75rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                #${idx + 1} · ${escapeHtml(a.original_filename || a.asset_id)}
              </div>
              <div style="display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap;">
                ${keeperBadge}
                ${qualBadge}
                ${typeBadge}
                ${batchBadge}
                ${folderChips.join('')}
                ${dupBadge}
                <span class="font-mono text-amber" style="font-size: 0.69rem;">Score ${a.score_normalized.toFixed(4)}</span>
                <span class="font-mono text-muted" style="font-size: 0.68rem;">${escapeHtml(dateStr)}${escapeHtml(sizeStr)}</span>
              </div>
              ${tagsHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  const orgTargets = g.organizer_target_folders || [];
  const srcAllMedia = g.source_all_media_folders || [];
  const sampleAidExp = assets[0]?.asset_id || g.preview_assets?.[0]?.asset_id || '';
  const orgSummaryBannerHtml =
    orgTargets.length > 0 || srcAllMedia.length > 0
      ? `<div style="display: flex; flex-direction: column; gap: 0.35rem; padding: 0.45rem 0.65rem; margin-bottom: 0.45rem; border-radius: 6px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.32);">
          ${
            orgTargets.length > 0
              ? `<div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;">
                  <div class="font-mono" style="font-size: 0.72rem; color: #6ee7b7; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                    <strong>⚡ Media Organizer Library:</strong>
                    ${orgTargets
                      .map(
                        ot =>
                          `<button type="button" class="badge badge-xs badge-green font-mono pub-badge-link btn-ugrp-exp-open-photos" data-library-scope="organizer" data-album-name="${escapeHtml(ot.album_name)}" data-full-path="${escapeHtml(ot.full_path)}" data-sample-aid="${escapeHtml(sampleAidExp)}" title="Spotlight ${escapeHtml(ot.full_path)} in Media Organizer.photoslibrary">📁 ${escapeHtml(ot.full_path)} (${ot.matched_count}/${g.total_assets}) ↗</button>`
                      )
                      .join('')}
                  </div>
                  <span class="font-mono text-muted" style="font-size: 0.67rem;">~/Pictures/Media Organizer.photoslibrary</span>
                </div>`
              : ''
          }
          ${
            showAllMediaSourceLinks && srcAllMedia.length > 0
              ? `<div class="font-mono" style="font-size: 0.69rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.38rem; flex-wrap: wrap; padding-top: 0.2rem; border-top: 1px dashed rgba(148, 163, 184, 0.2);">
                  <span class="text-muted">📀 Legacy in All-Media (read-only — delete manually in Photos):</span>
                  ${srcAllMedia
                    .map(
                      am =>
                        `<button type="button" class="badge badge-xs badge-outline font-mono pub-badge-link btn-ugrp-exp-open-photos" data-library-scope="all_media" data-album-name="${escapeHtml(am.album_name)}" data-full-path="${escapeHtml(am.full_path)}" data-sample-aid="${escapeHtml(sampleAidExp)}" title="Read-only spotlight in All-Media.photoslibrary: ${escapeHtml(am.full_path)} (${am.all_migrated ? 'all active assets migrated — safe to delete manually in Photos' : `${am.matched_count}/${am.source_total_count} migrated`})">📀 ${escapeHtml(am.parent_folder)}/${escapeHtml(am.album_name)}${am.all_migrated ? ' ✓' : ` (${am.matched_count}/${am.source_total_count})`} ↗</button>`
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>`
      : '';

  return `
    ${orgSummaryBannerHtml}
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;">
      <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
        <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.74rem; cursor: pointer;" class="font-mono">
          <input type="checkbox" class="ugrp-select-all-cb" data-grouping-id="${escapeHtml(g.grouping_id)}" ${allChecked ? 'checked' : ''} />
          <span>Select All</span>
        </label>
        <span class="badge badge-xs badge-green font-mono">${selCount} / ${assets.length} selected</span>
        <span class="badge badge-xs badge-purple font-mono" title="Expected curated count = round(ln(${evTotExp})) = ${effectiveLnExp.toFixed(2)}">🎯 Expected Curated: ${effectiveExpExp} (ln ${evTotExp} = ${effectiveLnExp.toFixed(2)})</span>
        <button type="button" class="btn btn-xs ${curatedOnly ? 'btn-purple' : 'btn-outline'} btn-ugrp-curated-only" data-grouping-id="${escapeHtml(g.grouping_id)}">
          ${curatedOnly ? `★ Curated Only (${selCount})` : '👁️ Curated Only'}
        </button>
      </div>
      <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
        ${primaryActionBtn}
      </div>
    </div>
    <div class="publish-asset-list" style="max-height: 360px;">
      ${rowsHtml || '<div class="text-center text-muted font-mono" style="padding: 0.75rem;">No selected assets match filter.</div>'}
    </div>
  `;
}

function wireExpandedGroupingBodyEvents(bodyEl: HTMLElement, g: UnifiedGroupingItem): void {
  const assets = unifiedGroupingAssetsCache.get(g.grouping_id) || [];
  const selSet = getOrInitGroupingSelectedSet(g.grouping_id, assets);
  const rerenderBody = () => {
    bodyEl.innerHTML = renderExpandedGroupingBodyHtml(g, assets);
    wireExpandedGroupingBodyEvents(bodyEl, g);
  };

  bodyEl.querySelector<HTMLInputElement>('.ugrp-select-all-cb')?.addEventListener('change', e => {
    const checked = (e.target as HTMLInputElement).checked;
    selSet.clear();
    if (checked) assets.forEach(a => selSet.add(a.asset_id));
    rerenderBody();
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-curated-only')?.addEventListener('click', () => {
    if (unifiedGroupingCuratedOnly.has(g.grouping_id)) {
      unifiedGroupingCuratedOnly.delete(g.grouping_id);
    } else {
      unifiedGroupingCuratedOnly.add(g.grouping_id);
    }
    rerenderBody();
  });

  bodyEl.querySelectorAll<HTMLInputElement>('.ugrp-asset-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const aid = cb.dataset.assetId || '';
      if (!aid) return;
      if (cb.checked) selSet.add(aid);
      else selSet.delete(aid);
      rerenderBody();
    });
  });

  bodyEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-preview-asset').forEach(btn => {
    btn.addEventListener('click', () => {
      const aid = btn.dataset.assetId || '';
      if (!aid) return;
      openCleanupPreviewModal(aid, {
        assetIds: assets.map(a => a.asset_id),
        groupLabel: `${g.name} (${g.moment_status})`,
        hideMarkRemoved: true,
        selectedIds: selSet,
        defaultSort: 'score',
        onSelectionChange: () => rerenderBody()
      });
    });
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-assign-selected')?.addEventListener('click', () => {
    const ids = assets.filter(a => selSet.has(a.asset_id)).map(a => a.asset_id);
    if (!ids.length) return;
    const prefill = /uncategorized/i.test(g.name) ? '' : g.name;
    void openResolveDisjointModal(g.name, prefill, { assetIds: ids, isUnassignedCluster: true });
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-curate-selected')?.addEventListener('click', () => {
    const allIds = assets.map(a => a.asset_id);
    if (!allIds.length) return;
    const prefill = /uncategorized/i.test(g.name) ? '' : g.name;
    void openResolveDisjointModal(g.name, prefill, { assetIds: allIds, isUnassignedCluster: true, isCurateM200: true });
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-curate')?.addEventListener('click', () => {
    void openResolveDisjointModal(g.name, '', { isHistoricalMoment: true, isCurateM200: true });
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-publish')?.addEventListener('click', () => {
    void openPublishMomentModal(g.name);
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-exp-dedup')?.addEventListener('click', async e => {
    const btn = e.currentTarget as HTMLButtonElement;
    await triggerDedupMomentGrouping(g, btn);
  });

  bodyEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-exp-open-photos').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const albName = btn.dataset.albumName || g.name;
      const fullPath = btn.dataset.fullPath || '';
      const sampleAid = btn.dataset.sampleAid || '';
      const libScope = btn.dataset.libraryScope || 'organizer';
      const isRemoveLink = btn.dataset.isRemoveLink === '1';
      const confirmMsg = isRemoveLink
        ? `Open All-Media.photoslibrary (Read-Only) and spotlight "${albName}" so you can manually delete this duplicate Moment in Apple Photos?\n\n(Data Orchestrator never deletes from All-Media directly — once you delete the album in Photos, switch back to Media Organizer.)`
        : `Switch Apple Photos to All-Media.photoslibrary (Read-Only) and spotlight "${albName}"?\n\nData Orchestrator never modifies All-Media — you can inspect or manually delete the legacy album in Photos, then switch back to Media Organizer when ready.`;
      if (libScope === 'all_media' && !window.confirm(confirmMsg)) {
        return;
      }
      btn.disabled = true;
      try {
        await fetch('/api/media/memories/open-photos-album', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            album_name: albName,
            full_path: fullPath,
            sample_asset_id: sampleAid,
            library_scope: libScope
          })
        });
      } finally {
        btn.disabled = false;
      }
    });
  });

  bodyEl.querySelector<HTMLButtonElement>('.btn-ugrp-tag-merge')?.addEventListener('click', () => {
    const ids = assets.filter(a => selSet.has(a.asset_id)).map(a => a.asset_id);
    void openResolveDisjointModal(g.name, '', { assetIds: ids, isHistoricalMoment: true });
  });
}

async function triggerDedupMomentGrouping(g: UnifiedGroupingItem, btn?: HTMLButtonElement | null): Promise<void> {
  const canonical = (g.duplicate_of_moment || '').trim();
  if (!canonical) return;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/media/memories/dedup-grouping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duplicate_moment: g.name,
        canonical_moment: canonical
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      alert(`Failed deduplicating "${g.name}": ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    unifiedGroupingAssetsCache.clear();
    await fetchAllUnifiedGroupings(true);
  } catch (err: any) {
    alert(`Network error deduplicating "${g.name}": ${err?.message || 'Unknown error'}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderAllUnifiedGroupings(): void {
  const listEl = document.getElementById('all-groupings-list');
  const pillsEl = document.getElementById('all-groupings-status-pills');
  const totalBadge = document.getElementById('all-groupings-badge-total');
  const assetsBadge = document.getElementById('all-groupings-badge-assets');
  const avgBadge = document.getElementById('all-groupings-badge-avg');
  const visiblePill = document.getElementById('all-groupings-visible-pill');
  if (!listEl || !allGroupingsData) return;

  const allItems = allGroupingsData.groupings || [];
  if (totalBadge) {
    totalBadge.textContent = `${allGroupingsData.total_groupings} groupings (${allGroupingsData.moments_count} Moments · ${allGroupingsData.unassigned_count} Unassigned)`;
  }
  if (assetsBadge) {
    assetsBadge.textContent = `${allGroupingsData.total_assets.toLocaleString()} assets`;
  }
  if (avgBadge) {
    avgBadge.textContent = `Overall Avg ${allGroupingsData.overall_avg_score.toFixed(4)}`;
  }

  const libStatus = allGroupingsData.library_status;
  const orgBadgeEl = document.getElementById('organizer-lib-status-badge');
  const orgCountsEl = document.getElementById('organizer-lib-counts-note');
  const orgBtnEl = document.getElementById('btn-activate-organizer-library') as HTMLButtonElement | null;
  if (libStatus && orgBadgeEl) {
    if (!libStatus.organizer_exists) {
      orgBadgeEl.className = 'badge badge-xs badge-amber font-mono';
      orgBadgeEl.textContent = '➕ Target: Media Organizer.photoslibrary Not Created Yet';
      orgBadgeEl.title = `Expected at ${libStatus.organizer_library_path}`;
      if (orgBtnEl) orgBtnEl.textContent = '➕ Create Media Organizer Library in Photos';
    } else if (libStatus.organizer_active_in_photos && !libStatus.all_media_open_in_photos) {
      orgBadgeEl.className = 'badge badge-xs badge-green font-mono';
      orgBadgeEl.textContent = '🟢 Target: Media Organizer Active in Photos';
      orgBadgeEl.title = libStatus.organizer_library_path;
      if (orgBtnEl) orgBtnEl.textContent = '⚡ Focus Media Organizer in Photos';
    } else {
      orgBadgeEl.className = 'badge badge-xs badge-blue font-mono';
      orgBadgeEl.textContent = libStatus.all_media_open_in_photos
        ? '⚠️ Photos Open on All-Media (Will Switch on Write)'
        : '🟡 Target: Media Organizer Ready on SSD';
      orgBadgeEl.title = libStatus.organizer_library_path;
      if (orgBtnEl) orgBtnEl.textContent = '⚡ Activate Media Organizer in Photos';
    }
    if (orgCountsEl) {
      orgCountsEl.textContent = `${allGroupingsData.in_organizer_count ?? 0} groupings · ${libStatus.mapped_assets_count} mapped assets`;
    }
  }

  const bySt = allGroupingsData.by_status || {};
  const statusPillsDef: Array<{ key: string; label: string }> = [
    { key: 'all', label: `All (${allItems.length})` },
    { key: 'ReadyToPublish', label: `🚀 Ready to Publish (${bySt['ReadyToPublish'] || 0})` },
    { key: 'Unassigned', label: `🟣 Unassigned (${bySt['Unassigned'] || 0})` },
    { key: 'M100', label: `📁 M100 (${bySt['M100'] || 0})` },
    { key: 'M200', label: `🟡 M200 TBC (${bySt['M200'] || 0})` },
    { key: 'M300', label: `📦 M300 (${bySt['M300'] || 0})` },
    { key: 'M400', label: `✅ M400 Curated (${bySt['M400'] || 0})` },
    { key: 'M450', label: `🚀 M450 Part-Pub (${bySt['M450'] || 0})` },
    { key: 'M500', label: `🏁 M500 Complete (${bySt['M500'] || 0})` },
    { key: 'Duplicates', label: `♻️ Duplicates (${bySt['Duplicates'] || 0})` },
    { key: 'Disjoint', label: `🔀 Disjoint <2 (${bySt['Disjoint'] || 0})` }
  ];

  if (pillsEl) {
    pillsEl.innerHTML = statusPillsDef
      .map(
        p =>
          `<button type="button" class="disjoint-target-chip${allGroupingsStatusFilter === p.key ? ' active' : ''}" data-grp-status-filter="${escapeHtml(p.key)}">${escapeHtml(p.label)}</button>`
      )
      .join('');
    pillsEl.querySelectorAll<HTMLButtonElement>('[data-grp-status-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        allGroupingsStatusFilter = btn.dataset.grpStatusFilter || 'all';
        renderAllUnifiedGroupings();
      });
    });
  }

  const filtered = allItems.filter(g => {
    if (allGroupingsStatusFilter !== 'all') {
      if (allGroupingsStatusFilter === 'Disjoint') {
        if (!g.is_disjoint) return false;
      } else if (allGroupingsStatusFilter === 'Duplicates') {
        if (!g.is_duplicate_group && !g.is_deduped_group) return false;
      } else if (allGroupingsStatusFilter === 'ReadyToPublish') {
        const pend = g.pending_publish_count ?? 0;
        if (!g.curation_matches_log || !['M300', 'M400', 'M450'].includes(g.moment_status) || pend <= 0) return false;
      } else if (g.moment_status !== allGroupingsStatusFilter) {
        return false;
      }
    }
    if (allGroupingsBatchFilter !== 'all') {
      const has600 = g.batches.some(b => parseInt(b.status_code, 10) >= 600);
      const hasUnder600 = g.batches.some(b => {
        const n = parseInt(b.status_code, 10);
        return !Number.isNaN(n) && n < 600;
      });
      if (allGroupingsBatchFilter === '600_plus' && !has600) return false;
      if (allGroupingsBatchFilter === 'under_600' && !hasUnder600) return false;
    }
    const isFullyCopied =
      Boolean(g.in_organizer_library) ||
      ((g.organizer_mapped_count || 0) >= g.total_assets && g.total_assets > 0);
    if (allGroupingsLibraryFilter === 'organizer' && !g.in_organizer_library && !(g.organizer_target_folders || []).length) {
      return false;
    }
    if (allGroupingsLibraryFilter === 'source_only' && isFullyCopied) {
      return false;
    }
    if (allGroupingsSearchQuery) {
      const hay = [
        g.name,
        g.moment_status,
        g.status_detail,
        g.tag_summary,
        g.rule_reason || '',
        g.shutterfly_url || '',
        g.youtube_url || '',
        ...(g.photos_folders || []).map(pf => `${pf.parent_folder} ${pf.full_path}`),
        ...(g.organizer_target_folders || []).map(ot => `${ot.album_name} ${ot.full_path}`),
        ...(g.source_all_media_folders || []).map(am => `${am.album_name} ${am.parent_folder} ${am.full_path}`),
        ...g.batches.map(b => `${b.month} ${b.status_code}`)
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(allGroupingsSearchQuery)) return false;
    }
    return true;
  });

  const tieBreakGroupOrder = (a: UnifiedGroupingItem, b: UnifiedGroupingItem): number =>
    (a.is_deduped_group ? 1 : 0) - (b.is_deduped_group ? 1 : 0) ||
    (a.is_duplicate_group ? 1 : 0) - (b.is_duplicate_group ? 1 : 0) ||
    (a.in_organizer_library ? 0 : 1) - (b.in_organizer_library ? 0 : 1) ||
    b.total_assets - a.total_assets ||
    (b.published_count || 0) - (a.published_count || 0) ||
    a.name.localeCompare(b.name);

  filtered.sort((a, b) => {
    if (allGroupingsSortMode === 'qual_avg') {
      return b.qualified_avg_score - a.qualified_avg_score || b.avg_score - a.avg_score || tieBreakGroupOrder(a, b);
    }
    if (allGroupingsSortMode === 'count') {
      return b.total_assets - a.total_assets || b.avg_score - a.avg_score || tieBreakGroupOrder(a, b);
    }
    if (allGroupingsSortMode === 'rank_score') {
      return b.rank_score - a.rank_score || b.avg_score - a.avg_score || tieBreakGroupOrder(a, b);
    }
    if (allGroupingsSortMode === 'date') {
      return (b.earliest_date || '').localeCompare(a.earliest_date || '') || b.avg_score - a.avg_score || tieBreakGroupOrder(a, b);
    }
    return b.avg_score - a.avg_score || tieBreakGroupOrder(a, b);
  });

  if (visiblePill) {
    visiblePill.textContent = `${filtered.length} / ${allItems.length} shown`;
  }

  if (!filtered.length) {
    listEl.innerHTML =
      '<div class="text-center text-muted font-mono" style="padding: 1.5rem;">No groupings match the current filters.</div>';
    return;
  }

  listEl.innerHTML = filtered
    .map((g, idx) => {
      const isExpanded = expandedUnifiedGroupingIds.has(g.grouping_id);
      const stCls = groupingMomentStatusBadgeClass(g.moment_status);
      const taggedHtml = renderMomentTaggedBadge(g.is_tagged, g.paradigm_confirmed, g.tag_summary);
      const disjHtml = g.is_disjoint
        ? '<span class="badge badge-xs badge-red font-mono" title="Fewer than 2 qualified assets">🔀 &lt;2 Qual</span>'
        : '';

      const batchesHtml =
        g.batches.length <= 3
          ? g.batches
              .map(
                b =>
                  `<span class="badge badge-xs ${batchStatusBadgeClass(b.status_code)} font-mono" title="${b.count} asset(s) in batch ${escapeHtml(b.month)} (status ${escapeHtml(b.status_code)})">📅 ${escapeHtml(b.month)} · ${escapeHtml(b.status_code)}</span>`
              )
              .join('')
          : `<span class="badge badge-xs ${batchStatusBadgeClass(g.batches[0].status_code)} font-mono" title="${escapeHtml(
              g.batches.map(b => `${b.month} [${b.status_code}] (${b.count})`).join(', ')
            )}">📅 ${escapeHtml(g.batches[0].month)}..${escapeHtml(g.batches[g.batches.length - 1].month)} (${g.batches.length} batches)</span>`;

      const photosFolders = g.photos_folders || [];
      const orgFolders = photosFolders.filter(pf => pf.library_scope === 'organizer');
      const legacyFolders = photosFolders.filter(pf => pf.library_scope !== 'organizer');
      const orgTargets = g.organizer_target_folders || [];
      const srcAllMedia = g.source_all_media_folders || [];
      const sampleAid = g.preview_assets?.[0]?.asset_id || '';
      let photosFolderPillHtml = '';
      if (orgFolders.length > 0) {
        const primaryOrg = orgFolders[0];
        const primaryOrgPath = primaryOrg?.full_path || '';
        const primaryOrgAlbum = primaryOrg?.album_name || g.name;
        const pathLabel = orgFolders.map(pf => pf.full_path).join(' + ');
        photosFolderPillHtml = `<button type="button" class="badge badge-xs badge-green font-mono pub-badge-link btn-ugrp-open-photos" data-grouping-id="${escapeHtml(g.grouping_id)}" data-library-scope="organizer" data-album-name="${escapeHtml(primaryOrgAlbum)}" data-full-path="${escapeHtml(primaryOrgPath)}" data-sample-aid="${escapeHtml(sampleAid)}" title="${escapeHtml(
          `In Media Organizer.photoslibrary:\n${orgFolders.map(pf => `• ${pf.full_path}${pf.asset_count ? ` (${pf.asset_count})` : ''}`).join('\n')}\nClick to open in Media Organizer Photos`
        )}">⚡ Media Organizer: ${escapeHtml(pathLabel)} ↗</button>`;
        if (showAllMediaSourceLinks && srcAllMedia.length > 0) {
          const topSrc = srcAllMedia[0];
          const extraSrcCnt = srcAllMedia.length - 1;
          const srcLabel = `${topSrc.parent_folder}/${topSrc.album_name}${topSrc.all_migrated ? ' ✓' : ` (${topSrc.matched_count}/${topSrc.source_total_count})`}${extraSrcCnt > 0 ? ` +${extraSrcCnt}` : ''}`;
          photosFolderPillHtml += ` <button type="button" class="badge badge-xs badge-outline font-mono pub-badge-link btn-ugrp-open-photos" data-grouping-id="${escapeHtml(g.grouping_id)}" data-library-scope="all_media" data-album-name="${escapeHtml(topSrc.album_name)}" data-full-path="${escapeHtml(topSrc.full_path)}" data-sample-aid="${escapeHtml(sampleAid)}" title="${escapeHtml(
            `Legacy source folder(s) still in All-Media.photoslibrary (Read-Only):\n${srcAllMedia.map(am => `• ${am.parent_folder}/${am.album_name} — ${am.all_migrated ? 'all active assets migrated (can be manually deleted in Photos)' : `${am.matched_count}/${am.source_total_count} migrated`}`).join('\n')}\nClick to spotlight in All-Media Photos if you want to delete manually`
          )}">📀 All-Media: ${escapeHtml(srcLabel)} ↗</button>`;
        }
      } else {
        if (legacyFolders.length > 0) {
          photosFolderPillHtml = `<span class="badge badge-xs badge-outline font-mono" title="${escapeHtml(
            `Source library (All-Media — read-only):\n${legacyFolders.map(pf => `• ${pf.full_path}${pf.asset_count ? ` (${pf.asset_count})` : ''}`).join('\n')}`
          )}">📀 All-Media: ${escapeHtml(
            Array.from(new Set(legacyFolders.map(pf => pf.parent_folder))).join(' + ')
          )}</span>`;
        } else if (g.parent_folders.length) {
          photosFolderPillHtml = `<span class="badge badge-xs badge-outline font-mono">📀 All-Media: ${escapeHtml(g.parent_folders.join(' + '))}</span>`;
        }
        if (orgTargets.length > 0) {
          const topTarget = orgTargets[0];
          const extraTargetsCnt = orgTargets.length - 1;
          const targetSummary = `${topTarget.full_path} (${topTarget.matched_count}/${g.total_assets})${extraTargetsCnt > 0 ? ` +${extraTargetsCnt}` : ''}`;
          photosFolderPillHtml += `${photosFolderPillHtml ? ' ' : ''}<button type="button" class="badge badge-xs badge-green font-mono pub-badge-link btn-ugrp-open-photos" data-grouping-id="${escapeHtml(g.grouping_id)}" data-library-scope="organizer" data-album-name="${escapeHtml(topTarget.album_name)}" data-full-path="${escapeHtml(topTarget.full_path)}" data-sample-aid="${escapeHtml(sampleAid)}" title="${escapeHtml(
            `Asset(s) copied into Media Organizer.photoslibrary:\n${orgTargets.map(ot => `• ${ot.full_path} (${ot.matched_count}/${g.total_assets})`).join('\n')}\nClick to open folder in Media Organizer Photos`
          )}">⚡ Media Organizer → ${escapeHtml(targetSummary)} ↗</button>`;
        }
      }

      const curatedFinderPillHtml = g.curated_folder_exists
        ? `<button type="button" class="badge badge-xs badge-outline font-mono pub-badge-link btn-ugrp-open-curated" data-moment-name="${escapeHtml(g.name)}" title="Open exported Curated folder on LaCie in Finder">📂 Curated ↗</button>`
        : '';

      const sfCnt = g.shutterfly_count || 0;
      const ytCnt = g.youtube_count || 0;
      const sfUrl = (g.shutterfly_url || '').trim();
      const ytUrl = (g.youtube_url || '').trim();
      const isPublishedOrLinked = g.published_count > 0 || Boolean(sfUrl) || Boolean(ytUrl);

      let sfLinkHtml = '';
      if (sfUrl) {
        sfLinkHtml = `<a href="${escapeHtml(sfUrl)}" target="_blank" rel="noopener noreferrer" class="badge badge-xs badge-amber font-mono pub-badge-link" title="Open Shutterfly Album: ${escapeHtml(sfUrl)}">📷 Shutterfly${sfCnt > 0 ? `: ${sfCnt}` : ''} ↗</a>`;
      } else if (sfCnt > 0) {
        sfLinkHtml = `<button type="button" class="badge badge-xs badge-amber font-mono pub-badge-link pub-badge-unset btn-ugrp-edit-pub-urls" data-grouping-id="${escapeHtml(g.grouping_id)}" title="No Shutterfly Album URL saved yet — click to enter album link">📷 Shutterfly: ${sfCnt} +Link</button>`;
      }

      let ytLinkHtml = '';
      if (ytUrl) {
        ytLinkHtml = `<a href="${escapeHtml(ytUrl)}" target="_blank" rel="noopener noreferrer" class="badge badge-xs badge-purple font-mono pub-badge-link" title="Open YouTube Video: ${escapeHtml(ytUrl)}">🎥 YouTube${ytCnt > 0 ? `: ${ytCnt}` : ''} ↗</a>`;
      } else if (ytCnt > 0) {
        ytLinkHtml = `<button type="button" class="badge badge-xs badge-purple font-mono pub-badge-link pub-badge-unset btn-ugrp-edit-pub-urls" data-grouping-id="${escapeHtml(g.grouping_id)}" title="No YouTube Video URL saved yet — click to enter video link">🎥 YouTube: ${ytCnt} +Link</button>`;
      }

      const editPubLinksBtnHtml = isPublishedOrLinked
        ? `<button type="button" class="pub-edit-url-btn btn-ugrp-edit-pub-urls" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Set or Edit Shutterfly Album / YouTube Video URLs">🔗</button>`
        : '';

      const isEditingUrls = editingUnifiedGroupingPubUrlId === g.grouping_id;
      const pubUrlEditorHtml = isEditingUrls
        ? `
          <div class="pub-url-editor" data-ugrp-url-editor="${escapeHtml(g.grouping_id)}" style="padding: 0.55rem 0.85rem 0.65rem; margin-top: 0; background: rgba(15, 23, 42, 0.92);">
            <div class="pub-url-row">
              <span class="pub-url-label">📷 Shutterfly:</span>
              <input type="url" class="pub-url-input" data-ugrp-sf-input="${escapeHtml(g.grouping_id)}" placeholder="https://photos.shutterfly.com/album/..." value="${escapeHtml(sfUrl)}" />
              <a href="https://photos.shutterfly.com/" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-outline" title="Open Shutterfly to copy album link">Open ↗</a>
            </div>
            <div class="pub-url-row">
              <span class="pub-url-label">🎥 YouTube:</span>
              <input type="url" class="pub-url-input" data-ugrp-yt-input="${escapeHtml(g.grouping_id)}" placeholder="https://youtu.be/... or https://www.youtube.com/watch?v=..." value="${escapeHtml(ytUrl)}" />
              <a href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-outline" title="Open YouTube Studio to copy video link">Studio ↗</a>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 0.4rem; margin-top: 0.15rem;">
              <button type="button" class="btn btn-xs btn-outline btn-ugrp-cancel-pub-urls" data-grouping-id="${escapeHtml(g.grouping_id)}">Cancel</button>
              <button type="button" class="btn btn-xs btn-green btn-ugrp-save-pub-urls" data-grouping-id="${escapeHtml(g.grouping_id)}">Save Links</button>
            </div>
          </div>
        `
        : '';

      const statusDetailNote = `<span class="text-muted">${escapeHtml(g.status_detail)}</span>`;

      const evTot = g.event_total_assets || g.total_assets;
      const fallbackExp = computeExpectedCuratedStats(evTot);
      const expCurCnt = g.expected_curated_count ?? fallbackExp.expected;
      const expCurLn = g.expected_curated_ln ?? fallbackExp.lnRaw;
      const expCurPillHtml = `<span class="badge badge-xs badge-purple font-mono" title="${escapeHtml(
        `Expected curated count = round(ln(${evTot})) = ${expCurCnt} (ln(${evTot}) = ${expCurLn.toFixed(2)})${
          g.curated_count > 0 ? ` · Currently curated: ${g.curated_count}` : ''
        }`
      )}">🎯 Exp Cur: ${expCurCnt} (ln ${evTot})</span>`;

      const isCuratedRow =
        Boolean(g.curation_matches_log) &&
        (g.moment_status === 'M300' ||
          g.moment_status === 'M400' ||
          g.moment_status === 'M450' ||
          g.moment_status === 'M500' ||
          g.curated_count > 0);
      const isCompletedM500Row = g.moment_status === 'M500' && g.published_count > 0;
      const mismatchCurCnt = g.curation_mismatch_count || 0;
      const mismatchPillHtml =
        !isCuratedRow && !isCompletedM500Row && mismatchCurCnt > 0
          ? `<span class="badge badge-xs badge-amber font-mono" title="${escapeHtml(
              `Prior curation has ${mismatchCurCnt} item(s), which does not match logarithmic expectation ln(${evTot}) = ${expCurCnt}. Treated as uncurated — Publish is locked until curated to ${expCurCnt} keeper(s).`
            )}">⚠️ Uncurated (${mismatchCurCnt} cur ≠ 🎯 ${expCurCnt})</span>`
          : '';
      const pendingPubCnt = isCuratedRow ? (g.pending_publish_count ?? Math.max(0, g.curated_count - g.published_count)) : 0;
      const propPreview = g.proposed_publish_preview || [];
      const propTooltip = propPreview.length
        ? `Step 2B Pending Publishing:\n• Curated: ${g.curated_count} · Published: ${g.published_count} · Pending: ${pendingPubCnt}\n• Can Publish: ${g.can_publish_str}\n• Proposed Next (${g.propose_next_str || '—'}): ${propPreview
            .slice(0, 5)
            .map(p => `${p.filename} [${p.score.toFixed(4)}]`)
            .join(', ')}${propPreview.length > 5 ? ` (+${propPreview.length - 5})` : ''}`
        : '';
      const step2bPubPillHtml =
        isCuratedRow && pendingPubCnt > 0
          ? `<span class="badge badge-xs ${g.can_publish_ok ? 'badge-green' : 'badge-amber'} font-mono" title="${escapeHtml(propTooltip)}">${
              g.can_publish_ok ? '🚀 Can Publish: Yes' : `⏳ Publish: ${escapeHtml(g.can_publish_str)}`
            } · Pending ${pendingPubCnt}${g.propose_next_str && g.propose_next_str !== '—' ? ` · Next: ${escapeHtml(g.propose_next_str)}` : ''}</span>`
          : '';

      const countsParts: string[] = [
        `<strong>${g.total_assets}</strong> total`,
        `<span class="text-green">★ ${g.qualified_assets} qual</span>`,
        `<span style="color:#c4b5fd;" title="ln(${evTot}) = ${expCurLn.toFixed(2)}">🎯 ${expCurCnt} exp cur</span>`
      ];
      if (isCuratedRow && g.curated_count > 0) {
        countsParts.push(`<span style="color:#93c5fd;">✅ ${g.curated_count}/${expCurCnt} cur ✓</span>`);
      } else if (mismatchCurCnt > 0) {
        countsParts.push(`<span class="text-amber" title="Legacy/prior curated count (${mismatchCurCnt}) does not match expected ln(${evTot}) = ${expCurCnt}">⚠️ ${mismatchCurCnt} prior cur ≠ ${expCurCnt}</span>`);
      }
      if (g.to_be_curated_count > 0) countsParts.push(`<span class="text-amber">🟡 ${g.to_be_curated_count} TBC</span>`);
      if (g.published_count > 0) countsParts.push(`<span class="text-green">📢 ${g.published_count} pub</span>`);
      if (pendingPubCnt > 0 && isCuratedRow) countsParts.push(`<span class="text-green">📤 ${pendingPubCnt} pending</span>`);
      if (g.duplicate_count > 0) countsParts.push(`<span class="text-amber">♻️ ${g.duplicate_count} dup</span>`);

      const thumbsHtml = (g.preview_assets || [])
        .slice(0, 5)
        .map(
          pa =>
            `<img class="ugrp-inline-thumb" data-grouping-id="${escapeHtml(g.grouping_id)}" data-asset-id="${escapeHtml(pa.asset_id)}" src="/api/media/cleanup/thumbnail/${encodeURIComponent(pa.asset_id)}" alt="${escapeHtml(pa.filename)}" title="${escapeHtml(pa.filename)} · Score ${pa.score.toFixed(4)}" loading="lazy" />`
        )
        .join('');
      const extraThumbCnt = Math.max(0, g.total_assets - 5);

      const allCopiedToOrganizer =
        Boolean(g.in_organizer_library) &&
        ((g.organizer_mapped_count || 0) >= g.total_assets && g.total_assets > 0);
      const tagBtnLabel = allCopiedToOrganizer ? '🏷️ Tag / Merge' : '🏷️ Tag &amp; Copy';
      const dupGroupPillHtml = g.is_deduped_group
        ? `<span class="badge badge-xs badge-amber font-mono" title="${escapeHtml(
            `Deduplicated into '${g.duplicate_of_moment || ''}' — click Remove on the right to open All-Media.photoslibrary and manually delete this legacy Moment in Photos`
          )}">♻️ Deduped → ${escapeHtml(g.duplicate_of_moment || 'Primary')}</span>`
        : g.is_duplicate_group && g.duplicate_of_moment
          ? `<span class="badge badge-xs badge-amber font-mono" title="${escapeHtml(
              `100% of this group's active assets already belong to '${g.duplicate_of_moment}' — click Dedup to reconcile DB tags & switch button to Remove (All-Media link)`
            )}">♻️ Dup of: ${escapeHtml(g.duplicate_of_moment)}</span>`
          : '';
      const removeTargetFolder = legacyFolders[0] || srcAllMedia[0];
      const removeAlbumName = removeTargetFolder?.album_name || g.name;
      const removeFullPath = removeTargetFolder?.full_path || '';
      const dedupRowBtnHtml =
        g.is_duplicate_group && !g.is_deduped_group && g.duplicate_of_moment
          ? `<button type="button" class="btn btn-xs btn-amber btn-ugrp-row-action" data-action="dedup" data-grouping-id="${escapeHtml(g.grouping_id)}" title="${escapeHtml(
              `Deduplicate '${g.name}' into '${g.duplicate_of_moment}' — merges DB tags & changes button to Remove (All-Media link)`
            )}">♻️ Dedup</button>`
          : '';
      const quickActionHtml = g.is_deduped_group
        ? `<button type="button" class="btn btn-xs btn-red btn-ugrp-open-photos" data-grouping-id="${escapeHtml(g.grouping_id)}" data-is-remove-link="1" data-library-scope="all_media" data-album-name="${escapeHtml(removeAlbumName)}" data-full-path="${escapeHtml(removeFullPath)}" data-sample-aid="${escapeHtml(sampleAid)}" title="${escapeHtml(
            `Deduped into '${g.duplicate_of_moment || ''}' — click to open '${removeAlbumName}' in All-Media.photoslibrary (Read-Only) so you can manually delete the Moment from Apple Photos`
          )}">🗑️ Remove</button>`
        : isCuratedRow && pendingPubCnt > 0
          ? `<button type="button" class="btn btn-xs ${g.published_count > 0 ? 'btn-purple' : 'btn-green'} btn-ugrp-row-action" data-action="publish" data-grouping-id="${escapeHtml(g.grouping_id)}" title="${escapeHtml(propTooltip || `Review & publish batch for '${g.name}'`)}">🚀 Publish</button>
             <button type="button" class="btn btn-xs btn-outline btn-ugrp-row-action" data-action="curate" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Adjust manual curation or tags">🎨 Curate</button>`
          : isCompletedM500Row
            ? `<button type="button" class="btn btn-xs btn-outline btn-ugrp-row-action" data-action="publish" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Open Publish / Republish dialog">🔄 Republish</button>
               <button type="button" class="btn btn-xs btn-outline btn-ugrp-row-action" data-action="curate" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Adjust manual curation or tags">🎨 Curate</button>`
            : g.kind === 'unassigned'
              ? `${g.is_tagged ? '' : `<button type="button" class="btn btn-xs btn-cyan btn-ugrp-row-action" data-action="assign" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Tag & assign selected assets into Moments">✨ Tag &amp; Assign</button>`}
                 <button type="button" class="btn btn-xs btn-purple btn-ugrp-row-action" data-action="curate" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Tag & manually curate ${expCurCnt} keepers (ln ${evTot}) directly into Curated & Ready to Publish">🎨 Curate (${expCurCnt})</button>`
              : `${dedupRowBtnHtml}
                 ${g.is_tagged ? '' : `<button type="button" class="btn btn-xs ${allCopiedToOrganizer ? 'btn-outline' : 'btn-cyan'} btn-ugrp-row-action" data-action="tag" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Tag & copy/consolidate into Moments">${tagBtnLabel}</button>`}
                 <button type="button" class="btn btn-xs btn-purple btn-ugrp-row-action" data-action="curate" data-grouping-id="${escapeHtml(g.grouping_id)}" title="Tag & manually curate ${expCurCnt} keepers (ln ${evTot}) directly into Curated & Ready to Publish">🎨 Curate (${expCurCnt})</button>`;

      const cachedAssets = unifiedGroupingAssetsCache.get(g.grouping_id);
      const bodyInnerHtml = isExpanded
        ? cachedAssets
          ? renderExpandedGroupingBodyHtml(g, cachedAssets)
          : '<div class="text-muted font-mono" style="padding: 0.6rem;"><div class="spinner-sm" style="display:inline-block;margin-right:0.4rem;"></div>Loading grouping assets...</div>'
        : '';

      return `
        <div class="unified-grouping-card${isExpanded ? ' expanded' : ''}" data-grouping-id="${escapeHtml(g.grouping_id)}">
          <div class="unified-grouping-header" data-toggle-grouping-id="${escapeHtml(g.grouping_id)}">
            <div class="unified-grouping-left">
              <span class="font-mono text-muted" style="font-size: 0.72rem; min-width: 34px; padding-top: 0.1rem;">${isExpanded ? '▾' : '▸'} #${idx + 1}</span>
              <div style="min-width: 0; flex: 1;">
                <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                  <strong style="font-size: 0.85rem; color: var(--text-primary);">${escapeHtml(g.name)}</strong>
                  <span class="badge badge-xs ${stCls} font-mono">${escapeHtml(g.moment_status)}</span>
                  ${expCurPillHtml}
                  ${dupGroupPillHtml}
                  ${mismatchPillHtml}
                  ${disjHtml}
                  ${batchesHtml}
                  ${taggedHtml}
                  ${photosFolderPillHtml}
                  ${curatedFinderPillHtml}
                  ${step2bPubPillHtml}
                  ${sfLinkHtml}
                  ${ytLinkHtml}
                  ${editPubLinksBtnHtml}
                </div>
                <div class="unified-grouping-metrics" style="margin-top: 0.24rem; color: var(--text-secondary);">
                  <span>${countsParts.join(' · ')}</span>
                  <span>·</span>
                  ${statusDetailNote}
                  <span>·</span>
                  <span class="text-muted">${escapeHtml(g.date_range)}</span>
                </div>
              </div>
            </div>
            <div class="unified-grouping-right">
              <div style="text-align: right;" class="font-mono">
                <div style="font-size: 0.82rem; font-weight: 700; color: #fbbf24;">Avg ${g.avg_score.toFixed(4)}</div>
                <div class="text-muted" style="font-size: 0.65rem;">
                  ${g.min_score.toFixed(3)}..${g.max_score.toFixed(3)} · Rank ${g.rank_score.toFixed(2)}
                </div>
              </div>
              <div class="unified-grouping-thumbs">
                ${thumbsHtml}
                ${extraThumbCnt > 0 ? `<span class="badge badge-xs badge-outline font-mono">+${extraThumbCnt}</span>` : ''}
              </div>
              ${quickActionHtml}
            </div>
          </div>
          ${pubUrlEditorHtml}
          <div class="unified-grouping-body" data-grouping-body-id="${escapeHtml(g.grouping_id)}">${bodyInnerHtml}</div>
        </div>
      `;
    })
    .join('');

  const itemById = new Map<string, UnifiedGroupingItem>();
  filtered.forEach(g => itemById.set(g.grouping_id, g));

  filtered.forEach(g => {
    if (expandedUnifiedGroupingIds.has(g.grouping_id) && unifiedGroupingAssetsCache.has(g.grouping_id)) {
      const bodyEl = listEl.querySelector<HTMLElement>(
        `.unified-grouping-body[data-grouping-body-id="${CSS.escape(g.grouping_id)}"]`
      );
      if (bodyEl) wireExpandedGroupingBodyEvents(bodyEl, g);
    }
  });

  listEl.querySelectorAll<HTMLElement>('[data-toggle-grouping-id]').forEach(hdrEl => {
    hdrEl.addEventListener('click', async e => {
      if (
        (e.target as HTMLElement).closest(
          '.btn-ugrp-row-action, .ugrp-inline-thumb, .pub-badge-link, .btn-ugrp-edit-pub-urls, .btn-ugrp-open-photos, .btn-ugrp-open-curated, a'
        )
      ) {
        return;
      }
      const gid = hdrEl.dataset.toggleGroupingId || '';
      const g = itemById.get(gid);
      if (!g) return;
      const cardEl = hdrEl.closest<HTMLElement>('.unified-grouping-card');
      const bodyEl = cardEl?.querySelector<HTMLElement>('.unified-grouping-body');
      if (!cardEl || !bodyEl) return;

      if (expandedUnifiedGroupingIds.has(gid)) {
        expandedUnifiedGroupingIds.delete(gid);
        cardEl.classList.remove('expanded');
        const chev = hdrEl.querySelector('span.font-mono');
        if (chev) chev.textContent = chev.textContent?.replace('▾', '▸') || '';
        return;
      }

      expandedUnifiedGroupingIds.add(gid);
      cardEl.classList.add('expanded');
      const chev = hdrEl.querySelector('span.font-mono');
      if (chev) chev.textContent = chev.textContent?.replace('▸', '▾') || '';
      bodyEl.innerHTML =
        '<div class="text-muted font-mono" style="padding: 0.6rem;"><div class="spinner-sm" style="display:inline-block;margin-right:0.4rem;"></div>Loading grouping assets...</div>';
      try {
        const assets = await ensureGroupingAssetsLoaded(g);
        bodyEl.innerHTML = renderExpandedGroupingBodyHtml(g, assets);
        wireExpandedGroupingBodyEvents(bodyEl, g);
      } catch (err: any) {
        bodyEl.innerHTML = `<div class="text-red font-mono" style="padding: 0.6rem;">❌ ${escapeHtml(err?.message || 'Failed loading assets')}</div>`;
      }
    });
  });

  listEl.querySelectorAll<HTMLElement>('.ugrp-inline-thumb').forEach(imgEl => {
    imgEl.addEventListener('click', async e => {
      e.stopPropagation();
      const gid = imgEl.dataset.groupingId || '';
      const aid = imgEl.dataset.assetId || '';
      const g = itemById.get(gid);
      if (!g || !aid) return;
      try {
        const assets = await ensureGroupingAssetsLoaded(g);
        const selSet = getOrInitGroupingSelectedSet(gid, assets);
        openCleanupPreviewModal(aid, {
          assetIds: assets.map(x => x.asset_id),
          groupLabel: `${g.name} (${g.moment_status})`,
          hideMarkRemoved: true,
          selectedIds: selSet,
          defaultSort: 'score',
          onSelectionChange: () => {
            if (expandedUnifiedGroupingIds.has(gid)) {
              const bodyEl = listEl.querySelector<HTMLElement>(
                `.unified-grouping-body[data-grouping-body-id="${CSS.escape(gid)}"]`
              );
              if (bodyEl) {
                bodyEl.innerHTML = renderExpandedGroupingBodyHtml(g, assets);
                wireExpandedGroupingBodyEvents(bodyEl, g);
              }
            }
          }
        });
      } catch {
        openCleanupPreviewModal(aid, { assetIds: [aid], groupLabel: g.name, hideMarkRemoved: true });
      }
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-row-action').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const gid = btn.dataset.groupingId || '';
      const act = btn.dataset.action || '';
      const g = itemById.get(gid);
      if (!g) return;
      if (act === 'dedup') {
        void triggerDedupMomentGrouping(g, btn);
      } else if (act === 'assign') {
        const assets = g.inline_assets || unifiedGroupingAssetsCache.get(gid) || [];
        const selSet = getOrInitGroupingSelectedSet(gid, assets);
        const ids = assets.filter(a => selSet.has(a.asset_id)).map(a => a.asset_id);
        const prefill = /uncategorized/i.test(g.name) ? '' : g.name;
        void openResolveDisjointModal(g.name, prefill, { assetIds: ids, isUnassignedCluster: true });
      } else if (act === 'curate') {
        if (g.kind === 'unassigned') {
          const assets = g.inline_assets || unifiedGroupingAssetsCache.get(gid) || [];
          const allIds = assets.map(a => a.asset_id);
          const prefill = /uncategorized/i.test(g.name) ? '' : g.name;
          void openResolveDisjointModal(g.name, prefill, {
            assetIds: allIds,
            isUnassignedCluster: true,
            isCurateM200: true
          });
        } else {
          void openResolveDisjointModal(g.name, '', { isHistoricalMoment: true, isCurateM200: true });
        }
      } else if (act === 'publish') {
        void openPublishMomentModal(g.name);
      } else {
        void openResolveDisjointModal(g.name, '', { isHistoricalMoment: true });
      }
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-open-photos').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const gid = btn.dataset.groupingId || '';
      const g = itemById.get(gid);
      if (!g) return;
      const albName = btn.dataset.albumName || g.name;
      const fullPath = btn.dataset.fullPath || '';
      const sampleAid = btn.dataset.sampleAid || '';
      const libScope = btn.dataset.libraryScope || 'organizer';
      const isRemoveLink = btn.dataset.isRemoveLink === '1';
      const confirmMsg = isRemoveLink
        ? `Open All-Media.photoslibrary (Read-Only) and spotlight "${albName}" so you can manually delete this duplicate Moment in Apple Photos?\n\n(Data Orchestrator never deletes from All-Media directly — once you delete the album in Photos, switch back to Media Organizer.)`
        : `Switch Apple Photos to All-Media.photoslibrary (Read-Only) and spotlight "${albName}"?\n\nData Orchestrator never modifies All-Media — you can inspect or manually delete the legacy album in Photos, then switch back to Media Organizer when ready.`;
      if (libScope === 'all_media' && !window.confirm(confirmMsg)) {
        return;
      }
      btn.disabled = true;
      try {
        await fetch('/api/media/memories/open-photos-album', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            album_name: albName,
            full_path: fullPath,
            sample_asset_id: sampleAid,
            library_scope: libScope
          })
        });
      } finally {
        btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-open-curated').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const mName = btn.dataset.momentName || '';
      if (!mName) return;
      btn.disabled = true;
      try {
        await fetch('/api/media/memories/open-curated-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ moment_name: mName, folder_kind: 'curated' })
        });
      } finally {
        btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-edit-pub-urls').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const gid = btn.dataset.groupingId || '';
      if (!gid) return;
      editingUnifiedGroupingPubUrlId = editingUnifiedGroupingPubUrlId === gid ? null : gid;
      renderAllUnifiedGroupings();
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-cancel-pub-urls').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      editingUnifiedGroupingPubUrlId = null;
      renderAllUnifiedGroupings();
    });
  });

  listEl.querySelectorAll<HTMLButtonElement>('.btn-ugrp-save-pub-urls').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const gid = btn.dataset.groupingId || '';
      const g = itemById.get(gid);
      if (!g) return;
      const sfInp = listEl.querySelector<HTMLInputElement>(`[data-ugrp-sf-input="${CSS.escape(gid)}"]`);
      const ytInp = listEl.querySelector<HTMLInputElement>(`[data-ugrp-yt-input="${CSS.escape(gid)}"]`);
      const sfVal = (sfInp?.value || '').trim();
      const ytVal = (ytInp?.value || '').trim();
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/media/published-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            moment_name: g.name,
            shutterfly_url: sfVal,
            youtube_url: ytVal
          })
        });
        const out = await res.json();
        if (!res.ok || !out.ok) {
          alert(`Failed to save URL: ${out.error || `HTTP ${res.status}`}`);
          btn.disabled = false;
          btn.textContent = 'Save Links';
          return;
        }
        g.shutterfly_url = sfVal;
        g.youtube_url = ytVal;
        editingUnifiedGroupingPubUrlId = null;
        renderAllUnifiedGroupings();
      } catch (err: any) {
        alert(`Error saving URL: ${err?.message || 'Unknown error'}`);
        btn.disabled = false;
        btn.textContent = 'Save Links';
      }
    });
  });
}

// ==========================================================================
// Consolidate Dialog: Devices in Same Timeframe (Naming Clues & Photo Explorer)
// ==========================================================================

async function fetchDisjointTimeframeDevices(): Promise<void> {
  const chipsEl = document.getElementById('resolve-disjoint-device-chips');
  const rangePillEl = document.getElementById('resolve-disjoint-timeframe-range-pill');
  const hintsEl = document.getElementById('resolve-disjoint-timeframe-hints');
  const panelEl = document.getElementById('resolve-disjoint-device-preview-panel');
  if (!chipsEl) return;

  chipsEl.innerHTML =
    '<span class="text-muted font-mono" style="font-size: 0.68rem;">Scanning devices in timeframe...</span>';
  if (rangePillEl) rangePillEl.textContent = '...';
  if (hintsEl) {
    hintsEl.style.display = 'none';
    hintsEl.innerHTML = '';
  }

  const dates = resolveDisjointAssets
    .map(a => (a.date_created_utc || '').trim())
    .filter(Boolean)
    .sort();
  const startDate = dates[0] || '';
  const endDate = dates[dates.length - 1] || startDate;
  const srcIds = resolveDisjointAssets.map(a => a.asset_id).slice(0, 60).join(',');

  const qs = new URLSearchParams({
    anchor_moment: resolveDisjointMomentName,
    start_date: startDate,
    end_date: endDate,
    window_days: String(disjointTimeframeWindowDays),
    source_asset_ids: srcIds
  });

  try {
    const res = await fetch(`/api/media/memories/timeframe-devices?${qs.toString()}`);
    const data: TimeframeDevicesResponse = await res.json();
    if (!res.ok || !data.ok) {
      chipsEl.innerHTML = `<span class="text-muted font-mono" style="font-size: 0.68rem;">${escapeHtml(data.error || 'No timeframe device data')}</span>`;
      if (panelEl) panelEl.style.display = 'none';
      return;
    }

    disjointTimeframeData = data;
    (data.assets || []).forEach(a => {
      const sz = a.file_size_bytes || 0;
      candidateAssetMeta.set(a.asset_id, {
        asset_id: a.asset_id,
        filename: a.original_filename,
        original_filename: a.original_filename,
        camera_model: a.camera_model || 'Unknown Device',
        primary_owner: a.owner_name || '',
        month: (a.date_created_utc || '').slice(0, 7),
        date_created_utc: a.date_created_utc || '',
        capture_timestamp: a.date_created_utc || '',
        file_size_bytes: sz,
        bytes: sz,
        file_size_mb: sz / (1024 * 1024),
        score_normalized: a.score_normalized,
        score_quartile: a.qualified ? 'Qualified' : 'Below Threshold',
        assigned_moment: a.assigned_moment || 'Unassigned',
        asset_tags: a.asset_tags,
        media_type: a.media_type,
        duration_sec: a.duration || 0,
        width: 0,
        height: 0,
        fps: 0
      });
    });

    if (
      disjointTimeframeActiveDeviceKey &&
      disjointTimeframeActiveDeviceKey !== '__all__' &&
      !(data.devices || []).some(d => d.device_key === disjointTimeframeActiveDeviceKey)
    ) {
      disjointTimeframeActiveDeviceKey = null;
    }
    renderDisjointTimeframeDevicesUI();
  } catch (err: any) {
    chipsEl.innerHTML = `<span class="text-red font-mono" style="font-size: 0.68rem;">Error loading timeframe devices: ${escapeHtml(err?.message || 'Unknown')}</span>`;
  }
}

function renderDisjointTimeframeDevicesUI(): void {
  const chipsEl = document.getElementById('resolve-disjoint-device-chips');
  const rangePillEl = document.getElementById('resolve-disjoint-timeframe-range-pill');
  const hintsEl = document.getElementById('resolve-disjoint-timeframe-hints');
  const panelEl = document.getElementById('resolve-disjoint-device-preview-panel');
  const titleEl = document.getElementById('resolve-disjoint-device-preview-title');
  const gridEl = document.getElementById('resolve-disjoint-device-assets-grid');
  const qualToggleBtn = document.getElementById('btn-disjoint-device-qual-toggle') as HTMLButtonElement | null;
  const addCheckedBtn = document.getElementById('btn-disjoint-device-add-checked') as HTMLButtonElement | null;
  if (!chipsEl || !disjointTimeframeData) return;

  if (rangePillEl) {
    rangePillEl.textContent = `📅 ${disjointTimeframeData.window_label} · ${disjointTimeframeData.total_assets} assets`;
  }

  // Naming clues strip (1-click add to Location / Family Member / People / Activity tags or preview nearby Moment)
  if (hintsEl) {
    const nh = disjointTimeframeData.naming_hints;
    const presentTagLc = new Set(sourceTagState.tags.map(t => t.tag_value.toLowerCase()));
    const clueChips: string[] = [];

    (nh.locations || []).forEach(loc => {
      if (presentTagLc.has(loc.toLowerCase())) return;
      clueChips.push(
        `<button type="button" class="disjoint-mini-chip btn-tf-add-clue" data-cat="location" data-val="${escapeHtml(loc)}" data-inc="1" title="Add '${escapeHtml(loc)}' to Location tags & folder name" style="border-color: rgba(251, 191, 36, 0.45); color: #fde68a;">+ 📍 ${escapeHtml(loc)}</button>`
      );
    });
    (nh.activities || []).forEach(act => {
      if (presentTagLc.has(act.toLowerCase())) return;
      clueChips.push(
        `<button type="button" class="disjoint-mini-chip btn-tf-add-clue" data-cat="activity" data-val="${escapeHtml(act)}" data-inc="1" title="Add '${escapeHtml(act)}' to Activity tags & folder name" style="border-color: rgba(56, 189, 248, 0.45); color: #bae6fd;">+ 🏃 ${escapeHtml(act)}</button>`
      );
    });
    (nh.family_owners || []).forEach(fam => {
      if (presentTagLc.has(fam.toLowerCase())) return;
      clueChips.push(
        `<button type="button" class="disjoint-mini-chip btn-tf-add-clue" data-cat="family_member" data-val="${escapeHtml(fam)}" data-inc="0" title="Device active in timeframe — add '${escapeHtml(fam)}' to Family Member tags" style="border-color: rgba(52, 211, 153, 0.45); color: #a7f3d0;">+ 📱 ${escapeHtml(fam)}</button>`
      );
    });
    (nh.people || []).forEach(per => {
      if (presentTagLc.has(per.toLowerCase()) || (nh.family_owners || []).some(f => f.toLowerCase() === per.toLowerCase())) {
        return;
      }
      clueChips.push(
        `<button type="button" class="disjoint-mini-chip btn-tf-add-clue" data-cat="people" data-val="${escapeHtml(per)}" data-inc="1" title="Detected face in timeframe — add '${escapeHtml(per)}' to People tags" style="border-color: rgba(167, 139, 250, 0.45); color: #ddd6fe;">+ 👤 ${escapeHtml(per)}</button>`
      );
    });
    (nh.moments || []).slice(0, 4).forEach(m => {
      clueChips.push(
        `<button type="button" class="disjoint-mini-chip btn-tf-preview-moment" data-moment-name="${escapeHtml(m.moment_name)}" title="Preview '${escapeHtml(m.moment_name)}' (${m.count} asset(s) in this timeframe)">📂 ${escapeHtml(m.moment_name)} (${m.count})</button>`
      );
    });

    if (clueChips.length > 0) {
      hintsEl.style.display = 'flex';
      hintsEl.innerHTML = `<span class="font-mono text-muted" style="font-size: 0.64rem;">Clues in timeframe:</span>${clueChips.join('')}`;
      hintsEl.querySelectorAll<HTMLButtonElement>('.btn-tf-add-clue').forEach(btn => {
        btn.addEventListener('click', () => {
          const cat = (btn.dataset.cat || 'location') as MomentTagItem['category'];
          const val = btn.dataset.val || '';
          const inc = btn.dataset.inc === '1';
          if (val) {
            addTagToEngineState(sourceTagState, cat, val, inc);
            renderDisjointTimeframeDevicesUI();
          }
        });
      });
      hintsEl.querySelectorAll<HTMLButtonElement>('.btn-tf-preview-moment').forEach(btn => {
        btn.addEventListener('click', () => {
          const mn = btn.dataset.momentName || '';
          if (mn) void openCandidateMomentPreview(mn);
        });
      });
    } else {
      hintsEl.style.display = 'none';
      hintsEl.innerHTML = '';
    }
  }

  const devices = disjointTimeframeData.devices || [];
  if (!devices.length) {
    chipsEl.innerHTML =
      '<span class="text-muted font-mono" style="font-size: 0.68rem;">No device photos found in this window — widen timeframe to ±3d or ±7d.</span>';
    if (panelEl) panelEl.style.display = 'none';
    return;
  }

  const otherTotal = (disjointTimeframeData.assets || []).filter(a => !a.in_source).length;
  const allChipHtml = `<button type="button" class="disjoint-target-chip${disjointTimeframeActiveDeviceKey === '__all__' ? ' active' : ''}" data-tf-device-key="__all__" title="Inspect all ${disjointTimeframeData.assets.length} photos across ${devices.length} device(s) in this timeframe">🌐 All Devices <span style="opacity:0.75;">(${otherTotal} other / ${disjointTimeframeData.assets.length} total)</span></button>`;
  const devChipsHtml = devices
    .map(d => {
      const isAct = disjointTimeframeActiveDeviceKey === d.device_key;
      const qualNote = d.qualified_count > 0 ? ` · ★${d.qualified_count}` : '';
      const momentsTip = d.moments_seen.length ? `\nMoments: ${d.moments_seen.join(', ')}` : '';
      return `<button type="button" class="disjoint-target-chip${isAct ? ' active' : ''}" data-tf-device-key="${escapeHtml(d.device_key)}" title="${escapeHtml(`${d.label}: ${d.total_count} photo(s) (${d.other_count} outside this Moment)${momentsTip}`)}">📱 ${escapeHtml(d.label)} <span style="opacity:0.75;">(${d.total_count}${qualNote})</span></button>`;
    })
    .join('');

  chipsEl.innerHTML = `${allChipHtml}${devChipsHtml}`;
  chipsEl.querySelectorAll<HTMLButtonElement>('[data-tf-device-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dk = btn.dataset.tfDeviceKey || '';
      disjointTimeframeActiveDeviceKey = disjointTimeframeActiveDeviceKey === dk ? null : dk;
      renderDisjointTimeframeDevicesUI();
    });
  });

  if (!panelEl || !titleEl || !gridEl) return;
  if (!disjointTimeframeActiveDeviceKey) {
    panelEl.style.display = 'none';
    return;
  }

  panelEl.style.display = 'flex';
  const activeDev = devices.find(d => d.device_key === disjointTimeframeActiveDeviceKey);
  const matchingAssets = (disjointTimeframeData.assets || []).filter(a => {
    if (disjointTimeframeActiveDeviceKey !== '__all__' && a.device_key !== disjointTimeframeActiveDeviceKey) {
      return false;
    }
    if (disjointTimeframeQualOnly && !a.qualified) {
      return false;
    }
    return true;
  });

  const checkedOutsideCnt = (disjointTimeframeData.assets || []).filter(
    a => !a.in_source && disjointTimeframeCheckedIds.has(a.asset_id)
  ).length;
  titleEl.textContent = activeDev
    ? `📱 ${activeDev.label} · ${matchingAssets.length} photo(s) in ${disjointTimeframeData.window_label}`
    : `🌐 All Devices · ${matchingAssets.length} photo(s) in ${disjointTimeframeData.window_label}`;

  if (qualToggleBtn) {
    qualToggleBtn.classList.toggle('btn-purple', disjointTimeframeQualOnly);
    qualToggleBtn.classList.toggle('btn-outline', !disjointTimeframeQualOnly);
    qualToggleBtn.textContent = disjointTimeframeQualOnly ? '★ Showing Qualified Only' : '★ Qualified Only';
  }
  if (addCheckedBtn) {
    addCheckedBtn.textContent =
      checkedOutsideCnt > 0
        ? `➕ Include Checked (${checkedOutsideCnt}) in Consolidation`
        : '➕ Include Checked in Consolidation';
    addCheckedBtn.disabled = checkedOutsideCnt === 0;
  }

  if (!matchingAssets.length) {
    gridEl.innerHTML =
      '<div class="text-muted font-mono" style="font-size: 0.69rem; padding: 0.4rem;">No photos match filter on this device.</div>';
    return;
  }

  const previewIds = matchingAssets.map(a => a.asset_id);
  gridEl.innerHTML = matchingAssets
    .map((a: TimeframeDeviceAssetItem) => {
      const checked = disjointTimeframeCheckedIds.has(a.asset_id);
      const dtShort = (a.date_created_utc || '').replace('T', ' ').slice(5, 16);
      const ownerShort = a.owner_name && a.owner_name !== 'Shared/Other' ? `${a.owner_name} · ` : '';
      const momLabel = a.in_source
        ? '<span class="badge badge-xs badge-amber font-mono" style="font-size:0.56rem;">📌 This Moment</span>'
        : a.assigned_moment
          ? `<button type="button" class="badge badge-xs badge-blue font-mono btn-tf-card-moment" data-moment-name="${escapeHtml(a.assigned_moment)}" style="font-size:0.56rem; cursor:pointer;" title="Click to preview Moment '${escapeHtml(a.assigned_moment)}'">📂 ${escapeHtml(a.assigned_moment)}</button>`
          : a.is_excluded
            ? '<span class="badge badge-xs badge-outline font-mono" style="font-size:0.56rem;">Ignored/Skip</span>'
            : '<span class="badge badge-xs badge-purple font-mono" style="font-size:0.56rem;">Unassigned</span>';
      return `
        <div class="tag-db-asset-card" style="${a.in_source ? 'border-color: rgba(245, 158, 11, 0.45);' : ''}" title="${escapeHtml(`${a.original_filename} · ${ownerShort}${a.camera_model} · ${a.date_created_utc}`)}">
          <input type="checkbox" class="disjoint-tf-asset-cb" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} ${a.in_source ? 'disabled title="Already in primary Moment"' : 'style="cursor: pointer; flex-shrink: 0;"'} />
          <img class="tag-db-asset-thumb btn-tf-preview-asset" data-asset-id="${escapeHtml(a.asset_id)}" src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.original_filename)}" loading="lazy" />
          <div class="btn-tf-preview-asset" data-asset-id="${escapeHtml(a.asset_id)}" style="min-width: 0; flex: 1; cursor: pointer;">
            <div class="font-mono" style="font-size: 0.66rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(dtShort || a.original_filename)} · ${a.qualified ? '★' : ''}${a.score_normalized.toFixed(3)}
            </div>
            <div class="font-mono text-muted" style="font-size: 0.6rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(`${ownerShort}${a.camera_model}`)}
            </div>
            <div style="margin-top: 0.12rem; display: flex; align-items: center; gap: 0.2rem; flex-wrap: wrap;">
              ${momLabel}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  gridEl.querySelectorAll<HTMLInputElement>('.disjoint-tf-asset-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const aid = cb.dataset.assetId || '';
      if (!aid) return;
      if (cb.checked) disjointTimeframeCheckedIds.add(aid);
      else disjointTimeframeCheckedIds.delete(aid);
      renderDisjointTimeframeDevicesUI();
    });
  });

  gridEl.querySelectorAll<HTMLButtonElement>('.btn-tf-card-moment').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const mn = btn.dataset.momentName || '';
      if (mn) void openCandidateMomentPreview(mn);
    });
  });

  gridEl.querySelectorAll<HTMLElement>('.btn-tf-preview-asset').forEach(el => {
    el.addEventListener('click', () => {
      const aid = el.dataset.assetId || '';
      if (!aid) return;
      openCleanupPreviewModal(aid, {
        assetIds: previewIds,
        groupLabel: titleEl.textContent || 'Timeframe Devices',
        hideMarkRemoved: true,
        selectedIds: disjointTimeframeCheckedIds,
        onSelectionChange: () => renderDisjointTimeframeDevicesUI()
      });
    });
  });
}

function addCheckedTimeframeDeviceAssetsToConsolidation(): void {
  if (!disjointTimeframeData) return;
  const chosenAssets = (disjointTimeframeData.assets || []).filter(
    a => !a.in_source && disjointTimeframeCheckedIds.has(a.asset_id)
  );
  if (!chosenAssets.length) return;

  const keyLabel = `📱 Timeframe (${disjointTimeframeData.window_label.split(' (')[0]})`;
  const existing = combinedExtraMoments.get(keyLabel);
  const nextSet = new Set<string>(existing ? Array.from(existing.assetIds) : []);
  chosenAssets.forEach(a => nextSet.add(a.asset_id));

  combinedExtraMoments.set(keyLabel, {
    momentName: keyLabel,
    assetIds: nextSet,
    totalAssets: nextSet.size,
    tags: [],
    isTimeframeDeviceSelection: true
  });

  renderResolveDisjointCombineTray();
  renderPropagateTagsPreview();
  updateSingleAssetWarningVisibility();
  updateResolveDisjointTargetPreview();
}

