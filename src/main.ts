// ==========================================================================
// Data Orchestrator Dashboard Frontend (TypeScript Entrypoint)
// ==========================================================================

import type { SystemStatusResponse } from './types/api.ts';
import { attachPathSanitizer, cleanPath } from './utils/formatters.ts';
import {
  closeCleanupPreviewModal,
  fetchCleanupDevices,
  hasCleanupDevicesLoaded,
  setupMediaCleanup
} from './modules/cleanup.ts';
import { fetchPlannerOverview, setupPlannerOverview } from './modules/planner.ts';
import {
  fetchMergeLog,
  setupUtilities,
  startMergeLogPolling,
  stopMergeLogPolling
} from './modules/utilities.ts';

let activeExecutionId: string | null = null;
let activeWebSocket: WebSocket | null = null;
let mediaMonitorInterval: ReturnType<typeof setInterval> | null = null;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupConsoleControls();
  setupModals();
  setupRefresh();
  setupUtilities();
  setupMediaCleanup();
  setupPlannerOverview(fetchExecutorMonitor);

  // Initial data loading
  fetchAllMetrics();
});

// Tab Navigation
function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLElement>('.nav-tab');
  const panels = document.querySelectorAll<HTMLElement>('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPanel = document.getElementById(`tab-${tab.dataset.tab}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      if (tab.dataset.tab === 'media') {
        fetchExecutorMonitor();
        if (!mediaMonitorInterval) {
          mediaMonitorInterval = setInterval(fetchExecutorMonitor, 4000);
        }
        fetchPlannerOverview();
        if (!hasCleanupDevicesLoaded()) {
          fetchCleanupDevices();
        }
      } else {
        if (mediaMonitorInterval) {
          clearInterval(mediaMonitorInterval);
          mediaMonitorInterval = null;
        }
      }

      if (tab.dataset.tab === 'reports') {
        fetchReportsList();
      }

      if (tab.dataset.tab === 'utilities') {
        fetchMergeLog();
        startMergeLogPolling();
      } else {
        stopMergeLogPolling();
      }
    });
  });
}

// Refresh all metrics across pillars
function setupRefresh(): void {
  document.getElementById('btn-refresh-all')?.addEventListener('click', () => {
    fetchAllMetrics();
  });
  document.getElementById('btn-refresh-monitor')?.addEventListener('click', () => {
    fetchExecutorMonitor();
  });
  document.getElementById('btn-toggle-bg-service')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const action = btn.dataset.action || 'start';
    btn.disabled = true;
    btn.textContent = action === 'stop' ? 'Stopping...' : 'Starting...';
    try {
      await fetch('/api/media/bg-service/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      await fetchExecutorMonitor();
    } catch (err) {
      console.error('BG Service control error:', err);
    } finally {
      btn.disabled = false;
    }
  });
}

async function fetchAllMetrics(): Promise<void> {
  try {
    await Promise.all([
      fetchSystemStatus(),
      fetchMediaMetrics(),
      fetchExecutorMonitor(),
      fetchStorageMetrics(),
      fetchIDriveMetrics(),
      fetchGmailMetrics()
    ]);
  } catch (err) {
    console.error('Error fetching metrics:', err);
  }
}

// 1. System Status & Mounts
async function fetchSystemStatus(): Promise<void> {
  try {
    const res = await fetch('/api/system/status');
    const data: SystemStatusResponse = await res.json();

    // Volume Mounts
    const mountsContainer = document.getElementById('mounts-list-container');
    const mountedCount = data.mounts.filter(m => m.mounted).length;
    const mountedSummary = document.getElementById('mounted-summary');
    if (mountedSummary) {
      mountedSummary.innerHTML = `<span class="badge-icon">💾</span> <span class="badge-text">${mountedCount} Volumes Online</span>`;
    }

    if (mountsContainer) {
      mountsContainer.innerHTML = data.mounts
        .map(m => {
          if (!m.mounted) {
            return `
            <div class="mount-item" style="opacity: 0.6;">
              <div class="mount-header">
                <span class="mount-name">⚠️ ${m.name}</span>
                <span class="badge badge-sm badge-outline">Unmounted</span>
              </div>
              <span class="mount-path">${m.path}</span>
            </div>
          `;
          }

          const pct = m.pct_used || 0;
          let fillClass = 'fill-green';
          if (pct > 85) fillClass = 'fill-red';
          else if (pct > 65) fillClass = 'fill-amber';
          else if (pct > 30) fillClass = 'fill-blue';

          return `
          <div class="mount-item">
            <div class="mount-header">
              <span class="mount-name">💾 ${m.name}</span>
              <span class="mount-numbers">${m.used_gb} GB / ${m.total_gb} GB (${pct}%)</span>
            </div>
            <span class="mount-path">${m.path}</span>
            <div class="gauge-bar-bg">
              <div class="gauge-bar-fill ${fillClass}" style="width: ${pct}%;"></div>
            </div>
          </div>
        `;
        })
        .join('');
    }

    // Submodules List
    const submodulesContainer = document.getElementById('submodules-list-container');
    if (submodulesContainer) {
      submodulesContainer.innerHTML = Object.entries(data.submodules)
        .map(([name, info]) => {
          let badgeHtml = '';
          if (info.is_git) {
            badgeHtml = `<span class="badge badge-sm badge-purple">${info.branch} · ${info.commit}</span>`;
          } else if (info.exists) {
            badgeHtml = `<span class="badge badge-sm badge-amber">Local (Git Pending)</span>`;
          } else {
            badgeHtml = `<span class="badge badge-sm badge-outline">Not Found</span>`;
          }

          return `
          <div class="submodule-item">
            <div class="submodule-info">
              <strong>${name}</strong>
              <span>${info.path || 'Configured via submodule'}</span>
            </div>
            <div>${badgeHtml}</div>
          </div>
        `;
        })
        .join('');
    }

    // Alerts
    const alertsContainer = document.getElementById('alerts-container');
    if (alertsContainer && data.alerts) {
      if (data.alerts.length === 0) {
        alertsContainer.innerHTML = '';
      } else {
        alertsContainer.innerHTML = data.alerts
          .map(
            a => `
          <div class="mount-item mb-3" style="border-left: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.08);">
            <strong style="color: #fcd34d;">${a.title}</strong>
            <p style="font-size: 0.8rem; color: #cbd5e1; margin-top: 0.2rem;">${a.message}</p>
          </div>
        `
          )
          .join('');
      }
    }
  } catch (err) {
    console.error('System status error:', err);
  }
}

// 2. Media Organizer Metrics
async function fetchMediaMetrics(): Promise<void> {
  try {
    const res = await fetch('/api/media/metrics');
    const data = await res.json();

    if (!data.connected) return;

    const stats = data.stats || {};
    const statAssets = document.getElementById('stat-media-assets');
    const statMoments = document.getElementById('stat-media-moments');
    const statBatches = document.getElementById('stat-media-batches');
    const statTriage = document.getElementById('stat-media-triage-saved');
    const topoMedia = document.getElementById('topo-media-stat');

    if (statAssets) statAssets.textContent = (stats.total_assets || 0).toLocaleString();
    if (statMoments) statMoments.textContent = (stats.curated_moments || 0).toLocaleString();
    if (statBatches) statBatches.textContent = (stats.month_batches || 0).toLocaleString();
    if (statTriage) statTriage.textContent = `${stats.triage_saved_gb || 0} GB`;
    if (topoMedia) {
      topoMedia.textContent = `${(stats.total_assets || 0).toLocaleString()} assets · ${stats.curated_moments || 0} moments`;
    }

    // Render per-phase breakdown below each top stat tile
    const pb = stats.phase_breakdown || null;
    const ms = stats.moment_stages || null;
    const totalAssets = Math.max(1, stats.total_assets || 0);
    const totalBatches = Math.max(1, stats.month_batches || 0);
    const totalMoments = Math.max(1, stats.curated_moments || 0);

    if (pb) {
      const a650 = pb.assets_650 || 0;
      const a500 = pb.assets_500_600 || 0;
      const a400 = pb.assets_400 || 0;
      const a100 = pb.assets_100_399 || 0;
      const a000 = pb.assets_000 || 0;

      const p650 = ((a650 / totalAssets) * 100).toFixed(1);
      const pInFlight = (((a500 + a400 + a100) / totalAssets) * 100).toFixed(1);
      const p000 = ((a000 / totalAssets) * 100).toFixed(1);

      const assetsSubEl = document.getElementById('stat-media-assets-sub');
      const assetsBarEl = document.getElementById('stat-media-assets-bar');
      const assetsPhasesEl = document.getElementById('stat-media-assets-phases');

      const scoredPct = (((pb.assets_scored || stats.total_assets || 0) / totalAssets) * 100).toFixed(0);
      if (assetsSubEl) {
        assetsSubEl.textContent = `In master catalog · ${scoredPct}% AI scored`;
      }
      if (assetsBarEl) {
        assetsBarEl.innerHTML = `
          <div class="stat-phase-seg" style="width:${p650}%; background:#34d399;" title="650 Finalized: ${a650.toLocaleString()} (${p650}%)"></div>
          <div class="stat-phase-seg" style="width:${pInFlight}%; background:#fbbf24;" title="In Progress (100–600): ${(a500 + a400 + a100).toLocaleString()} (${pInFlight}%)"></div>
          <div class="stat-phase-seg" style="width:${p000}%; background:#64748b;" title="000 Pending: ${a000.toLocaleString()} (${p000}%)"></div>
        `;
      }
      if (assetsPhasesEl) {
        const inFlightRows: string[] = [];
        if (a500 > 0) {
          inFlightRows.push(`
            <div class="stat-phase-row">
              <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#a78bfa;"></span>500–600 Curated / Ranked</span>
              <span class="stat-phase-val">${a500.toLocaleString()}<span class="stat-phase-pct">(${((a500 / totalAssets) * 100).toFixed(1)}%)</span></span>
            </div>
          `);
        }
        if (a400 > 0 || a500 === 0) {
          inFlightRows.push(`
            <div class="stat-phase-row">
              <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#fbbf24;"></span>400 Uploaded (In Curation)</span>
              <span class="stat-phase-val">${a400.toLocaleString()}<span class="stat-phase-pct">(${((a400 / totalAssets) * 100).toFixed(1)}%)</span></span>
            </div>
          `);
        }
        if (a100 > 0) {
          inFlightRows.push(`
            <div class="stat-phase-row">
              <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#38bdf8;"></span>100–399 Staging / Upload</span>
              <span class="stat-phase-val">${a100.toLocaleString()}<span class="stat-phase-pct">(${((a100 / totalAssets) * 100).toFixed(1)}%)</span></span>
            </div>
          `);
        }

        assetsPhasesEl.innerHTML = `
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#34d399;"></span>650 Finalized (Cloud Retained)</span>
            <span class="stat-phase-val">${a650.toLocaleString()}<span class="stat-phase-pct">(${p650}%)</span></span>
          </div>
          ${inFlightRows.join('')}
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#64748b;"></span>000 Ingested / Pending</span>
            <span class="stat-phase-val">${a000.toLocaleString()}<span class="stat-phase-pct">(${p000}%)</span></span>
          </div>
          <div class="stat-phase-footer">
            <span title="Google or Apple Favorites">★ ${(pb.assets_favorited || 0).toLocaleString()} Favs</span>
            <span>·</span>
            <span title="Assets assigned to Moments">📁 ${(pb.assets_in_moments || 0).toLocaleString()} in Moments</span>
            <span>·</span>
            <span title="Assets published to Shutterfly/YouTube">🚀 ${(pb.assets_published || 0).toLocaleString()} Pub</span>
          </div>
        `;
      }

      // Tile 3: Month Batches phase breakdown
      const b650 = pb.batches_650 || 0;
      const b500 = pb.batches_500_600 || 0;
      const b400 = pb.batches_400 || 0;
      const b100 = pb.batches_100_399 || 0;
      const b000 = pb.batches_000 || 0;
      const bp650 = ((b650 / totalBatches) * 100).toFixed(1);
      const bpInFlight = (((b500 + b400 + b100) / totalBatches) * 100).toFixed(1);
      const bp000 = ((b000 / totalBatches) * 100).toFixed(1);

      const batchesBarEl = document.getElementById('stat-media-batches-bar');
      const batchesPhasesEl = document.getElementById('stat-media-batches-phases');
      if (batchesBarEl) {
        batchesBarEl.innerHTML = `
          <div class="stat-phase-seg" style="width:${bp650}%; background:#34d399;"></div>
          <div class="stat-phase-seg" style="width:${bpInFlight}%; background:#fbbf24;"></div>
          <div class="stat-phase-seg" style="width:${bp000}%; background:#64748b;"></div>
        `;
      }
      if (batchesPhasesEl) {
        batchesPhasesEl.innerHTML = `
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#34d399;"></span>650 Completed Batches</span>
            <span class="stat-phase-val">${b650}<span class="stat-phase-pct">(${bp650}%)</span></span>
          </div>
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#fbbf24;"></span>100–600 In Curation / Active</span>
            <span class="stat-phase-val">${b500 + b400 + b100}<span class="stat-phase-pct">(${bpInFlight}%)</span></span>
          </div>
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#64748b;"></span>000 Queued / Unprocessed</span>
            <span class="stat-phase-val">${b000}<span class="stat-phase-pct">(${bp000}%)</span></span>
          </div>
          <div class="stat-phase-footer">
            <span>Avg ${Math.round(totalAssets / totalBatches).toLocaleString()} assets / batch</span>
          </div>
        `;
      }
    }

    // Tile 2: Curated Moments stage breakdown
    if (ms) {
      const m500 = ms.M500 || 0;
      const m450 = ms.M450 || 0;
      const m400 = ms.M400 || 0;
      const mp500 = ((m500 / totalMoments) * 100).toFixed(1);
      const mp450 = ((m450 / totalMoments) * 100).toFixed(1);
      const mp400 = ((m400 / totalMoments) * 100).toFixed(1);

      const momentsBarEl = document.getElementById('stat-media-moments-bar');
      const momentsPhasesEl = document.getElementById('stat-media-moments-phases');
      if (momentsBarEl) {
        momentsBarEl.innerHTML = `
          <div class="stat-phase-seg" style="width:${mp500}%; background:#34d399;"></div>
          <div class="stat-phase-seg" style="width:${mp450}%; background:#a78bfa;"></div>
          <div class="stat-phase-seg" style="width:${mp400}%; background:#64748b;"></div>
        `;
      }
      if (momentsPhasesEl) {
        const pubSummary = data.published_summary || {};
        momentsPhasesEl.innerHTML = `
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#34d399;"></span>M500 Fully Published</span>
            <span class="stat-phase-val">${m500}<span class="stat-phase-pct">(${mp500}%)</span></span>
          </div>
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#a78bfa;"></span>M450 Curated / Ready</span>
            <span class="stat-phase-val">${m450}<span class="stat-phase-pct">(${mp450}%)</span></span>
          </div>
          <div class="stat-phase-row">
            <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#64748b;"></span>M400 Candidate / Unsynced</span>
            <span class="stat-phase-val">${m400}<span class="stat-phase-pct">(${mp400}%)</span></span>
          </div>
          <div class="stat-phase-footer">
            <span>📷 ${(pubSummary.shutterfly_assets || 0).toLocaleString()} Shutterfly</span>
            <span>·</span>
            <span>🎥 ${(pubSummary.youtube_assets || 0).toLocaleString()} YouTube</span>
          </div>
        `;
      }
    }

    // Tile 4: Triage Duplicate Savings breakdown
    const triageBarEl = document.getElementById('stat-media-triage-bar');
    const triagePhasesEl = document.getElementById('stat-media-triage-phases');
    const scannedCnt = stats.triage_scanned || 0;
    const dupCnt = stats.triage_duplicates || 0;
    const uniqueCnt = Math.max(0, scannedCnt - dupCnt);
    const dupPct = scannedCnt > 0 ? ((dupCnt / scannedCnt) * 100).toFixed(1) : '0.0';
    const uniqPct = scannedCnt > 0 ? ((uniqueCnt / scannedCnt) * 100).toFixed(1) : '100.0';

    if (triageBarEl && scannedCnt > 0) {
      triageBarEl.innerHTML = `
        <div class="stat-phase-seg" style="width:${dupPct}%; background:#fbbf24;"></div>
        <div class="stat-phase-seg" style="width:${uniqPct}%; background:#38bdf8;"></div>
      `;
    }
    if (triagePhasesEl && scannedCnt > 0) {
      triagePhasesEl.innerHTML = `
        <div class="stat-phase-row">
          <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#fbbf24;"></span>Duplicates Skipped</span>
          <span class="stat-phase-val">${dupCnt.toLocaleString()}<span class="stat-phase-pct">(${dupPct}%)</span></span>
        </div>
        <div class="stat-phase-row">
          <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#38bdf8;"></span>Unique Files Retained</span>
          <span class="stat-phase-val">${uniqueCnt.toLocaleString()}<span class="stat-phase-pct">(${uniqPct}%)</span></span>
        </div>
        <div class="stat-phase-row">
          <span class="stat-phase-label"><span class="stat-phase-dot" style="background:#a78bfa;"></span>Total Intake Scanned</span>
          <span class="stat-phase-val">${scannedCnt.toLocaleString()}</span>
        </div>
        <div class="stat-phase-footer">
          <span>🛡️ ${(stats.triage_sessions || 0).toLocaleString()} triage sessions completed</span>
        </div>
      `;
    }

    // Published Moments History (Shutterfly & YouTube)
    if (data.published_moments) {
      publishedMomentsCache = data.published_moments;
      publishedSummaryCache = data.published_summary || {};
      renderPublishedMomentsHistory();
    } else if (data.featured_moments) {
      const momentsContainer = document.getElementById('featured-moments-list');
      if (momentsContainer) {
        momentsContainer.innerHTML = data.featured_moments
          .slice(0, 5)
          .map(
            (m: any) => `
          <div class="moment-card">
            <div>
              <div class="moment-name">${m.moment_name}</div>
              <div style="font-size: 0.75rem; color: #94a3b8;">Stage: ${m.memory_stage || 'Candidate'}</div>
            </div>
            <div class="moment-counts">
              <span class="badge badge-sm badge-green">${m.curated_count || 0} curated</span>
              <span class="badge badge-sm badge-outline">${m.to_be_curated_count || 0} proposed</span>
            </div>
          </div>
        `
          )
          .join('');
      }
    }

    // Pipeline executions table (compact bottom table)
    const executionsTbody = document.getElementById('pipeline-executions-tbody');
    if (executionsTbody && data.recent_executions) {
      executionsTbody.innerHTML = data.recent_executions
        .map(
          (ex: any) => `
        <tr>
          <td style="padding: 0.28rem 0.5rem;"><span style="font-family: var(--font-mono); color: #94a3b8; font-size: 0.72rem;">#${ex.id}</span></td>
          <td style="padding: 0.28rem 0.5rem;"><code style="font-size: 0.7rem;">${ex.session_id || '-'}</code></td>
          <td style="padding: 0.28rem 0.5rem;"><strong style="font-size: 0.74rem;">${ex.label || 'Batch Execution'}</strong></td>
          <td style="padding: 0.28rem 0.5rem; text-align: center;"><span class="badge badge-xs badge-green">${ex.status || 'DONE'}</span></td>
          <td style="padding: 0.28rem 0.5rem; text-align: right; font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted);">${ex.executed_at_utc || '-'}</td>
        </tr>
      `
        )
        .join('');
    }
  } catch (err) {
    console.error('Media metrics error:', err);
  }
}

let publishedMomentsCache: any[] = [];
let publishedSummaryCache: any = {};
let pubControlsAttached = false;
const pubHistoryState: {
  sortBy: string;
  sortDir: 'desc' | 'asc';
  platformFilter: string;
  searchQuery: string;
  editingMoment?: string | null;
} = {
  sortBy: 'score',
  sortDir: 'desc',
  platformFilter: 'all',
  searchQuery: '',
  editingMoment: null
};

function renderPublishedMomentsHistory(): void {
  const momentsContainer = document.getElementById('featured-moments-list');
  if (!momentsContainer) return;

  const sfBadge = document.getElementById('pub-shutterfly-badge');
  const ytBadge = document.getElementById('pub-youtube-badge');
  const totBadge = document.getElementById('pub-moments-badge');

  if (sfBadge) {
    sfBadge.textContent = `📷 Shutterfly: ${(publishedSummaryCache.shutterfly_assets || 0).toLocaleString()} ↗`;
  }
  if (ytBadge) {
    ytBadge.textContent = `🎥 YouTube: ${(publishedSummaryCache.youtube_assets || 0).toLocaleString()} ↗`;
  }
  if (totBadge) {
    const mCount = publishedSummaryCache.total_moments || publishedMomentsCache.length || 0;
    const aCount = publishedSummaryCache.total_assets || 0;
    totBadge.textContent = `${mCount} Moments · ${aCount} Published`;
  }

  if (!pubControlsAttached) {
    pubControlsAttached = true;
    document.querySelectorAll<HTMLElement>('[data-pub-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-pub-sort') || 'score';
        if (pubHistoryState.sortBy === key) {
          pubHistoryState.sortDir = pubHistoryState.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          pubHistoryState.sortBy = key;
          pubHistoryState.sortDir = 'desc';
        }
        renderPublishedMomentsHistory();
      });
    });

    document.querySelectorAll<HTMLElement>('[data-pub-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        pubHistoryState.platformFilter = btn.getAttribute('data-pub-filter') || 'all';
        document.querySelectorAll('[data-pub-filter]').forEach(b => b.classList.toggle('active', b === btn));
        renderPublishedMomentsHistory();
      });
    });

    const searchInput = document.getElementById('pub-history-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        pubHistoryState.searchQuery = ((e.target as HTMLInputElement).value || '').trim().toLowerCase();
        renderPublishedMomentsHistory();
      });
    }
  }

  document.querySelectorAll<HTMLElement>('[data-pub-sort]').forEach(btn => {
    const key = btn.getAttribute('data-pub-sort');
    const isAct = key === pubHistoryState.sortBy;
    btn.classList.toggle('active', isAct);
    const arrow = isAct ? (pubHistoryState.sortDir === 'desc' ? ' ↓' : ' ↑') : '';
    if (key === 'score') {
      btn.textContent = `★ Normalized Score${arrow}`;
    } else if (key === 'date') {
      btn.textContent = `🕒 Date Published${arrow}`;
    }
  });

  let filtered = [...publishedMomentsCache];
  if (pubHistoryState.platformFilter === 'shutterfly') {
    filtered = filtered.filter(m => (m.shutterfly_count || 0) > 0);
  } else if (pubHistoryState.platformFilter === 'youtube') {
    filtered = filtered.filter(m => (m.youtube_count || 0) > 0);
  }

  if (pubHistoryState.searchQuery) {
    const q = pubHistoryState.searchQuery;
    filtered = filtered.filter(
      m =>
        (m.moment_name || '').toLowerCase().includes(q) ||
        (m.published_at_local || '').toLowerCase().includes(q) ||
        (m.capture_range || '').toLowerCase().includes(q)
    );
  }

  const dirMul = pubHistoryState.sortDir === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    if (pubHistoryState.sortBy === 'date') {
      const da = a.published_at_utc || '';
      const db = b.published_at_utc || '';
      if (da !== db) return da < db ? -1 * dirMul : 1 * dirMul;
      return ((a.avg_score || 0) - (b.avg_score || 0)) * dirMul;
    } else {
      const sa = a.avg_score || 0;
      const sb = b.avg_score || 0;
      if (sa !== sb) return (sa - sb) * dirMul;
      const da = a.published_at_utc || '';
      const db = b.published_at_utc || '';
      return da < db ? 1 : -1;
    }
  });

  if (filtered.length === 0) {
    momentsContainer.innerHTML = `<div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.8rem;">No published moments match the active filter.</div>`;
    return;
  }

  momentsContainer.innerHTML = filtered
    .map((m, idx) => {
      const hasSfUrl = Boolean(m.shutterfly_url);
      const hasYtUrl = Boolean(m.youtube_url);
      const isEditing = pubHistoryState.editingMoment === m.moment_name;
      const escapedMoment = (m.moment_name || '').replace(/"/g, '&quot;');

      let sfPill = '';
      if (m.shutterfly_count > 0) {
        if (hasSfUrl) {
          sfPill = `<a href="${m.shutterfly_url}" target="_blank" rel="noopener noreferrer" class="badge badge-xs badge-amber font-mono pub-badge-link" title="Open Shutterfly Album: ${m.shutterfly_url}">📷 Shutterfly: ${m.shutterfly_count} ↗</a>`;
        } else {
          sfPill = `<button type="button" class="badge badge-xs badge-amber font-mono pub-badge-link pub-badge-unset" data-edit-moment="${escapedMoment}" title="No Shutterfly Album URL saved yet — click to enter album link">📷 Shutterfly: ${m.shutterfly_count} +Link</button>`;
        }
      }

      let ytPill = '';
      if (m.youtube_count > 0) {
        if (hasYtUrl) {
          ytPill = `<a href="${m.youtube_url}" target="_blank" rel="noopener noreferrer" class="badge badge-xs badge-purple font-mono pub-badge-link" title="Open YouTube Video: ${m.youtube_url}">🎥 YouTube: ${m.youtube_count} ↗</a>`;
        } else {
          ytPill = `<button type="button" class="badge badge-xs badge-purple font-mono pub-badge-link pub-badge-unset" data-edit-moment="${escapedMoment}" title="No YouTube Video URL saved yet — click to enter video link">🎥 YouTube: ${m.youtube_count} +Link</button>`;
        }
      }

      const fallbackPill =
        !sfPill && !ytPill
          ? `<span class="badge badge-xs badge-outline font-mono">${m.published_count} published</span>`
          : '';
      const acctTitle =
        m.accounts && m.accounts.length ? `Account: ${m.accounts.join(', ')}` : 'Published Moment';

      const editorHtml = isEditing
        ? `
      <div class="pub-url-editor" data-editor-for="${escapedMoment}">
        <div class="pub-url-row">
          <span class="pub-url-label">📷 Shutterfly:</span>
          <input type="url" class="pub-url-input" data-sf-input="${escapedMoment}" placeholder="https://photos.shutterfly.com/album/..." value="${(m.shutterfly_url || '').replace(/"/g, '&quot;')}" />
          <a href="https://photos.shutterfly.com/" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-outline" title="Open Shutterfly to copy album link">Open ↗</a>
        </div>
        <div class="pub-url-row">
          <span class="pub-url-label">🎥 YouTube:</span>
          <input type="url" class="pub-url-input" data-yt-input="${escapedMoment}" placeholder="https://youtu.be/... or https://www.youtube.com/watch?v=..." value="${(m.youtube_url || '').replace(/"/g, '&quot;')}" />
          <a href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-outline" title="Open YouTube Studio to copy video link">Studio ↗</a>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.4rem; margin-top: 0.15rem;">
          <button type="button" class="btn btn-xs btn-outline" data-cancel-url="${escapedMoment}">Cancel</button>
          <button type="button" class="btn btn-xs btn-green" data-save-url="${escapedMoment}">Save Links</button>
        </div>
      </div>
    `
        : '';

      return `
      <div class="moment-card" style="flex-direction: column; align-items: stretch;" title="${acctTitle}">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem;">
          <div style="min-width: 0; flex: 1;">
            <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
              <span class="pub-rank-num">#${idx + 1}</span>
              <span class="moment-name">${m.moment_name}</span>
              <span class="badge badge-xs badge-outline font-mono">${m.memory_stage || 'M500'}</span>
            </div>
            <div class="pub-meta-line">
              <span title="Published Timestamp (Local)">🕒 ${m.published_at_local}</span>
              <span title="Capture Date Range">📸 ${m.capture_range}</span>
            </div>
          </div>
          <div class="moment-counts">
            ${sfPill}
            ${ytPill}
            ${fallbackPill}
            <button type="button" class="pub-edit-url-btn" data-edit-moment="${escapedMoment}" title="Set or Edit Shutterfly Album / YouTube Video URLs">🔗</button>
            <div class="pub-score-badge" title="Normalized Aesthetic + Favorites Score (Range: ${m.score_range})">
              <span class="pub-score-val">★ ${m.avg_score.toFixed(4)}</span>
              <span class="pub-score-rng">${m.score_range}</span>
            </div>
          </div>
        </div>
        ${editorHtml}
      </div>
    `;
    })
    .join('');

  momentsContainer.querySelectorAll<HTMLElement>('[data-edit-moment]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mName = btn.getAttribute('data-edit-moment');
      pubHistoryState.editingMoment = pubHistoryState.editingMoment === mName ? null : mName;
      renderPublishedMomentsHistory();
    });
  });

  momentsContainer.querySelectorAll<HTMLElement>('[data-cancel-url]').forEach(btn => {
    btn.addEventListener('click', () => {
      pubHistoryState.editingMoment = null;
      renderPublishedMomentsHistory();
    });
  });

  momentsContainer.querySelectorAll<HTMLButtonElement>('[data-save-url]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mName = btn.getAttribute('data-save-url') || '';
      const sfInput = momentsContainer.querySelector(`[data-sf-input="${CSS.escape(mName)}"]`) as HTMLInputElement | null;
      const ytInput = momentsContainer.querySelector(`[data-yt-input="${CSS.escape(mName)}"]`) as HTMLInputElement | null;
      const sfVal = sfInput ? sfInput.value.trim() : '';
      const ytVal = ytInput ? ytInput.value.trim() : '';
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/media/published-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            moment_name: mName,
            shutterfly_url: sfVal,
            youtube_url: ytVal
          })
        });
        const out = await res.json();
        if (out.ok) {
          const item = publishedMomentsCache.find(x => x.moment_name === mName);
          if (item) {
            item.shutterfly_url = sfVal;
            item.youtube_url = ytVal;
          }
          pubHistoryState.editingMoment = null;
          renderPublishedMomentsHistory();
        } else {
          alert(`Failed to save URL: ${out.error || 'Unknown error'}`);
          btn.disabled = false;
          btn.textContent = 'Save Links';
        }
      } catch (err: any) {
        alert(`Error saving URL: ${err.message}`);
        btn.disabled = false;
        btn.textContent = 'Save Links';
      }
    });
  });
}

// 2b. Media Scheduler & Executor Monitor
async function fetchExecutorMonitor(): Promise<void> {
  try {
    const res = await fetch('/api/media/executor-monitor');
    const data = await res.json();

    const execBadge = document.getElementById('monitor-executor-badge');
    if (execBadge && data.executor) {
      if (data.executor.is_running) {
        execBadge.className = 'badge badge-sm badge-green pulse';
        execBadge.textContent = `🟢 Executor: ACTIVE (PID: ${data.executor.pid})`;
      } else if (data.executor.status === 'STALE') {
        execBadge.className = 'badge badge-sm badge-amber';
        execBadge.textContent = `🟡 Executor: STALE (PID: ${data.executor.pid})`;
      } else {
        execBadge.className = 'badge badge-sm badge-outline';
        execBadge.textContent = '⚪ Executor: IDLE';
      }
    }

    const bgBadge = document.getElementById('monitor-bg-service-badge');
    const dbLockBadge = document.getElementById('monitor-db-lock-badge');
    const bgStatePill = document.getElementById('bg-service-state-pill');
    const bgSyncPill = document.getElementById('bg-service-sync-pill');
    const btnToggleBg = document.getElementById('btn-toggle-bg-service');

    if (data.bg_service) {
      const bg = data.bg_service;

      if (bg.status === 'REFRESHING') {
        if (bgBadge) {
          bgBadge.className = 'badge badge-sm badge-purple pulse';
          bgBadge.textContent = `🔄 BG Sync: REFRESHING (PID: ${bg.pid || bg.lock_pid})`;
        }
        if (bgStatePill) {
          bgStatePill.className = 'badge badge-xs badge-purple pulse';
          bgStatePill.textContent = `🔄 Refreshing (PID: ${bg.pid || bg.lock_pid})`;
        }
      } else if (bg.is_running) {
        if (bgBadge) {
          bgBadge.className = 'badge badge-sm badge-green';
          bgBadge.textContent = `🟢 BG Sync: RUNNING (PID: ${bg.pid})`;
        }
        if (bgStatePill) {
          bgStatePill.className = 'badge badge-xs badge-green';
          bgStatePill.textContent = `🟢 Running (PID: ${bg.pid})`;
        }
      } else {
        if (bgBadge) {
          bgBadge.className = 'badge badge-sm badge-outline';
          bgBadge.textContent = '⚪ BG Sync: STOPPED';
        }
        if (bgStatePill) {
          bgStatePill.className = 'badge badge-xs badge-outline';
          bgStatePill.textContent = '⚪ Stopped';
        }
      }

      if (btnToggleBg) {
        if (bg.is_running) {
          btnToggleBg.dataset.action = 'stop';
          btnToggleBg.className = 'btn btn-xs btn-outline';
          btnToggleBg.textContent = '⏹ Stop Service';
        } else {
          btnToggleBg.dataset.action = 'start';
          btnToggleBg.className = 'btn btn-xs btn-green';
          btnToggleBg.textContent = '▶ Start Service';
        }
      }

      if (dbLockBadge) {
        if (bg.lock_status === 'available' || !bg.lock_status) {
          dbLockBadge.className = 'badge badge-sm badge-outline';
          dbLockBadge.textContent = '🔓 DB Lock: AVAILABLE';
        } else if (bg.lock_pid && !bg.lock_pid_alive) {
          dbLockBadge.className = 'badge badge-sm badge-red';
          dbLockBadge.textContent = `⚠️ DB Lock: STALE (${bg.lock_status} · PID ${bg.lock_pid})`;
        } else if (bg.lock_status === 'planner_active') {
          dbLockBadge.className = 'badge badge-sm badge-amber';
          dbLockBadge.textContent = `🔐 DB Lock: PLANNER (PID: ${bg.lock_pid})`;
        } else if (bg.lock_status === 'executor_active') {
          dbLockBadge.className = 'badge badge-sm badge-purple';
          dbLockBadge.textContent = `🔐 DB Lock: EXECUTOR (PID: ${bg.lock_pid})`;
        } else if (bg.lock_status === 'refreshing') {
          dbLockBadge.className = 'badge badge-sm badge-purple pulse';
          dbLockBadge.textContent = `🔄 DB Lock: REFRESHING (PID: ${bg.lock_pid})`;
        } else {
          dbLockBadge.className = 'badge badge-sm badge-blue';
          dbLockBadge.textContent = `🔐 DB Lock: ${bg.lock_status}`;
        }
      }

      if (bgSyncPill) {
        if (bg.sync_state === 'REFRESHING') {
          bgSyncPill.className = 'badge badge-xs badge-purple pulse';
          bgSyncPill.textContent = '🔄 Syncing Metadata...';
        } else if (bg.sync_state === 'UP_TO_DATE') {
          bgSyncPill.className = 'badge badge-xs badge-green';
          bgSyncPill.textContent = '✅ Replica Up to Date';
        } else if (bg.sync_state === 'SYNC_PENDING') {
          bgSyncPill.className = 'badge badge-xs badge-amber';
          bgSyncPill.textContent = '⚠️ Sync Pending';
        } else {
          bgSyncPill.className = 'badge badge-xs badge-outline';
          bgSyncPill.textContent = '⚠️ Source Drive Offline';
        }
      }

      const procEl = document.getElementById('bg-metric-process');
      const procSubEl = document.getElementById('bg-metric-process-sub');
      if (procEl) {
        procEl.textContent = bg.is_running ? `🟢 Active (PID: ${bg.pid})` : '⚪ Stopped (Idle)';
      }
      if (procSubEl) {
        procSubEl.textContent = bg.is_running
          ? 'Polling every 60s · Auto-sync enabled'
          : 'Auto-starts with Planner or via Start button';
      }

      const lockEl = document.getElementById('bg-metric-lock');
      const lockSubEl = document.getElementById('bg-metric-lock-sub');
      if (lockEl) {
        if (bg.lock_status === 'available' || !bg.lock_status) {
          lockEl.textContent = '🔓 Available';
        } else if (bg.lock_pid && !bg.lock_pid_alive) {
          lockEl.textContent = `⚠️ Stale (${bg.lock_status} · PID ${bg.lock_pid})`;
        } else {
          lockEl.textContent = `🔐 ${bg.lock_status} (PID: ${bg.lock_pid || '—'})`;
        }
      }
      if (lockSubEl) {
        lockSubEl.textContent = bg.lock_started_utc ? `Acquired: ${bg.lock_started_utc}` : 'No active lock contention';
      }

      const lastSyncEl = document.getElementById('bg-metric-last-sync');
      const lastSumEl = document.getElementById('bg-metric-last-summary');
      if (lastSyncEl) {
        lastSyncEl.textContent =
          bg.latest_refresh_utc && bg.latest_refresh_utc !== '—'
            ? bg.latest_refresh_utc.endsWith('UTC')
              ? bg.latest_refresh_utc
              : `${bg.latest_refresh_utc} UTC`
            : '—';
      }
      if (lastSumEl) {
        lastSumEl.textContent = bg.last_summary || '—';
        lastSumEl.title = bg.last_summary || '';
      }

      const srcModEl = document.getElementById('bg-metric-source-mod');
      const syncReasonEl = document.getElementById('bg-metric-sync-reason');
      if (srcModEl) {
        srcModEl.textContent =
          bg.source_online && bg.source_mod_utc !== '—' ? `${bg.source_mod_utc} UTC` : 'Offline';
      }
      if (syncReasonEl) {
        syncReasonEl.textContent = bg.sync_reason || '—';
        syncReasonEl.title = bg.sync_reason || '';
      }

      const bgLatestLogEl = document.getElementById('bg-service-latest-log');
      if (bgLatestLogEl) {
        bgLatestLogEl.textContent = bg.latest_event || 'No recent events in logs/bg_copy_db_service.log';
        bgLatestLogEl.title = bg.latest_event || '';
      }
    }

    const backupBadge = document.getElementById('monitor-backup-badge');
    const backupSafetyTag = document.getElementById('monitor-backup-safety-tag');
    if (data.backup_safety) {
      if (data.backup_safety.is_locked) {
        if (backupBadge) {
          backupBadge.className = 'badge badge-sm badge-amber pulse';
          backupBadge.textContent = '🔒 Backup: ACTIVE IN PROGRESS';
        }
        if (backupSafetyTag) {
          backupSafetyTag.className = 'badge badge-sm badge-amber pulse';
          backupSafetyTag.textContent = 'Backup In Progress';
        }
      } else {
        if (backupBadge) {
          backupBadge.className = 'badge badge-sm badge-blue';
          backupBadge.textContent = '🛡️ Backup Lock: CLEAR';
        }
        if (backupSafetyTag) {
          backupSafetyTag.className = 'badge badge-sm badge-green';
          backupSafetyTag.textContent = 'Safe (No Collision)';
        }
      }
    }

    const updatedEl = document.getElementById('monitor-last-updated');
    if (updatedEl && data.timestamp) {
      const parts = data.timestamp.split(' ');
      updatedEl.textContent = `Updated: ${parts[1] || data.timestamp}`;
    }

    const currentStepEl = document.getElementById('monitor-current-step');
    if (currentStepEl) {
      currentStepEl.textContent = data.activity?.current_step || '—';
    }

    const uploadPctEl = document.getElementById('monitor-upload-pct');
    const uploadBarEl = document.getElementById('monitor-upload-bar');
    const uploadSubtextEl = document.getElementById('monitor-upload-subtext');

    if (data.activity?.upload_details) {
      const u = data.activity.upload_details;
      if (uploadPctEl) uploadPctEl.textContent = `${u.pct}%`;
      if (uploadBarEl) uploadBarEl.style.width = `${u.pct}%`;
      if (uploadSubtextEl) {
        uploadSubtextEl.textContent = `Asset ${u.current}/${u.total}: ${u.filename} (${u.size}) · ETA: ${u.eta} (${u.speed})`;
      }
    } else if (data.activity?.upload_progress) {
      if (uploadPctEl) uploadPctEl.textContent = 'Syncing';
      if (uploadBarEl) uploadBarEl.style.width = '100%';
      if (uploadSubtextEl) uploadSubtextEl.textContent = data.activity.upload_progress;
    } else {
      if (uploadPctEl) uploadPctEl.textContent = 'Idle';
      if (uploadBarEl) uploadBarEl.style.width = '0%';
      if (uploadSubtextEl) {
        uploadSubtextEl.textContent =
          'No active upload stream detected · Executor is waiting or processing metadata';
      }
    }

    const queueListEl = document.getElementById('monitor-queue-list');
    const queueBadgeEl = document.getElementById('monitor-queue-badge');
    if (queueBadgeEl) {
      queueBadgeEl.textContent = `${data.queue_count || 0} batches`;
    }

    if (queueListEl) {
      if (!data.queue || data.queue.length === 0) {
        queueListEl.innerHTML =
          '<div class="text-muted" style="font-size: 0.8rem; padding: 0.5rem 0;">(Queue is currently empty)</div>';
      } else {
        queueListEl.innerHTML = data.queue
          .map((b: any) => {
            const markerBadge = b.is_in_progress
              ? '<span class="badge badge-xs badge-green pulse">▶ IN PROGRESS</span>'
              : '<span class="badge badge-xs badge-outline">⏳ QUEUED</span>';

            let statusBadgeClass = 'badge-purple';
            if (b.status_code === '400') statusBadgeClass = 'badge-green';
            else if (b.status_code && b.status_code.includes('E')) statusBadgeClass = 'badge-red';
            else if (b.status_code === '000') statusBadgeClass = 'badge-outline';

            return `
            <div class="queue-item ${b.is_in_progress ? 'in-progress' : ''}">
              <div class="queue-main">
                ${markerBadge}
                <div class="queue-details">
                  <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <strong>${b.month}</strong>
                    <span class="badge badge-xs ${statusBadgeClass}">${b.status_code} (${b.status_label || 'Status'})</span>
                  </div>
                  <span class="font-mono text-muted" style="font-size: 0.7rem;">Q-ID: #${b.id} · Scheduled: ${b.set_at_utc || '-'}</span>
                </div>
              </div>
              <span class="font-mono text-muted" style="font-size: 0.72rem;">${
                b.updated_at_utc ? 'Updated: ' + (b.updated_at_utc.split(' ')[1] || b.updated_at_utc) : ''
              }</span>
            </div>
          `;
          })
          .join('');
      }
    }

    const logBoxEl = document.getElementById('monitor-log-box');
    if (logBoxEl && data.activity?.log_tail) {
      if (data.activity.log_tail.length === 0) {
        logBoxEl.textContent = '(No recent log activity in logs/media_organizer.log)';
      } else {
        logBoxEl.textContent = data.activity.log_tail.join('\n');
        logBoxEl.scrollTop = logBoxEl.scrollHeight;
      }
    }

    if (data.throughput) {
      renderThroughputTimeline(data.throughput, data.executor?.is_running);
    }
  } catch (err) {
    console.error('Executor monitor error:', err);
  }
}

let allThroughputPoints: any[] = [];
let visibleThroughputPoints: any[] = [];
let lastThroughputPayload: any = null;
let lastExecutorRunning = false;
let throughputInteractionsAttached = false;

const tpState = {
  windowSize: 100,
  panOffset: 0,
  yScaleMode: 'auto',
  chartW: 860,
  chartH: 185,
  isPanning: false,
  panStartX: 0,
  panStartOffset: 0
};

function computeTpYMapper(points: any[], mode: string, padT: number, plotH: number) {
  const vals = points.flatMap(p => [p.instant_mbps || 0, p.rolling_mbps || 0]).filter(v => v > 0);
  const rawMax = vals.length ? Math.max(...vals) : 1.5;

  if (mode === 'log') {
    const minLogVal = 0.05;
    const maxLogVal = Math.max(5.0, Math.ceil(rawMax * 1.25));
    const logMin = Math.log10(minLogVal);
    const logMax = Math.log10(maxLogVal);
    const getY = (val: number) => {
      const clamped = Math.max(minLogVal, Math.min(maxLogVal, val || minLogVal));
      const ratio = (Math.log10(clamped) - logMin) / (logMax - logMin);
      return padT + plotH - ratio * plotH;
    };
    const ticks = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0].filter(
      t => t >= minLogVal && t <= maxLogVal
    );
    return { getY, maxY: maxLogVal, ticks, isLog: true };
  }

  let maxY = 2.0;
  if (mode === '2') {
    maxY = 2.0;
  } else if (mode === '5') {
    maxY = 5.0;
  } else if (mode === 'p95' && vals.length >= 4) {
    const sorted = [...vals].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    maxY = Math.max(1.0, Math.ceil(p95 * 1.25 * 10) / 10);
  } else {
    maxY = Math.max(1.5, Math.ceil(rawMax * 1.15 * 10) / 10);
  }

  const getY = (val: number) => padT + plotH - (Math.min(maxY, Math.max(0, val || 0)) / maxY) * plotH;
  const ticks = [0, 0.33, 0.66, 1.0].map(s => Number((maxY * s).toFixed(1)));
  return { getY, maxY, ticks, isLog: false };
}

function updateTpControlButtons(): void {
  const total = allThroughputPoints.length;
  document.querySelectorAll<HTMLElement>('[data-tp-win]').forEach(btn => {
    const v = Number(btn.getAttribute('data-tp-win'));
    btn.classList.toggle('active', v === tpState.windowSize);
  });
  document.querySelectorAll<HTMLElement>('[data-tp-yscale]').forEach(btn => {
    const m = btn.getAttribute('data-tp-yscale');
    btn.classList.toggle('active', m === tpState.yScaleMode);
  });
  const resetBtn = document.getElementById('tp-reset-zoom');
  if (resetBtn) {
    const isCustom =
      tpState.panOffset > 0 ||
      ![0, 25, 50, 100, 250].includes(tpState.windowSize) ||
      tpState.yScaleMode !== 'auto';
    resetBtn.style.display = isCustom ? 'inline-block' : 'none';
  }
  const rangeLabel = document.getElementById('tp-range-label');
  if (rangeLabel && total > 0) {
    const winCount = tpState.windowSize === 0 ? total : Math.min(total, tpState.windowSize);
    const endIdx = Math.max(winCount, total - tpState.panOffset);
    const startIdx = Math.max(0, endIdx - winCount);
    if (tpState.panOffset > 0 || winCount < total) {
      rangeLabel.textContent = `Showing ${startIdx + 1}–${endIdx} of ${total} (${winCount} pts)`;
    } else {
      rangeLabel.textContent = `Showing all ${total} pts · Scroll to zoom`;
    }
  }
}

function renderThroughputTimeline(throughput?: any, isRunning?: boolean): void {
  if (throughput) {
    lastThroughputPayload = throughput;
    lastExecutorRunning = Boolean(isRunning);
  } else if (lastThroughputPayload) {
    throughput = lastThroughputPayload;
    isRunning = lastExecutorRunning;
  } else {
    return;
  }

  const summary = throughput.summary || {};
  allThroughputPoints = throughput.points || [];
  const total = allThroughputPoints.length;

  const winCount = tpState.windowSize === 0 ? total : Math.min(total, Math.max(8, tpState.windowSize));
  const maxPan = Math.max(0, total - winCount);
  tpState.panOffset = Math.max(0, Math.min(maxPan, tpState.panOffset));
  const endIdx = total - tpState.panOffset;
  const startIdx = Math.max(0, endIdx - winCount);
  const points = allThroughputPoints.slice(startIdx, endIdx);
  visibleThroughputPoints = points;

  updateTpControlButtons();

  const rollingEl = document.getElementById('tp-rolling-mbps');
  const latestEl = document.getElementById('tp-latest-mbps');
  const peakEl = document.getElementById('tp-peak-mbps');
  const avgEl = document.getElementById('tp-avg-mbps');
  const volEl = document.getElementById('tp-window-vol');
  const step400Badge = document.getElementById('step-400-badge');

  const winPeak = points.length
    ? Math.max(...points.map(p => p.instant_mbps || 0))
    : summary.peak_mbps || 0;
  const winMb = points.reduce((acc, p) => acc + (p.size_mb || 0), 0);
  const winDur = points.reduce((acc, p) => acc + (p.duration_s || 0), 0);
  const winAvg = winDur > 0 ? winMb / winDur : summary.avg_mbps || 0;
  const winVideos = points.filter(p => p.is_video).length;
  const winPhotos = points.length - winVideos;

  if (rollingEl) {
    rollingEl.textContent = summary.current_rolling_mbps
      ? `${summary.current_rolling_mbps.toFixed(2)} MB/s`
      : '—';
  }
  if (latestEl) {
    latestEl.textContent = summary.latest_instant_mbps
      ? `${summary.latest_instant_mbps.toFixed(2)} MB/s`
      : '—';
  }
  if (peakEl) peakEl.textContent = winPeak ? `${winPeak.toFixed(2)} MB/s` : '—';
  if (avgEl) avgEl.textContent = winAvg ? `${winAvg.toFixed(2)} MB/s` : '—';
  if (volEl) {
    volEl.textContent = points.length
      ? `${winMb.toFixed(1)} MB (${points.length} files · ${winPhotos}P/${winVideos}V)`
      : '0 MB';
  }

  if (step400Badge) {
    if (isRunning && summary.current_rolling_mbps > 0) {
      step400Badge.className = 'badge badge-sm badge-green pulse font-mono';
      step400Badge.textContent = `⚡ ${summary.current_rolling_mbps.toFixed(2)} MB/s`;
    } else if (summary.avg_mbps > 0) {
      step400Badge.className = 'badge badge-sm badge-purple font-mono';
      step400Badge.textContent = `Avg ${summary.avg_mbps.toFixed(2)} MB/s`;
    } else {
      step400Badge.className = 'badge badge-sm badge-outline';
      step400Badge.textContent = 'Step';
    }
  }

  const svg = document.getElementById('throughput-svg');
  const emptyMsg = document.getElementById('throughput-empty-msg');
  const wrap = document.getElementById('throughput-chart-wrap');
  if (!svg || !emptyMsg || !wrap) return;

  if (points.length === 0) {
    svg.style.display = 'none';
    emptyMsg.style.display = 'flex';
    emptyMsg.textContent = 'No completed upload_to_google_photos events found in recent log window';
    return;
  }

  emptyMsg.style.display = 'none';
  svg.style.display = 'block';

  const W = Math.max(420, wrap.clientWidth || 860);
  const H = Math.max(145, wrap.clientHeight || 185);
  tpState.chartW = W;
  tpState.chartH = H;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const padL = 52;
  const padR = 16;
  const padT = 14;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { getY, ticks } = computeTpYMapper(points, tpState.yScaleMode, padT, plotH);

  const n = points.length;
  const getX = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const gridHtml = ticks
    .map(tickVal => {
      const y = getY(tickVal).toFixed(1);
      const label = tickVal < 0.1 && tickVal > 0 ? tickVal.toFixed(2) : tickVal.toFixed(1);
      return `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
      <text x="${padL - 6}" y="${Number(y) + 3.5}" fill="#64748b" font-size="9.5" font-family="monospace" text-anchor="end">${label}</text>
    `;
    })
    .join('');

  const labelIndices =
    n <= 5
      ? points.map((_, idx) => idx)
      : [0, Math.floor((n - 1) * 0.25), Math.floor((n - 1) * 0.5), Math.floor((n - 1) * 0.75), n - 1];
  const xLabelsHtml = [...new Set(labelIndices)]
    .map(idx => {
      const x = getX(idx).toFixed(1);
      const t = points[idx].time;
      const anchor = idx === 0 ? 'start' : idx === n - 1 ? 'end' : 'middle';
      return `<text x="${x}" y="${H - 6}" fill="#64748b" font-size="9.5" font-family="monospace" text-anchor="${anchor}">${t}</text>`;
    })
    .join('');

  const instCoords = points.map((p, i) => `${getX(i).toFixed(1)},${getY(p.instant_mbps).toFixed(1)}`);
  const rollCoords = points.map((p, i) => `${getX(i).toFixed(1)},${getY(p.rolling_mbps).toFixed(1)}`);

  const baseY = (padT + plotH).toFixed(1);
  const areaPoints = `${getX(0).toFixed(1)},${baseY} ${instCoords.join(' ')} ${getX(n - 1).toFixed(1)},${baseY}`;

  const dotRadiusPhoto = n > 180 ? '1.6' : n < 40 ? '3.0' : '2.2';
  const dotRadiusVideo = n > 180 ? '2.4' : n < 40 ? '4.0' : '3.1';
  const dotsHtml = points
    .map((p, i) => {
      const cx = getX(i).toFixed(1);
      const cy = getY(p.instant_mbps).toFixed(1);
      const color = p.is_video ? '#c084fc' : '#38bdf8';
      const r = p.is_video ? dotRadiusVideo : dotRadiusPhoto;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`;
    })
    .join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="tp-area-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.32" />
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0" />
      </linearGradient>
    </defs>
    ${gridHtml}
    ${xLabelsHtml}
    <polygon points="${areaPoints}" fill="url(#tp-area-grad)" />
    <polyline points="${instCoords.join(' ')}" fill="none" stroke="#38bdf8" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
    <polyline points="${rollCoords.join(' ')}" fill="none" stroke="#fbbf24" stroke-width="2" stroke-dasharray="5,3" stroke-linejoin="round" />
    ${dotsHtml}
    <line id="tp-hover-line" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="rgba(255,255,255,0.35)" stroke-width="1" stroke-dasharray="2,2" style="display:none;" />
    <circle id="tp-hover-dot" cx="0" cy="0" r="5" fill="none" stroke="#fff" stroke-width="1.8" style="display:none;" />
  `;

  if (!throughputInteractionsAttached) {
    throughputInteractionsAttached = true;
    const tooltip = document.getElementById('throughput-tooltip');

    document.querySelectorAll<HTMLElement>('[data-tp-win]').forEach(btn => {
      btn.addEventListener('click', () => {
        tpState.windowSize = Number(btn.getAttribute('data-tp-win'));
        tpState.panOffset = 0;
        renderThroughputTimeline();
      });
    });

    document.querySelectorAll<HTMLElement>('[data-tp-yscale]').forEach(btn => {
      btn.addEventListener('click', () => {
        tpState.yScaleMode = btn.getAttribute('data-tp-yscale') || 'auto';
        renderThroughputTimeline();
      });
    });

    document.querySelectorAll<HTMLElement>('[data-tp-height]').forEach(btn => {
      btn.addEventListener('click', () => {
        const h = Number(btn.getAttribute('data-tp-height'));
        document.querySelectorAll('[data-tp-height]').forEach(b => b.classList.toggle('active', b === btn));
        wrap.style.height = `${h}px`;
        renderThroughputTimeline();
      });
    });

    const resetBtn = document.getElementById('tp-reset-zoom');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        tpState.windowSize = 100;
        tpState.panOffset = 0;
        tpState.yScaleMode = 'auto';
        renderThroughputTimeline();
      });
    }

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const nw = wrap.clientWidth;
        const nh = wrap.clientHeight;
        if (nw > 0 && nh > 0 && (Math.abs(nw - tpState.chartW) > 2 || Math.abs(nh - tpState.chartH) > 2)) {
          renderThroughputTimeline();
        }
      });
      ro.observe(wrap);
    }

    wrap.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (allThroughputPoints.length <= 10) return;
        e.preventDefault();
        const totalPts = allThroughputPoints.length;
        const curWin = tpState.windowSize === 0 ? totalPts : Math.min(totalPts, tpState.windowSize);
        const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
        const nextWin = Math.max(10, Math.min(totalPts, Math.round(curWin * zoomFactor)));
        if (nextWin === curWin) return;

        const rect = wrap.getBoundingClientRect();
        const cursorRatio = Math.max(
          0,
          Math.min(1, (e.clientX - rect.left - 52) / Math.max(1, rect.width - 68))
        );
        const oldEnd = totalPts - tpState.panOffset;
        const oldStart = Math.max(0, oldEnd - curWin);
        const anchorIdx = oldStart + cursorRatio * curWin;
        const newStart = Math.round(anchorIdx - cursorRatio * nextWin);
        const newEnd = Math.min(totalPts, Math.max(nextWin, newStart + nextWin));

        tpState.windowSize = nextWin === totalPts ? 0 : nextWin;
        tpState.panOffset = Math.max(0, totalPts - newEnd);
        renderThroughputTimeline();
      },
      { passive: false }
    );

    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      if (rect.bottom - e.clientY < 16 && rect.right - e.clientX < 24) return;
      tpState.isPanning = true;
      tpState.panStartX = e.clientX;
      tpState.panStartOffset = tpState.panOffset;
      wrap.classList.add('is-panning');
    });

    window.addEventListener('mouseup', () => {
      if (tpState.isPanning) {
        tpState.isPanning = false;
        wrap.classList.remove('is-panning');
      }
    });

    wrap.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect();
      const curW = tpState.chartW;
      const curH = tpState.chartH;
      const curPlotW = curW - 52 - 16;
      const curPlotH = curH - 14 - 24;

      if (tpState.isPanning && allThroughputPoints.length > 1) {
        const totalPts = allThroughputPoints.length;
        const curWin = tpState.windowSize === 0 ? totalPts : Math.min(totalPts, tpState.windowSize);
        if (curWin < totalPts) {
          const dx = e.clientX - tpState.panStartX;
          const ptsDelta = Math.round((dx / Math.max(1, rect.width - 68)) * curWin);
          tpState.panOffset = Math.max(0, Math.min(totalPts - curWin, tpState.panStartOffset + ptsDelta));
          renderThroughputTimeline();
        }
        return;
      }

      if (!visibleThroughputPoints.length) return;
      const relX = ((e.clientX - rect.left) / rect.width) * curW;
      const clampedX = Math.max(52, Math.min(curW - 16, relX));
      const count = visibleThroughputPoints.length;
      const idx = count === 1 ? 0 : Math.round(((clampedX - 52) / curPlotW) * (count - 1));
      const pt = visibleThroughputPoints[Math.max(0, Math.min(count - 1, idx))];
      if (!pt) return;

      const { getY: curGetY } = computeTpYMapper(visibleThroughputPoints, tpState.yScaleMode, 14, curPlotH);
      const px = 52 + (count === 1 ? curPlotW / 2 : (idx / (count - 1)) * curPlotW);
      const py = curGetY(pt.instant_mbps);

      const hLine = document.getElementById('tp-hover-line');
      const hDot = document.getElementById('tp-hover-dot');
      if (hLine) {
        hLine.setAttribute('x1', px.toFixed(1));
        hLine.setAttribute('x2', px.toFixed(1));
        hLine.style.display = 'block';
      }
      if (hDot) {
        hDot.setAttribute('cx', px.toFixed(1));
        hDot.setAttribute('cy', py.toFixed(1));
        hDot.style.display = 'block';
      }
      if (tooltip) {
        const typeBadge = pt.is_video
          ? '<span class="badge badge-xs badge-purple">VIDEO</span>'
          : '<span class="badge badge-xs badge-blue">PHOTO</span>';
        tooltip.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;margin-bottom:0.2rem;">
            <strong class="font-mono">[${pt.asset_ref}] ${pt.filename}</strong>
            ${typeBadge}
          </div>
          <div style="color:#94a3b8;font-family:var(--font-mono);font-size:0.68rem;margin-bottom:0.25rem;">
            Batch ${pt.batch} · ${pt.time} · ${pt.size_mb} MB in ${pt.duration_s}s
          </div>
          <div style="display:flex;justify-content:space-between;gap:0.75rem;">
            <span>Instant: <strong style="color:#38bdf8" class="font-mono">${pt.instant_mbps.toFixed(2)} MB/s</strong></span>
            <span>Rolling: <strong style="color:#fbbf24" class="font-mono">${pt.rolling_mbps.toFixed(2)} MB/s</strong></span>
          </div>
        `;
        tooltip.style.display = 'block';
        const tipW = tooltip.offsetWidth || 220;
        let leftPx = e.clientX - rect.left + 12;
        if (leftPx + tipW > rect.width - 8) {
          leftPx = Math.max(8, e.clientX - rect.left - tipW - 12);
        }
        tooltip.style.left = `${leftPx}px`;
        tooltip.style.top = '10px';
      }
    });

    wrap.addEventListener('mouseleave', () => {
      const hLine = document.getElementById('tp-hover-line');
      const hDot = document.getElementById('tp-hover-dot');
      if (hLine) hLine.style.display = 'none';
      if (hDot) hDot.style.display = 'none';
      if (tooltip) tooltip.style.display = 'none';
    });
  }
}

// 3. Storage Master Metrics
async function fetchStorageMetrics(): Promise<void> {
  try {
    const res = await fetch('/api/storage/metrics');
    const data = await res.json();

    if (!data.connected) return;

    const elFiles = document.getElementById('stat-storage-files');
    const elSize = document.getElementById('stat-storage-size');
    const elDirs = document.getElementById('stat-storage-dirs');
    const elTopo = document.getElementById('topo-storage-stat');

    if (elFiles) elFiles.textContent = (data.total_files || 0).toLocaleString();
    if (elSize) elSize.textContent = `${data.total_size_gb || 0} GB`;
    if (elDirs) elDirs.textContent = (data.total_directories || 0).toLocaleString();
    if (elTopo) {
      elTopo.textContent = `${(data.total_files || 0).toLocaleString()} files · ${data.total_size_gb || 0} GB`;
    }

    const tiersContainer = document.getElementById('priority-tiers-container');
    if (tiersContainer && data.priority_tiers) {
      tiersContainer.innerHTML = data.priority_tiers
        .map((t: any) => {
          let cls = 'tier-p1';
          if (t.tier === 'Priority 2') cls = 'tier-p2';
          else if (t.tier === 'Priority 3') cls = 'tier-p3';
          else if (t.tier === 'Priority 4') cls = 'tier-p4';
          else if (t.tier === 'Review') cls = 'tier-review';
          else if (t.tier === 'Purge') cls = 'tier-purge';

          return `
          <div class="tier-card ${cls}">
            <div class="tier-header">
              <strong style="color: ${t.color};">${t.tier}</strong>
              <span class="tier-tag">${t.label}</span>
            </div>
            <p class="tier-desc">${t.description}</p>
          </div>
        `;
        })
        .join('');
    }

    const rulesContainer = document.getElementById('storage-rules-container');
    if (rulesContainer && data.rules) {
      rulesContainer.innerHTML = data.rules
        .map(
          (r: any) => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong>${r.name}: ${r.device_pattern || '*'}</strong>
            <p style="font-family: var(--font-mono); font-size: 0.75rem; color: #7dd3fc;">Path: ${r.path_pattern} ➔ ${r.priority_tier}</p>
            <p style="font-size: 0.75rem; color: #94a3b8;">${r.description || ''}</p>
          </div>
        </div>
      `
        )
        .join('');
    }

    const filesContainer = document.getElementById('large-files-container');
    if (filesContainer && data.recent_files) {
      filesContainer.innerHTML = data.recent_files
        .map(
          (f: any) => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;">${f.name}</strong>
            <span style="font-size: 0.75rem; color: #94a3b8;">Category: ${f.category} (${f.ext})</span>
          </div>
          <span class="badge badge-sm badge-blue">${f.size_mb} MB</span>
        </div>
      `
        )
        .join('');
    }
  } catch (err) {
    console.error('Storage metrics error:', err);
  }
}

// 4. IDrive Metrics
async function fetchIDriveMetrics(): Promise<void> {
  try {
    const res = await fetch('/api/idrive/metrics');
    const data = await res.json();

    const topoEl = document.getElementById('topo-idrive-stat');
    const evsEl = document.getElementById('stat-evs-api-calls');

    if (topoEl) {
      topoEl.textContent = `device_registry.db: ${data.devices?.length || 4} devices`;
    }
    if (evsEl) {
      evsEl.textContent = (data.api_calls_count || 859).toLocaleString();
    }

    const cookieText = document.getElementById('idrive-cookie-status-text');
    if (cookieText) {
      if (data.cookie_valid) {
        cookieText.innerHTML = `<span style="color: #34d399;">Active session cookie found in repository. EVS queries ready.</span>`;
      } else {
        cookieText.innerHTML = `<span style="color: #f87171;">No active .idrive_cookie detected. Open idrive.com web console, copy EVSID & JSESSIONID to enable cloud restores.</span>`;
      }
    }

    const devicesContainer = document.getElementById('idrive-devices-container');
    if (devicesContainer && data.devices) {
      const badgeDevCount = document.getElementById('badge-device-count');
      if (badgeDevCount) badgeDevCount.textContent = `${data.devices.length} Devices`;
      devicesContainer.innerHTML = data.devices
        .map(
          (d: any) => `
        <div class="topo-pillar">
          <div class="topo-icon icon-cyan">💻</div>
          <h4>${d.name}</h4>
          <p style="font-family: var(--font-mono); font-size: 0.75rem;">Type: ${d.type} · ${d.capacity_tb} TB</p>
          <div class="topo-db-stat">Last Seen: ${d.last_seen ? d.last_seen.split(' ')[0] : 'Recorded'}</div>
        </div>
      `
        )
        .join('');
    }

    const policiesContainer = document.getElementById('idrive-policies-container');
    if (policiesContainer && data.policies) {
      policiesContainer.innerHTML = data.policies
        .map(
          (p: any) => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong>Policy #${p.policy_id}: ${p.policy_name}</strong>
          </div>
          <span class="badge badge-sm badge-cyan">Active</span>
        </div>
      `
        )
        .join('');
    }
  } catch (err) {
    console.error('IDrive metrics error:', err);
  }
}

// 5. Gmail Metrics
async function fetchGmailMetrics(): Promise<void> {
  try {
    const res = await fetch('/api/gmail/metrics');
    const data = await res.json();

    const statusBadge = document.getElementById('badge-gmail-status');
    const statusText = document.getElementById('gmail-auth-status-text');
    if (statusBadge && statusText) {
      statusBadge.textContent = data.auth_status;
      if (data.has_token) {
        statusBadge.className = 'badge badge-green';
        statusText.textContent =
          'token.json verified. Gmail API read scopes authorized for scan and suggestions.';
      } else if (data.has_credentials) {
        statusBadge.className = 'badge badge-amber';
        statusText.textContent =
          'credentials.json configured. Run report to initiate OAuth consent flow.';
      } else {
        statusBadge.className = 'badge badge-outline';
        statusText.textContent =
          'Please place credentials.json in gmail-cleanup-planner to enable OAuth.';
      }
    }

    const familiesContainer = document.getElementById('rule-families-container');
    if (familiesContainer && data.rule_families) {
      familiesContainer.innerHTML = data.rule_families
        .map(
          (rf: any) => `
        <div class="rule-family-card">
          <strong style="color: ${rf.color};">${rf.name}</strong>
          <div class="domain-tags">
            ${rf.domains.map((d: string) => `<span class="domain-tag">${d}</span>`).join('')}
          </div>
        </div>
      `
        )
        .join('');
    }

    const rulesContainer = document.getElementById('gmail-rules-container');
    if (rulesContainer && data.existing_rules) {
      rulesContainer.innerHTML = data.existing_rules
        .map(
          (r: any) => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong>${r.name}</strong>
            <p style="font-family: var(--font-mono); font-size: 0.75rem; color: #fbbf24;">${r.query}</p>
          </div>
          <span class="badge badge-sm badge-purple">${r.action}</span>
        </div>
      `
        )
        .join('');
    }
  } catch (err) {
    console.error('Gmail metrics error:', err);
  }
}

// 6. Reports Inspector
async function fetchReportsList(): Promise<void> {
  try {
    const res = await fetch('/api/reports/list');
    const data = await res.json();

    const navList = document.getElementById('reports-nav-list');
    const countBadge = document.getElementById('reports-count-badge');
    if (countBadge) countBadge.textContent = String(data.reports?.length || 0);

    if (navList && data.reports) {
      navList.innerHTML = data.reports
        .map(
          (r: any) => `
        <div class="report-item" data-id="${r.id}" onclick="window.loadReport('${r.id}', '${r.title}', '${r.filename}')">
          <span class="report-item-title">${r.title}</span>
          <span class="badge badge-sm badge-outline">${r.size_kb} KB</span>
        </div>
      `
        )
        .join('');

      if (data.reports.length > 0) {
        window.loadReport(data.reports[0].id, data.reports[0].title, data.reports[0].filename);
      }
    }
  } catch (err) {
    console.error('Error fetching reports:', err);
  }
}

window.loadReport = async function (id: string, title: string, filename: string): Promise<void> {
  document.querySelectorAll<HTMLElement>('.report-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });

  const titleEl = document.getElementById('report-viewer-title');
  const filenameEl = document.getElementById('report-viewer-filename');
  const bodyEl = document.getElementById('report-viewer-body');

  if (titleEl) titleEl.textContent = title;
  if (filenameEl) filenameEl.textContent = filename;
  if (bodyEl) bodyEl.innerHTML = '<div class="loading-spinner">Loading report document...</div>';

  try {
    const res = await fetch(`/api/reports/content?report_id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (bodyEl) {
      bodyEl.textContent = data.content;
    }
  } catch (err) {
    if (bodyEl) bodyEl.textContent = `Error reading report: ${err}`;
  }
};

// 7. Live Console & WebSocket Task Runner
function setupConsoleControls(): void {
  const drawer = document.getElementById('console-drawer');
  const btnToggle = document.getElementById('btn-toggle-console');
  const btnClose = document.getElementById('btn-close-console');
  const btnClear = document.getElementById('btn-clear-console');
  const btnKill = document.getElementById('btn-kill-task');

  btnToggle?.addEventListener('click', () => {
    drawer?.classList.toggle('open');
  });

  btnClose?.addEventListener('click', () => {
    drawer?.classList.remove('open');
  });

  btnClear?.addEventListener('click', () => {
    const output = document.getElementById('console-output');
    if (output) output.innerHTML = '';
  });

  btnKill?.addEventListener('click', async () => {
    if (activeExecutionId) {
      try {
        await fetch(`/api/runner/kill/${activeExecutionId}`, { method: 'POST' });
        appendConsoleLog('\n[ABORTED] Termination signal sent to process.\n');
        btnKill.style.display = 'none';
      } catch (err) {
        console.error('Error killing process:', err);
      }
    }
  });

  document.querySelectorAll<HTMLElement>('.action-card').forEach(card => {
    card.addEventListener('click', () => {
      const action = card.dataset.action;
      if (action) {
        window.triggerTask(action);
      }
    });
  });
}

let activeTaskCallbacks: {
  taskId: string | null;
  executionId: string | null;
  openConsole: boolean;
  onLog: ((text: string) => void) | null;
  onDone: ((exitCode: number, errDetail?: string) => void) | null;
} = {
  taskId: null,
  executionId: null,
  openConsole: true,
  onLog: null,
  onDone: null
};

window.triggerTask = async function (
  taskId: string,
  args: any = null,
  openConsole = true,
  onLog: ((text: string) => void) | null = null,
  onDone: ((exitCode: number, errDetail?: string) => void) | null = null
): Promise<any> {
  if (openConsole) {
    const drawer = document.getElementById('console-drawer');
    drawer?.classList.add('open');

    const label = document.getElementById('console-task-label');
    const btnKill = document.getElementById('btn-kill-task');
    const badgeActive = document.getElementById('active-task-badge');

    if (label) label.textContent = `Running: ${taskId}`;
    if (btnKill) btnKill.style.display = 'inline-flex';
    if (badgeActive) badgeActive.style.display = 'inline-block';

    appendConsoleLog(`\n[DISPATCH] Requesting execution: ${taskId}...\n`);
  }

  activeTaskCallbacks = {
    taskId,
    executionId: null,
    openConsole,
    onLog,
    onDone
  };

  try {
    const res = await fetch('/api/runner/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, args: args })
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = `[ERROR] ${data.detail || 'Failed to dispatch task'}\n`;
      if (openConsole) {
        appendConsoleLog(errMsg);
        const btnKill = document.getElementById('btn-kill-task');
        const badgeActive = document.getElementById('active-task-badge');
        if (btnKill) btnKill.style.display = 'none';
        if (badgeActive) badgeActive.style.display = 'none';
      }
      if (onDone) onDone(-1, data.detail);
      return null;
    }

    activeExecutionId = data.execution_id;
    activeTaskCallbacks.executionId = activeExecutionId;
    if (activeExecutionId) connectWebSocket(activeExecutionId);
    return activeExecutionId;
  } catch (err: any) {
    const errMsg = `[ERROR] Network error starting task: ${err}\n`;
    if (openConsole) {
      appendConsoleLog(errMsg);
      const btnKill = document.getElementById('btn-kill-task');
      const badgeActive = document.getElementById('active-task-badge');
      if (btnKill) btnKill.style.display = 'none';
      if (badgeActive) badgeActive.style.display = 'none';
    }
    if (onDone) onDone(-1, err.message);
    return null;
  }
};

function connectWebSocket(executionId: string): void {
  if (activeWebSocket) {
    activeWebSocket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/${executionId}`;

  activeWebSocket = new WebSocket(wsUrl);

  activeWebSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'log') {
        if (activeTaskCallbacks.openConsole) {
          appendConsoleLog(data.text);
        }
        if (activeTaskCallbacks.onLog) {
          activeTaskCallbacks.onLog(data.text);
        }
        const match = data.text && data.text.match(/\[COMPLETED\] Process exited with code (\d+)/);
        if (match) {
          const code = parseInt(match[1], 10);
          if (activeTaskCallbacks.openConsole) {
            const btnKill = document.getElementById('btn-kill-task');
            const badgeActive = document.getElementById('active-task-badge');
            const label = document.getElementById('console-task-label');
            if (btnKill) btnKill.style.display = 'none';
            if (badgeActive) badgeActive.style.display = 'none';
            if (label) label.textContent = 'Completed';
          }
          if (activeTaskCallbacks.onDone) {
            activeTaskCallbacks.onDone(code);
          }
        }
      } else if (data.type === 'done') {
        if (activeTaskCallbacks.openConsole) {
          appendConsoleLog(`\n[COMPLETE] Task finished with exit code ${data.exit_code}\n`);
          const btnKill = document.getElementById('btn-kill-task');
          const badgeActive = document.getElementById('active-task-badge');
          const label = document.getElementById('console-task-label');
          if (btnKill) btnKill.style.display = 'none';
          if (badgeActive) badgeActive.style.display = 'none';
          if (label) label.textContent = 'Completed';
        }
        if (activeTaskCallbacks.onDone) {
          activeTaskCallbacks.onDone(data.exit_code);
        }
        fetchAllMetrics();
      }
    } catch {
      if (activeTaskCallbacks.openConsole) {
        appendConsoleLog(event.data);
      }
      if (activeTaskCallbacks.onLog) {
        activeTaskCallbacks.onLog(event.data);
      }
    }
  };

  activeWebSocket.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function appendConsoleLog(text: string): void {
  const output = document.getElementById('console-output');
  if (output) {
    const span = document.createElement('span');
    span.textContent = text;
    output.appendChild(span);
    output.scrollTop = output.scrollHeight;
  }
}

// 8. Modals
function setupModals(): void {
  const modalTriage = document.getElementById('modal-triage');
  const btnOpenTriage = document.getElementById('btn-open-triage-modal');
  const btnConfirmTriage = document.getElementById('btn-confirm-triage');

  btnOpenTriage?.addEventListener('click', () => {
    modalTriage?.classList.add('open');
  });

  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      modalTriage?.classList.remove('open');
      document.getElementById('modal-cleanup-confirm')?.classList.remove('open');
      closeCleanupPreviewModal();
    });
  });

  const triageInput = document.getElementById('triage-input-path') as HTMLInputElement | null;
  attachPathSanitizer(triageInput);

  btnConfirmTriage?.addEventListener('click', () => {
    const rawPath = (document.getElementById('triage-input-path') as HTMLInputElement | null)?.value;
    const intakePath = cleanPath(rawPath);
    modalTriage?.classList.remove('open');
    window.triggerTask('media_triage', intakePath ? (['--intake-dir', intakePath] as any) : null);
  });

  document.getElementById('btn-cookie-help')?.addEventListener('click', () => {
    alert(
      'How to Refresh IDrive Session Cookie:\n\n' +
        '1. Log into your account on https://www.idrive.com\n' +
        '2. Open Chrome DevTools (F12) -> Application -> Cookies\n' +
        "3. Copy the 'EVSID' and 'JSESSIONID' cookies\n" +
        '4. Save them in submodules/idrive-audit/.idrive_cookie as:\n' +
        '   EVSID=...; JSESSIONID=...'
    );
  });
}

