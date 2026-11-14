// ==========================================================================
// Media Cleanup & Storage Reclaim (Mode [C] UI Organizer)
// ==========================================================================

import type { CleanupCandidateAsset, CleanupDevice, CleanupDevicesResponse } from '../types/api.ts';
import {
  candidateAssetMeta,
  escapeHtml,
  formatAppleBytes,
  formatCaptureTimestampParts,
  formatDuration
} from '../utils/formatters.ts';

let cleanupDevicesData: CleanupDevicesResponse | null = null;
let selectedCleanupDevice: any = null;
let activeFamilyScope = 'family'; // 'family' (default) | 'all'
let activeDeviceScope = 'active'; // 'active' (default) | 'all'
let activeOwnerFilter = 'all';
let activeLocationFilter = 'possibly'; // 'possibly' | 'actually'
let activeQuartileFilter = 'all';
let activeTypeFilter = 'all';
let cleanupViewMode: 'iphone' | 'table' = 'iphone';
const cleanupPageLimit = 50;
let cleanupPageOffset = 0;
let currentCandidateList: CleanupCandidateAsset[] = [];
const selectedCandidateAssetIds = new Set<string>();
export interface PreviewGroupContext {
  assetIds: string[];
  groupLabel?: string;
}

let pendingRemovalAssetIds: string[] = [];
let previewModalAssetId: string | null = null;
let previewGroupAssetIds: string[] = [];
let previewGroupIndex = -1;
let previewGroupLabel: string | null = null;
let previewSortMode: 'timestamp' | 'score' = 'timestamp';
let isFetchingCleanupDevices = false;
let isFetchingCleanupCandidates = false;

export function hasCleanupDevicesLoaded(): boolean {
  return Boolean(cleanupDevicesData);
}

function syncSelectedDeviceToScope(): void {
  const visibleDevices = getDevicesInActiveScope();
  const stillVisible =
    selectedCleanupDevice &&
    visibleDevices.some(
      d => d.camera_model === selectedCleanupDevice.camera_model && d.owner === selectedCleanupDevice.owner
    );
  if (!stillVisible && visibleDevices.length > 0) {
    let topDev = visibleDevices[0];
    visibleDevices.forEach(d => {
      if ((d.low_gb || 0) > (topDev.low_gb || 0)) topDev = d;
    });
    selectCleanupDevice(topDev);
  }
}

export function setupMediaCleanup(): void {
  // 0a. Family vs. All Owners Scope Toggle
  document.querySelectorAll<HTMLElement>('#cleanup-family-scope-toggle .cleanup-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextFamilyScope = btn.dataset.familyScope || 'family';
      if (activeFamilyScope === nextFamilyScope) return;
      activeFamilyScope = nextFamilyScope;

      document.querySelectorAll<HTMLElement>('#cleanup-family-scope-toggle .cleanup-scope-btn').forEach(b => {
        b.classList.toggle('active', (b.dataset.familyScope || 'family') === activeFamilyScope);
      });

      activeOwnerFilter = 'all';
      updateCleanupScopeSummaryBadges();
      renderCleanupOwnerChips();
      renderCleanupDevicesList();
      syncSelectedDeviceToScope();
    });
  });

  // 0b. Active vs. All Devices Scope Toggle
  document.querySelectorAll<HTMLElement>('#cleanup-device-scope-toggle .cleanup-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextScope = btn.dataset.deviceScope || 'active';
      if (activeDeviceScope === nextScope) return;
      activeDeviceScope = nextScope;

      document.querySelectorAll<HTMLElement>('#cleanup-device-scope-toggle .cleanup-scope-btn').forEach(b => {
        b.classList.toggle('active', (b.dataset.deviceScope || 'active') === activeDeviceScope);
      });

      activeOwnerFilter = 'all';
      updateCleanupScopeSummaryBadges();
      renderCleanupOwnerChips();
      renderCleanupDevicesList();
      syncSelectedDeviceToScope();
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

  // 2b. Sync Physical Device Inventory button (ManagedIntake ImageCapture snapshots)
  document.getElementById('btn-sync-device-inventory')?.addEventListener('click', async () => {
    const syncBtn = document.getElementById('btn-sync-device-inventory') as HTMLButtonElement | null;
    const origText = syncBtn?.textContent || '📲 Sync Snapshot';
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = '⏳ Syncing...';
    }
    try {
      const res = await fetch('/api/media/cleanup/sync-inventory', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        await fetchCleanupDevices(false);
        if (selectedCleanupDevice) {
          await fetchCleanupCandidates();
        }
      } else {
        alert(`Failed to sync device inventory: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      console.error('Error syncing device inventory:', err);
      alert(`Network error syncing device inventory: ${err.message || 'Unknown error'}`);
    } finally {
      if (syncBtn) {
        syncBtn.disabled = false;
        syncBtn.textContent = origText;
      }
    }
  });

  // 2c. Device location status filter buttons ('possibly' vs 'actually')
  document.querySelectorAll<HTMLElement>('#cleanup-location-filter-group .cleanup-location-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('#cleanup-location-filter-group .cleanup-location-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeLocationFilter = btn.dataset.location || 'possibly';
      cleanupPageOffset = 0;
      if (selectedCleanupDevice) {
        updateSelectedDeviceKPIs(selectedCleanupDevice);
        fetchCleanupCandidates();
      }
    });
  });

  // 3. Quartile filter buttons (scoped to cleanup toolbar so it doesn't collide with unassigned sort buttons)
  document.querySelectorAll<HTMLElement>('#cleanup-toolbar .cleanup-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('#cleanup-toolbar .cleanup-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeQuartileFilter = btn.dataset.quartile || 'all';
      cleanupPageOffset = 0;
      fetchCleanupCandidates();
    });
  });

  // 4. Media type filter buttons
  document.querySelectorAll<HTMLElement>('.cleanup-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.cleanup-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTypeFilter = btn.dataset.type || 'all';
      cleanupPageOffset = 0;
      fetchCleanupCandidates();
    });
  });

  // 4b. View Mode Toggle (iPhone Simplified Grid vs Full Metadata Table)
  document.querySelectorAll<HTMLElement>('.cleanup-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextView = (btn.dataset.view || 'iphone') as 'iphone' | 'table';
      cleanupViewMode = nextView === 'table' ? 'table' : 'iphone';
      document.querySelectorAll<HTMLElement>('.cleanup-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      syncCleanupViewContainers();
    });
  });

  // 5. Select All Checkboxes (table header + iPhone toolbar pill)
  const applySelectAll = (isChecked: boolean): void => {
    currentCandidateList.forEach(c => {
      if (isChecked) {
        selectedCandidateAssetIds.add(c.asset_id);
      } else {
        selectedCandidateAssetIds.delete(c.asset_id);
      }
    });

    document.querySelectorAll<HTMLInputElement>('.cleanup-asset-checkbox, .cleanup-grid-checkbox').forEach(cb => {
      cb.checked = isChecked;
      const tr = cb.closest('tr');
      if (tr) tr.classList.toggle('selected', isChecked);
      const tile = cb.closest('.cleanup-iphone-tile');
      if (tile) tile.classList.toggle('selected', isChecked);
    });

    updateCleanupSelectionBar();
  };

  const selectAllCb = document.getElementById('cleanup-select-all-checkbox') as HTMLInputElement | null;
  selectAllCb?.addEventListener('change', (e) => {
    applySelectAll((e.target as HTMLInputElement).checked);
  });

  const selectAllVisibleCb = document.getElementById('cleanup-select-all-visible') as HTMLInputElement | null;
  selectAllVisibleCb?.addEventListener('change', (e) => {
    applySelectAll((e.target as HTMLInputElement).checked);
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

  // 8. Preview Modal Mark as Removed button & Group Prev/Next Navigation
  document.getElementById('btn-preview-mark-removed')?.addEventListener('click', () => {
    if (!previewModalAssetId) return;
    const aid = previewModalAssetId;
    closeCleanupPreviewModal();
    openCleanupConfirmModal([aid]);
  });

  document.getElementById('btn-preview-prev')?.addEventListener('click', () => {
    navigateCleanupPreview(-1);
  });

  document.getElementById('btn-preview-next')?.addEventListener('click', () => {
    navigateCleanupPreview(1);
  });

  document.querySelectorAll<HTMLElement>('.cleanup-preview-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nextSort = btn.dataset.previewSort === 'score' ? 'score' : 'timestamp';
      if (nextSort === previewSortMode) return;
      previewSortMode = nextSort;
      applyPreviewSortOrder();
    });
  });

  document.getElementById('cleanup-preview-filmstrip')?.addEventListener(
    'wheel',
    (e) => {
      const strip = e.currentTarget as HTMLElement;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
        strip.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false }
  );

  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('modal-cleanup-preview');
    if (!modal?.classList.contains('open')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const targetTag = (e.target as HTMLElement)?.tagName;
    if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateCleanupPreview(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateCleanupPreview(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCleanupPreviewModal();
    }
  });

  // Close preview modal when clicking backdrop
  document.getElementById('modal-cleanup-preview')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'modal-cleanup-preview') {
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

function isDeviceMatchingFilters(d: any, familyScope = activeFamilyScope, deviceScope = activeDeviceScope): boolean {
  if (familyScope === 'family' && !d.is_family) return false;
  if (deviceScope === 'active' && !d.is_active) return false;
  return true;
}

function getDevicesInActiveScope(): any[] {
  if (!cleanupDevicesData || !cleanupDevicesData.owners) return [];
  const list: any[] = [];
  cleanupDevicesData.owners.forEach(o => {
    (o.devices || []).forEach(d => {
      if (!isDeviceMatchingFilters(d)) return;
      list.push(d);
    });
  });
  return list;
}

function updateCleanupScopeSummaryBadges(): void {
  if (!cleanupDevicesData) return;
  const owners = cleanupDevicesData.owners || [];

  const reclaimableBadge = document.getElementById('cleanup-badge-reclaimable');
  const candidatesBadge = document.getElementById('cleanup-badge-candidates');
  const devicesBadge = document.getElementById('cleanup-badge-devices');
  const paneTitle = document.getElementById('cleanup-pane-scope-title');
  const countPill = document.getElementById('cleanup-device-count-pill');

  const scopeCountFamily = document.getElementById('scope-count-family');
  const scopeCountOwnersAll = document.getElementById('scope-count-owners-all');
  const scopeCountActive = document.getElementById('scope-count-active');
  const scopeCountAll = document.getElementById('scope-count-all');

  let familyMatchingDeviceScopeCount = 0;
  let allOwnersMatchingDeviceScopeCount = 0;
  let activeMatchingFamilyScopeCount = 0;
  let allDevicesMatchingFamilyScopeCount = 0;

  let currentLowGb = 0;
  let currentLowCount = 0;
  let currentDeviceCount = 0;

  owners.forEach((o: any) => {
    (o.devices || []).forEach((d: any) => {
      if (isDeviceMatchingFilters(d, 'family', activeDeviceScope)) familyMatchingDeviceScopeCount++;
      if (isDeviceMatchingFilters(d, 'all', activeDeviceScope)) allOwnersMatchingDeviceScopeCount++;
      if (isDeviceMatchingFilters(d, activeFamilyScope, 'active')) activeMatchingFamilyScopeCount++;
      if (isDeviceMatchingFilters(d, activeFamilyScope, 'all')) allDevicesMatchingFamilyScopeCount++;

      if (isDeviceMatchingFilters(d, activeFamilyScope, activeDeviceScope)) {
        currentDeviceCount++;
        currentLowGb += d.low_gb || 0;
        currentLowCount += d.low_count || 0;
      }
    });
  });

  if (scopeCountFamily) scopeCountFamily.textContent = String(familyMatchingDeviceScopeCount);
  if (scopeCountOwnersAll) scopeCountOwnersAll.textContent = String(allOwnersMatchingDeviceScopeCount);
  if (scopeCountActive) scopeCountActive.textContent = String(activeMatchingFamilyScopeCount);
  if (scopeCountAll) scopeCountAll.textContent = String(allDevicesMatchingFamilyScopeCount);

  const scopeLabelParts: string[] = [];
  if (activeFamilyScope === 'family') scopeLabelParts.push('Family');
  if (activeDeviceScope === 'active') scopeLabelParts.push('Active');
  const scopeSuffix = scopeLabelParts.length ? ` (${scopeLabelParts.join(' · ')})` : ' (All)';

  if (reclaimableBadge) reclaimableBadge.textContent = `${currentLowGb.toFixed(1)} GB Reclaimable${scopeSuffix}`;
  if (candidatesBadge) candidatesBadge.textContent = `${currentLowCount.toLocaleString()} Low-Quality Files`;
  if (devicesBadge) devicesBadge.textContent = `${currentDeviceCount} ${activeDeviceScope === 'active' ? 'Active ' : ''}Devices`;

  if (paneTitle) {
    const icon = activeDeviceScope === 'active' ? '🟢' : '📚';
    const devWord = activeDeviceScope === 'active' ? 'Active Devices' : 'All Devices';
    const famWord = activeFamilyScope === 'family' ? 'Family' : 'All Owners';
    paneTitle.textContent = `${icon} ${devWord} · ${famWord}`;
  }
  if (countPill) {
    countPill.textContent = `${currentDeviceCount} ${activeDeviceScope === 'active' ? 'Active' : 'Devices'}`;
  }
}

export async function fetchCleanupDevices(forceRefresh = false): Promise<void> {
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

    if (activeDeviceScope === 'active' && (summary.active_devices || 0) === 0) {
      activeDeviceScope = 'all';
      document.querySelectorAll<HTMLElement>('#cleanup-device-scope-toggle .cleanup-scope-btn').forEach(b => {
        b.classList.toggle('active', (b.dataset.deviceScope || 'active') === activeDeviceScope);
      });
    }

    updateCleanupScopeSummaryBadges();

    if (updatedLabel) {
      updatedLabel.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }

    renderCleanupOwnerChips();
    renderCleanupDevicesList();

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
      let topDevice = scopedDevices[0];
      scopedDevices.forEach(d => {
        if ((d.low_gb || 0) > (topDevice.low_gb || 0)) topDevice = d;
      });
      selectCleanupDevice(topDevice);
    }
  } catch (err: any) {
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

function renderCleanupOwnerChips(): void {
  const container = document.getElementById('cleanup-owner-chips');
  if (!container || !cleanupDevicesData) return;

  const scopedAllDevs = getDevicesInActiveScope();
  const allChipLabel = activeFamilyScope === 'family' ? 'All Family' : 'All Owners';

  let html = `
    <button class="cleanup-chip ${activeOwnerFilter === 'all' ? 'active' : ''}" data-owner="all">
      ${allChipLabel} (${scopedAllDevs.length})
    </button>
  `;

  (cleanupDevicesData.owners || []).forEach(o => {
    const scopedDevs = (o.devices || []).filter(d => isDeviceMatchingFilters(d));
    if (!scopedDevs.length) return;
    const isAct = activeOwnerFilter === o.owner_name;
    html += `
      <button class="cleanup-chip ${isAct ? 'active' : ''}" data-owner="${escapeHtml(o.owner_name)}">
        ${escapeHtml(o.owner_name)} (${scopedDevs.length})
      </button>
    `;
  });

  container.innerHTML = html;

  container.querySelectorAll<HTMLElement>('.cleanup-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.cleanup-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeOwnerFilter = chip.dataset.owner || 'all';
      renderCleanupDevicesList();
    });
  });
}

function renderCleanupDevicesList(): void {
  const listEl = document.getElementById('cleanup-devices-list');
  if (!listEl || !cleanupDevicesData) return;

  const searchTerm = ((document.getElementById('cleanup-device-search') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
  const owners = cleanupDevicesData.owners || [];

  let filteredOwners: any[] = owners;
  if (activeOwnerFilter !== 'all') {
    filteredOwners = filteredOwners.filter(o => o.owner_name === activeOwnerFilter);
  }

  let html = '';
  let totalVisibleDevices = 0;

  filteredOwners.forEach((o: any) => {
    let devices = (o.devices || []).filter((d: any) => isDeviceMatchingFilters(d));
    if (searchTerm) {
      devices = devices.filter(
        (d: any) =>
          d.camera_model.toLowerCase().includes(searchTerm) ||
          o.owner_name.toLowerCase().includes(searchTerm)
      );
    }

    if (!devices.length) return;
    totalVisibleDevices += devices.length;

    const ownerReclaimGb = devices.reduce((acc: number, d: any) => acc + (d.low_gb || 0), 0);
    const ownerIcon = o.is_family ? '👨‍👩‍👧‍👦' : '👤';

    html += `
      <div class="cleanup-owner-group">
        <div class="cleanup-owner-header">
          <span class="cleanup-owner-name">
            <span>${ownerIcon}</span> ${escapeHtml(o.owner_name)}
          </span>
          <span class="badge badge-xs badge-amber font-mono">${ownerReclaimGb.toFixed(2)} GB reclaimable</span>
        </div>
        <div class="cleanup-owner-devices">
    `;

    devices.forEach((d: any) => {
      const isSelected =
        selectedCleanupDevice &&
        selectedCleanupDevice.camera_model === d.camera_model &&
        selectedCleanupDevice.owner === d.owner;
      const pct = d.total_count > 0 ? Math.min(100, Math.round((d.low_count / d.total_count) * 100)) : 50;
      const activeDot = d.is_active
        ? `<span class="cleanup-device-active-dot" title="Active Device (since ${escapeHtml(d.start_date || 'current')})"></span>`
        : '';

      const snapshotLine = d.has_actual_snapshot
        ? `<div class="cleanup-device-subrow" style="margin-top: 2px;">
             <span class="badge badge-xs badge-green font-mono" style="font-size: 0.65rem; padding: 1px 5px;" title="ManagedIntake snapshot '${escapeHtml(d.snapshot_folder || '')}'">
               📲 ${(d.actual_low_count ?? 0).toLocaleString()} low / ${(d.actual_total_count ?? 0).toLocaleString()} on device (${(d.actual_low_gb ?? 0).toFixed(1)} GB)
             </span>
           </div>`
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
          ${snapshotLine}
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

  listEl.querySelectorAll<HTMLElement>('.cleanup-device-item').forEach(item => {
    item.addEventListener('click', () => {
      const model = item.dataset.model;
      const owner = item.dataset.owner;
      let matchedDev: any = null;
      for (const o of cleanupDevicesData?.owners || []) {
        for (const d of (o as any).devices || []) {
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

function updateSelectedDeviceKPIs(device: any): void {
  const kpisContainer = document.getElementById('cleanup-detail-kpis');
  const kpiGb = document.getElementById('cleanup-kpi-device-gb');
  const kpiCount = document.getElementById('cleanup-kpi-device-count');
  const kpiMaxScore = document.getElementById('cleanup-kpi-device-max-score');
  const snapshotBadge = document.getElementById('cleanup-detail-snapshot-badge');
  const subtitle = document.getElementById('cleanup-detail-subtitle');

  const isActualView = activeLocationFilter === 'actually' && Boolean(device.has_actual_snapshot);
  const lowGb = isActualView ? (device.actual_low_gb ?? 0) : (device.low_gb ?? 0);
  const lowCount = isActualView ? (device.actual_low_count ?? 0) : (device.low_count ?? 0);

  if (kpisContainer) kpisContainer.style.display = 'flex';
  if (kpiGb) kpiGb.textContent = `${lowGb.toFixed(2)} GB`;
  if (kpiCount) kpiCount.textContent = `${lowCount.toLocaleString()} files`;
  if (kpiMaxScore) kpiMaxScore.textContent = `≤ ${(device.q2_max_score ?? 0).toFixed(4)}`;

  if (snapshotBadge) {
    if (device.has_actual_snapshot) {
      snapshotBadge.style.display = 'inline-block';
      snapshotBadge.className = 'badge badge-xs badge-cyan font-mono';
      const syncedStr = device.snapshot_synced_at
        ? ` · Synced ${formatCaptureTimestampParts(device.snapshot_synced_at).dateLine}`
        : '';
      snapshotBadge.textContent = `📲 Snapshot: ${(device.actual_total_count ?? 0).toLocaleString()} on device (${device.snapshot_folder || 'ManagedIntake'})`;
      snapshotBadge.title = `ManagedIntake ImageCapture folder '${device.snapshot_folder || ''}' (${(device.snapshot_total_files ?? 0).toLocaleString()} media files)${syncedStr}`;
    } else {
      snapshotBadge.style.display = 'inline-block';
      snapshotBadge.className = 'badge badge-xs badge-outline font-mono';
      snapshotBadge.textContent = 'No ImageCapture Snapshot';
      snapshotBadge.title = `No ManagedIntake ImageCapture snapshot folder mapped for ${device.camera_model}`;
    }
  }

  if (subtitle) {
    const dateSpan = device.start_date
      ? ` (Active since ${device.start_date}${device.end_date ? ` to ${device.end_date}` : ''})`
      : '';
    if (activeLocationFilter === 'actually') {
      subtitle.textContent = device.has_actual_snapshot
        ? `Showing assets verified on physical device via ManagedIntake ('${device.snapshot_folder}') — ordered largest-to-smallest.`
        : `No ManagedIntake ImageCapture snapshot found for ${device.camera_model} — toggle "Possibly Located" to inspect DB records.`;
    } else {
      subtitle.textContent = `Reviewing candidates for ${device.owner}${dateSpan} — ordered largest-to-smallest.`;
    }
  }
}

function selectCleanupDevice(device: any): void {
  selectedCleanupDevice = device;

  document.querySelectorAll<HTMLElement>('.cleanup-device-item').forEach(item => {
    if (item.dataset.model === device.camera_model && item.dataset.owner === device.owner) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  const titleName = document.getElementById('cleanup-detail-device-name');
  const ownerBadge = document.getElementById('cleanup-detail-owner-badge');
  const activeBadge = document.getElementById('cleanup-detail-active-badge');
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

  updateSelectedDeviceKPIs(device);

  if (toolbar) toolbar.style.display = 'flex';
  if (placeholder) placeholder.style.display = 'none';
  syncCleanupViewContainers();
  if (paginationBar) paginationBar.style.display = 'flex';

  cleanupPageOffset = 0;
  selectedCandidateAssetIds.clear();
  updateCleanupSelectionBar();

  fetchCleanupCandidates();
}

function syncCleanupViewContainers(): void {
  const tableEl = document.getElementById('cleanup-candidates-table');
  const gridEl = document.getElementById('cleanup-candidates-grid');
  if (!selectedCleanupDevice) {
    if (tableEl) tableEl.style.display = 'none';
    if (gridEl) gridEl.style.display = 'none';
    return;
  }
  if (cleanupViewMode === 'iphone') {
    if (gridEl) gridEl.style.display = 'grid';
    if (tableEl) tableEl.style.display = 'none';
  } else {
    if (gridEl) gridEl.style.display = 'none';
    if (tableEl) tableEl.style.display = 'table';
  }
}

function renderCleanupIphoneGrid(): void {
  const gridEl = document.getElementById('cleanup-candidates-grid');
  if (!gridEl) return;

  if (!currentCandidateList.length) {
    gridEl.innerHTML = `
      <div class="text-center text-muted" style="grid-column: 1 / -1; padding: 3.5rem 1rem;">
        <span style="font-size: 1.5rem; display: block; margin-bottom: 0.4rem;">🎉</span>
        No candidate assets found for <strong>${escapeHtml(selectedCleanupDevice?.camera_model || '')}</strong> with current filters.
      </div>
    `;
    return;
  }

  gridEl.innerHTML = currentCandidateList
    .map((c) => {
      const isChecked = selectedCandidateAssetIds.has(c.asset_id);
      const isVideo = c.media_type === 'video';
      const durationStr = isVideo && c.duration_sec > 0 ? formatDuration(c.duration_sec) : '';
      const sizeBytes = c.file_size_bytes || (c.file_size_mb ? c.file_size_mb * 1_000_000 : 0);
      const sizeStr = formatAppleBytes(sizeBytes);
      const thumbUrl = `/api/media/cleanup/thumbnail/${encodeURIComponent(c.asset_id)}`;

      return `
        <div
          class="cleanup-iphone-tile ${isChecked ? 'selected' : ''}"
          data-grid-asset-id="${escapeHtml(c.asset_id)}"
          title="Ordered by size (${escapeHtml(sizeStr)}${durationStr ? ` · ${escapeHtml(durationStr)}` : ''}) — click to preview"
        >
          <img
            class="cleanup-iphone-thumb"
            src="${thumbUrl}"
            alt="${escapeHtml(c.original_filename)}"
            loading="lazy"
          />
          <label class="cleanup-iphone-check" title="Select for removal">
            <input
              type="checkbox"
              class="cleanup-grid-checkbox"
              data-asset-id="${escapeHtml(c.asset_id)}"
              ${isChecked ? 'checked' : ''}
            />
          </label>
          ${durationStr ? `<span class="cleanup-iphone-duration">${escapeHtml(durationStr)}</span>` : ''}
          <span class="cleanup-iphone-size">${escapeHtml(sizeStr)}</span>
        </div>
      `;
    })
    .join('');

  gridEl.querySelectorAll<HTMLElement>('.cleanup-iphone-check').forEach((labelEl) => {
    labelEl.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  gridEl.querySelectorAll<HTMLInputElement>('.cleanup-grid-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const aid = cb.dataset.assetId;
      if (!aid) return;
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) {
        selectedCandidateAssetIds.add(aid);
      } else {
        selectedCandidateAssetIds.delete(aid);
      }
      cb.closest('.cleanup-iphone-tile')?.classList.toggle('selected', checked);

      // Keep table row checkbox in sync
      const tableCb = document.querySelector<HTMLInputElement>(`.cleanup-asset-checkbox[data-asset-id="${CSS.escape(aid)}"]`);
      if (tableCb) {
        tableCb.checked = checked;
        tableCb.closest('tr')?.classList.toggle('selected', checked);
      }
      updateCleanupSelectionBar();
    });
  });

  gridEl.querySelectorAll<HTMLElement>('.cleanup-iphone-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const aid = tile.dataset.gridAssetId;
      if (!aid) return;
      const pageAssetIds = currentCandidateList.map(item => item.asset_id).filter(Boolean);
      const groupLabel = selectedCleanupDevice
        ? `${selectedCleanupDevice.device_name || selectedCleanupDevice.camera_model || 'Cleanup'} (Current Page)`
        : 'Cleanup Candidates (Current Page)';
      openCleanupPreviewModal(aid, { assetIds: pageAssetIds, groupLabel });
    });
  });
}

export async function fetchCleanupCandidates(): Promise<void> {
  if (!selectedCleanupDevice) return;
  if (isFetchingCleanupCandidates) return;
  isFetchingCleanupCandidates = true;

  const tbody = document.getElementById('cleanup-candidates-tbody');
  const gridEl = document.getElementById('cleanup-candidates-grid');
  const paginationInfo = document.getElementById('cleanup-pagination-info');
  const pageNumberLabel = document.getElementById('cleanup-page-number');
  const prevBtn = document.getElementById('btn-cleanup-prev-page') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('btn-cleanup-next-page') as HTMLButtonElement | null;

  syncCleanupViewContainers();

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" class="text-center text-muted" style="padding: 3rem 1rem;">
          <div class="spinner-sm mb-2" style="margin: 0 auto;"></div>
          Scanning ${activeLocationFilter === 'actually' ? 'on-device snapshot' : 'database candidates'} for <strong>${escapeHtml(selectedCleanupDevice.camera_model)}</strong>...
        </td>
      </tr>
    `;
  }
  if (gridEl) {
    gridEl.innerHTML = `
      <div class="text-center text-muted" style="grid-column: 1 / -1; padding: 3rem 1rem;">
        <div class="spinner-sm mb-2" style="margin: 0 auto;"></div>
        Loading <strong>${escapeHtml(selectedCleanupDevice.camera_model)}</strong> items by size...
      </div>
    `;
  }

  try {
    const params = new URLSearchParams({
      camera_model: selectedCleanupDevice.camera_model,
      owner: selectedCleanupDevice.owner || 'all',
      quartile: activeQuartileFilter,
      media_type: activeTypeFilter,
      location_status: activeLocationFilter,
      limit: cleanupPageLimit.toString(),
      offset: cleanupPageOffset.toString()
    });

    const res = await fetch(`/api/media/cleanup/candidates?${params.toString()}`);
    const data = await res.json();

    if (!data.ok) {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" class="text-center text-muted" style="padding: 2.5rem 1rem;">
              ⚠️ Error loading candidates: ${escapeHtml(data.error || 'Unknown error')}
            </td>
          </tr>
        `;
      }
      if (gridEl) {
        gridEl.innerHTML = `
          <div class="text-center text-muted" style="grid-column: 1 / -1; padding: 2.5rem 1rem;">
            ⚠️ Error loading candidates: ${escapeHtml(data.error || 'Unknown error')}
          </div>
        `;
      }
      return;
    }

    const locCountPossEl = document.getElementById('loc-count-possibly');
    const locCountActEl = document.getElementById('loc-count-actually');
    if (locCountPossEl) {
      locCountPossEl.textContent = typeof data.possibly_total_count === 'number'
        ? `(${data.possibly_total_count.toLocaleString()})`
        : '';
    }
    if (locCountActEl) {
      locCountActEl.textContent = typeof data.actually_total_count === 'number'
        ? `(${data.actually_total_count.toLocaleString()})`
        : '';
    }

    const hasSnapshot = Boolean(data.has_device_snapshot);
    const snapshotFolder = data.snapshot_folder || '';

    currentCandidateList = data.candidates || [];
    currentCandidateList.forEach(c => {
      candidateAssetMeta.set(c.asset_id, {
        ...c,
        filename: c.original_filename,
        bytes: c.file_size_bytes
      });
    });

    const totalCount = data.total_count || 0;
    const totalGb = data.total_gb || 0;

    if (!currentCandidateList.length) {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" class="text-center text-muted" style="padding: 3.5rem 1rem;">
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

        const resSub =
          c.width && c.height
            ? `<div class="candidate-res-sub">${c.width}×${c.height}${c.fps > 0 ? ` · ${Math.round(c.fps)}fps` : ''}</div>`
            : '';

        const hasDiffOrigin =
          Boolean(c.origin_camera_model &&
          c.origin_camera_model !== c.camera_model &&
          c.origin_camera_model !== 'Unknown');

        const originBadgeHtml = hasDiffOrigin
          ? `<div class="candidate-origin-sub" style="margin-top: 2px;" title="Origin capture device: ${escapeHtml(c.origin_camera_model || '')} · Physical carrier: ${escapeHtml(c.camera_model)}">
              <span class="badge badge-xs badge-cyan font-mono" style="font-size: 0.65rem; padding: 1px 5px; line-height: 1.2;">
                ${c.origin_camera_model?.includes('GoPro') ? '🎥' : '📷'} ${escapeHtml(c.origin_camera_model || '')}
              </span>
            </div>`
          : '';

        let onDeviceHtml = '';
        if (c.actually_on_device) {
          const folderTitle = c.device_source_folder || snapshotFolder || 'ManagedIntake';
          const altFile =
            c.device_location_filename && c.device_location_filename !== c.original_filename
              ? `<div class="candidate-res-sub" style="margin-top: 2px;" title="File on device: ${escapeHtml(c.device_location_filename)}">↳ ${escapeHtml(c.device_location_filename)}</div>`
              : '';
          onDeviceHtml = `
            <span class="badge badge-xs badge-green font-mono" title="Verified on physical device via ManagedIntake '${escapeHtml(folderTitle)}' (${escapeHtml(c.device_match_tier || 'exact')})">
              📱 On Device
            </span>
            ${altFile}
          `;
        } else if (hasSnapshot) {
          onDeviceHtml = `
            <span class="badge badge-xs badge-outline font-mono" style="opacity: 0.8;" title="Attributed to ${escapeHtml(c.camera_model)} in DB, not present in ManagedIntake snapshot '${escapeHtml(snapshotFolder)}'">
              ❓ Possibly
            </span>
          `;
        } else {
          onDeviceHtml = `
            <span class="badge badge-xs badge-outline font-mono" style="opacity: 0.65;" title="No ManagedIntake ImageCapture snapshot available for ${escapeHtml(c.camera_model)}">
              ❓ No Snap
            </span>
          `;
        }

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

        const sizeFormatted = formatAppleBytes(
          c.file_size_bytes || (c.file_size_mb ? c.file_size_mb * 1_000_000 : 0)
        );

        const quartileBadge =
          c.score_quartile === 1
            ? `<span class="badge badge-xs cleanup-badge-q1 font-mono">Q1 (Lowest)</span>`
            : c.score_quartile === 2
              ? `<span class="badge badge-xs cleanup-badge-q2 font-mono">Q2 (Low)</span>`
              : c.score_quartile === 3
                ? `<span class="badge badge-xs badge-blue font-mono">Q3 (Good)</span>`
                : c.score_quartile === 4
                  ? `<span class="badge badge-xs badge-green font-mono">Q4 (Best)</span>`
                  : `<span class="badge badge-xs badge-outline font-mono">—</span>`;

        let momentHtml = '<span class="text-muted">—</span>';
        if (c.last_asset_pub) {
          momentHtml = `<span class="badge badge-xs badge-green" title="Published: ${escapeHtml(c.last_asset_pub)}">✅ ${escapeHtml(c.last_asset_pub.substring(0, 10))}</span>`;
        } else if (c.assigned_moment && c.assigned_moment !== '—') {
          const shortMom =
            c.assigned_moment.length > 20 ? c.assigned_moment.substring(0, 20) + '…' : c.assigned_moment;
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
              ${originBadgeHtml}
              ${resSub}
            </td>
            <td>${onDeviceHtml}</td>
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

    tbody?.querySelectorAll<HTMLInputElement>('.cleanup-asset-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const aid = cb.dataset.assetId;
        if (!aid) return;
        const tr = cb.closest('tr');
        const checked = (e.target as HTMLInputElement).checked;
        if (checked) {
          selectedCandidateAssetIds.add(aid);
          tr?.classList.add('selected');
        } else {
          selectedCandidateAssetIds.delete(aid);
          tr?.classList.remove('selected');
        }
        const gridCb = document.querySelector<HTMLInputElement>(`.cleanup-grid-checkbox[data-asset-id="${CSS.escape(aid)}"]`);
        if (gridCb) {
          gridCb.checked = checked;
          gridCb.closest('.cleanup-iphone-tile')?.classList.toggle('selected', checked);
        }
        updateCleanupSelectionBar();
      });
    });

    tbody?.querySelectorAll<HTMLElement>('[data-preview-asset-id], .btn-cleanup-preview').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const aid = el.dataset.previewAssetId || el.dataset.assetId;
        if (!aid) return;
        const pageAssetIds = currentCandidateList.map(item => item.asset_id).filter(Boolean);
        const groupLabel = selectedCleanupDevice
          ? `${selectedCleanupDevice.device_name || selectedCleanupDevice.camera_model || 'Cleanup'} (Current Page)`
          : 'Cleanup Candidates (Current Page)';
        openCleanupPreviewModal(aid, { assetIds: pageAssetIds, groupLabel });
      });
    });

    tbody?.querySelectorAll<HTMLElement>('.btn-cleanup-single-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const aid = btn.dataset.assetId;
        if (aid) openCleanupConfirmModal([aid]);
      });
    });

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

    renderCleanupIphoneGrid();
    syncCleanupViewContainers();
    updateCleanupSelectionBar();
  } catch (err) {
    console.error('Error fetching cleanup candidates:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="12" class="text-center text-muted" style="padding: 2.5rem 1rem;">
            ❌ Network error loading candidates.
          </td>
        </tr>
      `;
    }
    if (gridEl) {
      gridEl.innerHTML = `
        <div class="text-center text-muted" style="grid-column: 1 / -1; padding: 2.5rem 1rem;">
          ❌ Network error loading candidates.
        </div>
      `;
    }
  } finally {
    isFetchingCleanupCandidates = false;
  }
}

function stopPreviewMedia(): void {
  const stage = document.getElementById('cleanup-preview-stage');
  if (!stage) return;
  const vid = stage.querySelector('video');
  if (vid) {
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
  }
}

function navigateCleanupPreview(delta: number): void {
  if (previewGroupAssetIds.length <= 1) return;
  const nextIdx = previewGroupIndex + delta;
  if (nextIdx < 0 || nextIdx >= previewGroupAssetIds.length) return;
  previewGroupIndex = nextIdx;
  renderCleanupPreviewAsset(previewGroupAssetIds[previewGroupIndex]);
  updatePreviewGroupControls();
}

function formatSeriesTimeRange(assetIds: string[]): string | null {
  const timestamps: string[] = [];
  for (const aid of assetIds) {
    const meta = candidateAssetMeta.get(aid);
    const ts = (meta?.capture_timestamp || meta?.date_created_utc || '').trim();
    if (ts && ts !== '—') {
      timestamps.push(ts);
    }
  }
  if (timestamps.length === 0) return null;
  timestamps.sort();
  const earliest = timestamps[0];
  const latest = timestamps[timestamps.length - 1];
  if (earliest === latest) return earliest;
  const eDate = earliest.slice(0, 10);
  const lDate = latest.slice(0, 10);
  if (eDate && eDate === lDate && earliest.length >= 19 && latest.length >= 19) {
    return `${eDate} · ${earliest.slice(11, 19)} – ${latest.slice(11, 19)}`;
  }
  return `${earliest.slice(0, 16)} → ${latest.slice(0, 16)}`;
}

function formatSeriesFilenamesSummary(assetIds: string[]): string | null {
  const uniqueNames = new Set<string>();
  for (const aid of assetIds) {
    const fn = candidateAssetMeta.get(aid)?.original_filename;
    if (fn) uniqueNames.add(fn);
  }
  if (uniqueNames.size === 0) return null;
  const sortedNames = Array.from(uniqueNames).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
  if (sortedNames.length <= 3) {
    return sortedNames.join(', ');
  }
  return `${sortedNames[0]} … ${sortedNames[sortedNames.length - 1]}`;
}

function renderPreviewFilmstrip(): void {
  const stripWrap = document.getElementById('cleanup-preview-filmstrip-wrap');
  const strip = document.getElementById('cleanup-preview-filmstrip');
  const labelEl = document.getElementById('cleanup-preview-group-label');
  const seriesMetaEl = document.getElementById('cleanup-preview-series-meta');
  if (!stripWrap || !strip) return;

  if (previewGroupAssetIds.length <= 1) {
    stripWrap.style.display = 'none';
    strip.innerHTML = '';
    if (seriesMetaEl) seriesMetaEl.innerHTML = '';
    return;
  }

  stripWrap.style.display = 'flex';
  if (labelEl) {
    labelEl.textContent = previewGroupLabel
      ? `${previewGroupLabel} (${previewGroupAssetIds.length} assets)`
      : `Group (${previewGroupAssetIds.length} assets)`;
  }

  if (seriesMetaEl) {
    const timeRange = formatSeriesTimeRange(previewGroupAssetIds);
    const filenameRange = formatSeriesFilenamesSummary(previewGroupAssetIds);
    const chips: string[] = [];
    if (timeRange) {
      chips.push(`<span class="cleanup-preview-series-chip" title="Capture time range across series">🕒 ${escapeHtml(timeRange)}</span>`);
    }
    if (filenameRange) {
      chips.push(`<span class="cleanup-preview-series-chip" title="Filename span across series">📄 ${escapeHtml(filenameRange)}</span>`);
    }
    seriesMetaEl.innerHTML = chips.join('');
  }

  strip.innerHTML = previewGroupAssetIds
    .map((aid, idx) => {
      const meta = candidateAssetMeta.get(aid);
      const isVideo = meta?.media_type === 'video';
      const thumbUrl = `/api/media/cleanup/thumbnail/${encodeURIComponent(aid)}`;
      const filename = meta?.original_filename || aid;
      const captureTs = (meta?.capture_timestamp && meta.capture_timestamp !== '—' ? meta.capture_timestamp : meta?.date_created_utc && meta.date_created_utc !== '—' ? meta.date_created_utc : '').trim();
      const shortTs = captureTs ? captureTs.replace('T', ' ').slice(0, 19) : '—';
      const isDupCopy = Boolean(meta?.is_duplicate_copy);
      const hasScore = typeof meta?.score_normalized === 'number';
      const scoreVal = hasScore ? meta!.score_normalized.toFixed(4) : '';
      const scoreLabel = hasScore ? ` · ${scoreVal}` : '';
      const subLine =
        previewSortMode === 'score' && hasScore
          ? `★ ${scoreVal}${shortTs !== '—' ? ` · ${shortTs.slice(5, 16)}` : ''}`
          : shortTs;
      const tooltipParts = [`#${idx + 1} ${filename}`, captureTs, scoreLabel, isDupCopy ? '· ♻️ Photos Dup Copy' : ''].filter(Boolean).join(' ');
      return `
        <button type="button" class="cleanup-preview-thumb-item${idx === previewGroupIndex ? ' active' : ''}${isDupCopy ? ' is-dup-copy' : ''}" data-preview-index="${idx}" title="${escapeHtml(tooltipParts)}">
          <div class="cleanup-preview-thumb-media">
            <img src="${thumbUrl}" loading="lazy" alt="${escapeHtml(filename)}" onerror="this.style.display='none'" />
            <span class="cleanup-preview-thumb-idx">#${idx + 1}${isDupCopy ? ' ♻️' : ''}</span>
            ${isVideo ? '<span class="cleanup-preview-thumb-play">▶</span>' : ''}
          </div>
          <span class="cleanup-preview-thumb-caption">${escapeHtml(filename)}</span>
          <span class="cleanup-preview-thumb-time">${escapeHtml(subLine)}</span>
        </button>
      `;
    })
    .join('');

  strip.querySelectorAll<HTMLElement>('.cleanup-preview-thumb-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.previewIndex);
      if (Number.isNaN(idx) || idx < 0 || idx >= previewGroupAssetIds.length) return;
      previewGroupIndex = idx;
      renderCleanupPreviewAsset(previewGroupAssetIds[previewGroupIndex]);
      updatePreviewGroupControls();
    });
  });
}

function updatePreviewGroupControls(): void {
  const total = previewGroupAssetIds.length;
  const hasGroup = total > 1;
  const btnPrev = document.getElementById('btn-preview-prev') as HTMLButtonElement | null;
  const btnNext = document.getElementById('btn-preview-next') as HTMLButtonElement | null;
  const groupBadgeEl = document.getElementById('cleanup-preview-group-badge');

  if (btnPrev) {
    btnPrev.style.display = hasGroup ? 'flex' : 'none';
    btnPrev.disabled = previewGroupIndex <= 0;
  }
  if (btnNext) {
    btnNext.style.display = hasGroup ? 'flex' : 'none';
    btnNext.disabled = previewGroupIndex < 0 || previewGroupIndex >= total - 1;
  }
  if (groupBadgeEl) {
    if (hasGroup && previewGroupIndex >= 0) {
      groupBadgeEl.style.display = 'inline-flex';
      groupBadgeEl.textContent = `${previewGroupIndex + 1} / ${total}`;
    } else {
      groupBadgeEl.style.display = 'none';
    }
  }

  const strip = document.getElementById('cleanup-preview-filmstrip');
  if (strip && hasGroup) {
    const items = strip.querySelectorAll<HTMLElement>('.cleanup-preview-thumb-item');
    items.forEach((item, idx) => {
      const isActive = idx === previewGroupIndex;
      item.classList.toggle('active', isActive);
      if (isActive) {
        item.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    });
  }
}

function renderCleanupPreviewAsset(assetId: string): void {
  const c = candidateAssetMeta.get(assetId);
  const stage = document.getElementById('cleanup-preview-stage');
  if (!c || !stage) return;

  previewModalAssetId = assetId;
  stopPreviewMedia();

  const isVideo = c.media_type === 'video';
  const ext = (c.original_filename.split('.').pop() || '').toUpperCase();
  const sizeStr = formatAppleBytes(
    c.file_size_bytes || c.bytes || (c.file_size_mb ? c.file_size_mb * 1_000_000 : 0)
  );

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
    resEl.textContent =
      c.width && c.height
        ? `${c.width} × ${c.height} px${c.fps > 0 ? ` @ ${c.fps} fps` : ''}`
        : '—';
  }
  if (devEl) {
    const locStatusText = c.actually_on_device
      ? `📱 Actually on Device${c.device_source_folder ? ` (${c.device_source_folder})` : ''}`
      : '❓ Possibly Located';
    if (c.origin_camera_model && c.origin_camera_model !== c.camera_model && c.origin_camera_model !== 'Unknown') {
      devEl.textContent = `${c.camera_model || 'Unknown Device'} (${c.primary_owner || 'Unassigned'}) · Origin: ${c.origin_camera_model} · ${locStatusText}`;
    } else {
      devEl.textContent = `${c.camera_model || 'Unknown Device'} (${c.primary_owner || 'Unassigned'}) · ${locStatusText}`;
    }
  }
  if (scoreEl) {
    const qPrefix =
      typeof c.score_quartile === 'number' ? `Q${c.score_quartile}` : c.score_quartile || 'High Rank';
    scoreEl.textContent = `${qPrefix} · Score ${(c.score_normalized || 0).toFixed(4)}`;
  }
  if (momEl) momEl.textContent = c.assigned_moment || '—';
  if (uuidEl) uuidEl.textContent = `Asset UUID: ${c.asset_id}`;
}

function getAssetCaptureSortValue(assetId: string): { epochMs: number; rawTs: string; filename: string } {
  const meta = candidateAssetMeta.get(assetId);
  const raw =
    (meta?.capture_timestamp && meta.capture_timestamp !== '—' ? meta.capture_timestamp : '') ||
    (meta?.date_created_utc && meta.date_created_utc !== '—' ? meta.date_created_utc : '');
  const trimmed = raw.trim();
  const normalized = trimmed ? trimmed.replace(' ', 'T') : '';
  const parsed = normalized ? Date.parse(normalized) : Number.NaN;
  return {
    epochMs: Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY,
    rawTs: trimmed,
    filename: meta?.original_filename || ''
  };
}

function compareAssetsByCaptureDate(aId: string, bId: string): number {
  const a = getAssetCaptureSortValue(aId);
  const b = getAssetCaptureSortValue(bId);
  if (a.epochMs !== b.epochMs) {
    return a.epochMs - b.epochMs;
  }
  if (a.rawTs !== b.rawTs) {
    if (!a.rawTs) return 1;
    if (!b.rawTs) return -1;
    return a.rawTs.localeCompare(b.rawTs);
  }
  const fnCmp = a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
  if (fnCmp !== 0) return fnCmp;
  return aId.localeCompare(bId);
}

function compareAssetsByScore(aId: string, bId: string): number {
  const aScore = candidateAssetMeta.get(aId)?.score_normalized;
  const bScore = candidateAssetMeta.get(bId)?.score_normalized;
  const aVal = typeof aScore === 'number' ? aScore : -1;
  const bVal = typeof bScore === 'number' ? bScore : -1;
  if (bVal !== aVal) {
    return bVal - aVal;
  }
  return compareAssetsByCaptureDate(aId, bId);
}

function syncPreviewSortButtons(): void {
  document.querySelectorAll<HTMLElement>('.cleanup-preview-sort-btn').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.previewSort || 'timestamp') === previewSortMode);
  });
}

function applyPreviewSortOrder(): void {
  syncPreviewSortButtons();
  if (!previewGroupAssetIds.length) return;

  const comparator = previewSortMode === 'score' ? compareAssetsByScore : compareAssetsByCaptureDate;
  previewGroupAssetIds.sort(comparator);

  if (previewModalAssetId) {
    const newIdx = previewGroupAssetIds.indexOf(previewModalAssetId);
    previewGroupIndex = newIdx >= 0 ? newIdx : 0;
  } else {
    previewGroupIndex = 0;
  }

  renderPreviewFilmstrip();
  updatePreviewGroupControls();
}

export function openCleanupPreviewModal(assetId: string, context?: PreviewGroupContext): void {
  const c = candidateAssetMeta.get(assetId);
  if (!c) return;

  const modal = document.getElementById('modal-cleanup-preview');
  const stage = document.getElementById('cleanup-preview-stage');
  if (!modal || !stage) return;

  const seen = new Set<string>();
  const validGroupIds: string[] = [];
  for (const id of context?.assetIds || [assetId]) {
    if (id && !seen.has(id) && candidateAssetMeta.has(id)) {
      seen.add(id);
      validGroupIds.push(id);
    }
  }
  if (!seen.has(assetId)) {
    validGroupIds.unshift(assetId);
  }

  previewGroupAssetIds = validGroupIds;
  previewModalAssetId = assetId;
  previewGroupLabel = context?.groupLabel || null;

  renderCleanupPreviewAsset(assetId);
  applyPreviewSortOrder();

  modal.classList.add('open');
}

export function closeCleanupPreviewModal(): void {
  const modal = document.getElementById('modal-cleanup-preview');
  const stage = document.getElementById('cleanup-preview-stage');
  stopPreviewMedia();
  if (stage) {
    stage.innerHTML = '';
  }
  const strip = document.getElementById('cleanup-preview-filmstrip');
  if (strip) {
    strip.innerHTML = '';
  }
  const seriesMetaEl = document.getElementById('cleanup-preview-series-meta');
  if (seriesMetaEl) {
    seriesMetaEl.innerHTML = '';
  }
  const stripWrap = document.getElementById('cleanup-preview-filmstrip-wrap');
  if (stripWrap) {
    stripWrap.style.display = 'none';
  }
  modal?.classList.remove('open');
  previewModalAssetId = null;
  previewGroupAssetIds = [];
  previewGroupIndex = -1;
  previewGroupLabel = null;
}

function updateCleanupSelectionBar(): void {
  const summaryEl = document.getElementById('cleanup-selection-summary');
  const btnMark = document.getElementById('btn-mark-selected-removed') as HTMLButtonElement | null;
  const selectAllCb = document.getElementById('cleanup-select-all-checkbox') as HTMLInputElement | null;
  const selectAllVisibleCb = document.getElementById('cleanup-select-all-visible') as HTMLInputElement | null;

  const count = selectedCandidateAssetIds.size;
  let totalBytes = 0;
  selectedCandidateAssetIds.forEach(aid => {
    const meta = candidateAssetMeta.get(aid);
    if (meta && meta.bytes) {
      totalBytes += meta.bytes;
    }
  });

  if (summaryEl) {
    summaryEl.textContent = `${count} selected (${formatAppleBytes(totalBytes)})`;
  }

  if (btnMark) {
    btnMark.disabled = count === 0;
    btnMark.textContent = count > 0 ? `🗑️ Mark (${count}) as Removed` : '🗑️ Mark Selected as Removed';
  }

  const allChecked =
    currentCandidateList.length > 0 && currentCandidateList.every(c => selectedCandidateAssetIds.has(c.asset_id));
  if (selectAllCb) {
    selectAllCb.checked = allChecked;
  }
  if (selectAllVisibleCb) {
    selectAllVisibleCb.checked = allChecked;
  }
}

function openCleanupConfirmModal(assetIds: string[]): void {
  pendingRemovalAssetIds = assetIds;
  const modal = document.getElementById('modal-cleanup-confirm');
  if (!modal) return;

  const devNameEl = document.getElementById('cleanup-confirm-device-name');
  const countEl = document.getElementById('cleanup-confirm-count');
  const sizeEl = document.getElementById('cleanup-confirm-size');
  const previewEl = document.getElementById('cleanup-confirm-files-preview');

  let totalBytes = 0;
  const filenames: string[] = [];

  assetIds.forEach(aid => {
    const meta = candidateAssetMeta.get(aid);
    if (meta) {
      totalBytes += meta.bytes || 0;
      filenames.push(meta.filename || meta.original_filename);
    }
  });

  if (devNameEl) {
    devNameEl.textContent = selectedCleanupDevice ? selectedCleanupDevice.camera_model : '—';
  }
  if (countEl) {
    countEl.textContent = `${assetIds.length} asset${assetIds.length === 1 ? '' : 's'}`;
  }
  if (sizeEl) {
    sizeEl.textContent = formatAppleBytes(totalBytes);
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

async function executeCleanupRemoval(): Promise<void> {
  if (!pendingRemovalAssetIds.length) return;

  const btnConfirm = document.getElementById('btn-execute-cleanup-removal') as HTMLButtonElement | null;
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

    pendingRemovalAssetIds.forEach(aid => {
      selectedCandidateAssetIds.delete(aid);
    });

    modal?.classList.remove('open');

    await fetchCleanupCandidates();
    fetchCleanupDevices(true);
  } catch (err: any) {
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

