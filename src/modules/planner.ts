// ==========================================================================
// Planner Mode Overview: [B] Batch Management | [M] Moments Organizer
// ==========================================================================

import type {
  BatchDeviceSummary,
  CreateMomentResponse,
  MemoriesFolderItem,
  MemoriesFoldersResponse,
  ModeMDedupApplyResponse,
  ModeMDedupDuplicate,
  ModeMDedupPreviewResponse,
  PlannerModeB,
  PlannerModeM,
  PlannerOverviewResponse
} from '../types/api.ts';
import { candidateAssetMeta, escapeHtml, formatBytes, formatDuration } from '../utils/formatters.ts';
import { openCleanupPreviewModal } from './cleanup.ts';

let plannerOverviewData: PlannerOverviewResponse | null = null;
let activePlannerFetchPromise: Promise<void> | null = null;
let pendingPlannerRefresh = false;
let queuedPlannerFetchPromise: Promise<void> | null = null;
let unassignedSortMode: 'size' | 'score' | 'date' = 'size';
let unassignedSearchQuery = '';
const expandedUnassignedFolders = new Set<string>();
const clusterPreviewAssetIds = new Map<string, string[]>();
let dedupPreviewData: ModeMDedupPreviewResponse | null = null;
const selectedDedupAssetIds = new Set<string>();
let isRunningDedupPreview = false;
let isApplyingDedupIgnore = false;
let plannerRefreshExecutorCb: (() => void) | undefined;

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
let createMomentCheckTimer: number | null = null;
let groupingRulesPanelCollapsed = false;
let isUpdatingGroupingRules = false;

function applyPlannerModeView(view: 'b' | 'm' | 'c'): void {
  document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.modeView === view);
  });

  const grid = document.getElementById('planner-modes-grid');
  const cardB = document.getElementById('planner-mode-b-card');
  const cardM = document.getElementById('planner-mode-m-card');
  const cardC = document.getElementById('media-cleanup-card');
  const cardPub = document.getElementById('published-memories-card');
  const cardTrack1 = document.getElementById('track-1-reference-card');

  if (view === 'b') {
    if (grid) {
      grid.style.display = 'grid';
      grid.classList.add('single-col');
    }
    if (cardB) cardB.style.display = 'flex';
    if (cardM) cardM.style.display = 'none';
    if (cardC) cardC.style.display = 'none';
    if (cardPub) cardPub.style.display = 'none';
    if (cardTrack1) cardTrack1.style.display = 'block';
  } else if (view === 'm') {
    if (grid) {
      grid.style.display = 'grid';
      grid.classList.add('single-col');
    }
    if (cardB) cardB.style.display = 'none';
    if (cardM) cardM.style.display = 'flex';
    if (cardC) cardC.style.display = 'none';
    if (cardPub) cardPub.style.display = 'block';
    if (cardTrack1) cardTrack1.style.display = 'none';
  } else if (view === 'c') {
    if (grid) grid.style.display = 'none';
    if (cardPub) cardPub.style.display = 'none';
    if (cardTrack1) cardTrack1.style.display = 'none';
    if (cardC) {
      cardC.style.display = 'block';
    }
  }
}

export function setupPlannerOverview(onRefreshExecutor?: () => void): void {
  plannerRefreshExecutorCb = onRefreshExecutor;

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
    fetchPlannerOverview();
    void fetchMemoriesFolders();
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

  window.runPlannerBatchAction = async function (month: string, action: string): Promise<void> {
    try {
      const res = await fetch('/api/media/planner/batch-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, action })
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Action failed: ${data.error || 'Unknown error'}`);
        return;
      }
      await fetchPlannerOverview();
      if (onRefreshExecutor) onRefreshExecutor();
    } catch (err: any) {
      console.error('Error running planner batch action:', err);
      alert(`Network error: ${err.message || 'Unknown error'}`);
    }
  };

  // Load initial planner overview data & synced Memories/Moments folders
  fetchPlannerOverview();
  void fetchMemoriesFolders();
}

export async function fetchPlannerOverview(force = false): Promise<void> {
  if (activePlannerFetchPromise) {
    if (!force) {
      return activePlannerFetchPromise;
    }
    pendingPlannerRefresh = true;
    if (!queuedPlannerFetchPromise) {
      queuedPlannerFetchPromise = activePlannerFetchPromise
        .catch(() => {})
        .then(() => {
          queuedPlannerFetchPromise = null;
          pendingPlannerRefresh = false;
          return fetchPlannerOverview(false);
        });
    }
    return queuedPlannerFetchPromise;
  }

  activePlannerFetchPromise = (async () => {
    try {
      const res = await fetch('/api/media/planner-overview');
      const data: PlannerOverviewResponse = await res.json();

      if (!data.connected) return;
      plannerOverviewData = data;

      const updatedEl = document.getElementById('planner-overview-updated');
      if (updatedEl) {
        updatedEl.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
      }

      renderModeBOverview((data.mode_b || {}) as PlannerModeB);
      renderModeMOverview((data.mode_m || {}) as PlannerModeM);
    } catch (err) {
      console.error('Error fetching planner overview:', err);
    } finally {
      activePlannerFetchPromise = null;
      if (pendingPlannerRefresh && !queuedPlannerFetchPromise) {
        pendingPlannerRefresh = false;
        void fetchPlannerOverview();
      }
    }
  })();

  return activePlannerFetchPromise;
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

  if (primary) {
    if (headlineEl) headlineEl.textContent = primary.headline;
    if (detailEl) detailEl.textContent = `👉 ${primary.detail}`;
    if (secEl) secEl.textContent = primary.secondary || '';
  } else {
    if (headlineEl) headlineEl.textContent = 'All eligible batch transitions are queued or complete';
    if (detailEl) detailEl.textContent = 'No pending manual or pipeline transitions detected.';
    if (secEl) secEl.textContent = '';
  }

  // 1. Manual 400 -> 500 Table
  const b400Badge = document.getElementById('mode-b-400-badge');
  const b400Tbody = document.getElementById('mode-b-400-tbody');
  if (b400Badge) b400Badge.textContent = `${c400.length} batch${c400.length === 1 ? '' : 'es'}`;

  if (b400Tbody) {
    if (!c400.length) {
      b400Tbody.innerHTML =
        '<tr><td colspan="6" class="text-center text-muted">No batches currently awaiting manual Google Photos curation (400).</td></tr>';
    } else {
      b400Tbody.innerHTML = c400
        .map(item => {
          const favBadge =
            (item.fav_assets || 0) > 0
              ? `<span class="badge badge-xs badge-green font-mono">⭐ ${item.fav_assets}</span>`
              : `<span class="text-muted font-mono">0</span>`;
          const elapsedStr =
            item.elapsed_days !== null && item.elapsed_days !== undefined ? ` (${item.elapsed_days}d ago)` : '';
          return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-amber font-mono">400</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td style="text-align: right;">${favBadge}</td>
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
        '<tr><td colspan="6" class="text-center text-muted">No batches at stage 500 waiting for favorites pull & ranking.</td></tr>';
    } else {
      b500Tbody.innerHTML = c500
        .map(item => {
          const favBadge =
            (item.fav_assets || 0) > 0
              ? `<span class="badge badge-xs badge-green font-mono">⭐ ${item.fav_assets}</span>`
              : item.is_bypassed
              ? `<span class="badge badge-xs badge-outline">Bypassed</span>`
              : `<span class="text-muted font-mono">0</span>`;
          const actionBtn = item.in_queue
            ? `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'remove_queue')" title="Remove from planned_execution queue">✓ Queued (Remove)</button>`
            : `<button class="btn btn-xs btn-purple" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'queue')" title="Add ${escapeHtml(item.month)} to planned_execution queue">➕ Queue (500➜650)</button>`;

          return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-purple font-mono">${escapeHtml(item.status_code)}</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td style="text-align: right;">${favBadge}</td>
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
    } else {
      thPill.className = 'badge badge-xs badge-amber font-mono';
      thPill.textContent = `⚠️ Threshold ${(th.current || 0).toFixed(4)} > ${(th.historical_min || 0).toFixed(4)}`;
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

  // Step 1: Sync Box
  const syncBox = document.getElementById('mode-m-sync-box');
  if (syncBox) {
    const thText = th.aligned
      ? `<span class="text-green">✅ <strong>Curation Threshold Aligned:</strong> Current <code>${(th.current || 0.5315).toFixed(4)}</code> matches target <code>${(th.historical_min || 0.5315).toFixed(4)}</code>.</span>`
      : `<span class="text-amber">⚠️ <strong>Threshold Mismatch:</strong> Current <code>${(th.current || 0).toFixed(4)}</code> exceeds target <code>${(th.historical_min || 0).toFixed(4)}</code> — assign Moments to top unassigned assets first.</span>`;

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
          const actionBadge = isRepub
            ? `<span class="badge badge-xs badge-purple">${escapeHtml(r.action)}</span>`
            : `<span class="badge badge-xs badge-green">${escapeHtml(r.action)}</span>`;
          return `
          <tr>
            <td><strong class="text-primary">${escapeHtml(r.moment_name)}</strong></td>
            <td style="text-align: right;" class="font-mono text-amber">${r.avg_score.toFixed(4)}</td>
            <td style="text-align: right;" class="font-mono">${r.files}</td>
            <td style="text-align: right;" class="font-mono">${r.published}</td>
            <td>${actionBadge}</td>
            <td class="font-mono text-muted" style="font-size: 0.69rem; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(r.details)}">
              ${escapeHtml(r.details)}
            </td>
          </tr>
        `;
        })
        .join('');
    }
  }

  // Step 3: Disjoint Moments Table
  const disjBadge = document.getElementById('mode-m-disjoint-badge');
  const disjTbody = document.getElementById('mode-m-disjoint-tbody');
  if (disjBadge) disjBadge.textContent = `${disjoint.length} disjoint`;

  if (disjTbody) {
    if (!disjoint.length) {
      disjTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No disjoint moments (&lt;2 assets) detected.</td></tr>';
    } else {
      disjTbody.innerHTML = disjoint
        .map(
          d => `
        <tr>
          <td><strong class="text-primary">${escapeHtml(d.moment_name)}</strong></td>
          <td style="text-align: right;" class="font-mono">${d.avg_score.toFixed(4)}</td>
          <td style="text-align: right;" class="font-mono">${d.files}</td>
          <td style="font-size: 0.72rem; color: var(--accent-amber);">${escapeHtml(d.details)}</td>
        </tr>
      `
        )
        .join('');
    }
  }
}

function renderUnassignedClustersList(): void {
  const listEl = document.getElementById('mode-m-unassigned-list');
  if (!listEl) return;

  const rawClusters = plannerOverviewData?.mode_m?.unassigned_clusters || [];

  if (!rawClusters.length) {
    listEl.innerHTML = '<div class="text-center text-muted" style="padding: 1rem;">No unassigned high-rank asset clusters found.</div>';
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

  let filtered = normalizedClusters;
  if (unassignedSearchQuery) {
    filtered = normalizedClusters.filter(c => {
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

  const sorted = [...filtered].sort((a, b) => {
    const cntA = (a.assets || []).length || a.asset_count || 0;
    const cntB = (b.assets || []).length || b.asset_count || 0;
    if (unassignedSortMode === 'size') {
      if (cntB !== cntA) return cntB - cntA;
      if (b.max_score !== a.max_score) return b.max_score - a.max_score;
      return (a.folder || '').localeCompare(b.folder || '');
    } else if (unassignedSortMode === 'score') {
      if (b.max_score !== a.max_score) return b.max_score - a.max_score;
      if (cntB !== cntA) return cntB - cntA;
      return (a.folder || '').localeCompare(b.folder || '');
    } else {
      return (a.folder || '').localeCompare(b.folder || '');
    }
  });

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
      const isExpanded = expandedUnassignedFolders.has(cluster.folder);
      const previewableAssets = assets.filter(a => a.asset_id);
      clusterPreviewAssetIds.set(
        cluster.folder,
        previewableAssets.map(a => a.asset_id)
      );

      let typeBadgeClass = 'badge-amber';
      if ((cluster.group_type || '').includes('Proposed New')) {
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

      const rowsHtml = assets
        .map((a, aIdx) => {
          const hasUuid = Boolean(a.asset_id);
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

          return `
        <tr>
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

      return `
      <div class="unassigned-cluster-card ${isExpanded ? 'expanded' : ''}" data-cluster-folder="${escapeHtml(cluster.folder)}">
        <div class="unassigned-cluster-header" data-toggle-cluster="${escapeHtml(cluster.folder)}">
          <div class="unassigned-cluster-left">
            <span class="unassigned-cluster-chevron">▶</span>
            <span class="unassigned-cluster-rank font-mono">#${idx + 1}</span>
            <div class="unassigned-cluster-info">
              <div class="unassigned-cluster-title-row">
                <span class="unassigned-cluster-folder">${count === 1 && (cluster.rule_id === 'ungrouped' || cluster.rule_id === 'refused_cluster') ? '🖼️' : '📁'} ${escapeHtml(cluster.folder)}</span>
                <span class="badge badge-xs badge-green font-mono" style="font-size: 0.62rem;" title="Unique files identified after Media-Intake dedup (${count} total - ${cluster.duplicate_copy_count || 0} dup flagged)">✓ ${Math.max(0, count - (cluster.duplicate_copy_count || 0))} unique</span>
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
            <button
              class="btn btn-xs btn-purple btn-create-moment-from-cluster"
              data-cluster-folder="${escapeHtml(cluster.folder)}"
              title="Create (or populate) this Moment album in Apple Photos via AppleScript"
              style="white-space: nowrap; flex-shrink: 0;"
            >
              ✨ Create Moment
            </button>
          </div>
        </div>
        <div class="unassigned-cluster-body">
          <table class="cleanup-table planner-compact-table">
            <thead>
              <tr>
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
      if ((e.target as HTMLElement).closest('[data-preview-asset-id], .btn-create-moment-from-cluster, .btn-refuse-cluster-group, .btn-restore-cluster-group')) return;
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
      const uniqueIds = (cluster.assets || []).filter(a => a.asset_id && !a.is_duplicate_copy).map(a => a.asset_id);
      const isUncategorized = /uncategorized/i.test(cluster.folder);
      const prefillName = isUncategorized ? '' : cluster.folder;
      openCreateMomentModal({
        prefillName,
        sourceClusterFolder: cluster.folder,
        uniqueAssetIds: uniqueIds,
        allAssetIds: allIds,
        duplicateCount: cluster.duplicate_copy_count || 0
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
        groupAssetIds && groupAssetIds.length > 0 ? { assetIds: groupAssetIds, groupLabel: folder } : undefined
      );
    });
  });
}

async function openIntakeDedupModal(): Promise<void> {
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
          openCleanupPreviewModal(aid, { assetIds: pairIds, groupLabel: 'Duplicate vs Keeper' });
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

    await fetchPlannerOverview(true);
    if (plannerRefreshExecutorCb) plannerRefreshExecutorCb();

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

      return `
        <tr>
          <td>
            <div style="font-weight: 600; color: var(--text-primary); font-size: 0.76rem;">
              ${icon} ${escapeHtml(item.album_name)}
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
            <button
              class="btn btn-xs btn-outline btn-use-memories-folder"
              data-folder-name="${escapeHtml(prefillName)}"
              data-parent-folder="${escapeHtml(targetParent)}"
              title="Open AppleScript Create/Update Moment with this folder/album pre-selected"
            >
              ${item.is_folder ? '+ New Inside' : '✨ Select'}
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

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
  if (ignoreDupsCb) ignoreDupsCb.checked = false;
  if (emptyOnlyCb) emptyOnlyCb.checked = false;
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.innerHTML = '';
  }

  updateCreateMomentTargetPath();
  updateCreateMomentAssetsUI();
  modal.classList.add('open');
  void checkExistingMemoriesMatch((nameInput?.value || '').trim());
  window.setTimeout(() => nameInput?.focus(), 40);
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
  if (isSubmittingCreateMoment) return;
  const nameInput = document.getElementById('create-moment-name-input') as HTMLInputElement | null;
  const parentSelect = document.getElementById('create-moment-parent-select') as HTMLSelectElement | null;
  const allowExistingCb = document.getElementById('create-moment-allow-existing') as HTMLInputElement | null;
  const statusEl = document.getElementById('create-moment-status');
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
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Running AppleScript...';
  }
  if (statusEl) {
    statusEl.style.display = 'flex';
    const ignNote = ignoreAssetIds.length ? ` and moving ${ignoreAssetIds.length} duplicate(s) to Ignore` : '';
    statusEl.innerHTML = `<div class="spinner-sm"></div><span>Creating Moment <code>${escapeHtml(momentName)}</code> in Apple Photos via AppleScript${assetIds.length ? ` and adding ${assetIds.length} asset(s)` : ''}${escapeHtml(ignNote)}...</span>`;
  }

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
      if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.innerHTML = `<span class="text-red">❌ ${escapeHtml(data.error || `HTTP ${res.status}`)}</span>`;
      }
      return;
    }

    // Immediately update UI cluster list optimistically while authoritative DB refresh runs
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

    await Promise.all([fetchMemoriesFolders(), fetchPlannerOverview(true)]);
    if (plannerRefreshExecutorCb) plannerRefreshExecutorCb();

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
  } catch (err: any) {
    console.error('Error creating Moment via AppleScript:', err);
    if (statusEl) {
      statusEl.style.display = 'flex';
      statusEl.innerHTML = `<span class="text-red">❌ Network error: ${escapeHtml(err?.message || 'Unknown error')}</span>`;
    }
  } finally {
    isSubmittingCreateMoment = false;
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.textContent = '🍎 Create Moment via AppleScript';
    }
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
  const activeCount = rules.filter(r => r.enabled).length;
  const refusedRuleCount = rules.length - activeCount;

  if (summaryBadge) {
    const parts = [`${activeCount}/${rules.length} active`];
    if (refusedRuleCount > 0) parts.push(`${refusedRuleCount} rule refused`);
    if (refusedClusters.length > 0) parts.push(`${refusedClusters.length} group split`);
    summaryBadge.textContent = parts.join(' · ');
  }

  const hasNonDefault =
    rules.some(r => {
      const def = r.id === 'time_gps_session' ? false : true;
      return r.enabled !== def;
    }) || refusedClusters.length > 0;
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
    if (!refusedClusters.length) {
      refusedBar.style.display = 'none';
      refusedBar.innerHTML = '';
    } else {
      refusedBar.style.display = 'flex';
      refusedBar.innerHTML =
        `<span class="text-muted">Refused Cluster Groups (split to individual):</span>` +
        refusedClusters
          .map(
            ck =>
              `<button type="button" class="grouping-refused-chip" data-restore-refused="${escapeHtml(ck)}" title="Click to restore grouping for ${escapeHtml(ck)}">🚫 ${escapeHtml(ck)} ✕</button>`
          )
          .join('');
      refusedBar.querySelectorAll<HTMLElement>('[data-restore-refused]').forEach(chip => {
        chip.addEventListener('click', () => {
          const ck = chip.dataset.restoreRefused;
          if (ck) void updateGroupingRules({ restore_cluster: ck });
        });
      });
    }
  }
}

async function updateGroupingRules(payload: {
  rules?: Record<string, boolean>;
  refuse_cluster?: string;
  restore_cluster?: string;
  reset_defaults?: boolean;
}): Promise<void> {
  if (isUpdatingGroupingRules) return;
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
      return;
    }
    await fetchPlannerOverview(true);
  } catch (err: any) {
    console.error('Error updating grouping rules:', err);
    alert(`Network error updating grouping rules: ${err?.message || 'Unknown error'}`);
  } finally {
    isUpdatingGroupingRules = false;
  }
}

