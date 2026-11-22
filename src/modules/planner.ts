// ==========================================================================
// Planner Mode Overview: [B] Batch Management | [M] Moments Organizer
// ==========================================================================

import type {
  AppleMonthSelectionDetailResponse,
  BatchDeviceSummary,
  CreateMomentResponse,
  DisjointDetailAsset,
  DisjointDetailResponse,
  DisjointNameSuggestion,
  MemoriesFolderItem,
  MemoriesFoldersResponse,
  ModeMDedupApplyResponse,
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
  TagLookupResponse
} from '../types/api.ts';
import { candidateAssetMeta, escapeHtml, formatBytes, formatDuration } from '../utils/formatters.ts';
import { openCleanupPreviewModal } from './cleanup.ts';

let plannerOverviewData: PlannerOverviewResponse | null = null;
type PlannerModeTarget = 'b' | 'm' | 'all';
const activePlannerFetchByMode: Partial<Record<PlannerModeTarget, Promise<void>>> = {};
const pendingPlannerRefreshByMode: Partial<Record<PlannerModeTarget, boolean>> = {};
let activePlannerModeView: 'b' | 'm' | 'c' = 'b';
let modeBLoaded = false;
let modeMLoaded = false;
let foldersLoaded = false;
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
let resolveDisjointExplicitAssetIds: string[] = [];
let resolveDisjointAssets: DisjointDetailAsset[] = [];
const resolveDisjointSelectedIds = new Set<string>();
let isSubmittingResolveDisjoint = false;
let resolveDisjointCompleted = false;
let combinedExtraMoments = new Map<string, { momentName: string; assetIds: Set<string>; totalAssets: number; tags: MomentTagItem[] }>();
const candidateTagsCache = new Map<string, { tags: MomentTagItem[]; lastSession: MomentTagSessionSummary | null }>();
let previewedCandidateMomentName = '';
let previewedCandidateAssets: DisjointDetailAsset[] = [];
const previewedCandidateSelectedIds = new Set<string>();
let nearbyMomentCandidatesList: Array<{ moment_name: string; qualified_count: number; rel_label: string; is_suggested: boolean }> = [];
let displayedCandidateMomentsList: Array<{ moment_name: string; qualified_count: number; total_count?: number; rel_label: string; is_suggested?: boolean }> = [];
let momentSearchTimer: number | null = null;
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

type ClustersSyncLockMode = 'idle' | 'running' | 'awaiting';
let clustersSyncLockMode: ClustersSyncLockMode = 'idle';
let clustersSyncLockMessage = '';
let clustersLastUpdatedTime = '';
let latestBgSyncStateInfo: {
  isRunning: boolean;
  syncState: string;
  latestRefreshUtc: string;
} = { isRunning: false, syncState: 'UNKNOWN', latestRefreshUtc: '' };

function formatClusterDbSyncShort(utcStr: string): string {
  const s = (utcStr || '').trim();
  if (!s || s === '—') return '';
  const m = s.match(/(\d{2}:\d{2})(?::\d{2})?/);
  return m ? `DB ${m[1]} UTC` : `DB ${s.slice(0, 16)}`;
}

function renderClustersSyncUI(): void {
  const sectionEl = document.getElementById('mode-m-unassigned-section');
  const bannerEl = document.getElementById('mode-m-clusters-sync-banner');
  const bannerTextEl = document.getElementById('mode-m-clusters-sync-banner-text');
  const badgeEl = document.getElementById('mode-m-clusters-updated-badge');

  const isLocked = clustersSyncLockMode !== 'idle';
  sectionEl?.classList.toggle('clusters-awaiting-sync', isLocked);
  if (bannerEl) {
    bannerEl.style.display = isLocked ? 'flex' : 'none';
  }
  if (bannerTextEl && isLocked) {
    if (clustersSyncLockMode === 'running') {
      bannerTextEl.textContent =
        clustersSyncLockMessage || 'Running Apple Photos update — cluster list paused until sync completes…';
    } else if (latestBgSyncStateInfo.syncState === 'REFRESHING') {
      bannerTextEl.textContent =
        'Background Apple Photos DB sync running — refreshing threshold stats & reordering clusters…';
    } else {
      bannerTextEl.textContent =
        clustersSyncLockMessage ||
        'Awaiting background Apple Photos DB sync to refresh threshold stats & reorder clusters…';
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
  renderClustersSyncUI();
}

function finishApplePhotosActionSyncLock(awaitingMessage: string): void {
  if (latestBgSyncStateInfo.isRunning && latestBgSyncStateInfo.syncState !== 'SOURCE_OFFLINE') {
    setClustersSyncLock('awaiting', awaitingMessage);
  } else {
    setClustersSyncLock('idle');
  }
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
    const completedNow =
      Boolean(bg.syncJustCompleted) ||
      (Boolean(prevLatest) && Boolean(bg.latestRefreshUtc) && bg.latestRefreshUtc !== prevLatest);
    if (completedNow) {
      setClustersSyncLock('idle');
      void refreshModeMFull();
      return;
    }
    if (!latestBgSyncStateInfo.isRunning || latestBgSyncStateInfo.syncState === 'SOURCE_OFFLINE') {
      setClustersSyncLock('idle');
      return;
    }
  }
  renderClustersSyncUI();
}

function applyPlannerModeView(view: 'b' | 'm' | 'c'): void {
  activePlannerModeView = view;

  document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.modeView === view);
  });

  const grid = document.getElementById('planner-modes-grid');
  const cardB = document.getElementById('planner-mode-b-card');
  const cardM = document.getElementById('planner-mode-m-card');
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
    if (cardC) cardC.style.display = 'none';
    if (cardPub) cardPub.style.display = 'block';
    if (cardFolders) cardFolders.style.display = 'block';
    if (!modeMLoaded) {
      void fetchPlannerOverview(false, 'm');
    }
    if (!foldersLoaded) {
      void fetchMemoriesFolders();
    }
  } else if (view === 'c') {
    closeIntakeDedupModal();
    closeCreateMomentModal();
    closePublishMomentModal();
    closeResolveDisjointModal();
    if (grid) grid.style.display = 'none';
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

  // Mode view tabs ([B] | [M] | [C])
  document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = (tab.dataset.modeView as 'b' | 'm' | 'c') || 'b';
      applyPlannerModeView(view);
    });
  });

  // Default to [B] Batch Management focused branch view
  applyPlannerModeView('b');

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
    } else if (activePlannerModeView === 'b') {
      void fetchPlannerOverview(true, 'b');
    }
  });

  document.getElementById('btn-refresh-unassigned-clusters')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh-unassigned-clusters') as HTMLButtonElement | null;
    setClustersSyncLock('idle');
    void refreshModeMFull(btn);
  });

  document.getElementById('btn-unlock-refresh-clusters-sync')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-unlock-refresh-clusters-sync') as HTMLButtonElement | null;
    setClustersSyncLock('idle');
    void refreshModeMFull(btn);
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
    const allSelected = publishMomentAssets.every(a => publishSelectedAssetIds.has(a.asset_id));
    if (allSelected) {
      publishSelectedAssetIds.clear();
    } else {
      publishMomentAssets.forEach(a => publishSelectedAssetIds.add(a.asset_id));
    }
    renderPublishMomentAssets();
  });
  document.getElementById('btn-publish-open-folder')?.addEventListener('click', () => {
    if (!publishMomentName) return;
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
    openResolveActionConfirmDialog('merge_new');
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
    const btnQueueReady = document.getElementById('btn-ms-detail-queue-ready');
    const btnOverride = document.getElementById('btn-ms-detail-override');

    if (badgeEl) {
      badgeEl.className = `badge badge-xs font-mono ${
        ms.ready ? 'badge-green' : ms.exists ? 'badge-amber' : 'badge-red'
      }`;
      badgeEl.textContent = ms.ready
        ? `✓ Ready (${ms.asset_count})`
        : ms.exists
        ? `⚠️ Empty (0 assets)`
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

  // Load initial Mode [B] Batch Management overview only (Mode [M] & Intake Dedup load when [M] is opened)
  void fetchPlannerOverview(false, 'b');
}

const queuedPlannerFetchByMode: Partial<Record<PlannerModeTarget, Promise<void>>> = {};

export async function fetchPlannerOverview(force = false, targetMode?: PlannerModeTarget): Promise<void> {
  if (!targetMode && activePlannerModeView === 'c') {
    if (force) {
      modeBLoaded = false;
      modeMLoaded = false;
      foldersLoaded = false;
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
        .catch(() => {})
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
    const cls = ms.ready ? 'badge-green' : ms.exists ? 'badge-amber' : sourceStep === 'step3' ? 'badge-red' : 'badge-amber';
    const label = ms.ready
      ? `✓ ${ms.matched_album_name || ms.expected_album} (${ms.asset_count})`
      : ms.exists
      ? `⚠️ ${ms.matched_album_name || ms.expected_album} (0)`
      : `⚠️ Missing (${ms.expected_album})`;
    const title = ms.ready
      ? `Click for details: Apple Photos Month Selection / ${ms.matched_album_name || ms.expected_album} (${ms.asset_count} assets)`
      : ms.exists
      ? `Click for details: Album exists under Apple Photos Month Selection with 0 assets`
      : `Click for details: Missing album '${ms.expected_album}' under Apple Photos Month Selection`;
    return `<button type="button" class="badge badge-xs ${cls} font-mono" style="cursor: pointer;" onclick="window.openMonthSelectionDialog('${escapeHtml(
      item.month
    )}', { sourceStep: '${sourceStep}' })" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
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
  if (b500Badge) b500Badge.textContent = `${c500.length} batch${c500.length === 1 ? '' : 'es'}`;

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
            ? `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'remove_queue')" title="Remove from planned_execution queue">✓ Queued (Remove)</button>`
            : `<button class="btn btn-xs btn-purple" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'queue')" title="Add ${escapeHtml(item.month)} to planned_execution queue">➕ Queue (500➜650)</button>`;

          return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-purple font-mono">${escapeHtml(item.status_code)}</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td style="text-align: right;">${favBadge}</td>
            <td>${msBadge}</td>
            <td class="font-mono" style="font-size: 0.7rem; color: var(--text-secondary);">500 ➜ 550 (Pull Favs) ➜ 600 (Rank) ➜ 650</td>
            <td style="text-align: right; white-space: nowrap;">${actionBtn}</td>
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
      detailEl.textContent = `👉 Run Option [1] to sync new qualified assets to ToBeCurated in Apple Photos, or publish top ready candidate: ${
        recs[0] ? `${recs[0].moment_name} (${recs[0].action})` : '—'
      }`;
    }
  } else if (!th.aligned) {
    if (headlineEl) {
      headlineEl.textContent = `Step 1: Resolve Threshold Mismatch (${(th.current || 0).toFixed(4)} > ${(th.historical_min || 0).toFixed(4)}) before Step 2 Publishing`;
    }
    if (detailEl) {
      const unassignedCount = modeM.unassigned_total_assets || 0;
      const clusterCount = modeM.unassigned_total_clusters || (modeM.unassigned_clusters || []).length;
      detailEl.textContent = `👉 ToBeCurated sync is complete. Assign Moments to top unassigned assets (${unassignedCount} across ${clusterCount} clusters) to align threshold${
        recs[0] ? `; next ready candidate once aligned: ${recs[0].moment_name}` : ''
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
  const recTbody = document.getElementById('mode-m-recs-tbody');
  if (recBadge) recBadge.textContent = `${recs.length} actionable`;

  if (recTbody) {
    if (!recs.length) {
      recTbody.innerHTML =
        '<tr><td colspan="6" class="text-center text-muted">No actionable publishing recommendations currently ready.</td></tr>';
    } else {
      recTbody.innerHTML = recs
        .map(r => {
          const isRepub = r.action.startsWith('Republish');
          const actionBtnClass = isRepub ? 'btn-purple' : 'btn-green';
          const actionBtn = `<button type="button" class="btn btn-xs ${actionBtnClass} btn-open-publish-moment" data-moment-name="${escapeHtml(r.moment_name)}" title="Open Publish / Republish workflow for '${escapeHtml(r.moment_name)}'">${escapeHtml(r.action)}</button>`;
          const tagBadgeHtml = renderMomentTaggedBadge(r.is_tagged, r.paradigm_confirmed, r.tag_summary);
          return `
          <tr data-moment-name="${escapeHtml(r.moment_name)}">
            <td><strong class="text-primary">${escapeHtml(r.moment_name)}</strong>${tagBadgeHtml}</td>
            <td style="text-align: right;" class="font-mono text-amber">${r.avg_score.toFixed(4)}</td>
            <td style="text-align: right;" class="font-mono">${r.files}</td>
            <td style="text-align: right;" class="font-mono">${r.published}</td>
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
                ${
                  isCompleteGroup
                    ? `<span class="badge badge-xs badge-green font-mono" style="font-size: 0.62rem;" title="Complete — all ${count} assets in this group are flagged as duplicate copies (no unique assets remain)">✅ Complete (0 unique)</span>`
                    : `<span class="badge badge-xs badge-green font-mono" style="font-size: 0.62rem;" title="Unique files identified after Media-Intake dedup (${count} total - ${cluster.duplicate_copy_count || 0} dup flagged)">✓ ${uniqueCount} unique</span>`
                }
                <span class="badge badge-xs ${sizeBadgeClass} font-mono">${count} asset${count === 1 ? '' : 's'}</span>
                <span class="badge badge-xs ${typeBadgeClass}" style="font-size: 0.64rem;">${escapeHtml(cluster.group_type)}</span>
                ${
                  cluster.rule_label
                    ? `<span class="badge badge-xs badge-outline font-mono" style="font-size: 0.61rem;" title="${escapeHtml(cluster.rule_reason || cluster.rule_label)}">⚖️ ${escapeHtml(cluster.rule_label)}</span>`
                    : ''
                }
                ${
                  (cluster.duplicate_copy_count || 0) > 0
                    ? `<span class="badge badge-xs badge-amber font-mono" style="font-size: 0.62rem;" title="Potential duplicate copy flagged — review via Intake Dedup & Ignore">♻️ ${cluster.duplicate_copy_count} Dup Flagged</span>`
                    : ''
                }
              </div>
              <div class="unassigned-cluster-meta-row font-mono">
                <span>Score: <strong class="text-amber">${escapeHtml(cluster.score_span)}</strong></span>
                <span>•</span>
                <span>Month(s): <strong>${escapeHtml(cluster.months)}</strong></span>
                ${
                  cluster.rule_reason
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
            ${
              cluster.rule_id === 'custom_split'
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
            ${
              count > 1
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
            ${
              cluster.rule_id === 'misdated_duplicate_triage' || isCompleteGroup
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
      openCleanupPreviewModal(
        aid,
        groupAssetIds && groupAssetIds.length > 0
          ? {
              assetIds: groupAssetIds,
              groupLabel: folder,
              hideMarkRemoved: true,
              onRemoveFromGroup:
                groupAssetIds.length > 1 && folder
                  ? async (removingAid: string) => {
                      const selSet = clusterAssetSelection.get(folder);
                      if (selSet) selSet.delete(removingAid);
                      return await updateGroupingRules({
                        split_asset_ids: [removingAid],
                        split_target_group: '__INDIVIDUAL__',
                        split_source_group: folder
                      });
                    }
                  : undefined
            }
          : { assetIds: [aid], hideMarkRemoved: true }
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
  setClustersSyncLock('running', `🍎 Moving ${assetIds.length} asset(s) to Apple Photos Ignore album — awaiting sync…`);
  try {
    const res = await fetch('/api/media/mode-m/dedup-apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_ids: assetIds })
    });
    const data: ModeMDedupApplyResponse = await res.json();
    if (!res.ok || !data.ok) {
      setClustersSyncLock('idle');
      window.alert(`Failed moving assets to Ignore album: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    applyOptimisticClusterRemoval(new Set(assetIds));
    await refreshModeMFull();
    finishApplePhotosActionSyncLock(
      `⏳ Moved ${assetIds.length} asset(s) to Ignore — awaiting background Photos DB sync to refresh threshold & reorder clusters…`
    );
  } catch (err) {
    setClustersSyncLock('idle');
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
          openCleanupPreviewModal(aid, { assetIds: pairIds, groupLabel: 'Duplicate vs Keeper', hideMarkRemoved: true });
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
  setClustersSyncLock('running', `🍎 Adding ${assetIds.length} duplicate(s) to Apple Photos Ignore album — awaiting sync…`);
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
      setClustersSyncLock('idle');
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
          and updated <strong>${data.db_updated}</strong> DB record(s)${escapeHtml(errNote)}. Refreshing Mode [M]...
        </span>
      `;
    }

    // Remove applied duplicates from local list immediately and refresh Mode [M]
    if (dedupPreviewData?.duplicates) {
      dedupPreviewData.duplicates = dedupPreviewData.duplicates.filter(d => !selectedDedupAssetIds.has(d.duplicate_asset_id));
    }
    selectedDedupAssetIds.clear();

    await refreshModeMFull();
    finishApplePhotosActionSyncLock(
      `⏳ Added ${assetIds.length} duplicate(s) to Ignore — awaiting background Photos DB sync to refresh threshold & reorder clusters…`
    );

    if (dedupPreviewData) {
      renderDedupModalResults(dedupPreviewData);
      if (statusEl) {
        statusEl.innerHTML = `
          <span class="text-green">
            ✅ Added <strong>${data.photos_added}</strong> asset(s) to <code>${escapeHtml(data.ignore_album_path || 'Ignore')}</code>
            (synced <strong>${data.db_updated}</strong> in DB). Mode [M] refreshed.
          </span>
        `;
      }
    }
  } catch (err: any) {
    console.error('Error applying intake dedup ignore:', err);
    setClustersSyncLock('idle');
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
        const cls =
          item.memory_stage === 'M500'
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
  setClustersSyncLock('running', `🍎 Updating Apple Photos (${momentName}) — cluster section paused until sync…`);
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
      setClustersSyncLock('idle');
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

    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `
        <div class="spinner-sm"></div>
        <span>
          AppleScript <strong>${escapeHtml(data.action || 'created')}</strong>
          <code>${escapeHtml(data.full_path || momentName)}</code> (+${data.photos_added ?? 0} in Photos) — refreshing Moments Organizer list...
        </span>
      `;
    }

    await refreshModeMFull();
    finishApplePhotosActionSyncLock(
      `⏳ Apple Photos updated (${momentName}) — awaiting background Photos DB sync to refresh threshold & reorder clusters…`
    );

    if (statusEl) {
      const ignSummary =
        (data.ignored_photos_added ?? 0) > 0 || (data.ignored_db_updated ?? 0) > 0
          ? `; moved ${data.ignored_photos_added ?? 0} duplicate(s) to Ignore`
          : '';
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `
        <span class="text-green">
          ✅ AppleScript <strong>${escapeHtml(data.action || 'created')}</strong>
          <code>${escapeHtml(data.full_path || momentName)}</code>
          — added <strong>${data.photos_added ?? 0}</strong> asset(s) in Photos
          (synced ${data.db_inserted_assets ?? 0} album links in DB${escapeHtml(ignSummary)}). Moments Organizer list refreshed.
        </span>
      `;
    }
    succeeded = true;
  } catch (err: any) {
    console.error('Error creating Moment via AppleScript:', err);
    setClustersSyncLock('idle');
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

function updatePublishMomentSelectionSummary(): void {
  const pill = document.getElementById('publish-moment-selected-pill');
  const breakdownEl = document.getElementById('publish-moment-breakdown');
  const selected = publishMomentAssets.filter(a => publishSelectedAssetIds.has(a.asset_id));
  const photosCnt = selected.filter(a => a.media_type !== 'video').length;
  const videosCnt = selected.filter(a => a.media_type === 'video').length;
  if (pill) {
    pill.textContent = `${selected.length} / ${publishMomentAssets.length} selected`;
  }
  if (breakdownEl) {
    breakdownEl.textContent = selected.length
      ? `📷 ${photosCnt} Photo(s) → Shutterfly · 🎥 ${videosCnt} Video(s) → YouTube`
      : 'Select at least 1 asset to record';
  }
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

  listEl.innerHTML = publishMomentAssets
    .map((a, idx) => {
      const checked = publishSelectedAssetIds.has(a.asset_id);
      const typeBadge =
        a.media_type === 'video'
          ? '<span class="badge badge-xs badge-purple font-mono">VIDEO</span>'
          : '<span class="badge badge-xs badge-green font-mono">PHOTO</span>';
      const localNote =
        a.local_files && a.local_files.length > 0
          ? `<span class="badge badge-xs badge-outline font-mono" title="Exported on LaCie: ${escapeHtml(a.local_files.join(', '))}">✓ LaCie</span>`
          : '<span class="badge badge-xs badge-amber font-mono" title="Not yet exported in LaCie Curated folder">Not exported</span>';
      return `
        <div class="publish-asset-row">
          <label class="publish-asset-left" style="cursor: pointer;">
            <input type="checkbox" class="publish-asset-checkbox" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} />
            <img class="publish-asset-thumb" src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.filename)}" loading="lazy" />
            <div style="min-width: 0; flex: 1;">
              <div class="font-mono" style="font-size: 0.75rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                #${idx + 1} · ${escapeHtml(a.filename || a.asset_id)}
              </div>
              <div style="display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap;">
                ${typeBadge}
                <span class="font-mono text-amber" style="font-size: 0.69rem;">Score ${a.score.toFixed(4)}</span>
                ${localNote}
              </div>
            </div>
          </label>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll<HTMLInputElement>('.publish-asset-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const aid = cb.dataset.assetId || '';
      if (!aid) return;
      if (cb.checked) publishSelectedAssetIds.add(aid);
      else publishSelectedAssetIds.delete(aid);
      updatePublishMomentSelectionSummary();
    });
  });

  updatePublishMomentSelectionSummary();
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
          Remaining Unpublished: <strong>${unpubCount}</strong>${syncNote}
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
    publishMomentAssets.forEach(a => publishSelectedAssetIds.add(a.asset_id));
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
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>Recording publication of ${assetIds.length} asset(s) for <code>${escapeHtml(publishMomentName)}</code>...</span>`;
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

    await Promise.all([fetchPlannerOverview(true, 'm'), fetchMemoriesFolders()]);
    if (plannerRefreshMediaMetricsCb) plannerRefreshMediaMetricsCb();

    if (statusEl) {
      const syncInfo = data.pub_rec_sync;
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
          (Stage: <strong>${escapeHtml(data.new_stage || 'M450')}</strong> · Total Published: ${data.total_published ?? 0}/${data.curated_total ?? 0}${escapeHtml(syncSuffix)}).
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
    btnLegacy.style.display = completed ? 'none' : '';
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

function updateResolveDisjointSelectionSummary(): void {
  const pill = document.getElementById('resolve-disjoint-selected-pill');
  if (pill) {
    const selectedCount = resolveDisjointAssets.filter(a => resolveDisjointSelectedIds.has(a.asset_id)).length;
    pill.textContent = `${selectedCount} / ${resolveDisjointAssets.length} selected`;
  }
  renderResolveDisjointCombineTray();
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
  listEl.innerHTML = resolveDisjointAssets
    .map((a, idx) => {
      const checked = resolveDisjointSelectedIds.has(a.asset_id);
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
      return `
        <div class="publish-asset-row${a.is_duplicate_copy ? ' is-dup-copy' : ''}" ${dupTip ? `title="${escapeHtml(dupTip)}"` : ''}>
          <div class="publish-asset-left">
            <input type="checkbox" class="resolve-disjoint-asset-cb" data-asset-id="${escapeHtml(a.asset_id)}" ${checked ? 'checked' : ''} style="cursor: pointer;" />
            <button type="button" class="disjoint-row-thumb-btn btn-preview-disjoint-modal-asset" data-asset-id="${escapeHtml(a.asset_id)}" title="Open full preview" style="width: 40px; height: 40px;">
              <img src="/api/media/cleanup/thumbnail/${encodeURIComponent(a.asset_id)}" alt="${escapeHtml(a.original_filename)}" loading="lazy" />
            </button>
            <div style="min-width: 0; flex: 1;">
              <div class="font-mono" style="font-size: 0.75rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                #${idx + 1} · ${escapeHtml(a.original_filename || a.asset_id)}
              </div>
              <div style="display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap;">
                ${qualBadge}
                ${typeBadge}
                ${dupBadge}
                <span class="font-mono text-amber" style="font-size: 0.69rem;">Score ${a.score_normalized.toFixed(4)}</span>
                <span class="font-mono text-muted" style="font-size: 0.68rem;">${escapeHtml(dateStr)}${escapeHtml(sizeStr)}</span>
              </div>
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
          hideMarkRemoved: true
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
  const loc = picked('location').join(', ');
  const ppl = picked('people').join(', ');
  const when = picked('when').join(' / ');

  const parts: string[] = [];
  if (act) parts.push(act);
  if (loc) parts.push(act ? `at ${loc}` : loc);
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
    });
  });
  updateSingleAssetWarningVisibility();
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
            hideMarkRemoved: true
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
    menuEl.innerHTML = `<div class="tag-category-dropdown-empty">${
      catalog.length
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
    menuEl.classList.add('open');
  };

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

function updateResolveDisjointTargetPreview(): void {
  const previewEl = document.getElementById('resolve-disjoint-target-path-preview');
  const statusNoteEl = document.getElementById('resolve-disjoint-target-status-note');
  const parentSel = document.getElementById('resolve-disjoint-parent-select') as HTMLSelectElement | null;
  const targetInp = document.getElementById('resolve-disjoint-target-input') as HTMLInputElement | null;
  const btnSubmit = document.getElementById('btn-submit-resolve-disjoint') as HTMLButtonElement | null;
  const parentName = parentSel?.value || 'Moments';
  const targetName = (targetInp?.value || '').trim() || '—';
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
    previewEl.innerHTML = `${escapeHtml(`Media Organizer on LaCie / ${parentName} / `)}<span class="target-path-leaf">${escapeHtml(targetName)}</span>${statusNote}`;
  }

  if (btnSubmit && !resolveDisjointCompleted) {
    if (existingInfo.exists) {
      btnSubmit.textContent = '➕ Add Missing Assets & Tag Existing';
      btnSubmit.title = 'Destination folder already exists — copy only missing assets, update DB tags, and delete disjoint source(s) if checked';
    } else {
      btnSubmit.textContent = '✨ Merge & Tag into New Moment';
      btnSubmit.title = 'Recommended: Consolidate source(s) + apply DB tags into a New Paradigm formatted Moment';
    }
  }
}

export async function openResolveDisjointModal(
  momentName: string,
  suggestedTarget = '',
  options?: { assetIds?: string[]; isUnassignedCluster?: boolean; isHistoricalMoment?: boolean }
): Promise<void> {
  const isUnassigned = Boolean(options?.isUnassignedCluster);
  const isHistorical = Boolean(options?.isHistoricalMoment);
  const explicitIds = (options?.assetIds || []).map(s => (s || '').trim()).filter(Boolean);
  resolveDisjointMomentName = momentName;
  resolveDisjointIsUnassignedCluster = isUnassigned;
  resolveDisjointIsHistoricalMoment = isHistorical;
  resolveDisjointExplicitAssetIds = explicitIds;
  resolveDisjointAssets = [];
  resolveDisjointSelectedIds.clear();
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
    titleEl.textContent = isUnassigned
      ? `🏷️ Tag & Consolidate Unassigned Group · ${momentName}`
      : isHistorical
        ? `🏷️ Tag Historical Moment (All Assets) · ${momentName}`
        : `🏷️ Tag & Consolidate Moment · ${momentName}`;
  }
  if (badgeEl) badgeEl.textContent = 'loading...';
  if (summaryEl) {
    summaryEl.innerHTML = isUnassigned
      ? '<div class="spinner-sm"></div><span>Inspecting unassigned group assets, duplicates, DB tags, and nearby Moment candidates...</span>'
      : '<div class="spinner-sm"></div><span>Inspecting Moment assets, DB tags, and consolidation candidates...</span>';
  }
  if (albumsBarEl) albumsBarEl.style.display = 'none';
  if (listEl) listEl.innerHTML = '';
  if (chipsEl) chipsEl.innerHTML = '<span class="text-muted font-mono" style="font-size: 0.69rem;">Searching nearby Moments...</span>';
  if (targetInp) targetInp.value = '';
  if (parentSel) parentSel.value = 'Moments';
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
        media_type: a.media_type,
        duration_sec: a.duration || 0,
        width: a.width || 0,
        height: a.height || 0,
        fps: 0,
        is_duplicate_copy: Boolean(a.is_duplicate_copy)
      });
    });
    if (resolveDisjointSelectedIds.size === 0) {
      const nonDups = assets.filter(a => !a.is_duplicate_copy);
      (nonDups.length ? nonDups : assets).forEach(a => resolveDisjointSelectedIds.add(a.asset_id));
    }

    const qualCount = assets.filter(a => a.qualified).length;
    const belowCount = assets.length - qualCount;
    const histMin = data.historical_min ?? 0.5315;
    if (badgeEl) {
      badgeEl.textContent = `${qualCount} qualified · ${assets.length} total`;
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
  } catch (err: any) {
    if (summaryEl) {
      summaryEl.innerHTML = `<span class="text-red">❌ Error loading disjoint details: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  }
}

type ResolveDisjointAction = 'merge_new' | 'merge_legacy' | 'skip_publishing' | 'ignore';
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
    totalAssets: chosenIds.size || previewedCandidateAssets.length,
    tags: clonedTags
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
  const targetMoment = (targetInp?.value || '').trim();
  const resolvedParent = parentSel?.value || 'Moments';
  const assetIds = Array.from(resolveDisjointSelectedIds);
  const delSrc = Boolean(delSrcCb?.checked ?? true);

  let autoIncludedName = '';
  const previewPanelEl = document.getElementById('resolve-disjoint-candidate-preview-panel');
  if (
    !skipAutoInclude &&
    isMerge &&
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

  if (isMerge && !targetMoment) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Enter or compose a Target Moment Album Name before merging.</span>';
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
  if (isMerge) {
    const existingInfo = getExistingTargetAlbumInfo(resolvedParent, targetMoment);
    const fullTargetPath = `Media Organizer on LaCie / ${resolvedParent} / ${targetMoment}`;
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

    const allSourceNamesLc = new Set(
      [
        ...(resolveDisjointIsUnassignedCluster ? [] : [resolveDisjointMomentName]),
        ...extraEntries.map(e => e.momentName)
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
      ...extraEntries.map(e => e.momentName)
    ].filter(s => s.toLowerCase() !== targetMoment.toLowerCase());

    if (delSrc) {
      if (priorAlbumsToRemove.length) {
        const albumBadges = priorAlbumsToRemove
          .map(al => `<code>${escapeHtml(`Media Organizer on LaCie / ${al.parent_folder_name} / ${al.album_name}`)}</code>`)
          .join(', ');
        stepsHtml.push(
          `<strong>Remove prior Moment albums (once all non-duplicate assets are copied):</strong> Delete pre-merge album(s) ${albumBadges} in Apple Photos &amp; local DB even if skipped duplicate copies remain inside them.`
        );
      } else if (deletableSources.length) {
        stepsHtml.push(
          `<strong>Remove prior Moment albums (once all non-duplicate assets are copied):</strong> Delete obsolete source album(s) ${deletableSources.map(s => `<code>${escapeHtml(s)}</code>`).join(', ')} in Apple Photos (across Moments/ToBeCurated/Curated) &amp; clean DB rows, even if skipped duplicate copies remain.`
        );
      } else if (resolveDisjointIsUnassignedCluster) {
        stepsHtml.push(
          `<strong>Remove group from Unassigned Clusters:</strong> Group <code>${escapeHtml(resolveDisjointMomentName)}</code> has no prior Photos album to delete; selected assets will be assigned to <code>${escapeHtml(targetMoment)}</code> and cleared from unassigned staging.`
        );
      } else {
        stepsHtml.push(
          `<strong>Preserve destination &amp; clean duplicate album copies:</strong> Keep target album <code>${escapeHtml(targetMoment)}</code> and remove any prior album copies in other folders with a different album ID (if any exist).`
        );
      }
    } else {
      stepsHtml.push('<strong>Keep prior albums:</strong> Leave all pre-merge source albums intact in Apple Photos.');
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
      `<strong>Move to SkipPublishing:</strong> Add ${assetIds.length} selected asset(s) to <code>Media Organizer on LaCie / Moments / SkipPublishing</code> in Apple Photos (skipping any already there).`
    );
    stepsHtml.push('<strong>Sync DB &amp; folders:</strong> Record asset links in <code>media_organizer_album_assets</code> and remove any local recommendation export folder if present.');
    noteEl.innerHTML = 'ℹ️ Assets stay in your library but are excluded from Publishing Recommendations.';
    proceedBtn.className = 'btn btn-purple';
    proceedBtn.textContent = '⏭️ Confirm SkipPublishing';
  } else {
    titleEl.textContent = '🗑️ Confirm Ignore Selected Action';
    subEl.innerHTML = `Source Moment: <code>${escapeHtml(resolveDisjointMomentName)}</code>`;
    stepsHtml.push(
      `<strong>Ignore assets:</strong> Run dedup ignore pipeline (<code>--apply --asset-ids</code>) for ${assetIds.length} selected asset(s).`
    );
    if (delSrc) {
      stepsHtml.push(`<strong>Delete source album rows:</strong> Clean up obsolete album rows for <code>${escapeHtml(resolveDisjointMomentName)}</code> in <code>media_organizer.db</code>.`);
    }
    noteEl.innerHTML = '⚠️ Selected assets will be marked ignored and excluded from the Media Organizer.';
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
  const targetMoment = (targetInp?.value || '').trim();
  if (isMerge && !targetMoment) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Enter or compose a Target Moment Album Name before merging.</span>';
    }
    return;
  }

  const resolvedParent = parentSel?.value || 'Moments';
  const assetIds = Array.from(resolveDisjointSelectedIds);
  if ((action === 'skip_publishing' || action === 'ignore') && !assetIds.length) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = '<span class="text-red">❌ Select at least 1 asset first.</span>';
    }
    return;
  }

  const additionalMoments = isMerge ? Array.from(combinedExtraMoments.keys()) : [];
  const additionalAssetIds: string[] = [];
  if (isMerge) {
    combinedExtraMoments.forEach(entry => {
      entry.assetIds.forEach(aid => additionalAssetIds.push(aid));
    });
  }

  const toCleanTags = (tags: MomentTagItem[]) =>
    tags.map(t => ({ category: t.category, tag_value: t.tag_value, include_in_name: t.include_in_name }));

  const momentTagGroups: Array<{ moment_name: string; asset_ids: string[]; tags: Array<{ category: string; tag_value: string; include_in_name: boolean }> }> = [];
  if (action === 'merge_new' && savePerSource) {
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
    action === 'merge_new' && shareDisjoint ? toCleanTags(sourceTagState.tags) : [];

  isSubmittingResolveDisjoint = true;
  if (btnSubmit) btnSubmit.disabled = true;
  if (btnLegacy) btnLegacy.disabled = true;
  if (btnSkip) btnSkip.disabled = true;
  if (btnIgnore) btnIgnore.disabled = true;

  const actionLabel =
    action === 'merge_new'
      ? `Consolidating ${1 + additionalMoments.length} Moment(s) & tagging into "${resolvedParent}/${targetMoment}"...`
      : action === 'merge_legacy'
        ? `Merging into existing target "${resolvedParent}/${targetMoment}" via AppleScript...`
        : action === 'skip_publishing'
          ? 'Moving selected asset(s) to Moments/SkipPublishing...'
          : 'Excluding selected asset(s) via ignore pipeline...';

  if (statusEl) {
    statusEl.style.display = 'flex';
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>${escapeHtml(actionLabel)}</span>`;
  }

  let succeeded = false;
  try {
    const res = await fetch('/api/media/memories/resolve-disjoint', {
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
        apply_tags: applyTags,
        moment_tag_groups: momentTagGroups,
        delete_source_albums: Boolean(delSrcCb?.checked ?? true),
        is_unassigned_cluster: resolveDisjointIsUnassignedCluster
      })
    });
    const rawText = await res.text();
    let data: ResolveDisjointResponse;
    try {
      data = rawText ? JSON.parse(rawText) : { ok: false };
    } catch {
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ Server returned HTTP ${res.status}: ${escapeHtml(rawText.slice(0, 180) || 'Invalid JSON response')}</span>`;
      }
      return;
    }
    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    if (resolveDisjointIsUnassignedCluster) {
      applyOptimisticClusterRemoval(new Set([...assetIds, ...additionalAssetIds]));
      clusterAssetSelection.delete(resolveDisjointMomentName);
    }
    await Promise.all([fetchPlannerOverview(true, 'm'), fetchMemoriesFolders()]);
    if (plannerRefreshMediaMetricsCb) plannerRefreshMediaMetricsCb();

    if (statusEl) {
      statusEl.style.display = 'flex';
      if (isMerge) {
        const tagNote = data.tags_applied
          ? ` · ${data.tags_applied} DB tag(s) applied (session #${data.tag_session_id ?? '—'})`
          : '';
        const paradigmNote = data.moment_paradigm_confirmed
          ? ` · ✓ Moment folder tagged (New Tagging Paradigm · ${data.moment_tags_union?.length ?? 0} union tag(s))`
          : '';
        statusEl.innerHTML = `<span class="text-green">✅ Consolidated ${(data.combined_moments || [resolveDisjointMomentName]).length} Moment(s) into <code>${escapeHtml(data.target_moment || targetMoment)}</code> (${data.photos_added ?? 0} asset(s) added, ${data.albums_deleted ?? 0} source album(s) deleted, ${data.db_updated ?? 0} DB row(s) updated${escapeHtml(tagNote)}${escapeHtml(paradigmNote)}).</span>`;
      } else if (action === 'skip_publishing') {
        statusEl.innerHTML = `<span class="text-green">✅ Moved ${data.photos_added ?? assetIds.length} asset(s) to <code>Moments/SkipPublishing</code> (updated ${data.db_updated ?? 0} DB row(s)).</span>`;
      } else {
        statusEl.innerHTML = `<span class="text-green">✅ Ignored &amp; excluded ${assetIds.length} asset(s) (${data.db_updated ?? 0} DB row(s) cleaned).</span>`;
      }
    }
    succeeded = true;
  } catch (err: any) {
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isSubmittingResolveDisjoint = false;
    setResolveDisjointCompletedState(succeeded);
  }
}

