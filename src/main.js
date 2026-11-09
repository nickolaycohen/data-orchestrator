// ==========================================================================
// Data Orchestrator Dashboard Frontend
// ==========================================================================

let activeExecutionId = null;
let activeWebSocket = null;
let mediaMonitorInterval = null;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupConsoleControls();
  setupModals();
  setupRefresh();
  setupUtilities();
  setupMediaCleanup();
  setupPlannerOverview();
  
  // Initial data loading
  fetchAllMetrics();
});

// Tab Navigation
function setupTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  const panels = document.querySelectorAll('.tab-panel');

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
        if (!cleanupDevicesData) {
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
function setupRefresh() {
  document.getElementById('btn-refresh-all')?.addEventListener('click', () => {
    fetchAllMetrics();
  });
  document.getElementById('btn-refresh-monitor')?.addEventListener('click', () => {
    fetchExecutorMonitor();
  });
  document.getElementById('btn-toggle-bg-service')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
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

async function fetchAllMetrics() {
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
async function fetchSystemStatus() {
  try {
    const res = await fetch('/api/system/status');
    const data = await res.json();

    // Volume Mounts
    const mountsContainer = document.getElementById('mounts-list-container');
    const mountedCount = data.mounts.filter(m => m.mounted).length;
    document.getElementById('mounted-summary').innerHTML = `<span class="badge-icon">💾</span> <span class="badge-text">${mountedCount} Volumes Online</span>`;

    if (mountsContainer) {
      mountsContainer.innerHTML = data.mounts.map(m => {
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

        let fillClass = 'fill-green';
        if (m.pct_used > 85) fillClass = 'fill-red';
        else if (m.pct_used > 65) fillClass = 'fill-amber';
        else if (m.pct_used > 30) fillClass = 'fill-blue';

        return `
          <div class="mount-item">
            <div class="mount-header">
              <span class="mount-name">💾 ${m.name}</span>
              <span class="mount-numbers">${m.used_gb} GB / ${m.total_gb} GB (${m.pct_used}%)</span>
            </div>
            <span class="mount-path">${m.path}</span>
            <div class="gauge-bar-bg">
              <div class="gauge-bar-fill ${fillClass}" style="width: ${m.pct_used}%;"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    // Submodules List
    const submodulesContainer = document.getElementById('submodules-list-container');
    if (submodulesContainer) {
      submodulesContainer.innerHTML = Object.entries(data.submodules).map(([name, info]) => {
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
      }).join('');
    }

    // Alerts
    const alertsContainer = document.getElementById('alerts-container');
    if (alertsContainer && data.alerts) {
      if (data.alerts.length === 0) {
        alertsContainer.innerHTML = '';
      } else {
        alertsContainer.innerHTML = data.alerts.map(a => `
          <div class="mount-item mb-3" style="border-left: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.08);">
            <strong style="color: #fcd34d;">${a.title}</strong>
            <p style="font-size: 0.8rem; color: #cbd5e1; margin-top: 0.2rem;">${a.message}</p>
          </div>
        `).join('');
      }
    }

  } catch (err) {
    console.error('System status error:', err);
  }
}

// 2. Media Organizer Metrics
async function fetchMediaMetrics() {
  try {
    const res = await fetch('/api/media/metrics');
    const data = await res.json();

    if (!data.connected) return;

    const stats = data.stats || {};
    if (document.getElementById('stat-media-assets')) {
      document.getElementById('stat-media-assets').textContent = (stats.total_assets || 0).toLocaleString();
    }
    if (document.getElementById('stat-media-moments')) {
      document.getElementById('stat-media-moments').textContent = (stats.curated_moments || 0).toLocaleString();
    }
    if (document.getElementById('stat-media-batches')) {
      document.getElementById('stat-media-batches').textContent = (stats.month_batches || 0).toLocaleString();
    }
    if (document.getElementById('stat-media-triage-saved')) {
      document.getElementById('stat-media-triage-saved').textContent = `${stats.triage_saved_gb || 0} GB`;
    }
    if (document.getElementById('topo-media-stat')) {
      document.getElementById('topo-media-stat').textContent = `${(stats.total_assets || 0).toLocaleString()} assets · ${(stats.curated_moments || 0)} moments`;
    }

    // Published Moments History (Shutterfly & YouTube)
    if (data.published_moments) {
      publishedMomentsCache = data.published_moments;
      publishedSummaryCache = data.published_summary || {};
      renderPublishedMomentsHistory();
    } else if (data.featured_moments) {
      const momentsContainer = document.getElementById('featured-moments-list');
      if (momentsContainer) {
        momentsContainer.innerHTML = data.featured_moments.slice(0, 5).map(m => `
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
        `).join('');
      }
    }

    // Pipeline executions table
    const executionsTbody = document.getElementById('pipeline-executions-tbody');
    if (executionsTbody && data.recent_executions) {
      executionsTbody.innerHTML = data.recent_executions.map(ex => `
        <tr>
          <td><span style="font-family: var(--font-mono); color: #94a3b8;">#${ex.id}</span></td>
          <td><code>${ex.session_id || '-'}</code></td>
          <td><strong>${ex.label || 'Batch Execution'}</strong></td>
          <td><span class="badge badge-sm badge-green">${ex.status || 'DONE'}</span></td>
          <td style="font-family: var(--font-mono); font-size: 0.75rem;">${ex.executed_at_utc || '-'}</td>
        </tr>
      `).join('');
    }

  } catch (err) {
    console.error('Media metrics error:', err);
  }
}

let publishedMomentsCache = [];
let publishedSummaryCache = {};
let pubControlsAttached = false;
const pubHistoryState = {
  sortBy: 'score', // 'score' | 'date'
  sortDir: 'desc', // 'desc' | 'asc'
  platformFilter: 'all', // 'all' | 'shutterfly' | 'youtube'
  searchQuery: ''
};

function renderPublishedMomentsHistory() {
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
    document.querySelectorAll('[data-pub-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-pub-sort');
        if (pubHistoryState.sortBy === key) {
          pubHistoryState.sortDir = pubHistoryState.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          pubHistoryState.sortBy = key;
          pubHistoryState.sortDir = 'desc';
        }
        renderPublishedMomentsHistory();
      });
    });

    document.querySelectorAll('[data-pub-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        pubHistoryState.platformFilter = btn.getAttribute('data-pub-filter');
        document.querySelectorAll('[data-pub-filter]').forEach(b => b.classList.toggle('active', b === btn));
        renderPublishedMomentsHistory();
      });
    });

    const searchInput = document.getElementById('pub-history-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        pubHistoryState.searchQuery = (e.target.value || '').trim().toLowerCase();
        renderPublishedMomentsHistory();
      });
    }
  }

  // Update sort button labels with direction arrows
  document.querySelectorAll('[data-pub-sort]').forEach(btn => {
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
    filtered = filtered.filter(m =>
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

  momentsContainer.innerHTML = filtered.map((m, idx) => {
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

    const fallbackPill = (!sfPill && !ytPill)
      ? `<span class="badge badge-xs badge-outline font-mono">${m.published_count} published</span>`
      : '';
    const acctTitle = (m.accounts && m.accounts.length) ? `Account: ${m.accounts.join(', ')}` : 'Published Moment';

    const editorHtml = isEditing ? `
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
    ` : '';

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
  }).join('');

  // Attach inline URL editor handlers
  momentsContainer.querySelectorAll('[data-edit-moment]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mName = btn.getAttribute('data-edit-moment');
      pubHistoryState.editingMoment = pubHistoryState.editingMoment === mName ? null : mName;
      renderPublishedMomentsHistory();
    });
  });

  momentsContainer.querySelectorAll('[data-cancel-url]').forEach(btn => {
    btn.addEventListener('click', () => {
      pubHistoryState.editingMoment = null;
      renderPublishedMomentsHistory();
    });
  });

  momentsContainer.querySelectorAll('[data-save-url]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mName = btn.getAttribute('data-save-url');
      const sfInput = momentsContainer.querySelector(`[data-sf-input="${CSS.escape(mName)}"]`);
      const ytInput = momentsContainer.querySelector(`[data-yt-input="${CSS.escape(mName)}"]`);
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
      } catch (err) {
        alert(`Error saving URL: ${err.message}`);
        btn.disabled = false;
        btn.textContent = 'Save Links';
      }
    });
  });
}

// 2b. Media Scheduler & Executor Monitor
async function fetchExecutorMonitor() {
  try {
    const res = await fetch('/api/media/executor-monitor');
    const data = await res.json();

    // 1. Executor status badge
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

    // 1b. Background Database Copy & Sync Service badges & panel
    const bgBadge = document.getElementById('monitor-bg-service-badge');
    const dbLockBadge = document.getElementById('monitor-db-lock-badge');
    const bgStatePill = document.getElementById('bg-service-state-pill');
    const bgSyncPill = document.getElementById('bg-service-sync-pill');
    const btnToggleBg = document.getElementById('btn-toggle-bg-service');

    if (data.bg_service) {
      const bg = data.bg_service;

      // Top Header BG Service Badge & Panel State Pill
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

      // Toggle Button state
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

      // Top Header DB Copy Lock Badge
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

      // Sync Freshness Pill
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

      // 4 Metric Cards
      const procEl = document.getElementById('bg-metric-process');
      const procSubEl = document.getElementById('bg-metric-process-sub');
      if (procEl) {
        procEl.textContent = bg.is_running ? `🟢 Active (PID: ${bg.pid})` : '⚪ Stopped (Idle)';
      }
      if (procSubEl) {
        procSubEl.textContent = bg.is_running ? 'Polling every 60s · Auto-sync enabled' : 'Auto-starts with Planner or via Start button';
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
        lastSyncEl.textContent = bg.latest_refresh_utc && bg.latest_refresh_utc !== '—'
          ? (bg.latest_refresh_utc.endsWith('UTC') ? bg.latest_refresh_utc : `${bg.latest_refresh_utc} UTC`)
          : '—';
      }
      if (lastSumEl) {
        lastSumEl.textContent = bg.last_summary || '—';
        lastSumEl.title = bg.last_summary || '';
      }

      const srcModEl = document.getElementById('bg-metric-source-mod');
      const syncReasonEl = document.getElementById('bg-metric-sync-reason');
      if (srcModEl) {
        srcModEl.textContent = bg.source_online && bg.source_mod_utc !== '—' ? `${bg.source_mod_utc} UTC` : 'Offline';
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

    // 2. Backup safety badge & tag
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

    // 3. Last updated timestamp
    const updatedEl = document.getElementById('monitor-last-updated');
    if (updatedEl && data.timestamp) {
      const parts = data.timestamp.split(' ');
      updatedEl.textContent = `Updated: ${parts[1] || data.timestamp}`;
    }

    // 4. Current Pipeline Activity / Step
    const currentStepEl = document.getElementById('monitor-current-step');
    if (currentStepEl) {
      currentStepEl.textContent = data.activity?.current_step || '—';
    }

    // 5. Upload Telemetry & Progress Bar
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
      if (uploadSubtextEl) uploadSubtextEl.textContent = 'No active upload stream detected · Executor is waiting or processing metadata';
    }

    // 6. Active Execution Queue
    const queueListEl = document.getElementById('monitor-queue-list');
    const queueBadgeEl = document.getElementById('monitor-queue-badge');
    if (queueBadgeEl) {
      queueBadgeEl.textContent = `${data.queue_count || 0} batches`;
    }

    if (queueListEl) {
      if (!data.queue || data.queue.length === 0) {
        queueListEl.innerHTML = '<div class="text-muted" style="font-size: 0.8rem; padding: 0.5rem 0;">(Queue is currently empty)</div>';
      } else {
        queueListEl.innerHTML = data.queue.map(b => {
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
              <span class="font-mono text-muted" style="font-size: 0.72rem;">${b.updated_at_utc ? 'Updated: ' + (b.updated_at_utc.split(' ')[1] || b.updated_at_utc) : ''}</span>
            </div>
          `;
        }).join('');
      }
    }

    // 7. Recent Log Activity Tail
    const logBoxEl = document.getElementById('monitor-log-box');
    if (logBoxEl && data.activity?.log_tail) {
      if (data.activity.log_tail.length === 0) {
        logBoxEl.textContent = '(No recent log activity in logs/media_organizer.log)';
      } else {
        logBoxEl.textContent = data.activity.log_tail.join('\n');
        logBoxEl.scrollTop = logBoxEl.scrollHeight;
      }
    }

    // 8. Upload Throughput Timeline Graph (upload_to_google_photos.py)
    if (data.throughput) {
      renderThroughputTimeline(data.throughput, data.executor?.is_running);
    }

  } catch (err) {
    console.error('Executor monitor error:', err);
  }
}

let allThroughputPoints = [];
let visibleThroughputPoints = [];
let lastThroughputPayload = null;
let lastExecutorRunning = false;
let throughputInteractionsAttached = false;

const tpState = {
  windowSize: 100,   // 0 = All points, otherwise number of visible points
  panOffset: 0,      // 0 = pinned to latest point, >0 = panned back by N points
  yScaleMode: 'auto', // 'auto' | 'p95' | '2' | '5' | 'log'
  chartW: 860,
  chartH: 185,
  isPanning: false,
  panStartX: 0,
  panStartOffset: 0
};

function computeTpYMapper(points, mode, padT, plotH) {
  const vals = points.flatMap(p => [p.instant_mbps || 0, p.rolling_mbps || 0]).filter(v => v > 0);
  const rawMax = vals.length ? Math.max(...vals) : 1.5;

  if (mode === 'log') {
    const minLogVal = 0.05; // 50 KB/s floor
    const maxLogVal = Math.max(5.0, Math.ceil(rawMax * 1.25));
    const logMin = Math.log10(minLogVal);
    const logMax = Math.log10(maxLogVal);
    const getY = (val) => {
      const clamped = Math.max(minLogVal, Math.min(maxLogVal, val || minLogVal));
      const ratio = (Math.log10(clamped) - logMin) / (logMax - logMin);
      return padT + plotH - ratio * plotH;
    };
    const ticks = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0].filter(t => t >= minLogVal && t <= maxLogVal);
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

  const getY = (val) => padT + plotH - (Math.min(maxY, Math.max(0, val || 0)) / maxY) * plotH;
  const ticks = [0, 0.33, 0.66, 1.0].map(s => Number((maxY * s).toFixed(1)));
  return { getY, maxY, ticks, isLog: false };
}

function updateTpControlButtons() {
  const total = allThroughputPoints.length;
  document.querySelectorAll('[data-tp-win]').forEach(btn => {
    const v = Number(btn.getAttribute('data-tp-win'));
    btn.classList.toggle('active', v === tpState.windowSize);
  });
  document.querySelectorAll('[data-tp-yscale]').forEach(btn => {
    const m = btn.getAttribute('data-tp-yscale');
    btn.classList.toggle('active', m === tpState.yScaleMode);
  });
  const resetBtn = document.getElementById('tp-reset-zoom');
  if (resetBtn) {
    const isCustom = tpState.panOffset > 0 || ![0, 25, 50, 100, 250].includes(tpState.windowSize) || tpState.yScaleMode !== 'auto';
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

function renderThroughputTimeline(throughput, isRunning) {
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

  // Compute visible slice according to windowSize + panOffset
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

  // Recompute KPIs for the currently visible window so zooming/scaling updates stats dynamically
  const winPeak = points.length ? Math.max(...points.map(p => p.instant_mbps || 0)) : (summary.peak_mbps || 0);
  const winMb = points.reduce((acc, p) => acc + (p.size_mb || 0), 0);
  const winDur = points.reduce((acc, p) => acc + (p.duration_s || 0), 0);
  const winAvg = winDur > 0 ? (winMb / winDur) : (summary.avg_mbps || 0);
  const winVideos = points.filter(p => p.is_video).length;
  const winPhotos = points.length - winVideos;

  if (rollingEl) rollingEl.textContent = summary.current_rolling_mbps ? `${summary.current_rolling_mbps.toFixed(2)} MB/s` : '—';
  if (latestEl) latestEl.textContent = summary.latest_instant_mbps ? `${summary.latest_instant_mbps.toFixed(2)} MB/s` : '—';
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
  const getX = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  // Gridlines
  const gridHtml = ticks.map(tickVal => {
    const y = getY(tickVal).toFixed(1);
    const label = tickVal < 0.1 && tickVal > 0 ? tickVal.toFixed(2) : tickVal.toFixed(1);
    return `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
      <text x="${padL - 6}" y="${Number(y) + 3.5}" fill="#64748b" font-size="9.5" font-family="monospace" text-anchor="end">${label}</text>
    `;
  }).join('');

  // X-axis time labels
  const labelIndices = n <= 5
    ? points.map((_, idx) => idx)
    : [0, Math.floor((n - 1) * 0.25), Math.floor((n - 1) * 0.5), Math.floor((n - 1) * 0.75), n - 1];
  const xLabelsHtml = [...new Set(labelIndices)].map(idx => {
    const x = getX(idx).toFixed(1);
    const t = points[idx].time;
    const anchor = idx === 0 ? 'start' : (idx === n - 1 ? 'end' : 'middle');
    return `<text x="${x}" y="${H - 6}" fill="#64748b" font-size="9.5" font-family="monospace" text-anchor="${anchor}">${t}</text>`;
  }).join('');

  // Coordinates for Instantaneous & Rolling polylines
  const instCoords = points.map((p, i) => `${getX(i).toFixed(1)},${getY(p.instant_mbps).toFixed(1)}`);
  const rollCoords = points.map((p, i) => `${getX(i).toFixed(1)},${getY(p.rolling_mbps).toFixed(1)}`);

  const baseY = (padT + plotH).toFixed(1);
  const areaPoints = `${getX(0).toFixed(1)},${baseY} ${instCoords.join(' ')} ${getX(n - 1).toFixed(1)},${baseY}`;

  // Circles for each uploaded asset (purple for video, cyan for photo)
  const dotRadiusPhoto = n > 180 ? '1.6' : (n < 40 ? '3.0' : '2.2');
  const dotRadiusVideo = n > 180 ? '2.4' : (n < 40 ? '4.0' : '3.1');
  const dotsHtml = points.map((p, i) => {
    const cx = getX(i).toFixed(1);
    const cy = getY(p.instant_mbps).toFixed(1);
    const color = p.is_video ? '#c084fc' : '#38bdf8';
    const r = p.is_video ? dotRadiusVideo : dotRadiusPhoto;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`;
  }).join('');

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

    // Toolbar X-Window scale buttons
    document.querySelectorAll('[data-tp-win]').forEach(btn => {
      btn.addEventListener('click', () => {
        tpState.windowSize = Number(btn.getAttribute('data-tp-win'));
        tpState.panOffset = 0;
        renderThroughputTimeline();
      });
    });

    // Toolbar Y-Scale buttons
    document.querySelectorAll('[data-tp-yscale]').forEach(btn => {
      btn.addEventListener('click', () => {
        tpState.yScaleMode = btn.getAttribute('data-tp-yscale');
        renderThroughputTimeline();
      });
    });

    // Toolbar Height preset buttons
    document.querySelectorAll('[data-tp-height]').forEach(btn => {
      btn.addEventListener('click', () => {
        const h = Number(btn.getAttribute('data-tp-height'));
        document.querySelectorAll('[data-tp-height]').forEach(b => b.classList.toggle('active', b === btn));
        wrap.style.height = `${h}px`;
        renderThroughputTimeline();
      });
    });

    // Reset Zoom / View button
    const resetBtn = document.getElementById('tp-reset-zoom');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        tpState.windowSize = 100;
        tpState.panOffset = 0;
        tpState.yScaleMode = 'auto';
        renderThroughputTimeline();
      });
    }

    // ResizeObserver for crisp 1:1 SVG re-scaling on container resize or vertical drag
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

    // Mouse-wheel zoom on X-axis around cursor position
    wrap.addEventListener('wheel', (e) => {
      if (allThroughputPoints.length <= 10) return;
      e.preventDefault();
      const totalPts = allThroughputPoints.length;
      const curWin = tpState.windowSize === 0 ? totalPts : Math.min(totalPts, tpState.windowSize);
      const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
      const nextWin = Math.max(10, Math.min(totalPts, Math.round(curWin * zoomFactor)));
      if (nextWin === curWin) return;

      const rect = wrap.getBoundingClientRect();
      const cursorRatio = Math.max(0, Math.min(1, (e.clientX - rect.left - 52) / Math.max(1, rect.width - 68)));
      const oldEnd = totalPts - tpState.panOffset;
      const oldStart = Math.max(0, oldEnd - curWin);
      const anchorIdx = oldStart + cursorRatio * curWin;
      const newStart = Math.round(anchorIdx - cursorRatio * nextWin);
      const newEnd = Math.min(totalPts, Math.max(nextWin, newStart + nextWin));

      tpState.windowSize = nextWin === totalPts ? 0 : nextWin;
      tpState.panOffset = Math.max(0, totalPts - newEnd);
      renderThroughputTimeline();
    }, { passive: false });

    // Drag-to-pan horizontally across upload history
    wrap.addEventListener('mousedown', (e) => {
      // Allow native CSS bottom-right resize handle to work unimpeded
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

    // Hover crosshair + Drag-pan movement
    wrap.addEventListener('mousemove', (e) => {
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
async function fetchStorageMetrics() {
  try {
    const res = await fetch('/api/storage/metrics');
    const data = await res.json();

    if (!data.connected) return;

    if (document.getElementById('stat-storage-files')) {
      document.getElementById('stat-storage-files').textContent = (data.total_files || 0).toLocaleString();
    }
    if (document.getElementById('stat-storage-size')) {
      document.getElementById('stat-storage-size').textContent = `${data.total_size_gb || 0} GB`;
    }
    if (document.getElementById('stat-storage-dirs')) {
      document.getElementById('stat-storage-dirs').textContent = (data.total_directories || 0).toLocaleString();
    }
    if (document.getElementById('topo-storage-stat')) {
      document.getElementById('topo-storage-stat').textContent = `${(data.total_files || 0).toLocaleString()} files · ${data.total_size_gb || 0} GB`;
    }

    // Priority Tiers
    const tiersContainer = document.getElementById('priority-tiers-container');
    if (tiersContainer && data.priority_tiers) {
      tiersContainer.innerHTML = data.priority_tiers.map(t => {
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
      }).join('');
    }

    // Storage rules
    const rulesContainer = document.getElementById('storage-rules-container');
    if (rulesContainer && data.rules) {
      rulesContainer.innerHTML = data.rules.map(r => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong>${r.name}: ${r.device_pattern || '*'}</strong>
            <p style="font-family: var(--font-mono); font-size: 0.75rem; color: #7dd3fc;">Path: ${r.path_pattern} ➔ ${r.priority_tier}</p>
            <p style="font-size: 0.75rem; color: #94a3b8;">${r.description || ''}</p>
          </div>
        </div>
      `).join('');
    }

    // Large files
    const filesContainer = document.getElementById('large-files-container');
    if (filesContainer && data.recent_files) {
      filesContainer.innerHTML = data.recent_files.map(f => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;">${f.name}</strong>
            <span style="font-size: 0.75rem; color: #94a3b8;">Category: ${f.category} (${f.ext})</span>
          </div>
          <span class="badge badge-sm badge-blue">${f.size_mb} MB</span>
        </div>
      `).join('');
    }

  } catch (err) {
    console.error('Storage metrics error:', err);
  }
}

// 4. IDrive Metrics
async function fetchIDriveMetrics() {
  try {
    const res = await fetch('/api/idrive/metrics');
    const data = await res.json();

    if (document.getElementById('topo-idrive-stat')) {
      document.getElementById('topo-idrive-stat').textContent = `device_registry.db: ${data.devices?.length || 4} devices`;
    }

    if (document.getElementById('stat-evs-api-calls')) {
      document.getElementById('stat-evs-api-calls').textContent = (data.api_calls_count || 859).toLocaleString();
    }

    // Cookie status
    const cookieText = document.getElementById('idrive-cookie-status-text');
    if (cookieText) {
      if (data.cookie_valid) {
        cookieText.innerHTML = `<span style="color: #34d399;">Active session cookie found in repository. EVS queries ready.</span>`;
      } else {
        cookieText.innerHTML = `<span style="color: #f87171;">No active .idrive_cookie detected. Open idrive.com web console, copy EVSID & JSESSIONID to enable cloud restores.</span>`;
      }
    }

    // Devices grid
    const devicesContainer = document.getElementById('idrive-devices-container');
    if (devicesContainer && data.devices) {
      document.getElementById('badge-device-count').textContent = `${data.devices.length} Devices`;
      devicesContainer.innerHTML = data.devices.map(d => `
        <div class="topo-pillar">
          <div class="topo-icon icon-cyan">💻</div>
          <h4>${d.name}</h4>
          <p style="font-family: var(--font-mono); font-size: 0.75rem;">Type: ${d.type} · ${d.capacity_tb} TB</p>
          <div class="topo-db-stat">Last Seen: ${d.last_seen ? d.last_seen.split(' ')[0] : 'Recorded'}</div>
        </div>
      `).join('');
    }

    // Policies & priorities
    const policiesContainer = document.getElementById('idrive-policies-container');
    if (policiesContainer && data.policies) {
      policiesContainer.innerHTML = data.policies.map(p => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong>Policy #${p.policy_id}: ${p.policy_name}</strong>
          </div>
          <span class="badge badge-sm badge-cyan">Active</span>
        </div>
      `).join('');
    }

  } catch (err) {
    console.error('IDrive metrics error:', err);
  }
}

// 5. Gmail Metrics
async function fetchGmailMetrics() {
  try {
    const res = await fetch('/api/gmail/metrics');
    const data = await res.json();

    const statusBadge = document.getElementById('badge-gmail-status');
    const statusText = document.getElementById('gmail-auth-status-text');
    if (statusBadge && statusText) {
      statusBadge.textContent = data.auth_status;
      if (data.has_token) {
        statusBadge.className = 'badge badge-green';
        statusText.textContent = 'token.json verified. Gmail API read scopes authorized for scan and suggestions.';
      } else if (data.has_credentials) {
        statusBadge.className = 'badge badge-amber';
        statusText.textContent = 'credentials.json configured. Run report to initiate OAuth consent flow.';
      } else {
        statusBadge.className = 'badge badge-outline';
        statusText.textContent = 'Please place credentials.json in gmail-cleanup-planner to enable OAuth.';
      }
    }

    // Rule families
    const familiesContainer = document.getElementById('rule-families-container');
    if (familiesContainer && data.rule_families) {
      familiesContainer.innerHTML = data.rule_families.map(rf => `
        <div class="rule-family-card">
          <strong style="color: ${rf.color};">${rf.name}</strong>
          <div class="domain-tags">
            ${rf.domains.map(d => `<span class="domain-tag">${d}</span>`).join('')}
          </div>
        </div>
      `).join('');
    }

    // Existing rules
    const rulesContainer = document.getElementById('gmail-rules-container');
    if (rulesContainer && data.existing_rules) {
      rulesContainer.innerHTML = data.existing_rules.map(r => `
        <div class="step-item mb-2">
          <div class="step-info">
            <strong>${r.name}</strong>
            <p style="font-family: var(--font-mono); font-size: 0.75rem; color: #fbbf24;">${r.query}</p>
          </div>
          <span class="badge badge-sm badge-purple">${r.action}</span>
        </div>
      `).join('');
    }

  } catch (err) {
    console.error('Gmail metrics error:', err);
  }
}

// 6. Reports Inspector
async function fetchReportsList() {
  try {
    const res = await fetch('/api/reports/list');
    const data = await res.json();

    const navList = document.getElementById('reports-nav-list');
    const countBadge = document.getElementById('reports-count-badge');
    if (countBadge) countBadge.textContent = data.reports?.length || 0;

    if (navList && data.reports) {
      navList.innerHTML = data.reports.map(r => `
        <div class="report-item" data-id="${r.id}" onclick="window.loadReport('${r.id}', '${r.title}', '${r.filename}')">
          <span class="report-item-title">${r.title}</span>
          <span class="badge badge-sm badge-outline">${r.size_kb} KB</span>
        </div>
      `).join('');

      if (data.reports.length > 0) {
        window.loadReport(data.reports[0].id, data.reports[0].title, data.reports[0].filename);
      }
    }
  } catch (err) {
    console.error('Error fetching reports:', err);
  }
}

window.loadReport = async function(id, title, filename) {
  document.querySelectorAll('.report-item').forEach(item => {
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
function setupConsoleControls() {
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

  // Action cards click listener
  document.querySelectorAll('.action-card').forEach(card => {
    card.addEventListener('click', () => {
      const action = card.dataset.action;
      if (action) {
        window.triggerTask(action);
      }
    });
  });
}

let activeTaskCallbacks = {
  taskId: null,
  executionId: null,
  openConsole: true,
  onLog: null,
  onDone: null
};
let isMergeRunning = false;
let activeMergeExecutionId = null;

window.triggerTask = async function(taskId, args = null, openConsole = true, onLog = null, onDone = null) {
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
    connectWebSocket(activeExecutionId);
    return activeExecutionId;

  } catch (err) {
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

function connectWebSocket(executionId) {
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
        // Fallback detection in case done frame was dropped:
        const match = data.text && data.text.match(/\[COMPLETED\] Process exited with code (\d+)/);
        if (match) {
          const code = parseInt(match[1], 10);
          if (activeTaskCallbacks.openConsole) {
            document.getElementById('btn-kill-task').style.display = 'none';
            document.getElementById('active-task-badge').style.display = 'none';
            const label = document.getElementById('console-task-label');
            if (label) label.textContent = 'Completed';
          }
          if (activeTaskCallbacks.onDone) {
            activeTaskCallbacks.onDone(code);
          }
        }
      } else if (data.type === 'done') {
        if (activeTaskCallbacks.openConsole) {
          appendConsoleLog(`\n[COMPLETE] Task finished with exit code ${data.exit_code}\n`);
          document.getElementById('btn-kill-task').style.display = 'none';
          document.getElementById('active-task-badge').style.display = 'none';
          const label = document.getElementById('console-task-label');
          if (label) label.textContent = 'Completed';
        }
        if (activeTaskCallbacks.onDone) {
          activeTaskCallbacks.onDone(data.exit_code);
        }
        // Refresh metrics upon completion
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

function appendConsoleLog(text) {
  const output = document.getElementById('console-output');
  if (output) {
    const span = document.createElement('span');
    span.textContent = text;
    output.appendChild(span);
    output.scrollTop = output.scrollHeight;
  }
}

// 8. Modals
function setupModals() {
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

  const triageInput = document.getElementById('triage-input-path');
  attachPathSanitizer(triageInput);

  btnConfirmTriage?.addEventListener('click', () => {
    const rawPath = document.getElementById('triage-input-path')?.value;
    const intakePath = cleanPath(rawPath);
    modalTriage?.classList.remove('open');
    window.triggerTask('media_triage', intakePath ? ['--intake-dir', intakePath] : null);
  });

  // Cookie help button
  document.getElementById('btn-cookie-help')?.addEventListener('click', () => {
    alert(
      "How to Refresh IDrive Session Cookie:\n\n" +
      "1. Log into your account on https://www.idrive.com\n" +
      "2. Open Chrome DevTools (F12) -> Application -> Cookies\n" +
      "3. Copy the 'EVSID' and 'JSESSIONID' cookies\n" +
      "4. Save them in submodules/idrive-audit/.idrive_cookie as:\n" +
      "   EVSID=...; JSESSIONID=..."
    );
  });
}

// ==========================================================================
// 9. Utilities Tab: Directory Merge Tool & merge_directories.log Viewer
// ==========================================================================

// Helper: Trim surrounding single or double quotes (e.g. from Finder "Copy ... as Pathname")
function cleanPath(p) {
  if (!p) return '';
  let str = p.trim();
  // Strip outer quotes repeatedly if nested
  while ((str.startsWith("'") && str.endsWith("'")) || (str.startsWith('"') && str.endsWith('"'))) {
    str = str.slice(1, -1).trim();
  }
  // Strip any remaining lone quotes at start or end
  str = str.replace(/^['"]+|['"]+$/g, '').trim();
  return str;
}

// Attach paste and blur sanitizers to text inputs to automatically strip Finder quotes
function attachPathSanitizer(inputEl, onSanitized = null) {
  if (!inputEl) return;

  const sanitize = () => {
    const raw = inputEl.value;
    const cleaned = cleanPath(raw);
    if (raw !== cleaned) {
      inputEl.value = cleaned;
      if (onSanitized) onSanitized();
    }
  };

  inputEl.addEventListener('paste', (e) => {
    const pasteText = (e.clipboardData || window.clipboardData)?.getData('text');
    if (pasteText && (pasteText.includes("'") || pasteText.includes('"'))) {
      e.preventDefault();
      const cleaned = cleanPath(pasteText);
      const start = inputEl.selectionStart ?? 0;
      const end = inputEl.selectionEnd ?? inputEl.value.length;
      const currentVal = inputEl.value;
      inputEl.value = currentVal.substring(0, start) + cleaned + currentVal.substring(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + cleaned.length;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  inputEl.addEventListener('input', () => {
    const val = inputEl.value.trim();
    if ((val.startsWith("'") && val.endsWith("'") && val.length > 1) ||
        (val.startsWith('"') && val.endsWith('"') && val.length > 1)) {
      inputEl.value = cleanPath(val);
    }
  });

  inputEl.addEventListener('blur', sanitize);
}

let mergeLogTail = 250;
let mergeLogAutoRefresh = true;
let mergeLogFilter = '';
let mergeLogPollingInterval = null;
let cachedMergeLogLines = [];
let dirValidationTimer = null;

function setupUtilities() {
  const srcInput = document.getElementById('merge-source-dir');
  const dstInput = document.getElementById('merge-dest-dir');
  const swapBtn = document.getElementById('btn-merge-swap-dirs');
  const modeRadios = document.querySelectorAll('input[name="merge-mode"]');
  const collisionSelect = document.getElementById('merge-collision-strategy');
  const dryRunCheck = document.getElementById('merge-flag-dry-run');
  const noCleanCheck = document.getElementById('merge-flag-no-clean');
  const executeBtn = document.getElementById('btn-merge-execute');
  const dryRunBtn = document.getElementById('btn-merge-dry-run');
  const cancelBtn = document.getElementById('btn-merge-cancel');
  const refreshLogBtn = document.getElementById('btn-merge-log-refresh');
  const refreshAllBtn = document.getElementById('btn-utilities-refresh-all');
  const scrollBottomBtn = document.getElementById('btn-merge-log-scroll-bottom');
  const filterInput = document.getElementById('merge-log-filter-input');
  const autoRefreshCheck = document.getElementById('merge-log-autorefresh-toggle');

  // Clear path buttons
  document.querySelectorAll('.btn-clear-input[data-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-clear');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.value = '';
        updateMergeCommandPreview();
        triggerDirectoryValidation();
      }
    });
  });

  // Swap Source and Destination paths
  swapBtn?.addEventListener('click', () => {
    if (!srcInput || !dstInput) return;
    const temp = srcInput.value;
    srcInput.value = dstInput.value;
    dstInput.value = temp;
    updateMergeCommandPreview();
    triggerDirectoryValidation();
  });

  // Input changes trigger preview & debounced validation
  [srcInput, dstInput].forEach(el => {
    el?.addEventListener('input', () => {
      updateMergeCommandPreview();
      triggerDirectoryValidation();
    });
  });

  // Automatically sanitize Finder copied paths on paste, input, and blur
  attachPathSanitizer(srcInput, () => {
    updateMergeCommandPreview();
    triggerDirectoryValidation();
  });
  attachPathSanitizer(dstInput, () => {
    updateMergeCommandPreview();
    triggerDirectoryValidation();
  });

  modeRadios.forEach(r => r.addEventListener('change', updateMergeCommandPreview));
  collisionSelect?.addEventListener('change', updateMergeCommandPreview);
  dryRunCheck?.addEventListener('change', updateMergeCommandPreview);
  noCleanCheck?.addEventListener('change', updateMergeCommandPreview);

  // Execute Merge
  executeBtn?.addEventListener('click', () => {
    runDirectoryMerge(false);
  });

  // Dry Run Preview
  dryRunBtn?.addEventListener('click', () => {
    runDirectoryMerge(true);
  });

  // Cancel / Stop Merge
  cancelBtn?.addEventListener('click', async () => {
    if (activeMergeExecutionId) {
      try {
        await fetch(`/api/runner/kill/${activeMergeExecutionId}`, { method: 'POST' });
      } catch (err) {
        console.warn('Kill task request error:', err);
      }
    }
    const cancelMsg = `${new Date().toISOString().replace('T', ' ').substring(0, 19)} [merge_directories] - 🛑 Directory Merge stopped by user.`;
    cachedMergeLogLines.push(cancelMsg);
    appendLiveMergeLogLine(cancelMsg);
    handleMergeDone(-2);
  });

  // Log Tail buttons
  document.querySelectorAll('[data-log-tail]').forEach(btn => {
    btn.addEventListener('click', () => {
      mergeLogTail = Number(btn.getAttribute('data-log-tail')) || 250;
      document.querySelectorAll('[data-log-tail]').forEach(b => b.classList.toggle('active', b === btn));
      fetchMergeLog();
    });
  });

  // Log filter input
  filterInput?.addEventListener('input', (e) => {
    mergeLogFilter = (e.target.value || '').trim().toLowerCase();
    renderFilteredMergeLog();
  });

  // Auto-refresh toggle
  autoRefreshCheck?.addEventListener('change', (e) => {
    mergeLogAutoRefresh = e.target.checked;
    if (mergeLogAutoRefresh) {
      startMergeLogPolling();
    } else {
      stopMergeLogPolling();
    }
  });

  // Refresh buttons
  refreshLogBtn?.addEventListener('click', () => fetchMergeLog());
  refreshAllBtn?.addEventListener('click', () => fetchMergeLog());

  // Scroll to bottom
  scrollBottomBtn?.addEventListener('click', scrollMergeLogToBottom);

  // Initial preview
  updateMergeCommandPreview();
}

function updateMergeCommandPreview() {
  const srcInput = document.getElementById('merge-source-dir');
  const dstInput = document.getElementById('merge-dest-dir');
  const modeVal = document.querySelector('input[name="merge-mode"]:checked')?.value || 'move';
  const collisionVal = document.getElementById('merge-collision-strategy')?.value || 'rename';
  const dryRunChecked = document.getElementById('merge-flag-dry-run')?.checked || false;
  const noCleanChecked = document.getElementById('merge-flag-no-clean')?.checked || false;
  const previewEl = document.getElementById('merge-cmd-preview');

  const src = cleanPath(srcInput?.value || '') || '[source]';
  const dst = cleanPath(dstInput?.value || '') || '[destination]';

  const parts = ['python3', 'scripts/merge_directories.py', `"${src}"`, `"${dst}"`];
  if (modeVal === 'copy') parts.push('--copy');
  if (collisionVal !== 'rename') parts.push(`--on-collision ${collisionVal}`);
  if (dryRunChecked) parts.push('--dry-run');
  if (noCleanChecked) parts.push('--no-clean');

  if (previewEl) {
    previewEl.innerHTML = `Command: <code>${parts.join(' ')}</code>`;
  }
}

function triggerDirectoryValidation() {
  clearTimeout(dirValidationTimer);
  dirValidationTimer = setTimeout(async () => {
    const src = cleanPath(document.getElementById('merge-source-dir')?.value || '');
    const dst = cleanPath(document.getElementById('merge-dest-dir')?.value || '');
    const srcStatus = document.getElementById('merge-source-status');
    const dstStatus = document.getElementById('merge-dest-status');

    if (!src && !dst) {
      if (srcStatus) srcStatus.innerHTML = '';
      if (dstStatus) dstStatus.innerHTML = '';
      return;
    }

    try {
      const res = await fetch('/api/utilities/validate-directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: src, destination: dst })
      });
      const data = await res.json();

      if (srcStatus) {
        if (!src) {
          srcStatus.innerHTML = '';
        } else if (data.source.exists && data.source.is_dir) {
          srcStatus.className = 'form-dir-status status-ok';
          srcStatus.innerHTML = '✓ Valid directory' + (data.source.readable ? ' (Readable)' : '');
        } else if (data.source.exists && !data.source.is_dir) {
          srcStatus.className = 'form-dir-status status-err';
          srcStatus.innerHTML = '⚠️ Path is a file, not a directory';
        } else {
          srcStatus.className = 'form-dir-status status-warn';
          srcStatus.innerHTML = '⚠️ Directory not found or volume not mounted';
        }
      }

      if (dstStatus) {
        if (!dst) {
          dstStatus.innerHTML = '';
        } else if (data.same_directory) {
          dstStatus.className = 'form-dir-status status-err';
          dstStatus.innerHTML = '❌ Destination cannot be identical to Source directory';
        } else if (data.destination.exists && data.destination.is_dir) {
          dstStatus.className = 'form-dir-status status-ok';
          dstStatus.innerHTML = '✓ Existing directory' + (data.destination.writable ? ' (Writable)' : '');
        } else if (data.destination.parent_exists) {
          dstStatus.className = 'form-dir-status status-warn';
          dstStatus.innerHTML = 'ℹ️ Directory will be automatically created upon merge';
        } else {
          dstStatus.className = 'form-dir-status status-warn';
          dstStatus.innerHTML = '⚠️ Parent path not found or volume unmounted';
        }
      }
    } catch (err) {
      console.warn('Directory validation error:', err);
    }
  }, 400);
}

function formatLogLine(line) {
  const escaped = escapeHtml(line);
  if (line.includes('🚀 Starting Directory Merge:') || line.includes('🚀 Dispatching Directory Merge:')) {
    return `<span style="color: #38bdf8; font-weight: 600;">${escaped}</span>`;
  }
  if (line.includes('✅ Merge Finished') || line.includes('✅ Removed')) {
    return `<span style="color: #34d399; font-weight: 600;">${escaped}</span>`;
  }
  if (line.includes('❌') || line.includes('ERROR') || line.includes('Permission denied')) {
    return `<span style="color: #f87171; font-weight: 600;">${escaped}</span>`;
  }
  if (line.includes('Progress:')) {
    return `<span style="color: #c084fc;">${escaped}</span>`;
  }
  if (line.includes('🧹 Cleaning') || line.includes('🛑 Directory Merge')) {
    return `<span style="color: #fbbf24;">${escaped}</span>`;
  }
  if (line.includes('📂 Found')) {
    return `<span style="color: #60a5fa;">${escaped}</span>`;
  }
  return `<span>${escaped}</span>`;
}

function appendLiveMergeLogLine(line) {
  const preEl = document.getElementById('merge-log-pre');
  if (!preEl) return;

  if (preEl.innerHTML.includes('Loading merge_directories.log...')) {
    preEl.innerHTML = '';
  }

  const spanHtml = formatLogLine(line);
  if (!preEl.innerHTML.trim()) {
    preEl.innerHTML = spanHtml;
  } else {
    preEl.innerHTML += '\n' + spanHtml;
  }
  scrollMergeLogToBottom();

  const linesBadge = document.getElementById('merge-log-lines-badge');
  if (linesBadge) {
    linesBadge.textContent = `${cachedMergeLogLines.length} lines shown`;
  }
}

let activeMergePollInterval = null;

function handleMergeDone(exitCode) {
  if (!isMergeRunning) return;
  isMergeRunning = false;
  if (activeMergePollInterval) {
    clearInterval(activeMergePollInterval);
    activeMergePollInterval = null;
  }

  const executeBtn = document.getElementById('btn-merge-execute');
  const dryRunBtn = document.getElementById('btn-merge-dry-run');
  const cancelBtn = document.getElementById('btn-merge-cancel');
  const stateBadge = document.getElementById('merge-tool-state-badge');

  if (executeBtn) {
    executeBtn.disabled = false;
    executeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Start Directory Merge`;
  }
  if (dryRunBtn) dryRunBtn.disabled = false;
  if (cancelBtn) cancelBtn.style.display = 'none';

  if (stateBadge) {
    if (exitCode === 0) {
      stateBadge.className = 'badge badge-green font-mono';
      stateBadge.textContent = 'Completed';
    } else if (exitCode === -2) {
      stateBadge.className = 'badge badge-red font-mono';
      stateBadge.textContent = 'Stopped';
    } else {
      stateBadge.className = 'badge badge-red font-mono';
      stateBadge.textContent = `Failed (Exit ${exitCode})`;
    }
  }

  setTimeout(() => {
    fetchMergeLog(false);
    scrollMergeLogToBottom();
  }, 400);
}

function runDirectoryMerge(forceDryRun = false) {
  if (isMergeRunning) {
    return;
  }

  const srcInput = document.getElementById('merge-source-dir');
  const dstInput = document.getElementById('merge-dest-dir');
  const modeVal = document.querySelector('input[name="merge-mode"]:checked')?.value || 'move';
  const collisionVal = document.getElementById('merge-collision-strategy')?.value || 'rename';
  const dryRunChecked = forceDryRun || (document.getElementById('merge-flag-dry-run')?.checked || false);
  const noCleanChecked = document.getElementById('merge-flag-no-clean')?.checked || false;
  const stateBadge = document.getElementById('merge-tool-state-badge');
  const executeBtn = document.getElementById('btn-merge-execute');
  const dryRunBtn = document.getElementById('btn-merge-dry-run');
  const cancelBtn = document.getElementById('btn-merge-cancel');

  const src = cleanPath(srcInput?.value || '');
  const dst = cleanPath(dstInput?.value || '');

  // Reflect cleaned path back to inputs if quotes were present
  if (srcInput && srcInput.value !== src) srcInput.value = src;
  if (dstInput && dstInput.value !== dst) dstInput.value = dst;

  if (!src) {
    alert('Please specify a Source Directory to merge.');
    srcInput?.focus();
    return;
  }
  if (!dst) {
    alert('Please specify a Destination Directory to merge into.');
    dstInput?.focus();
    return;
  }
  if (src === dst) {
    alert('Source Directory and Destination Directory cannot be the same folder.');
    return;
  }

  const args = [src, dst];
  if (modeVal === 'copy') {
    args.push('--copy');
  } else {
    args.push('--move');
  }

  if (collisionVal && collisionVal !== 'rename') {
    args.push('--on-collision', collisionVal);
  }

  if (dryRunChecked) {
    args.push('--dry-run');
  }

  if (noCleanChecked) {
    args.push('--no-clean');
  }

  isMergeRunning = true;

  if (stateBadge) {
    stateBadge.className = 'badge badge-amber pulse font-mono';
    stateBadge.textContent = dryRunChecked ? 'Simulating...' : 'Merging...';
  }

  if (executeBtn) {
    executeBtn.disabled = true;
    executeBtn.innerHTML = `<span style="display:inline-block;animation:spin 1s linear infinite;margin-right:6px;">⏳</span> ${dryRunChecked ? 'Simulating in progress...' : 'Merging in progress...'}`;
  }
  if (dryRunBtn) dryRunBtn.disabled = true;
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const startMsg = `${timestamp} [merge_directories] - 🚀 Dispatching Directory Merge: ${src} -> ${dst} [Mode: ${modeVal}, Collision: ${collisionVal}, DryRun: ${dryRunChecked}]`;
  cachedMergeLogLines.push(startMsg);
  appendLiveMergeLogLine(startMsg);

  // Rapid polling during execution (every 1s) to pick up disk updates & verify process status
  if (activeMergePollInterval) {
    clearInterval(activeMergePollInterval);
  }
  activeMergePollInterval = setInterval(async () => {
    fetchMergeLog(true);

    if (isMergeRunning && activeMergeExecutionId) {
      try {
        const sRes = await fetch(`/api/runner/status/${activeMergeExecutionId}`);
        if (sRes.ok) {
          const sData = await sRes.json();
          if (!sData.running && sData.exit_code !== null) {
            handleMergeDone(sData.exit_code);
          }
        }
      } catch (err) {
        console.warn('Status poll error:', err);
      }
    }
  }, 1000);

  window.triggerTask(
    'media_merge_directories',
    args,
    false, // Do not open console drawer!
    (logText) => {
      // Live output streamed from stdout
      const lines = logText.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        if (!cachedMergeLogLines.includes(line)) {
          cachedMergeLogLines.push(line);
          appendLiveMergeLogLine(line);
        }
      }
    },
    (exitCode) => {
      handleMergeDone(exitCode);
    }
  ).then(execId => {
    activeMergeExecutionId = execId;
  });
}

async function fetchMergeLog(isBackgroundRefresh = false) {
  try {
    const res = await fetch(`/api/utilities/merge-log?tail_lines=${mergeLogTail}`);
    const data = await res.json();

    const sizeBadge = document.getElementById('merge-log-size-badge');
    const modBadge = document.getElementById('merge-log-mod-badge');
    const linesBadge = document.getElementById('merge-log-lines-badge');
    const stateBadge = document.getElementById('merge-tool-state-badge');

    if (sizeBadge) sizeBadge.textContent = data.size_formatted || '0 B';
    if (modBadge) modBadge.textContent = data.modified ? `Updated: ${data.modified.split(' ')[1] || data.modified}` : '—';
    if (linesBadge) linesBadge.textContent = `${(data.lines || []).length} lines shown`;

    if (data.exists && stateBadge && !isMergeRunning && !stateBadge.classList.contains('pulse')) {
      stateBadge.className = 'badge badge-green font-mono';
      stateBadge.textContent = 'Ready';
    }

    const diskLines = data.lines || [];
    if (diskLines.length > 0) {
      if (!isMergeRunning || !isBackgroundRefresh) {
        cachedMergeLogLines = diskLines;
        renderFilteredMergeLog();
        scrollMergeLogToBottom();
      } else {
        // While running, append any newly flushed disk lines not yet cached
        let added = false;
        for (const line of diskLines) {
          if (!cachedMergeLogLines.includes(line)) {
            cachedMergeLogLines.push(line);
            appendLiveMergeLogLine(line);
            added = true;
          }
        }
        if (added) scrollMergeLogToBottom();

        // Extra safety: If disk log has finished message, ensure running UI state finishes
        const lastLine = diskLines[diskLines.length - 1] || '';
        if (lastLine.includes('✅ Merge Finished in') || lastLine.includes('❌ Source directory does not exist')) {
          handleMergeDone(lastLine.includes('❌') ? 1 : 0);
        }
      }
    }
  } catch (err) {
    console.error('Error fetching merge log:', err);
  }
}

function renderFilteredMergeLog() {
  const preEl = document.getElementById('merge-log-pre');
  if (!preEl) return;

  if (!cachedMergeLogLines.length) {
    preEl.innerHTML = '<span style="color: var(--text-muted);">No log entries recorded yet in logs/merge_directories.log.</span>';
    return;
  }

  let lines = cachedMergeLogLines;
  if (mergeLogFilter) {
    lines = lines.filter(l => l.toLowerCase().includes(mergeLogFilter));
  }

  if (!lines.length) {
    preEl.innerHTML = `<span style="color: var(--text-muted);">No log lines matched filter: "${escapeHtml(mergeLogFilter)}"</span>`;
    return;
  }

  preEl.innerHTML = lines.map(line => formatLogLine(line)).join('\n');
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function scrollMergeLogToBottom() {
  const wrap = document.getElementById('merge-log-wrapper');
  if (wrap) {
    wrap.scrollTop = wrap.scrollHeight;
  }
}

function startMergeLogPolling() {
  if (!mergeLogPollingInterval) {
    mergeLogPollingInterval = setInterval(() => {
      const utilPanel = document.getElementById('tab-utilities');
      if (utilPanel?.classList.contains('active') && mergeLogAutoRefresh) {
        fetchMergeLog(true);
      }
    }, 3000);
  }
}

function stopMergeLogPolling() {
  if (mergeLogPollingInterval) {
    clearInterval(mergeLogPollingInterval);
    mergeLogPollingInterval = null;
  }
}

// ==========================================================================
// 12. Media Cleanup & Storage Reclaim (Mode [C] UI Organizer)
// ==========================================================================

let cleanupDevicesData = null;
let selectedCleanupDevice = null;
let activeDeviceScope = 'active'; // 'active' (default) | 'all'
let activeOwnerFilter = 'all';
let activeQuartileFilter = 'all';
let activeTypeFilter = 'all';
let cleanupPageLimit = 50;
let cleanupPageOffset = 0;
let currentCandidateList = [];
let selectedCandidateAssetIds = new Set();
let candidateAssetMeta = new Map(); // asset_id -> full candidate object
let pendingRemovalAssetIds = [];
let previewModalAssetId = null;
let isFetchingCleanupDevices = false;
let isFetchingCleanupCandidates = false;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDuration(seconds) {
  const sec = Number(seconds);
  if (!sec || sec <= 0) return '0:00';
  const totalSec = Math.round(sec);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const remSec = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  }
  return `${mins}:${String(remSec).padStart(2, '0')}`;
}

function formatCaptureTimestampParts(tsStr) {
  if (!tsStr || tsStr === '—') {
    return { dateLine: '—', timeLine: '' };
  }
  const parts = tsStr.trim().split(' ');
  const datePart = parts[0] || tsStr;
  const timePart = parts[1] || '';

  // Try to format readable date e.g. "2025-02-16" -> "Feb 16, 2025 (2025-02-16)"
  let readableDate = datePart;
  const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monIdx = parseInt(m[2], 10) - 1;
    if (months[monIdx]) {
      readableDate = `${months[monIdx]} ${parseInt(m[3], 10)}, ${m[1]}`;
    }
  }
  return {
    dateLine: readableDate,
    isoDate: datePart,
    timeLine: timePart ? `${timePart} (${datePart})` : datePart
  };
}

function setupMediaCleanup() {
  // 0. Active vs. All Devices Scope Toggle
  document.querySelectorAll('.cleanup-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextScope = btn.dataset.deviceScope || 'active';
      if (activeDeviceScope === nextScope) return;
      activeDeviceScope = nextScope;

      document.querySelectorAll('.cleanup-scope-btn').forEach(b => {
        b.classList.toggle('active', (b.dataset.deviceScope || 'active') === activeDeviceScope);
      });

      activeOwnerFilter = 'all';
      updateCleanupScopeSummaryBadges();
      renderCleanupOwnerChips();
      renderCleanupDevicesList();

      // Ensure a valid device in the current scope is selected
      const visibleDevices = getDevicesInActiveScope();
      const stillVisible = selectedCleanupDevice && visibleDevices.some(
        d => d.camera_model === selectedCleanupDevice.camera_model && d.owner === selectedCleanupDevice.owner
      );
      if (!stillVisible && visibleDevices.length > 0) {
        let topDev = visibleDevices[0];
        visibleDevices.forEach(d => {
          if ((d.low_gb || 0) > (topDev.low_gb || 0)) topDev = d;
        });
        selectCleanupDevice(topDev);
      }
    });
  });

  // 1. Device search filter
  const searchInput = document.getElementById('cleanup-device-search');
  searchInput?.addEventListener('input', () => {
    renderCleanupDevicesList();
  });

  // 2. Refresh button
  document.getElementById('btn-refresh-cleanup')?.addEventListener('click', () => {
    fetchCleanupDevices(true);
  });

  // 3. Quartile filter buttons
  document.querySelectorAll('.cleanup-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cleanup-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeQuartileFilter = btn.dataset.quartile || 'all';
      cleanupPageOffset = 0;
      fetchCleanupCandidates();
    });
  });

  // 4. Media type filter buttons
  document.querySelectorAll('.cleanup-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cleanup-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTypeFilter = btn.dataset.type || 'all';
      cleanupPageOffset = 0;
      fetchCleanupCandidates();
    });
  });

  // 5. Select All Checkbox
  const selectAllCb = document.getElementById('cleanup-select-all-checkbox');
  selectAllCb?.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    currentCandidateList.forEach(c => {
      if (isChecked) {
        selectedCandidateAssetIds.add(c.asset_id);
      } else {
        selectedCandidateAssetIds.delete(c.asset_id);
      }
    });

    // Update row states
    document.querySelectorAll('.cleanup-asset-checkbox').forEach(cb => {
      cb.checked = isChecked;
      const tr = cb.closest('tr');
      if (tr) {
        if (isChecked) tr.classList.add('selected');
        else tr.classList.remove('selected');
      }
    });

    updateCleanupSelectionBar();
  });

  // 6. Bulk Action: Mark Selected as Removed
  document.getElementById('btn-mark-selected-removed')?.addEventListener('click', () => {
    if (!selectedCandidateAssetIds.size) return;
    openCleanupConfirmModal(Array.from(selectedCandidateAssetIds));
  });

  // 7. Modal confirm button
  document.getElementById('btn-execute-cleanup-removal')?.addEventListener('click', () => {
    executeCleanupRemoval();
  });

  // 8. Preview Modal Mark as Removed button
  document.getElementById('btn-preview-mark-removed')?.addEventListener('click', () => {
    if (!previewModalAssetId) return;
    const aid = previewModalAssetId;
    closeCleanupPreviewModal();
    openCleanupConfirmModal([aid]);
  });

  // Close preview modal when clicking backdrop
  document.getElementById('modal-cleanup-preview')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-cleanup-preview') {
      closeCleanupPreviewModal();
    }
  });

  // 9. Pagination buttons
  document.getElementById('btn-cleanup-prev-page')?.addEventListener('click', () => {
    if (cleanupPageOffset <= 0) return;
    cleanupPageOffset = Math.max(0, cleanupPageOffset - cleanupPageLimit);
    fetchCleanupCandidates();
  });

  document.getElementById('btn-cleanup-next-page')?.addEventListener('click', () => {
    cleanupPageOffset += cleanupPageLimit;
    fetchCleanupCandidates();
  });
}

function getDevicesInActiveScope() {
  if (!cleanupDevicesData || !cleanupDevicesData.owners) return [];
  const list = [];
  cleanupDevicesData.owners.forEach(o => {
    (o.devices || []).forEach(d => {
      if (activeDeviceScope === 'active' && !d.is_active) return;
      list.push(d);
    });
  });
  return list;
}

function updateCleanupScopeSummaryBadges() {
  if (!cleanupDevicesData) return;
  const summary = cleanupDevicesData.summary || {};

  const reclaimableBadge = document.getElementById('cleanup-badge-reclaimable');
  const candidatesBadge = document.getElementById('cleanup-badge-candidates');
  const devicesBadge = document.getElementById('cleanup-badge-devices');
  const paneTitle = document.getElementById('cleanup-pane-scope-title');
  const countPill = document.getElementById('cleanup-device-count-pill');
  const scopeCountActive = document.getElementById('scope-count-active');
  const scopeCountAll = document.getElementById('scope-count-all');

  if (scopeCountActive) scopeCountActive.textContent = summary.active_devices ?? 0;
  if (scopeCountAll) scopeCountAll.textContent = summary.total_devices ?? 0;

  if (activeDeviceScope === 'active') {
    const actGb = summary.active_low_gb ?? 0;
    const actCnt = summary.active_low_count ?? 0;
    const actDev = summary.active_devices ?? 0;
    if (reclaimableBadge) reclaimableBadge.textContent = `${actGb} GB Reclaimable (Active)`;
    if (candidatesBadge) candidatesBadge.textContent = `${actCnt.toLocaleString()} Active Low-Quality Files`;
    if (devicesBadge) devicesBadge.textContent = `${actDev} Active Devices`;
    if (paneTitle) paneTitle.textContent = '🟢 Active Devices by Owner';
    if (countPill) countPill.textContent = `${actDev} Active`;
  } else {
    const allGb = summary.grand_low_gb ?? 0;
    const allCnt = summary.grand_low_count ?? 0;
    const allDev = summary.total_devices ?? 0;
    if (reclaimableBadge) reclaimableBadge.textContent = `${allGb} GB Reclaimable (All)`;
    if (candidatesBadge) candidatesBadge.textContent = `${allCnt.toLocaleString()} Low-Quality Files`;
    if (devicesBadge) devicesBadge.textContent = `${allDev} Total Devices`;
    if (paneTitle) paneTitle.textContent = '📚 All Devices by Owner';
    if (countPill) countPill.textContent = `${allDev} Devices`;
  }
}

async function fetchCleanupDevices(forceRefresh = false) {
  if (isFetchingCleanupDevices) return;
  isFetchingCleanupDevices = true;

  const reclaimableBadge = document.getElementById('cleanup-badge-reclaimable');
  const updatedLabel = document.getElementById('cleanup-last-updated');
  const listEl = document.getElementById('cleanup-devices-list');

  if (forceRefresh && reclaimableBadge) {
    reclaimableBadge.textContent = 'Calculating...';
  }

  try {
    const res = await fetch(`/api/media/cleanup/devices${forceRefresh ? '?refresh=true' : ''}`);
    const data = await res.json();

    if (!data.connected) {
      if (listEl) {
        listEl.innerHTML = `
          <div class="text-muted text-center" style="padding: 2rem 1rem; font-size: 0.85rem;">
            ⚠️ Media database unavailable. Check SQLite path.
          </div>
        `;
      }
      return;
    }

    cleanupDevicesData = data;
    const summary = data.summary || {};

    // If there are no active devices in DB, fallback to 'all'
    if (activeDeviceScope === 'active' && (summary.active_devices || 0) === 0) {
      activeDeviceScope = 'all';
      document.querySelectorAll('.cleanup-scope-btn').forEach(b => {
        b.classList.toggle('active', (b.dataset.deviceScope || 'active') === activeDeviceScope);
      });
    }

    updateCleanupScopeSummaryBadges();

    if (updatedLabel) {
      updatedLabel.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }

    renderCleanupOwnerChips();
    renderCleanupDevicesList();

    // If a device was previously selected, refresh its details if still in scope
    const scopedDevices = getDevicesInActiveScope();
    if (selectedCleanupDevice) {
      const found = scopedDevices.find(
        d => d.camera_model === selectedCleanupDevice.camera_model && d.owner === selectedCleanupDevice.owner
      );
      if (found) {
        selectedCleanupDevice = found;
        updateSelectedDeviceKPIs(found);
      } else if (scopedDevices.length > 0) {
        let topDevice = scopedDevices[0];
        scopedDevices.forEach(d => {
          if ((d.low_gb || 0) > (topDevice.low_gb || 0)) topDevice = d;
        });
        selectCleanupDevice(topDevice);
      }
    } else if (scopedDevices.length > 0) {
      // Auto-select device with highest storage reclaim in current scope
      let topDevice = scopedDevices[0];
      scopedDevices.forEach(d => {
        if ((d.low_gb || 0) > (topDevice.low_gb || 0)) topDevice = d;
      });
      selectCleanupDevice(topDevice);
    }
  } catch (err) {
    console.error('Error fetching cleanup devices:', err);
    if (listEl) {
      listEl.innerHTML = `
        <div class="text-muted text-center" style="padding: 2rem 1rem; font-size: 0.85rem;">
          ❌ Failed to load devices: ${escapeHtml(err.message || 'Network error')}
        </div>
      `;
    }
  } finally {
    isFetchingCleanupDevices = false;
  }
}

function renderCleanupOwnerChips() {
  const container = document.getElementById('cleanup-owner-chips');
  if (!container || !cleanupDevicesData) return;

  const summary = cleanupDevicesData.summary || {};
  const totalScopedDev = activeDeviceScope === 'active'
    ? (summary.active_devices || 0)
    : (summary.total_devices || 0);

  let html = `
    <button class="cleanup-chip ${activeOwnerFilter === 'all' ? 'active' : ''}" data-owner="all">
      All Owners (${totalScopedDev})
    </button>
  `;

  (cleanupDevicesData.owners || []).forEach(o => {
    const scopedDevs = (o.devices || []).filter(d => activeDeviceScope === 'all' || d.is_active);
    if (!scopedDevs.length) return;
    const isAct = activeOwnerFilter === o.owner_name;
    html += `
      <button class="cleanup-chip ${isAct ? 'active' : ''}" data-owner="${escapeHtml(o.owner_name)}">
        ${escapeHtml(o.owner_name)} (${scopedDevs.length})
      </button>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll('.cleanup-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.cleanup-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeOwnerFilter = chip.dataset.owner || 'all';
      renderCleanupDevicesList();
    });
  });
}

function renderCleanupDevicesList() {
  const listEl = document.getElementById('cleanup-devices-list');
  if (!listEl || !cleanupDevicesData) return;

  const searchTerm = (document.getElementById('cleanup-device-search')?.value || '').trim().toLowerCase();
  const owners = cleanupDevicesData.owners || [];

  let filteredOwners = owners;
  if (activeOwnerFilter !== 'all') {
    filteredOwners = filteredOwners.filter(o => o.owner_name === activeOwnerFilter);
  }

  let html = '';
  let totalVisibleDevices = 0;

  filteredOwners.forEach(o => {
    let devices = (o.devices || []).filter(d => activeDeviceScope === 'all' || d.is_active);
    if (searchTerm) {
      devices = devices.filter(d => 
        d.camera_model.toLowerCase().includes(searchTerm) || 
        o.owner_name.toLowerCase().includes(searchTerm)
      );
    }

    if (!devices.length) return;
    totalVisibleDevices += devices.length;

    const ownerReclaimGb = devices.reduce((acc, d) => acc + (d.low_gb || 0), 0);

    html += `
      <div class="cleanup-owner-group">
        <div class="cleanup-owner-header">
          <span class="cleanup-owner-name">
            <span>👤</span> ${escapeHtml(o.owner_name)}
          </span>
          <span class="badge badge-xs badge-amber font-mono">${ownerReclaimGb.toFixed(2)} GB reclaimable</span>
        </div>
        <div class="cleanup-owner-devices">
    `;

    devices.forEach(d => {
      const isSelected = selectedCleanupDevice &&
        selectedCleanupDevice.camera_model === d.camera_model &&
        selectedCleanupDevice.owner === d.owner;
      const pct = d.total_count > 0 ? Math.min(100, Math.round((d.low_count / d.total_count) * 100)) : 50;
      const activeDot = d.is_active
        ? `<span class="cleanup-device-active-dot" title="Active Device (since ${escapeHtml(d.start_date || 'current')})"></span>`
        : '';

      html += `
        <div class="cleanup-device-item ${isSelected ? 'active' : ''}" data-model="${escapeHtml(d.camera_model)}" data-owner="${escapeHtml(d.owner)}">
          <div class="cleanup-device-header-row">
            <span class="cleanup-device-name" title="${escapeHtml(d.camera_model)}">
              ${activeDot}
              ${escapeHtml(d.camera_model)}
            </span>
            <span class="badge badge-xs badge-amber font-mono">${d.low_gb.toFixed(2)} GB</span>
          </div>
          <div class="cleanup-device-subrow">
            <span>${d.low_count.toLocaleString()} / ${d.total_count.toLocaleString()} files (${pct}%)</span>
            <span class="font-mono">Q2 ≤ ${d.q2_max_score.toFixed(4)}</span>
          </div>
          <div class="cleanup-device-progress-bg">
            <div class="cleanup-device-progress-fill" style="width: ${pct}%;"></div>
          </div>
        </div>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  if (!totalVisibleDevices) {
    html = `
      <div class="text-muted text-center" style="padding: 2.5rem 1rem; font-size: 0.85rem;">
        No ${activeDeviceScope === 'active' ? 'active ' : ''}devices found${searchTerm ? ` matching "${escapeHtml(searchTerm)}"` : ''}.
      </div>
    `;
  }

  listEl.innerHTML = html;

  // Add click handlers
  listEl.querySelectorAll('.cleanup-device-item').forEach(item => {
    item.addEventListener('click', () => {
      const model = item.dataset.model;
      const owner = item.dataset.owner;
      let matchedDev = null;
      for (const o of (cleanupDevicesData.owners || [])) {
        for (const d of (o.devices || [])) {
          if (d.camera_model === model && d.owner === owner) {
            matchedDev = d;
            break;
          }
        }
        if (matchedDev) break;
      }
      if (matchedDev) {
        selectCleanupDevice(matchedDev);
      }
    });
  });
}

function updateSelectedDeviceKPIs(device) {
  const kpisContainer = document.getElementById('cleanup-detail-kpis');
  const kpiGb = document.getElementById('cleanup-kpi-device-gb');
  const kpiCount = document.getElementById('cleanup-kpi-device-count');
  const kpiMaxScore = document.getElementById('cleanup-kpi-device-max-score');

  if (kpisContainer) kpisContainer.style.display = 'flex';
  if (kpiGb) kpiGb.textContent = `${device.low_gb.toFixed(2)} GB`;
  if (kpiCount) kpiCount.textContent = `${device.low_count.toLocaleString()} files`;
  if (kpiMaxScore) kpiMaxScore.textContent = `≤ ${device.q2_max_score.toFixed(4)}`;
}

function selectCleanupDevice(device) {
  selectedCleanupDevice = device;

  // Highlight in list
  document.querySelectorAll('.cleanup-device-item').forEach(item => {
    if (item.dataset.model === device.camera_model && item.dataset.owner === device.owner) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update detail view header
  const titleName = document.getElementById('cleanup-detail-device-name');
  const ownerBadge = document.getElementById('cleanup-detail-owner-badge');
  const activeBadge = document.getElementById('cleanup-detail-active-badge');
  const subtitle = document.getElementById('cleanup-detail-subtitle');
  const toolbar = document.getElementById('cleanup-toolbar');
  const placeholder = document.getElementById('cleanup-empty-placeholder');
  const table = document.getElementById('cleanup-candidates-table');
  const paginationBar = document.getElementById('cleanup-pagination-bar');

  if (titleName) titleName.textContent = device.camera_model;
  if (ownerBadge) {
    ownerBadge.textContent = device.owner;
    ownerBadge.style.display = 'inline-block';
  }
  if (activeBadge) {
    activeBadge.style.display = device.is_active ? 'inline-block' : 'none';
  }
  if (subtitle) {
    const dateSpan = device.start_date
      ? ` (Active since ${device.start_date}${device.end_date ? ` to ${device.end_date}` : ''})`
      : '';
    subtitle.textContent = `Reviewing bottom 2 quartiles (Q1 & Q2) for ${device.owner}${dateSpan} — ordered largest-to-smallest.`;
  }

  updateSelectedDeviceKPIs(device);

  if (toolbar) toolbar.style.display = 'flex';
  if (placeholder) placeholder.style.display = 'none';
  if (table) table.style.display = 'table';
  if (paginationBar) paginationBar.style.display = 'flex';

  cleanupPageOffset = 0;
  selectedCandidateAssetIds.clear();
  updateCleanupSelectionBar();

  fetchCleanupCandidates();
}

async function fetchCleanupCandidates() {
  if (!selectedCleanupDevice) return;
  if (isFetchingCleanupCandidates) return;
  isFetchingCleanupCandidates = true;

  const tbody = document.getElementById('cleanup-candidates-tbody');
  const paginationInfo = document.getElementById('cleanup-pagination-info');
  const pageNumberLabel = document.getElementById('cleanup-page-number');
  const prevBtn = document.getElementById('btn-cleanup-prev-page');
  const nextBtn = document.getElementById('btn-cleanup-next-page');

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="text-center text-muted" style="padding: 3rem 1rem;">
          <div class="spinner-sm mb-2" style="margin: 0 auto;"></div>
          Scanning bottom 2 quartiles for <strong>${escapeHtml(selectedCleanupDevice.camera_model)}</strong>...
        </td>
      </tr>
    `;
  }

  try {
    const params = new URLSearchParams({
      camera_model: selectedCleanupDevice.camera_model,
      owner: selectedCleanupDevice.owner || 'all',
      quartile: activeQuartileFilter,
      media_type: activeTypeFilter,
      limit: cleanupPageLimit.toString(),
      offset: cleanupPageOffset.toString()
    });

    const res = await fetch(`/api/media/cleanup/candidates?${params.toString()}`);
    const data = await res.json();

    if (!data.ok) {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="11" class="text-center text-muted" style="padding: 2.5rem 1rem;">
              ⚠️ Error loading candidates: ${escapeHtml(data.error || 'Unknown error')}
            </td>
          </tr>
        `;
      }
      return;
    }

    currentCandidateList = data.candidates || [];
    currentCandidateList.forEach(c => {
      candidateAssetMeta.set(c.asset_id, {
        ...c,
        filename: c.original_filename,
        bytes: c.file_size_bytes,
        mb: c.file_size_mb,
        model: c.camera_model
      });
    });

    const totalCount = data.total_count || 0;
    const totalGb = data.total_gb || 0;

    if (!currentCandidateList.length) {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="11" class="text-center text-muted" style="padding: 3.5rem 1rem;">
              <span style="font-size: 1.5rem; display: block; margin-bottom: 0.4rem;">🎉</span>
              No candidate assets found for <strong>${escapeHtml(selectedCleanupDevice.camera_model)}</strong> with current filters.
            </td>
          </tr>
        `;
      }
    } else {
      let rowsHtml = '';
      currentCandidateList.forEach((c, idx) => {
        const isChecked = selectedCandidateAssetIds.has(c.asset_id);
        const rowNum = cleanupPageOffset + idx + 1;
        const ext = (c.original_filename.split('.').pop() || '').toUpperCase();
        const isVideo = c.media_type === 'video';

        const thumbUrl = `/api/media/cleanup/thumbnail/${encodeURIComponent(c.asset_id)}`;
        const thumbPlayIcon = isVideo ? `<span class="cleanup-thumb-play">▶</span>` : '';
        const previewThumbHtml = `
          <div class="cleanup-thumb-wrap" data-preview-asset-id="${c.asset_id}" title="Click to preview ${escapeHtml(c.original_filename)}">
            <img class="cleanup-thumb-img" src="${thumbUrl}" alt="${escapeHtml(c.original_filename)}" loading="lazy" />
            ${thumbPlayIcon}
            <span class="cleanup-thumb-badge">${escapeHtml(ext)}</span>
          </div>
        `;

        const resSub = (c.width && c.height)
          ? `<div class="candidate-res-sub">${c.width}×${c.height}${c.fps > 0 ? ` · ${Math.round(c.fps)}fps` : ''}</div>`
          : '';

        const tsParts = formatCaptureTimestampParts(c.capture_timestamp || c.date_created_utc);
        const captureTsHtml = `
          <div class="candidate-capture-ts" title="Exact capture timestamp: ${escapeHtml(c.capture_timestamp || c.date_created_utc)}">
            <span class="candidate-capture-date">${escapeHtml(tsParts.dateLine)}</span>
            <span class="candidate-capture-time">🕒 ${escapeHtml(tsParts.timeLine || c.month || '—')}</span>
          </div>
        `;

        const durationHtml = isVideo
          ? `<span class="candidate-duration-pill" title="Video duration: ${c.duration_sec}s">⏱️ ${formatDuration(c.duration_sec)}</span>`
          : `<span class="text-muted font-mono" style="font-size: 0.71rem;">Still</span>`;

        const sizeFormatted = c.file_size_mb >= 1024
          ? `${(c.file_size_mb / 1024).toFixed(2)} GB`
          : `${c.file_size_mb.toFixed(1)} MB`;

        const quartileBadge = c.score_quartile === 1
          ? `<span class="badge badge-xs cleanup-badge-q1 font-mono">Q1 (Lowest)</span>`
          : `<span class="badge badge-xs cleanup-badge-q2 font-mono">Q2 (Low)</span>`;

        let momentHtml = '<span class="text-muted">—</span>';
        if (c.last_asset_pub) {
          momentHtml = `<span class="badge badge-xs badge-green" title="Published: ${escapeHtml(c.last_asset_pub)}">✅ ${escapeHtml(c.last_asset_pub.substring(0, 10))}</span>`;
        } else if (c.assigned_moment && c.assigned_moment !== '—') {
          const shortMom = c.assigned_moment.length > 20 ? c.assigned_moment.substring(0, 20) + '…' : c.assigned_moment;
          momentHtml = `<span class="badge badge-xs badge-outline font-mono" title="${escapeHtml(c.assigned_moment)}">${escapeHtml(shortMom)}</span>`;
        }

        rowsHtml += `
          <tr class="${isChecked ? 'selected' : ''}" data-asset-id="${c.asset_id}">
            <td style="text-align: center;">
              <input type="checkbox" class="cleanup-asset-checkbox" data-asset-id="${c.asset_id}" ${isChecked ? 'checked' : ''} />
            </td>
            <td style="text-align: center; font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted);">${rowNum}</td>
            <td>${previewThumbHtml}</td>
            <td class="candidate-filename" title="${escapeHtml(c.original_filename)}">
              <div>${escapeHtml(c.original_filename)}</div>
              ${resSub}
            </td>
            <td>${captureTsHtml}</td>
            <td style="text-align: right;">${durationHtml}</td>
            <td style="text-align: right;">
              <strong class="text-amber font-mono" style="font-size: 0.78rem;">${sizeFormatted}</strong>
            </td>
            <td style="text-align: center;">${quartileBadge}</td>
            <td style="text-align: right; font-family: var(--font-mono); font-size: 0.73rem; color: var(--text-secondary);">
              ${c.score_normalized.toFixed(4)}
            </td>
            <td>${momentHtml}</td>
            <td style="text-align: center; white-space: nowrap;">
              <button class="btn btn-xs btn-outline btn-cleanup-preview" data-asset-id="${c.asset_id}" title="Preview media & full device details">
                👁️
              </button>
              <button class="btn btn-xs btn-outline btn-cleanup-single-remove" data-asset-id="${c.asset_id}" title="Mark this asset as removed from source">
                🗑️ Remove
              </button>
            </td>
          </tr>
        `;
      });

      if (tbody) tbody.innerHTML = rowsHtml;
    }

    // Attach row checkbox handlers
    tbody?.querySelectorAll('.cleanup-asset-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const aid = cb.dataset.assetId;
        const tr = cb.closest('tr');
        if (e.target.checked) {
          selectedCandidateAssetIds.add(aid);
          tr?.classList.add('selected');
        } else {
          selectedCandidateAssetIds.delete(aid);
          tr?.classList.remove('selected');
        }
        updateCleanupSelectionBar();
      });
    });

    // Attach thumbnail and preview button handlers
    tbody?.querySelectorAll('[data-preview-asset-id], .btn-cleanup-preview').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const aid = el.dataset.previewAssetId || el.dataset.assetId;
        if (aid) openCleanupPreviewModal(aid);
      });
    });

    // Attach row remove button handlers
    tbody?.querySelectorAll('.btn-cleanup-single-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const aid = btn.dataset.assetId;
        openCleanupConfirmModal([aid]);
      });
    });

    // Update pagination controls
    const fromIdx = totalCount > 0 ? cleanupPageOffset + 1 : 0;
    const toIdx = Math.min(cleanupPageOffset + cleanupPageLimit, totalCount);
    if (paginationInfo) {
      paginationInfo.textContent = `Showing ${fromIdx}–${toIdx} of ${totalCount.toLocaleString()} candidates (${totalGb.toFixed(2)} GB)`;
    }

    const curPage = Math.floor(cleanupPageOffset / cleanupPageLimit) + 1;
    const totalPages = Math.ceil(totalCount / cleanupPageLimit) || 1;
    if (pageNumberLabel) {
      pageNumberLabel.textContent = `Page ${curPage} of ${totalPages}`;
    }

    if (prevBtn) prevBtn.disabled = cleanupPageOffset <= 0;
    if (nextBtn) nextBtn.disabled = cleanupPageOffset + cleanupPageLimit >= totalCount;

    updateCleanupSelectionBar();
  } catch (err) {
    console.error('Error fetching cleanup candidates:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="11" class="text-center text-muted" style="padding: 2.5rem 1rem;">
            ❌ Network error loading candidates.
          </td>
        </tr>
      `;
    }
  } finally {
    isFetchingCleanupCandidates = false;
  }
}

function openCleanupPreviewModal(assetId) {
  const c = candidateAssetMeta.get(assetId);
  if (!c) return;

  previewModalAssetId = assetId;
  const modal = document.getElementById('modal-cleanup-preview');
  const stage = document.getElementById('cleanup-preview-stage');
  if (!modal || !stage) return;

  const isVideo = c.media_type === 'video';
  const ext = (c.original_filename.split('.').pop() || '').toUpperCase();
  const sizeStr = c.file_size_mb >= 1024
    ? `${(c.file_size_mb / 1024).toFixed(2)} GB`
    : `${c.file_size_mb.toFixed(1)} MB`;

  const titleEl = document.getElementById('cleanup-preview-title');
  const typeBadgeEl = document.getElementById('cleanup-preview-type-badge');
  const sizeBadgeEl = document.getElementById('cleanup-preview-size-badge');

  if (titleEl) titleEl.textContent = c.original_filename;
  if (typeBadgeEl) typeBadgeEl.textContent = isVideo ? `🎥 VIDEO (${ext})` : `📷 PHOTO (${ext})`;
  if (sizeBadgeEl) sizeBadgeEl.textContent = sizeStr;

  const thumbUrl = `/api/media/cleanup/thumbnail/${encodeURIComponent(assetId)}`;
  const previewUrl = `/api/media/cleanup/preview/${encodeURIComponent(assetId)}`;

  if (isVideo) {
    stage.innerHTML = `
      <video controls autoplay preload="metadata" poster="${thumbUrl}" src="${previewUrl}">
        Your browser does not support playback of this video format.
      </video>
    `;
  } else {
    stage.innerHTML = `
      <img src="${previewUrl}" alt="${escapeHtml(c.original_filename)}" />
    `;
  }

  const tsParts = formatCaptureTimestampParts(c.capture_timestamp || c.date_created_utc);
  const tsEl = document.getElementById('cleanup-preview-timestamp');
  const durEl = document.getElementById('cleanup-preview-duration');
  const resEl = document.getElementById('cleanup-preview-resolution');
  const devEl = document.getElementById('cleanup-preview-device');
  const scoreEl = document.getElementById('cleanup-preview-score');
  const momEl = document.getElementById('cleanup-preview-moment');
  const uuidEl = document.getElementById('cleanup-preview-uuid');

  if (tsEl) tsEl.textContent = `${tsParts.dateLine} · ${tsParts.timeLine || c.capture_timestamp}`;
  if (durEl) {
    durEl.textContent = isVideo
      ? `${formatDuration(c.duration_sec)} (${c.duration_sec}s · ${ext})`
      : `Still Photo (${ext})`;
  }
  if (resEl) {
    resEl.textContent = (c.width && c.height)
      ? `${c.width} × ${c.height} px${c.fps > 0 ? ` @ ${c.fps} fps` : ''}`
      : '—';
  }
  if (devEl) devEl.textContent = `${c.camera_model} (${c.primary_owner})`;
  if (scoreEl) scoreEl.textContent = `Q${c.score_quartile} · Score ${(c.score_normalized || 0).toFixed(4)}`;
  if (momEl) momEl.textContent = c.assigned_moment || '—';
  if (uuidEl) uuidEl.textContent = `Asset UUID: ${c.asset_id}`;

  modal.classList.add('open');
}

function closeCleanupPreviewModal() {
  const modal = document.getElementById('modal-cleanup-preview');
  const stage = document.getElementById('cleanup-preview-stage');
  if (stage) {
    const vid = stage.querySelector('video');
    if (vid) {
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
    }
    stage.innerHTML = '';
  }
  modal?.classList.remove('open');
  previewModalAssetId = null;
}

function updateCleanupSelectionBar() {
  const summaryEl = document.getElementById('cleanup-selection-summary');
  const btnMark = document.getElementById('btn-mark-selected-removed');
  const selectAllCb = document.getElementById('cleanup-select-all-checkbox');

  const count = selectedCandidateAssetIds.size;
  let totalBytes = 0;
  selectedCandidateAssetIds.forEach(aid => {
    const meta = candidateAssetMeta.get(aid);
    if (meta && meta.bytes) {
      totalBytes += meta.bytes;
    }
  });

  if (summaryEl) {
    summaryEl.textContent = `${count} selected (${formatBytes(totalBytes)})`;
  }

  if (btnMark) {
    btnMark.disabled = count === 0;
    btnMark.textContent = count > 0 
      ? `🗑️ Mark (${count}) as Removed` 
      : '🗑️ Mark Selected as Removed';
  }

  if (selectAllCb) {
    const allChecked = currentCandidateList.length > 0 && currentCandidateList.every(c => selectedCandidateAssetIds.has(c.asset_id));
    selectAllCb.checked = allChecked;
  }
}

function openCleanupConfirmModal(assetIds) {
  pendingRemovalAssetIds = assetIds;
  const modal = document.getElementById('modal-cleanup-confirm');
  if (!modal) return;

  const devNameEl = document.getElementById('cleanup-confirm-device-name');
  const countEl = document.getElementById('cleanup-confirm-count');
  const sizeEl = document.getElementById('cleanup-confirm-size');
  const previewEl = document.getElementById('cleanup-confirm-files-preview');

  let totalBytes = 0;
  const filenames = [];

  assetIds.forEach(aid => {
    const meta = candidateAssetMeta.get(aid);
    if (meta) {
      totalBytes += meta.bytes || 0;
      filenames.push(meta.filename);
    }
  });

  if (devNameEl) {
    devNameEl.textContent = selectedCleanupDevice ? selectedCleanupDevice.camera_model : '—';
  }
  if (countEl) {
    countEl.textContent = `${assetIds.length} asset${assetIds.length === 1 ? '' : 's'}`;
  }
  if (sizeEl) {
    sizeEl.textContent = formatBytes(totalBytes);
  }
  if (previewEl) {
    let previewHtml = '';
    const slice = filenames.slice(0, 6);
    slice.forEach(fn => {
      previewHtml += `<div>• ${escapeHtml(fn)}</div>`;
    });
    if (filenames.length > 6) {
      previewHtml += `<div class="text-muted" style="margin-top: 0.25rem;">... and ${filenames.length - 6} more file(s)</div>`;
    }
    previewEl.innerHTML = previewHtml || '<div>Asset UUID: ' + assetIds[0] + '</div>';
  }

  modal.classList.add('open');
}

async function executeCleanupRemoval() {
  if (!pendingRemovalAssetIds.length) return;

  const btnConfirm = document.getElementById('btn-execute-cleanup-removal');
  const modal = document.getElementById('modal-cleanup-confirm');

  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Removing...';
  }

  try {
    const res = await fetch('/api/media/cleanup/mark-removed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_ids: pendingRemovalAssetIds,
        action: 'remove'
      })
    });
    const data = await res.json();

    if (!data.ok) {
      alert(`Failed to mark assets as removed: ${data.error || 'Server error'}`);
      return;
    }

    // Success! Remove the marked asset IDs from selection
    pendingRemovalAssetIds.forEach(aid => {
      selectedCandidateAssetIds.delete(aid);
    });

    modal?.classList.remove('open');

    // Refresh candidate table and device summary
    await fetchCleanupCandidates();
    fetchCleanupDevices(true);
  } catch (err) {
    console.error('Error executing cleanup removal:', err);
    alert(`Network error marking assets as removed: ${err.message || 'Unknown error'}`);
  } finally {
    if (btnConfirm) {
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'Confirm & Mark Removed';
    }
    pendingRemovalAssetIds = [];
  }
}

// ==========================================================================
// 13. Planner Mode Overview: [B] Batch Management | [M] Memory & Publishing
// ==========================================================================

let plannerOverviewData = null;
let isFetchingPlannerOverview = false;

function setupPlannerOverview() {
  // Mode view tabs (All | [B] | [M] | [C])
  document.querySelectorAll('.planner-mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.planner-mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const view = tab.dataset.modeView || 'all';
      const grid = document.getElementById('planner-modes-grid');
      const cardB = document.getElementById('planner-mode-b-card');
      const cardM = document.getElementById('planner-mode-m-card');
      const cardC = document.getElementById('media-cleanup-card');

      if (view === 'all') {
        if (grid) {
          grid.style.display = 'grid';
          grid.classList.remove('single-col');
        }
        if (cardB) cardB.style.display = 'flex';
        if (cardM) cardM.style.display = 'flex';
        if (cardC) cardC.style.display = 'block';
      } else if (view === 'b') {
        if (grid) {
          grid.style.display = 'grid';
          grid.classList.add('single-col');
        }
        if (cardB) cardB.style.display = 'flex';
        if (cardM) cardM.style.display = 'none';
        if (cardC) cardC.style.display = 'none';
      } else if (view === 'm') {
        if (grid) {
          grid.style.display = 'grid';
          grid.classList.add('single-col');
        }
        if (cardB) cardB.style.display = 'none';
        if (cardM) cardM.style.display = 'flex';
        if (cardC) cardC.style.display = 'none';
      } else if (view === 'c') {
        if (grid) grid.style.display = 'none';
        if (cardC) {
          cardC.style.display = 'block';
          cardC.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });

  document.getElementById('btn-refresh-planner-overview')?.addEventListener('click', () => {
    fetchPlannerOverview();
  });

  // Load initial planner overview data
  fetchPlannerOverview();
}

async function fetchPlannerOverview() {
  if (isFetchingPlannerOverview) return;
  isFetchingPlannerOverview = true;

  try {
    const res = await fetch('/api/media/planner-overview');
    const data = await res.json();

    if (!data.connected) return;
    plannerOverviewData = data;

    const updatedEl = document.getElementById('planner-overview-updated');
    if (updatedEl) {
      updatedEl.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }

    renderModeBOverview(data.mode_b || {});
    renderModeMOverview(data.mode_m || {});
  } catch (err) {
    console.error('Error fetching planner overview:', err);
  } finally {
    isFetchingPlannerOverview = false;
  }
}

function renderModeBOverview(modeB) {
  const sb = modeB.status_breakdown || {};
  const qList = modeB.active_queue || [];
  const c400 = modeB.manual_400_candidates || [];
  const c500 = modeB.pipeline_500_candidates || [];
  const c000 = modeB.pipeline_000_candidates || [];
  const primary = modeB.primary_suggestion || null;

  // Header & Stage Strip counters
  const qPill = document.getElementById('mode-b-queue-pill');
  const compPill = document.getElementById('mode-b-completed-pill');
  if (qPill) {
    qPill.textContent = qList.length > 0
      ? `${qList.length} Queued (${qList.map(q => q.month).join(', ')})`
      : '0 Queued';
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

  if (document.getElementById('mode-b-cnt-000')) {
    document.getElementById('mode-b-cnt-000').textContent = `${cnt000} batches (${assets000.toLocaleString()})`;
  }
  if (document.getElementById('mode-b-cnt-400')) {
    document.getElementById('mode-b-cnt-400').textContent = `${cnt400} batches (${assets400.toLocaleString()})`;
  }
  if (document.getElementById('mode-b-cnt-500')) {
    document.getElementById('mode-b-cnt-500').textContent = `${cnt500} batches (${assets500.toLocaleString()})`;
  }
  if (document.getElementById('mode-b-cnt-650')) {
    document.getElementById('mode-b-cnt-650').textContent = `${cnt650} batches (${assets650.toLocaleString()})`;
  }

  // Primary Suggested Action Banner
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
      b400Tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No batches currently awaiting manual Google Photos curation (400).</td></tr>';
    } else {
      b400Tbody.innerHTML = c400.map(item => {
        const favBadge = item.fav_assets > 0
          ? `<span class="badge badge-xs badge-green font-mono">⭐ ${item.fav_assets}</span>`
          : `<span class="text-muted font-mono">0</span>`;
        const elapsedStr = item.elapsed_days !== null ? ` (${item.elapsed_days}d ago)` : '';
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
      }).join('');
    }
  }

  // 2. Pipeline 500 -> 550 -> 600 -> 650 Table
  const b500Badge = document.getElementById('mode-b-500-badge');
  const b500Tbody = document.getElementById('mode-b-500-tbody');
  if (b500Badge) b500Badge.textContent = `${c500.length} batch${c500.length === 1 ? '' : 'es'}`;

  if (b500Tbody) {
    if (!c500.length) {
      b500Tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No batches at stage 500 waiting for favorites pull & ranking.</td></tr>';
    } else {
      b500Tbody.innerHTML = c500.map(item => {
        const favBadge = item.fav_assets > 0
          ? `<span class="badge badge-xs badge-green font-mono">⭐ ${item.fav_assets}</span>`
          : (item.is_bypassed ? `<span class="badge badge-xs badge-outline">Bypassed</span>` : `<span class="text-muted font-mono">0</span>`);
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
      }).join('');
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
      b000Tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No unprocessed 000 batches remaining.</td></tr>';
    } else {
      b000Tbody.innerHTML = c000.map(item => {
        const actionBtn = item.in_queue
          ? `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'remove_queue')">✓ Queued (Remove)</button>`
          : `<button class="btn btn-xs btn-outline" onclick="window.runPlannerBatchAction('${escapeHtml(item.month)}', 'queue')" title="Queue ${escapeHtml(item.month)} for Verify, Export & Google Upload">➕ Queue (000➜399)</button>`;

        return `
          <tr>
            <td><strong class="font-mono text-primary">${escapeHtml(item.month)}</strong></td>
            <td><span class="badge badge-xs badge-outline font-mono">${escapeHtml(item.status_code)}</span></td>
            <td style="text-align: right;" class="font-mono">${item.total_assets.toLocaleString()}</td>
            <td class="font-mono" style="font-size: 0.7rem; color: var(--text-muted);">000 ➜ 100 ➜ 200 ➜ 210 ➜ 399 (Upload)</td>
            <td style="text-align: right; white-space: nowrap;">${actionBtn}</td>
          </tr>
        `;
      }).join('');
    }
  }
}

function renderModeMOverview(modeM) {
  const th = modeM.threshold || {};
  const sc = modeM.stage_counts || {};
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

  // Stage Strip
  if (document.getElementById('mode-m-cnt-sync')) {
    document.getElementById('mode-m-cnt-sync').textContent = `${needsSync.length} moment${needsSync.length === 1 ? '' : 's'}`;
  }
  if (document.getElementById('mode-m-cnt-m400')) {
    document.getElementById('mode-m-cnt-m400').textContent = `${sc.M400 || 0} moments`;
  }
  if (document.getElementById('mode-m-cnt-m450')) {
    document.getElementById('mode-m-cnt-m450').textContent = `${sc.M450 || 0} moments`;
  }
  if (document.getElementById('mode-m-cnt-m500')) {
    document.getElementById('mode-m-cnt-m500').textContent = `${sc.M500 || 0} moments`;
  }

  // Primary Banner for Mode [M]
  const headlineEl = document.getElementById('mode-m-primary-headline');
  const detailEl = document.getElementById('mode-m-primary-detail');

  if (needsSync.length > 0) {
    const names = needsSync.map(m => m.moment_name).join(', ');
    if (headlineEl) {
      headlineEl.textContent = `Step 1: Sync ${needsSync.length} Moment(s) Requiring Curation Updates (${names}) ➜ Step 2: Publish Top ${recs.length} Ready Moments`;
    }
    if (detailEl) {
      detailEl.textContent = `👉 Run Option [1] to sync new qualified assets to ToBeCurated in Apple Photos, or publish top ready candidate: ${recs[0] ? `${recs[0].moment_name} (${recs[0].action})` : '—'}`;
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
      syncMomentsHtml = `<div style="margin-top: 0.35rem;">🔄 <strong>Moments Requiring Option [1] Sync to <code>ToBeCurated</code>:</strong> ` +
        needsSync.map(m => `<span class="badge badge-xs badge-amber font-mono">${escapeHtml(m.moment_name)} (${m.stage} · ${m.assets} assets · Rank ${m.rank_score.toFixed(2)})</span>`).join(' ') +
        `</div>`;
    } else {
      syncMomentsHtml = `<div style="margin-top: 0.3rem;" class="text-muted">All qualified assets are synced to <code>ToBeCurated</code> or <code>Curated</code>.</div>`;
    }
    syncBox.innerHTML = thText + syncMomentsHtml;
  }

  // Step 2: Top Actionable Recommendations Table
  const recBadge = document.getElementById('mode-m-rec-badge');
  const recTbody = document.getElementById('mode-m-recs-tbody');
  if (recBadge) recBadge.textContent = `${recs.length} actionable`;

  if (recTbody) {
    if (!recs.length) {
      recTbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No actionable publishing recommendations found in log.</td></tr>';
    } else {
      recTbody.innerHTML = recs.map(r => {
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
      }).join('');
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
      disjTbody.innerHTML = disjoint.map(d => `
        <tr>
          <td><strong class="text-primary">${escapeHtml(d.moment_name)}</strong></td>
          <td style="text-align: right;" class="font-mono">${d.avg_score.toFixed(4)}</td>
          <td style="text-align: right;" class="font-mono">${d.files}</td>
          <td style="font-size: 0.72rem; color: var(--accent-amber);">${escapeHtml(d.details)}</td>
        </tr>
      `).join('');
    }
  }
}

window.runPlannerBatchAction = async function(month, action) {
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
    fetchExecutorMonitor();
  } catch (err) {
    console.error('Error running planner batch action:', err);
    alert(`Network error: ${err.message || 'Unknown error'}`);
  }
};
