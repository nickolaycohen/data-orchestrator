// ==========================================================================
// Planner Mode Overview: [B] Batch Management | [M] Memory & Publishing
// ==========================================================================

import type { BatchDeviceSummary, PlannerModeB, PlannerModeM, PlannerOverviewResponse } from '../types/api.ts';
import { candidateAssetMeta, escapeHtml, formatDuration } from '../utils/formatters.ts';
import { openCleanupPreviewModal } from './cleanup.ts';

let plannerOverviewData: PlannerOverviewResponse | null = null;
let isFetchingPlannerOverview = false;
let unassignedSortMode: 'size' | 'score' | 'date' = 'size';
let unassignedSearchQuery = '';
const expandedUnassignedFolders = new Set<string>();
let hasInitializedUnassignedExpansion = false;

export function setupPlannerOverview(onRefreshExecutor?: () => void): void {
  // Mode view tabs (All | [B] | [M] | [C])
  document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.planner-mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const view = tab.dataset.modeView || 'all';
      const grid = document.getElementById('planner-modes-grid');
      const cardB = document.getElementById('planner-mode-b-card');
      const cardM = document.getElementById('planner-mode-m-card');
      const cardC = document.getElementById('media-cleanup-card');
      const cardPub = document.getElementById('published-memories-card');
      const cardTrack1 = document.getElementById('track-1-reference-card');

      if (view === 'all') {
        if (grid) {
          grid.style.display = 'grid';
          grid.classList.remove('single-col');
        }
        if (cardB) cardB.style.display = 'flex';
        if (cardM) cardM.style.display = 'flex';
        if (cardC) cardC.style.display = 'block';
        if (cardPub) cardPub.style.display = 'block';
        if (cardTrack1) cardTrack1.style.display = 'block';
      } else if (view === 'b') {
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
          cardC.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });

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

export async function fetchPlannerOverview(): Promise<void> {
  if (isFetchingPlannerOverview) return;
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
  } else if (recs.length > 0) {
    if (headlineEl) {
      headlineEl.textContent = `Threshold Aligned (${(th.current || 0.5315).toFixed(4)}) · Top Next Candidate: "${recs[0].moment_name}" (${recs[0].action})`;
    }
    if (detailEl) {
      detailEl.textContent = `👉 ${recs.length} actionable moments ready for Shutterfly/YouTube publishing (up to 9 assets per batch) and ${disjoint.length} disjoint moments ready for merge.`;
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
    if (unassignedSummaryBadge) {
      unassignedSummaryBadge.style.display = 'inline-flex';
      unassignedSummaryBadge.textContent = `${totalUnassignedAssets} unassigned · ${totalUnassignedClusters} folders`;
    }
    if (unassignedSection) {
      unassignedSection.style.display = 'block';
    }
    if (unassignedTitleEl) {
      unassignedTitleEl.textContent = `⚠️ Unassigned High-Rank Assets Above Threshold > ${(th.historical_min || 0.5315).toFixed(4)} (${totalUnassignedAssets} Asset(s) Grouped into ${totalUnassignedClusters} Proposed Moment Folder(s))`;
    }

    if (!hasInitializedUnassignedExpansion) {
      hasInitializedUnassignedExpansion = true;
      unassignedClusters.slice(0, 3).forEach(c => expandedUnassignedFolders.add(c.folder));
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

  let filtered = rawClusters;
  if (unassignedSearchQuery) {
    filtered = rawClusters.filter(c => {
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
    listEl.innerHTML = `<div class="text-center text-muted" style="padding: 1rem;">No clusters match "${escapeHtml(unassignedSearchQuery)}".</div>`;
    return;
  }

  listEl.innerHTML = sorted
    .map((cluster, idx) => {
      const assets = cluster.assets || [];
      const count = assets.length || cluster.asset_count || 0;
      const isExpanded = expandedUnassignedFolders.has(cluster.folder);

      let typeBadgeClass = 'badge-amber';
      if ((cluster.group_type || '').includes('Proposed New')) {
        typeBadgeClass = 'badge-purple';
      } else if ((cluster.group_type || '').includes('Existing')) {
        typeBadgeClass = 'badge-green';
      }

      const sizeBadgeClass = count >= 10 ? 'badge-purple' : count >= 3 ? 'badge-amber' : 'badge-outline';

      const previewAssets = assets.filter(a => a.asset_id).slice(0, 5);
      const extraCount = Math.max(0, assets.length - previewAssets.length);
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
          .join('') + (extraCount > 0 ? `<span class="unassigned-more-thumbs">+${extraCount}</span>` : '');

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

          return `
        <tr>
          <td class="text-muted font-mono" style="width: 28px;">${aIdx + 1}</td>
          <td style="width: 56px;">${thumbCell}</td>
          <td>
            <div class="font-mono" style="font-weight: 600; color: var(--text-primary); font-size: 0.75rem;">${escapeHtml(a.original_filename)}</div>
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
                <span class="badge badge-xs ${sizeBadgeClass} font-mono">${count} asset${count === 1 ? '' : 's'}</span>
                <span class="badge badge-xs ${typeBadgeClass}" style="font-size: 0.64rem;">${escapeHtml(cluster.group_type)}</span>
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
      if (aid) openCleanupPreviewModal(aid);
    });
  });
}

