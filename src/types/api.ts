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
  asset_tags?: MomentTagItem[];
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

export interface AppleMonthSelectionStatus {
  expected_album: string;
  exists: boolean;
  has_assets: boolean;
  asset_count: number;
  matched_album_name?: string | null;
  batch_selected_count?: number;
  ready: boolean;
  status: 'ready' | 'empty' | 'missing';
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
  month_selection?: AppleMonthSelectionStatus;
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
  custom_split_groups?: string[];
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

export interface MonthIngestionUnlockInfo {
  unlocked: boolean;
  pending_months: string[];
  target_month: string;
  latest_ingested_month?: string | null;
  last_complete_month: string;
  active_devices: string[];
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
  month_ingestion_unlock?: MonthIngestionUnlockInfo | null;
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

export interface ThresholdDriverInfo {
  folder: string;
  position: number;
  asset_id: string;
  filename: string;
  score: number;
  unique_count: number;
  asset_count: number;
  rule_id: string;
}

export interface PlannerModeM {
  threshold: {
    historical_min: number;
    current: number;
    aligned: boolean;
    unassigned_above_count?: number;
    proposed_folders_count?: number;
    last_checked_utc?: string | null;
    driver?: ThresholdDriverInfo | null;
  };
  stage_counts: {
    M400: number;
    M450: number;
    M500: number;
    total_moments: number;
    published_moments_total?: number;
    published_untagged_total?: number;
    published_assets_total: number;
    top_published?: { moment_name: string; avg_score: number } | null;
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
    display_stage?: string;
    to_be_curated_exists?: boolean;
    to_be_curated_count?: number;
    to_be_curated_str?: string;
    curated_str?: string;
    published_str?: string;
    can_publish_str?: string;
    is_tagged?: boolean;
    paradigm_confirmed?: boolean;
    tag_summary?: string;
  }>;
  disjoint_recommendations: Array<{
    moment_name: string;
    avg_score: number;
    files: number;
    curated: number;
    published: string;
    action: string;
    details: string;
    suggested_target?: string;
    asset_ids?: string[];
    is_tagged?: boolean;
    paradigm_confirmed?: boolean;
    tag_summary?: string;
  }>;
  unassigned_total_assets: number;
  unassigned_total_clusters: number;
  unassigned_clusters: PlannerUnassignedCluster[];
  grouping_rules?: GroupingRulesState;
  cli_step2_sim?: CliStep2Simulation | null;
}

export interface CliStep2ConsoleMomentRow {
  no: number;
  moment_name: string;
  display_stage: string;
  rank_score: number;
  avg_score: number;
  min_score: number;
  max_score: number;
  total_qualified: number;
  proposed_count: number;
  curated_count: number;
  assets_display: number;
  pub_count: number;
  pub_avg_str: string;
  pub_range_str: string;
  to_be_curated_exists: boolean;
  to_be_curated_count: number;
  to_be_curated_str: string;
  curated_str: string;
  published_str: string;
  can_publish_str: string;
  last_pub_str: string;
  needs_update: boolean;
}

export interface CliStep2PendingPublishingRow {
  moment_name: string;
  display_stage: string;
  avg_proposed: number;
  curated: number;
  published: number;
  pending: number;
  propose: number;
  propose_str: string;
  can_publish_str: string;
  can_publish_ok: boolean;
  to_be_curated_exists: boolean;
  to_be_curated_count: number;
  total_qualified: number;
  proposed_scores: number[];
  proposed_filenames: string[];
}

export interface CliStep2Simulation {
  gate: 'threshold_unaligned' | 'auto_option_2_export' | 'pending_curation_m200_m300' | 'unlocked_publishing_candidates';
  gate_label: string;
  has_pending_curation: boolean;
  all_needs_folder: boolean;
  threshold_aligned: boolean;
  lacie_mounted: boolean;
  table_title: string;
  next_prompt: string;
  counts: {
    ranked_total: number;
    console_total: number;
    needs_update: number;
    up_to_date: number;
    needs_sync_option1: number;
    m100: number;
    m200: number;
    m300: number;
    publishable_tbc: number;
    publishable_clean: number;
    pending_curation: number;
    pending_cooldown: number;
    disjoint_pending: number;
    publishable_tbc_total?: number;
    publishable_clean_total?: number;
    pending_curation_total?: number;
    pending_cooldown_total?: number;
    disjoint_pending_total?: number;
  };
  console_moments: CliStep2ConsoleMomentRow[];
  pending_publishing: {
    publishable_tbc: CliStep2PendingPublishingRow[];
    publishable_clean: CliStep2PendingPublishingRow[];
    pending_curation: CliStep2PendingPublishingRow[];
    pending_cooldown: CliStep2PendingPublishingRow[];
    disjoint: CliStep2PendingPublishingRow[];
  };
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
  is_tagged?: boolean;
  paradigm_confirmed?: boolean;
  tag_summary?: string;
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

export interface PublishMomentAssetItem {
  asset_id: string;
  filename: string;
  score: number;
  media_type: 'photo' | 'video';
  local_files?: string[];
  date_created_utc?: string;
  file_size_bytes?: number;
  duration?: number;
  width?: number;
  height?: number;
  camera_model?: string;
  primary_owner?: string;
  asset_tags?: MomentTagItem[];
}

export interface PublishMomentInfoResponse {
  ok: boolean;
  error?: string;
  moment_name?: string;
  memory_stage?: string;
  shutterfly_url?: string;
  youtube_url?: string;
  curated_count?: number;
  published_count?: number;
  unpublished_count?: number;
  target_batch_size?: number;
  curated_dir?: string;
  curated_dir_exists?: boolean;
  pub_rec_dir?: string;
  pub_rec_dir_exists?: boolean;
  pub_rec_sync?: {
    synced?: boolean;
    copied?: number;
    removed?: number;
    removed_folder?: boolean;
    reason?: string;
    expected_files?: string[];
  };
  assets?: PublishMomentAssetItem[];
  skip_publishing_moved?: number;
  skip_publishing_error?: string;
}

export interface PublishMomentResponse {
  ok: boolean;
  error?: string;
  moment_name?: string;
  inserted_count?: number;
  skipped_count?: number;
  skip_publishing_moved?: number;
  skip_publishing_error?: string;
  photos_count?: number;
  videos_count?: number;
  total_published?: number;
  curated_total?: number;
  new_stage?: string;
  shutterfly_url?: string;
  youtube_url?: string;
  pub_rec_sync?: {
    synced?: boolean;
    copied?: number;
    removed?: number;
    removed_folder?: boolean;
    pub_rec_dir?: string;
  };
}

export interface DisjointDetailAsset {
  asset_id: string;
  original_filename: string;
  score_normalized: number;
  date_created_utc: string;
  month: string;
  media_type: 'photo' | 'video';
  duration: number;
  width: number;
  height: number;
  file_size_bytes: number;
  camera_model: string;
  primary_owner: string;
  qualified: boolean;
  is_duplicate_copy?: boolean;
  duplicate_keeper_id?: string;
  duplicate_keeper_filename?: string;
  duplicate_keeper_moment?: string;
  duplicate_match_tier?: string;
  duplicate_similarity_pct?: number;
  asset_tags?: MomentTagItem[];
}

export interface MomentTagItem {
  category: 'activity' | 'location' | 'people' | 'when' | 'family_member';
  tag_value: string;
  include_in_name: boolean;
  tagged_asset_count?: number;
  db_asset_count?: number;
  db_moment_count?: number;
}

export interface MomentTagSessionSummary {
  session_id: number;
  moment_name: string;
  apply_to_folder_name: boolean;
  composed_name?: string;
  asset_count: number;
  created_at_utc: string;
  metadata_summary?: string;
}

export interface DisjointNameSuggestion {
  activity: string;
  location: string;
  people: string;
  when: string;
  family_members?: string[];
  family_member_pool?: string[];
  suggested_name: string;
  location_candidates?: string[];
  people_candidates?: Array<{ name: string; short_name: string; count: number }>;
}

export interface TagCatalogItem {
  tag_value: string;
  assets: number;
  moments: number;
}

export interface DisjointDetailResponse {
  ok: boolean;
  error?: string;
  moment_name?: string;
  historical_min?: number;
  suggested_target?: string;
  assets?: DisjointDetailAsset[];
  albums_present?: Array<{ parent: string; asset_count: number; full_path: string }>;
  name_suggestion?: DisjointNameSuggestion;
  saved_tags?: MomentTagItem[];
  last_tag_session?: MomentTagSessionSummary | null;
  tag_db_counts?: Record<string, { assets: number; moments: number }>;
  tag_catalog_by_category?: Record<string, TagCatalogItem[]>;
  metadata_summary?: string;
  metadata_struct?: Record<string, any>;
  moment_tagging_paradigm?: string;
  existing_albums?: Array<{ album_name: string; parent_folder_name: string; asset_count: number }>;
  nearby_candidates?: Array<{
    moment_name: string;
    qualified_count: number;
    rel_label: string;
    is_suggested: boolean;
  }>;
}

export interface SaveMomentTagsResponse {
  ok: boolean;
  error?: string;
  session_id?: number;
  moment_name?: string;
  apply_to_folder_name?: boolean;
  composed_name?: string;
  tags_saved?: number;
  assets_tagged?: number;
  merged_existing_count?: number;
  removed_count?: number;
  saved_tags?: MomentTagItem[];
  created_at_utc?: string;
  tag_db_counts?: Record<string, { assets: number; moments: number }>;
  tag_catalog_by_category?: Record<string, TagCatalogItem[]>;
  metadata_summary?: string;
  metadata_struct?: Record<string, any>;
  moment_tags_union?: MomentTagItem[];
  moment_paradigm_confirmed?: boolean;
}

export interface TagLookupAssetItem {
  asset_id: string;
  original_filename: string;
  moment_name: string;
  category: string;
  tag_value: string;
  score_normalized: number;
  date_created_utc: string;
  media_type: 'photo' | 'video';
  is_current: boolean;
}

export interface TagLookupResponse {
  ok: boolean;
  error?: string;
  tag_value?: string;
  category?: string;
  total_assets?: number;
  total_moments?: number;
  moments?: Array<{
    moment_name: string;
    asset_count: number;
    max_score: number;
    is_current: boolean;
  }>;
  assets?: TagLookupAssetItem[];
}

export interface SearchMomentItem {
  moment_name: string;
  total_count: number;
  qualified_count: number;
  rel_label: string;
  min_date: string;
  saved_tags_count: number;
}

export interface SearchMomentsResponse {
  ok: boolean;
  error?: string;
  moments?: SearchMomentItem[];
  total_matched?: number;
}

export interface MomentAssetsPreviewResponse {
  ok: boolean;
  error?: string;
  moment_name?: string;
  historical_min?: number;
  assets?: DisjointDetailAsset[];
  albums_present?: Array<{ parent: string; asset_count: number; full_path: string }>;
  name_suggestion?: DisjointNameSuggestion;
  saved_tags?: MomentTagItem[];
  last_tag_session?: MomentTagSessionSummary | null;
  tag_db_counts?: Record<string, { assets: number; moments: number }>;
  tag_catalog_by_category?: Record<string, TagCatalogItem[]>;
  metadata_summary?: string;
  metadata_struct?: Record<string, any>;
  moment_tags_union?: MomentTagItem[];
  moment_paradigm_confirmed?: boolean;
}

export interface ResolveDisjointResponse {
  ok: boolean;
  error?: string;
  action?: string;
  source_moment?: string;
  combined_moments?: string[];
  target_moment?: string;
  target_parent?: string;
  photos_added?: number;
  albums_deleted?: number;
  db_updated?: number;
  tag_session_id?: number | null;
  tags_applied?: number;
  moment_tags_union?: MomentTagItem[];
  moment_paradigm_confirmed?: boolean;
}

export interface MonthSelectionDetailAsset {
  asset_id: string;
  original_filename: string;
  date_created_utc: string;
  score_normalized: number;
  month: string;
}

export interface LivePhotosMonthSelectionCheck {
  checked: boolean;
  exists: boolean;
  count: number;
  matched_name?: string | null;
  error?: string | null;
}

export interface AppleMonthSelectionDetailResponse {
  ok: boolean;
  error?: string;
  month: string;
  status_code: string;
  is_bypassed: boolean;
  in_queue: boolean;
  batch_assets_count: number;
  db_synced_at_utc?: string | null;
  expected_path: string;
  month_selection: AppleMonthSelectionStatus;
  assets: MonthSelectionDetailAsset[];
  live_photos_app?: LivePhotosMonthSelectionCheck | null;
}

export interface UnifiedGroupingBatchSummary {
  month: string;
  status_code: string;
  count: number;
}

export interface UnifiedGroupingPhotosFolder {
  parent_folder: string;
  full_path: string;
  asset_count: number;
}

export interface UnifiedGroupingPreviewAsset {
  asset_id: string;
  filename: string;
  score: number;
  media_type: 'photo' | 'video';
}

export interface UnifiedGroupingAssetItem {
  asset_id: string;
  original_filename: string;
  score_normalized: number;
  qualified: boolean;
  date_created_utc: string;
  month: string;
  batch_status: string;
  media_type: 'photo' | 'video';
  duration?: number;
  width?: number;
  height?: number;
  file_size_bytes?: number;
  camera_model?: string;
  primary_owner?: string;
  is_duplicate_copy?: boolean;
  duplicate_keeper_filename?: string;
  duplicate_keeper_moment?: string;
  in_moments?: boolean;
  in_to_be_curated?: boolean;
  in_curated?: boolean;
  is_published?: boolean;
  asset_tags?: MomentTagItem[];
}

export interface UnifiedGroupingItem {
  grouping_id: string;
  kind: 'moment' | 'unassigned';
  name: string;
  moment_status: string;
  status_detail: string;
  rule_id?: string;
  rule_reason?: string;
  is_disjoint: boolean;
  can_publish_str: string;
  can_publish_ok: boolean;
  parent_folders: string[];
  photos_folders?: UnifiedGroupingPhotosFolder[];
  curated_folder_exists?: boolean;
  pub_rec_folder_exists?: boolean;
  total_assets: number;
  qualified_assets: number;
  unique_count: number;
  curated_count: number;
  to_be_curated_count: number;
  published_count: number;
  shutterfly_count?: number;
  youtube_count?: number;
  shutterfly_url?: string;
  youtube_url?: string;
  published_at_local?: string;
  duplicate_count: number;
  avg_score: number;
  qualified_avg_score: number;
  min_score: number;
  max_score: number;
  rank_score: number;
  earliest_date: string;
  date_range: string;
  batches: UnifiedGroupingBatchSummary[];
  is_tagged: boolean;
  paradigm_confirmed: boolean;
  tag_summary: string;
  preview_assets: UnifiedGroupingPreviewAsset[];
  inline_assets?: UnifiedGroupingAssetItem[];
}

export interface AllGroupingsResponse {
  ok: boolean;
  error?: string;
  historical_min: number;
  total_groupings: number;
  moments_count: number;
  unassigned_count: number;
  total_assets: number;
  overall_avg_score: number;
  by_status: Record<string, number>;
  groupings: UnifiedGroupingItem[];
}

export interface GroupingAssetsResponse {
  ok: boolean;
  error?: string;
  moment_name: string;
  historical_min: number;
  assets: UnifiedGroupingAssetItem[];
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
    openManagedIntakeModal: (defaultMonth?: string) => void;
    runPlannerBatchAction: (month: string, action: string, confirmMissingMonthSelection?: boolean) => Promise<void>;
    openMonthSelectionDialog: (
      month: string,
      opts?: { sourceStep?: 'step2' | 'step3'; queueBlocked?: boolean }
    ) => Promise<void>;
    createEmptyMonthSelectionFolder: (month: string, expectedAlbum?: string) => Promise<void>;
  }
}

