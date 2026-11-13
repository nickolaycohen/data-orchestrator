// ==========================================================================
// TypeScript Interfaces for Data Orchestrator Frontend & FastAPI Contracts
// ==========================================================================

export interface VolumeMount {
  name: string;
  path: string;
  mounted: boolean;
  total_gb?: number;
  used_gb?: number;
  free_gb?: number;
  pct_used?: number;
}

export interface SubmoduleInfo {
  exists: boolean;
  is_git: boolean;
  path?: string;
  branch?: string;
  commit?: string;
}

export interface SystemAlert {
  title: string;
  message: string;
  level?: string;
}

export interface SystemStatusResponse {
  mounts: VolumeMount[];
  submodules: Record<string, SubmoduleInfo>;
  alerts?: SystemAlert[];
}

export interface CleanupDevice {
  camera_model: string;
  primary_owner: string;
  owner?: string;
  is_active: boolean;
  start_date: string | null;
  end_date: string | null;
  total_files: number;
  total_gb: number;
  q1_files: number;
  q1_gb: number;
  q2_files: number;
  q2_gb: number;
  q3_files: number;
  q3_gb: number;
  q4_files: number;
  q4_gb: number;
  q1_max_score: number;
  q2_max_score: number;
  q3_max_score: number;
  reclaimable_files: number;
  reclaimable_gb: number;
  removed_files: number;
  has_actual_snapshot?: boolean;
  snapshot_folder?: string | null;
  snapshot_total_files?: number;
  snapshot_synced_at?: string | null;
  actual_low_count?: number;
  actual_low_gb?: number;
  actual_total_count?: number;
  actual_total_gb?: number;
}

export interface CleanupOwnerGroup {
  owner_name: string;
  device_count: number;
  active_device_count?: number;
  total_files: number;
  reclaimable_files: number;
  reclaimable_gb: number;
  devices: CleanupDevice[];
}

export interface CleanupDevicesResponse {
  connected: boolean;
  error?: string;
  summary: {
    total_devices: number;
    active_devices: number;
    inactive_devices: number;
    total_owners: number;
    total_reclaimable_files: number;
    total_reclaimable_gb: number;
    active_reclaimable_files: number;
    active_reclaimable_gb: number;
    total_removed_files: number;
  };
  owners: CleanupOwnerGroup[];
  devices: CleanupDevice[];
}

export interface CleanupCandidateAsset {
  asset_id: string;
  original_filename: string;
  filename?: string;
  camera_model: string;
  carrier_device?: string;
  origin_camera_model?: string;
  origin_make?: string;
  primary_owner: string;
  month: string;
  date_created_utc?: string;
  capture_timestamp: string;
  file_size_bytes: number;
  bytes?: number;
  file_size_mb: number;
  score_normalized: number;
  score_quartile: number | string;
  assigned_moment: string;
  last_asset_pub?: string | null;
  media_type: 'video' | 'photo';
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  notes?: string;
  actually_on_device?: boolean;
  device_location_filename?: string | null;
  device_match_tier?: string | null;
  device_source_folder?: string | null;
}

export interface CleanupCandidatesResponse {
  connected: boolean;
  error?: string;
  camera_model: string;
  total_candidates: number;
  total_candidates_gb: number;
  q1_max_score: number;
  q2_max_score: number;
  offset: number;
  limit: number;
  candidates: CleanupCandidateAsset[];
}

export interface BatchDeviceSummary {
  coverage_percent: number;
  active_family_count: number;
  matched_family_count: number;
  matched_family_devices: Array<{
    camera_model: string;
    owner_name: string;
    count: number;
  }>;
  missing_family_devices: Array<{
    camera_model: string;
    owner_name: string;
  }>;
  other_devices: Array<{
    camera_model: string;
    owner_name?: string | null;
    count: number;
  }>;
  other_assets_count: number;
}

export interface PlannerBatchCandidate {
  month: string;
  status_code: string;
  status_name?: string;
  total_assets: number;
  fav_assets?: number;
  is_bypassed?: boolean;
  elapsed_days?: number | null;
  in_queue?: boolean;
  next_step: string;
  device_summary?: BatchDeviceSummary | null;
}

export interface PlannerUnassignedCluster {
  orig_rank: number;
  folder: string;
  group_type: string;
  asset_count: number;
  score_span: string;
  max_score: number;
  min_score: number;
  months: string;
  assets: CleanupCandidateAsset[];
}

export interface PlannerModeB {
  status_breakdown: Record<string, { name: string; count: number; assets: number }>;
  active_queue: Array<{
    month: string;
    status: string;
    total_assets: number;
    status_code: string;
    status_name: string;
  }>;
  manual_400_candidates: PlannerBatchCandidate[];
  pipeline_500_candidates: PlannerBatchCandidate[];
  pipeline_000_candidates: PlannerBatchCandidate[];
  total_000_batches: number;
  primary_suggestion: {
    type: string;
    headline: string;
    detail: string;
    recommended_month: string;
    secondary?: string | null;
  } | null;
}

export interface PlannerModeM {
  threshold: {
    historical_min: number;
    current: number;
    aligned: boolean;
    unassigned_above_count: number;
    proposed_folders_count: number;
  };
  stage_counts: {
    M400: number;
    M450: number;
    M500: number;
    total_moments: number;
    published_assets_total: number;
  };
  needs_sync_moments: Array<{
    moment_name: string;
    stage: string;
    assets: number;
    rank_score: number;
    action: string;
  }>;
  actionable_recommendations: Array<{
    rank: number;
    moment_name: string;
    avg_score: number;
    files: number;
    curated: number;
    published: string;
    action: string;
    details: string;
  }>;
  disjoint_recommendations: Array<{
    moment_name: string;
    avg_score: number;
    files: number;
    curated: number;
    published: string;
    action: string;
    details: string;
  }>;
  unassigned_total_assets: number;
  unassigned_total_clusters: number;
  unassigned_clusters: PlannerUnassignedCluster[];
}

export interface PlannerOverviewResponse {
  connected: boolean;
  error?: string;
  mode_b: PlannerModeB;
  mode_m: PlannerModeM;
}

export type TriggerTaskFn = (
  taskId: string,
  args?: Record<string, any> | null,
  openConsole?: boolean,
  onLog?: ((line: string) => void) | null,
  onDone?: ((exitCode: number) => void) | null
) => Promise<void>;

declare global {
  interface Window {
    loadReport: (id: string, title: string, filename: string) => Promise<void>;
    triggerTask: TriggerTaskFn;
    openManagedIntakeModal: () => void;
    runPlannerBatchAction: (month: string, action: string) => Promise<void>;
  }
}

