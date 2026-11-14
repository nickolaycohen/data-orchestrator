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
  duplicate_state?: number;
  is_duplicate_copy?: boolean;
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

export interface GroupingRuleItem {
  id: string;
  priority: number;
  name: string;
  description: string;
  enabled: boolean;
  cluster_count: number;
  asset_count: number;
}

export interface GroupingRulesState {
  rules: GroupingRuleItem[];
  refused_clusters: string[];
  ungrouped_count?: number;
}

export interface PlannerUnassignedCluster {
  orig_rank: number;
  folder: string;
  group_type: string;
  rule_id?: string;
  rule_label?: string;
  rule_reason?: string;
  refused_from_group?: string | null;
  asset_count: number;
  duplicate_copy_count?: number;
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
  grouping_rules?: GroupingRulesState;
}

export interface PlannerOverviewResponse {
  connected: boolean;
  error?: string;
  mode?: string;
  mode_b?: PlannerModeB | null;
  mode_m?: PlannerModeM | null;
}

export interface ModeMDedupDuplicate {
  duplicate_asset_id: string;
  duplicate_filename: string;
  duplicate_ext: string;
  duplicate_score: number;
  duplicate_size_bytes: number;
  duplicate_size_mb: number;
  duplicate_resolution: string;
  duplicate_date: string;
  duplicate_month: string;
  keeper_asset_id: string;
  keeper_filename: string;
  keeper_ext: string;
  keeper_score: number;
  keeper_size_bytes: number;
  keeper_size_mb: number;
  keeper_resolution: string;
  keeper_date: string;
  keeper_moment: string | null;
  match_tier: string;
  hamming_distance: number | null;
  similarity_pct: number | null;
}

export interface ModeMDedupPreviewResponse {
  ok: boolean;
  error?: string;
  threshold: number;
  scanned_unassigned: number;
  pool_size: number;
  duplicate_count: number;
  reclaimable_bytes: number;
  duration_sec: number;
  has_imagehash: boolean;
  newly_hashed?: number;
  duplicates: ModeMDedupDuplicate[];
}

export interface ModeMDedupApplyResponse {
  ok: boolean;
  requested: number;
  photos_added: number;
  db_updated: number;
  ignore_album_path?: string;
  errors?: string[];
  error?: string;
}

export interface MemoriesFolderItem {
  album_pk: number;
  album_name: string;
  parent_folder_pk: number | null;
  parent_folder_name: string;
  full_path: string;
  is_folder: boolean;
  depth: number;
  asset_count: number;
  synced_at_utc: string;
  memory_stage: string | null;
  curated_count: number;
  published_count: number;
}

export interface MemoriesFoldersResponse {
  connected: boolean;
  error?: string;
  source?: string;
  synced_at_utc?: string | null;
  scope?: string;
  total?: number;
  returned?: number;
  scope_counts?: {
    moments?: number;
    curated?: number;
    to_be_curated?: number;
    folders?: number;
    all?: number;
  };
  items: MemoriesFolderItem[];
}

export interface CreateMomentResponse {
  ok: boolean;
  error?: string;
  db_error?: string;
  action?: string;
  album_pk?: number;
  moment_name?: string;
  parent_folder?: string;
  full_path?: string;
  requested_assets?: number;
  photos_added?: number;
  db_inserted_assets?: number;
  db_updated_assets?: number;
  ignored_photos_added?: number;
  ignored_db_updated?: number;
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

