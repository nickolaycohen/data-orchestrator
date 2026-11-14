// ==========================================================================
// Planner Mode Overview: [B] Batch Management | [M] Memory & Publishing
// ==========================================================================

import type {
  BatchDeviceSummary,
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
let isFetchingPlannerOverview = false;
let pendingPlannerRefresh = false;
let unassignedSortMode: 'size' | 'score' | 'date' = 'size';
let unassignedSearchQuery = '';
const expandedUnassignedFolders = new Set<string>();
const clusterPreviewAssetIds = new Map<string, string[]>();
let dedupPreviewData: ModeMDedupPreviewResponse | null = null;
const selectedDedupAssetIds = new Set<string>();
let isRunningDedupPreview = false;
let isApplyingDedupIgnore = false;
let plannerRefreshExecutorCb: (() => void) | undefined;

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

  // Load initial planner overview data
  fetchPlannerOverview();
}

export async function fetchPlannerOverview(force = false): Promise<void> {
  if (isFetchingPlannerOverview) {
    if (force) pendingPlannerRefresh = true;
    return;
  }
  isFetchingPlannerOverview = true;

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
    isFetchingPlannerOverview = false;
    if (pendingPlannerRefresh) {
      pendingPlannerRefresh = false;
      void fetchPlannerOverview();
    }
  }
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
                <span class="unassigned-cluster-folder">📁 ${escapeHtml(cluster.folder)}</span>
                <span class="badge badge-xs badge-green font-mono" style="font-size: 0.62rem;" title="Unique files identified after Media-Intake dedup (${count} total - ${cluster.duplicate_copy_count || 0} dup flagged)">✓ ${Math.max(0, count - (cluster.duplicate_copy_count || 0))} unique</span>
                <span class="badge badge-xs ${sizeBadgeClass} font-mono">${count} asset${count === 1 ? '' : 's'}</span>
                <span class="badge badge-xs ${typeBadgeClass}" style="font-size: 0.64rem;">${escapeHtml(cluster.group_type)}</span>
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
                <span>•</span>
                <span>Log #[${cluster.orig_rank}]</span>
              </div>
            </div>
          </div>
          <div class="unassigned-cluster-right">
            <div class="unassigned-thumb-strip">
              ${thumbStripHtml}
            </div>
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
      if ((e.target as HTMLElement).closest('[data-preview-asset-id]')) return;
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

