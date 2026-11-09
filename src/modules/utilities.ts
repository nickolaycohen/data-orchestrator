// ==========================================================================
// Utilities Tab: Directory Merge Tool & merge_directories.log Viewer
// ==========================================================================

import { attachPathSanitizer, cleanPath, escapeHtml } from '../utils/formatters.ts';

let isMergeRunning = false;
let activeMergeExecutionId: string | null = null;
let mergeLogTail = 250;
let mergeLogAutoRefresh = true;
let mergeLogFilter = '';
let mergeLogPollingInterval: ReturnType<typeof setInterval> | null = null;
let cachedMergeLogLines: string[] = [];
let dirValidationTimer: ReturnType<typeof setTimeout> | null = null;
let activeMergePollInterval: ReturnType<typeof setInterval> | null = null;

export function setupUtilities(): void {
  const srcInput = document.getElementById('merge-source-dir') as HTMLInputElement | null;
  const dstInput = document.getElementById('merge-dest-dir') as HTMLInputElement | null;
  const swapBtn = document.getElementById('btn-merge-swap-dirs');
  const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="merge-mode"]');
  const collisionSelect = document.getElementById('merge-collision-strategy') as HTMLSelectElement | null;
  const dryRunCheck = document.getElementById('merge-flag-dry-run') as HTMLInputElement | null;
  const noCleanCheck = document.getElementById('merge-flag-no-clean') as HTMLInputElement | null;
  const executeBtn = document.getElementById('btn-merge-execute') as HTMLButtonElement | null;
  const dryRunBtn = document.getElementById('btn-merge-dry-run') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('btn-merge-cancel') as HTMLButtonElement | null;
  const refreshLogBtn = document.getElementById('btn-merge-log-refresh');
  const refreshAllBtn = document.getElementById('btn-utilities-refresh-all');
  const scrollBottomBtn = document.getElementById('btn-merge-log-scroll-bottom');
  const filterInput = document.getElementById('merge-log-filter-input') as HTMLInputElement | null;
  const autoRefreshCheck = document.getElementById('merge-log-autorefresh-toggle') as HTMLInputElement | null;

  // Clear path buttons
  document.querySelectorAll<HTMLElement>('.btn-clear-input[data-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-clear');
      const targetEl = targetId ? (document.getElementById(targetId) as HTMLInputElement | null) : null;
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
  document.querySelectorAll<HTMLElement>('[data-log-tail]').forEach(btn => {
    btn.addEventListener('click', () => {
      mergeLogTail = Number(btn.getAttribute('data-log-tail')) || 250;
      document.querySelectorAll('[data-log-tail]').forEach(b => b.classList.toggle('active', b === btn));
      fetchMergeLog();
    });
  });

  // Log filter input
  filterInput?.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    mergeLogFilter = (target.value || '').trim().toLowerCase();
    renderFilteredMergeLog();
  });

  // Auto-refresh toggle
  autoRefreshCheck?.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    mergeLogAutoRefresh = target.checked;
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

function updateMergeCommandPreview(): void {
  const srcInput = document.getElementById('merge-source-dir') as HTMLInputElement | null;
  const dstInput = document.getElementById('merge-dest-dir') as HTMLInputElement | null;
  const modeVal = (document.querySelector('input[name="merge-mode"]:checked') as HTMLInputElement | null)?.value || 'move';
  const collisionVal = (document.getElementById('merge-collision-strategy') as HTMLSelectElement | null)?.value || 'rename';
  const dryRunChecked = (document.getElementById('merge-flag-dry-run') as HTMLInputElement | null)?.checked || false;
  const noCleanChecked = (document.getElementById('merge-flag-no-clean') as HTMLInputElement | null)?.checked || false;
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

function triggerDirectoryValidation(): void {
  if (dirValidationTimer) clearTimeout(dirValidationTimer);
  dirValidationTimer = setTimeout(async () => {
    const src = cleanPath((document.getElementById('merge-source-dir') as HTMLInputElement | null)?.value || '');
    const dst = cleanPath((document.getElementById('merge-dest-dir') as HTMLInputElement | null)?.value || '');
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

function formatLogLine(line: string): string {
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

function appendLiveMergeLogLine(line: string): void {
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

function handleMergeDone(exitCode: number): void {
  if (!isMergeRunning) return;
  isMergeRunning = false;
  if (activeMergePollInterval) {
    clearInterval(activeMergePollInterval);
    activeMergePollInterval = null;
  }

  const executeBtn = document.getElementById('btn-merge-execute') as HTMLButtonElement | null;
  const dryRunBtn = document.getElementById('btn-merge-dry-run') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('btn-merge-cancel') as HTMLButtonElement | null;
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

function runDirectoryMerge(forceDryRun = false): void {
  if (isMergeRunning) {
    return;
  }

  const srcInput = document.getElementById('merge-source-dir') as HTMLInputElement | null;
  const dstInput = document.getElementById('merge-dest-dir') as HTMLInputElement | null;
  const modeVal = (document.querySelector('input[name="merge-mode"]:checked') as HTMLInputElement | null)?.value || 'move';
  const collisionVal = (document.getElementById('merge-collision-strategy') as HTMLSelectElement | null)?.value || 'rename';
  const dryRunChecked = forceDryRun || ((document.getElementById('merge-flag-dry-run') as HTMLInputElement | null)?.checked || false);
  const noCleanChecked = (document.getElementById('merge-flag-no-clean') as HTMLInputElement | null)?.checked || false;
  const stateBadge = document.getElementById('merge-tool-state-badge');
  const executeBtn = document.getElementById('btn-merge-execute') as HTMLButtonElement | null;
  const dryRunBtn = document.getElementById('btn-merge-dry-run') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('btn-merge-cancel') as HTMLButtonElement | null;

  const src = cleanPath(srcInput?.value || '');
  const dst = cleanPath(dstInput?.value || '');

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

  const args: string[] = [src, dst];
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
    args as any,
    false,
    (logText: string) => {
      const lines = logText.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        if (!cachedMergeLogLines.includes(line)) {
          cachedMergeLogLines.push(line);
          appendLiveMergeLogLine(line);
        }
      }
    },
    (exitCode: number) => {
      handleMergeDone(exitCode);
    }
  ).then((execId: any) => {
    activeMergeExecutionId = execId;
  });
}

export async function fetchMergeLog(isBackgroundRefresh = false): Promise<void> {
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

    const diskLines: string[] = data.lines || [];
    if (diskLines.length > 0) {
      if (!isMergeRunning || !isBackgroundRefresh) {
        cachedMergeLogLines = diskLines;
        renderFilteredMergeLog();
        scrollMergeLogToBottom();
      } else {
        let added = false;
        for (const line of diskLines) {
          if (!cachedMergeLogLines.includes(line)) {
            cachedMergeLogLines.push(line);
            appendLiveMergeLogLine(line);
            added = true;
          }
        }
        if (added) scrollMergeLogToBottom();

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

function renderFilteredMergeLog(): void {
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

function scrollMergeLogToBottom(): void {
  const wrap = document.getElementById('merge-log-wrapper');
  if (wrap) {
    wrap.scrollTop = wrap.scrollHeight;
  }
}

export function startMergeLogPolling(): void {
  if (!mergeLogPollingInterval) {
    mergeLogPollingInterval = setInterval(() => {
      const utilPanel = document.getElementById('tab-utilities');
      if (utilPanel?.classList.contains('active') && mergeLogAutoRefresh) {
        fetchMergeLog(true);
      }
    }, 3000);
  }
}

export function stopMergeLogPolling(): void {
  if (mergeLogPollingInterval) {
    clearInterval(mergeLogPollingInterval);
    mergeLogPollingInterval = null;
  }
}

