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
      } else {
        if (mediaMonitorInterval) {
          clearInterval(mediaMonitorInterval);
          mediaMonitorInterval = null;
        }
      }

      if (tab.dataset.tab === 'reports') {
        fetchReportsList();
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

    // Featured moments list
    const momentsContainer = document.getElementById('featured-moments-list');
    if (momentsContainer && data.featured_moments) {
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
        execBadge.textContent = `🟢 ACTIVE (PID: ${data.executor.pid})`;
      } else if (data.executor.status === 'STALE') {
        execBadge.className = 'badge badge-sm badge-amber';
        execBadge.textContent = `🟡 STALE (PID: ${data.executor.pid})`;
      } else {
        execBadge.className = 'badge badge-sm badge-outline';
        execBadge.textContent = '⚪ IDLE (Not Executing)';
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

  } catch (err) {
    console.error('Executor monitor error:', err);
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

window.triggerTask = async function(taskId, args = null) {
  const drawer = document.getElementById('console-drawer');
  drawer?.classList.add('open');

  const label = document.getElementById('console-task-label');
  const btnKill = document.getElementById('btn-kill-task');
  const badgeActive = document.getElementById('active-task-badge');

  if (label) label.textContent = `Running: ${taskId}`;
  if (btnKill) btnKill.style.display = 'inline-flex';
  if (badgeActive) badgeActive.style.display = 'inline-block';

  appendConsoleLog(`\n[DISPATCH] Requesting execution: ${taskId}...\n`);

  try {
    const res = await fetch('/api/runner/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, args: args })
    });
    const data = await res.json();
    if (!res.ok) {
      appendConsoleLog(`[ERROR] ${data.detail || 'Failed to dispatch task'}\n`);
      if (btnKill) btnKill.style.display = 'none';
      if (badgeActive) badgeActive.style.display = 'none';
      return;
    }

    activeExecutionId = data.execution_id;
    connectWebSocket(activeExecutionId);

  } catch (err) {
    appendConsoleLog(`[ERROR] Network error starting task: ${err}\n`);
    if (btnKill) btnKill.style.display = 'none';
    if (badgeActive) badgeActive.style.display = 'none';
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
        appendConsoleLog(data.text);
      } else if (data.type === 'done') {
        appendConsoleLog(`\n[COMPLETE] Task finished with exit code ${data.exit_code}\n`);
        document.getElementById('btn-kill-task').style.display = 'none';
        document.getElementById('active-task-badge').style.display = 'none';
        document.getElementById('console-task-label').textContent = 'Completed';
        // Refresh metrics upon completion
        fetchAllMetrics();
      }
    } catch {
      appendConsoleLog(event.data);
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
    });
  });

  btnConfirmTriage?.addEventListener('click', () => {
    const intakePath = document.getElementById('triage-input-path')?.value;
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
