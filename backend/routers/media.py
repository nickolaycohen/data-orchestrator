import os
import re
import sys
import math
import json
import time
import errno
import shutil
import signal
import subprocess
import sqlite3
from typing import Optional
from pathlib import Path
from datetime import datetime, timedelta, timezone
import calendar
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from backend.config import BASE_DIR, MEDIA_DB_PATH, REPOS, get_db_connection

APPLE_PHOTOS_LIBRARY_PATH = Path("/Volumes/Extreme Pro/Photos Library/All-Media.photoslibrary")
CURATED_LACIE_DIR = Path("/Volumes/LaCie/Media Organizer/Curated")
PUBLISHING_RECOMMENDATION_DIR = Path("/Volumes/LaCie/Media Organizer/Publishing Recommendation")
VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v", ".avi", ".mpg"}

router = APIRouter(prefix="/api/media", tags=["media"])

class BgServiceControlRequest(BaseModel):
    action: str  # "start" or "stop"

class ExecutorControlRequest(BaseModel):
    action: str  # "start", "stop", "restart", "stop_after_step", "cancel_stop_after_step", "resume_cron"

class PublishedUrlUpdateRequest(BaseModel):
    moment_name: str
    shutterfly_url: Optional[str] = None
    youtube_url: Optional[str] = None

class MarkRemovedRequest(BaseModel):
    asset_ids: list[str]
    action: Optional[str] = "remove"  # "remove" or "restore"

class PlannerBatchActionRequest(BaseModel):
    month: str = ""
    months: Optional[list[str]] = None
    action: str  # "queue" | "remove_queue" | "confirm_500" | "bypass_500" | "demote_400" | "reset_000"
    confirm_missing_month_selection: bool = False

class MonthSelectionCreateEmptyRequest(BaseModel):
    month: str

class ModeMDedupApplyRequest(BaseModel):
    asset_ids: list[str]

_cleanup_devices_cache = {
    "timestamp": 0.0,
    "payload": None
}


def _ensure_carrier_device_schema(conn: sqlite3.Connection) -> None:
    """Ensures carrier_device column and device inventory snapshot tables exist."""
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(assets);")
        columns = [row[1] for row in cur.fetchall()]
        if "carrier_device" not in columns:
            cur.execute("ALTER TABLE assets ADD COLUMN carrier_device TEXT DEFAULT NULL;")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_assets_carrier_device ON assets(carrier_device);")
            conn.commit()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS device_actual_assets (
                camera_model TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                device_filename TEXT NOT NULL,
                device_file_size INTEGER DEFAULT 0,
                match_tier TEXT DEFAULT 'exact',
                source_folder TEXT,
                synced_at_utc TEXT NOT NULL,
                PRIMARY KEY (camera_model, asset_id)
            );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_device_actual_asset_id ON device_actual_assets(asset_id);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_device_actual_model ON device_actual_assets(camera_model);")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS device_inventory_snapshots (
                camera_model TEXT PRIMARY KEY,
                folder_path TEXT NOT NULL,
                total_files_on_device INTEGER DEFAULT 0,
                matched_in_db INTEGER DEFAULT 0,
                unmatched_files INTEGER DEFAULT 0,
                synced_at_utc TEXT NOT NULL
            );
        """)
        conn.commit()
    except Exception as e:
        pass


def _run_device_inventory_sync(target_device: Optional[str] = None) -> dict:
    """Invokes scripts/sync_device_inventory.py to refresh ManagedIntake -> DB device mapping."""
    import importlib.util
    script_candidates = [
        REPOS["media-organizer-pipeline"] / "scripts" / "sync_device_inventory.py",
        Path("/Users/nickolaycohen/dev/media-organizer-pipeline/scripts/sync_device_inventory.py"),
    ]
    script_path = next((p for p in script_candidates if p.exists()), None)
    if not script_path or not MEDIA_DB_PATH:
        return {"ok": False, "error": "sync_device_inventory.py not found", "devices": []}
    spec = importlib.util.spec_from_file_location("sync_device_inventory", str(script_path))
    if not spec or not spec.loader:
        return {"ok": False, "error": "Unable to load sync_device_inventory module", "devices": []}
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.sync_intake_to_db(db_path=MEDIA_DB_PATH, target_device=target_device)


def _infer_origin(camera_model: Optional[str], camera_make: Optional[str], filename: str) -> tuple[str, str]:
    """Infers origin capture device / camera model if missing from EXIF."""
    if camera_model and camera_model.strip() and camera_model != "Unknown":
        return camera_model.strip(), (camera_make or "").strip()
    fn_upper = (filename or "").upper()
    if fn_upper.startswith("GX") or fn_upper.startswith("GH") or fn_upper.startswith("GOPR"):
        return "GoPro Video", "GoPro"
    if fn_upper.startswith("DJI_"):
        return "DJI Video", "DJI"
    return "Unknown", "Unknown"

def _ensure_published_url_schema():
    """Ensure migration 060 columns (published_url, shutterfly_url, youtube_url) exist in media_organizer.db."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return
    try:
        rw_conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=5)
        try:
            c = rw_conn.cursor()
            c.execute("PRAGMA table_info(publications)")
            pub_cols = {r[1] for r in c.fetchall()}
            changed = False
            if pub_cols and "published_url" not in pub_cols:
                c.execute("ALTER TABLE publications ADD COLUMN published_url TEXT")
                changed = True
            c.execute("PRAGMA table_info(curated_moments)")
            cm_cols = {r[1] for r in c.fetchall()}
            if cm_cols:
                if "shutterfly_url" not in cm_cols:
                    c.execute("ALTER TABLE curated_moments ADD COLUMN shutterfly_url TEXT")
                    changed = True
                if "youtube_url" not in cm_cols:
                    c.execute("ALTER TABLE curated_moments ADD COLUMN youtube_url TEXT")
                    changed = True
            if changed:
                rw_conn.commit()
        finally:
            rw_conn.close()
    except Exception:
        pass

@router.get("/metrics")
def get_media_metrics():
    conn = get_db_connection(MEDIA_DB_PATH)
    if not conn:
        return {
            "connected": False,
            "error": "Media database unavailable",
            "stats": {}
        }
    
    try:
        cur = conn.cursor()
        
        # Assets count
        cur.execute("SELECT count(*) FROM assets")
        total_assets = cur.fetchone()[0]
        
        # Moments
        cur.execute("SELECT count(*) FROM curated_moments")
        curated_moments_count = cur.fetchone()[0]
        
        # Month batches & Asset phase breakdown
        cur.execute("""
            SELECT count(*), sum(assets_count)
            FROM month_batches
            WHERE status_code IS NULL OR status_code != 'INVALID'
        """)
        batches_row = cur.fetchone()
        month_batches_count = batches_row[0]
        batch_assets_count = batches_row[1] or 0

        # Detailed phase breakdown across assets & month_batches
        cur.execute("""
            WITH m_counts AS (
                SELECT month,
                       COUNT(*) AS cnt,
                       SUM(CASE WHEN aesthetic_score IS NOT NULL THEN 1 ELSE 0 END) AS scored,
                       SUM(CASE WHEN google_favorite = 1 OR apple_favorite = 1 OR apple_photos_monthly_selection = 1 OR mobile_apple_photos_featured_photos = 1 THEN 1 ELSE 0 END) AS favs,
                       SUM(CASE WHEN MomentsAlbumName IS NOT NULL AND MomentsAlbumName != '' THEN 1 ELSE 0 END) AS in_moments
                FROM assets
                GROUP BY month
            )
            SELECT COALESCE(mb.status_code, '000') AS status_code,
                   COALESCE(bs.short_label, 'added') AS label,
                   COALESCE(bs.pipeline_stage, '1.2') AS stage,
                   COUNT(mb.month) AS batches,
                   COALESCE(SUM(mc.cnt), SUM(mb.assets_count), 0) AS assets,
                   COALESCE(SUM(mc.scored), 0) AS scored,
                   COALESCE(SUM(mc.favs), 0) AS favs,
                   COALESCE(SUM(mc.in_moments), 0) AS in_moments
            FROM month_batches mb
            LEFT JOIN m_counts mc ON mb.month = mc.month
            LEFT JOIN batch_status bs ON mb.status_code = bs.code
            WHERE mb.status_code IS NULL OR mb.status_code != 'INVALID'
            GROUP BY COALESCE(mb.status_code, '000')
            ORDER BY status_code
        """)
        phase_rows = [dict(r) for r in cur.fetchall()]

        # Aggregate into major pipeline phases + exact status rows
        phase_summary = {
            "assets_000": 0,
            "batches_000": 0,
            "assets_100_399": 0,
            "batches_100_399": 0,
            "assets_400": 0,
            "batches_400": 0,
            "assets_500_600": 0,
            "batches_500_600": 0,
            "assets_650": 0,
            "batches_650": 0,
            "assets_scored": 0,
            "assets_favorited": 0,
            "assets_in_moments": 0,
            "by_status": phase_rows
        }
        for pr in phase_rows:
            code = str(pr["status_code"] or "000")
            a_cnt = int(pr["assets"] or 0)
            b_cnt = int(pr["batches"] or 0)
            phase_summary["assets_scored"] += int(pr["scored"] or 0)
            phase_summary["assets_favorited"] += int(pr["favs"] or 0)
            phase_summary["assets_in_moments"] += int(pr["in_moments"] or 0)
            if code == "000":
                phase_summary["assets_000"] += a_cnt
                phase_summary["batches_000"] += b_cnt
            elif code in ("100", "100E", "200", "200E", "210", "399"):
                phase_summary["assets_100_399"] += a_cnt
                phase_summary["batches_100_399"] += b_cnt
            elif code in ("400", "400E"):
                phase_summary["assets_400"] += a_cnt
                phase_summary["batches_400"] += b_cnt
            elif code in ("500", "550", "600"):
                phase_summary["assets_500_600"] += a_cnt
                phase_summary["batches_500_600"] += b_cnt
            elif code == "650":
                phase_summary["assets_650"] += a_cnt
                phase_summary["batches_650"] += b_cnt

        # Moment stage breakdown (M400, M450, M500)
        cur.execute("""
            SELECT COALESCE(memory_stage, 'M400') AS stage,
                   COUNT(*) AS moments,
                   COALESCE(SUM(to_be_curated_count), 0) AS to_be_curated_assets,
                   COALESCE(SUM(curated_count), 0) AS curated_assets
            FROM curated_moments
            GROUP BY COALESCE(memory_stage, 'M400')
        """)
        moment_stages = {"M400": 0, "M450": 0, "M500": 0, "curated_assets": 0, "to_be_curated_assets": 0}
        for mr in cur.fetchall():
            st = mr["stage"]
            if st in moment_stages:
                moment_stages[st] = int(mr["moments"] or 0)
            moment_stages["curated_assets"] += int(mr["curated_assets"] or 0)
            moment_stages["to_be_curated_assets"] += int(mr["to_be_curated_assets"] or 0)
        
        # Triage summary
        cur.execute("""
            SELECT count(*), coalesce(sum(total_files_scanned), 0), 
                   coalesce(sum(duplicates_count), 0), coalesce(sum(duplicates_bytes), 0)
            FROM triage_sessions
        """)
        triage_row = cur.fetchone()
        triage_sessions = triage_row[0]
        triage_scanned = triage_row[1]
        triage_duplicates = triage_row[2]
        triage_bytes = triage_row[3]
        
        # Recent pipeline executions
        cur.execute("""
            SELECT id, session_id, label, status, executed_at_utc 
            FROM pipeline_executions 
            ORDER BY id DESC LIMIT 6
        """)
        recent_executions = [dict(r) for r in cur.fetchall()]
        
        # Recent curated moments
        cur.execute("""
            SELECT moment_name, to_be_curated_count, curated_count, memory_stage, last_pipeline_sync
            FROM curated_moments
            WHERE curated_count > 0 OR to_be_curated_count > 0
            ORDER BY last_pipeline_sync DESC LIMIT 8
        """)
        featured_moments = [dict(r) for r in cur.fetchall()]

        # Published Moments History (Shutterfly & YouTube) with Normalized Scoring
        _ensure_published_url_schema()
        published_moments = []
        published_summary = {
            "total_moments": 0,
            "total_assets": 0,
            "shutterfly_assets": 0,
            "youtube_assets": 0,
            "overall_avg_score": 0.0
        }
        try:
            cur.execute("PRAGMA table_info(publications)")
            has_pub_url = "published_url" in {r[1] for r in cur.fetchall()}
            cur.execute("PRAGMA table_info(curated_moments)")
            cm_col_names = {r[1] for r in cur.fetchall()}
            has_cm_urls = "shutterfly_url" in cm_col_names and "youtube_url" in cm_col_names

            sf_url_expr = (
                "COALESCE(NULLIF(cm.shutterfly_url, ''), MAX(CASE WHEN LOWER(COALESCE(p.platform, '')) LIKE '%shutterfly%' THEN NULLIF(p.published_url, '') END))"
                if (has_pub_url and has_cm_urls) else "NULL"
            )
            yt_url_expr = (
                "COALESCE(NULLIF(cm.youtube_url, ''), MAX(CASE WHEN LOWER(COALESCE(p.platform, '')) LIKE '%youtube%' THEN NULLIF(p.published_url, '') END))"
                if (has_pub_url and has_cm_urls) else "NULL"
            )

            cur.execute(f"""
                SELECT 
                    p.moment_name,
                    MAX(p.published_at_utc) AS last_published_utc,
                    COUNT(DISTINCT p.asset_uuid) AS published_count,
                    COUNT(DISTINCT CASE
                        WHEN LOWER(COALESCE(p.platform, '')) LIKE '%shutterfly%'
                          OR (
                              LOWER(COALESCE(p.platform, '')) NOT LIKE '%youtube%'
                              AND LOWER(COALESCE(p.filename, a.original_filename, '')) NOT LIKE '%.mov'
                              AND LOWER(COALESCE(p.filename, a.original_filename, '')) NOT LIKE '%.mp4'
                              AND LOWER(COALESCE(p.filename, a.original_filename, '')) NOT LIKE '%.m4v'
                          )
                        THEN p.asset_uuid END) AS shutterfly_count,
                    COUNT(DISTINCT CASE
                        WHEN LOWER(COALESCE(p.platform, '')) LIKE '%youtube%'
                          OR LOWER(COALESCE(p.filename, a.original_filename, '')) LIKE '%.mov'
                          OR LOWER(COALESCE(p.filename, a.original_filename, '')) LIKE '%.mp4'
                          OR LOWER(COALESCE(p.filename, a.original_filename, '')) LIKE '%.m4v'
                        THEN p.asset_uuid END) AS youtube_count,
                    {sf_url_expr} AS shutterfly_url,
                    {yt_url_expr} AS youtube_url,
                    GROUP_CONCAT(DISTINCT p.platform) AS platforms,
                    GROUP_CONCAT(DISTINCT p.account) AS accounts,
                    AVG(
                        (COALESCE(a.aesthetic_score, 0) * 0.875) +
                        (COALESCE(a.google_favorite, 0) * 0.125) +
                        (COALESCE(a.apple_photos_monthly_selection, 0) * 0.15) +
                        (COALESCE(a.mobile_apple_photos_featured_photos, 0) * 0.15)
                    ) AS avg_score,
                    MIN(
                        (COALESCE(a.aesthetic_score, 0) * 0.875) +
                        (COALESCE(a.google_favorite, 0) * 0.125) +
                        (COALESCE(a.apple_photos_monthly_selection, 0) * 0.15) +
                        (COALESCE(a.mobile_apple_photos_featured_photos, 0) * 0.15)
                    ) AS min_score,
                    MAX(
                        (COALESCE(a.aesthetic_score, 0) * 0.875) +
                        (COALESCE(a.google_favorite, 0) * 0.125) +
                        (COALESCE(a.apple_photos_monthly_selection, 0) * 0.15) +
                        (COALESCE(a.mobile_apple_photos_featured_photos, 0) * 0.15)
                    ) AS max_score,
                    MIN(a.date_created_utc) AS min_captured,
                    MAX(a.date_created_utc) AS max_captured,
                    COALESCE(cm.memory_stage, 'M500') AS memory_stage,
                    COALESCE(cm.curated_count, 0) AS curated_count
                FROM publications p
                LEFT JOIN assets a ON p.asset_uuid = a.asset_id
                LEFT JOIN curated_moments cm ON cm.moment_name = p.moment_name
                GROUP BY p.moment_name
                ORDER BY avg_score DESC NULLS LAST, last_published_utc DESC, p.moment_name ASC
            """)
            pub_rows = cur.fetchall()
            pub_tag_status_by_lc, _ = _load_moment_tagging_status_map(cur)
            for row in pub_rows:
                r_dict = dict(row)
                raw_pub = r_dict.get("last_published_utc") or ""
                pub_local = raw_pub[:19] if raw_pub else "—"
                if raw_pub:
                    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                        try:
                            dt_utc = datetime.strptime(raw_pub, fmt).replace(tzinfo=timezone.utc)
                            pub_local = dt_utc.astimezone().strftime("%Y-%m-%d %H:%M:%S")
                            break
                        except ValueError:
                            continue
                d_min = (r_dict.get("min_captured") or "")[:10]
                d_max = (r_dict.get("max_captured") or "")[:10]
                capture_range = f"{d_min} to {d_max}" if (d_min and d_max and d_min != d_max) else (d_min or "—")

                avg_s = round(float(r_dict["avg_score"]), 4) if r_dict.get("avg_score") is not None else 0.0
                min_s = round(float(r_dict["min_score"]), 4) if r_dict.get("min_score") is not None else 0.0
                max_s = round(float(r_dict["max_score"]), 4) if r_dict.get("max_score") is not None else 0.0
                m_name_val = r_dict["moment_name"] or "Untitled Moment"
                t_info = pub_tag_status_by_lc.get(m_name_val.strip().lower())

                published_moments.append({
                    "moment_name": m_name_val,
                    "published_at_utc": raw_pub,
                    "published_at_local": pub_local,
                    "published_count": int(r_dict["published_count"] or 0),
                    "shutterfly_count": int(r_dict["shutterfly_count"] or 0),
                    "youtube_count": int(r_dict["youtube_count"] or 0),
                    "shutterfly_url": (r_dict.get("shutterfly_url") or "").strip(),
                    "youtube_url": (r_dict.get("youtube_url") or "").strip(),
                    "platforms": [x.strip() for x in (r_dict.get("platforms") or "Shutterfly").split(",") if x.strip()],
                    "accounts": [x.strip() for x in (r_dict.get("accounts") or "").split(",") if x.strip()],
                    "avg_score": avg_s,
                    "min_score": min_s,
                    "max_score": max_s,
                    "score_range": f"{min_s:.4f} – {max_s:.4f}" if min_s > 0 else "—",
                    "capture_range": capture_range,
                    "memory_stage": r_dict.get("memory_stage") or "M500",
                    "curated_count": int(r_dict.get("curated_count") or 0),
                    "is_tagged": bool(t_info),
                    "paradigm_confirmed": bool(t_info and t_info.get("paradigm_confirmed")),
                    "tag_summary": (t_info or {}).get("tag_summary", ""),
                })

            if published_moments:
                tot_assets = sum(m["published_count"] for m in published_moments)
                sf_assets = sum(m["shutterfly_count"] for m in published_moments)
                yt_assets = sum(m["youtube_count"] for m in published_moments)
                weighted_score = sum(m["avg_score"] * m["published_count"] for m in published_moments)
                published_summary = {
                    "total_moments": len(published_moments),
                    "total_assets": tot_assets,
                    "shutterfly_assets": sf_assets,
                    "youtube_assets": yt_assets,
                    "overall_avg_score": round(weighted_score / max(1, tot_assets), 4),
                    "shutterfly_url": "https://photos.shutterfly.com/",
                    "youtube_url": "https://www.youtube.com/"
                }
        except Exception:
            pass

        # Recent triage sessions
        cur.execute("""
            SELECT id, triage_id, source_directory, status, total_files_scanned, duplicates_count, duplicates_bytes
            FROM triage_sessions
            ORDER BY id DESC LIMIT 5
        """)
        recent_triage = [dict(r) for r in cur.fetchall()]

        phase_summary["assets_published"] = int(published_summary.get("total_assets") or 0)

        return {
            "connected": True,
            "stats": {
                "total_assets": total_assets,
                "curated_moments": curated_moments_count,
                "month_batches": month_batches_count,
                "batch_assets": batch_assets_count,
                "triage_sessions": triage_sessions,
                "triage_scanned": triage_scanned,
                "triage_duplicates": triage_duplicates,
                "triage_saved_gb": round(triage_bytes / (1024**3), 2),
                "phase_breakdown": phase_summary,
                "moment_stages": moment_stages
            },
            "recent_executions": recent_executions,
            "featured_moments": featured_moments,
            "published_moments": published_moments,
            "published_summary": published_summary,
            "recent_triage": recent_triage
        }
    except Exception as e:
        return {
            "connected": True,
            "error": str(e),
            "stats": {}
        }
    finally:
        conn.close()

@router.get("/executor-monitor")
def get_executor_monitor():
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    pipe_repo = REPOS["media-organizer-pipeline"]
    sibling_repo = Path("/Users/nickolaycohen/dev/media-organizer-pipeline")

    # 1. Check Executor Status via lock files
    lock_paths = [pipe_repo / "db" / "executor.lock", sibling_repo / "db" / "executor.lock"]
    is_running = False
    pid = None
    status = "IDLE"
    for lp in lock_paths:
        if lp.exists():
            try:
                pid = int(lp.read_text().strip())
                os.kill(pid, 0)
                is_running = True
                status = "ACTIVE"
                break
            except OSError as e:
                if e.errno == errno.ESRCH:
                    status = "STALE"
                else:
                    is_running = True
                    status = "ACTIVE"
                break
            except Exception:
                pass

    # 2. Check Backup Safety
    backup_paths = [pipe_repo / "db" / "backup.lock", sibling_repo / "db" / "backup.lock"]
    backup_active = any(bp.exists() for bp in backup_paths)

    # 3. Query Execution Queue from database
    queue = []
    conn = get_db_connection(MEDIA_DB_PATH)
    if conn:
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT pe.id, pe.planned_month, pe.set_at_utc, pe.active,
                       mb.status_code, mb.updated_at_utc,
                       bs.short_label as status_label
                FROM planned_execution pe
                LEFT JOIN month_batches mb ON pe.planned_month = mb.month
                LEFT JOIN batch_status bs ON mb.status_code = bs.code
                WHERE pe.active = 1
                ORDER BY pe.id ASC
            """)
            for idx, r in enumerate(cur.fetchall()):
                queue.append({
                    "id": r["id"],
                    "month": r["planned_month"],
                    "set_at_utc": r["set_at_utc"],
                    "status_code": r["status_code"] or "Unknown",
                    "status_label": r["status_label"] or "",
                    "updated_at_utc": r["updated_at_utc"],
                    "is_in_progress": (idx == 0 and is_running)
                })
        except Exception:
            pass
        finally:
            conn.close()

    # 4. Tail Log & parse progress + Upload Throughput Timeline
    log_candidates = [sibling_repo / "logs" / "media_organizer.log", pipe_repo / "logs" / "media_organizer.log"]
    current_step = "—"
    upload_progress = None
    upload_details = None
    log_lines = []
    throughput_points = []
    throughput_summary = {
        "current_rolling_mbps": 0.0,
        "latest_instant_mbps": 0.0,
        "peak_mbps": 0.0,
        "avg_mbps": 0.0,
        "total_mb": 0.0,
        "total_files": 0,
        "video_count": 0,
        "photo_count": 0,
        "latest_asset": None
    }

    re_uploading = re.compile(
        r'^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}),(\d+)\s+\[upload_to_google_photos:\d+\]\s+-\s+INFO\s+-\s+\[(\d+)/(\d+)\]\s+Uploading:\s+(.+?)\s+\(([\d.]+)\s*MB\)\s+-\s+Est\.\s+Completion:\s+(\S+)\s+\(([\d.]+)m\s+remaining\s+at\s+([\d.]+)\s*(KB|MB)/s\)'
    )
    re_uploaded = re.compile(
        r'^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}),(\d+)\s+\[upload_to_google_photos:\d+\]\s+-\s+INFO\s+-\s+\[(\d+)/(\d+)\]\s+Uploaded:\s+(.+?)\s+-\s+Est\.\s+Completion:\s+(\S+)\s+\(([\d.]+)m\s+remaining\)'
    )
    re_batch_start = re.compile(r'Starting upload to Google Photos for month:\s*(\S+)')
    re_hb_batch = re.compile(r'Heartbeat:\s*Batch\s*(\d{4}-\d{2})')

    for lp in log_candidates:
        if lp.exists():
            try:
                file_size = lp.stat().st_size
                tail_bytes = 2097152  # 2 MB tail for deeper timeline zoom/scaling
                with open(lp, "rb") as f:
                    if file_size > tail_bytes:
                        f.seek(file_size - tail_bytes)
                    raw_bytes = f.read()
                lines = raw_bytes.decode("utf-8", errors="replace").splitlines()
                if file_size > tail_bytes and lines:
                    lines = lines[1:]  # drop partial first line

                log_lines = [l for l in lines[-8:] if l.strip()]
                live_asset_ratio = None
                for line in reversed(lines[-200:]):
                    if "⏱️ Heartbeat:" in line and current_step == "—":
                        current_step = line.strip().split("⏱️ Heartbeat:")[-1].strip()
                        current_step = current_step.replace(
                            "2.4 Partial upload to Google Photos due to insufficient space",
                            "2.4 Upload to Google Account from Staging Folder"
                        )
                    if "[upload_to_google_photos:" in line and "Uploading:" in line and not upload_progress:
                        m = re.search(r'\[(\d+)/(\d+)\] Uploading: (.+?) \(([\d.]+\s*MB)\) - Est\. Completion: ([^ ]+) \(([^)]+)\)', line)
                        if m:
                            idx_num = int(m.group(1))
                            tot_num = int(m.group(2))
                            done_num = max(0, idx_num - 1)
                            pct_val = round((done_num / tot_num) * 100, 1) if tot_num > 0 else 0.0
                            live_asset_ratio = f"{done_num}/{tot_num} ({pct_val:.1f}%)"
                            upload_progress = f"Asset {idx_num}/{tot_num}: {m.group(3)} ({m.group(4)}) | ETA: {m.group(5)} ({m.group(6)})"
                            upload_details = {
                                "current": idx_num,
                                "total": tot_num,
                                "pct": pct_val,
                                "filename": m.group(3),
                                "size": m.group(4),
                                "eta": m.group(5),
                                "speed": m.group(6)
                            }
                if current_step != "—" and live_asset_ratio:
                    current_step = re.sub(r'Assets:\s*0/\d+', f'Assets: {live_asset_ratio}', current_step)

                # Parse upload throughput timeline across lines
                active_uploads = {}
                cur_batch = None
                all_points = []
                for line in lines:
                    if "Starting upload to Google Photos for month:" in line:
                        mb = re_batch_start.search(line)
                        if mb:
                            cur_batch = mb.group(1)
                    elif "Heartbeat: Batch " in line:
                        mh = re_hb_batch.search(line)
                        if mh:
                            cur_batch = mh.group(1)
                    elif "[upload_to_google_photos:" in line:
                        if "Uploading:" in line:
                            mu = re_uploading.match(line)
                            if mu:
                                try:
                                    dt_s, ms_s = mu.group(1), mu.group(2)
                                    idx_s, tot_s = mu.group(3), mu.group(4)
                                    fname = mu.group(5).strip()
                                    fsize_mb = float(mu.group(6))
                                    spd_val = float(mu.group(9))
                                    spd_unit = mu.group(10)
                                    rolling_mbps = spd_val / 1024.0 if spd_unit == "KB" else spd_val
                                    ts_start = datetime.strptime(dt_s, "%Y-%m-%d %H:%M:%S").timestamp() + (int(ms_s) / 1000.0)
                                    active_uploads[(idx_s, tot_s, fname)] = (ts_start, fsize_mb, rolling_mbps, cur_batch)
                                except Exception:
                                    pass
                        elif "Uploaded:" in line:
                            md = re_uploaded.match(line)
                            if md:
                                try:
                                    dt_end_s, ms_end_s = md.group(1), md.group(2)
                                    idx_s, tot_s = md.group(3), md.group(4)
                                    fname = md.group(5).strip()
                                    key = (idx_s, tot_s, fname)
                                    if key in active_uploads:
                                        ts_start, fsize_mb, rolling_mbps, b_month = active_uploads.pop(key)
                                        ts_end = datetime.strptime(dt_end_s, "%Y-%m-%d %H:%M:%S").timestamp() + (int(ms_end_s) / 1000.0)
                                        dur_s = max(0.05, ts_end - ts_start)
                                        if dur_s < 600:
                                            inst_mbps = fsize_mb / dur_s
                                            all_points.append({
                                                "ts": round(ts_end, 2),
                                                "timestamp": dt_end_s,
                                                "time": dt_end_s.split(" ")[1],
                                                "batch": b_month or "Batch",
                                                "idx": int(idx_s),
                                                "total": int(tot_s),
                                                "asset_ref": f"{idx_s}/{tot_s}",
                                                "filename": fname,
                                                "is_video": fname.lower().endswith((".mov", ".mp4", ".m4v")),
                                                "size_mb": round(fsize_mb, 2),
                                                "duration_s": round(dur_s, 2),
                                                "instant_mbps": round(inst_mbps, 2),
                                                "rolling_mbps": round(rolling_mbps, 2)
                                            })
                                except Exception:
                                    pass

                throughput_points = all_points[-500:]
                if throughput_points:
                    tot_mb = sum(p["size_mb"] for p in throughput_points)
                    tot_dur = sum(p["duration_s"] for p in throughput_points)
                    v_cnt = sum(1 for p in throughput_points if p["is_video"])
                    throughput_summary = {
                        "current_rolling_mbps": throughput_points[-1]["rolling_mbps"],
                        "latest_instant_mbps": throughput_points[-1]["instant_mbps"],
                        "peak_mbps": round(max(p["instant_mbps"] for p in throughput_points), 2),
                        "avg_mbps": round(tot_mb / max(0.1, tot_dur), 2),
                        "total_mb": round(tot_mb, 1),
                        "total_files": len(throughput_points),
                        "video_count": v_cnt,
                        "photo_count": len(throughput_points) - v_cnt,
                        "latest_asset": throughput_points[-1]
                    }
                break
            except Exception:
                pass

    schedule_items = [
        {"time": "03:00 AM", "title": "macOS Time Machine Backup", "command": "tmutil startbackup", "target": "Local & External Disks"},
        {"time": "05:30 AM", "title": "Apple Photos Albums Backup", "command": "reconstruct_apple_albums.py --backup", "target": "Album Manifest DB"},
        {"time": "06:00 AM", "title": "SQLite Master Hot Backup", "command": "backup_database.py", "target": "media_organizer.db.gz"}
    ]

    # 5. Background Database Copy & Sync Service (bg_copy_db_service.py)
    bg_pid_candidates = [
        Path("/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.service.pid"),
        Path("/Volumes/Macintosh HD/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.service.pid"),
    ]
    bg_running = False
    bg_pid = None
    for pp in bg_pid_candidates:
        if pp.exists():
            try:
                bg_pid = int(pp.read_text().strip())
                os.kill(bg_pid, 0)
                bg_running = True
                break
            except OSError as e:
                if e.errno != errno.ESRCH:
                    bg_running = True
                    break
            except Exception:
                pass

    db_lock_candidates = [
        Path("/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.lock"),
        Path("/Volumes/Macintosh HD/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.lock"),
    ]
    db_lock_data = {}
    for dlp in db_lock_candidates:
        if dlp.exists():
            try:
                db_lock_data = json.loads(dlp.read_text(encoding="utf-8"))
                break
            except Exception:
                pass

    db_lock_status = db_lock_data.get("status", "available")
    db_lock_pid = db_lock_data.get("pid")
    db_lock_started = db_lock_data.get("started_at_utc")
    latest_refresh_utc = db_lock_data.get("latest_successful_refresh_utc", "—")
    db_lock_pid_alive = False
    if db_lock_pid:
        try:
            os.kill(int(db_lock_pid), 0)
            db_lock_pid_alive = True
        except OSError as e:
            if e.errno != errno.ESRCH:
                db_lock_pid_alive = True
        except Exception:
            pass

    src_db_path = Path("/Volumes/Extreme Pro/Photos Library/All-Media.photoslibrary/database/Photos.sqlite")
    src_wal_path = Path("/Volumes/Extreme Pro/Photos Library/All-Media.photoslibrary/database/Photos.sqlite-wal")
    source_online = src_db_path.exists()
    source_mod_utc = "—"
    sync_needed = False
    sync_state = "UP_TO_DATE"
    sync_reason = "Database copy is up to date"

    if source_online:
        try:
            src_mtime = src_db_path.stat().st_mtime
            if src_wal_path.exists():
                src_mtime = max(src_mtime, src_wal_path.stat().st_mtime)
            source_mod_utc = datetime.fromtimestamp(src_mtime, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            if latest_refresh_utc and latest_refresh_utc != "—":
                clean_refresh = latest_refresh_utc.replace(" UTC", "").strip()
                last_dt = datetime.strptime(clean_refresh, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                if src_mtime > (last_dt.timestamp() + 2.0):
                    sync_needed = True
                    sync_state = "SYNC_PENDING"
                    sync_reason = f"Source DB ({source_mod_utc} UTC) has newer changes than last sync"
            else:
                sync_needed = True
                sync_state = "SYNC_PENDING"
                sync_reason = "No prior successful refresh recorded"
        except Exception as e:
            sync_state = "UNKNOWN"
            sync_reason = f"Could not compare timestamps: {e}"
    else:
        sync_state = "SOURCE_OFFLINE"
        sync_reason = "Source volume (/Volumes/Extreme Pro) unmounted"

    if db_lock_status == "refreshing" and db_lock_pid_alive:
        sync_state = "REFRESHING"
        sync_reason = f"Currently refreshing & syncing metadata (PID: {db_lock_pid})"

    bg_log_candidates = [
        sibling_repo / "logs" / "bg_copy_db_service.log",
        pipe_repo / "logs" / "bg_copy_db_service.log",
    ]
    bg_log_tail = []
    bg_last_summary = "—"
    bg_latest_event = "—"
    for blp in bg_log_candidates:
        if blp.exists():
            try:
                blines = blp.read_text(encoding="utf-8", errors="replace").splitlines()[-80:]
                bg_log_tail = [l for l in blines[-6:] if l.strip()]
                if bg_log_tail:
                    last_raw = bg_log_tail[-1]
                    bg_latest_event = last_raw.split("[bg_copy_db_service] - ")[-1].strip() if "[bg_copy_db_service] - " in last_raw else last_raw
                for line in reversed(blines):
                    if "🎉 Database refresh and metadata sync completed successfully" in line and bg_last_summary == "—":
                        m_dur = re.search(r'in ([\d.]+) seconds', line)
                        dur_str = f"{m_dur.group(1)}s" if m_dur else "completed"
                        bg_last_summary = f"Completed in {dur_str}"
                    if "✅ Backup complete in" in line and "folders," in line:
                        m_bk = re.search(r'(\d+ folders, \d+ user albums.*?member asset associations)', line)
                        if m_bk:
                            bg_last_summary = f"{bg_last_summary} · {m_bk.group(1)}" if bg_last_summary != "—" else m_bk.group(1)
                            break
                break
            except Exception:
                pass

    if db_lock_status == "refreshing" and db_lock_pid_alive:
        bg_status = "REFRESHING"
    elif bg_running:
        bg_status = "RUNNING"
    else:
        bg_status = "STOPPED"

    paused_paths = [sibling_repo / "db" / "executor.paused", pipe_repo / "db" / "executor.paused"]
    stop_after_paths = [sibling_repo / "db" / "executor.stop_after_step", pipe_repo / "db" / "executor.stop_after_step"]
    paused_info = None
    paused_flag = False
    for pp in paused_paths:
        if pp.exists():
            paused_flag = True
            try:
                paused_info = json.loads(pp.read_text(encoding="utf-8"))
            except Exception:
                paused_info = {"paused_at_utc": None}
            break
    stop_after_flag = any(sp.exists() for sp in stop_after_paths)

    return {
        "timestamp": now_str,
        "executor": {
            "is_running": is_running,
            "pid": pid,
            "status": status,
            "paused": paused_flag,
            "paused_at_utc": (paused_info or {}).get("paused_at_utc"),
            "stop_after_step": stop_after_flag,
            "status_banner": f"ACTIVE (PID: {pid})" if is_running else (f"STALE (PID: {pid})" if status == "STALE" else "IDLE")
        },
        "bg_service": {
            "is_running": bg_running,
            "pid": bg_pid,
            "status": bg_status,
            "lock_status": db_lock_status,
            "lock_pid": db_lock_pid,
            "lock_pid_alive": db_lock_pid_alive,
            "lock_started_utc": db_lock_started,
            "latest_refresh_utc": latest_refresh_utc,
            "source_online": source_online,
            "source_mod_utc": source_mod_utc,
            "sync_needed": sync_needed,
            "sync_state": sync_state,
            "sync_reason": sync_reason,
            "last_summary": bg_last_summary,
            "latest_event": bg_latest_event,
            "log_tail": bg_log_tail
        },
        "backup_safety": {
            "is_locked": backup_active,
            "status": "ACTIVE_BACKUP" if backup_active else "CLEAR",
            "message": "ACTIVE BACKUP IN PROGRESS" if backup_active else "CLEAR (No backup collision)",
            "schedule": schedule_items
        },
        "queue": queue,
        "queue_count": len(queue),
        "activity": {
            "current_step": current_step,
            "upload_progress": upload_progress,
            "upload_details": upload_details,
            "log_tail": log_lines
        },
        "throughput": {
            "summary": throughput_summary,
            "points": throughput_points
        }
    }

def _list_child_pids(parent_pid: int) -> list[int]:
    """Return direct child PIDs for a running process using pgrep."""
    try:
        res = subprocess.run(["pgrep", "-P", str(parent_pid)], capture_output=True, text=True, check=False)
        if res.returncode == 0 and res.stdout:
            return [int(line.strip()) for line in res.stdout.splitlines() if line.strip().isdigit()]
    except Exception:
        pass
    return []


def _is_pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as e:
        return e.errno != errno.ESRCH


def _wait_pids_exit(pids: list[int], timeout_sec: float) -> list[int]:
    """Wait up to timeout_sec for given PIDs to exit and return any still alive."""
    deadline = time.time() + timeout_sec
    remaining = list(pids)
    while remaining and time.time() < deadline:
        remaining = [p for p in remaining if _is_pid_alive(p)]
        if not remaining:
            return []
        time.sleep(0.2)
    return [p for p in remaining if _is_pid_alive(p)]


def _release_executor_locks(stopped_pid: Optional[int], lock_paths: list[Path]) -> None:
    """Remove stale executor.lock and clear executor_active DB copy lock if owned by stopped/dead PID."""
    for lp in lock_paths:
        if lp.exists():
            try:
                cur_pid = int(lp.read_text().strip())
            except Exception:
                cur_pid = None
            if not _is_pid_alive(cur_pid):
                try:
                    lp.unlink()
                except OSError:
                    pass

    db_lock_candidates = [
        Path("/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.lock"),
        Path("/Volumes/Macintosh HD/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.lock"),
    ]
    for dlp in db_lock_candidates:
        if not dlp.exists():
            continue
        try:
            lock_data = json.loads(dlp.read_text(encoding="utf-8"))
        except Exception:
            continue
        if lock_data.get("status") != "executor_active":
            continue
        lock_pid = lock_data.get("pid")
        if lock_pid == stopped_pid or not _is_pid_alive(lock_pid):
            try:
                lock_data["status"] = "available"
                lock_data["pid"] = None
                dlp.write_text(json.dumps(lock_data, indent=2), encoding="utf-8")
            except OSError:
                pass


@router.post("/executor/control")
def control_executor(req: ExecutorControlRequest):
    action = (req.action or "").strip().lower()
    pipe_repo = REPOS["media-organizer-pipeline"]
    sibling_repo = Path("/Users/nickolaycohen/dev/media-organizer-pipeline")
    target_repo = sibling_repo if (sibling_repo / "scripts" / "pipeline_executor.py").exists() else pipe_repo

    lock_paths = [target_repo / "db" / "executor.lock", pipe_repo / "db" / "executor.lock", sibling_repo / "db" / "executor.lock"]
    paused_paths = [target_repo / "db" / "executor.paused", pipe_repo / "db" / "executor.paused", sibling_repo / "db" / "executor.paused"]
    stop_after_paths = [target_repo / "db" / "executor.stop_after_step", pipe_repo / "db" / "executor.stop_after_step", sibling_repo / "db" / "executor.stop_after_step"]

    def _dedup_paths(paths: list[Path]) -> list[Path]:
        seen = set()
        out = []
        for p in paths:
            rp = str(p.resolve()) if p.parent.exists() else str(p)
            if rp not in seen:
                seen.add(rp)
                out.append(p)
        return out

    lock_paths = _dedup_paths(lock_paths)
    paused_paths = _dedup_paths(paused_paths)
    stop_after_paths = _dedup_paths(stop_after_paths)

    active_pid = None
    for lp in lock_paths:
        if lp.exists():
            try:
                cand_pid = int(lp.read_text().strip())
                if _is_pid_alive(cand_pid):
                    active_pid = cand_pid
                    break
            except Exception:
                pass

    def _clear_sentinels(paths: list[Path]) -> None:
        for p in paths:
            if p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass

    def _write_pause_sentinel(reason: str) -> None:
        p = target_repo / "db" / "executor.paused"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(
                {"paused_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), "reason": reason},
                indent=2,
            ),
            encoding="utf-8",
        )

    def _stop_running(set_paused: bool) -> tuple[bool, Optional[int], str]:
        _clear_sentinels(stop_after_paths)
        if set_paused:
            _write_pause_sentinel("manual_ui_stop")
        else:
            _clear_sentinels(paused_paths)

        if not active_pid:
            _release_executor_locks(None, lock_paths)
            return True, None, "Executor was already stopped (cleaned stale locks)."

        child_pids = _list_child_pids(active_pid)
        try:
            os.kill(active_pid, signal.SIGTERM)
        except OSError as e:
            if e.errno != errno.ESRCH:
                return False, active_pid, f"Failed sending SIGTERM to PID {active_pid}: {e}"

        still_parent = _wait_pids_exit([active_pid], 10.0)
        if still_parent:
            try:
                os.kill(active_pid, signal.SIGKILL)
                _wait_pids_exit([active_pid], 2.0)
            except OSError:
                pass

        # Ensure any child subprocess (e.g., upload_to_google_photos.py if legacy parent died on SIGTERM) exits cleanly
        alive_children = [cp for cp in child_pids if _is_pid_alive(cp)]
        if alive_children:
            for cp in alive_children:
                try:
                    os.kill(cp, signal.SIGINT)
                except OSError:
                    pass
            alive_children = _wait_pids_exit(alive_children, 5.0)
            for cp in alive_children:
                try:
                    os.kill(cp, signal.SIGTERM)
                except OSError:
                    pass
            alive_children = _wait_pids_exit(alive_children, 3.0)
            for cp in alive_children:
                try:
                    os.kill(cp, signal.SIGKILL)
                except OSError:
                    pass

        _release_executor_locks(active_pid, lock_paths)
        return True, active_pid, f"Gracefully stopped executor PID {active_pid}" + (
            f" (plus child {', '.join(map(str, child_pids))})" if child_pids else ""
        )

    def _start_executor() -> dict:
        _clear_sentinels(paused_paths)
        _clear_sentinels(stop_after_paths)
        for lp in lock_paths:
            if lp.exists():
                try:
                    existing_pid = int(lp.read_text().strip())
                    if _is_pid_alive(existing_pid):
                        return {
                            "ok": True,
                            "status": "ACTIVE",
                            "pid": existing_pid,
                            "message": f"Executor is already running (PID: {existing_pid}).",
                        }
                except Exception:
                    pass
                try:
                    lp.unlink()
                except OSError:
                    pass

        script_path = target_repo / "scripts" / "pipeline_executor.py"
        if not script_path.exists():
            return {"ok": False, "status": "ERROR", "message": f"Executor script not found: {script_path}"}

        python_bin = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
        if not Path(python_bin).exists():
            python_bin = sys.executable

        log_path = target_repo / "logs" / "pipeline_executor_cron.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as log_f:
            proc = subprocess.Popen(
                [python_bin, str(script_path), "--cron"],
                cwd=str(target_repo),
                stdin=subprocess.DEVNULL,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )

        new_pid = None
        for _ in range(25):
            time.sleep(0.1)
            for lp in lock_paths:
                if lp.exists():
                    try:
                        cand = int(lp.read_text().strip())
                        if _is_pid_alive(cand):
                            new_pid = cand
                            break
                    except Exception:
                        pass
            if new_pid:
                break
            if proc.poll() is not None:
                break

        if new_pid:
            return {"ok": True, "status": "ACTIVE", "pid": new_pid, "message": f"Started executor (PID: {new_pid})."}
        if proc.poll() is None:
            return {"ok": True, "status": "ACTIVE", "pid": proc.pid, "message": f"Launched executor (PID: {proc.pid})."}
        return {
            "ok": True,
            "status": "IDLE",
            "pid": None,
            "message": "Executor checked queue cleanly and exited (no active planned batch or inside backup window).",
        }

    if action == "stop":
        ok, stopped_pid, msg = _stop_running(set_paused=True)
        return {"ok": ok, "status": "STOPPED" if ok else "ERROR", "stopped_pid": stopped_pid, "paused": True, "message": msg}

    if action == "start":
        return _start_executor()

    if action == "restart":
        ok, stopped_pid, stop_msg = _stop_running(set_paused=False)
        if not ok:
            return {"ok": False, "status": "ERROR", "message": stop_msg}
        start_res = _start_executor()
        if stopped_pid and start_res.get("ok"):
            start_res["message"] = f"Stopped PID {stopped_pid} -> {start_res['message']}"
        return start_res

    if action == "stop_after_step":
        if not active_pid:
            return {"ok": False, "status": "IDLE", "message": "Executor is not currently running."}
        sp = target_repo / "db" / "executor.stop_after_step"
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), encoding="utf-8")
        return {
            "ok": True,
            "status": "DRAIN_ARMED",
            "pid": active_pid,
            "message": f"Armed graceful stop after current step completes (PID: {active_pid}).",
        }

    if action == "cancel_stop_after_step":
        _clear_sentinels(stop_after_paths)
        return {"ok": True, "status": "ACTIVE" if active_pid else "IDLE", "message": "Cancelled pending stop-after-step."}

    if action == "resume_cron":
        _clear_sentinels(paused_paths)
        return {"ok": True, "status": "ACTIVE" if active_pid else "IDLE", "paused": False, "message": "Auto-cron pause cleared."}

    if action == "dequeue_pending":
        if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
            return {"ok": False, "status": "ERROR", "message": "Media database unavailable."}
        conn = get_db_connection(MEDIA_DB_PATH)
        if not conn:
            return {"ok": False, "status": "ERROR", "message": "Could not open Media database."}
        try:
            cur = conn.cursor()
            rows = cur.execute("SELECT id, planned_month FROM planned_execution WHERE active = 1 ORDER BY id ASC").fetchall()
            if not rows:
                return {"ok": True, "removed_count": 0, "removed_months": [], "message": "Execution queue is already empty."}
            kept_month = None
            if active_pid:
                in_prog_id, kept_month = rows[0][0], rows[0][1]
                to_remove = rows[1:]
                cur.execute("UPDATE planned_execution SET active = 0 WHERE active = 1 AND id != ?", (in_prog_id,))
            else:
                to_remove = rows
                cur.execute("UPDATE planned_execution SET active = 0 WHERE active = 1")
            conn.commit()
            removed_months = [r[1] for r in to_remove]
            if not removed_months:
                msg = f"No pending queued batches to remove (kept active in-progress batch {kept_month})."
            else:
                msg = f"Dequeued {len(removed_months)} pending batch(es): {', '.join(removed_months)}"
                if kept_month:
                    msg += f" (kept active {kept_month})"
            return {
                "ok": True,
                "removed_count": len(removed_months),
                "removed_months": removed_months,
                "kept_in_progress": kept_month,
                "message": msg,
            }
        except Exception as e:
            return {"ok": False, "status": "ERROR", "message": f"Dequeue failed: {e}"}
        finally:
            conn.close()

    return {"ok": False, "status": "INVALID", "message": f"Unsupported action: {action}"}


@router.post("/bg-service/control")
def control_bg_service(req: BgServiceControlRequest):
    pipe_repo = REPOS["media-organizer-pipeline"]
    sibling_repo = Path("/Users/nickolaycohen/dev/media-organizer-pipeline")
    bg_pid_candidates = [
        Path("/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.service.pid"),
        Path("/Volumes/Macintosh HD/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite.service.pid"),
    ]

    # Check current status
    bg_running = False
    bg_pid = None
    for pp in bg_pid_candidates:
        if pp.exists():
            try:
                bg_pid = int(pp.read_text().strip())
                os.kill(bg_pid, 0)
                bg_running = True
                break
            except OSError as e:
                if e.errno != errno.ESRCH:
                    bg_running = True
                    break
            except Exception:
                pass

    if req.action == "stop":
        if not bg_running or not bg_pid:
            return {"ok": True, "status": "STOPPED", "message": "Background service is already stopped."}
        try:
            os.kill(bg_pid, signal.SIGTERM)
            for _ in range(15):
                time.sleep(0.1)
                try:
                    os.kill(bg_pid, 0)
                except OSError:
                    break
            return {"ok": True, "status": "STOPPED", "message": f"Stopped background service (PID: {bg_pid})."}
        except Exception as e:
            return {"ok": False, "status": "ERROR", "message": str(e)}

    elif req.action == "start":
        if bg_running and bg_pid:
            return {"ok": True, "status": "RUNNING", "pid": bg_pid, "message": f"Background service is already running (PID: {bg_pid})."}
        target_repo = sibling_repo if (sibling_repo / "scripts" / "bg_copy_db_service.py").exists() else pipe_repo
        service_script = target_repo / "scripts" / "bg_copy_db_service.py"
        python_bin = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
        if not Path(python_bin).exists():
            python_bin = sys.executable
        try:
            subprocess.Popen(
                [python_bin, str(service_script)],
                cwd=str(target_repo),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True
            )
            new_pid = None
            for _ in range(20):
                time.sleep(0.1)
                for pp in bg_pid_candidates:
                    if pp.exists():
                        try:
                            cand_pid = int(pp.read_text().strip())
                            os.kill(cand_pid, 0)
                            new_pid = cand_pid
                            break
                        except Exception:
                            pass
                if new_pid:
                    break
            return {"ok": True, "status": "RUNNING", "pid": new_pid, "message": f"Started background service (PID: {new_pid or 'spawned'})."}
        except Exception as e:
            return {"ok": False, "status": "ERROR", "message": str(e)}

    return {"ok": False, "status": "INVALID", "message": "Unsupported action"}

@router.post("/published-url")
def update_published_moment_urls(req: PublishedUrlUpdateRequest):
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    _ensure_published_url_schema()
    moment = (req.moment_name or "").strip()
    if not moment:
        return {"ok": False, "error": "Moment name is required"}

    sf_url = (req.shutterfly_url or "").strip() if req.shutterfly_url is not None else None
    yt_url = (req.youtube_url or "").strip() if req.youtube_url is not None else None

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=10)
        try:
            cur = conn.cursor()
            if sf_url is not None:
                cur.execute("""
                    UPDATE publications
                    SET published_url = ?
                    WHERE moment_name = ? AND (
                        LOWER(COALESCE(platform, '')) LIKE '%shutterfly%'
                        OR (
                            LOWER(COALESCE(platform, '')) NOT LIKE '%youtube%'
                            AND LOWER(COALESCE(filename, '')) NOT LIKE '%.mov'
                            AND LOWER(COALESCE(filename, '')) NOT LIKE '%.mp4'
                            AND LOWER(COALESCE(filename, '')) NOT LIKE '%.m4v'
                        )
                    )
                """, (sf_url or None, moment))
            if yt_url is not None:
                cur.execute("""
                    UPDATE publications
                    SET published_url = ?
                    WHERE moment_name = ? AND (
                        LOWER(COALESCE(platform, '')) LIKE '%youtube%'
                        OR LOWER(COALESCE(filename, '')) LIKE '%.mov'
                        OR LOWER(COALESCE(filename, '')) LIKE '%.mp4'
                        OR LOWER(COALESCE(filename, '')) LIKE '%.m4v'
                    )
                """, (yt_url or None, moment))

            cur.execute("SELECT shutterfly_url, youtube_url FROM curated_moments WHERE moment_name = ?", (moment,))
            existing = cur.fetchone()
            if existing:
                next_sf = sf_url if sf_url is not None else (existing[0] or None)
                next_yt = yt_url if yt_url is not None else (existing[1] or None)
                cur.execute("""
                    UPDATE curated_moments
                    SET shutterfly_url = ?, youtube_url = ?
                    WHERE moment_name = ?
                """, (next_sf or None, next_yt or None, moment))
            else:
                cur.execute("""
                    INSERT INTO curated_moments (moment_name, memory_stage, shutterfly_url, youtube_url)
                    VALUES (?, 'M500', ?, ?)
                """, (moment, sf_url or None, yt_url or None))

            conn.commit()
            return {
                "ok": True,
                "moment_name": moment,
                "shutterfly_url": sf_url,
                "youtube_url": yt_url
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}

@router.post("/cleanup/sync-inventory")
def sync_cleanup_device_inventory(camera_model: Optional[str] = None):
    """Scans Priority 4 ManagedIntake folders and maps assets physically present on devices to media_organizer.db."""
    try:
        res = _run_device_inventory_sync(target_device=camera_model)
        if res.get("ok"):
            _cleanup_devices_cache["timestamp"] = 0.0
            _cleanup_devices_cache["payload"] = None
        return res
    except Exception as e:
        return {"ok": False, "error": str(e), "devices": []}


@router.get("/cleanup/devices")
def get_cleanup_devices(refresh: bool = False):
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {
            "connected": False,
            "error": "Media database unavailable",
            "summary": {},
            "owners": []
        }

    now = time.time()
    if not refresh and _cleanup_devices_cache["payload"] and (now - _cleanup_devices_cache["timestamp"] < 300):
        return _cleanup_devices_cache["payload"]

    if refresh:
        try:
            _run_device_inventory_sync()
        except Exception:
            pass

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            _ensure_carrier_device_schema(conn)
            cur = conn.cursor()
            cur.execute("""
                WITH scored_assets AS (
                    SELECT 
                        a.asset_id,
                        COALESCE(a.carrier_device, NULLIF(TRIM(a.resolved_camera_model), ''), zea.ZCAMERAMODEL, 'Unknown') AS camera_model,
                        COALESCE(do.owner_name, 'Shared/Other') AS primary_owner,
                        COALESCE(do.is_active, 0) AS is_active,
                        COALESCE(o.is_family, 0) AS is_family,
                        do.start_date AS owner_start_date,
                        do.end_date AS owner_end_date,
                        COALESCE(v.score_normalized, 0.0) AS score_normalized,
                        COALESCE(aaa.ZORIGINALFILESIZE, 0) AS file_size_bytes,
                        NTILE(4) OVER (
                            PARTITION BY COALESCE(a.carrier_device, NULLIF(TRIM(a.resolved_camera_model), ''), zea.ZCAMERAMODEL, 'Unknown')
                            ORDER BY COALESCE(v.score_normalized, 0.0) ASC
                        ) AS score_quartile
                    FROM assets a
                    LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
                    LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON za.ZADDITIONALATTRIBUTES = aaa.Z_PK
                    LEFT JOIN ZEXTENDEDATTRIBUTES zea ON za.ZEXTENDEDATTRIBUTES = zea.Z_PK
                    LEFT JOIN device_owners do ON do.camera_model = COALESCE(a.carrier_device, NULLIF(TRIM(a.resolved_camera_model), ''), zea.ZCAMERAMODEL)
                        AND (
                            do.is_active = 1
                            OR (
                                (do.start_date IS NULL OR do.start_date <= date(za.ZDATECREATED + 978307200, 'unixepoch'))
                                AND (do.end_date IS NULL OR do.end_date >= date(za.ZDATECREATED + 978307200, 'unixepoch'))
                            )
                        )
                    LEFT JOIN owners o ON o.name = do.owner_name
                    LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
                    WHERE COALESCE(a.removed_from_source, 0) = 0
                ),
                actual_stats AS (
                    SELECT
                        daa.camera_model,
                        COUNT(*) AS actual_total_count,
                        ROUND(SUM(sa.file_size_bytes) / 1073741824.0, 2) AS actual_total_gb,
                        COUNT(CASE WHEN sa.score_quartile IN (1, 2) THEN 1 END) AS actual_low_count,
                        ROUND(SUM(CASE WHEN sa.score_quartile IN (1, 2) THEN sa.file_size_bytes ELSE 0 END) / 1073741824.0, 2) AS actual_low_gb
                    FROM device_actual_assets daa
                    JOIN scored_assets sa ON sa.asset_id = daa.asset_id
                    GROUP BY daa.camera_model
                ),
                dev_agg AS (
                    SELECT 
                        primary_owner,
                        camera_model,
                        COUNT(CASE WHEN score_quartile IN (1, 2) THEN 1 END) AS low_quality_count,
                        ROUND(SUM(CASE WHEN score_quartile IN (1, 2) THEN file_size_bytes ELSE 0 END) / 1073741824.0, 2) AS low_quality_gb,
                        COUNT(*) AS total_assets,
                        ROUND(SUM(file_size_bytes) / 1073741824.0, 2) AS total_gb,
                        ROUND(MIN(score_normalized), 4) AS min_score,
                        ROUND(MAX(CASE WHEN score_quartile = 2 THEN score_normalized END), 4) AS q2_max_score,
                        MAX(is_active) AS is_active,
                        MIN(owner_start_date) AS start_date,
                        MAX(owner_end_date) AS end_date,
                        MAX(is_family) AS is_family
                    FROM scored_assets
                    GROUP BY primary_owner, camera_model
                )
                SELECT
                    da.*,
                    dis.folder_path,
                    dis.total_files_on_device,
                    dis.synced_at_utc,
                    COALESCE(act.actual_low_count, 0),
                    COALESCE(act.actual_low_gb, 0.0),
                    COALESCE(act.actual_total_count, 0),
                    COALESCE(act.actual_total_gb, 0.0)
                FROM dev_agg da
                LEFT JOIN device_inventory_snapshots dis ON dis.camera_model = da.camera_model
                LEFT JOIN actual_stats act ON act.camera_model = da.camera_model
                ORDER BY da.primary_owner ASC, da.low_quality_gb DESC, da.low_quality_count DESC;
            """)
            rows = cur.fetchall()

            owner_dict = {}
            grand_low_count = 0
            grand_low_gb = 0.0
            grand_total_count = 0
            grand_total_gb = 0.0

            active_devices_count = 0
            active_low_count = 0
            active_low_gb = 0.0
            active_total_count = 0
            active_total_gb = 0.0

            for r in rows:
                p_owner = r[0] or "Shared/Other"
                c_model = r[1]
                l_cnt = r[2] or 0
                l_gb = r[3] or 0.0
                t_cnt = r[4] or 0
                t_gb = r[5] or 0.0
                min_s = r[6] if r[6] is not None else 0.0
                max_s = r[7] if r[7] is not None else 0.0
                is_act = bool(r[8])
                s_date = r[9]
                e_date = r[10]
                is_fam = bool(r[11]) if len(r) > 11 else False
                snap_folder = r[12]
                snap_total_files = r[13] or 0
                snap_synced_at = r[14]
                act_low_cnt = r[15] or 0
                act_low_gb = r[16] or 0.0
                act_tot_cnt = r[17] or 0
                act_tot_gb = r[18] or 0.0
                has_snap = bool(snap_synced_at)

                if p_owner not in owner_dict:
                    owner_dict[p_owner] = {
                        "owner_name": p_owner,
                        "is_family": is_fam,
                        "low_count": 0,
                        "low_gb": 0.0,
                        "total_count": 0,
                        "total_gb": 0.0,
                        "active_low_count": 0,
                        "active_low_gb": 0.0,
                        "active_total_count": 0,
                        "active_total_gb": 0.0,
                        "active_device_count": 0,
                        "devices": []
                    }
                elif is_fam:
                    owner_dict[p_owner]["is_family"] = True

                owner_dict[p_owner]["low_count"] += l_cnt
                owner_dict[p_owner]["low_gb"] = round(owner_dict[p_owner]["low_gb"] + l_gb, 2)
                owner_dict[p_owner]["total_count"] += t_cnt
                owner_dict[p_owner]["total_gb"] = round(owner_dict[p_owner]["total_gb"] + t_gb, 2)

                if is_act:
                    owner_dict[p_owner]["active_low_count"] += l_cnt
                    owner_dict[p_owner]["active_low_gb"] = round(owner_dict[p_owner]["active_low_gb"] + l_gb, 2)
                    owner_dict[p_owner]["active_total_count"] += t_cnt
                    owner_dict[p_owner]["active_total_gb"] = round(owner_dict[p_owner]["active_total_gb"] + t_gb, 2)
                    owner_dict[p_owner]["active_device_count"] += 1

                    active_devices_count += 1
                    active_low_count += l_cnt
                    active_low_gb += l_gb
                    active_total_count += t_cnt
                    active_total_gb += t_gb

                owner_dict[p_owner]["devices"].append({
                    "camera_model": c_model,
                    "owner": p_owner,
                    "is_family": is_fam,
                    "low_count": l_cnt,
                    "low_gb": l_gb,
                    "total_count": t_cnt,
                    "total_gb": t_gb,
                    "min_score": min_s,
                    "q2_max_score": max_s,
                    "is_active": is_act,
                    "start_date": s_date,
                    "end_date": e_date,
                    "has_actual_snapshot": has_snap,
                    "snapshot_folder": snap_folder,
                    "snapshot_total_files": snap_total_files,
                    "snapshot_synced_at": snap_synced_at,
                    "actual_low_count": act_low_cnt,
                    "actual_low_gb": act_low_gb,
                    "actual_total_count": act_tot_cnt,
                    "actual_total_gb": act_tot_gb
                })

                grand_low_count += l_cnt
                grand_low_gb += l_gb
                grand_total_count += t_cnt
                grand_total_gb += t_gb

            # Sort owners alphabetically, but keep Shared/Other at the end
            def owner_sort_key(name):
                return (1 if name == "Shared/Other" else 0, name.lower())

            sorted_owners = [owner_dict[k] for k in sorted(owner_dict.keys(), key=owner_sort_key)]

            payload = {
                "connected": True,
                "summary": {
                    "total_devices": len(rows),
                    "grand_low_count": grand_low_count,
                    "grand_low_gb": round(grand_low_gb, 2),
                    "grand_total_count": grand_total_count,
                    "grand_total_gb": round(grand_total_gb, 2),
                    "active_devices": active_devices_count,
                    "active_low_count": active_low_count,
                    "active_low_gb": round(active_low_gb, 2),
                    "active_total_count": active_total_count,
                    "active_total_gb": round(active_total_gb, 2)
                },
                "owners": sorted_owners,
                "cached_at": datetime.now(timezone.utc).isoformat()
            }

            _cleanup_devices_cache["timestamp"] = now
            _cleanup_devices_cache["payload"] = payload
            return payload
        finally:
            conn.close()
    except Exception as e:
        return {
            "connected": False,
            "error": str(e),
            "summary": {},
            "owners": []
        }

@router.get("/cleanup/candidates")
def get_cleanup_candidates(
    camera_model: str,
    owner: Optional[str] = None,
    quartile: str = "all",          # "all" (Q1+Q2), "1", "2", "all_quartiles" (Q1-Q4)
    media_type: str = "all",        # "all", "video", "photo"
    location_status: str = "possibly",  # "possibly" | "actually"
    limit: int = 50,
    offset: int = 0
):
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable", "candidates": [], "total_count": 0}

    limit = max(1, min(limit, 250))
    offset = max(0, offset)
    location_status = (location_status or "possibly").lower().strip()
    if location_status not in ("possibly", "actually"):
        location_status = "possibly"

    quartile_cond = "score_quartile IN (1, 2)"
    if quartile == "1":
        quartile_cond = "score_quartile = 1"
    elif quartile == "2":
        quartile_cond = "score_quartile = 2"
    elif quartile == "all_quartiles":
        quartile_cond = "score_quartile IN (1, 2, 3, 4)"

    media_cond = ""
    if media_type == "video":
        media_cond = "AND media_type = 'video'"
    elif media_type == "photo":
        media_cond = "AND media_type = 'photo'"

    owner_cond = ""
    if owner and owner != "all":
        owner_cond = "AND primary_owner = ?"

    loc_cond = "AND daa_asset_id IS NOT NULL" if location_status == "actually" else ""

    base_cte = f"""
        WITH all_assets_with_moments AS (
            SELECT 
                a.asset_id,
                a.original_filename,
                a.month,
                a.date_created_utc,
                aaa.ZEXIFTIMESTAMPSTRING AS exif_timestamp_raw,
                COALESCE(a.carrier_device, zea.ZCAMERAMODEL, 'Unknown') AS carrier_device,
                COALESCE(zea.ZCAMERAMODEL, 'Unknown') AS origin_camera_model,
                COALESCE(zea.ZCAMERAMAKE, 'Unknown') AS origin_camera_make,
                COALESCE(do.owner_name, 'Shared/Other') AS primary_owner,
                COALESCE(v.score_normalized, 0.0) AS score_normalized,
                a.aesthetic_score,
                a.google_favorite,
                a.mobile_apple_photos_featured_photos AS apple_featured,
                a.apple_photos_monthly_selection AS apple_monthly_sel,
                CASE 
                    WHEN COALESCE(za.ZKIND, 0) = 1 
                         OR lower(a.original_filename) LIKE '%.mov' 
                         OR lower(a.original_filename) LIKE '%.mp4' 
                         OR lower(a.original_filename) LIKE '%.m4v' 
                         OR lower(a.original_filename) LIKE '%.avi' 
                    THEN 'video' 
                    ELSE 'photo' 
                END AS media_type,
                ROUND(COALESCE(za.ZDURATION, zea.ZDURATION, 0.0), 2) AS duration_sec,
                COALESCE(aaa.ZORIGINALWIDTH, za.ZWIDTH, 0) AS width,
                COALESCE(aaa.ZORIGINALHEIGHT, za.ZHEIGHT, 0) AS height,
                ROUND(COALESCE(zea.ZFPS, 0.0), 1) AS fps,
                COALESCE(
                    a.MomentsAlbumName, 
                    a.curated_album, 
                    a.to_be_curated_album, 
                    ps.published_moments,
                    '—'
                ) AS assigned_moment,
                ps.last_asset_pub,
                aaa.ZORIGINALFILESIZE AS file_size_bytes,
                ROUND(COALESCE(aaa.ZORIGINALFILESIZE, 0) / 1000000.0, 2) AS file_size_mb,
                ROUND(COALESCE(aaa.ZORIGINALFILESIZE, 0) / 1000000000.0, 3) AS file_size_gb,
                daa.asset_id AS daa_asset_id,
                daa.device_filename AS device_filename,
                daa.match_tier AS device_match_tier,
                daa.source_folder AS device_source_folder,
                NTILE(4) OVER (
                    PARTITION BY 1
                    ORDER BY COALESCE(v.score_normalized, 0.0) ASC
                ) AS score_quartile
            FROM assets a
            LEFT JOIN device_actual_assets daa
                ON daa.asset_id = a.asset_id AND daa.camera_model = ?
            LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
            LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON za.ZADDITIONALATTRIBUTES = aaa.Z_PK
            LEFT JOIN ZEXTENDEDATTRIBUTES zea ON za.ZEXTENDEDATTRIBUTES = zea.Z_PK
            LEFT JOIN device_owners do ON do.camera_model = COALESCE(daa.camera_model, a.carrier_device, zea.ZCAMERAMODEL)
                AND (
                    do.is_active = 1
                    OR (
                        (do.start_date IS NULL OR do.start_date <= date(za.ZDATECREATED + 978307200, 'unixepoch'))
                        AND (do.end_date IS NULL OR do.end_date >= date(za.ZDATECREATED + 978307200, 'unixepoch'))
                    )
                )
            LEFT JOIN (
                SELECT asset_uuid, GROUP_CONCAT(DISTINCT moment_name) AS published_moments, MAX(published_at_utc) AS last_asset_pub 
                FROM publications 
                GROUP BY asset_uuid
            ) ps ON ps.asset_uuid = a.asset_id
            LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
            WHERE (COALESCE(a.carrier_device, zea.ZCAMERAMODEL, 'Unknown') = ? OR daa.asset_id IS NOT NULL)
              AND COALESCE(a.removed_from_source, 0) = 0
        ),
        base_filtered AS (
            SELECT
                score_quartile,
                original_filename,
                month,
                file_size_mb,
                ROUND(score_normalized, 4) AS score_normalized,
                assigned_moment,
                media_type,
                date_created_utc,
                primary_owner,
                carrier_device,
                origin_camera_model,
                origin_camera_make,
                asset_id,
                file_size_bytes,
                last_asset_pub,
                duration_sec,
                width,
                height,
                fps,
                exif_timestamp_raw,
                daa_asset_id,
                device_filename,
                device_match_tier,
                device_source_folder,
                COUNT(*) OVER () AS possibly_total_count,
                SUM(CASE WHEN daa_asset_id IS NOT NULL THEN 1 ELSE 0 END) OVER () AS actually_total_count
            FROM all_assets_with_moments
            WHERE {quartile_cond} {media_cond} {owner_cond}
        ),
        filtered AS (
            SELECT
                *,
                COUNT(*) OVER () AS filtered_total_count,
                ROUND(SUM(file_size_bytes) OVER () / 1000000.0, 2) AS filtered_total_mb
            FROM base_filtered
            WHERE 1=1 {loc_cond}
        )
    """

    query = base_cte + """
        SELECT
            score_quartile, original_filename, month, file_size_mb, score_normalized,
            assigned_moment, media_type, date_created_utc, primary_owner, carrier_device,
            origin_camera_model, origin_camera_make, asset_id, file_size_bytes, last_asset_pub,
            duration_sec, width, height, fps, exif_timestamp_raw,
            daa_asset_id, device_filename, device_match_tier, device_source_folder,
            possibly_total_count, actually_total_count, filtered_total_count, filtered_total_mb
        FROM filtered
        ORDER BY file_size_bytes DESC
        LIMIT ? OFFSET ?;
    """

    def _normalize_timestamp(exif_ts: Optional[str], utc_ts: Optional[str]) -> str:
        if exif_ts and len(exif_ts) >= 19:
            date_part = exif_ts[:10].replace(":", "-")
            time_part = exif_ts[11:19]
            return f"{date_part} {time_part}"
        if utc_ts:
            cleaned = utc_ts.replace("T", " ").replace("Z", "")
            return cleaned[:19]
        return "—"

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            _ensure_carrier_device_schema(conn)
            cur = conn.cursor()

            # Fetch snapshot metadata for this device
            cur.execute("""
                SELECT folder_path, total_files_on_device, matched_in_db, synced_at_utc
                FROM device_inventory_snapshots
                WHERE camera_model = ?
            """, (camera_model,))
            snap_row = cur.fetchone()
            has_device_snapshot = bool(snap_row)
            snapshot_folder = snap_row[0] if snap_row else None
            snapshot_total_files = snap_row[1] if snap_row else 0
            snapshot_synced_at = snap_row[3] if snap_row else None

            params = [camera_model, camera_model]
            if owner and owner != "all":
                params.append(owner)
            params.extend([limit, offset])

            cur.execute(query, tuple(params))
            rows = cur.fetchall()

            total_count = 0
            total_mb = 0.0
            possibly_total_count = 0
            actually_total_count = 0
            candidates = []

            for r in rows:
                possibly_total_count = r[24] or 0
                actually_total_count = r[25] or 0
                total_count = r[26] or 0
                total_mb = r[27] or 0.0
                utc_raw = r[7]
                carrier_dev = r[9]
                origin_raw_cam = r[10]
                origin_raw_make = r[11]
                filename = r[1] or ""
                aid = r[12]
                sz_bytes = r[13] or 0
                last_pub = r[14]
                dur_sec = r[15] or 0.0
                w = r[16] or 0
                h = r[17] or 0
                fps_val = r[18] or 0.0
                exif_raw = r[19]
                capture_ts = _normalize_timestamp(exif_raw, utc_raw)

                origin_cam, origin_make = _infer_origin(origin_raw_cam, origin_raw_make, filename)
                is_actual = r[20] is not None

                candidates.append({
                    "score_quartile": r[0],
                    "original_filename": filename,
                    "month": r[2] or "—",
                    "file_size_mb": r[3] or 0.0,
                    "score_normalized": r[4] if r[4] is not None else 0.0,
                    "assigned_moment": r[5] or "—",
                    "media_type": r[6] or "photo",
                    "date_created_utc": utc_raw or "—",
                    "capture_timestamp": capture_ts,
                    "primary_owner": r[8] or "—",
                    "camera_model": carrier_dev or "—",
                    "carrier_device": carrier_dev or "—",
                    "origin_camera_model": origin_cam,
                    "origin_make": origin_make,
                    "asset_id": aid,
                    "file_size_bytes": sz_bytes,
                    "last_asset_pub": last_pub,
                    "duration_sec": dur_sec,
                    "width": w,
                    "height": h,
                    "fps": fps_val,
                    "actually_on_device": is_actual,
                    "device_location_filename": r[21],
                    "device_match_tier": r[22],
                    "device_source_folder": r[23]
                })

            if not rows:
                count_params = [camera_model, camera_model]
                if owner and owner != "all":
                    count_params.append(owner)
                cur.execute(base_cte + """
                    SELECT
                        COALESCE(MAX(possibly_total_count), 0),
                        COALESCE(MAX(actually_total_count), 0),
                        COUNT(*),
                        ROUND(COALESCE(SUM(file_size_bytes), 0) / 1000000.0, 2)
                    FROM filtered
                """, tuple(count_params))
                c_row = cur.fetchone()
                if c_row:
                    possibly_total_count = c_row[0] or 0
                    actually_total_count = c_row[1] or 0
                    total_count = c_row[2] or 0
                    total_mb = c_row[3] or 0.0

            total_gb = round(total_mb / 1000.0, 2)

            return {
                "ok": True,
                "camera_model": camera_model,
                "owner": owner,
                "quartile": quartile,
                "media_type": media_type,
                "location_status": location_status,
                "has_device_snapshot": has_device_snapshot,
                "snapshot_folder": snapshot_folder,
                "snapshot_total_files": snapshot_total_files,
                "snapshot_synced_at": snapshot_synced_at,
                "possibly_total_count": possibly_total_count,
                "actually_total_count": actually_total_count,
                "limit": limit,
                "offset": offset,
                "total_count": total_count,
                "total_mb": total_mb,
                "total_gb": total_gb,
                "candidates": candidates
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e), "candidates": [], "total_count": 0}


def _resolve_asset_paths(asset_id: str) -> dict:
    """Look up ZDIRECTORY and ZFILENAME in O(1) from media_organizer.db."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {}
    conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=10)
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT za.ZDIRECTORY, za.ZFILENAME, a.original_filename, COALESCE(za.ZKIND, 0)
            FROM ZASSET za
            LEFT JOIN assets a ON a.asset_id = za.ZUUID
            WHERE za.ZUUID = ?
            LIMIT 1
        """, (asset_id,))
        row = cur.fetchone()
        if not row:
            return {}
        return {
            "zdir": row[0] or "",
            "zfilename": row[1] or "",
            "original_filename": row[2] or "",
            "zkind": row[3] or 0
        }
    finally:
        conn.close()


def _placeholder_svg_response(label: str = "Preview") -> Response:
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">
      <rect width="160" height="120" rx="8" fill="#131926"/>
      <rect x="2" y="2" width="156" height="116" rx="6" fill="none" stroke="#2d3748" stroke-width="1"/>
      <text x="80" y="56" text-anchor="middle" fill="#8b5cf6" font-family="monospace" font-size="13" font-weight="bold">{label}</text>
      <text x="80" y="76" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="10">Offline / No Derivative</text>
    </svg>"""
    return Response(content=svg, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=300"})


@router.get("/cleanup/thumbnail/{asset_id}")
def get_cleanup_thumbnail(asset_id: str):
    info = _resolve_asset_paths(asset_id)
    if not info:
        return _placeholder_svg_response("Not Found")

    zdir = info["zdir"]
    zfn = info["zfilename"]
    orig_fn = info["original_filename"] or zfn
    ext = (orig_fn.split(".")[-1] if "." in orig_fn else "").upper() or "MEDIA"

    if APPLE_PHOTOS_LIBRARY_PATH.exists() and zdir:
        deriv_dir = APPLE_PHOTOS_LIBRARY_PATH / "resources" / "derivatives" / zdir
        # Check standard Apple Photos thumbnail derivatives in O(1)
        for suffix in ("_1_105_c.jpeg", "_1_102_o.jpeg", "_1_100_o.jpeg"):
            cand = deriv_dir / f"{asset_id}{suffix}"
            if cand.exists():
                return FileResponse(str(cand), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})
        # Also check masters/renders or any matching jpeg in that single directory
        if deriv_dir.exists():
            for p in deriv_dir.glob(f"{asset_id}*.jpeg"):
                return FileResponse(str(p), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})

        # Fallback to original if it is browser-compatible JPEG/PNG
        if zfn and zfn.lower().endswith((".jpg", ".jpeg", ".png")):
            orig_path = APPLE_PHOTOS_LIBRARY_PATH / "originals" / zdir / zfn
            if orig_path.exists():
                mtype = "image/png" if zfn.lower().endswith(".png") else "image/jpeg"
                return FileResponse(str(orig_path), media_type=mtype, headers={"Cache-Control": "public, max-age=3600"})

    return _placeholder_svg_response(ext)


@router.get("/cleanup/preview/{asset_id}")
def get_cleanup_preview(asset_id: str):
    info = _resolve_asset_paths(asset_id)
    if not info:
        raise HTTPException(status_code=404, detail="Asset not found")

    zdir = info["zdir"]
    zfn = info["zfilename"]
    orig_fn = info["original_filename"] or zfn
    is_video = info["zkind"] == 1 or orig_fn.lower().endswith((".mov", ".mp4", ".m4v", ".avi"))

    if APPLE_PHOTOS_LIBRARY_PATH.exists() and zdir:
        orig_path = APPLE_PHOTOS_LIBRARY_PATH / "originals" / zdir / zfn if zfn else None
        deriv_dir = APPLE_PHOTOS_LIBRARY_PATH / "resources" / "derivatives" / zdir

        if is_video:
            # Check if there is a medium derivative video or serve original .mov/.mp4
            if deriv_dir.exists():
                for p in deriv_dir.glob(f"{asset_id}*.mov"):
                    return FileResponse(str(p), media_type="video/quicktime")
                for p in deriv_dir.glob(f"{asset_id}*.mp4"):
                    return FileResponse(str(p), media_type="video/mp4")
            if orig_path and orig_path.exists():
                mtype = "video/mp4" if zfn.lower().endswith(".mp4") else "video/quicktime"
                return FileResponse(str(orig_path), media_type=mtype)

        # For photos (or fallback if video original missing), serve highest resolution JPEG derivative or original
        if deriv_dir.exists():
            for suffix in ("_1_102_o.jpeg", "_1_105_c.jpeg", "_1_100_o.jpeg"):
                cand = deriv_dir / f"{asset_id}{suffix}"
                if cand.exists():
                    return FileResponse(str(cand), media_type="image/jpeg")
            for p in deriv_dir.glob(f"{asset_id}*.jpeg"):
                return FileResponse(str(p), media_type="image/jpeg")

        if orig_path and orig_path.exists():
            return FileResponse(str(orig_path))

    return _placeholder_svg_response("Offline")

@router.post("/cleanup/mark-removed")
def mark_cleanup_assets_removed(req: MarkRemovedRequest):
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    if not req.asset_ids:
        return {"ok": False, "error": "No asset_ids provided"}

    action = (req.action or "remove").lower().strip()
    val = 1 if action == "remove" else 0

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            placeholders = ",".join("?" for _ in req.asset_ids)
            cur.execute(f"""
                SELECT COALESCE(SUM(aaa.ZORIGINALFILESIZE), 0)
                FROM assets a
                LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
                LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.ZASSET = za.Z_PK
                WHERE a.asset_id IN ({placeholders})
            """, req.asset_ids)
            row = cur.fetchone()
            total_bytes = row[0] if row else 0

            if val == 1:
                cur.execute(f"""
                    UPDATE assets 
                    SET removed_from_source = 1,
                        removed_from_source_at_utc = datetime('now'),
                        updated_at_utc = datetime('now')
                    WHERE asset_id IN ({placeholders})
                """, req.asset_ids)
            else:
                cur.execute(f"""
                    UPDATE assets 
                    SET removed_from_source = 0,
                        removed_from_source_at_utc = NULL,
                        updated_at_utc = datetime('now')
                    WHERE asset_id IN ({placeholders})
                """, req.asset_ids)

            affected = cur.rowcount
            conn.commit()

            # Invalidate device cache
            _cleanup_devices_cache["timestamp"] = 0.0
            _cleanup_devices_cache["payload"] = None

            freed_mb = round(total_bytes / 1048576.0, 2)
            freed_gb = round(total_bytes / 1073741824.0, 2)

            return {
                "ok": True,
                "action": action,
                "affected_count": affected,
                "freed_bytes": total_bytes,
                "freed_mb": freed_mb,
                "freed_gb": freed_gb
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _load_photos_moment_titles(asset_ids: list[str]) -> dict:
    """Loads Apple Photos ZMOMENT title/subtitle for asset UUIDs from the local unlocked replica if present."""
    if not asset_ids:
        return {}
    replica_candidates = [
        Path("/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite"),
        Path("/Volumes/Macintosh HD/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite"),
    ]
    replica_path = next((p for p in replica_candidates if p.exists()), None)
    if not replica_path:
        return {}

    result = {}
    try:
        rconn = sqlite3.connect(f"file:{replica_path}?mode=ro&immutable=1", uri=True, timeout=3)
        try:
            rcur = rconn.cursor()
            chunk_size = 450
            for i in range(0, len(asset_ids), chunk_size):
                chunk = asset_ids[i:i + chunk_size]
                ph = ",".join("?" for _ in chunk)
                rcur.execute(
                    f"""
                    SELECT a.ZUUID, m.ZTITLE, m.ZSUBTITLE
                    FROM ZASSET a
                    JOIN ZMOMENT m ON a.ZMOMENT = m.Z_PK
                    WHERE a.ZUUID IN ({ph})
                    """,
                    chunk,
                )
                for uuid_val, title, subtitle in rcur.fetchall():
                    if title or subtitle:
                        result[uuid_val] = (title, subtitle)
        finally:
            rconn.close()
    except Exception:
        pass
    return result


def _parse_utc_dt(dt_str: Optional[str]) -> Optional[datetime]:
    if not dt_str:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(dt_str.split(".")[0] if fmt == "%Y-%m-%d %H:%M:%S" else dt_str, fmt)
        except ValueError:
            continue
    return None


def _utc_to_local_str(dt_str: Optional[str]) -> str:
    dt_utc = _parse_utc_dt(dt_str)
    if dt_utc:
        try:
            return dt_utc.replace(tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass
    return (dt_str or "—")[:19]


def _extract_file_num(fname: Optional[str]) -> Optional[int]:
    if not fname:
        return None
    m = re.search(r"(\d+)(?=\.[^.]+$|$)", fname)
    return int(m.group(1)) if m else None


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))


def _is_dated_moment_album(album_name: str) -> bool:
    if not album_name:
        return False
    return bool(re.search(r"\b(?:19|20)\d{2}\b", album_name))


def _match_closest_existing_moment(
    fn: str,
    dt_target: Optional[datetime],
    imp_id,
    lat: Optional[float],
    lon: Optional[float],
    assigned_by_import: dict,
    assigned_with_gps: list,
    assigned_all: list,
):
    """Finds nearest existing Moments album by import session, GPS, and timestamp proximity."""
    if not dt_target:
        return None
    target_num = _extract_file_num(fn)
    has_gps = lat is not None and lon is not None and lat != -180.0 and lon != -180.0
    candidates = []

    def _fmt_time_diff(sec: float) -> str:
        if sec < 60:
            return f"{int(sec)}s apart"
        if sec < 3600:
            return f"{sec / 60:.0f}m apart"
        if sec < 86400:
            return f"{sec / 3600:.1f}h apart"
        return f"{sec / 86400:.1f}d apart"

    # 1. Same import session proximity (same day / <24h, or GPS <500m within 3d)
    if imp_id and imp_id in assigned_by_import:
        best_imp = None
        for m_alb, m_fn, m_dt, m_lat, m_lon in assigned_by_import[imp_id]:
            diff_sec = abs((dt_target - m_dt).total_seconds())
            is_dated = _is_dated_moment_album(m_alb)
            dist = None
            if has_gps and m_lat is not None and m_lon is not None:
                dist = _haversine_meters(lat, lon, m_lat, m_lon)
            if is_dated:
                if diff_sec > 24 * 3600 and not (dist is not None and dist < 500 and diff_sec <= 3 * 86400):
                    continue
            elif diff_sec > 14 * 86400 and not (dist is not None and dist < 500):
                continue
            m_num = _extract_file_num(m_fn)
            fn_diff = abs(target_num - m_num) if (target_num is not None and m_num is not None) else None
            fn_bonus = max(0.0, 10.0 - fn_diff * 0.5) if (fn_diff is not None and fn_diff <= 20) else 0.0
            score = 10.0 + min(30.0, (diff_sec / 3600.0) * 2.0) - fn_bonus
            reasons = [f"same import session {imp_id}"]
            if fn_diff is not None and fn_diff <= 20:
                reasons.append(f"frame {m_fn} (Δ{fn_diff})")
            reasons.append(_fmt_time_diff(diff_sec))
            if dist is not None:
                if dist < 50:
                    score -= 8.0
                    reasons.append(f"GPS {dist:.0f}m")
                elif dist < 500:
                    score -= 4.0
                    reasons.append(f"GPS {dist:.0f}m")
            if best_imp is None or score < best_imp[0]:
                best_imp = (score, m_alb, ", ".join(reasons))
        if best_imp:
            candidates.append(best_imp)

    # 2. GPS proximity (<1000m, within 3d for dated albums)
    if has_gps:
        best_gps = None
        for m_alb, m_dt, m_lat, m_lon in assigned_with_gps:
            if abs(m_lat - lat) >= 0.02 or abs(m_lon - lon) >= 0.02:
                continue
            diff_sec = abs((dt_target - m_dt).total_seconds())
            is_dated = _is_dated_moment_album(m_alb)
            if is_dated and diff_sec > 3 * 86400:
                continue
            dist = _haversine_meters(lat, lon, m_lat, m_lon)
            if dist < 1000:
                score = 15.0 + (dist / 100.0) + min(40.0, (diff_sec / 3600.0) * 1.5)
                if best_gps is None or score < best_gps[0]:
                    best_gps = (score, m_alb, f"GPS {dist:.0f}m, {_fmt_time_diff(diff_sec)}")
        if best_gps:
            candidates.append(best_gps)

    # 3. Tight timestamp proximity (<4h)
    best_time = None
    for m_alb, m_dt in assigned_all:
        diff_sec = abs((dt_target - m_dt).total_seconds())
        if diff_sec < 4 * 3600:
            score = 20.0 + (diff_sec / 3600.0) * 5.0
            if best_time is None or score < best_time[0]:
                best_time = (score, m_alb, _fmt_time_diff(diff_sec))
    if best_time:
        candidates.append(best_time)

    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    return candidates[0][1], candidates[0][2]


DEFAULT_GROUPING_RULES = [
    {
        "id": "existing_proximity",
        "priority": 1,
        "name": "Existing Moment Proximity",
        "description": "Attach unassigned assets into an existing Moment album when captured <4h apart, GPS <1000m (≤3d), or same bulk import (<24h).",
        "default_enabled": True,
    },
    {
        "id": "photos_moment",
        "priority": 2,
        "name": "Apple Photos Moment Title",
        "description": "Group assets that share an Apple Photos generated Moment title/subtitle and calendar date (YYYY-MM-DD - Title).",
        "default_enabled": True,
    },
    {
        "id": "photos_gps_guard",
        "priority": 3,
        "name": "Photos Moment GPS & Time Guard",
        "description": "Split assets out of an Apple Photos Moment Title if GPS differs >5 km or GPS is missing with >2h gap from the location-verified photos.",
        "default_enabled": True,
    },
    {
        "id": "misdated_duplicate_triage",
        "priority": 4,
        "name": "Misdated / Duplicate Triage",
        "description": "Quarantine assets with zero EXIF dates (0000:00:00), recovery/duplicate filenames (Dupl~, ~001, f########), or duplicate-heavy corrupt import batches instead of treating them as Moment events.",
        "default_enabled": True,
    },
    {
        "id": "multiday_gps",
        "priority": 5,
        "name": "Multi-Day GPS Location",
        "description": "Merge non-home unassigned events captured across nearby days (≤5d gap) when GPS metadata is within ≤3 km into a multi-day event.",
        "default_enabled": True,
    },
    {
        "id": "time_gps_session",
        "priority": 6,
        "name": "Time & GPS Session Clustering",
        "description": "Group remaining uncategorized assets within ≤2h and ≤500m GPS into finer sub-event sessions instead of full-day buckets.",
        "default_enabled": False,
    },
    {
        "id": "same_date",
        "priority": 7,
        "name": "Same-Date Fallback Grouping",
        "description": "Imply remaining uncategorized assets captured on the same calendar date belong together (YYYY-MM-DD - Uncategorized). Refuse to keep individual.",
        "default_enabled": True,
    },
]

_RULE_LABELS = {
    "existing_proximity": "Existing Moment Proximity",
    "photos_moment": "Apple Photos Moment Title",
    "photos_gps_guard": "Photos GPS & Time Guard",
    "misdated_duplicate_triage": "Misdated / Duplicate Triage",
    "multiday_gps": "Multi-Day GPS Location",
    "time_gps_session": "Time & GPS Session",
    "same_date": "Same-Date Grouping",
    "custom_split": "Manual Event Split",
    "ungrouped": "Ungrouped (Date Rule Refused)",
    "refused_cluster": "Individual (Grouping Refused)",
}


def _ensure_grouping_rule_tables(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS mode_m_grouping_rules (
            rule_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL,
            updated_at_utc TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS mode_m_refused_clusters (
            cluster_key TEXT PRIMARY KEY,
            refused_at_utc TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS mode_m_asset_splits (
            asset_id TEXT PRIMARY KEY,
            target_group TEXT NOT NULL,
            source_group TEXT,
            updated_at_utc TEXT NOT NULL
        )
        """
    )


def _load_grouping_rules_state(cur) -> tuple[dict[str, bool], set[str], dict[str, tuple[str, Optional[str]]]]:
    rules_map = {r["id"]: bool(r["default_enabled"]) for r in DEFAULT_GROUPING_RULES}
    refused: set[str] = set()
    asset_splits: dict[str, tuple[str, Optional[str]]] = {}
    try:
        has_rules = cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mode_m_grouping_rules' LIMIT 1"
        ).fetchone()
        if has_rules:
            for rid, en in cur.execute("SELECT rule_id, enabled FROM mode_m_grouping_rules").fetchall():
                if rid in rules_map:
                    rules_map[rid] = bool(en)
        has_ref = cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mode_m_refused_clusters' LIMIT 1"
        ).fetchone()
        if has_ref:
            for (ck,) in cur.execute("SELECT cluster_key FROM mode_m_refused_clusters").fetchall():
                if ck:
                    refused.add(ck)
        has_splits = cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mode_m_asset_splits' LIMIT 1"
        ).fetchone()
        if has_splits:
            for aid, tgt, src in cur.execute(
                "SELECT asset_id, target_group, source_group FROM mode_m_asset_splits"
            ).fetchall():
                if aid and tgt:
                    asset_splits[aid] = (tgt, src)
    except Exception:
        pass
    return rules_map, refused, asset_splits


def _apply_multiday_gps_rule(
    grouped_moments: dict,
    row_pre_meta: dict,
    gps_by_aid: dict[str, tuple[float, float]],
    home_gps_centroids: list[tuple[float, float]],
    max_distance_m: float = 3000.0,
    max_gap_days: int = 5,
) -> dict:
    """Merge non-home unassigned clusters sharing similar GPS metadata (≤3 km) across nearby days (≤5d gap)."""
    eligible_rules = {"photos_moment", "photos_gps_guard", "time_gps_session", "same_date", "ungrouped"}
    candidates: list[dict] = []

    for folder_key, grp in grouped_moments.items():
        if grp.get("rule_id") not in eligible_rules:
            continue
        assets = grp.get("assets") or []
        gps_pts = [gps_by_aid[a["asset_id"]] for a in assets if a["asset_id"] in gps_by_aid]
        dts = [row_pre_meta[a["asset_id"]][4] for a in assets if a["asset_id"] in row_pre_meta and row_pre_meta[a["asset_id"]][4] is not None]
        dates = {row_pre_meta[a["asset_id"]][1] for a in assets if a["asset_id"] in row_pre_meta}
        if not gps_pts or not dts or not dates:
            continue
        c_lat = sum(p[0] for p in gps_pts) / len(gps_pts)
        c_lon = sum(p[1] for p in gps_pts) / len(gps_pts)
        # Skip mixed-city buckets that already span >5 km internally
        if len(gps_pts) > 1 and max(_haversine_meters(c_lat, c_lon, p[0], p[1]) for p in gps_pts) > 5000.0:
            continue
        # Exclude primary residence / frequent daily cells so home snapshots aren't merged across weeks
        if any(_haversine_meters(c_lat, c_lon, h_lat, h_lon) <= 2500.0 for h_lat, h_lon in home_gps_centroids):
            continue
        candidates.append({
            "key": folder_key,
            "lat": c_lat,
            "lon": c_lon,
            "min_dt": min(dts),
            "max_dt": max(dts),
            "dates": dates,
        })

    if len(candidates) < 2:
        return grouped_moments

    n = len(candidates)
    parent = list(range(n))

    def _find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(x: int, y: int) -> None:
        rx, ry = _find(x), _find(y)
        if rx != ry:
            parent[rx] = ry

    max_gap_sec = max_gap_days * 86400.0
    for i in range(n):
        ci = candidates[i]
        for j in range(i + 1, n):
            cj = candidates[j]
            gap_sec = (max(ci["min_dt"], cj["min_dt"]) - min(ci["max_dt"], cj["max_dt"])).total_seconds()
            if gap_sec > max_gap_sec:
                continue
            if _haversine_meters(ci["lat"], ci["lon"], cj["lat"], cj["lon"]) <= max_distance_m:
                _union(i, j)

    comps: dict[int, list[dict]] = {}
    for i in range(n):
        comps.setdefault(_find(i), []).append(candidates[i])

    key_to_comp: dict[str, dict] = {}
    skip_keys: set[str] = set()
    used_new_keys: set[str] = set()
    existing_keys = set(grouped_moments.keys())

    for items in comps.values():
        if len(items) < 2:
            continue
        all_dates: set[str] = set()
        for it in items:
            all_dates |= it["dates"]
        if len(all_dates) < 2:
            continue

        sorted_items = sorted(items, key=lambda it: (it["min_dt"], it["key"]))
        merged_dates = sorted(all_dates)
        d_start, d_end = merged_dates[0], merged_dates[-1]
        date_span = f"{d_start}..{d_end[5:]}" if d_start[:4] == d_end[:4] else f"{d_start}..{d_end}"

        mean_lat = sum(it["lat"] for it in sorted_items) / len(sorted_items)
        mean_lon = sum(it["lon"] for it in sorted_items) / len(sorted_items)
        spread_m = max(
            (_haversine_meters(a["lat"], a["lon"], b["lat"], b["lon"]) for a in sorted_items for b in sorted_items),
            default=0.0,
        )
        spread_str = f"{spread_m:.0f}m" if spread_m < 1000.0 else f"{spread_m / 1000.0:.1f} km"

        # Prefer specific non-generic Apple Photos Moment title when available
        title_counts: dict[str, int] = {}
        title_first_dt: dict[str, datetime] = {}
        for it in sorted_items:
            grp = grouped_moments[it["key"]]
            for asset in grp.get("assets") or []:
                raw_title = (row_pre_meta.get(asset["asset_id"]) or (None, None, None, None))[3]
                if raw_title and raw_title.lower() != "uncategorized":
                    title_counts[raw_title] = title_counts.get(raw_title, 0) + 1
                    dt_val = row_pre_meta[asset["asset_id"]][4] or it["min_dt"]
                    if raw_title not in title_first_dt or dt_val < title_first_dt[raw_title]:
                        title_first_dt[raw_title] = dt_val

        if title_counts:
            best_title = min(
                title_counts.keys(),
                key=lambda t: (-title_counts[t], title_first_dt.get(t, datetime.max), t),
            )
        else:
            best_title = f"Location ({mean_lat:.3f}, {mean_lon:.3f})"

        new_folder = f"{date_span} - {best_title}"
        if (new_folder in existing_keys and new_folder not in {it["key"] for it in sorted_items}) or new_folder in used_new_keys:
            new_folder = f"{new_folder} (Multi-Day GPS)"
        used_new_keys.add(new_folder)

        rule_reason = (
            f"Multi-day GPS match across {len(merged_dates)} days ({date_span}, "
            f"centroid span ≤{spread_str} at {mean_lat:.4f}, {mean_lon:.4f})"
        )

        merged_assets: list[dict] = []
        merged_months: set[str] = set()
        max_sc = float("-inf")
        min_sc = float("inf")
        for it in sorted_items:
            old_k = it["key"]
            skip_keys.add(old_k)
            grp = grouped_moments[old_k]
            merged_months |= set(grp["months"])
            max_sc = max(max_sc, grp["max_score"])
            min_sc = min(min_sc, grp["min_score"])
            for asset in grp["assets"]:
                new_asset = dict(asset)
                new_asset["rule_id"] = "multiday_gps"
                new_asset["rule_label"] = _RULE_LABELS["multiday_gps"]
                new_asset["assigned_moment"] = f"Proposed: {new_folder}"
                prev_notes = new_asset.get("notes") or ""
                if prev_notes.startswith("Nearest Existing:") or prev_notes.startswith("Match:"):
                    new_asset["notes"] = f"{prev_notes} · {rule_reason}"
                else:
                    new_asset["notes"] = rule_reason
                merged_assets.append(new_asset)

        key_to_comp[sorted_items[0]["key"]] = {
            "orig_rank": 0,
            "folder": new_folder,
            "group_type": "Multi-Day GPS Event",
            "rule_id": "multiday_gps",
            "rule_label": _RULE_LABELS["multiday_gps"],
            "rule_reason": rule_reason,
            "refused_from_group": None,
            "asset_count": 0,
            "score_span": f"{max_sc:.4f} .. {min_sc:.4f}" if len(merged_assets) > 1 else f"{max_sc:.4f}",
            "max_score": max_sc,
            "min_score": min_sc,
            "months": merged_months,
            "assets": merged_assets,
        }

    if not skip_keys:
        return grouped_moments

    merged_result: dict = {}
    for folder_key, grp in grouped_moments.items():
        if folder_key in key_to_comp:
            comp_grp = key_to_comp[folder_key]
            merged_result[comp_grp["folder"]] = comp_grp
        elif folder_key not in skip_keys:
            merged_result[folder_key] = grp
    return merged_result


_LEGACY_CAM_MODELS = {"E5700", "Canon EOS DIGITAL REBEL", "COOLPIX 5700"}
_RECOVERY_FN_RE = re.compile(r"^(?:dupl~|~\d+|f\d{6,}\.)", re.IGNORECASE)
_LEGACY_MOV_DSCN_RE = re.compile(r"^(?:mov|dscn)\d+", re.IGNORECASE)


def _detect_misdated_duplicate_assets(
    cur,
    unassigned_rows: list,
    row_pre_meta: dict,
    asset_splits: dict,
    intake_dup_ids: set[str],
) -> tuple[dict[str, str], dict[str, dict]]:
    """Identify misdated/zero-EXIF/recovery-filename assets and duplicate-heavy corrupt import batches."""
    aids = [r[0] for r in unassigned_rows if r[0] not in asset_splits]
    if not aids:
        return {}, {}

    exif_ts_by_aid: dict[str, str] = {}
    legacy_fn_candidates: set[str] = set()
    for r in unassigned_rows:
        aid, fn = r[0], (r[1] or "")
        if aid in asset_splits:
            continue
        if _LEGACY_MOV_DSCN_RE.match(fn):
            legacy_fn_candidates.add(fn.lower())

    for i in range(0, len(aids), 450):
        chunk = aids[i:i + 450]
        ph = ",".join("?" for _ in chunk)
        cur.execute(
            f"""
            SELECT za.ZUUID, aaa.ZEXIFTIMESTAMPSTRING
            FROM ZASSET za
            LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.Z_PK = za.ZADDITIONALATTRIBUTES
            WHERE za.ZUUID IN ({ph})
            """,
            chunk,
        )
        for z_uuid, ex_ts in cur.fetchall():
            if ex_ts:
                exif_ts_by_aid[z_uuid] = str(ex_ts)

    pre2015_legacy_fns: set[str] = set()
    if legacy_fn_candidates:
        fn_list = list(legacy_fn_candidates)
        for i in range(0, len(fn_list), 450):
            chunk = fn_list[i:i + 450]
            ph = ",".join("?" for _ in chunk)
            cur.execute(
                f"""
                SELECT DISTINCT LOWER(original_filename)
                FROM assets
                WHERE LOWER(original_filename) IN ({ph})
                  AND date_created_utc < '2015-01-01'
                """,
                chunk,
            )
            for (lfn,) in cur.fetchall():
                if lfn:
                    pre2015_legacy_fns.add(lfn)

    direct_reasons: dict[str, list[str]] = {}
    direct_kinds: dict[str, set[str]] = {}
    batch_groups: dict[tuple[str, str], list[tuple[str, str]]] = {}

    for row_tuple in unassigned_rows:
        aid, fn, imp_id, cam_model = row_tuple[0], (row_tuple[1] or ""), row_tuple[5], (row_tuple[15] or "")
        if aid in asset_splits:
            continue
        captured_date = row_pre_meta[aid][1]
        cap_year = int(captured_date[:4]) if captured_date[:4].isdigit() else 0
        exif_ts = (exif_ts_by_aid.get(aid) or "").strip()

        reasons: list[str] = []
        kinds: set[str] = set()
        if exif_ts.startswith("0000"):
            reasons.append("Zero EXIF date (0000:00:00)")
            kinds.add("zero_exif")
        if _RECOVERY_FN_RE.match(fn) or "~" in fn.rsplit(".", 1)[0]:
            reasons.append("Recovery/duplicate filename")
            kinds.add("recovery_fn")
        if cap_year >= 2018 and (
            cam_model in _LEGACY_CAM_MODELS
            or (_LEGACY_MOV_DSCN_RE.match(fn) and fn.lower() in pre2015_legacy_fns)
        ):
            reasons.append(f"Legacy 2000s media dated {cap_year}")
            kinds.add("legacy_misdate")

        if reasons:
            direct_reasons[aid] = reasons
            direct_kinds[aid] = kinds
        if imp_id:
            batch_groups.setdefault((captured_date, str(imp_id)), []).append((aid, fn))

    quarantined_reason: dict[str, str] = {}
    triage_stats: dict[str, dict] = {}

    # Propagate across corrupt bulk-import batches on the same date (e.g. legacy recovery folder imported on 2020-10-19)
    propagated_batch_info: dict[str, str] = {}
    for (c_date, imp_str), members in batch_groups.items():
        if len(members) < 4:
            continue
        n_direct = sum(1 for a_id, _fn in members if a_id in direct_reasons)
        n_dup = sum(1 for a_id, _fn in members if a_id in intake_dup_ids)
        if (n_direct >= 3 or n_direct / len(members) >= 0.4) and (
            n_dup / len(members) >= 0.35 or n_direct / len(members) >= 0.5
        ):
            for a_id, _fn in members:
                if a_id not in direct_reasons:
                    propagated_batch_info[a_id] = f"Corrupt/duplicate bulk import #{imp_str} ({n_direct}/{len(members)} misdated)"

    for row_tuple in unassigned_rows:
        aid = row_tuple[0]
        if aid not in direct_reasons and aid not in propagated_batch_info:
            continue
        captured_date = row_pre_meta[aid][1]
        folder_key = f"{captured_date} - Misdated / Duplicate Triage"
        st = triage_stats.setdefault(folder_key, {"zero_exif": 0, "recovery": 0, "dup_copies": 0, "total": 0})
        st["total"] += 1
        kinds = direct_kinds.get(aid, set())
        if "zero_exif" in kinds:
            st["zero_exif"] += 1
        if "recovery_fn" in kinds or "legacy_misdate" in kinds:
            st["recovery"] += 1
        if aid in intake_dup_ids:
            st["dup_copies"] += 1

        if aid in direct_reasons:
            quarantined_reason[aid] = "; ".join(direct_reasons[aid])
        else:
            quarantined_reason[aid] = propagated_batch_info[aid]

    return quarantined_reason, triage_stats


def _build_cli_step2_simulation(
    ranked_moments: list[dict],
    pending_publishing_entries: list[dict],
    *,
    threshold_aligned: bool,
    needs_sync_count: int,
    unassigned_count: int,
    lacie_mounted: bool,
) -> dict:
    """Build a read-only simulation of CLI Mode [M] Step 2 (`pipeline_planner.py`)."""
    has_pending_curation = any(m["display_stage"] in ("M200", "M300") for m in ranked_moments)
    if has_pending_curation:
        table_title = "🌟 M200: Proposed Moments in ToBeCurated (Require Curation & Move to Curated)"
        console_moments = [m for m in ranked_moments if m["display_stage"] in ("M200", "M300")]
    else:
        table_title = "🌟 Publishing Candidates (Mode [M])"
        console_moments = list(ranked_moments)

    console_moments.sort(
        key=lambda x: (
            x["display_stage"] == "M300",
            x["needs_update"],
            x["rank_score"] if x["needs_update"] else x["avg_score"],
        ),
        reverse=True,
    )

    all_needs_folder = bool(
        has_pending_curation
        and console_moments
        and all(m["curated_str"] == "📁 Needs Folder" for m in console_moments)
    )

    needs_update_cnt = sum(1 for m in console_moments if m["needs_update"])
    up_to_date_cnt = len(console_moments) - needs_update_cnt
    m200_cnt = sum(1 for m in ranked_moments if m["display_stage"] == "M200")
    m300_cnt = sum(1 for m in ranked_moments if m["display_stage"] == "M300")
    m100_cnt = sum(1 for m in ranked_moments if m["display_stage"] == "M100")

    console_rows = []
    for idx, m in enumerate(console_moments[:60], 1):
        row_copy = dict(m)
        row_copy["no"] = idx
        console_rows.append(row_copy)

    # Classify Curated Moments Pending Publishing (CLI 5 subsections, Top 20 per bucket)
    pub_tbc_all = sorted(
        [e for e in pending_publishing_entries if e["total_qualified"] >= 2 and e["can_publish_ok"] and e["to_be_curated_exists"]],
        key=lambda e: -e["avg_proposed"],
    )
    pub_clean_all = sorted(
        [e for e in pending_publishing_entries if e["total_qualified"] >= 2 and e["can_publish_ok"] and not e["to_be_curated_exists"]],
        key=lambda e: -e["avg_proposed"],
    )
    pend_cur_all = sorted(
        [e for e in pending_publishing_entries if e["total_qualified"] >= 2 and not e["can_publish_ok"] and e["to_be_curated_exists"]],
        key=lambda e: -e["avg_proposed"],
    )
    pend_cool_all = sorted(
        [e for e in pending_publishing_entries if e["total_qualified"] >= 2 and not e["can_publish_ok"] and not e["to_be_curated_exists"]],
        key=lambda e: -e["avg_proposed"],
    )
    disjoint_pend_all = sorted(
        [e for e in pending_publishing_entries if e["total_qualified"] < 2],
        key=lambda e: -e["avg_proposed"],
    )
    pub_tbc = pub_tbc_all[:20]
    pub_clean = pub_clean_all[:20]
    pend_cur = pend_cur_all[:20]
    pend_cool = pend_cool_all[:20]
    disjoint_pend = disjoint_pend_all[:20]

    if not threshold_aligned:
        gate = "threshold_unaligned"
        gate_label = f"Step 1 Threshold Unaligned ({unassigned_count} unassigned above min)"
        next_prompt = (
            f"CLI Step 1 remains active until {unassigned_count} unassigned high-rank asset(s) are grouped/assigned to Moments; "
            "once aligned, CLI enters Step 2 below."
        )
    elif all_needs_folder:
        gate = "auto_option_2_export"
        gate_label = f"Auto Option [2] Export Ready ({len(console_moments)} M300 folders)"
        next_prompt = (
            f"All {len(console_moments)} M200/M300 Moment(s) are '📁 Needs Folder' — CLI automatically runs "
            "Option [2] (Export Curated Album -> LaCie) and re-evaluates into Publishing Candidates."
        )
    elif has_pending_curation:
        gate = "pending_curation_m200_m300"
        gate_label = f"Gated at M200/M300 Curation ({m200_cnt} M200 · {m300_cnt} M300)"
        parts = []
        if needs_update_cnt > 0:
            parts.append(f"Option [1] sync needed on {needs_update_cnt} Moment(s)")
        parts.append(
            f"inspect ToBeCurated/[Moment] and move selection to Curated/[Moment] ({up_to_date_cnt} up-to-date)"
        )
        next_prompt = "CLI stays on M200/M300 Curation Table: " + "; ".join(parts) + " before unlocking Publishing Candidates."
    else:
        gate = "unlocked_publishing_candidates"
        gate_label = "Unlocked: Publishing Candidates & Pending Publishing"
        parts = []
        if pub_clean:
            parts.append(f"{len(pub_clean)} Ready (Clean)")
        if pub_tbc:
            parts.append(f"{len(pub_tbc)} Ready (w/ ToBeCurated review)")
        if m100_cnt > 0:
            parts.append(f"{m100_cnt} M100 eligible for Option [1]")
        next_prompt = (
            "All M200/M300 curation finished — CLI outputs Publishing Recommendations & Curated Moments Pending Publishing"
            + (f" ({', '.join(parts)})" if parts else "")
            + "."
        )

    return {
        "gate": gate,
        "gate_label": gate_label,
        "has_pending_curation": has_pending_curation,
        "all_needs_folder": all_needs_folder,
        "threshold_aligned": threshold_aligned,
        "lacie_mounted": lacie_mounted,
        "table_title": table_title,
        "next_prompt": next_prompt,
        "counts": {
            "ranked_total": len(ranked_moments),
            "console_total": len(console_moments),
            "needs_update": needs_update_cnt,
            "up_to_date": up_to_date_cnt,
            "needs_sync_option1": needs_sync_count,
            "m100": m100_cnt,
            "m200": m200_cnt,
            "m300": m300_cnt,
            "publishable_tbc": len(pub_tbc),
            "publishable_clean": len(pub_clean),
            "pending_curation": len(pend_cur),
            "pending_cooldown": len(pend_cool),
            "disjoint_pending": len(disjoint_pend),
            "publishable_tbc_total": len(pub_tbc_all),
            "publishable_clean_total": len(pub_clean_all),
            "pending_curation_total": len(pend_cur_all),
            "pending_cooldown_total": len(pend_cool_all),
            "disjoint_pending_total": len(disjoint_pend_all),
        },
        "console_moments": console_rows,
        "pending_publishing": {
            "publishable_tbc": pub_tbc,
            "publishable_clean": pub_clean,
            "pending_curation": pend_cur,
            "pending_cooldown": pend_cool,
            "disjoint": disjoint_pend,
        },
    }


def _compute_mode_m_from_db(cur, db_hist_min: float, last_th_utc: Optional[str]) -> dict:
    """Computes live Mode [M] thresholds, unassigned high-rank clusters, sync needs, and recommendations from SQLite."""
    # Excluded assets in Ignore / SkipPublishing / TopScore Excluded albums
    cur.execute(
        """
        SELECT DISTINCT moaa.asset_id
        FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE LOWER(moa.album_name) IN ('ignore', 'skippublishing', 'topscore excluded')
        """
    )
    excluded_aids = {r[0] for r in cur.fetchall()}

    # 1. Dynamic threshold: top unassigned score among batches >= 600 (excluding trashed)
    cur.execute(
        """
        SELECT v.asset_id, v.score_normalized
        FROM ranked_assets_view v
        JOIN month_batches mb ON v.month = mb.month
        LEFT JOIN ZASSET za ON za.ZUUID = v.asset_id
        WHERE mb.status_code >= '600'
          AND (v.MomentsAlbumName IS NULL OR v.MomentsAlbumName = '')
          AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
        ORDER BY v.score_normalized DESC
        LIMIT 250
        """
    )
    live_curr_th = None
    live_curr_th_aid = None
    for aid, sc in cur.fetchall():
        if aid not in excluded_aids and sc is not None:
            live_curr_th = float(sc)
            live_curr_th_aid = aid
            break

    hist_min_raw = db_hist_min if db_hist_min > 0 else 0.5315
    curr_thresh = round(live_curr_th, 4) if live_curr_th is not None else round(hist_min_raw, 4)
    hist_min = round(hist_min_raw, 4)
    threshold_aligned = (live_curr_th is None) or (live_curr_th <= hist_min_raw + 1e-6)

    # 2. Live Unassigned High-Rank Assets > historical_min
    cur.execute(
        """
        SELECT
            v.asset_id,
            v.original_filename,
            ROUND(v.score_normalized, 4),
            v.month,
            v.date_created_utc,
            ast.import_id,
            za.ZLATITUDE,
            za.ZLONGITUDE,
            COALESCE(za.ZKIND, 0),
            ROUND(COALESCE(za.ZDURATION, ze.ZDURATION, 0.0), 2),
            COALESCE(aaa.ZORIGINALWIDTH, za.ZWIDTH, 0),
            COALESCE(aaa.ZORIGINALHEIGHT, za.ZHEIGHT, 0),
            ROUND(COALESCE(ze.ZFPS, 0.0), 1),
            ROUND(COALESCE(aaa.ZORIGINALFILESIZE, 0) / 1048576.0, 2),
            COALESCE(aaa.ZORIGINALFILESIZE, 0),
            COALESCE(NULLIF(TRIM(ast.resolved_camera_model), ''), ze.ZCAMERAMODEL, ast.carrier_device, 'Unknown'),
            COALESCE(do.owner_name, 'Shared/Other'),
            COALESCE(za.ZDUPLICATEASSETVISIBILITYSTATE, 0)
        FROM ranked_assets_view v
        JOIN month_batches mb ON v.month = mb.month
        JOIN assets ast ON ast.asset_id = v.asset_id
        LEFT JOIN ZASSET za ON za.ZUUID = v.asset_id
        LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.Z_PK = za.ZADDITIONALATTRIBUTES
        LEFT JOIN ZEXTENDEDATTRIBUTES ze ON ze.Z_PK = za.ZEXTENDEDATTRIBUTES
        LEFT JOIN device_owners do ON do.camera_model = COALESCE(NULLIF(TRIM(ast.resolved_camera_model), ''), ast.carrier_device, ze.ZCAMERAMODEL)
            AND (do.start_date IS NULL OR do.start_date <= date(za.ZDATECREATED + 978307200, 'unixepoch'))
            AND (do.end_date IS NULL OR do.end_date >= date(za.ZDATECREATED + 978307200, 'unixepoch'))
        WHERE mb.status_code >= '600'
          AND (v.MomentsAlbumName IS NULL OR v.MomentsAlbumName = '')
          AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
          AND v.score_normalized > ?
        ORDER BY v.score_normalized DESC
        """,
        (hist_min_raw,),
    )
    unassigned_rows = [r for r in cur.fetchall() if r[0] not in excluded_aids]

    cur.execute("SELECT DISTINCT album_name FROM moments WHERE parent_folder_name = 'Moments'")
    valid_moment_albums = {r[0] for r in cur.fetchall() if r[0]}

    moment_titles = _load_photos_moment_titles([r[0] for r in unassigned_rows])
    intake_dup_ids = _get_intake_duplicate_ids() if unassigned_rows else set()

    # Preload assigned assets index once for fast proximity matching
    assigned_by_import = {}
    assigned_with_gps = []
    assigned_all = []
    if unassigned_rows:
        cur.execute(
            """
            SELECT a.MomentsAlbumName, a.original_filename, a.date_created_utc, a.import_id,
                   za.ZLATITUDE, za.ZLONGITUDE
            FROM assets a
            LEFT JOIN ZASSET za ON a.asset_id = za.ZUUID
            WHERE a.MomentsAlbumName IS NOT NULL AND a.MomentsAlbumName != ''
              AND LOWER(a.MomentsAlbumName) NOT IN ('ignore', 'skippublishing', 'topscore excluded')
              AND COALESCE(a.removed_from_source, 0) = 0
            """
        )
        for m_alb, m_fn, m_dt_str, imp_id, m_lat, m_lon in cur.fetchall():
            if valid_moment_albums and m_alb not in valid_moment_albums:
                continue
            m_dt = _parse_utc_dt(m_dt_str)
            if not m_dt:
                continue
            valid_gps = m_lat is not None and m_lon is not None and m_lat != -180.0 and m_lon != -180.0
            if imp_id:
                assigned_by_import.setdefault(imp_id, []).append(
                    (m_alb, m_fn, m_dt, m_lat if valid_gps else None, m_lon if valid_gps else None)
                )
            if valid_gps:
                assigned_with_gps.append((m_alb, m_dt, m_lat, m_lon))
            assigned_all.append((m_alb, m_dt))

    rules_map, refused_clusters, asset_splits = _load_grouping_rules_state(cur)
    grouped_moments = {}
    uncat_items = []
    guard_split_items = []

    # Pre-index GPS anchors per Apple Photos Moment Title so photos_gps_guard can detect
    # mixed same-day events (e.g., morning GPS-less Ski photos lumped into afternoon Beach Moment).
    moment_gps_points: dict[str, list[tuple[Optional[datetime], float, float]]] = {}
    gps_by_aid: dict[str, tuple[float, float]] = {}
    row_pre_meta: dict[str, tuple[str, str, Optional[str], Optional[str], Optional[datetime], bool]] = {}
    for row_tuple in unassigned_rows:
        aid = row_tuple[0]
        dt_utc_str = row_tuple[4]
        lat, lon = row_tuple[6], row_tuple[7]
        captured_str = _utc_to_local_str(dt_utc_str)
        captured_date = captured_str[:10] if captured_str != "—" else ((dt_utc_str or "")[:10] or row_tuple[3])
        m_title, m_subtitle = moment_titles.get(aid, (None, None))
        moment_parts = []
        if m_title:
            moment_parts.append(m_title.replace("\xa0", " ").strip())
        if m_subtitle:
            moment_parts.append(m_subtitle.replace("\xa0", " ").strip())
        suggested_new = f"{captured_date} - {' - '.join(moment_parts)}" if moment_parts else None
        raw_title = " - ".join(moment_parts) if moment_parts else None
        dt_target = _parse_utc_dt(dt_utc_str)
        has_gps = lat is not None and lon is not None and lat != -180.0 and lon != -180.0
        if has_gps:
            gps_by_aid[aid] = (float(lat), float(lon))
        row_pre_meta[aid] = (captured_str, captured_date, suggested_new, raw_title, dt_target, has_gps)
        if suggested_new and has_gps and aid not in asset_splits:
            moment_gps_points.setdefault(suggested_new, []).append((dt_target, float(lat), float(lon)))

    triage_aid_reasons: dict[str, str] = {}
    triage_stats: dict[str, dict] = {}
    if unassigned_rows and rules_map.get("misdated_duplicate_triage", True):
        triage_aid_reasons, triage_stats = _detect_misdated_duplicate_assets(
            cur,
            unassigned_rows,
            row_pre_meta,
            asset_splits,
            intake_dup_ids,
        )

    # Pick primary dense GPS sub-cluster for each suggested_new (in case GPS itself spans >5 km)
    moment_primary_anchors: dict[str, list[tuple[Optional[datetime], float, float]]] = {}
    for s_key, pts in moment_gps_points.items():
        best_cluster = pts
        if len(pts) > 1:
            best_count = -1
            for _dt, p_lat, p_lon in pts:
                near = [p for p in pts if _haversine_meters(p_lat, p_lon, p[1], p[2]) <= 5000.0]
                if len(near) > best_count:
                    best_count = len(near)
                    best_cluster = near
        moment_primary_anchors[s_key] = best_cluster

    def _add_asset_to_group(
        folder_key: str,
        group_type: str,
        rule_id: str,
        rule_reason: str,
        row_tuple: tuple,
        captured_str: str,
        suggested_new: Optional[str],
        best_album_name: Optional[str],
        best_reason: Optional[str],
        refused_from_group: Optional[str] = None,
    ) -> None:
        (
            aid, fn, score, month, dt_utc_str, imp_id, lat, lon,
            zkind, dur_sec, width, height, fps, size_mb, size_bytes, cam_model, owner_name, dup_state
        ) = row_tuple
        extra_notes = []
        if best_album_name:
            if folder_key == best_album_name:
                extra_notes.append(f"Match: {best_reason}")
            else:
                extra_notes.append(f'Nearest Existing: "{best_album_name}" [{best_reason}]')
        if suggested_new and folder_key.lower() != suggested_new.lower():
            extra_notes.append(f"Photos Moment: {suggested_new}")

        if folder_key not in grouped_moments:
            grouped_moments[folder_key] = {
                "orig_rank": 0,
                "folder": folder_key,
                "group_type": group_type,
                "rule_id": rule_id,
                "rule_label": _RULE_LABELS.get(rule_id, rule_id),
                "rule_reason": rule_reason,
                "refused_from_group": refused_from_group,
                "asset_count": 0,
                "score_span": f"{score:.4f}",
                "max_score": score,
                "min_score": score,
                "months": set(),
                "assets": [],
            }
        grp = grouped_moments[folder_key]
        grp["max_score"] = max(grp["max_score"], score)
        grp["min_score"] = min(grp["min_score"], score)
        grp["months"].add(month)
        is_vid = zkind == 1 or (fn or "").lower().endswith((".mov", ".mp4", ".m4v", ".avi", ".mpg"))
        is_intake_dup = aid in intake_dup_ids
        grp["assets"].append({
            "asset_id": aid,
            "original_filename": fn or "—",
            "score_normalized": float(score),
            "capture_timestamp": captured_str,
            "date_created_utc": dt_utc_str or captured_str,
            "month": month,
            "media_type": "video" if is_vid else "photo",
            "duration_sec": float(dur_sec or 0.0),
            "width": int(width or 0),
            "height": int(height or 0),
            "fps": float(fps or 0.0),
            "file_size_mb": float(size_mb or 0.0),
            "file_size_bytes": int(size_bytes or 0),
            "camera_model": cam_model or "Unknown",
            "primary_owner": owner_name or "Shared/Other",
            "assigned_moment": f"Proposed: {folder_key}",
            "notes": ", ".join(extra_notes) if extra_notes else rule_reason,
            "rule_id": rule_id,
            "rule_label": _RULE_LABELS.get(rule_id, rule_id),
            "duplicate_state": 1 if is_intake_dup else 0,
            "is_duplicate_copy": is_intake_dup,
        })

    for row_tuple in unassigned_rows:
        (
            aid, fn, score, month, dt_utc_str, imp_id, lat, lon,
            zkind, dur_sec, width, height, fps, size_mb, size_bytes, cam_model, owner_name, dup_state
        ) = row_tuple
        captured_str, captured_date, suggested_new, raw_title, dt_target, has_gps = row_pre_meta[aid]

        # Explicit user asset-level split/removal overrides take priority over automatic rules
        if aid in asset_splits:
            tgt_group, src_group = asset_splits[aid]
            if tgt_group == "__INDIVIDUAL__":
                ind_key = f"{captured_str} · {fn or aid[:8]}"
                if ind_key in grouped_moments:
                    ind_key = f"{ind_key} [{aid[:6]}]"
                _add_asset_to_group(
                    ind_key,
                    "Individual (Grouping Refused)",
                    "refused_cluster",
                    f"Removed from '{src_group or 'group'}'",
                    row_tuple,
                    captured_str,
                    suggested_new,
                    None,
                    None,
                    refused_from_group=src_group,
                )
            else:
                _add_asset_to_group(
                    tgt_group,
                    "Existing Moment Album" if tgt_group in valid_moment_albums else "Proposed New Moment",
                    "custom_split",
                    f"Manually split event{f' (from {src_group})' if src_group else ''}",
                    row_tuple,
                    captured_str,
                    suggested_new,
                    None,
                    None,
                    refused_from_group=src_group,
                )
            continue

        if aid in triage_aid_reasons:
            triage_folder = f"{captured_date} - Misdated / Duplicate Triage"
            st = triage_stats.get(triage_folder, {})
            summary_parts = []
            if st.get("zero_exif"):
                summary_parts.append(f"{st['zero_exif']} zero-EXIF (0000:00:00)")
            if st.get("recovery"):
                summary_parts.append(f"{st['recovery']} recovery/legacy names")
            if st.get("dup_copies"):
                summary_parts.append(f"{st['dup_copies']} dup copies")
            triage_group_reason = (
                f"Quarantined non-Moment triage ({', '.join(summary_parts)})"
                if summary_parts
                else "Misdated / duplicate import triage"
            )
            _add_asset_to_group(
                triage_folder,
                "Misdated / Duplicate Triage",
                "misdated_duplicate_triage",
                triage_group_reason,
                row_tuple,
                captured_str,
                suggested_new,
                None,
                None,
            )
            # Surface the asset-specific triage signal in notes rather than overwriting with group summary
            grouped_moments[triage_folder]["assets"][-1]["notes"] = triage_aid_reasons[aid]
            continue

        # Check Photos Moment GPS & Time Guard when Apple Photos Moment Title applies
        guard_reason = None
        effective_suggested = suggested_new if rules_map.get("photos_moment", True) else None
        if effective_suggested and rules_map.get("photos_gps_guard", True):
            anchor_pts = moment_primary_anchors.get(effective_suggested, [])
            if anchor_pts:
                if has_gps:
                    min_dist_m = min(_haversine_meters(float(lat), float(lon), a_lat, a_lon) for _dt, a_lat, a_lon in anchor_pts)
                    if min_dist_m > 5000.0:
                        guard_reason = f"GPS differs {min_dist_m / 1000.0:.1f} km from '{raw_title}'"
                        effective_suggested = None
                elif dt_target is not None:
                    dt_pts = [p[0] for p in anchor_pts if p[0] is not None]
                    if dt_pts:
                        min_gap_sec = min(abs((dt_target - a_dt).total_seconds()) for a_dt in dt_pts)
                        if min_gap_sec > 2 * 3600:
                            guard_reason = f"Missing GPS & {min_gap_sec / 3600.0:.1f}h apart from GPS-verified '{raw_title}'"
                            effective_suggested = None

        dt_target = _parse_utc_dt(dt_utc_str)
        best_album_name, best_reason = (None, None)
        if rules_map.get("existing_proximity", True):
            closest = _match_closest_existing_moment(
                fn, dt_target, imp_id, lat, lon, assigned_by_import, assigned_with_gps, assigned_all
            )
            best_album_name, best_reason = closest if closest else (None, None)

        reason_str = best_reason or ""
        is_tight_reason = bool(
            "inside event span" in reason_str
            or "s apart" in reason_str
            or "m apart" in reason_str
            or "h apart" in reason_str
        )
        is_tight_existing = bool(
            best_album_name and (
                is_tight_reason
                or (not effective_suggested and (not _is_dated_moment_album(best_album_name) or "GPS " in reason_str))
            )
        )
        if is_tight_existing:
            _add_asset_to_group(
                best_album_name,
                "Existing Moment Album",
                "existing_proximity",
                f"Existing Moment Proximity: {best_reason}",
                row_tuple,
                captured_str,
                suggested_new,
                best_album_name,
                best_reason,
            )
        elif effective_suggested:
            gtype = "Existing Moment Album" if effective_suggested in valid_moment_albums else "Proposed New Moment"
            _add_asset_to_group(
                effective_suggested,
                gtype,
                "photos_moment",
                f"Apple Photos Moment Title match ('{effective_suggested}')",
                row_tuple,
                captured_str,
                suggested_new,
                best_album_name,
                best_reason,
            )
        elif guard_reason:
            guard_split_items.append((row_tuple, captured_str, captured_date, dt_target, suggested_new, raw_title, guard_reason, best_album_name, best_reason))
        elif best_album_name:
            _add_asset_to_group(
                best_album_name,
                "Existing Moment Album",
                "existing_proximity",
                f"Existing Moment Proximity: {best_reason}",
                row_tuple,
                captured_str,
                suggested_new,
                best_album_name,
                best_reason,
            )
        else:
            uncat_items.append((row_tuple, captured_str, captured_date, dt_target, suggested_new, best_album_name, best_reason))

    # Group guard-split assets into contiguous <=2h sub-events so separated morning/evening
    # shots never stay lumped into the GPS-verified location Moment or merge with unrelated times.
    if guard_split_items:
        by_src: dict[tuple[str, str], list[tuple]] = {}
        for item in sorted(guard_split_items, key=lambda x: (x[2], x[3] or datetime.max, x[0][1] or "")):
            by_src.setdefault((item[2], item[5] or "Event"), []).append(item)
        for (cdate, rtitle), items in by_src.items():
            sub_blocks: list[list[tuple]] = []
            cur_block: list[tuple] = []
            prev_bdt = None
            for item in items:
                bdt = item[3]
                if cur_block and (bdt is None or prev_bdt is None or abs((bdt - prev_bdt).total_seconds()) > 2 * 3600):
                    sub_blocks.append(cur_block)
                    cur_block = []
                cur_block.append(item)
                prev_bdt = bdt
            if cur_block:
                sub_blocks.append(cur_block)

            multi_block = len(sub_blocks) > 1
            for blk in sub_blocks:
                hhmm = blk[0][1][11:16] if len(blk[0][1]) >= 16 else ""
                time_tag = f" {hhmm}" if (multi_block and hhmm) else ""
                blk_folder = f"{cdate}{time_tag} - Separate Event (from {rtitle})"
                for r_t, cs, _cd, _dt_t, sn, _rt, gr, ba, br in blk:
                    _add_asset_to_group(
                        blk_folder,
                        "Separate Event (GPS/Time Guard)",
                        "photos_gps_guard",
                        gr,
                        r_t,
                        cs,
                        sn,
                        ba,
                        br,
                    )

    # Rule 3 & Rule 4 for remaining uncategorized assets
    session_claimed_aids: set[str] = set()
    if uncat_items and rules_map.get("time_gps_session", False):
        uncat_sorted = sorted(
            uncat_items,
            key=lambda x: (x[3] or datetime.max, x[0][1] or ""),
        )
        sessions: list[list[tuple]] = []
        current_sess: list[tuple] = []
        prev_dt = None
        prev_lat = None
        prev_lon = None
        for item in uncat_sorted:
            r_t, _cs, _cd, dt_t, _sn, _ba, _br = item
            a_lat, a_lon = r_t[6], r_t[7]
            has_curr_gps = a_lat is not None and a_lon is not None and a_lat != -180.0 and a_lon != -180.0
            has_prev_gps = prev_lat is not None and prev_lon is not None and prev_lat != -180.0 and prev_lon != -180.0
            split_needed = False
            if not current_sess:
                split_needed = True
            elif dt_t is None or prev_dt is None:
                split_needed = True
            elif abs((dt_t - prev_dt).total_seconds()) > 2 * 3600:
                split_needed = True
            elif has_curr_gps and has_prev_gps and _haversine_meters(a_lat, a_lon, prev_lat, prev_lon) > 500.0:
                split_needed = True

            if split_needed and current_sess:
                sessions.append(current_sess)
                current_sess = []
            current_sess.append(item)
            prev_dt = dt_t
            if has_curr_gps:
                prev_lat, prev_lon = a_lat, a_lon
        if current_sess:
            sessions.append(current_sess)

        for sess in sessions:
            if len(sess) < 2:
                continue
            first_row, first_cs, first_cd, _fdt, _sn, _ba, _br = sess[0]
            hhmm = first_cs[11:16] if len(first_cs) >= 16 else "00:00"
            sess_key = f"{first_cd} {hhmm} - Session ({first_row[3]})"
            for r_t, cs, _cd, _dt_t, sn, ba, br in sess:
                session_claimed_aids.add(r_t[0])
                _add_asset_to_group(
                    sess_key,
                    "Time/GPS Session",
                    "time_gps_session",
                    f"Captured within ≤2h & ≤500m GPS ({len(sess)} assets)",
                    r_t,
                    cs,
                    sn,
                    ba,
                    br,
                )

    for row_tuple, captured_str, captured_date, _dt_t, suggested_new, best_album_name, best_reason in uncat_items:
        aid, fn, _score, month = row_tuple[0], row_tuple[1], row_tuple[2], row_tuple[3]
        if aid in session_claimed_aids:
            continue
        if rules_map.get("same_date", True):
            _add_asset_to_group(
                f"{captured_date} - Uncategorized ({month})",
                "Date Cluster (Needs Moment Name)",
                "same_date",
                f"Same capture date fallback ({captured_date})",
                row_tuple,
                captured_str,
                suggested_new,
                best_album_name,
                best_reason,
            )
        else:
            ind_key = f"{captured_str} · {fn or aid[:8]}"
            if ind_key in grouped_moments:
                ind_key = f"{ind_key} [{aid[:6]}]"
            _add_asset_to_group(
                ind_key,
                "Individual Asset (Ungrouped)",
                "ungrouped",
                "Same-Date fallback rule refused — kept individual",
                row_tuple,
                captured_str,
                suggested_new,
                best_album_name,
                best_reason,
            )

    if grouped_moments and rules_map.get("multiday_gps", True):
        cur.execute(
            """
            SELECT AVG(za.ZLATITUDE), AVG(za.ZLONGITUDE)
            FROM ZASSET za
            JOIN assets a ON a.asset_id = za.ZUUID
            WHERE za.ZLATITUDE IS NOT NULL AND za.ZLONGITUDE IS NOT NULL
              AND za.ZLATITUDE != -180.0 AND za.ZLONGITUDE != -180.0
              AND COALESCE(a.removed_from_source, 0) = 0
            GROUP BY ROUND(za.ZLATITUDE, 2), ROUND(za.ZLONGITUDE, 2)
            HAVING COUNT(DISTINCT substr(a.date_created_utc, 1, 10)) >= 80
            """
        )
        home_gps_centroids = [(float(r[0]), float(r[1])) for r in cur.fetchall()]
        grouped_moments = _apply_multiday_gps_rule(
            grouped_moments,
            row_pre_meta,
            gps_by_aid,
            home_gps_centroids,
        )

    # Apply explicit per-cluster refusals: break refused multi-asset clusters into individual items
    if refused_clusters:
        final_grouped = {}
        for folder_key, grp in grouped_moments.items():
            if folder_key in refused_clusters and len(grp["assets"]) > 1:
                for asset in grp["assets"]:
                    ind_key = f"{asset['capture_timestamp']} · {asset['original_filename']}"
                    if ind_key in final_grouped:
                        ind_key = f"{ind_key} [{asset['asset_id'][:6]}]"
                    sc = float(asset["score_normalized"])
                    asset_copy = {
                        **asset,
                        "assigned_moment": f"Ungrouped (Refused: {folder_key})",
                        "rule_id": "refused_cluster",
                        "rule_label": _RULE_LABELS["refused_cluster"],
                        "notes": f"Grouping refused for '{folder_key}'" + (f" · {asset['notes']}" if asset.get("notes") else ""),
                    }
                    final_grouped[ind_key] = {
                        "orig_rank": 0,
                        "folder": ind_key,
                        "group_type": "Individual (Grouping Refused)",
                        "rule_id": "refused_cluster",
                        "rule_label": _RULE_LABELS["refused_cluster"],
                        "rule_reason": f"User refused grouping rule for '{folder_key}'",
                        "refused_from_group": folder_key,
                        "asset_count": 1,
                        "score_span": f"{sc:.4f}",
                        "max_score": sc,
                        "min_score": sc,
                        "months": {asset["month"]},
                        "assets": [asset_copy],
                    }
            else:
                final_grouped[folder_key] = grp
        grouped_moments = final_grouped

    # Rank clusters cleanly and compute per-rule telemetry
    rule_cluster_counts: dict[str, int] = {}
    rule_asset_counts: dict[str, int] = {}
    clusters_by_score = sorted(
        grouped_moments.values(),
        key=lambda g: (-g["max_score"], -len(g["assets"]), g["folder"]),
    )
    unassigned_clusters = []
    for idx, grp in enumerate(clusters_by_score, 1):
        cnt = len(grp["assets"])
        grp["orig_rank"] = idx
        grp["asset_count"] = cnt
        grp["duplicate_copy_count"] = sum(1 for a in grp["assets"] if a.get("is_duplicate_copy"))
        grp["unique_count"] = max(0, cnt - grp["duplicate_copy_count"])
        grp["months"] = ", ".join(sorted(grp["months"]))
        grp["score_span"] = f"{grp['max_score']:.4f}" if cnt == 1 else f"{grp['max_score']:.4f} .. {grp['min_score']:.4f}"
        rid = grp.get("rule_id") or "same_date"
        rule_cluster_counts[rid] = rule_cluster_counts.get(rid, 0) + 1
        rule_asset_counts[rid] = rule_asset_counts.get(rid, 0) + cnt
        unassigned_clusters.append(grp)
    unassigned_clusters.sort(
        key=lambda g: (
            2 if g["unique_count"] == 0 else (1 if g.get("rule_id") == "misdated_duplicate_triage" else 0),
            -g["unique_count"],
            -len(g["assets"]),
            -g["max_score"],
            g["folder"],
        )
    )

    threshold_driver = None
    if not threshold_aligned and unassigned_clusters:
        for pos_idx, grp in enumerate(unassigned_clusters, 1):
            matched_asset = (
                next((a for a in grp["assets"] if a.get("asset_id") == live_curr_th_aid), None)
                if live_curr_th_aid
                else None
            )
            if matched_asset:
                threshold_driver = {
                    "folder": grp["folder"],
                    "position": pos_idx,
                    "asset_id": live_curr_th_aid,
                    "filename": matched_asset.get("original_filename") or "",
                    "score": round(live_curr_th, 4) if live_curr_th is not None else curr_thresh,
                    "unique_count": grp["unique_count"],
                    "asset_count": grp["asset_count"],
                    "rule_id": grp.get("rule_id") or "",
                }
                break

    custom_split_groups = sorted({tgt for tgt, _src in asset_splits.values() if tgt and tgt != "__INDIVIDUAL__"})
    grouping_rules_payload = {
        "rules": [
            {
                "id": r["id"],
                "priority": r["priority"],
                "name": r["name"],
                "description": r["description"],
                "enabled": bool(rules_map.get(r["id"], r["default_enabled"])),
                "cluster_count": rule_cluster_counts.get(r["id"], 0),
                "asset_count": rule_asset_counts.get(r["id"], 0),
            }
            for r in DEFAULT_GROUPING_RULES
        ],
        "refused_clusters": sorted(refused_clusters),
        "custom_split_groups": custom_split_groups,
        "ungrouped_count": rule_asset_counts.get("ungrouped", 0) + rule_asset_counts.get("refused_cluster", 0),
    }

    # 3. Qualified Moment Stats -> needs_sync_moments + actionable/disjoint recommendations
    cur.execute(
        """
        SELECT moa.album_name, moaa.asset_id
        FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE moa.full_path LIKE 'Media Organizer on LaCie/ToBeCurated/%'
          AND LOWER(moa.album_name) NOT IN ('skippublishing', 'ignore')
        """
    )
    tbc_aids_by_album: dict[str, set[str]] = {}
    tbc_aids = set()
    for alb_name, aid in cur.fetchall():
        tbc_aids.add(aid)
        if alb_name:
            tbc_aids_by_album.setdefault(alb_name.strip(), set()).add(aid)

    cur.execute(
        """
        SELECT moa.album_name, moaa.asset_id
        FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE moa.full_path LIKE 'Media Organizer on LaCie/Curated/%'
        """
    )
    curated_aids_by_album = {}
    curated_aids_all = set()
    for alb_name, aid in cur.fetchall():
        curated_aids_all.add(aid)
        if alb_name:
            curated_aids_by_album.setdefault(alb_name.strip(), set()).add(aid)

    cur.execute(
        """
        SELECT p.asset_uuid, p.moment_name
        FROM publications p
        LEFT JOIN curated_moments cm
          ON TRIM(LOWER(cm.moment_name)) = TRIM(LOWER(p.moment_name))
        WHERE LOWER(COALESCE(cm.memory_stage, '')) != 'deleted'
        """
    )
    published_assets_by_moment = {}
    published_aids_all = set()
    for aid, mom_name in cur.fetchall():
        published_aids_all.add(aid)
        if mom_name:
            published_assets_by_moment.setdefault(mom_name, set()).add(aid)

    cur.execute(
        """
        SELECT moment_name, memory_stage, COALESCE(curated_count, 0),
               COALESCE(photos_to_be_curated_exists, 0), COALESCE(photos_curated_exists, 0)
        FROM curated_moments
        """
    )
    cm_meta = {
        r[0]: {
            "stage": r[1] or "M100",
            "curated_count": r[2],
            "tbc_exists": bool(r[3]),
            "curated_exists": bool(r[4]),
        }
        for r in cur.fetchall()
    }

    cur.execute(
        """
        SELECT
            p.moment_name,
            MAX(p.published_at_utc),
            COUNT(DISTINCT p.asset_uuid),
            AVG(v.score_normalized),
            MIN(v.score_normalized),
            MAX(v.score_normalized)
        FROM publications p
        LEFT JOIN curated_moments cm
          ON TRIM(LOWER(cm.moment_name)) = TRIM(LOWER(p.moment_name))
        LEFT JOIN ranked_assets_view v ON v.asset_id = p.asset_uuid
        WHERE LOWER(COALESCE(cm.memory_stage, '')) != 'deleted'
        GROUP BY p.moment_name
        """
    )
    pub_info = {
        r[0]: {
            "last_pub_utc": r[1],
            "pub_count": r[2] or 0,
            "pub_avg": r[3],
            "pub_min": r[4],
            "pub_max": r[5],
        }
        for r in cur.fetchall()
    }

    cur.execute(
        """
        SELECT
            v.asset_id,
            v.MomentsAlbumName,
            v.score_normalized,
            v.original_filename,
            v.date_created_utc
        FROM ranked_assets_view v
        JOIN month_batches mb ON v.month = mb.month
        WHERE mb.status_code >= '600'
          AND v.MomentsAlbumName IS NOT NULL AND v.MomentsAlbumName != ''
          AND LOWER(v.MomentsAlbumName) NOT IN ('skippublishing', 'ignore')
          AND v.score_normalized > ?
        ORDER BY v.score_normalized DESC
        """,
        (hist_min_raw,),
    )
    moments_data = {}
    for aid, m_name, sc, fn, dt_str in cur.fetchall():
        if aid in excluded_aids:
            continue
        md = moments_data.setdefault(
            m_name,
            {
                "total_qualified": 0,
                "proposed_count": 0,
                "curated_count": 0,
                "unpublished_scores": [],
                "curated_unpublished": [],
                "qualified_aids": [],
                "all_dates": [],
            },
        )
        md["total_qualified"] += 1
        md["qualified_aids"].append(aid)
        in_tbc = aid in tbc_aids
        in_cur = aid in curated_aids_by_album.get(m_name.strip(), set()) or aid in curated_aids_all
        if in_tbc:
            md["proposed_count"] += 1
        if in_cur:
            md["curated_count"] += 1
        is_pub = aid in published_assets_by_moment.get(m_name, set()) or aid in published_aids_all
        if not is_pub and sc is not None:
            md["unpublished_scores"].append(float(sc))
            if in_cur:
                base_name = os.path.splitext(fn or "")[0]
                md["curated_unpublished"].append((aid, base_name, float(sc)))
        dt_val = _parse_utc_dt(dt_str)
        if dt_val:
            md["all_dates"].append(dt_val)

    # Compute needs_sync_moments, ranked_moments (CLI Step 2 simulation), recommendations, and disjoint moments
    needs_sync_moments = []
    ranked_moments_sim = []
    pending_publishing_entries = []
    moment_midpoints = {}
    lacie_mounted = CURATED_LACIE_DIR.exists()
    now_local = datetime.now()
    for name, md in moments_data.items():
        if md["all_dates"]:
            timestamps = sorted(d.timestamp() for d in md["all_dates"])
            mid_ts = (timestamps[0] + timestamps[-1]) / 2.0
            moment_midpoints[name] = {
                "mid": datetime.fromtimestamp(mid_ts),
                "count": md["total_qualified"],
            }

        cm = cm_meta.get(name, {})
        stage = cm.get("stage", "M100")
        if str(stage).strip().lower() == "deleted":
            continue
        p_info = pub_info.get(name, {})
        pub_count = p_info.get("pub_count", 0)
        last_pub_raw = p_info.get("last_pub_utc")
        unpub = md["unpublished_scores"]
        avg_score = sum(unpub) / len(unpub) if unpub else 0.0
        min_score = min(unpub) if unpub else 0.0
        max_score = max(unpub) if unpub else 0.0
        rank_score = avg_score * math.log(md["total_qualified"] + 1)

        name_stripped = name.strip()
        tbc_album_aids = tbc_aids_by_album.get(name_stripped, set())
        tbc_count = len(tbc_album_aids) if tbc_album_aids else md["proposed_count"]
        to_be_curated_exists = bool((tbc_count > 0) or (cm.get("tbc_exists") and not tbc_aids_by_album))
        curated_album_aids = curated_aids_by_album.get(name_stripped, set())
        curated_exists = bool(cm.get("curated_exists") or md["curated_count"] > 0 or curated_album_aids)

        fs_bases: set[str] = set()
        fs_curated_exists = False
        if lacie_mounted:
            for cand_dir in (CURATED_LACIE_DIR / name, CURATED_LACIE_DIR / name_stripped):
                if cand_dir.is_dir():
                    fs_curated_exists = True
                    try:
                        with os.scandir(cand_dir) as it_dir:
                            for entry in it_dir:
                                if entry.is_file() and not entry.name.startswith("."):
                                    fs_bases.add(os.path.splitext(entry.name)[0].lower())
                    except OSError:
                        pass
                    break
        fs_count = len(fs_bases)

        if stage == "M500" or (pub_count >= md["total_qualified"] and md["total_qualified"] > 0):
            display_stage = "M500"
        elif stage == "M450" or pub_count > 0:
            display_stage = "M450"
        elif stage == "M400" or fs_curated_exists:
            display_stage = "M400"
        elif curated_exists:
            display_stage = "M300"
        elif to_be_curated_exists:
            display_stage = "M200"
        else:
            display_stage = "M100"

        if curated_exists and fs_curated_exists:
            if curated_album_aids and fs_count > 0 and len(curated_album_aids) != fs_count:
                curated_str = f"🔄 Export ({fs_count}/{len(curated_album_aids)})"
            else:
                curated_str = "✅ Yes"
        elif curated_exists and not fs_curated_exists:
            curated_str = "📁 Needs Folder" if lacie_mounted else "📁 Curated (LaCie offline)"
        elif not curated_exists and fs_curated_exists:
            curated_str = "📁 Local Only"
        else:
            curated_str = "❌ No"

        if fs_count > 0:
            assets_display = fs_count
        elif curated_album_aids:
            assets_display = len(curated_album_aids)
        elif cm.get("curated_count", 0) > 0:
            assets_display = cm["curated_count"]
        elif md["curated_count"] > 0:
            assets_display = md["curated_count"]
        else:
            assets_display = md["total_qualified"]

        too_recent = False
        days_remaining = 0
        last_pub_str = "—"
        if last_pub_raw:
            pub_dt = _parse_utc_dt(last_pub_raw)
            if pub_dt:
                diff = now_local - pub_dt
                if diff.days < 30:
                    too_recent = True
                    days_remaining = max(1, 30 - diff.days)
                last_pub_str = pub_dt.strftime("%Y-%m-%d %H:%M")
            else:
                last_pub_str = str(last_pub_raw)[:16]

        effective_curated_cnt = max(md["curated_count"], fs_count if fs_curated_exists else 0)
        has_unpublished = bool((fs_curated_exists or not lacie_mounted) and effective_curated_cnt > 0 and effective_curated_cnt > pub_count)
        if not has_unpublished:
            can_publish_str = "❌ No"
            can_publish_ok = False
        elif too_recent:
            can_publish_str = f"❌ (in {days_remaining}d)"
            can_publish_ok = False
        else:
            can_publish_str = "✅ Yes"
            can_publish_ok = True

        needs_update = (md["proposed_count"] + md["curated_count"]) < md["total_qualified"]
        if needs_update and to_be_curated_exists:
            to_be_curated_str = "🔄 Update needed"
        elif to_be_curated_exists:
            to_be_curated_str = "✅ Yes"
        else:
            to_be_curated_str = "❌ No"

        if pub_count == 0:
            published_str = "❌ No"
        elif pub_count >= md["total_qualified"] or (stage == "M500" and pub_count >= md["curated_count"]):
            published_str = "✅ Yes"
        else:
            published_str = f"🔄 Part ({pub_count})"

        pub_avg = p_info.get("pub_avg")
        pub_min = p_info.get("pub_min")
        pub_max = p_info.get("pub_max")

        ranked_moments_sim.append({
            "no": 0,
            "moment_name": name,
            "display_stage": display_stage,
            "rank_score": round(rank_score, 4),
            "avg_score": round(avg_score, 4),
            "min_score": round(min_score, 4),
            "max_score": round(max_score, 4),
            "total_qualified": md["total_qualified"],
            "proposed_count": md["proposed_count"],
            "curated_count": md["curated_count"],
            "assets_display": assets_display,
            "pub_count": pub_count,
            "pub_avg_str": f"{pub_avg:.4f}" if pub_avg is not None else "—",
            "pub_range_str": f"{pub_min:.4f} - {pub_max:.4f}" if pub_min is not None and pub_max is not None else "—",
            "to_be_curated_exists": to_be_curated_exists,
            "to_be_curated_count": tbc_count,
            "to_be_curated_str": to_be_curated_str,
            "curated_str": curated_str,
            "published_str": published_str,
            "can_publish_str": can_publish_str,
            "last_pub_str": last_pub_str,
            "needs_update": needs_update,
        })

        if display_stage in ("M400", "M450"):
            cur_unpub_rows = sorted(md["curated_unpublished"], key=lambda r: (-r[2], r[1]))
            if fs_curated_exists and fs_bases:
                valid_pending = [r for r in cur_unpub_rows if r[1].lower() in fs_bases]
            else:
                valid_pending = cur_unpub_rows
            pending_cnt = len(valid_pending)
            if pending_cnt > 0:
                propose_cnt = pending_cnt if pending_cnt < 9 else min(9, math.ceil(pending_cnt / 4))
                top_prop = valid_pending[:propose_cnt]
                prop_scores = [round(r[2], 4) for r in top_prop]
                avg_prop = sum(prop_scores) / len(prop_scores) if prop_scores else 0.0
                propose_str = f"All ({pending_cnt})" if pending_cnt < 9 else f"{propose_cnt} (1/4 of {pending_cnt})"
                pending_publishing_entries.append({
                    "moment_name": name,
                    "display_stage": display_stage,
                    "avg_proposed": round(avg_prop, 4),
                    "curated": fs_count if fs_count > 0 else (pending_cnt + pub_count),
                    "published": pub_count,
                    "pending": pending_cnt,
                    "propose": propose_cnt,
                    "propose_str": propose_str,
                    "can_publish_str": can_publish_str,
                    "can_publish_ok": can_publish_ok,
                    "to_be_curated_exists": to_be_curated_exists,
                    "to_be_curated_count": tbc_count,
                    "total_qualified": md["total_qualified"],
                    "proposed_scores": prop_scores,
                    "proposed_filenames": [r[1] for r in top_prop if r[1]],
                })

        if needs_update:
            needs_sync_moments.append({
                "idx": 0,
                "moment_name": name,
                "stage": display_stage,
                "rank_score": round(rank_score, 4),
                "avg_score": round(avg_score, 4),
                "assets": md["total_qualified"],
                "published": str(pub_count) if pub_count > 0 else "—",
                "action": "Sync Option [1] to ToBeCurated",
            })

    needs_sync_moments.sort(key=lambda x: -x["rank_score"])
    for idx, m in enumerate(needs_sync_moments, 1):
        m["idx"] = idx

    # Actionable & Disjoint publishing recommendations
    tag_status_by_lc, tagged_aids = _load_moment_tagging_status_map(cur)

    actionable_recs = []
    disjoint_recs = []
    now_local = datetime.now()
    for name, md in moments_data.items():
        cm = cm_meta.get(name, {})
        p_info = pub_info.get(name, {})
        pub_count = p_info.get("pub_count", 0)
        last_pub_raw = p_info.get("last_pub_utc")
        cur_files_cnt = max(cm.get("curated_count", 0), md["curated_count"], len(curated_aids_by_album.get(name.strip(), ())))
        t_info = tag_status_by_lc.get(name.strip().lower())

        if md["total_qualified"] < 2 and pub_count == 0:
            # Find nearest moment with >= 2 assets
            merge_hint = "Merge candidate (<2 assets)"
            best_other = None
            if name in moment_midpoints:
                t_mid = moment_midpoints[name]["mid"]
                best_diff = None
                for other_name, o_info in moment_midpoints.items():
                    if other_name == name or o_info["count"] < 2:
                        continue
                    diff_days = (o_info["mid"] - t_mid).total_seconds() / 86400.0
                    if best_diff is None or abs(diff_days) < abs(best_diff):
                        best_diff = diff_days
                        best_other = other_name
                if best_other is not None:
                    days_int = round(abs(best_diff))
                    rel = f"+{days_int}d" if best_diff > 0 else (f"-{days_int}d" if best_diff < 0 else "0d")
                    merge_hint = f"💡 Suggest merge with: '{best_other}' ({rel})"

            qual_aids_list = list(md.get("qualified_aids") or [])
            is_tagged = bool(t_info) or any(aid in tagged_aids for aid in qual_aids_list)
            unpub = md["unpublished_scores"]
            disjoint_recs.append({
                "moment_name": name,
                "avg_score": round(sum(unpub) / len(unpub), 4) if unpub else 0.0,
                "files": md["total_qualified"],
                "published": str(pub_count) if pub_count > 0 else "0",
                "recommended": 0,
                "action": "Disjoint: Merge needed (<2 assets)",
                "details": merge_hint,
                "suggested_target": best_other or "",
                "asset_ids": qual_aids_list,
                "is_tagged": is_tagged,
                "paradigm_confirmed": bool(t_info and t_info.get("paradigm_confirmed")),
                "tag_summary": (t_info or {}).get("tag_summary", ""),
            })
            continue

        if not (cm.get("curated_exists") or md["curated_count"] > 0):
            continue

        too_recent = False
        if last_pub_raw:
            pub_dt = _parse_utc_dt(last_pub_raw)
            if pub_dt and (now_local - pub_dt).days < 30:
                too_recent = True
        if too_recent or cur_files_cnt <= pub_count:
            continue

        # Curated unpublished assets ready to publish
        cur_unpub = sorted(md["curated_unpublished"], key=lambda x: (-x[2], x[1]))
        if not cur_unpub:
            continue

        rec_batch = cur_unpub[:9]
        rec_avg = sum(x[2] for x in rec_batch) / len(rec_batch)
        if pub_count == 0:
            if cur_files_cnt <= 9:
                action = "Publish Whole Album"
            else:
                action = f"Publish Top 9 Assets (out of {cur_files_cnt})"
        else:
            action = f"Republish: Next {len(rec_batch)} Assets (regulation passed)"

        bases = [x[1] for x in rec_batch if x[1]]
        if len(bases) <= 5:
            details_str = ", ".join(bases)
        else:
            details_str = ", ".join(bases[:4]) + f" (+{len(bases) - 4} more)"

        rec_tagged = bool(t_info) or any(x[0] in tagged_aids for x in md.get("curated_unpublished") or [])
        sim_row = next((r for r in ranked_moments_sim if r["moment_name"] == name), None)
        actionable_recs.append({
            "idx": 0,
            "moment_name": name,
            "avg_score": round(rec_avg, 4),
            "files": cur_files_cnt,
            "published": str(pub_count),
            "recommended": len(rec_batch),
            "action": action,
            "details": details_str or "—",
            "display_stage": sim_row["display_stage"] if sim_row else "M400",
            "to_be_curated_exists": sim_row["to_be_curated_exists"] if sim_row else False,
            "to_be_curated_count": sim_row["to_be_curated_count"] if sim_row else 0,
            "to_be_curated_str": sim_row["to_be_curated_str"] if sim_row else "❌ No",
            "curated_str": sim_row["curated_str"] if sim_row else "❌ No",
            "published_str": sim_row["published_str"] if sim_row else "❌ No",
            "can_publish_str": sim_row["can_publish_str"] if sim_row else "✅ Yes",
            "is_tagged": rec_tagged,
            "paradigm_confirmed": bool(t_info and t_info.get("paradigm_confirmed")),
            "tag_summary": (t_info or {}).get("tag_summary", ""),
        })

    actionable_recs.sort(key=lambda x: -x["avg_score"])
    for idx, rec in enumerate(actionable_recs, 1):
        rec["idx"] = idx
    disjoint_recs.sort(key=lambda x: (1 if x.get("is_tagged") else 0, -x["avg_score"]))

    cli_step2_sim = _build_cli_step2_simulation(
        ranked_moments_sim,
        pending_publishing_entries,
        threshold_aligned=threshold_aligned,
        needs_sync_count=len(needs_sync_moments),
        unassigned_count=sum(len(c["assets"]) for c in unassigned_clusters),
        lacie_mounted=lacie_mounted,
    )

    return {
        "threshold_aligned": threshold_aligned,
        "current_threshold": curr_thresh,
        "historical_min": hist_min,
        "last_checked_utc": last_th_utc,
        "threshold_driver": threshold_driver,
        "actionable_recs": actionable_recs,
        "disjoint_recs": disjoint_recs,
        "needs_sync_moments": needs_sync_moments,
        "unassigned_clusters": unassigned_clusters,
        "grouping_rules": grouping_rules_payload,
        "cli_step2_sim": cli_step2_sim,
    }


_IPHONE7_NIKI_BOUNDS: dict[str, tuple[int, int]] = {
    "2017-07": (90, 300),
    "2017-08": (290, 1520),
    "2017-09": (1517, 3000),
    "2017-10": (1969, 3020),
    "2017-11": (2182, 3350),
    "2017-12": (3340, 3625),
    "2018-01": (3622, 3670),
    "2018-02": (3666, 3700),
    "2018-03": (3697, 3750),
    "2018-04": (3747, 3960),
    "2018-05": (3957, 4020),
    "2018-06": (4015, 4170),
    "2018-07": (4163, 4380),
    "2018-08": (4382, 4965),
    "2018-09": (4961, 5055),
    "2018-10": (5049, 5210),
    "2018-11": (5207, 5270),
    "2018-12": (5270, 5460),
    "2019-01": (5456, 5570),
    "2019-02": (5568, 5645),
    "2019-03": (5644, 5680),
    "2019-05": (5728, 5850),
    "2019-06": (5846, 5920),
    "2019-07": (5915, 5965),
    "2019-08": (5965, 6195),
    "2019-09": (6194, 6412),
    "2019-10": (6410, 6420),
    "2019-11": (6419, 6535),
    "2019-12": (6530, 6535),
    "2020-01": (6530, 6540),
}
_IPHONE7_IMG_NUM_RE = re.compile(r"^IMG_[Ee]?(\d{4})")


def _ensure_iphone7_device_split(conn: sqlite3.Connection, cur: sqlite3.Cursor, force: bool = False) -> dict:
    """Split shared 'iPhone 7' EXIF assets into 'iPhone 7 (Niki)' and 'iPhone 7 (Benny)' by IMG_XXXX stream."""
    asset_cols = {r[1] for r in cur.execute("PRAGMA table_info(assets)").fetchall()}
    if "resolved_camera_model" not in asset_cols:
        cur.execute("ALTER TABLE assets ADD COLUMN resolved_camera_model TEXT")

    has_split_owner = cur.execute(
        "SELECT 1 FROM device_owners WHERE camera_model = 'iPhone 7 (Niki)' LIMIT 1"
    ).fetchone()
    if not force and has_split_owner:
        unsplit = cur.execute(
            """
            SELECT 1 FROM assets a
            JOIN ZASSET za ON za.ZUUID = a.asset_id
            LEFT JOIN ZEXTENDEDATTRIBUTES ze ON ze.Z_PK = za.ZEXTENDEDATTRIBUTES
            WHERE ze.ZCAMERAMODEL = 'iPhone 7' AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
              AND (a.resolved_camera_model IS NULL OR TRIM(a.resolved_camera_model) = '')
            LIMIT 1
            """
        ).fetchone()
        if not unsplit:
            return {"ok": True, "already_applied": True, "niki_count": 0, "benny_count": 0}

    rows = cur.execute(
        """
        SELECT a.asset_id, a.original_filename, a.month,
               (za.ZDATECREATED + 978307200) AS unix_ts,
               date(za.ZDATECREATED + 978307200, 'unixepoch') AS ymd
        FROM assets a
        JOIN ZASSET za ON za.ZUUID = a.asset_id
        LEFT JOIN ZEXTENDEDATTRIBUTES ze ON ze.Z_PK = za.ZEXTENDEDATTRIBUTES
        WHERE ze.ZCAMERAMODEL = 'iPhone 7'
          AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
        """
    ).fetchall()

    niki_ids: list[str] = []
    benny_ids: list[str] = []
    other_rows: list[tuple[str, Optional[float]]] = []
    niki_ts_sec: set[int] = set()

    for aid, fn, mo, unix_ts, ymd in rows:
        m = _IPHONE7_IMG_NUM_RE.match(fn or "")
        if not m:
            other_rows.append((aid, float(unix_ts) if unix_ts is not None else None))
            continue
        num = int(m.group(1))
        is_niki = False
        if mo == "2019-04":
            is_niki = (5680 <= num <= 5728) and (
                (ymd or "") <= "2019-04-18" or ((ymd or "") >= "2019-04-20" and num >= 5715)
            )
        else:
            b = _IPHONE7_NIKI_BOUNDS.get(mo or "")
            if b and b[0] <= num <= b[1]:
                is_niki = True

        if is_niki:
            niki_ids.append(aid)
            if unix_ts is not None:
                ts_i = int(round(float(unix_ts)))
                for d_s in (-2, -1, 0, 1, 2):
                    niki_ts_sec.add(ts_i + d_s)
        else:
            benny_ids.append(aid)

    for aid, unix_ts in other_rows:
        if unix_ts is not None and int(round(unix_ts)) in niki_ts_sec:
            niki_ids.append(aid)
        else:
            benny_ids.append(aid)

    if niki_ids:
        cur.executemany(
            "UPDATE assets SET resolved_camera_model = 'iPhone 7 (Niki)' WHERE asset_id = ?",
            [(aid,) for aid in niki_ids],
        )
    if benny_ids:
        cur.executemany(
            "UPDATE assets SET resolved_camera_model = 'iPhone 7 (Benny)' WHERE asset_id = ?",
            [(aid,) for aid in benny_ids],
        )

    # Mark unsplit 'iPhone 7' row as trimmed for family coverage while keeping carrier fallback intact
    cur.execute(
        """
        UPDATE device_owners
        SET notes = 'Split into iPhone 7 (Niki) and iPhone 7 (Benny) (trimmed)',
            updated_at_utc = datetime('now')
        WHERE camera_model = 'iPhone 7'
        """
    )

    for cam_label, owner, s_dt, e_dt, note in (
        (
            "iPhone 7 (Niki)",
            "Niki",
            "2017-07-04",
            "2020-01-15",
            "Split from shared iPhone 7 by IMG_XXXX stream (continues into Niki iPhone 11 Pro at IMG_6531)",
        ),
        (
            "iPhone 7 (Benny)",
            "Benny",
            "2017-07-04",
            "2021-05-02",
            "Split from shared iPhone 7 by IMG_XXXX stream (rolls 9999 -> 0001)",
        ),
    ):
        existing_do = cur.execute(
            "SELECT id FROM device_owners WHERE camera_model = ? LIMIT 1",
            (cam_label,),
        ).fetchone()
        if existing_do:
            cur.execute(
                """
                UPDATE device_owners
                SET owner_name = ?, start_date = ?, end_date = ?, notes = ?, is_active = 0, updated_at_utc = datetime('now')
                WHERE id = ?
                """,
                (owner, s_dt, e_dt, note, int(existing_do[0])),
            )
        else:
            cur.execute(
                """
                INSERT INTO device_owners (camera_model, owner_name, start_date, end_date, notes, created_at_utc, updated_at_utc, is_active)
                VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
                """,
                (cam_label, owner, s_dt, e_dt, note),
            )

    conn.commit()
    return {
        "ok": True,
        "already_applied": False,
        "niki_count": len(niki_ids),
        "benny_count": len(benny_ids),
    }


@router.post("/devices/split-iphone7")
def split_iphone7_devices_endpoint(force: bool = True):
    """Split shared 'iPhone 7' assets into 'iPhone 7 (Niki)' and 'iPhone 7 (Benny)' in media_organizer.db."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            return _ensure_iphone7_device_split(conn, cur, force=force)
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _enrich_batch_candidates_with_devices(cur, candidates):
    """Enrich candidate month batch dicts with device counts and active family device coverage comparison."""
    if not candidates:
        return
    months = [c["month"] for c in candidates if c.get("month")]
    if not months:
        return

    try:
        _ensure_iphone7_device_split(cur.connection, cur, force=False)
        # Camera model aliases (e.g. 'Samsung SCH-I800' -> 'SCH-I800')
        cur.execute("SELECT camera_model, notes FROM device_owners WHERE notes LIKE 'Alias for %'")
        aliases = {}
        for alias_cam, notes in cur.fetchall():
            target = notes.split("Alias for ")[-1].strip()
            aliases[alias_cam] = target
            aliases[target] = alias_cam

        # All device ownership intervals with family status
        cur.execute("""
            SELECT d.camera_model, d.owner_name, d.start_date, d.end_date, COALESCE(o.is_family, 0), d.notes
            FROM device_owners d
            LEFT JOIN owners o ON d.owner_name = o.name
            WHERE (d.notes IS NULL OR (d.notes NOT LIKE 'Alias for %' AND d.notes NOT LIKE '%(trimmed)%'))
            ORDER BY d.owner_name, d.camera_model
        """)
        all_device_owners = cur.fetchall()

        # Query actual camera models and asset counts for candidate months
        ph = ",".join("?" for _ in months)
        cur.execute(f"""
            SELECT a.month, COALESCE(NULLIF(TRIM(a.resolved_camera_model), ''), zea.ZCAMERAMODEL, 'Unknown') as camera_model, COUNT(*) as cnt
            FROM assets a
            JOIN ZASSET za ON a.asset_id = za.ZUUID
            LEFT JOIN ZEXTENDEDATTRIBUTES zea ON za.ZEXTENDEDATTRIBUTES = zea.Z_PK
            WHERE a.month IN ({ph})
            GROUP BY a.month, COALESCE(NULLIF(TRIM(a.resolved_camera_model), ''), zea.ZCAMERAMODEL, 'Unknown')
            ORDER BY a.month DESC, cnt DESC
        """, months)
        batch_device_rows = cur.fetchall()

        devices_by_month = {}
        for mo, cam, cnt in batch_device_rows:
            devices_by_month.setdefault(mo, []).append((cam, cnt))

        for item in candidates:
            m = item.get("month")
            if not m:
                continue

            m_start = f"{m}-01"
            try:
                y, mon = map(int, m.split("-"))
                _, last_day = calendar.monthrange(y, mon)
                m_end = f"{y}-{mon:02d}-{last_day:02d}"
            except Exception:
                m_end = f"{m}-31"

            active_fam_dict = {}
            device_to_owner = {}
            for cam, owner, s_date, e_date, is_fam, notes in all_device_owners:
                starts_before = (s_date is None or s_date <= m_end)
                ends_after = (e_date is None or e_date >= m_start)
                if starts_before and ends_after:
                    if is_fam == 1:
                        active_fam_dict[cam] = owner
                    if cam not in device_to_owner:
                        device_to_owner[cam] = (owner, bool(is_fam))

            b_devs = devices_by_month.get(m, [])
            b_models = {cam: cnt for cam, cnt in b_devs}

            matched_family = []
            missing_family = []
            accounted_models = set()

            for fam_cam, fam_owner in active_fam_dict.items():
                found_cam = None
                count = 0
                if fam_cam in b_models:
                    found_cam = fam_cam
                    count = b_models[fam_cam]
                elif aliases.get(fam_cam) in b_models:
                    found_cam = aliases.get(fam_cam)
                    count = b_models[found_cam]

                if found_cam:
                    matched_family.append({
                        "camera_model": fam_cam,
                        "owner_name": fam_owner,
                        "count": count
                    })
                    accounted_models.add(found_cam)
                else:
                    missing_family.append({
                        "camera_model": fam_cam,
                        "owner_name": fam_owner
                    })

            matched_family.sort(key=lambda x: -x["count"])

            other_devices = []
            other_assets_count = 0
            for cam, cnt in b_devs:
                if cam not in accounted_models and cam not in active_fam_dict:
                    owner_info = device_to_owner.get(cam) or device_to_owner.get(aliases.get(cam))
                    owner_name = owner_info[0] if owner_info else None
                    other_devices.append({
                        "camera_model": cam,
                        "owner_name": owner_name,
                        "count": cnt
                    })
                    other_assets_count += cnt

            total_active_fam = len(active_fam_dict)
            matched_cnt = len(matched_family)
            pct = round((matched_cnt / total_active_fam * 100.0), 1) if total_active_fam > 0 else 100.0

            item["device_summary"] = {
                "coverage_percent": pct,
                "active_family_count": total_active_fam,
                "matched_family_count": matched_cnt,
                "matched_family_devices": matched_family,
                "missing_family_devices": missing_family,
                "other_devices": other_devices,
                "other_assets_count": other_assets_count
            }
    except Exception as e:
        # Fallback gracefully if any query fails
        for item in candidates:
            if "device_summary" not in item:
                item["device_summary"] = None


def _load_pipeline_queries_module():
    """Dynamically load shared queries module from live sibling or submodule media-organizer-pipeline."""
    import importlib.util

    candidate_roots = [
        BASE_DIR.parent / "media-organizer-pipeline",
        REPOS["media-organizer-pipeline"],
    ]
    for pipe_root in candidate_roots:
        queries_path = pipe_root / "db" / "queries.py"
        if not queries_path.exists():
            continue
        scripts_dir = pipe_root / "scripts"
        for p in (str(pipe_root), str(scripts_dir)):
            if p not in sys.path:
                sys.path.insert(0, p)
        spec = importlib.util.spec_from_file_location("pipeline_db_queries", queries_path)
        if spec is None or spec.loader is None:
            continue
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if hasattr(mod, "check_apple_month_selection_album"):
            return mod
    return None


def _check_apple_month_selection_status(cur: sqlite3.Cursor, month_str: str) -> dict:
    """Delegate Apple Photos Month Selection verification to shared pipeline helper."""
    mod = _load_pipeline_queries_module()
    if mod is not None and hasattr(mod, "check_apple_month_selection_album"):
        return mod.check_apple_month_selection_album(cur, month_str)
    return {
        "month": month_str,
        "expected_album": month_str,
        "exists": False,
        "has_assets": False,
        "asset_count": 0,
        "matched_album_name": None,
        "album_pk": None,
        "batch_selected_count": 0,
        "ready": False,
        "status": "missing",
    }


def _ensure_planned_execution_override_column(cur: sqlite3.Cursor) -> None:
    """Delegate schema guard for planned_execution override flag to shared pipeline helper."""
    mod = _load_pipeline_queries_module()
    if mod is not None and hasattr(mod, "ensure_planned_execution_override_column"):
        mod.ensure_planned_execution_override_column(cur)


def _compute_month_ingestion_unlock(cur: sqlite3.Cursor, current_month_str: str) -> dict:
    """Detect whether any completed calendar month is unlocked for 050 Managed Intake (not yet ingested)."""
    now_local = datetime.now()
    last_complete_dt = now_local.replace(day=1) - timedelta(days=1)
    last_complete_month = last_complete_dt.strftime("%Y-%m")

    cur.execute("SELECT MAX(month) FROM month_batches WHERE month <= ?", (last_complete_month,))
    row_mb = cur.fetchone()
    latest_batch_month = str(row_mb[0]) if row_mb and row_mb[0] else None

    cur.execute(
        """
        SELECT DISTINCT month
        FROM month_batches
        WHERE month <= ? AND COALESCE(assets_count, 0) > 0
        """,
        (last_complete_month,),
    )
    existing_batches = {str(r[0]) for r in cur.fetchall() if r[0]}

    cur.execute(
        """
        SELECT DISTINCT month
        FROM assets
        WHERE month IS NOT NULL AND month <= ?
        GROUP BY month
        HAVING COUNT(*) > 0
        """,
        (last_complete_month,),
    )
    ingested_asset_months = {str(r[0]) for r in cur.fetchall() if r[0]}

    # Check calendar months after latest_batch_month up through last_complete_month (and last_complete_month itself)
    pending_months: list[str] = []
    if latest_batch_month and latest_batch_month < last_complete_month:
        try:
            cursor_dt = datetime.strptime(f"{latest_batch_month}-01", "%Y-%m-%d")
            end_dt = datetime.strptime(f"{last_complete_month}-01", "%Y-%m-%d")
            while cursor_dt < end_dt:
                # Advance one calendar month
                cursor_dt = (cursor_dt + timedelta(days=32)).replace(day=1)
                m_cand = cursor_dt.strftime("%Y-%m")
                if m_cand <= last_complete_month and (
                    m_cand not in existing_batches or m_cand not in ingested_asset_months
                ):
                    pending_months.append(m_cand)
        except Exception:
            pass
    elif last_complete_month not in existing_batches or last_complete_month not in ingested_asset_months:
        pending_months.append(last_complete_month)

    target_month = pending_months[0] if pending_months else last_complete_month
    active_devices: list[str] = []
    try:
        y, mon = map(int, target_month.split("-"))
        _, last_day = calendar.monthrange(y, mon)
        m_start = f"{y}-{mon:02d}-01"
        m_end = f"{y}-{mon:02d}-{last_day:02d}"
        cur.execute(
            """
            SELECT d.camera_model, d.owner_name
            FROM device_owners d
            LEFT JOIN owners o ON d.owner_name = o.name
            WHERE COALESCE(o.is_family, 0) = 1
              AND (d.notes IS NULL OR (d.notes NOT LIKE 'Alias for %' AND d.notes NOT LIKE '%(trimmed)%'))
              AND (d.start_date IS NULL OR d.start_date <= ?)
              AND (d.end_date IS NULL OR d.end_date >= ?)
            ORDER BY d.owner_name, d.camera_model
            """,
            (m_end, m_start),
        )
        seen_dev: set[str] = set()
        for cam, own in cur.fetchall():
            label = f"{cam} ({own})" if own else cam
            if label not in seen_dev:
                seen_dev.add(label)
                active_devices.append(label)
    except Exception:
        pass

    return {
        "unlocked": len(pending_months) > 0,
        "pending_months": pending_months,
        "target_month": target_month,
        "latest_ingested_month": latest_batch_month,
        "last_complete_month": last_complete_month,
        "active_devices": active_devices,
    }


@router.get("/planner-overview")
def get_planner_overview(mode: str = "all"):
    """Return next-step overview for Mode [B] Batch Management and/or Mode [M] Moments Organizer."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"connected": False, "error": "Media database unavailable"}

    mode_norm = (mode or "all").strip().lower()
    include_b = mode_norm in ("all", "b")
    include_m = mode_norm in ("all", "m")

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            mode_b_payload = None
            mode_m_payload = None

            if include_b:
                now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
                current_month_str = now_utc.strftime("%Y-%m")

                # -----------------------------------------------------------------
                # 1. Mode [B]: Batch Management Overview & Next Steps
                # -----------------------------------------------------------------
                cur.execute("SELECT id, planned_month, set_at_utc FROM planned_execution WHERE active = 1 ORDER BY id ASC")
                active_queue = [
                    {"id": r[0], "month": r[1], "queued_at_utc": r[2]}
                    for r in cur.fetchall()
                ]
                queued_months_set = {q["month"] for q in active_queue}

                cur.execute("""
                    SELECT status_code, COUNT(*), COALESCE(SUM(assets_count), 0)
                    FROM month_batches
                    GROUP BY status_code
                    ORDER BY status_code ASC
                """)
                status_breakdown = {}
                for sc, cnt, assets_sum in cur.fetchall():
                    status_breakdown[str(sc)] = {"count": cnt, "assets": assets_sum}

                # Outdated completed batches (status >= 600 with newly imported assets)
                cur.execute("""
                    SELECT mb.month, mb.updated_at_utc, MAX(a.imported_date_utc), COUNT(a.asset_id)
                    FROM month_batches mb
                    JOIN assets a ON a.month = mb.month
                    WHERE mb.status_code >= '600'
                    GROUP BY mb.month
                    HAVING MAX(a.imported_date_utc) > mb.updated_at_utc
                    ORDER BY mb.month DESC
                """)
                outdated_batches = [
                    {
                        "month": r[0],
                        "finalized_at_utc": r[1],
                        "newest_import_utc": r[2],
                        "assets_count": r[3]
                    }
                    for r in cur.fetchall()
                ]

                # Active (non-650) batches with favorites and upload timestamps
                cur.execute("""
                    SELECT 
                        mb.month, 
                        mb.status_code,
                        COALESCE(a.total_assets, mb.assets_count, 0) as total_assets,
                        COALESCE(a.fav_assets, 0) as fav_assets,
                        a.max_fav_updated as fav_synced,
                        a.last_uploaded_at,
                        COALESCE(mb.is_bypassed, 0) as is_bypassed,
                        mb.bypass_timestamp
                    FROM month_batches mb
                    LEFT JOIN (
                        SELECT 
                            month, 
                            COUNT(*) as total_assets,
                            SUM(CASE WHEN google_favorite = 1 THEN 1 ELSE 0 END) as fav_assets,
                            MAX(CASE WHEN google_favorite = 1 THEN updated_at_utc END) as max_fav_updated,
                            MAX(CASE WHEN uploaded_to_google = 1 THEN updated_at_utc END) as last_uploaded_at
                        FROM assets
                        GROUP BY month
                    ) a ON mb.month = a.month
                    WHERE mb.status_code != '650' AND mb.month < ?
                    ORDER BY mb.month DESC
                """, (current_month_str,))
                non_final_rows = cur.fetchall()

                manual_400_candidates = []
                pipeline_500_candidates = []
                pipeline_600_candidates = []
                pipeline_000_candidates = []
                retryable_candidates = []

                for r in non_final_rows:
                    m_str, sc, tot_a, fav_a, fav_sync, last_up, is_byp, byp_ts = r
                    sc_str = str(sc)
                    in_q = m_str in queued_months_set

                    elapsed_days = None
                    if last_up:
                        try:
                            dt_up = datetime.strptime(last_up[:19], "%Y-%m-%d %H:%M:%S")
                            elapsed_days = round((now_utc - dt_up).total_seconds() / 86400.0, 1)
                        except Exception:
                            pass

                    item = {
                        "month": m_str,
                        "status_code": sc_str,
                        "total_assets": tot_a,
                        "fav_assets": fav_a,
                        "fav_synced": fav_sync[:10] if fav_sync else None,
                        "last_uploaded_at": last_up[:16] if last_up else None,
                        "elapsed_days": elapsed_days,
                        "is_bypassed": bool(is_byp),
                        "in_queue": in_q
                    }

                    if sc_str == "400":
                        ms_info = _check_apple_month_selection_status(cur, m_str)
                        item["month_selection"] = ms_info
                        if fav_a > 0:
                            item["readiness"] = "ready"
                            item["next_step"] = f"Confirm Google AI rating & Best-of Favorites (400 ➜ 500) — {fav_a} favorites detected"
                        elif elapsed_days is not None and elapsed_days < 3.0:
                            item["readiness"] = "cooldown"
                            item["next_step"] = f"Google AI rating window ({elapsed_days:.1f}d / 3.0d) — confirm once Best-of lists are generated & Favorites manually added"
                        else:
                            item["readiness"] = "action_needed"
                            item["next_step"] = "Confirm Google AI rating (Best-of lists generated & Favorites manually added) via Confirm 500 or Bypass"
                        manual_400_candidates.append(item)
                    elif sc_str in ("500", "550"):
                        ms_info = _check_apple_month_selection_status(cur, m_str)
                        item["month_selection"] = ms_info
                        item["transition_path"] = "500 ➜ 550 (Pull Favorites) ➜ 600 (Rank & Export) ➜ 650 (Cloud Retain)"
                        if not ms_info.get("ready") and not is_byp:
                            ms_warn = (
                                f"Apple Photos Month Selection '{ms_info['matched_album_name']}' is empty (0 assets)"
                                if ms_info.get("exists")
                                else f"Missing Apple Photos Month Selection album '{ms_info['expected_album']}'"
                            )
                            item["next_step"] = f"⚠️ {ms_warn} — populate before pulling Google Favorites"
                        else:
                            item["next_step"] = (
                                f"Queue pipeline execution ({fav_a} favorites synced)"
                                if fav_a > 0
                                else ("Queue Direct-Rank Bypass execution" if is_byp else "Queue Pull Google Favorites & Rank (500 ➜ 650)")
                            )
                        pipeline_500_candidates.append(item)
                    elif sc_str == "600":
                        item["transition_path"] = "600 ➜ 650 (Cloud Retention & Local Staging Cleanup)"
                        item["next_step"] = "Finalize batch & clean staging folder"
                        pipeline_600_candidates.append(item)
                    elif sc_str in ("399",) or sc_str.endswith("E"):
                        item["transition_path"] = f"{sc_str} ➜ Retry step"
                        item["next_step"] = "Resume / retry interrupted upload or failed transition"
                        retryable_candidates.append(item)
                    elif sc_str in ("000", "100", "200", "210"):
                        item["transition_path"] = "000 ➜ 100 (Verify DB) ➜ 200 (Export) ➜ 210 (Dedupe) ➜ 399 (Upload)"
                        item["next_step"] = f"Verify sequencing & export {tot_a} assets to staging for Google upload"
                        pipeline_000_candidates.append(item)

                # Determine primary suggested next action for Mode [B]
                primary_b_suggestion = None
                if manual_400_candidates:
                    top_m = manual_400_candidates[0]
                    primary_b_suggestion = {
                        "type": "manual_curation",
                        "month": top_m["month"],
                        "status_code": "400 ➜ 500",
                        "headline": f"Step 1 (Manual Curation Check): Batch {top_m['month']} ({top_m['total_assets']} assets)",
                        "detail": top_m["next_step"],
                        "secondary": (
                            f"If skipped, planner proceeds to Pipeline Candidate: Batch {pipeline_500_candidates[0]['month']} (500 ➜ 550 ➜ 600 ➜ 650)"
                            if pipeline_500_candidates
                            else (f"If skipped, planner proceeds to Ingest Candidate: Batch {pipeline_000_candidates[0]['month']} (000 ➜ 399)" if pipeline_000_candidates else "")
                        )
                    }
                elif retryable_candidates:
                    top_r = retryable_candidates[0]
                    primary_b_suggestion = {
                        "type": "retryable",
                        "month": top_r["month"],
                        "status_code": top_r["status_code"],
                        "headline": f"Retry Interrupted Batch {top_r['month']}",
                        "detail": top_r["next_step"],
                        "secondary": ""
                    }
                elif pipeline_500_candidates:
                    top_p = pipeline_500_candidates[0]
                    primary_b_suggestion = {
                        "type": "pipeline_500",
                        "month": top_p["month"],
                        "status_code": "500 ➜ 650",
                        "headline": f"Queue Ranking & Finalization for Batch {top_p['month']} ({top_p['total_assets']} assets)",
                        "detail": top_p["next_step"],
                        "secondary": ""
                    }
                elif pipeline_000_candidates:
                    top_0 = pipeline_000_candidates[0]
                    primary_b_suggestion = {
                        "type": "pipeline_000",
                        "month": top_0["month"],
                        "status_code": "000 ➜ 399",
                        "headline": f"Start Batch Ingest & Upload for {top_0['month']} ({top_0['total_assets']} assets)",
                        "detail": top_0["next_step"],
                        "secondary": ""
                    }

                # Enrich candidate batches with device summary vs active family devices
                top_000_batches = pipeline_000_candidates[:8]
                _enrich_batch_candidates_with_devices(cur, top_000_batches)
                if manual_400_candidates:
                    _enrich_batch_candidates_with_devices(cur, manual_400_candidates)
                if pipeline_500_candidates:
                    _enrich_batch_candidates_with_devices(cur, pipeline_500_candidates)

                mode_b_payload = {
                    "active_queue": active_queue,
                    "status_breakdown": status_breakdown,
                    "outdated_batches": outdated_batches,
                    "month_ingestion_unlock": _compute_month_ingestion_unlock(cur, current_month_str),
                    "manual_400_candidates": manual_400_candidates,
                    "pipeline_500_candidates": pipeline_500_candidates,
                    "pipeline_600_candidates": pipeline_600_candidates,
                    "pipeline_000_candidates": top_000_batches,
                    "total_000_batches": len(pipeline_000_candidates),
                    "total_000_assets": sum(x["total_assets"] for x in pipeline_000_candidates),
                    "retryable_candidates": retryable_candidates,
                    "primary_suggestion": primary_b_suggestion
                }

            if include_m:
                # -----------------------------------------------------------------
                # 2. Mode [M]: Moments Organizer Overview & Next Steps
                # -----------------------------------------------------------------
                cur.execute("SELECT MIN(threshold_score) FROM threshold_history WHERE threshold_score > 0.0")
                min_th_row = cur.fetchone()
                db_hist_min = float(min_th_row[0]) if min_th_row and min_th_row[0] else 0.5315

                cur.execute("SELECT recorded_at_utc FROM threshold_history ORDER BY id DESC LIMIT 1")
                last_th_row = cur.fetchone()
                last_th_utc = last_th_row[0] if last_th_row else None

                cur.execute("SELECT memory_stage, COUNT(*) FROM curated_moments GROUP BY memory_stage")
                moment_stage_counts = {r[0]: r[1] for r in cur.fetchall()}

                cur.execute("SELECT COUNT(DISTINCT moment_name), COUNT(DISTINCT asset_uuid) FROM publications")
                pub_totals = cur.fetchone()
                published_moments_total = pub_totals[0] if pub_totals else 0
                published_assets_total = pub_totals[1] if pub_totals else 0

                pub_tag_status_by_lc, _ = _load_moment_tagging_status_map(cur)
                pub_ranked_rows = cur.execute(
                    """
                    SELECT
                        p.moment_name,
                        AVG(
                            (COALESCE(a.aesthetic_score, 0) * 0.875) +
                            (COALESCE(a.google_favorite, 0) * 0.125) +
                            (COALESCE(a.apple_photos_monthly_selection, 0) * 0.15) +
                            (COALESCE(a.mobile_apple_photos_featured_photos, 0) * 0.15)
                        ) AS avg_score
                    FROM publications p
                    LEFT JOIN assets a ON p.asset_uuid = a.asset_id
                    GROUP BY p.moment_name
                    ORDER BY avg_score DESC NULLS LAST, MAX(p.published_at_utc) DESC
                    """
                ).fetchall()
                top_published_moment = None
                untagged_published_moments = 0
                for m_name_pub, avg_s_pub in pub_ranked_rows:
                    if not m_name_pub:
                        continue
                    if m_name_pub.strip().lower() in pub_tag_status_by_lc:
                        continue
                    untagged_published_moments += 1
                    if top_published_moment is None:
                        top_published_moment = {
                            "moment_name": m_name_pub,
                            "avg_score": round(float(avg_s_pub or 0.0), 4),
                        }

                mode_m_live = _compute_mode_m_from_db(cur, db_hist_min, last_th_utc)

                curr_thresh = mode_m_live["current_threshold"]
                hist_min = mode_m_live["historical_min"]
                thresh_aligned = mode_m_live["threshold_aligned"]
                unassigned_clusters = mode_m_live["unassigned_clusters"]
                total_unassigned_assets = sum(len(c["assets"]) for c in unassigned_clusters)

                mode_m_payload = {
                    "threshold": {
                        "current": curr_thresh,
                        "historical_min": hist_min,
                        "aligned": thresh_aligned,
                        "last_checked_utc": last_th_utc,
                        "driver": mode_m_live.get("threshold_driver"),
                    },
                    "stage_counts": {
                        "M400": moment_stage_counts.get("M400", 0),
                        "M450": moment_stage_counts.get("M450", 0),
                        "M500": moment_stage_counts.get("M500", 0),
                        "needs_sync": len(mode_m_live["needs_sync_moments"]),
                        "total_moments": sum(moment_stage_counts.values()),
                        "published_moments_total": published_moments_total,
                        "published_untagged_total": untagged_published_moments,
                        "published_assets_total": published_assets_total,
                        "top_published": top_published_moment,
                    },
                    "needs_sync_moments": mode_m_live["needs_sync_moments"],
                    "unassigned_total_assets": total_unassigned_assets,
                    "unassigned_total_clusters": len(unassigned_clusters),
                    "unassigned_clusters": unassigned_clusters,
                    "grouping_rules": mode_m_live["grouping_rules"],
                    "actionable_recommendations": mode_m_live["actionable_recs"][:12],
                    "disjoint_recommendations": mode_m_live["disjoint_recs"][:25],
                    "cli_step2_sim": mode_m_live.get("cli_step2_sim"),
                }

            return {
                "connected": True,
                "mode": mode_norm,
                "mode_b": mode_b_payload,
                "mode_m": mode_m_payload,
            }
        finally:
            conn.close()
    except Exception as e:
        return {"connected": False, "error": str(e)}


_MONTH_SELECTION_LIVE_APPLESCRIPT = r'''
on run argv
    set targetName to item 1 of argv
    tell application "Photos"
        try
            set topF to folder "Media Organizer on LaCie"
            set msF to folder "Apple Photos Month Selection" of topF
        on error errMsg
            return "ERROR|" & errMsg
        end try

        set matchedName to ""
        set matchedCount to 0
        try
            set albList to albums of msF
            repeat with aObj in albList
                set rawName to (name of aObj) as string
                if rawName is targetName then
                    set matchedName to rawName
                    set matchedCount to count of media items of aObj
                    return "FOUND|" & matchedName & "|" & (matchedCount as string)
                end if
            end repeat
            -- Trimmed/case-insensitive check via lowercase comparison
            repeat with aObj in albList
                set rawName to (name of aObj) as string
                ignoring case
                    set trimmedOk to (rawName is targetName) or (rawName starts with targetName and length of rawName <= (length of targetName + 2))
                end ignoring
                if trimmedOk then
                    set matchedName to rawName
                    set matchedCount to count of media items of aObj
                    return "FOUND|" & matchedName & "|" & (matchedCount as string)
                end if
            end repeat
        on error errMsg
            return "ERROR|" & errMsg
        end try
        return "MISSING|" & targetName & "|0"
    end tell
end run
'''


def _check_live_photos_month_selection(expected_album: str) -> dict:
    """Read-only AppleScript check for an album under Media Organizer on LaCie / Apple Photos Month Selection."""
    try:
        proc = subprocess.run(
            ["osascript", "-", expected_album],
            input=_MONTH_SELECTION_LIVE_APPLESCRIPT,
            capture_output=True,
            text=True,
            timeout=10,
        )
        stdout = (proc.stdout or "").strip()
        if proc.returncode != 0:
            err = (proc.stderr or stdout or f"osascript exited {proc.returncode}").strip()
            return {"checked": True, "exists": False, "count": 0, "matched_name": None, "error": err}
        parts = stdout.split("|")
        tag = parts[0] if parts else ""
        if tag == "FOUND":
            cnt = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
            return {
                "checked": True,
                "exists": True,
                "count": cnt,
                "matched_name": parts[1] if len(parts) > 1 else expected_album,
                "error": None,
            }
        if tag == "MISSING":
            return {"checked": True, "exists": False, "count": 0, "matched_name": None, "error": None}
        err_msg = parts[1] if len(parts) > 1 else stdout
        return {"checked": True, "exists": False, "count": 0, "matched_name": None, "error": err_msg}
    except Exception as e:
        return {"checked": True, "exists": False, "count": 0, "matched_name": None, "error": str(e)}


@router.get("/planner/month-selection-detail")
def get_planner_month_selection_detail(month: str, live: bool = False):
    """Inspect Apple Photos Month Selection album existence, asset count, and sample assets for a batch."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    m_str = (month or "").strip()
    if not m_str:
        return {"ok": False, "error": "month is required"}

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            ms_info = _check_apple_month_selection_status(cur, m_str)

            cur.execute(
                "SELECT status_code, COALESCE(assets_count, 0), COALESCE(is_bypassed, 0) FROM month_batches WHERE month = ?",
                (m_str,),
            )
            mb_row = cur.fetchone()
            status_code = str(mb_row[0]) if mb_row and mb_row[0] is not None else "—"
            batch_assets_count = int(mb_row[1] or 0) if mb_row else 0
            is_bypassed = bool(mb_row[2]) if mb_row else False

            cur.execute("SELECT 1 FROM planned_execution WHERE planned_month = ? AND active = 1 LIMIT 1", (m_str,))
            in_queue = cur.fetchone() is not None

            cur.execute("SELECT MAX(synced_at_utc) FROM media_organizer_albums")
            sync_row = cur.fetchone()
            db_synced_at_utc = sync_row[0] if sync_row else None

            assets_preview = []
            album_pk = ms_info.get("album_pk")
            if album_pk is not None:
                cur.execute(
                    """
                    SELECT
                        moaa.asset_id,
                        COALESCE(v.original_filename, a.original_filename, moaa.original_filename, ''),
                        COALESCE(v.date_created_utc, a.date_created_utc, moaa.date_created_utc, ''),
                        ROUND(COALESCE(v.score_normalized, 0.0), 4),
                        COALESCE(a.month, '')
                    FROM media_organizer_album_assets moaa
                    LEFT JOIN assets a ON a.asset_id = moaa.asset_id
                    LEFT JOIN ranked_assets_view v ON v.asset_id = moaa.asset_id
                    WHERE moaa.album_pk = ?
                    ORDER BY COALESCE(v.score_normalized, 0.0) DESC, moaa.date_created_utc ASC
                    LIMIT 24
                    """,
                    (album_pk,),
                )
                for aid, fn, dt_s, sc, asset_month in cur.fetchall():
                    assets_preview.append(
                        {
                            "asset_id": aid,
                            "original_filename": fn or aid,
                            "date_created_utc": (dt_s or "")[:19],
                            "score_normalized": float(sc or 0.0),
                            "month": asset_month or "",
                        }
                    )

            if not assets_preview and ms_info.get("batch_selected_count", 0) > 0:
                cur.execute(
                    """
                    SELECT
                        a.asset_id,
                        COALESCE(v.original_filename, a.original_filename, ''),
                        COALESCE(v.date_created_utc, a.date_created_utc, ''),
                        ROUND(COALESCE(v.score_normalized, 0.0), 4),
                        COALESCE(a.month, '')
                    FROM assets a
                    LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
                    WHERE a.month = ? AND COALESCE(a.apple_photos_monthly_selection, 0) = 1
                    ORDER BY COALESCE(v.score_normalized, 0.0) DESC, a.date_created_utc ASC
                    LIMIT 24
                    """,
                    (m_str,),
                )
                for aid, fn, dt_s, sc, asset_month in cur.fetchall():
                    assets_preview.append(
                        {
                            "asset_id": aid,
                            "original_filename": fn or aid,
                            "date_created_utc": (dt_s or "")[:19],
                            "score_normalized": float(sc or 0.0),
                            "month": asset_month or "",
                        }
                    )

            live_check = _check_live_photos_month_selection(ms_info["expected_album"]) if live else None
            return {
                "ok": True,
                "month": m_str,
                "status_code": status_code,
                "is_bypassed": is_bypassed,
                "in_queue": in_queue,
                "batch_assets_count": batch_assets_count,
                "db_synced_at_utc": db_synced_at_utc,
                "expected_path": f"Media Organizer on LaCie / Apple Photos Month Selection / {ms_info['expected_album']}",
                "month_selection": ms_info,
                "assets": assets_preview,
                "live_photos_app": live_check,
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/planner/month-selection/create-empty")
def create_empty_month_selection_album(req: MonthSelectionCreateEmptyRequest):
    """Create an empty month album under Media Organizer on LaCie / Apple Photos Month Selection in Apple Photos."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    m_str = (req.month or "").strip()
    if not m_str:
        return {"ok": False, "error": "month is required"}

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            ms_info = _check_apple_month_selection_status(cur, m_str)
            expected_album = (ms_info.get("expected_album") or m_str).strip()

            try:
                proc = subprocess.run(
                    [
                        "osascript",
                        "-",
                        "Media Organizer on LaCie",
                        "Apple Photos Month Selection",
                        expected_album,
                        "1",
                    ],
                    input=_MOMENTS_APPLESCRIPT,
                    capture_output=True,
                    text=True,
                    timeout=45,
                )
            except Exception as e:
                return {"ok": False, "error": f"Failed to run osascript: {e}"}

            stdout = (proc.stdout or "").strip()
            stderr = (proc.stderr or "").strip()
            if proc.returncode != 0:
                return {"ok": False, "error": stderr or stdout or f"AppleScript failed (exit {proc.returncode})"}
            if stdout.startswith("ERROR|"):
                return {"ok": False, "error": stdout.split("|", 1)[1]}

            parts = stdout.split("|")
            action_state = parts[0] if parts and parts[0] else "created"

            # Mirror album immediately into media_organizer_albums so reload sees "Folder is empty" before DB sync catches up
            top_folder = "Media Organizer on LaCie"
            parent_folder = "Apple Photos Month Selection"
            full_path = f"{top_folder}/{parent_folder}/{expected_album}"
            p_row = cur.execute(
                """
                SELECT album_pk, depth FROM media_organizer_albums
                WHERE is_folder = 1
                  AND LOWER(TRIM(album_name)) = LOWER(?)
                  AND LOWER(full_path) LIKE 'media organizer on lacie%'
                ORDER BY depth ASC, album_pk ASC
                LIMIT 1
                """,
                (parent_folder,),
            ).fetchone()
            if p_row:
                parent_pk = int(p_row[0])
                depth = int(p_row[1] or 2) + 1
            else:
                top_row = cur.execute(
                    "SELECT album_pk FROM media_organizer_albums WHERE is_folder = 1 AND LOWER(TRIM(album_name)) = LOWER(?) LIMIT 1",
                    (top_folder,),
                ).fetchone()
                top_pk = int(top_row[0]) if top_row else None
                parent_pk = _allocate_synthetic_album_pk(cur)
                cur.execute(
                    """
                    INSERT INTO media_organizer_albums
                        (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
                    VALUES (?, ?, ?, ?, ?, 1, 2, 4000, 0, datetime('now'))
                    """,
                    (parent_pk, parent_folder, top_pk, top_folder, f"{top_folder}/{parent_folder}"),
                )
                depth = 3

            alb_row = cur.execute(
                """
                SELECT album_pk FROM media_organizer_albums
                WHERE is_folder = 0
                  AND (
                      LOWER(full_path) = LOWER(?)
                      OR (LOWER(TRIM(album_name)) = LOWER(?) AND LOWER(TRIM(COALESCE(parent_folder_name, ''))) = LOWER(?))
                  )
                LIMIT 1
                """,
                (full_path, expected_album, parent_folder),
            ).fetchone()
            if not alb_row:
                alb_pk = _allocate_synthetic_album_pk(cur)
                cur.execute(
                    """
                    INSERT INTO media_organizer_albums
                        (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
                    VALUES (?, ?, ?, ?, ?, 0, ?, 2, 0, datetime('now'))
                    """,
                    (alb_pk, expected_album, parent_pk, parent_folder, full_path, depth),
                )
            conn.commit()
            updated_ms = _check_apple_month_selection_status(cur, m_str)
            return {
                "ok": True,
                "month": m_str,
                "album_name": expected_album,
                "action_state": action_state,
                "month_selection": updated_ms,
                "message": (
                    f"Created empty folder '{expected_album}' in Apple Photos"
                    if action_state == "created"
                    else f"Folder '{expected_album}' already exists in Apple Photos"
                ),
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/planner/batch-action")
def execute_planner_batch_action(req: PlannerBatchActionRequest):
    """Perform interactive Mode [B] batch management actions (queue batch, confirm 400->500, bypass 400->500, remove from queue)."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    month = (req.month or "").strip()
    action = (req.action or "").strip().lower()
    if not month or not action:
        return {"ok": False, "error": "Month and action are required"}

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            if action == "queue":
                _ensure_planned_execution_override_column(cur)
                cur.execute("SELECT status_code, COALESCE(is_bypassed, 0) FROM month_batches WHERE month = ?", (month,))
                mb_row = cur.fetchone()
                batch_status = str(mb_row[0]) if mb_row and mb_row[0] is not None else ""
                is_byp = bool(mb_row[1]) if mb_row else False

                skip_ms_flag = 0
                if batch_status in ("500", "550"):
                    ms_info = _check_apple_month_selection_status(cur, month)
                    if not ms_info.get("ready"):
                        if not is_byp and not req.confirm_missing_month_selection:
                            warn_code = "EMPTY_MONTH_SELECTION" if ms_info.get("exists") else "MISSING_MONTH_SELECTION"
                            err_msg = (
                                f"Apple Photos Month Selection album '{ms_info.get('matched_album_name') or ms_info.get('expected_album')}' has 0 assets."
                                if ms_info.get("exists")
                                else f"Apple Photos Month Selection album '{ms_info.get('expected_album')}' was not found."
                            )
                            return {
                                "ok": False,
                                "requires_confirmation": True,
                                "warning_code": warn_code,
                                "month_selection": ms_info,
                                "error": err_msg,
                            }
                        skip_ms_flag = 1

                cur.execute("SELECT id FROM planned_execution WHERE planned_month = ? AND active = 1", (month,))
                existing = cur.fetchone()
                if existing:
                    cur.execute(
                        "UPDATE planned_execution SET set_at_utc = datetime('now'), skip_month_selection_check = ? WHERE id = ?",
                        (skip_ms_flag, existing[0]),
                    )
                    msg = f"Updated existing queue entry for batch {month} (ID #{existing[0]})"
                else:
                    cur.execute(
                        "INSERT INTO planned_execution (planned_month, active, set_at_utc, skip_month_selection_check) VALUES (?, 1, datetime('now'), ?)",
                        (month, skip_ms_flag),
                    )
                    msg = f"Added batch {month} to active execution queue"
            elif action == "remove_queue":
                cur.execute("UPDATE planned_execution SET active = 0 WHERE planned_month = ? AND active = 1", (month,))
                msg = f"Removed batch {month} from active execution queue"
            elif action == "confirm_500":
                cur.execute("""
                    UPDATE month_batches
                    SET status_code = '500', is_bypassed = 0, bypass_timestamp = NULL, updated_at_utc = datetime('now')
                    WHERE month = ?
                """, (month,))
                msg = f"Confirmed Google Photos Curation for {month} (status 400 ➜ 500)"
            elif action == "bypass_500":
                cur.execute("""
                    UPDATE month_batches
                    SET status_code = '500', is_bypassed = 1, bypass_timestamp = datetime('now'), updated_at_utc = datetime('now')
                    WHERE month = ?
                """, (month,))
                msg = f"Marked {month} as Direct-Rank Bypassed (status 400 ➜ 500)"
            elif action == "demote_400":
                target_months = [m.strip() for m in (req.months or ([month] if month else [])) if m and m.strip()]
                if not target_months:
                    return {"ok": False, "error": "At least one month is required for demote_400"}
                placeholders = ",".join("?" for _ in target_months)
                cur.execute(
                    f"""
                    UPDATE month_batches
                    SET status_code = '400', is_bypassed = 0, bypass_timestamp = NULL, updated_at_utc = datetime('now')
                    WHERE month IN ({placeholders})
                    """,
                    target_months,
                )
                cur.execute(
                    f"UPDATE planned_execution SET active = 0 WHERE planned_month IN ({placeholders}) AND active = 1",
                    target_months,
                )
                msg = f"Returned {', '.join(target_months)} back to Google curation (status ➜ 400) and dequeued if active"
            elif action == "reset_000":
                cur.execute("""
                    UPDATE month_batches
                    SET status_code = '000', updated_at_utc = datetime('now')
                    WHERE month = ?
                """, (month,))
                msg = f"Reset batch {month} to status 000"
            else:
                return {"ok": False, "error": f"Unsupported action: {action}"}

            conn.commit()
            return {"ok": True, "month": month, "action": action, "message": msg}
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


_intake_dedup_cache = {
    "timestamp": 0.0,
    "dup_ids": set(),
}


def _load_dedup_module():
    """Dynamically load dedup_unassigned_moments helper module without duplicating dedup/pHash logic."""
    scripts_dir = REPOS["media-organizer-pipeline"] / "scripts"
    script_path = scripts_dir / "dedup_unassigned_moments.py"
    if not script_path.exists():
        return None
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import importlib.util

    spec = importlib.util.spec_from_file_location("dedup_unassigned_moments", script_path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _get_intake_duplicate_ids(force: bool = False) -> set[str]:
    """Computes duplicate unassigned asset IDs via Media-Intake dedup (cached 5m) instead of Photos Merge."""
    now = time.time()
    if not force and (now - _intake_dedup_cache["timestamp"] < 300.0) and _intake_dedup_cache["dup_ids"]:
        return set(_intake_dedup_cache["dup_ids"])
    try:
        mod = _load_dedup_module()
        if mod is None:
            return set(_intake_dedup_cache["dup_ids"])
        res = mod.analyze_unassigned_duplicates(db_path=str(MEDIA_DB_PATH), use_phash=True)
        dup_ids = {d["duplicate_asset_id"] for d in res.get("duplicates", [])}
        _intake_dedup_cache["timestamp"] = now
        _intake_dedup_cache["dup_ids"] = dup_ids
        return set(dup_ids)
    except Exception:
        return set(_intake_dedup_cache["dup_ids"])


def _detect_duplicates_for_asset_list(
    conn: sqlite3.Connection,
    cur: sqlite3.Cursor,
    asset_ids: list[str],
    target_threshold: float,
    excluded_aids: set[str],
    use_phash: bool = True,
) -> dict[str, dict]:
    """Run Media-Intake tier matching (Exact Byte, Same Name+Time, pHash) for a Moment's asset list."""
    target_set = {aid for aid in asset_ids if aid and aid not in excluded_aids}
    if not target_set:
        return {}
    try:
        mod = _load_dedup_module()
    except Exception:
        return {}
    if mod is None:
        return {}

    try:
        mod.ensure_phash_cache_table(conn)
        ph_t = ",".join("?" for _ in target_set)
        dt_rows = cur.execute(
            f"""
            SELECT datetime(za.ZDATECREATED + 978307200, 'unixepoch')
            FROM ZASSET za
            WHERE za.ZUUID IN ({ph_t}) AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
            """,
            tuple(sorted(target_set)),
        ).fetchall()
        cand_dates: set[str] = set()
        for (dt_s,) in dt_rows:
            if dt_s and len(dt_s) >= 10:
                try:
                    dt_b = datetime.strptime(dt_s[:10], "%Y-%m-%d")
                    for delta in (-1, 0, 1):
                        cand_dates.add((dt_b + timedelta(days=delta)).strftime("%Y-%m-%d"))
                except ValueError:
                    pass
        if not cand_dates:
            return {}

        date_list = sorted(cand_dates)
        ph_d = ",".join("?" for _ in date_list)
        pool_rows = cur.execute(
            f"""
            SELECT za.ZUUID,
                   COALESCE(aaa.ZORIGINALFILENAME, za.ZFILENAME),
                   datetime(za.ZDATECREATED + 978307200, 'unixepoch'),
                   za.ZDIRECTORY,
                   za.ZFILENAME,
                   COALESCE(aaa.ZORIGINALFILESIZE, 0),
                   COALESCE(za.ZKIND, 0),
                   COALESCE(za.ZWIDTH, 0),
                   COALESCE(za.ZHEIGHT, 0),
                   (za.ZDATECREATED + 978307200),
                   ast.MomentsAlbumName,
                   COALESCE(v.score_normalized, ast.aesthetic_score, 0.0),
                   COALESCE(ast.apple_favorite, 0),
                   COALESCE(ast.google_favorite, 0),
                   COALESCE(ast.month, '')
            FROM ZASSET za
            LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.Z_PK = za.ZADDITIONALATTRIBUTES
            LEFT JOIN assets ast ON ast.asset_id = za.ZUUID
            LEFT JOIN ranked_assets_view v ON v.asset_id = za.ZUUID
            WHERE COALESCE(za.ZTRASHEDSTATE, 0) = 0
              AND COALESCE(ast.removed_from_source, 0) = 0
              AND substr(datetime(za.ZDATECREATED + 978307200, 'unixepoch'), 1, 10) IN ({ph_d})
            """,
            tuple(date_list),
        ).fetchall()

        pool_map: dict[str, dict] = {}
        by_date_kind: dict[tuple[str, int], list[dict]] = {}
        by_date_stem: dict[tuple[str, str], list[dict]] = {}
        for row in pool_rows:
            aid = row[0]
            if aid in excluded_aids:
                continue
            fn = row[1] or row[4] or ""
            dt = row[2] or ""
            info = {
                "asset_id": aid,
                "filename": fn,
                "date_utc": dt,
                "ymd": dt[:10] if len(dt) >= 10 else "",
                "zdir": row[3] or "",
                "zfilename": row[4] or "",
                "size": int(row[5] or 0),
                "kind": int(row[6] or 0),
                "width": int(row[7] or 0),
                "height": int(row[8] or 0),
                "unix_ts": float(row[9] or 0.0),
                "moment": row[10] or "",
                "score": float(row[11] or 0.0),
                "apple_favorite": int(row[12] or 0),
                "google_favorite": int(row[13] or 0),
                "month": row[14] or (dt[:7] if len(dt) >= 7 else ""),
                "stem": mod.normalize_filename_stem(fn),
                "ext": os.path.splitext(fn.lower())[1].lstrip("."),
            }
            pool_map[aid] = info
            if info["ymd"]:
                by_date_kind.setdefault((info["ymd"], info["kind"]), []).append(info)
                if info["stem"]:
                    by_date_stem.setdefault((info["ymd"], info["stem"]), []).append(info)

        cached_hashes_db = {
            r[0]: r[1]
            for r in cur.execute("SELECT asset_id, phash FROM asset_phash_cache WHERE phash IS NOT NULL").fetchall()
        }
        hash_int_cache: dict[str, Optional[int]] = {}
        new_hashes_to_persist: list[tuple[str, str, int, str]] = []
        allow_live_phash = len(target_set) <= 10

        def _get_phash_int(info: dict) -> Optional[int]:
            a_id = info["asset_id"]
            if a_id in hash_int_cache:
                return hash_int_cache[a_id]
            if a_id in cached_hashes_db:
                try:
                    val = int(cached_hashes_db[a_id], 16)
                    hash_int_cache[a_id] = val
                    return val
                except Exception:
                    pass
            if allow_live_phash and getattr(mod, "HAS_IMAGEHASH", False):
                _, h_hex = mod.compute_asset_phash(a_id, info["zdir"], info["zfilename"])
                if h_hex:
                    new_hashes_to_persist.append((a_id, info["zfilename"], info["size"], h_hex))
                    try:
                        val = int(h_hex, 16)
                        hash_int_cache[a_id] = val
                        return val
                    except Exception:
                        pass
            hash_int_cache[a_id] = None
            return None

        uf = mod._UnionFind(pool_map.keys())
        edge_meta: dict[tuple[str, str], dict] = {}

        def _record(a_id: str, b_id: str, tier: str, dist: int, sim: float) -> None:
            uf.union(a_id, b_id)
            key = (a_id, b_id) if a_id < b_id else (b_id, a_id)
            prev = edge_meta.get(key)
            if not prev or sim > prev["similarity_pct"] or (sim == prev["similarity_pct"] and dist < prev["hamming_distance"]):
                edge_meta[key] = {
                    "match_tier": tier,
                    "hamming_distance": dist,
                    "similarity_pct": round(sim, 2),
                }

        for aid in sorted(target_set):
            me = pool_map.get(aid)
            if not me or not me["ymd"]:
                continue
            try:
                base_dt = datetime.strptime(me["ymd"], "%Y-%m-%d")
            except ValueError:
                continue
            cands = []
            for delta in (-1, 0, 1):
                d_str = (base_dt + timedelta(days=delta)).strftime("%Y-%m-%d")
                cands.extend(by_date_kind.get((d_str, me["kind"]), []))

            # Also pair same-stem photo + video (e.g. Live Photo companion IMG_7098.HEIC + IMG_7098.MOV)
            if me["stem"]:
                for delta in (-1, 0, 1):
                    d_str = (base_dt + timedelta(days=delta)).strftime("%Y-%m-%d")
                    for c in by_date_stem.get((d_str, me["stem"]), []):
                        if c["asset_id"] == aid or c["kind"] == me["kind"]:
                            continue
                        if abs(c["unix_ts"] - me["unix_ts"]) <= 30.0:
                            _record(aid, c["asset_id"], "Tier 2: Same-Name Photo+Video Pair", 0, 99.0)

            matched_meta = False
            for c in cands:
                cid = c["asset_id"]
                if cid == aid:
                    continue
                dt_diff = abs(c["unix_ts"] - me["unix_ts"])
                if dt_diff > 86400:
                    continue
                if me["size"] > 0 and c["size"] == me["size"] and (me["stem"] == c["stem"] or dt_diff <= 2.0):
                    _record(aid, cid, "Tier 1: Exact Byte+Date", 0, 100.0)
                    matched_meta = True
                elif me["size"] > 0 and c["size"] == me["size"] and me["ext"] == c["ext"]:
                    _record(aid, cid, "Tier 1: Exact Byte+Date", 0, 100.0)
                    matched_meta = True
                elif me["stem"] and c["stem"] == me["stem"] and dt_diff <= 10.0:
                    tier = "Tier 2: Same Name+Time" if me["ext"] == c["ext"] else "Tier 2: Format/Quality Pair"
                    sim = 99.5 if me["ext"] == c["ext"] else 99.0
                    _record(aid, cid, tier, 0, sim)
                    matched_meta = True

            if use_phash and me["kind"] == 0 and not matched_meta and (getattr(mod, "HAS_IMAGEHASH", False) or cached_hashes_db):
                my_h = _get_phash_int(me)
                if my_h is not None:
                    near_cands = sorted(
                        [c for c in cands if c["asset_id"] != aid and abs(c["unix_ts"] - me["unix_ts"]) <= 86400],
                        key=lambda x: abs(x["unix_ts"] - me["unix_ts"]),
                    )[:40]
                    for c in near_cands:
                        ch = _get_phash_int(c)
                        if ch is None:
                            continue
                        dist = (my_h ^ ch).bit_count()
                        if dist <= getattr(mod, "PHASH_MAX_HAMMING_DIST", 6):
                            sim = max(0.0, 1.0 - (dist / 64.0)) * 100.0
                            _record(aid, c["asset_id"], "Tier 2.5: Visual pHash", dist, sim)

        if new_hashes_to_persist:
            cur.executemany(
                """
                INSERT OR REPLACE INTO asset_phash_cache (asset_id, zfilename, file_size, phash)
                VALUES (?, ?, ?, ?)
                """,
                new_hashes_to_persist,
            )

        components: dict[str, list[dict]] = {}
        for aid, info in pool_map.items():
            components.setdefault(uf.find(aid), []).append(info)

        dup_map: dict[str, dict] = {}
        ext_prio_map = getattr(mod, "EXTENSION_PRIORITY", {"heic": 0, "heif": 0, "dng": 1, "raw": 1, "png": 2, "jpg": 3, "jpeg": 3, "mp4": 4, "mov": 5})
        excluded_names = getattr(mod, "EXCLUDED_ALBUM_NAMES", ("ignore", "skippublishing", "topscore excluded"))

        def _keeper_rank(m: dict) -> tuple:
            mom = (m.get("moment") or "").strip()
            is_assigned = 1 if mom and mom.lower() not in excluded_names else 0
            above_thresh = 1 if m["score"] > target_threshold else 0
            is_still_photo = 1 if m["kind"] == 0 else 0
            is_heic = 1 if m["ext"] in ("heic", "heif") else 0
            pixels = (m["width"] or 0) * (m["height"] or 0)
            pixel_bucket = int(pixels // 100000)
            ext_prio = ext_prio_map.get(m["ext"], 99)
            clean_name = 0 if mod.has_copy_suffix(m["filename"]) else 1
            fav = 1 if (m.get("apple_favorite") or m.get("google_favorite")) else 0
            return (
                is_assigned,
                is_heic,
                is_still_photo,
                above_thresh,
                pixel_bucket,
                -ext_prio,
                m["size"],
                round(m["score"], 4),
                clean_name,
                fav,
                m["asset_id"],
            )

        for _root, members in components.items():
            if len(members) < 2 or not any(m["asset_id"] in target_set for m in members):
                continue
            keeper = max(members, key=_keeper_rank)
            keeper_id = keeper["asset_id"]
            for m in members:
                mid = m["asset_id"]
                if mid == keeper_id or mid not in target_set:
                    continue
                ek = (mid, keeper_id) if mid < keeper_id else (keeper_id, mid)
                em = edge_meta.get(ek) or {"match_tier": "Moment Duplicate", "hamming_distance": 0, "similarity_pct": 98.0}
                dup_map[mid] = {
                    "is_duplicate_copy": True,
                    "duplicate_keeper_id": keeper_id,
                    "duplicate_keeper_filename": keeper["filename"],
                    "duplicate_keeper_moment": keeper["moment"],
                    "duplicate_match_tier": em["match_tier"],
                    "duplicate_similarity_pct": em["similarity_pct"],
                }
        return dup_map
    except Exception:
        return {}


def _get_pipeline_python_and_dedup_script() -> tuple[str, Path]:
    python_bin = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
    if not os.path.exists(python_bin):
        python_bin = sys.executable
    script_path = REPOS["media-organizer-pipeline"] / "scripts" / "dedup_unassigned_moments.py"
    return python_bin, script_path


@router.post("/mode-m/dedup-preview")
def preview_mode_m_intake_dedup():
    """Runs Media-Intake multi-tier dedup & visual comparison before Proposed Moment grouping (dry run)."""
    python_bin, script_path = _get_pipeline_python_and_dedup_script()
    if not script_path.exists():
        raise HTTPException(status_code=404, detail=f"Script not found: {script_path}")
    try:
        proc = subprocess.run(
            [python_bin, str(script_path), "--dry-run", "--json"],
            cwd=str(REPOS["media-organizer-pipeline"]),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode != 0:
            return {"ok": False, "error": proc.stderr.strip() or proc.stdout.strip() or f"Exit code {proc.returncode}"}
        data = json.loads(proc.stdout)
        _intake_dedup_cache["timestamp"] = time.time()
        _intake_dedup_cache["dup_ids"] = {d["duplicate_asset_id"] for d in data.get("duplicates", [])}
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/mode-m/dedup-apply")
def apply_mode_m_intake_dedup(req: ModeMDedupApplyRequest):
    """Adds identified duplicate assets to Apple Photos 'Ignore' album & local DB so they leave Proposed Moment groups."""
    clean_ids = [aid.strip() for aid in (req.asset_ids or []) if aid and aid.strip()]
    if not clean_ids:
        return {"ok": False, "error": "No asset_ids provided"}
    python_bin, script_path = _get_pipeline_python_and_dedup_script()
    if not script_path.exists():
        raise HTTPException(status_code=404, detail=f"Script not found: {script_path}")
    try:
        proc = subprocess.run(
            [python_bin, str(script_path), "--apply", "--json", "--asset-ids", *clean_ids],
            cwd=str(REPOS["media-organizer-pipeline"]),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode != 0:
            return {"ok": False, "error": proc.stderr.strip() or proc.stdout.strip() or f"Exit code {proc.returncode}"}
        data = json.loads(proc.stdout)
        _intake_dedup_cache["timestamp"] = 0.0
        _intake_dedup_cache["dup_ids"] = set()
        return data
    except Exception as e:
        return {"ok": False, "error": str(e)}


class GroupingRulesUpdateRequest(BaseModel):
    rules: Optional[dict[str, bool]] = None
    refuse_cluster: Optional[str] = None
    restore_cluster: Optional[str] = None
    split_asset_ids: Optional[list[str]] = None
    split_target_group: Optional[str] = None
    split_source_group: Optional[str] = None
    clear_split_group: Optional[str] = None
    clear_split_asset_ids: Optional[list[str]] = None
    reset_defaults: bool = False


@router.post("/mode-m/grouping-rules")
def update_mode_m_grouping_rules(req: GroupingRulesUpdateRequest):
    """Persist enabled/refused grouping rules, refused clusters, and per-asset event splits in media_organizer.db."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    valid_ids = {r["id"] for r in DEFAULT_GROUPING_RULES}
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            _ensure_grouping_rule_tables(cur)

            if req.reset_defaults:
                cur.execute("DELETE FROM mode_m_grouping_rules")
                cur.execute("DELETE FROM mode_m_refused_clusters")
                cur.execute("DELETE FROM mode_m_asset_splits")
            else:
                if req.rules:
                    for rid, en in req.rules.items():
                        if rid in valid_ids:
                            cur.execute(
                                """
                                INSERT INTO mode_m_grouping_rules (rule_id, enabled, updated_at_utc)
                                VALUES (?, ?, datetime('now'))
                                ON CONFLICT(rule_id) DO UPDATE SET
                                    enabled = excluded.enabled,
                                    updated_at_utc = excluded.updated_at_utc
                                """,
                                (rid, 1 if en else 0),
                            )
                if req.refuse_cluster:
                    ck = req.refuse_cluster.strip()
                    if ck:
                        cur.execute(
                            """
                            INSERT OR REPLACE INTO mode_m_refused_clusters (cluster_key, refused_at_utc)
                            VALUES (?, datetime('now'))
                            """,
                            (ck,),
                        )
                if req.restore_cluster:
                    ck = req.restore_cluster.strip()
                    if ck:
                        cur.execute("DELETE FROM mode_m_refused_clusters WHERE cluster_key = ?", (ck,))
                        cur.execute(
                            "DELETE FROM mode_m_asset_splits WHERE source_group = ? AND target_group = '__INDIVIDUAL__'",
                            (ck,),
                        )
                if req.split_asset_ids and req.split_target_group:
                    tgt = req.split_target_group.strip()
                    src = (req.split_source_group or "").strip() or None
                    if tgt:
                        for raw_aid in req.split_asset_ids:
                            aid = (raw_aid or "").strip()
                            if aid:
                                cur.execute(
                                    """
                                    INSERT INTO mode_m_asset_splits (asset_id, target_group, source_group, updated_at_utc)
                                    VALUES (?, ?, ?, datetime('now'))
                                    ON CONFLICT(asset_id) DO UPDATE SET
                                        target_group = excluded.target_group,
                                        source_group = COALESCE(excluded.source_group, mode_m_asset_splits.source_group),
                                        updated_at_utc = excluded.updated_at_utc
                                    """,
                                    (aid, tgt, src),
                                )
                if req.clear_split_group:
                    cg = req.clear_split_group.strip()
                    if cg:
                        cur.execute("DELETE FROM mode_m_asset_splits WHERE target_group = ?", (cg,))
                if req.clear_split_asset_ids:
                    clean_clr = [(a or "").strip() for a in req.clear_split_asset_ids if (a or "").strip()]
                    if clean_clr:
                        ph = ",".join("?" for _ in clean_clr)
                        cur.execute(f"DELETE FROM mode_m_asset_splits WHERE asset_id IN ({ph})", clean_clr)

            conn.commit()
            rules_map, refused, splits = _load_grouping_rules_state(cur)
            custom_split_groups = sorted({tgt for tgt, _src in splits.values() if tgt and tgt != "__INDIVIDUAL__"})
            return {
                "ok": True,
                "rules": rules_map,
                "refused_clusters": sorted(refused),
                "custom_split_groups": custom_split_groups,
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


class CreateMomentRequest(BaseModel):
    moment_name: str
    parent_folder: str = "Moments"
    asset_ids: list[str] = []
    ignore_asset_ids: list[str] = []
    allow_existing: bool = True


_MOMENTS_APPLESCRIPT = r'''
on run argv
    set topFolderName to item 1 of argv
    set parentFolderName to item 2 of argv
    set targetAlbumName to item 3 of argv
    set allowExisting to (item 4 of argv) is "1"
    set assetIds to {}
    if (count of argv) > 4 then
        set assetIds to items 5 thru (count of argv) of argv
    end if

    tell application "Photos"
        if not (exists folder topFolderName) then
            make new folder named topFolderName
        end if
        set topFolder to folder topFolderName

        if parentFolderName is not "" and parentFolderName is not topFolderName then
            if not (exists folder parentFolderName of topFolder) then
                make new folder named parentFolderName at topFolder
            end if
            set containerFolder to folder parentFolderName of topFolder
        else
            set containerFolder to topFolder
        end if

        set actionState to "created"
        if exists album targetAlbumName of containerFolder then
            if not allowExisting then
                return "ERROR|Album '" & targetAlbumName & "' already exists under " & parentFolderName
            end if
            set targetAlbum to album targetAlbumName of containerFolder
            set actionState to "existing"
        else
            make new album named targetAlbumName at containerFolder
            set targetAlbum to album targetAlbumName of containerFolder
        end if

        set addedCount to 0
        set matchedCount to 0
        if (count of assetIds) > 0 then
            set existingIds to {}
            try
                repeat with exItem in (every media item of targetAlbum)
                    copy (id of exItem) to end of existingIds
                end repeat
            end try

            set assetsToAdd to {}
            repeat with anId in assetIds
                set matchedCount to matchedCount + 1
                set alreadyInAlbum to false
                repeat with exId in existingIds
                    if (exId as string) starts with (anId as string) then
                        set alreadyInAlbum to true
                        exit repeat
                    end if
                end repeat
                if not alreadyInAlbum then
                    try
                        set end of assetsToAdd to media item id (anId & "/L0/001")
                    on error
                        try
                            set foundItems to (media items whose id contains anId)
                            if (count of foundItems) > 0 then
                                set end of assetsToAdd to item 1 of foundItems
                            end if
                        end try
                    end try
                end if
            end repeat

            set addedCount to (count of assetsToAdd)
            if addedCount > 0 then
                add assetsToAdd to targetAlbum
            end if
        end if

        return actionState & "|" & (addedCount as string) & "|" & (matchedCount as string)
    end tell
end run
'''


def _allocate_synthetic_album_pk(cur: sqlite3.Cursor) -> int:
    row = cur.execute("SELECT COALESCE(MIN(album_pk), 0) FROM media_organizer_albums").fetchone()
    min_pk = int(row[0]) if row and row[0] is not None else 0
    return min(min_pk, -10000) - 1


def _insert_album_asset_row_if_missing(cur: sqlite3.Cursor, album_pk: int, aid: str) -> bool:
    """Insert an asset into media_organizer_album_assets with metadata and synced_at_utc if absent."""
    exists = cur.execute(
        "SELECT 1 FROM media_organizer_album_assets WHERE album_pk = ? AND asset_id = ? LIMIT 1",
        (album_pk, aid),
    ).fetchone()
    if exists:
        return False
    cur.execute(
        """
        INSERT INTO media_organizer_album_assets (album_pk, asset_id, original_filename, date_created_utc, synced_at_utc)
        SELECT ?, ?, a.original_filename, a.date_created_utc, datetime('now')
        FROM assets a
        WHERE a.asset_id = ?
        LIMIT 1
        """,
        (album_pk, aid, aid),
    )
    if cur.rowcount == 0:
        cur.execute(
            """
            INSERT INTO media_organizer_album_assets (album_pk, asset_id, synced_at_utc)
            VALUES (?, ?, datetime('now'))
            """,
            (album_pk, aid),
        )
    return True


@router.get("/memories/folders")
def query_memories_folders(
    scope: str = "moments",
    q: str = "",
    sort: str = "name",
    limit: int = 300,
):
    """Query existing folders/albums under Moments from the local media_organizer.db copy (no Apple Photos DB query)."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"connected": False, "error": "Media database unavailable", "items": []}

    scope_clean = (scope or "moments").strip().lower()
    query_clean = (q or "").strip().lower()
    sort_clean = (sort or "name").strip().lower()
    safe_limit = max(1, min(int(limit or 300), 1000))

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()

            has_table = cur.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_organizer_albums' LIMIT 1"
            ).fetchone()
            if not has_table:
                return {
                    "connected": True,
                    "source": "media_organizer.db (local copy)",
                    "synced_at_utc": None,
                    "scope": scope_clean,
                    "total": 0,
                    "scope_counts": {},
                    "items": [],
                }

            sync_row = cur.execute("SELECT MAX(synced_at_utc) FROM media_organizer_albums").fetchone()
            synced_at_utc = sync_row[0] if sync_row else None

            counts_row = cur.execute(
                """
                SELECT
                    SUM(CASE WHEN LOWER(COALESCE(parent_folder_name, '')) IN ('moments', 'memories', 'generic moments')
                              OR LOWER(full_path) LIKE 'media organizer on lacie/moments/%'
                              OR LOWER(full_path) LIKE 'media organizer on lacie/memories/%'
                              OR LOWER(full_path) LIKE 'media organizer on lacie/generic moments/%'
                        THEN 1 ELSE 0 END) AS moments_cnt,
                    SUM(CASE WHEN LOWER(COALESCE(parent_folder_name, '')) = 'curated' THEN 1 ELSE 0 END) AS curated_cnt,
                    SUM(CASE WHEN LOWER(COALESCE(parent_folder_name, '')) = 'tobecurated' THEN 1 ELSE 0 END) AS tbc_cnt,
                    SUM(CASE WHEN is_folder = 1 THEN 1 ELSE 0 END) AS folders_cnt,
                    COUNT(*) AS all_cnt
                FROM media_organizer_albums
                """
            ).fetchone()
            scope_counts = {
                "moments": int(counts_row[0] or 0) if counts_row else 0,
                "curated": int(counts_row[1] or 0) if counts_row else 0,
                "to_be_curated": int(counts_row[2] or 0) if counts_row else 0,
                "folders": int(counts_row[3] or 0) if counts_row else 0,
                "all": int(counts_row[4] or 0) if counts_row else 0,
            }

            where_clauses = []
            params: list = []
            if scope_clean == "moments":
                where_clauses.append(
                    "("
                    "LOWER(COALESCE(moa.parent_folder_name, '')) IN ('moments', 'memories', 'generic moments') "
                    "OR LOWER(moa.full_path) LIKE 'media organizer on lacie/moments/%' "
                    "OR LOWER(moa.full_path) LIKE 'media organizer on lacie/memories/%' "
                    "OR LOWER(moa.full_path) LIKE 'media organizer on lacie/generic moments/%'"
                    ")"
                )
            elif scope_clean == "curated":
                where_clauses.append(
                    "(LOWER(COALESCE(moa.parent_folder_name, '')) = 'curated' "
                    "OR LOWER(moa.full_path) LIKE 'media organizer on lacie/curated/%')"
                )
            elif scope_clean == "to_be_curated":
                where_clauses.append(
                    "(LOWER(COALESCE(moa.parent_folder_name, '')) = 'tobecurated' "
                    "OR LOWER(moa.full_path) LIKE 'media organizer on lacie/tobecurated/%')"
                )
            elif scope_clean == "folders":
                where_clauses.append("moa.is_folder = 1")

            if query_clean:
                like_pat = f"%{query_clean}%"
                where_clauses.append(
                    "(LOWER(moa.album_name) LIKE ? OR LOWER(moa.full_path) LIKE ? OR LOWER(COALESCE(moa.parent_folder_name, '')) LIKE ?)"
                )
                params.extend([like_pat, like_pat, like_pat])

            where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

            order_sql = "ORDER BY moa.is_folder DESC, LOWER(moa.album_name) ASC"
            if sort_clean == "assets":
                order_sql = "ORDER BY COALESCE(moa.asset_count, 0) DESC, LOWER(moa.album_name) ASC"
            elif sort_clean == "recent":
                order_sql = "ORDER BY moa.album_name DESC"

            count_sql = f"SELECT COUNT(*) FROM media_organizer_albums moa {where_sql}"
            total_matches = int(cur.execute(count_sql, params).fetchone()[0] or 0)

            sql = f"""
                SELECT
                    moa.album_pk,
                    moa.album_name,
                    moa.parent_folder_pk,
                    moa.parent_folder_name,
                    moa.full_path,
                    moa.is_folder,
                    moa.depth,
                    COALESCE(moa.asset_count, 0) AS asset_count,
                    moa.synced_at_utc,
                    cm.memory_stage,
                    COALESCE(cm.curated_count, 0) AS curated_count,
                    COALESCE(pub.pub_count, 0) AS published_count
                FROM media_organizer_albums moa
                LEFT JOIN curated_moments cm ON LOWER(cm.moment_name) = LOWER(moa.album_name)
                LEFT JOIN (
                    SELECT LOWER(moment_name) AS mname_lower, COUNT(DISTINCT asset_uuid) AS pub_count
                    FROM publications
                    GROUP BY LOWER(moment_name)
                ) pub ON pub.mname_lower = LOWER(moa.album_name)
                {where_sql}
                {order_sql}
                LIMIT ?
            """
            rows = cur.execute(sql, [*params, safe_limit]).fetchall()
            tag_status_by_lc, _ = _load_moment_tagging_status_map(cur)
            items = []
            for r in rows:
                t_info = None if bool(r[5]) else tag_status_by_lc.get((r[1] or "").strip().lower())
                items.append(
                    {
                        "album_pk": int(r[0]),
                        "album_name": r[1],
                        "parent_folder_pk": int(r[2]) if r[2] is not None else None,
                        "parent_folder_name": r[3] or "",
                        "full_path": r[4],
                        "is_folder": bool(r[5]),
                        "depth": int(r[6]),
                        "asset_count": int(r[7] or 0),
                        "synced_at_utc": r[8] or "",
                        "memory_stage": r[9] or None,
                        "curated_count": int(r[10] or 0),
                        "published_count": int(r[11] or 0),
                        "is_tagged": bool(t_info),
                        "paradigm_confirmed": bool(t_info and t_info.get("paradigm_confirmed")),
                        "tag_summary": (t_info or {}).get("tag_summary", ""),
                    }
                )

            return {
                "connected": True,
                "source": "media_organizer.db (local copy)",
                "synced_at_utc": synced_at_utc,
                "scope": scope_clean,
                "total": total_matches,
                "returned": len(items),
                "scope_counts": scope_counts,
                "items": items,
            }
        finally:
            conn.close()
    except Exception as e:
        return {"connected": False, "error": str(e), "items": []}


@router.post("/memories/create-moment")
def create_moment_via_applescript(req: CreateMomentRequest):
    """Call AppleScript to create (or populate) a Moment album under Media Organizer on LaCie and sync local media_organizer.db."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    moment_name = (req.moment_name or "").strip()
    parent_folder = (req.parent_folder or "Moments").strip() or "Moments"
    top_folder = "Media Organizer on LaCie"

    if not moment_name:
        return {"ok": False, "error": "Moment name is required"}
    if "/" in moment_name or "/" in parent_folder:
        return {"ok": False, "error": "Folder and Moment names cannot contain '/' characters"}

    clean_ids: list[str] = []
    seen: set[str] = set()
    for aid in (req.asset_ids or []):
        s = (aid or "").strip()
        if s and s not in seen:
            seen.add(s)
            clean_ids.append(s)

    # Execute AppleScript in safe chunks of up to 80 asset IDs
    batch_size = 80
    batches = [clean_ids[i : i + batch_size] for i in range(0, len(clean_ids), batch_size)] if clean_ids else [[]]
    action_state = "created"
    total_photos_added = 0

    for b_idx, chunk in enumerate(batches):
        allow_flag = "1" if (req.allow_existing or b_idx > 0) else "0"
        argv = [top_folder, parent_folder, moment_name, allow_flag, *chunk]
        try:
            proc = subprocess.run(
                ["osascript", "-", *argv],
                input=_MOMENTS_APPLESCRIPT,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except Exception as e:
            return {"ok": False, "error": f"Failed to run osascript: {e}"}

        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        if proc.returncode != 0:
            return {"ok": False, "error": stderr or stdout or f"AppleScript failed (exit {proc.returncode})"}
        if stdout.startswith("ERROR|"):
            return {"ok": False, "error": stdout.split("|", 1)[1]}

        parts = stdout.split("|")
        if b_idx == 0 and parts and parts[0]:
            action_state = parts[0]
        if len(parts) >= 2:
            try:
                total_photos_added += int(parts[1] or 0)
            except ValueError:
                pass

    full_path = f"{top_folder}/{moment_name}" if parent_folder == top_folder else f"{top_folder}/{parent_folder}/{moment_name}"

    # Immediately reflect creation & added assets in local media_organizer.db copy (no Photos.sqlite query)
    db_inserted_assets = 0
    db_updated_moments_col = 0
    album_pk_out = None
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            parent_pk = None
            depth = 2
            if parent_folder != top_folder:
                p_row = cur.execute(
                    """
                    SELECT album_pk, depth FROM media_organizer_albums
                    WHERE is_folder = 1
                      AND LOWER(album_name) = LOWER(?)
                      AND LOWER(full_path) LIKE 'media organizer on lacie%'
                    ORDER BY depth ASC, album_pk ASC
                    LIMIT 1
                    """,
                    (parent_folder,),
                ).fetchone()
                if p_row:
                    parent_pk = int(p_row[0])
                    depth = int(p_row[1] or 2) + 1
                else:
                    top_row = cur.execute(
                        "SELECT album_pk FROM media_organizer_albums WHERE is_folder = 1 AND LOWER(album_name) = LOWER(?) LIMIT 1",
                        (top_folder,),
                    ).fetchone()
                    top_pk = int(top_row[0]) if top_row else None
                    parent_pk = _allocate_synthetic_album_pk(cur)
                    cur.execute(
                        """
                        INSERT INTO media_organizer_albums
                            (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
                        VALUES (?, ?, ?, ?, ?, 1, 2, 4000, 0, datetime('now'))
                        """,
                        (parent_pk, parent_folder, top_pk, top_folder, f"{top_folder}/{parent_folder}"),
                    )
                    depth = 3

            alb_row = cur.execute(
                """
                SELECT album_pk, full_path FROM media_organizer_albums
                WHERE is_folder = 0
                  AND (
                      LOWER(full_path) = LOWER(?)
                      OR (LOWER(album_name) = LOWER(?) AND LOWER(COALESCE(parent_folder_name, '')) = LOWER(?))
                  )
                LIMIT 1
                """,
                (full_path, moment_name, parent_folder),
            ).fetchone()

            if alb_row:
                album_pk_out = int(alb_row[0])
                full_path = alb_row[1] or full_path
            else:
                album_pk_out = _allocate_synthetic_album_pk(cur)
                cur.execute(
                    """
                    INSERT INTO media_organizer_albums
                        (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
                    VALUES (?, ?, ?, ?, ?, 0, ?, 2, 0, datetime('now'))
                    """,
                    (album_pk_out, moment_name, parent_pk, parent_folder, full_path, depth),
                )

            if clean_ids:
                for aid in clean_ids:
                    if _insert_album_asset_row_if_missing(cur, album_pk_out, aid):
                        db_inserted_assets += 1

                cur.execute(
                    """
                    UPDATE media_organizer_albums
                    SET asset_count = (SELECT COUNT(*) FROM media_organizer_album_assets WHERE album_pk = ?),
                        synced_at_utc = datetime('now')
                    WHERE album_pk = ?
                    """,
                    (album_pk_out, album_pk_out),
                )

            if parent_folder.lower() in ("moments", "memories", "curated", "tobecurated", "generic moments"):
                mom_exists = cur.execute(
                    """
                    SELECT 1 FROM moments
                    WHERE album_pk = ?
                       OR (LOWER(album_name) = LOWER(?) AND LOWER(COALESCE(parent_folder_name, '')) = LOWER(?))
                    LIMIT 1
                    """,
                    (album_pk_out, moment_name, parent_folder),
                ).fetchone()
                if not mom_exists:
                    cur.execute(
                        "INSERT INTO moments (album_pk, album_name, parent_folder_pk, parent_folder_name) VALUES (?, ?, ?, ?)",
                        (album_pk_out, moment_name, parent_pk, parent_folder),
                    )

            if clean_ids and parent_folder.lower() in ("moments", "curated", "tobecurated", "generic moments"):
                placeholders = ",".join("?" for _ in clean_ids)
                cur.execute(
                    f"""
                    UPDATE assets
                    SET MomentsAlbumName = ?, updated_at_utc = datetime('now')
                    WHERE asset_id IN ({placeholders})
                      AND (MomentsAlbumName IS NULL OR TRIM(MomentsAlbumName) = '')
                    """,
                    [moment_name, *clean_ids],
                )
                db_updated_moments_col = cur.rowcount or 0

            if action_state == "created":
                _reset_new_folder_curated_moment_stage(
                    cur,
                    moment_name,
                    parent_folder,
                    asset_count=len(clean_ids),
                    force=True,
                )

            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        return {
            "ok": True,
            "action": action_state,
            "moment_name": moment_name,
            "parent_folder": parent_folder,
            "full_path": full_path,
            "requested_assets": len(clean_ids),
            "photos_added": total_photos_added,
            "db_error": str(e),
        }

    ignored_photos_added = 0
    ignored_db_updated = 0
    clean_ignore_ids = []
    seen_ignore = set(clean_ids)
    for aid in (req.ignore_asset_ids or []):
        s = (aid or "").strip()
        if s and s not in seen_ignore:
            seen_ignore.add(s)
            clean_ignore_ids.append(s)

    if clean_ignore_ids:
        python_bin, script_path = _get_pipeline_python_and_dedup_script()
        if script_path.exists():
            try:
                proc_ign = subprocess.run(
                    [python_bin, str(script_path), "--apply", "--json", "--asset-ids", *clean_ignore_ids],
                    cwd=str(REPOS["media-organizer-pipeline"]),
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if proc_ign.returncode == 0 and proc_ign.stdout.strip():
                    ign_data = json.loads(proc_ign.stdout)
                    ignored_photos_added = int(ign_data.get("photos_added") or 0)
                    ignored_db_updated = int(ign_data.get("db_updated") or 0)
            except Exception:
                pass

    # Keep pHash duplicate cache warm for remaining unassigned items (just drop processed IDs)
    if _intake_dedup_cache["dup_ids"]:
        _intake_dedup_cache["dup_ids"] -= set(clean_ids) | set(clean_ignore_ids)

    return {
        "ok": True,
        "action": action_state,
        "album_pk": album_pk_out,
        "moment_name": moment_name,
        "parent_folder": parent_folder,
        "full_path": full_path,
        "requested_assets": len(clean_ids),
        "photos_added": total_photos_added,
        "db_inserted_assets": db_inserted_assets,
        "db_updated_assets": db_updated_moments_col,
        "ignored_photos_added": ignored_photos_added,
        "ignored_db_updated": ignored_db_updated,
    }


class PublishMomentRequest(BaseModel):
    moment_name: str
    asset_ids: list[str]
    shutterfly_url: Optional[str] = None
    youtube_url: Optional[str] = None
    account: Optional[str] = "nickolay.cohen@gmail.com"
    custom_platform: Optional[str] = None


class OpenCuratedFolderRequest(BaseModel):
    moment_name: str
    folder_kind: Optional[str] = "pub_rec"  # "pub_rec" | "curated"


class SyncPublishingRecRequest(BaseModel):
    moment_name: Optional[str] = None


def _get_curated_asset_rows_for_moment(cur: sqlite3.Cursor, moment_name: str):
    """Return curated assets (asset_id, original_filename, score_normalized, is_published) for a Moment."""
    cur.execute(
        """
        SELECT DISTINCT moaa.asset_id
        FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE LOWER(moa.album_name) IN ('ignore', 'skippublishing', 'topscore excluded')
        """
    )
    excluded_aids = {r[0] for r in cur.fetchall()}

    cur.execute(
        """
        SELECT DISTINCT moaa.asset_id
        FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE moa.full_path LIKE 'Media Organizer on LaCie/Curated/%'
        """
    )
    all_curated_album_aids = {r[0] for r in cur.fetchall()}

    cur.execute("SELECT DISTINCT asset_uuid FROM publications WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))", (moment_name,))
    moment_pub_aids = {r[0] for r in cur.fetchall()}
    cur.execute(
        """
        SELECT DISTINCT p.asset_uuid
        FROM publications p
        LEFT JOIN curated_moments cm
          ON TRIM(LOWER(cm.moment_name)) = TRIM(LOWER(p.moment_name))
        WHERE LOWER(COALESCE(cm.memory_stage, '')) != 'deleted'
        """
    )
    all_pub_aids = {r[0] for r in cur.fetchall()}

    cur.execute("SELECT MIN(threshold_score) FROM threshold_history WHERE threshold_score > 0.0")
    min_row = cur.fetchone()
    hist_min_raw = float(min_row[0]) if min_row and min_row[0] else 0.5315

    # Match the same curated set used in _compute_mode_m_from_db
    by_aid: dict[str, tuple[str, str, float]] = {}
    cur.execute(
        """
        SELECT v.asset_id, COALESCE(v.original_filename, a.original_filename, ''), v.score_normalized
        FROM ranked_assets_view v
        JOIN month_batches mb ON v.month = mb.month
        LEFT JOIN assets a ON a.asset_id = v.asset_id
        WHERE mb.status_code >= '600'
          AND TRIM(COALESCE(v.MomentsAlbumName, '')) = TRIM(?)
          AND v.score_normalized > ?
        """,
        (moment_name, hist_min_raw),
    )
    for aid, fn, sc in cur.fetchall():
        if aid in excluded_aids or aid not in all_curated_album_aids:
            continue
        by_aid[aid] = (aid, fn or "", float(sc or 0.0))

    # Also include rows recorded directly in moment_exports (curation_stage='curated') if missing above
    cur.execute(
        """
        SELECT me.asset_id, COALESCE(v.original_filename, a.original_filename, ''), COALESCE(v.score_normalized, 0.0)
        FROM moment_exports me
        LEFT JOIN ranked_assets_view v ON me.asset_id = v.asset_id
        LEFT JOIN assets a ON me.asset_id = a.asset_id
        WHERE TRIM(me.album_name) = TRIM(?) AND me.curation_stage = 'curated'
        """,
        (moment_name,),
    )
    for aid, fn, sc in cur.fetchall():
        if aid in excluded_aids or aid in by_aid:
            continue
        by_aid[aid] = (aid, fn or "", float(sc or 0.0))

    rows = []
    for aid, fn, sc in by_aid.values():
        is_pub = (aid in moment_pub_aids) or (aid in all_pub_aids)
        rows.append((aid, fn, sc, is_pub))

    rows.sort(key=lambda x: (-x[2], os.path.splitext(x[1])[0].lower(), x[0]))
    return rows, moment_pub_aids


def _sync_publishing_recommendation_for_moment(cur: sqlite3.Cursor, moment_name: str) -> dict:
    """Sync /Volumes/LaCie/Media Organizer/Publishing Recommendation/<moment> from Curated/<moment> matching CLI logic."""
    src_dir = CURATED_LACIE_DIR / moment_name
    dest_dir = PUBLISHING_RECOMMENDATION_DIR / moment_name

    if not PUBLISHING_RECOMMENDATION_DIR.parent.exists():
        return {
            "synced": False,
            "reason": "LaCie volume unavailable",
            "pub_rec_dir": str(dest_dir),
            "pub_rec_dir_exists": dest_dir.exists(),
            "copied": 0,
            "removed": 0,
            "expected_files": [],
        }

    rows, _ = _get_curated_asset_rows_for_moment(cur, moment_name)
    unpublished_rows = [(aid, fn, sc) for aid, fn, sc, is_pub in rows if not is_pub]
    top_batch = unpublished_rows[:9]

    if not top_batch or len(rows) < 2:
        removed_folder = False
        if dest_dir.exists() and dest_dir.is_dir():
            try:
                shutil.rmtree(dest_dir)
                removed_folder = True
            except Exception:
                pass
        return {
            "synced": True,
            "removed_folder": removed_folder,
            "pub_rec_dir": str(dest_dir),
            "pub_rec_dir_exists": dest_dir.exists(),
            "copied": 0,
            "removed": 0,
            "expected_files": [],
        }

    base_to_files: dict[str, list[str]] = {}
    if src_dir.exists() and src_dir.is_dir():
        try:
            for entry in os.listdir(src_dir):
                if not entry.startswith(".") and (src_dir / entry).is_file():
                    b = os.path.splitext(entry)[0].lower()
                    base_to_files.setdefault(b, []).append(entry)
        except Exception:
            pass

    proposed_files: list[str] = []
    for _aid, fn, _sc in top_batch:
        if fn:
            b = os.path.splitext(fn)[0].lower()
            proposed_files.extend(base_to_files.get(b, []))

    cur.execute(
        "SELECT filename FROM publications WHERE TRIM(moment_name) = TRIM(?)",
        (moment_name,),
    )
    published_files: list[str] = []
    for (p_fn,) in cur.fetchall():
        if p_fn:
            b = os.path.splitext(p_fn)[0].lower()
            published_files.extend(base_to_files.get(b, []))

    seen_files: set[str] = set()
    sync_files: list[str] = []
    for f in published_files + proposed_files:
        if f not in seen_files:
            seen_files.add(f)
            sync_files.append(f)

    if not sync_files:
        return {
            "synced": False,
            "reason": "Curated source files not exported on LaCie yet",
            "pub_rec_dir": str(dest_dir),
            "pub_rec_dir_exists": dest_dir.exists(),
            "copied": 0,
            "removed": 0,
            "expected_files": [],
        }

    PUBLISHING_RECOMMENDATION_DIR.mkdir(parents=True, exist_ok=True)
    dest_dir.mkdir(parents=True, exist_ok=True)

    removed_cnt = 0
    try:
        for f in os.listdir(dest_dir):
            if f.startswith("."):
                continue
            fp = dest_dir / f
            if fp.is_file() and f not in seen_files:
                fp.unlink()
                removed_cnt += 1
    except Exception:
        pass

    copied_cnt = 0
    for f in sync_files:
        src_f = src_dir / f
        dst_f = dest_dir / f
        if src_f.exists() and not dst_f.exists():
            shutil.copy2(src_f, dst_f)
            copied_cnt += 1

    return {
        "synced": True,
        "pub_rec_dir": str(dest_dir),
        "pub_rec_dir_exists": dest_dir.exists(),
        "copied": copied_cnt,
        "removed": removed_cnt,
        "expected_files": sync_files,
        "proposed_count": len(proposed_files),
        "published_count": len(published_files),
    }


@router.get("/memories/publish-info")
def get_moment_publish_info(moment_name: str):
    """Return curated unpublished batch (top 9), existing URLs, and LaCie Curated / Publishing Recommendation status."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    m_name = (moment_name or "").strip()
    if not m_name:
        return {"ok": False, "error": "moment_name is required"}

    _ensure_published_url_schema()
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT memory_stage, shutterfly_url, youtube_url FROM curated_moments WHERE moment_name = ?",
                (m_name,),
            )
            cm_row = cur.fetchone()
            stage = (cm_row[0] if cm_row and cm_row[0] else "M400")
            sf_url = (cm_row[1] if cm_row and cm_row[1] else "") or ""
            yt_url = (cm_row[2] if cm_row and cm_row[2] else "") or ""

            sync_res = _sync_publishing_recommendation_for_moment(cur, m_name)

            rows, moment_pub_aids = _get_curated_asset_rows_for_moment(cur, m_name)
            curated_total = len(rows)
            unpublished_rows = [(aid, fn, sc) for aid, fn, sc, is_pub in rows if not is_pub]
            top_batch = unpublished_rows[:9]

            moment_dir = CURATED_LACIE_DIR / m_name
            dir_exists = moment_dir.exists() and moment_dir.is_dir()
            local_by_base: dict[str, list[str]] = {}
            if dir_exists:
                try:
                    for entry in os.listdir(moment_dir):
                        if not entry.startswith(".") and (moment_dir / entry).is_file():
                            b = os.path.splitext(entry)[0].lower()
                            local_by_base.setdefault(b, []).append(entry)
                except Exception:
                    pass

            assets_out = []
            for aid, fn, sc in top_batch:
                ext = os.path.splitext(fn or "")[1].lower()
                base = os.path.splitext(fn or "")[0].lower()
                assets_out.append(
                    {
                        "asset_id": aid,
                        "filename": fn,
                        "score": round(sc, 4),
                        "media_type": "video" if ext in VIDEO_EXTENSIONS else "photo",
                        "local_files": local_by_base.get(base, []),
                    }
                )

            pub_rec_dir = PUBLISHING_RECOMMENDATION_DIR / m_name
            return {
                "ok": True,
                "moment_name": m_name,
                "memory_stage": stage,
                "shutterfly_url": sf_url,
                "youtube_url": yt_url,
                "curated_count": curated_total,
                "published_count": len(moment_pub_aids),
                "unpublished_count": len(unpublished_rows),
                "curated_dir": str(moment_dir),
                "curated_dir_exists": dir_exists,
                "pub_rec_dir": str(pub_rec_dir),
                "pub_rec_dir_exists": pub_rec_dir.exists() and pub_rec_dir.is_dir(),
                "pub_rec_sync": sync_res,
                "assets": assets_out,
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/memories/open-curated-folder")
def open_curated_moment_folder(req: OpenCuratedFolderRequest):
    """Open Publishing Recommendation or Curated Moment folder on LaCie in macOS Finder."""
    m_name = (req.moment_name or "").strip()
    kind = (req.folder_kind or "pub_rec").strip().lower()
    base_dir = CURATED_LACIE_DIR if kind == "curated" else PUBLISHING_RECOMMENDATION_DIR
    if not m_name:
        target = base_dir
    else:
        target = base_dir / m_name
        if not target.exists() and base_dir.exists():
            target = base_dir
    if not target.exists():
        return {"ok": False, "error": f"Folder not found: {target}"}
    try:
        subprocess.run(["open", str(target)], check=True)
        return {"ok": True, "opened": str(target)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/memories/sync-publishing-recommendations")
def sync_publishing_recommendations(req: SyncPublishingRecRequest):
    """Sync Publishing Recommendation folder(s) on LaCie from Curated exports (matching CLI behavior)."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    if not PUBLISHING_RECOMMENDATION_DIR.parent.exists():
        return {"ok": False, "error": "LaCie volume is not mounted"}

    m_name = (req.moment_name or "").strip()
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=20)
        try:
            cur = conn.cursor()
            if m_name:
                res = _sync_publishing_recommendation_for_moment(cur, m_name)
                return {"ok": True, "mode": "single", "moment_name": m_name, **res}

            # Full sync across all actionable/pending curated moments
            cur.execute("SELECT MIN(threshold_score) FROM threshold_history WHERE threshold_score > 0.0")
            min_row = cur.fetchone()
            db_hist_min = float(min_row[0]) if min_row and min_row[0] else 0.5315
            mode_m_live = _compute_mode_m_from_db(cur, db_hist_min, None)

            active_names: set[str] = set()
            total_copied = 0
            total_removed = 0
            for rec in mode_m_live.get("actionable_recs", []):
                mn = rec.get("moment_name")
                if not mn:
                    continue
                res = _sync_publishing_recommendation_for_moment(cur, mn)
                if res.get("expected_files"):
                    active_names.add(mn)
                total_copied += int(res.get("copied") or 0)
                total_removed += int(res.get("removed") or 0)

            deleted_folders = 0
            if PUBLISHING_RECOMMENDATION_DIR.exists():
                for entry in os.listdir(PUBLISHING_RECOMMENDATION_DIR):
                    ep = PUBLISHING_RECOMMENDATION_DIR / entry
                    if ep.is_dir() and not entry.startswith(".") and entry not in active_names:
                        shutil.rmtree(ep)
                        deleted_folders += 1

            return {
                "ok": True,
                "mode": "all",
                "active_folders": len(active_names),
                "copied": total_copied,
                "removed": total_removed,
                "deleted_folders": deleted_folders,
                "pub_rec_dir": str(PUBLISHING_RECOMMENDATION_DIR),
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/memories/publish")
def publish_moment_assets(req: PublishMomentRequest):
    """Record publication/republication of Moment assets in media_organizer.db (Shutterfly/YouTube + URLs)."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    m_name = (req.moment_name or "").strip()
    if not m_name:
        return {"ok": False, "error": "moment_name is required"}

    clean_ids = []
    seen = set()
    for raw_aid in req.asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen:
            seen.add(s)
            clean_ids.append(s)
    if not clean_ids:
        return {"ok": False, "error": "Select at least one asset to record publication"}

    _ensure_published_url_schema()
    account = (req.account or "nickolay.cohen@gmail.com").strip() or "nickolay.cohen@gmail.com"
    custom_plat = (req.custom_platform or "").strip() or None

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT shutterfly_url, youtube_url FROM curated_moments WHERE moment_name = ?",
                (m_name,),
            )
            cm_row = cur.fetchone()
            existing_sf = cm_row[0] if cm_row and cm_row[0] else None
            existing_yt = cm_row[1] if cm_row and cm_row[1] else None

            sf_url_val = (req.shutterfly_url or "").strip() or existing_sf
            yt_url_val = (req.youtube_url or "").strip() or existing_yt

            cur.execute("SELECT asset_uuid FROM publications WHERE moment_name = ?", (m_name,))
            already_published = {r[0] for r in cur.fetchall()}

            to_insert_ids = [aid for aid in clean_ids if aid not in already_published]
            skipped_count = len(clean_ids) - len(to_insert_ids)

            ph = ",".join("?" for _ in clean_ids)
            cur.execute(
                f"SELECT asset_id, COALESCE(original_filename, '') FROM assets WHERE asset_id IN ({ph})",
                clean_ids,
            )
            fn_map = {r[0]: (r[1] or "") for r in cur.fetchall()}

            pub_rows = []
            photos_cnt = 0
            videos_cnt = 0
            for aid in to_insert_ids:
                fn = fn_map.get(aid, "")
                ext = os.path.splitext(fn)[1].lower()
                is_video = ext in VIDEO_EXTENSIONS
                if custom_plat:
                    platform = custom_plat
                    pub_url = sf_url_val if "shutterfly" in custom_plat.lower() else (yt_url_val if "youtube" in custom_plat.lower() else (sf_url_val or yt_url_val))
                elif is_video:
                    platform = "YouTube"
                    pub_url = yt_url_val
                    videos_cnt += 1
                else:
                    platform = "Shutterfly"
                    pub_url = sf_url_val
                    photos_cnt += 1
                pub_rows.append((aid, fn, m_name, platform, account, pub_url))

            if pub_rows:
                cur.executemany(
                    """
                    INSERT INTO publications (asset_uuid, filename, moment_name, platform, account, published_url, published_at_utc)
                    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                    """,
                    pub_rows,
                )

            curated_rows, _ = _get_curated_asset_rows_for_moment(cur, m_name)
            curated_total = len(curated_rows)
            total_pub_after = len(already_published) + len(pub_rows)
            new_stage = (
                "M500"
                if (curated_total > 0 and total_pub_after >= curated_total)
                else ("M450" if total_pub_after > 0 else "M400")
            )

            cur.execute(
                """
                INSERT INTO curated_moments (moment_name, memory_stage, shutterfly_url, youtube_url)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(moment_name) DO UPDATE SET
                    memory_stage = excluded.memory_stage,
                    shutterfly_url = COALESCE(excluded.shutterfly_url, curated_moments.shutterfly_url),
                    youtube_url = COALESCE(excluded.youtube_url, curated_moments.youtube_url)
                """,
                (m_name, new_stage, sf_url_val, yt_url_val),
            )

            if sf_url_val:
                cur.execute(
                    """
                    UPDATE publications SET published_url = ?
                    WHERE moment_name = ? AND LOWER(COALESCE(platform, '')) LIKE '%shutterfly%'
                    """,
                    (sf_url_val, m_name),
                )
            if yt_url_val:
                cur.execute(
                    """
                    UPDATE publications SET published_url = ?
                    WHERE moment_name = ? AND LOWER(COALESCE(platform, '')) LIKE '%youtube%'
                    """,
                    (yt_url_val, m_name),
                )

            conn.commit()
            pub_rec_sync = _sync_publishing_recommendation_for_moment(cur, m_name)
            return {
                "ok": True,
                "moment_name": m_name,
                "inserted_count": len(pub_rows),
                "skipped_count": skipped_count,
                "photos_count": photos_cnt,
                "videos_count": videos_cnt,
                "total_published": total_pub_after,
                "curated_total": curated_total,
                "new_stage": new_stage,
                "shutterfly_url": sf_url_val or "",
                "youtube_url": yt_url_val or "",
                "pub_rec_sync": pub_rec_sync,
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


class SaveMomentTagItem(BaseModel):
    category: str
    tag_value: str
    include_in_name: bool = True


class MomentAssetTagGroup(BaseModel):
    moment_name: str
    asset_ids: list[str] = []
    tags: list[SaveMomentTagItem] = []


class DisjointDetailPostRequest(BaseModel):
    moment_name: str
    suggested_target: str = ""
    asset_ids: list[str] = []


class ResolveDisjointRequest(BaseModel):
    source_moment: str
    action: str  # "merge" | "skip_publishing" | "ignore"
    target_moment: Optional[str] = None
    target_parent_folder: str = "Moments"
    asset_ids: list[str] = []
    additional_moments: list[str] = []
    additional_asset_ids: list[str] = []
    unselected_asset_ids: list[str] = []
    unselected_action: str = "none"  # "ignore" | "skip_publishing" | "none"
    apply_tags: list[SaveMomentTagItem] = []
    moment_tag_groups: list[MomentAssetTagGroup] = []
    delete_source_albums: bool = True
    is_unassigned_cluster: bool = False


class CurateMomentRequest(BaseModel):
    source_moment: str
    target_moment: str
    selected_asset_ids: list[str] = []
    additional_moments: list[str] = []
    additional_asset_ids: list[str] = []
    unselected_asset_ids: list[str] = []
    unselected_action: str = "ignore"  # "ignore" | "skip_publishing" | "none"
    delete_tbc_album: bool = True
    export_to_lacie: bool = True
    apply_tags: list[SaveMomentTagItem] = []
    moment_tag_groups: list[MomentAssetTagGroup] = []


_CURATE_M200_APPLESCRIPT = r'''
on run argv
    set topFolderName to item 1 of argv
    set targetAlbumName to item 2 of argv
    set srcMomentName to item 3 of argv
    set deleteTbc to (item 4 of argv) is "1"
    set extraMomentCount to (item 5 of argv) as integer
    set extraMomentNames to {}
    if extraMomentCount > 0 then
        set extraMomentNames to items 6 thru (5 + extraMomentCount) of argv
    end if
    set extraAssetCount to (item (6 + extraMomentCount) of argv) as integer
    set extraAssetIds to {}
    if extraAssetCount > 0 then
        set extraAssetIds to items (7 + extraMomentCount) thru (6 + extraMomentCount + extraAssetCount) of argv
    end if
    set curatedStartIdx to 7 + extraMomentCount + extraAssetCount
    set assetIds to {}
    if (count of argv) >= curatedStartIdx then
        set assetIds to items curatedStartIdx thru (count of argv) of argv
    end if

    tell application "Photos"
        if not (exists folder topFolderName) then
            make new folder named topFolderName
        end if
        set topFolder to folder topFolderName

        if not (exists folder "Curated" of topFolder) then
            make new folder named "Curated" at topFolder
        end if
        set curatedFolder to folder "Curated" of topFolder

        set targetAction to "created"
        if exists album targetAlbumName of curatedFolder then
            set curatedAlbum to album targetAlbumName of curatedFolder
            set targetAction to "existing"
        else
            make new album named targetAlbumName at curatedFolder
            set curatedAlbum to album targetAlbumName of curatedFolder
        end if

        set curatedExistingIds to {}
        try
            repeat with exItem in (every media item of curatedAlbum)
                copy (id of exItem) to end of curatedExistingIds
            end repeat
        end try

        set addCurated to {}
        repeat with anId in assetIds
            set matchedItem to missing value
            try
                set matchedItem to media item id (anId & "/L0/001")
            on error
                try
                    set foundItems to (media items whose id contains anId)
                    if (count of foundItems) > 0 then
                        set matchedItem to item 1 of foundItems
                    end if
                end try
            end try
            if matchedItem is not missing value then
                set mIdStr to (id of matchedItem) as string
                set inCurated to false
                repeat with exId in curatedExistingIds
                    if (exId as string) is mIdStr then
                        set inCurated to true
                        exit repeat
                    end if
                end repeat
                if not inCurated then
                    copy matchedItem to end of addCurated
                    copy mIdStr to end of curatedExistingIds
                end if
            end if
        end repeat

        set addedCurated to (count of addCurated)
        if addedCurated > 0 then
            add addCurated to curatedAlbum
        end if

        -- Only touch Moments/<target> if extra Moments were consolidated into the kept original name
        if (count of extraAssetIds) > 0 then
            if not (exists folder "Moments" of topFolder) then
                make new folder named "Moments" at topFolder
            end if
            set momentsFolder to folder "Moments" of topFolder
            if exists album targetAlbumName of momentsFolder then
                set momentsAlbum to album targetAlbumName of momentsFolder
            else
                make new album named targetAlbumName at momentsFolder
                set momentsAlbum to album targetAlbumName of momentsFolder
            end if
            set momentsExistingIds to {}
            try
                repeat with exItem in (every media item of momentsAlbum)
                    copy (id of exItem) to end of momentsExistingIds
                end repeat
            end try
            set addMoments to {}
            repeat with exAid in extraAssetIds
                set matchedExtra to missing value
                try
                    set matchedExtra to media item id (exAid & "/L0/001")
                on error
                    try
                        set foundEx to (media items whose id contains exAid)
                        if (count of foundEx) > 0 then
                            set matchedExtra to item 1 of foundEx
                        end if
                    end try
                end try
                if matchedExtra is not missing value then
                    set exIdStr to (id of matchedExtra) as string
                    set alreadyInMoments to false
                    repeat with mExId in momentsExistingIds
                        if (mExId as string) is exIdStr then
                            set alreadyInMoments to true
                            exit repeat
                        end if
                    end repeat
                    if not alreadyInMoments then
                        copy matchedExtra to end of addMoments
                        copy exIdStr to end of momentsExistingIds
                    end if
                end if
            end repeat
            if (count of addMoments) > 0 then
                add addMoments to momentsAlbum
            end if
        end if

        set deletedCount to 0
        if deleteTbc and (exists folder "ToBeCurated" of topFolder) then
            set tbcFolder to folder "ToBeCurated" of topFolder
            if srcMomentName is not "" and (exists album srcMomentName of tbcFolder) then
                try
                    delete album id (id of album srcMomentName of tbcFolder)
                    set deletedCount to deletedCount + 1
                end try
            end if
        end if

        if (count of extraMomentNames) > 0 then
            repeat with extraName in extraMomentNames
                set exNameStr to extraName as string
                if exNameStr is not "" and exNameStr is not targetAlbumName then
                    repeat with fName in {"Moments", "Curated", "ToBeCurated", "Generic Moments"}
                        if exists folder (fName as string) of topFolder then
                            set subF to folder (fName as string) of topFolder
                            if exists album exNameStr of subF then
                                set oldAlb to album exNameStr of subF
                                if (id of oldAlb) is not (id of curatedAlbum) then
                                    try
                                        delete album id (id of oldAlb)
                                        set deletedCount to deletedCount + 1
                                    end try
                                end if
                            end if
                        end if
                    end repeat
                end if
            end repeat
        end if

        return targetAction & "|" & (addedCurated as string) & "|" & (deletedCount as string)
    end tell
end run
'''


_MERGE_DISJOINT_APPLESCRIPT = r'''
on run argv
    set topFolderName to item 1 of argv
    set targetParentName to item 2 of argv
    set targetAlbumName to item 3 of argv
    set deleteSource to (item 4 of argv) is "1"
    set srcCount to (item 5 of argv) as integer
    set srcAlbumNames to {}
    if srcCount > 0 then
        set srcAlbumNames to items 6 thru (5 + srcCount) of argv
    end if
    set assetIds to {}
    if (count of argv) > (5 + srcCount) then
        set assetIds to items (6 + srcCount) thru (count of argv) of argv
    end if

    tell application "Photos"
        if not (exists folder topFolderName) then
            make new folder named topFolderName
        end if
        set topFolder to folder topFolderName

        if targetParentName is not "" and targetParentName is not topFolderName then
            if not (exists folder targetParentName of topFolder) then
                make new folder named targetParentName at topFolder
            end if
            set targetParent to folder targetParentName of topFolder
        else
            set targetParent to topFolder
        end if

        set targetAction to "created"
        if exists album targetAlbumName of targetParent then
            set targetAlbum to album targetAlbumName of targetParent
            set targetAction to "existing"
        else
            make new album named targetAlbumName at targetParent
            set targetAlbum to album targetAlbumName of targetParent
        end if

        set existingIds to {}
        try
            repeat with exItem in (every media item of targetAlbum)
                copy (id of exItem) to end of existingIds
            end repeat
        end try

        set itemsToAdd to {}
        set candidateItems to {}
        set sourceFolders to {}
        set folderNamesToCheck to {"Moments", "Curated", "ToBeCurated", "Generic Moments"}
        repeat with fName in folderNamesToCheck
            if exists folder (fName as string) of topFolder then
                copy (folder (fName as string) of topFolder) to end of sourceFolders
            end if
        end repeat

        if (count of assetIds) is 0 then
            repeat with sName in srcAlbumNames
                set srcAlbStr to sName as string
                repeat with subF in sourceFolders
                    if exists album srcAlbStr of subF then
                        set srcAlb to album srcAlbStr of subF
                        try
                            repeat with mIt in (every media item of srcAlb)
                                copy mIt to end of candidateItems
                            end repeat
                        end try
                    end if
                end repeat
            end repeat
        else
            repeat with anId in assetIds
                try
                    set mItem to media item id (anId & "/L0/001")
                    copy mItem to end of candidateItems
                on error
                    try
                        set foundItems to (media items whose id contains anId)
                        if (count of foundItems) > 0 then
                            copy (item 1 of foundItems) to end of candidateItems
                        end if
                    end try
                end try
            end repeat
        end if

        repeat with cand in candidateItems
            set candId to (id of cand) as string
            set alreadyInTarget to false
            repeat with exId in existingIds
                if (exId as string) is candId then
                    set alreadyInTarget to true
                    exit repeat
                end if
            end repeat
            if not alreadyInTarget then
                copy cand to end of itemsToAdd
                copy candId to end of existingIds
            end if
        end repeat

        set addedCount to (count of itemsToAdd)
        if addedCount > 0 then
            add itemsToAdd to targetAlbum
        end if

        set deletedCount to 0
        if deleteSource then
            repeat with sName in srcAlbumNames
                set srcAlbStr to sName as string
                repeat with subF in sourceFolders
                    if exists album srcAlbStr of subF then
                        set srcAlb to album srcAlbStr of subF
                        if (id of srcAlb) is not (id of targetAlbum) then
                            try
                                delete album id (id of srcAlb)
                                set deletedCount to deletedCount + 1
                            end try
                        end if
                    end if
                end repeat
            end repeat
        end if

        return targetAction & "|" & (addedCount as string) & "|" & (deletedCount as string)
    end tell
end run
'''


def _reset_new_folder_curated_moment_stage(
    cur: sqlite3.Cursor,
    target_moment: str,
    target_parent: str,
    asset_count: int = 0,
    force: bool = False,
) -> str:
    """Set or reset curated_moments.memory_stage so a newly created folder starts cleanly in Mode [M]."""
    parent_lc = (target_parent or "Moments").strip().lower()
    if parent_lc == "tobecurated":
        new_stage = "M200"
        tbc_cnt, cur_cnt, tbc_ex, cur_ex = int(asset_count or 0), 0, 1, 0
    elif parent_lc == "curated":
        new_stage = "M300"
        tbc_cnt, cur_cnt, tbc_ex, cur_ex = 0, int(asset_count or 0), 0, 1
    else:
        new_stage = "M100"
        tbc_cnt, cur_cnt, tbc_ex, cur_ex = 0, 0, 0, 0

    existing_rows = cur.execute(
        "SELECT moment_name, COALESCE(memory_stage, '') FROM curated_moments WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))",
        (target_moment,),
    ).fetchall()
    if existing_rows:
        if force or all((st or "").strip().lower() in ("", "deleted") for _, st in existing_rows):
            cur.execute(
                """
                UPDATE curated_moments
                SET memory_stage = ?,
                    to_be_curated_count = ?,
                    curated_count = ?,
                    photos_to_be_curated_exists = ?,
                    photos_curated_exists = ?,
                    last_pipeline_sync = datetime('now')
                WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                """,
                (new_stage, tbc_cnt, cur_cnt, tbc_ex, cur_ex, target_moment),
            )
            return new_stage
        return (existing_rows[0][1] or new_stage)

    cur.execute(
        """
        INSERT INTO curated_moments (
            moment_name, to_be_curated_count, curated_count, memory_stage,
            last_pipeline_sync, photos_to_be_curated_exists, photos_curated_exists
        ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
        """,
        (target_moment, tbc_cnt, cur_cnt, new_stage, tbc_ex, cur_ex),
    )
    return new_stage


def _delete_source_albums_from_db(cur: sqlite3.Cursor, source_moment: str) -> None:
    """Remove obsolete album & folder entries for a deleted/consolidated Moment and mark curated_moments as 'Deleted'."""
    alb_rows = cur.execute(
        """
        SELECT album_pk FROM media_organizer_albums
        WHERE is_folder = 0
          AND TRIM(LOWER(album_name)) = TRIM(LOWER(?))
          AND (
            LOWER(COALESCE(parent_folder_name, '')) IN ('moments', 'curated', 'tobecurated', 'generic moments')
            OR LOWER(COALESCE(full_path, '')) LIKE 'media organizer on lacie/moments/%'
          )
        """,
        (source_moment,),
    ).fetchall()
    pks = [int(r[0]) for r in alb_rows]
    if pks:
        ph = ",".join("?" for _ in pks)
        cur.execute(f"DELETE FROM media_organizer_album_assets WHERE album_pk IN ({ph})", pks)
        cur.execute(f"DELETE FROM media_organizer_albums WHERE album_pk IN ({ph})", pks)
    cur.execute("DELETE FROM moments WHERE TRIM(LOWER(album_name)) = TRIM(LOWER(?))", (source_moment,))
    cur.execute("DELETE FROM moment_exports WHERE TRIM(LOWER(album_name)) = TRIM(LOWER(?))", (source_moment,))

    # Soft-mark old folder as 'Deleted' in curated_moments (Option A: preserve publications audit trail & URLs)
    cm_exists = cur.execute(
        "SELECT 1 FROM curated_moments WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) LIMIT 1",
        (source_moment,),
    ).fetchone()
    if cm_exists:
        cur.execute(
            """
            UPDATE curated_moments
            SET memory_stage = 'Deleted',
                to_be_curated_count = 0,
                curated_count = 0,
                photos_to_be_curated_exists = 0,
                photos_curated_exists = 0,
                last_pipeline_sync = datetime('now')
            WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
            """,
            (source_moment,),
        )
    else:
        pub_exists = cur.execute(
            "SELECT 1 FROM publications WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) LIMIT 1",
            (source_moment,),
        ).fetchone()
        if pub_exists:
            cur.execute(
                """
                INSERT INTO curated_moments (
                    moment_name, to_be_curated_count, curated_count, memory_stage,
                    last_pipeline_sync, photos_to_be_curated_exists, photos_curated_exists
                ) VALUES (?, 0, 0, 'Deleted', datetime('now'), 0, 0)
                """,
                (source_moment,),
            )

    for folder in (PUBLISHING_RECOMMENDATION_DIR / source_moment, CURATED_LACIE_DIR / source_moment):
        if folder.exists() and folder.is_dir():
            try:
                shutil.rmtree(folder)
            except Exception:
                pass


def _load_photos_moment_metadata(asset_ids: list[str]) -> dict:
    """Load ZMOMENT locations and ZPERSON named faces from the unlocked Photos.sqlite replica."""
    info: dict = {"moments": [], "people": []}
    if not asset_ids:
        return info
    replica_candidates = [
        Path("/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite"),
        Path("/Volumes/Macintosh HD/Users/nickolaycohen/Photos Library DB/All-Media-Extreme/database/Photos.sqlite"),
    ]
    replica_path = next((p for p in replica_candidates if p.exists()), None)
    if not replica_path:
        return info

    moment_counts: dict[str, int] = {}
    people_counts: dict[str, int] = {}
    try:
        rconn = sqlite3.connect(f"file:{replica_path}?mode=ro&immutable=1", uri=True, timeout=3)
        try:
            rcur = rconn.cursor()
            chunk_size = 450
            for i in range(0, len(asset_ids), chunk_size):
                chunk = asset_ids[i:i + chunk_size]
                ph = ",".join("?" for _ in chunk)
                rcur.execute(
                    f"""
                    SELECT m.ZTITLE, m.ZSUBTITLE, COUNT(*)
                    FROM ZASSET a
                    JOIN ZMOMENT m ON a.ZMOMENT = m.Z_PK
                    WHERE a.ZUUID IN ({ph})
                    GROUP BY m.ZTITLE, m.ZSUBTITLE
                    """,
                    chunk,
                )
                for title, subtitle, cnt in rcur.fetchall():
                    parts = [p.replace("\xa0", " ").strip() for p in (title, subtitle) if p and p.replace("\xa0", " ").strip()]
                    if parts:
                        label = " - ".join(parts)
                        moment_counts[label] = moment_counts.get(label, 0) + int(cnt or 1)

                rcur.execute(
                    f"""
                    SELECT
                        COALESCE(NULLIF(TRIM(p.ZFULLNAME), ''), NULLIF(TRIM(p.ZDISPLAYNAME), '')) AS pname,
                        COUNT(DISTINCT a.ZUUID) AS hits
                    FROM ZASSET a
                    JOIN ZDETECTEDFACE df ON df.ZASSETFORFACE = a.Z_PK
                    JOIN ZPERSON p ON COALESCE(df.ZPERSONFORFACE, df.ZPERSONFORTORSO, df.ZPERSONFORTEMPORALDETECTEDFACES) = p.Z_PK
                    WHERE a.ZUUID IN ({ph})
                      AND COALESCE(df.ZHIDDEN, 0) = 0
                      AND COALESCE(df.ZISINTRASH, 0) = 0
                    GROUP BY pname
                    HAVING pname IS NOT NULL AND pname != ''
                    """,
                    chunk,
                )
                for pname, hits in rcur.fetchall():
                    clean_name = re.sub(r"\s+", " ", (pname or "").strip())
                    if clean_name:
                        people_counts[clean_name] = people_counts.get(clean_name, 0) + int(hits or 1)
        finally:
            rconn.close()
    except Exception:
        pass

    info["moments"] = [
        {"label": k, "count": v}
        for k, v in sorted(moment_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    raw_people = [
        {"name": k, "count": v}
        for k, v in sorted(people_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    first_names: dict[str, int] = {}
    for p in raw_people:
        fn = p["name"].split()[0]
        first_names[fn.lower()] = first_names.get(fn.lower(), 0) + 1
    for p in raw_people:
        fn = p["name"].split()[0]
        p["short_name"] = fn if first_names.get(fn.lower(), 0) == 1 else p["name"]
    info["people"] = raw_people
    return info


_ACTIVITY_RULES: list[tuple[tuple[str, ...], str, str]] = [
    (("camelback", "blue mountain", "pico", "hunter", "killington", "stowe", "okemo", "ski", "snowboard", "snow"), "Skiing", "Skiing & Snow"),
    (("fishing", "manasquan outlet", "inlet", "charter boat"), "Ocean Fishing", "Fishing"),
    (("manasquan", "spring lake", "point pleasant", "asbury", "boardwalk", "jenkinson", "beach", "shore", "primorsko", "sozopol", "chanioti", "ocean grove"), "Beach & Coast", "Beach & Coast"),
    (("soccer", "futbol"), "Soccer", "Sports"),
    (("basketball",), "Basketball", "Sports"),
    (("karting", "go-kart"), "Go-Karting", "Activities"),
    (("waterfall", "rila", "lakes", "vitosha", "trigrad", "meteora", "trail", "hike", "hiking", "niagara"), "Hiking & Sightseeing", "Travel & Outdoors"),
    (("six flags",), "Amusement Park", "Trips & Parks"),
    (("lion king", "broadway", "concert", "show", "theater"), "Show & Outing", "Events & Shows"),
    (("bday", "birthday",), "Birthday Celebration", "Family & Celebrations"),
    (("shower",), "Baby Shower", "Family & Celebrations"),
    (("new year", "newyear", "christmas", "thanksgiving"), "Holiday Celebration", "Family & Celebrations"),
    (("nyc", "manhattan", "thessaloniki"), "City Exploration", "Travel & Outdoors"),
]


def _build_moment_name_suggestion(
    moment_name: str,
    assets_out: list[dict],
    qual_dates: list[datetime],
    photos_meta: dict,
) -> dict:
    """Synthesize a structured [Activity] [Location] [People] [When] suggestion and subfolder hint."""
    # Strip YYYY-MM-DD / YYYY-MM / YYYY prefix from legacy album or cluster name
    suffix = re.sub(r"^\d{4}(?:[-/\s]+(?:[A-Za-z]+|\d{2})(?:[-/\s]+\d{2})?)?\s*(?:[-–]\s*)?", "", moment_name).strip()
    if suffix.endswith(")") and "(" not in suffix:
        suffix = suffix[:-1].strip()
    if re.match(r"^uncategorized\b", suffix, re.IGNORECASE) or re.match(r"^\(\d{4}-\d{2}\)$", suffix):
        suffix = ""

    anchor_dt = qual_dates[len(qual_dates) // 2] if qual_dates else (_parse_utc_dt(assets_out[0]["date_created_utc"]) if assets_out else None)
    when_str = ""
    season_name = ""
    if anchor_dt:
        m = anchor_dt.month
        season_name = "Winter" if m in (12, 1, 2) else ("Spring" if m in (3, 4, 5) else ("Summer" if m in (6, 7, 8) else "Fall"))
        when_str = f"{season_name} {anchor_dt.year}"
    elif assets_out and assets_out[0].get("month"):
        when_str = str(assets_out[0]["month"])

    # Determine Activity cue from moment title & location keywords
    effective_name_for_search = "" if re.search(r"\buncategorized\b", moment_name, re.IGNORECASE) else moment_name
    search_blob = " ".join(
        [effective_name_for_search, suffix] + [str(pm.get("label") or "") for pm in (photos_meta.get("moments") or [])[:3]]
    ).lower()
    activity = ""
    for keywords, act_label, _sf_label in _ACTIVITY_RULES:
        if any(kw in search_blob for kw in keywords):
            activity = act_label
            break

    # Optional Family Member cues (computed before People so family names are not double-tagged in both)
    family_pool = ["Niki", "Milena", "Roberto", "Eva", "Benny"]
    family_map = {
        "niki": "Niki",
        "nickolay": "Niki",
        "nickolay c.": "Niki",
        "milena": "Milena",
        "roberto": "Roberto",
        "eva": "Eva",
        "benny": "Benny",
    }
    people_objs = photos_meta.get("people") or []
    detected_family: list[str] = []
    seen_fam: set[str] = set()
    for src_val in [
        *(p.get("short_name", "") for p in people_objs),
        *(p.get("name", "") for p in people_objs),
        *(a.get("primary_owner", "") for a in assets_out),
    ]:
        tok = (src_val or "").strip().lower()
        first_tok = tok.split()[0] if tok else ""
        mapped = family_map.get(tok) or family_map.get(first_tok)
        if mapped and mapped.lower() not in seen_fam:
            seen_fam.add(mapped.lower())
            detected_family.append(mapped)
    for k, canonical in family_map.items():
        if k in moment_name.lower() and canonical.lower() not in seen_fam:
            seen_fam.add(canonical.lower())
            detected_family.append(canonical)

    # People: non-family detected faces / companions (avoid duplicating Family Member pills)
    fam_tokens_lc = seen_fam | set(family_map.keys())
    non_family_people_objs = [
        p
        for p in people_objs
        if (p.get("short_name") or "").strip().lower() not in fam_tokens_lc
        and (p.get("name") or "").split()[0].strip().lower() not in fam_tokens_lc
    ]
    people_names = [p["short_name"] for p in non_family_people_objs if p.get("short_name")]
    if not people_names:
        owner_counts: dict[str, int] = {}
        for a in assets_out:
            own = (a.get("primary_owner") or "").strip()
            if own and own != "Shared/Other":
                short_own = own.split()[0]
                if short_own.lower() not in fam_tokens_lc:
                    owner_counts[short_own] = owner_counts.get(short_own, 0) + 1
        people_names = [k for k, _ in sorted(owner_counts.items(), key=lambda kv: -kv[1])]
    people_str = ", ".join(people_names[:3])

    # Location: prefer suffix if it looks like a venue/place rather than purely an event/person description
    zmoment_labels = [pm["label"] for pm in (photos_meta.get("moments") or []) if pm.get("label")]
    non_place_suffix = any(tok in suffix.lower() for tok in ("soccer player", "birthday", "bday", "baby shower", "graduation", "new year", "newyear"))
    location = ""
    if suffix and not non_place_suffix:
        location = suffix
    elif zmoment_labels:
        location = zmoment_labels[0]
    elif suffix:
        location = suffix

    if not activity:
        if assets_out and all(a.get("media_type") == "video" for a in assets_out):
            activity = "Video Clips"
        elif people_names:
            activity = "Family Outing"
        elif location:
            activity = "Day Trip"
        else:
            activity = "Moment"

    location_candidates: list[str] = []
    for cand in [suffix, *zmoment_labels]:
        c = (cand or "").strip()
        if c and c.lower() not in {x.lower() for x in location_candidates}:
            location_candidates.append(c)

    # Compose canonical readable label: [Activity] at [Location] with [People] - [When]
    parts: list[str] = []
    if activity:
        parts.append(activity)
    if location:
        parts.append(f"at {location}")
    if people_str:
        parts.append(f"with {people_str}")
    head = " ".join(parts).strip() or moment_name
    suggested_name = f"{head} - {when_str}" if when_str else head

    return {
        "activity": activity,
        "location": location,
        "people": people_str,
        "when": when_str,
        "family_members": detected_family,
        "family_member_pool": family_pool,
        "suggested_name": suggested_name,
        "location_candidates": location_candidates[:6],
        "people_candidates": non_family_people_objs[:8],
    }


def _dedup_moment_tags_table(cur: sqlite3.Cursor) -> int:
    """Remove duplicate (moment_name, asset_id, tag_value) rows across categories, preferring family_member over people."""
    rows = cur.execute(
        """
        SELECT id, TRIM(moment_name), COALESCE(asset_id, ''), LOWER(TRIM(category)), TRIM(tag_value), COALESCE(include_in_name, 0)
        FROM moment_tags
        ORDER BY id ASC
        """
    ).fetchall()
    groups: dict[tuple[str, str, str], list[tuple[int, str, int]]] = {}
    for row_id, m_name, aid, cat, _val, inc in rows:
        val_clean = re.sub(r"\s+", " ", _val or "").strip()
        key = ((m_name or "").lower(), aid or "", val_clean.lower())
        groups.setdefault(key, []).append((int(row_id), cat or "", int(inc or 0)))

    delete_ids: list[int] = []
    for _key, items in groups.items():
        if len(items) <= 1:
            continue
        # Prefer family_member > other specific categories > people, then higher id
        def _rank(item: tuple[int, str, int]) -> tuple[int, int]:
            rid, cat, _inc = item
            cat_score = 2 if cat == "family_member" else (0 if cat == "people" else 1)
            return (cat_score, rid)

        winner = max(items, key=_rank)
        for rid, _cat, _inc in items:
            if rid != winner[0]:
                delete_ids.append(rid)

    if delete_ids:
        ph = ",".join("?" for _ in delete_ids)
        cur.execute(f"DELETE FROM moment_tags WHERE id IN ({ph})", delete_ids)
    return len(delete_ids)


_TAG_CAT_DISPLAY = {
    "activity": "Activity",
    "location": "Location",
    "people": "People",
    "when": "When",
    "family_member": "Family Member",
}
_TAG_CAT_ORDER = ("activity", "location", "people", "when", "family_member")


def _build_tag_metadata_struct(
    tag_list: list[dict],
    session_id: Optional[int] = None,
    moment_name: str = "",
) -> dict:
    """Build canonical unified active metadata struct (only current active flags) for asset JSON storage & UI."""
    by_cat: dict[str, list[str]] = {}
    active_flags: list[dict] = []
    seen_vals: set[str] = set()
    for t in tag_list or []:
        cat = (t.get("category") or "").strip().lower()
        val = re.sub(r"\s+", " ", (t.get("tag_value") or "").strip())
        if cat not in _TAG_CAT_DISPLAY or not val:
            continue
        k = val.lower()
        if k in seen_vals:
            continue
        seen_vals.add(k)
        by_cat.setdefault(cat, []).append(val)
        active_flags.append(
            {
                "category": cat,
                "tag_value": val,
                "include_in_name": bool(t.get("include_in_name", True)),
            }
        )
    metadata: dict[str, object] = {}
    for cat in _TAG_CAT_ORDER:
        vals = by_cat.get(cat, [])
        if vals:
            disp = _TAG_CAT_DISPLAY[cat]
            metadata[disp] = vals[0] if len(vals) == 1 else vals
    return {
        "metadata": metadata,
        "active_tags": active_flags,
        "moment_name": moment_name,
        "session_id": session_id,
    }


def _format_metadata_summary_str(tag_list: list[dict]) -> str:
    """Format unified active metadata as {Activity: Skiing, Location: CamelBack, When: Winter 2020}."""
    struct = _build_tag_metadata_struct(tag_list)
    meta = struct.get("metadata") or {}
    parts: list[str] = []
    for k, v in meta.items():
        if isinstance(v, list):
            parts.append(f"{k}: [{', '.join(str(x) for x in v)}]")
        else:
            parts.append(f"{k}: {v}")
    return "{" + ", ".join(parts) + "}"


def _sync_asset_metadata_json(
    cur: sqlite3.Cursor,
    asset_id: str,
    moment_name: str,
    active_tags: list[dict],
    session_id: Optional[int],
) -> None:
    """Persist only current active tag flags into assets.tags_metadata_json for one asset."""
    if not asset_id:
        return
    payload = _build_tag_metadata_struct(active_tags, session_id=session_id, moment_name=moment_name)
    cur.execute(
        """
        UPDATE assets
        SET tags_metadata_json = ?, updated_at_utc = datetime('now')
        WHERE asset_id = ?
        """,
        (json.dumps(payload), asset_id),
    )


def _sync_moment_folder_metadata_json(
    cur: sqlite3.Cursor,
    moment_name: str,
    session_id: Optional[int],
    asset_ids_hint: Optional[list[str]] = None,
    extra_union_tags: Optional[list[dict]] = None,
    paradigm: str = "new_paradigm_v1",
) -> list[dict]:
    """Compute union of asset tags and persist Moment-level metadata + tagging_paradigm confirmation onto moments & media_organizer_albums."""
    m_name = (moment_name or "").strip()
    if not m_name:
        return []

    collected: list[dict] = []
    # 1. Active per-asset rows in moment_tags for this Moment
    cur.execute(
        """
        SELECT category, tag_value, include_in_name
        FROM moment_tags
        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
          AND asset_id != ''
        ORDER BY id ASC
        """,
        (m_name,),
    )
    for cat, val, inc in cur.fetchall():
        clean_v = re.sub(r"\s+", " ", (val or "").strip())
        clean_c = (cat or "").strip().lower()
        if clean_c in _TAG_CAT_DISPLAY and clean_v:
            collected.append({"category": clean_c, "tag_value": clean_v, "include_in_name": bool(inc)})

    # 2. Active tags inside assets.tags_metadata_json for assets in this Moment
    hint_ids = [s.strip() for s in (asset_ids_hint or []) if s and s.strip()]
    if hint_ids:
        ph = ",".join("?" for _ in hint_ids)
        cur.execute(
            f"""
            SELECT asset_id FROM assets
            WHERE TRIM(LOWER(COALESCE(MomentsAlbumName, ''))) = TRIM(LOWER(?))
               OR asset_id IN ({ph})
            """,
            [m_name, *hint_ids],
        )
    else:
        cur.execute(
            "SELECT asset_id FROM assets WHERE TRIM(LOWER(COALESCE(MomentsAlbumName, ''))) = TRIM(LOWER(?))",
            (m_name,),
        )
    for (aid,) in cur.fetchall():
        if aid:
            collected.extend(_read_asset_metadata_tags(cur, aid))

    # 3. Any additional incoming tags passed for this confirmation
    for t in extra_union_tags or []:
        clean_v = re.sub(r"\s+", " ", (t.get("tag_value") or "").strip())
        clean_c = (t.get("category") or "").strip().lower()
        if clean_c in _TAG_CAT_DISPLAY and clean_v:
            collected.append(
                {
                    "category": clean_c,
                    "tag_value": clean_v,
                    "include_in_name": bool(t.get("include_in_name", True)),
                }
            )

    # Fallback: include existing Moment-level moment_tags rows if no asset rows exist yet
    if not collected:
        cur.execute(
            """
            SELECT category, tag_value, include_in_name
            FROM moment_tags
            WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
              AND asset_id = ''
            ORDER BY id ASC
            """,
            (m_name,),
        )
        for cat, val, inc in cur.fetchall():
            clean_v = re.sub(r"\s+", " ", (val or "").strip())
            clean_c = (cat or "").strip().lower()
            if clean_c in _TAG_CAT_DISPLAY and clean_v:
                collected.append({"category": clean_c, "tag_value": clean_v, "include_in_name": bool(inc)})

    union_tags = _normalize_unique_moment_tags(collected)
    if not union_tags:
        return []

    # Refresh Moment-level summary rows (asset_id = '') cleanly with the exact asset union
    cur.execute(
        "DELETE FROM moment_tags WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) AND asset_id = ''",
        (m_name,),
    )
    for t in union_tags:
        cur.execute(
            """
            INSERT OR IGNORE INTO moment_tags (moment_name, asset_id, category, tag_value, include_in_name, session_id, updated_at_utc)
            VALUES (?, '', ?, ?, ?, ?, datetime('now'))
            """,
            (
                m_name,
                t["category"],
                t["tag_value"],
                1 if t["include_in_name"] else 0,
                session_id,
            ),
        )

    payload = _build_tag_metadata_struct(union_tags, session_id=session_id, moment_name=m_name)
    payload["scope"] = "moment"
    payload["tagging_paradigm"] = paradigm
    payload["asset_tag_union_count"] = len(union_tags)
    payload_json = json.dumps(payload)

    cur.execute(
        """
        UPDATE moments
        SET tags_metadata_json = ?,
            tagging_paradigm = ?,
            tagged_at_utc = datetime('now')
        WHERE TRIM(LOWER(album_name)) = TRIM(LOWER(?))
        """,
        (payload_json, paradigm, m_name),
    )
    cur.execute(
        """
        UPDATE media_organizer_albums
        SET tags_metadata_json = ?,
            tagging_paradigm = ?,
            tagged_at_utc = datetime('now')
        WHERE is_folder = 0
          AND TRIM(LOWER(album_name)) = TRIM(LOWER(?))
          AND LOWER(COALESCE(parent_folder_name, '')) IN ('moments', 'memories', 'curated', 'tobecurated', 'generic moments')
        """,
        (payload_json, paradigm, m_name),
    )
    return union_tags


def _load_moment_tagging_status_map(cur: sqlite3.Cursor) -> tuple[dict[str, dict], set[str]]:
    """Load per-Moment DB tagging & paradigm confirmation status plus tagged asset IDs."""
    status_by_lc: dict[str, dict] = {}
    tagged_aids: set[str] = set()
    existing_tables = {
        r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }

    def _entry(m_lc: str) -> dict:
        return status_by_lc.setdefault(
            m_lc,
            {
                "is_tagged": True,
                "paradigm_confirmed": False,
                "tags": [],
                "tag_summary": "",
            },
        )

    if "moment_tags" in existing_tables:
        seen_vals: dict[str, set[str]] = {}
        for m_lc, aid, cat, val, inc in cur.execute(
            """
            SELECT
                TRIM(LOWER(moment_name)),
                COALESCE(asset_id, ''),
                LOWER(TRIM(COALESCE(category, ''))),
                TRIM(COALESCE(tag_value, '')),
                COALESCE(include_in_name, 1)
            FROM moment_tags
            WHERE TRIM(COALESCE(moment_name, '')) != ''
            ORDER BY id ASC
            """
        ).fetchall():
            if m_lc:
                ent = _entry(m_lc)
                v_lc = val.lower()
                if val and cat in _TAG_CAT_DISPLAY and v_lc not in seen_vals.setdefault(m_lc, set()):
                    seen_vals[m_lc].add(v_lc)
                    ent["tags"].append({"category": cat, "tag_value": val, "include_in_name": bool(inc)})
            if aid:
                tagged_aids.add(aid)

    if "moment_tag_sessions" in existing_tables:
        for (m_lc,) in cur.execute(
            "SELECT DISTINCT TRIM(LOWER(moment_name)) FROM moment_tag_sessions WHERE TRIM(COALESCE(moment_name, '')) != ''"
        ).fetchall():
            if m_lc:
                _entry(m_lc)

    for tbl in ("moments", "media_organizer_albums"):
        if tbl in existing_tables:
            t_cols = {r[1] for r in cur.execute(f"PRAGMA table_info({tbl})").fetchall()}
            if "tagging_paradigm" in t_cols:
                for m_lc, par, raw_json in cur.execute(
                    f"""
                    SELECT DISTINCT
                        TRIM(LOWER(album_name)),
                        TRIM(COALESCE(tagging_paradigm, '')),
                        COALESCE(tags_metadata_json, '')
                    FROM {tbl}
                    WHERE TRIM(COALESCE(tagging_paradigm, '')) != ''
                       OR TRIM(COALESCE(tags_metadata_json, '')) != ''
                    """
                ).fetchall():
                    if m_lc:
                        ent = _entry(m_lc)
                        if par:
                            ent["paradigm_confirmed"] = True
                        if raw_json and not ent["tags"]:
                            try:
                                parsed = json.loads(raw_json)
                                for t in parsed.get("active_tags") or []:
                                    c = (t.get("category") or "").strip().lower()
                                    v = (t.get("tag_value") or "").strip()
                                    if c in _TAG_CAT_DISPLAY and v:
                                        ent["tags"].append(
                                            {"category": c, "tag_value": v, "include_in_name": bool(t.get("include_in_name", True))}
                                        )
                            except Exception:
                                pass

    a_cols = {r[1] for r in cur.execute("PRAGMA table_info(assets)").fetchall()}
    if "tags_metadata_json" in a_cols:
        for (aid,) in cur.execute(
            "SELECT asset_id FROM assets WHERE TRIM(COALESCE(tags_metadata_json, '')) != ''"
        ).fetchall():
            if aid:
                tagged_aids.add(aid)

    for ent in status_by_lc.values():
        if ent["tags"]:
            ent["tag_summary"] = _format_metadata_summary_str(ent["tags"])
    return status_by_lc, tagged_aids


def _read_asset_metadata_tags(cur: sqlite3.Cursor, asset_id: str) -> list[dict]:
    """Read active_tags list stored inside assets.tags_metadata_json for one asset."""
    if not asset_id:
        return []
    row = cur.execute("SELECT tags_metadata_json FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
    if not row or not row[0]:
        return []
    try:
        parsed = json.loads(row[0])
        raw_tags = parsed.get("active_tags") or []
        out: list[dict] = []
        for t in raw_tags:
            if not isinstance(t, dict):
                continue
            cat = (t.get("category") or "").strip().lower()
            val = re.sub(r"\s+", " ", (t.get("tag_value") or "").strip())
            if cat in _TAG_CAT_DISPLAY and val:
                out.append(
                    {
                        "category": cat,
                        "tag_value": val,
                        "include_in_name": bool(t.get("include_in_name", True)),
                    }
                )
        return out
    except Exception:
        return []


def _load_per_asset_tags_map(cur: sqlite3.Cursor, asset_ids: list[str]) -> dict[str, list[dict]]:
    """Return deduplicated individual DB tags mapped by asset_id (combining moment_tags rows and assets.tags_metadata_json)."""
    clean_ids = [s.strip() for s in asset_ids if s and s.strip()]
    if not clean_ids:
        return {}
    by_aid: dict[str, list[dict]] = {aid: [] for aid in clean_ids}
    seen_by_aid: dict[str, set[str]] = {aid: set() for aid in clean_ids}

    for off in range(0, len(clean_ids), 400):
        chunk = clean_ids[off : off + 400]
        ph = ",".join("?" for _ in chunk)
        for aid, cat, val, inc in cur.execute(
            f"""
            SELECT asset_id, category, tag_value, include_in_name
            FROM moment_tags
            WHERE asset_id IN ({ph})
            ORDER BY id ASC
            """,
            chunk,
        ).fetchall():
            c_norm = (cat or "").strip().lower()
            v_norm = re.sub(r"\s+", " ", (val or "").strip())
            if not aid or c_norm not in _TAG_CAT_DISPLAY or not v_norm:
                continue
            v_lc = v_norm.lower()
            if v_lc not in seen_by_aid[aid]:
                seen_by_aid[aid].add(v_lc)
                by_aid[aid].append({"category": c_norm, "tag_value": v_norm, "include_in_name": bool(inc)})

        for aid, raw_json in cur.execute(
            f"SELECT asset_id, tags_metadata_json FROM assets WHERE asset_id IN ({ph}) AND tags_metadata_json IS NOT NULL",
            chunk,
        ).fetchall():
            if not aid or not raw_json:
                continue
            try:
                parsed = json.loads(raw_json)
                for t in parsed.get("active_tags") or []:
                    if not isinstance(t, dict):
                        continue
                    c_norm = (t.get("category") or "").strip().lower()
                    v_norm = re.sub(r"\s+", " ", (t.get("tag_value") or "").strip())
                    if c_norm not in _TAG_CAT_DISPLAY or not v_norm:
                        continue
                    v_lc = v_norm.lower()
                    if v_lc not in seen_by_aid[aid]:
                        seen_by_aid[aid].add(v_lc)
                        by_aid[aid].append(
                            {
                                "category": c_norm,
                                "tag_value": v_norm,
                                "include_in_name": bool(t.get("include_in_name", True)),
                            }
                        )
            except Exception:
                pass
    return by_aid


@router.get("/asset-tags/{asset_id}")
def get_single_asset_tags(asset_id: str):
    """Return individual saved DB tags for a single asset (used when previewing assets in lightbox)."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "asset_id": asset_id, "tags": []}
    aid = (asset_id or "").strip()
    if not aid:
        return {"ok": False, "asset_id": aid, "tags": []}
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
        try:
            cur = conn.cursor()
            _ensure_moment_tag_tables(cur)
            tags_map = _load_per_asset_tags_map(cur, [aid])
            row = cur.execute("SELECT MomentsAlbumName FROM assets WHERE asset_id = ?", (aid,)).fetchone()
            return {
                "ok": True,
                "asset_id": aid,
                "moment_name": (row[0] or "") if row else "",
                "tags": tags_map.get(aid, []),
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "asset_id": aid, "tags": [], "error": str(e)}


def _backfill_assets_tags_metadata(cur: sqlite3.Cursor) -> int:
    """Populate assets.tags_metadata_json from active moment_tags for assets not yet initialized."""
    rows = cur.execute(
        """
        SELECT DISTINCT mt.asset_id, mt.moment_name, COALESCE(mt.session_id, 0)
        FROM moment_tags mt
        JOIN assets a ON a.asset_id = mt.asset_id
        WHERE mt.asset_id != ''
          AND (a.tags_metadata_json IS NULL OR TRIM(a.tags_metadata_json) = '')
        """
    ).fetchall()
    updated = 0
    for aid, m_name, sess_id in rows:
        tag_rows = cur.execute(
            """
            SELECT category, tag_value, include_in_name
            FROM moment_tags
            WHERE asset_id = ? AND TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
            ORDER BY id ASC
            """,
            (aid, m_name),
        ).fetchall()
        active_tags = [
            {
                "category": (c or "").strip().lower(),
                "tag_value": re.sub(r"\s+", " ", (v or "").strip()),
                "include_in_name": bool(inc),
            }
            for c, v, inc in tag_rows
            if (v or "").strip()
        ]
        _sync_asset_metadata_json(cur, aid, m_name, active_tags, int(sess_id) if sess_id else None)
        updated += 1
    return updated


def _ensure_moment_tag_tables(cur: sqlite3.Cursor) -> int:
    """Create Moment/Asset tagging and session history tables if not yet present; return duplicates removed if upgraded."""
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS moment_tag_sessions (
            session_id INTEGER PRIMARY KEY AUTOINCREMENT,
            moment_name TEXT NOT NULL,
            apply_to_folder_name INTEGER NOT NULL DEFAULT 0,
            composed_name TEXT,
            selected_tags_json TEXT,
            asset_count INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            created_at_utc TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS moment_tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moment_name TEXT NOT NULL,
            asset_id TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL,
            tag_value TEXT NOT NULL,
            include_in_name INTEGER NOT NULL DEFAULT 1,
            session_id INTEGER,
            updated_at_utc TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    removed_on_upgrade = 0
    has_val_idx = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_moment_tags_unique_val'"
    ).fetchone()
    if not has_val_idx:
        removed_on_upgrade = _dedup_moment_tags_table(cur)
        cur.execute("DROP INDEX IF EXISTS idx_moment_tags_unique")
    cur.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_tags_unique_val
        ON moment_tags(LOWER(moment_name), asset_id, LOWER(tag_value))
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_moment_tags_tagval
        ON moment_tags(LOWER(tag_value), LOWER(category))
        """
    )
    asset_cols = {r[1] for r in cur.execute("PRAGMA table_info(assets)").fetchall()}
    if "tags_metadata_json" not in asset_cols:
        cur.execute("ALTER TABLE assets ADD COLUMN tags_metadata_json TEXT")
    for tbl in ("moments", "media_organizer_albums"):
        tbl_cols = {r[1] for r in cur.execute(f"PRAGMA table_info({tbl})").fetchall()}
        if "tags_metadata_json" not in tbl_cols:
            cur.execute(f"ALTER TABLE {tbl} ADD COLUMN tags_metadata_json TEXT")
        if "tagging_paradigm" not in tbl_cols:
            cur.execute(f"ALTER TABLE {tbl} ADD COLUMN tagging_paradigm TEXT")
        if "tagged_at_utc" not in tbl_cols:
            cur.execute(f"ALTER TABLE {tbl} ADD COLUMN tagged_at_utc TEXT")
    _backfill_assets_tags_metadata(cur)
    return removed_on_upgrade


class SaveMomentTagsRequest(BaseModel):
    moment_name: str
    tags: list[SaveMomentTagItem] = []
    asset_ids: list[str] = []
    apply_to_folder_name: bool = False
    composed_name: Optional[str] = None
    notes: Optional[str] = None
    merge_existing: bool = True
    removed_tags: list[str] = []
    include_all_moment_assets: bool = False


def _moment_membership_where_sql(m_name: str) -> tuple[str, tuple[str, str, str, str]]:
    """Return shared SQL predicate and params matching active assets of a Moment across assets, albums, publications, and exports."""
    predicate = """(
        TRIM(LOWER(COALESCE(a.MomentsAlbumName, ''))) = TRIM(LOWER(?))
        OR a.asset_id IN (
            SELECT moaa.asset_id
            FROM media_organizer_album_assets moaa
            JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
            WHERE moa.is_folder = 0
              AND TRIM(LOWER(moa.album_name)) = TRIM(LOWER(?))
        )
        OR a.asset_id IN (
            SELECT asset_uuid FROM publications WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
        )
        OR a.asset_id IN (
            SELECT asset_id FROM moment_exports WHERE TRIM(LOWER(album_name)) = TRIM(LOWER(?))
        )
    )"""
    return predicate, (m_name, m_name, m_name, m_name)


def _collect_moment_asset_ids(cur: sqlite3.Cursor, m_name: str) -> list[str]:
    """Return all distinct active asset IDs belonging to a Moment across assets, albums, publications, and exports."""
    where_clause, query_params = _moment_membership_where_sql(m_name)
    cur.execute(
        f"""
        SELECT DISTINCT a.asset_id
        FROM assets a
        LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
        WHERE COALESCE(za.ZTRASHEDSTATE, 0) = 0
          AND COALESCE(a.removed_from_source, 0) = 0
          AND {where_clause}
        """,
        query_params,
    )
    return [r[0] for r in cur.fetchall() if r[0]]


def _tag_value_in_folder_name(tag_value: str, folder_name: str) -> bool:
    """Return True when tag_value appears as a distinct phrase/token inside folder_name."""
    val_clean = re.sub(r"\s+", " ", (tag_value or "").strip()).lower()
    folder_clean = re.sub(r"\s+", " ", (folder_name or "").strip()).lower()
    if not val_clean or not folder_clean:
        return False
    return re.search(rf"(?<!\w){re.escape(val_clean)}(?!\w)", folder_clean) is not None


def _reconcile_include_in_name_with_folder(
    tags: list[dict],
    folder_name: str,
    *,
    has_named_session: bool = False,
) -> list[dict]:
    """Align tag include_in_name flags with folder_name once a Moment has been named from its tags."""
    if not tags or not folder_name:
        return tags
    is_dated_legacy = bool(re.match(r"^\d{4}-\d{2}", folder_name.strip()))
    any_match = any(_tag_value_in_folder_name(t.get("tag_value") or "", folder_name) for t in tags)
    if not (has_named_session or (not is_dated_legacy and any_match)):
        return tags
    reconciled: list[dict] = []
    for t in tags:
        copy_t = dict(t)
        copy_t["include_in_name"] = _tag_value_in_folder_name(copy_t.get("tag_value") or "", folder_name)
        reconciled.append(copy_t)
    return reconciled


def _fetch_moment_summary_tag_rows(cur: sqlite3.Cursor, m_name: str) -> list[dict]:
    """Fetch per-tag summary rows for a Moment, preferring Moment-level summary (asset_id='') include_in_name flags."""
    cur.execute(
        """
        SELECT
            category,
            tag_value,
            COALESCE(
                MAX(CASE WHEN asset_id = '' THEN include_in_name ELSE NULL END),
                MAX(include_in_name)
            ) AS inc,
            COUNT(DISTINCT CASE WHEN asset_id != '' THEN asset_id END) AS asset_cnt
        FROM moment_tags
        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
        GROUP BY LOWER(tag_value)
        ORDER BY MIN(id) ASC
        """,
        (m_name,),
    )
    return [
        {
            "category": r[0],
            "tag_value": r[1],
            "include_in_name": bool(r[2]),
            "tagged_asset_count": int(r[3] or 0),
        }
        for r in cur.fetchall()
    ]


def _load_moment_detail_core(
    cur: sqlite3.Cursor,
    m_name: str,
    limit_assets: Optional[int] = None,
    explicit_asset_ids: Optional[list[str]] = None,
) -> dict:
    """Shared loader for Moment assets, Apple Photos metadata, name suggestions, saved DB tags, and session history."""
    _ensure_moment_tag_tables(cur)
    cur.execute("SELECT MIN(threshold_score) FROM threshold_history WHERE threshold_score > 0.0")
    min_row = cur.fetchone()
    hist_min_raw = float(min_row[0]) if min_row and min_row[0] else 0.5315

    cur.execute(
        """
        SELECT DISTINCT moaa.asset_id
        FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE LOWER(moa.album_name) IN ('ignore', 'skippublishing', 'topscore excluded')
        """
    )
    excluded_aids = {r[0] for r in cur.fetchall()}

    clean_explicit_ids: list[str] = []
    seen_exp: set[str] = set()
    for raw_aid in explicit_asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen_exp:
            seen_exp.add(s)
            clean_explicit_ids.append(s)

    limit_sql = f"LIMIT {int(limit_assets)}" if limit_assets else ""
    if clean_explicit_ids:
        ph_exp = ",".join("?" for _ in clean_explicit_ids)
        where_clause = f"a.asset_id IN ({ph_exp})"
        query_params: tuple = tuple(clean_explicit_ids)
    else:
        where_clause, query_params = _moment_membership_where_sql(m_name)

    cur.execute(
        f"""
        SELECT DISTINCT
            a.asset_id,
            COALESCE(v.original_filename, a.original_filename, ''),
            COALESCE(v.score_normalized, 0.0),
            COALESCE(v.date_created_utc, a.date_created_utc, ''),
            a.month,
            COALESCE(za.ZKIND, 0),
            ROUND(COALESCE(za.ZDURATION, ze.ZDURATION, 0.0), 2),
            COALESCE(aaa.ZORIGINALWIDTH, za.ZWIDTH, 0),
            COALESCE(aaa.ZORIGINALHEIGHT, za.ZHEIGHT, 0),
            COALESCE(aaa.ZORIGINALFILESIZE, 0),
            COALESCE(NULLIF(TRIM(a.resolved_camera_model), ''), ze.ZCAMERAMODEL, a.carrier_device, 'Unknown'),
            COALESCE(do.owner_name, 'Shared/Other')
        FROM assets a
        LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
        LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
        LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.Z_PK = za.ZADDITIONALATTRIBUTES
        LEFT JOIN ZEXTENDEDATTRIBUTES ze ON ze.Z_PK = za.ZEXTENDEDATTRIBUTES
        LEFT JOIN device_owners do ON do.camera_model = COALESCE(NULLIF(TRIM(a.resolved_camera_model), ''), ze.ZCAMERAMODEL, a.carrier_device)
            AND (do.start_date IS NULL OR do.start_date <= date(za.ZDATECREATED + 978307200, 'unixepoch'))
            AND (do.end_date IS NULL OR do.end_date >= date(za.ZDATECREATED + 978307200, 'unixepoch'))
        WHERE {where_clause}
          AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
          AND COALESCE(a.removed_from_source, 0) = 0
        ORDER BY COALESCE(v.score_normalized, 0.0) DESC, a.date_created_utc ASC
        {limit_sql}
        """,
        query_params,
    )
    raw_assets = cur.fetchall()
    assets_out = []
    qual_dates: list[datetime] = []
    for r in raw_assets:
        aid, fn, sc, dt_s, mo, zkind, dur, w, h, fbytes, cam, owner = r
        if aid in excluded_aids:
            continue
        is_qual = float(sc or 0.0) > hist_min_raw
        dt_obj = _parse_utc_dt(dt_s)
        if is_qual and dt_obj:
            qual_dates.append(dt_obj)
        assets_out.append(
            {
                "asset_id": aid,
                "original_filename": fn,
                "score_normalized": round(float(sc or 0.0), 4),
                "date_created_utc": (dt_s or "")[:19],
                "month": mo or "",
                "media_type": "video" if int(zkind or 0) == 1 else "photo",
                "duration": float(dur or 0.0),
                "width": int(w or 0),
                "height": int(h or 0),
                "file_size_bytes": int(fbytes or 0),
                "camera_model": cam or "Unknown",
                "primary_owner": owner or "Shared/Other",
                "qualified": is_qual,
            }
        )

    dup_map = _detect_duplicates_for_asset_list(
        cur.connection,
        cur,
        [a["asset_id"] for a in assets_out],
        hist_min_raw,
        excluded_aids,
    )
    for a_obj in assets_out:
        d_info = dup_map.get(a_obj["asset_id"])
        a_obj["is_duplicate_copy"] = bool(d_info)
        if d_info:
            a_obj["duplicate_keeper_id"] = d_info["duplicate_keeper_id"]
            a_obj["duplicate_keeper_filename"] = d_info["duplicate_keeper_filename"]
            a_obj["duplicate_keeper_moment"] = d_info["duplicate_keeper_moment"]
            a_obj["duplicate_match_tier"] = d_info["duplicate_match_tier"]
            a_obj["duplicate_similarity_pct"] = d_info["duplicate_similarity_pct"]

    per_asset_tags = _load_per_asset_tags_map(cur, [a["asset_id"] for a in assets_out])
    for a_obj in assets_out:
        a_obj["asset_tags"] = per_asset_tags.get(a_obj["asset_id"], [])

    cur.execute(
        """
        SELECT parent_folder_name, asset_count, full_path
        FROM media_organizer_albums
        WHERE is_folder = 0 AND TRIM(LOWER(album_name)) = TRIM(LOWER(?))
          AND LOWER(COALESCE(parent_folder_name, '')) IN ('moments', 'curated', 'tobecurated', 'generic moments')
        """,
        (m_name,),
    )
    albums_present = [
        {"parent": r[0], "asset_count": int(r[1] or 0), "full_path": r[2]}
        for r in cur.fetchall()
    ]

    photos_meta = _load_photos_moment_metadata([a["asset_id"] for a in assets_out])
    name_suggestion = _build_moment_name_suggestion(m_name, assets_out, qual_dates, photos_meta)

    row_saved_tags = _fetch_moment_summary_tag_rows(cur, m_name)

    cur.execute(
        """
        SELECT session_id, moment_name, apply_to_folder_name, composed_name, selected_tags_json, asset_count, created_at_utc
        FROM moment_tag_sessions
        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
        ORDER BY session_id DESC
        LIMIT 1
        """,
        (m_name,),
    )
    sess_row = cur.fetchone()
    sess_inc_by_val: dict[str, bool] = {}
    parsed_sess_tags: list[dict] = []
    if sess_row and sess_row[4]:
        try:
            parsed = json.loads(sess_row[4])
            if isinstance(parsed, list) and parsed:
                parsed_sess_tags = parsed
                for st in parsed:
                    if isinstance(st, dict) and st.get("tag_value"):
                        sess_inc_by_val[str(st["tag_value"]).strip().lower()] = bool(st.get("include_in_name", True))
        except Exception:
            pass

    # Merge any active flags persisted in assets.tags_metadata_json with active moment_tags rows
    asset_meta_tags: list[dict] = []
    for a_obj in assets_out:
        asset_meta_tags.extend(_read_asset_metadata_tags(cur, a_obj.get("asset_id") or ""))
    merged_tags, _ = _merge_tag_lists(asset_meta_tags, row_saved_tags, set())
    cnt_by_val = {t["tag_value"].lower(): t["tagged_asset_count"] for t in row_saved_tags}
    row_inc_by_val = {t["tag_value"].lower(): bool(t.get("include_in_name", True)) for t in row_saved_tags}
    saved_tags = [
        {
            "category": t["category"],
            "tag_value": t["tag_value"],
            "include_in_name": row_inc_by_val.get(
                t["tag_value"].lower(),
                sess_inc_by_val.get(t["tag_value"].lower(), bool(t.get("include_in_name", True))),
            ),
            "tagged_asset_count": cnt_by_val.get(t["tag_value"].lower(), 1 if asset_meta_tags else 0),
        }
        for t in merged_tags
    ]
    has_named_session = bool(sess_row and bool(sess_row[2]))
    folder_ref = (sess_row[3] or "").strip() if (sess_row and sess_row[2] and (sess_row[3] or "").strip()) else m_name
    saved_tags = _reconcile_include_in_name_with_folder(
        saved_tags,
        folder_ref or m_name,
        has_named_session=has_named_session,
    )
    sess_tags_for_summary: list[dict] = parsed_sess_tags or saved_tags
    metadata_struct = _build_tag_metadata_struct(
        saved_tags,
        session_id=int(sess_row[0]) if sess_row else None,
        moment_name=m_name,
    )
    metadata_summary = _format_metadata_summary_str(saved_tags)
    last_tag_session = (
        {
            "session_id": int(sess_row[0]),
            "moment_name": sess_row[1],
            "apply_to_folder_name": bool(sess_row[2]),
            "composed_name": sess_row[3] or "",
            "asset_count": int(sess_row[5] or 0),
            "created_at_utc": sess_row[6] or "",
            "metadata_summary": _format_metadata_summary_str(sess_tags_for_summary) or metadata_summary,
        }
        if sess_row
        else None
    )

    tag_db_counts = _compute_tag_db_counts(cur)
    tag_catalog_by_category = _compute_tag_catalog_by_category(cur)
    return {
        "historical_min": hist_min_raw,
        "assets_out": assets_out,
        "qual_dates": qual_dates,
        "albums_present": albums_present,
        "name_suggestion": name_suggestion,
        "saved_tags": saved_tags,
        "last_tag_session": last_tag_session,
        "tag_db_counts": tag_db_counts,
        "tag_catalog_by_category": tag_catalog_by_category,
        "metadata_summary": metadata_summary,
        "metadata_struct": metadata_struct,
    }


def _get_disjoint_moment_detail_impl(
    moment_name: str,
    suggested_target: str = "",
    explicit_asset_ids: Optional[list[str]] = None,
) -> dict:
    """Return full asset metadata, album locations, DB tags, and chronological merge candidates for a Moment or unassigned group."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    m_name = (moment_name or "").strip()
    if not m_name:
        return {"ok": False, "error": "moment_name is required"}

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
        try:
            cur = conn.cursor()
            core = _load_moment_detail_core(cur, m_name, explicit_asset_ids=explicit_asset_ids)
            hist_min_raw = core["historical_min"]
            assets_out = core["assets_out"]
            qual_dates = core["qual_dates"]
            albums_present = core["albums_present"]
            name_suggestion = core["name_suggestion"]
            saved_tags = core["saved_tags"]
            last_tag_session = core["last_tag_session"]
            tag_db_counts = core["tag_db_counts"]
            conn.commit()

            # Build nearby multi-asset merge candidates
            cur.execute(
                """
                SELECT
                    TRIM(v.MomentsAlbumName) as m_alb,
                    COUNT(*) as qual_cnt,
                    MIN(v.date_created_utc) as min_dt,
                    MAX(v.date_created_utc) as max_dt
                FROM ranked_assets_view v
                JOIN month_batches mb ON v.month = mb.month
                WHERE mb.status_code >= '600'
                  AND v.MomentsAlbumName IS NOT NULL AND TRIM(v.MomentsAlbumName) != ''
                  AND TRIM(v.MomentsAlbumName) != TRIM(?)
                  AND LOWER(v.MomentsAlbumName) NOT IN ('ignore', 'skippublishing', 'topscore excluded')
                  AND v.score_normalized > ?
                GROUP BY TRIM(v.MomentsAlbumName)
                HAVING COUNT(*) >= 2
                """,
                (m_name, hist_min_raw),
            )
            anchor_dt = qual_dates[0] if qual_dates else (_parse_utc_dt(assets_out[0]["date_created_utc"]) if assets_out else None)
            nearby_candidates = []
            for cand_name, qual_cnt, min_dt_s, max_dt_s in cur.fetchall():
                d_min = _parse_utc_dt(min_dt_s)
                d_max = _parse_utc_dt(max_dt_s)
                days_diff = None
                rel_label = ""
                if anchor_dt and d_min and d_max:
                    mid_ts = (d_min.timestamp() + d_max.timestamp()) / 2.0
                    diff_d = (mid_ts - anchor_dt.timestamp()) / 86400.0
                    days_diff = abs(diff_d)
                    d_int = round(abs(diff_d))
                    rel_label = f"+{d_int}d" if diff_d > 0 else (f"-{d_int}d" if diff_d < 0 else "0d")
                nearby_candidates.append(
                    {
                        "moment_name": cand_name,
                        "qualified_count": int(qual_cnt or 0),
                        "rel_label": rel_label,
                        "is_suggested": bool(suggested_target and cand_name.lower() == suggested_target.lower()),
                        "_sort_diff": days_diff if days_diff is not None else 999999.0,
                    }
                )
            nearby_candidates.sort(key=lambda x: (0 if x["is_suggested"] else 1, x["_sort_diff"], -x["qualified_count"]))
            for x in nearby_candidates:
                x.pop("_sort_diff", None)

            existing_album_rows = cur.execute(
                """
                SELECT TRIM(album_name), TRIM(COALESCE(parent_folder_name, 'Moments')), COALESCE(asset_count, 0)
                FROM media_organizer_albums
                WHERE is_folder = 0
                  AND TRIM(COALESCE(album_name, '')) != ''
                  AND LOWER(COALESCE(parent_folder_name, '')) IN ('moments', 'generic moments', 'curated', 'tobecurated')
                """
            ).fetchall()
            existing_albums = [
                {
                    "album_name": r[0],
                    "parent_folder_name": r[1],
                    "asset_count": int(r[2] or 0),
                }
                for r in existing_album_rows
            ]

            return {
                "ok": True,
                "moment_name": m_name,
                "historical_min": round(hist_min_raw, 4),
                "suggested_target": suggested_target,
                "assets": assets_out,
                "albums_present": albums_present,
                "name_suggestion": name_suggestion,
                "saved_tags": saved_tags,
                "last_tag_session": last_tag_session,
                "tag_db_counts": tag_db_counts,
                "tag_catalog_by_category": core["tag_catalog_by_category"],
                "metadata_summary": core["metadata_summary"],
                "metadata_struct": core["metadata_struct"],
                "existing_albums": existing_albums,
                "nearby_candidates": nearby_candidates[:10],
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/memories/disjoint-detail")
def get_disjoint_moment_detail(moment_name: str, suggested_target: str = ""):
    """Return full asset metadata, album locations, DB tags, and chronological merge candidates for a Moment."""
    return _get_disjoint_moment_detail_impl(moment_name, suggested_target)


@router.post("/memories/disjoint-detail")
def get_disjoint_moment_detail_post(req: DisjointDetailPostRequest):
    """Return tagging/consolidation metadata for an explicit list of unassigned cluster assets."""
    return _get_disjoint_moment_detail_impl(req.moment_name, req.suggested_target, req.asset_ids)


_VALID_MOMENT_TAG_CATS = {"activity", "location", "people", "when", "family_member"}


def _normalize_unique_moment_tags(items: list) -> list[dict]:
    """Deduplicate tags by normalized value (and category) so an asset/Moment is never double-tagged with the same tag."""
    by_val_lc: dict[str, dict] = {}
    ordered_keys: list[str] = []
    for t in items or []:
        if isinstance(t, dict):
            raw_cat = t.get("category")
            raw_val = t.get("tag_value")
            inc = bool(t.get("include_in_name", True))
        else:
            raw_cat = t.category
            raw_val = t.tag_value
            inc = bool(t.include_in_name)
        cat = (raw_cat or "").strip().lower()
        val = re.sub(r"\s+", " ", (raw_val or "").strip())
        if cat not in _VALID_MOMENT_TAG_CATS or not val:
            continue
        k = val.lower()
        if k not in by_val_lc:
            by_val_lc[k] = {"category": cat, "tag_value": val, "include_in_name": inc}
            ordered_keys.append(k)
        else:
            existing = by_val_lc[k]
            # Prefer family_member over people if same name was provided in both; keep include_in_name if either is checked
            if cat == "family_member" and existing["category"] == "people":
                existing["category"] = "family_member"
            existing["include_in_name"] = existing["include_in_name"] or inc
    return [by_val_lc[k] for k in ordered_keys]


def _compute_tag_db_counts(cur: sqlite3.Cursor) -> dict:
    """Return exact distinct tagged asset & moment counts per lowercase tag value."""
    cur.execute(
        """
        SELECT
            LOWER(tag_value) AS tv,
            COUNT(DISTINCT CASE WHEN asset_id != '' THEN asset_id END) AS assets_cnt,
            COUNT(DISTINCT LOWER(moment_name)) AS moments_cnt
        FROM moment_tags
        GROUP BY LOWER(tag_value)
        """
    )
    return {
        r[0]: {"assets": int(r[1] or 0), "moments": int(r[2] or 0)}
        for r in cur.fetchall()
        if r[0]
    }


def _compute_tag_catalog_by_category(cur: sqlite3.Cursor) -> dict[str, list[dict]]:
    """Return all applied DB tags grouped by category, ordered by Moment & asset frequency."""
    by_cat_lc: dict[str, dict[str, dict]] = {}
    cur.execute(
        """
        SELECT
            LOWER(TRIM(category)) AS cat,
            MIN(TRIM(tag_value)) AS tag_val,
            COUNT(DISTINCT CASE WHEN asset_id != '' THEN asset_id END) AS assets_cnt,
            COUNT(DISTINCT LOWER(moment_name)) AS moments_cnt
        FROM moment_tags
        WHERE TRIM(COALESCE(category, '')) != ''
          AND TRIM(COALESCE(tag_value, '')) != ''
        GROUP BY LOWER(TRIM(category)), LOWER(TRIM(tag_value))
        ORDER BY moments_cnt DESC, assets_cnt DESC, LOWER(TRIM(tag_value)) ASC
        """
    )
    for cat, val, acnt, mcnt in cur.fetchall():
        c_key = cat or "activity"
        bucket = by_cat_lc.setdefault(c_key, {})
        bucket[val.lower()] = {
            "tag_value": val,
            "assets": int(acnt or 0),
            "moments": int(mcnt or 0),
        }
    return {c_key: list(items.values()) for c_key, items in by_cat_lc.items()}


def _merge_tag_lists(existing_tags: list[dict], incoming_tags: list[dict], removed_lc: set[str]) -> tuple[list[dict], int]:
    """Merge existing DB tags with incoming UI tags, letting incoming win on category/include_in_name."""
    merged_by_val: dict[str, dict] = {}
    ordered_keys: list[str] = []
    preserved_existing = 0
    incoming_keys = {t["tag_value"].lower() for t in incoming_tags}

    for et in existing_tags:
        k = (et.get("tag_value") or "").strip().lower()
        if not k or k in removed_lc:
            continue
        if k not in merged_by_val:
            merged_by_val[k] = {
                "category": et["category"],
                "tag_value": et["tag_value"],
                "include_in_name": bool(et.get("include_in_name", True)),
            }
            ordered_keys.append(k)
            if k not in incoming_keys:
                preserved_existing += 1

    for nt in incoming_tags:
        k = nt["tag_value"].lower()
        merged_by_val[k] = {
            "category": nt["category"],
            "tag_value": nt["tag_value"],
            "include_in_name": bool(nt.get("include_in_name", True)),
        }
        if k not in ordered_keys:
            ordered_keys.append(k)

    return [merged_by_val[k] for k in ordered_keys], preserved_existing


@router.post("/memories/tags/dedup")
def dedup_moment_tags_endpoint():
    """Deduplicate moment_tags rows across categories and enforce unique tag values per Moment/asset."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            removed_schema = _ensure_moment_tag_tables(cur)
            removed = removed_schema + _dedup_moment_tags_table(cur)
            remaining = cur.execute("SELECT COUNT(*) FROM moment_tags").fetchone()[0]
            conn.commit()
            return {"ok": True, "removed_duplicates": int(removed), "remaining_rows": int(remaining or 0)}
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/memories/tags/save")
def save_moment_tags(req: SaveMomentTagsRequest):
    """Record Moment/asset tags & tagging session in media_organizer.db, merging existing + new DB tags."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    m_name = (req.moment_name or "").strip()
    if not m_name:
        return {"ok": False, "error": "moment_name is required"}

    clean_tags = _normalize_unique_moment_tags(req.tags or [])
    incoming_lc = {t["tag_value"].lower() for t in clean_tags}
    removed_lc = {
        re.sub(r"\s+", " ", (rt or "").strip()).lower()
        for rt in (req.removed_tags or [])
        if (rt or "").strip()
    } - incoming_lc

    clean_aids: list[str] = []
    seen_aids: set[str] = set()
    for raw_id in req.asset_ids or []:
        s = (raw_id or "").strip()
        if s and s not in seen_aids:
            seen_aids.add(s)
            clean_aids.append(s)

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            _ensure_moment_tag_tables(cur)

            if not clean_aids or req.include_all_moment_assets:
                for aid in _collect_moment_asset_ids(cur, m_name):
                    if aid and aid not in seen_aids:
                        seen_aids.add(aid)
                        clean_aids.append(aid)

            target_ids_for_rows = ["", *clean_aids]
            removed_count = 0
            if removed_lc:
                ph_rem = ",".join("?" for _ in removed_lc)
                sorted_rem = sorted(removed_lc)
                for off in range(0, len(target_ids_for_rows), 400):
                    chunk_ids = target_ids_for_rows[off : off + 400]
                    ph_ids = ",".join("?" for _ in chunk_ids)
                    cur.execute(
                        f"""
                        DELETE FROM moment_tags
                        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                          AND asset_id IN ({ph_ids})
                          AND LOWER(tag_value) IN ({ph_rem})
                        """,
                        [m_name, *chunk_ids, *sorted_rem],
                    )
                    removed_count += cur.rowcount or 0

            existing_by_aid: dict[str, list[dict]] = {}
            all_target_existing: list[dict] = []
            if req.merge_existing:
                for off in range(0, len(target_ids_for_rows), 400):
                    chunk_ids = target_ids_for_rows[off : off + 400]
                    ph_ids = ",".join("?" for _ in chunk_ids)
                    cur.execute(
                        f"""
                        SELECT asset_id, category, tag_value, include_in_name
                        FROM moment_tags
                        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                          AND asset_id IN ({ph_ids})
                        ORDER BY id ASC
                        """,
                        [m_name, *chunk_ids],
                    )
                    for row_aid, cat, val, inc in cur.fetchall():
                        item = {
                            "category": (cat or "").strip().lower(),
                            "tag_value": re.sub(r"\s+", " ", (val or "").strip()),
                            "include_in_name": bool(inc),
                        }
                        if not item["tag_value"] or item["tag_value"].lower() in removed_lc:
                            continue
                        existing_by_aid.setdefault(row_aid or "", []).append(item)
                        all_target_existing.append(item)

                # Also fold in active flags stored in each asset's unified JSON metadata construct
                for aid in clean_aids:
                    meta_items = _read_asset_metadata_tags(cur, aid)
                    for m_item in meta_items:
                        if m_item["tag_value"].lower() in removed_lc:
                            continue
                        existing_by_aid.setdefault(aid, []).append(m_item)
                        all_target_existing.append(m_item)

                session_tags, merged_existing_count = _merge_tag_lists(all_target_existing, clean_tags, removed_lc)
            else:
                session_tags = clean_tags
                merged_existing_count = 0

            composed = (req.composed_name or "").strip()
            if req.apply_to_folder_name:
                target_ref = composed or m_name
                session_tags = _reconcile_include_in_name_with_folder(session_tags, target_ref, has_named_session=True)
                clean_tags = _reconcile_include_in_name_with_folder(clean_tags, target_ref, has_named_session=True)

            cur.execute(
                """
                INSERT INTO moment_tag_sessions
                    (moment_name, apply_to_folder_name, composed_name, selected_tags_json, asset_count, notes)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    m_name,
                    1 if req.apply_to_folder_name else 0,
                    composed if req.apply_to_folder_name else None,
                    json.dumps(session_tags),
                    len(clean_aids),
                    (req.notes or "").strip() or None,
                ),
            )
            session_id = int(cur.lastrowid)

            # Update selected asset rows (merging per-asset existing DB tags when merge_existing=True)
            for aid in clean_aids:
                aid_tags = (
                    _merge_tag_lists(existing_by_aid.get(aid, []), clean_tags, removed_lc)[0]
                    if req.merge_existing
                    else clean_tags
                )
                if req.apply_to_folder_name:
                    aid_tags = _reconcile_include_in_name_with_folder(aid_tags, composed or m_name, has_named_session=True)
                cur.execute(
                    "DELETE FROM moment_tags WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) AND asset_id = ?",
                    (m_name, aid),
                )
                for t in aid_tags:
                    cur.execute(
                        """
                        INSERT INTO moment_tags (moment_name, asset_id, category, tag_value, include_in_name, session_id, updated_at_utc)
                        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                        """,
                        (
                            m_name,
                            aid,
                            t["category"],
                            t["tag_value"],
                            1 if t["include_in_name"] else 0,
                            session_id,
                        ),
                    )
                _sync_asset_metadata_json(cur, aid, m_name, aid_tags, session_id)

            # Recompute Moment-level summary rows (asset_id = '') honoring latest checked flags & folder name
            cur.execute(
                """
                SELECT category, tag_value, include_in_name
                FROM moment_tags
                WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                  AND asset_id != ''
                ORDER BY id ASC
                """,
                (m_name,),
            )
            remaining_asset_tags = [
                {
                    "category": (r[0] or "").strip().lower(),
                    "tag_value": re.sub(r"\s+", " ", (r[1] or "").strip()),
                    "include_in_name": bool(r[2]),
                }
                for r in cur.fetchall()
                if (r[1] or "").strip()
            ]
            if req.merge_existing:
                moment_summary_tags, _ = _merge_tag_lists(
                    existing_by_aid.get("", []) + remaining_asset_tags,
                    clean_tags,
                    removed_lc,
                )
            else:
                moment_summary_tags, _ = _merge_tag_lists(remaining_asset_tags, clean_tags, removed_lc)
            if req.apply_to_folder_name:
                moment_summary_tags = _reconcile_include_in_name_with_folder(
                    moment_summary_tags, composed or m_name, has_named_session=True
                )

            cur.execute(
                "DELETE FROM moment_tags WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) AND asset_id = ''",
                (m_name,),
            )
            for t in moment_summary_tags:
                cur.execute(
                    """
                    INSERT INTO moment_tags (moment_name, asset_id, category, tag_value, include_in_name, session_id, updated_at_utc)
                    VALUES (?, '', ?, ?, ?, ?, datetime('now'))
                    """,
                    (
                        m_name,
                        t["category"],
                        t["tag_value"],
                        1 if t["include_in_name"] else 0,
                        session_id,
                    ),
                )
            moment_union_tags = _sync_moment_folder_metadata_json(
                cur,
                m_name,
                session_id,
                asset_ids_hint=clean_aids,
                extra_union_tags=moment_summary_tags,
            )

            saved_tags_out = _fetch_moment_summary_tag_rows(cur, m_name)
            saved_tags_out = _reconcile_include_in_name_with_folder(
                saved_tags_out,
                composed or m_name if req.apply_to_folder_name else m_name,
                has_named_session=bool(req.apply_to_folder_name),
            )

            row_ts = cur.execute(
                "SELECT created_at_utc FROM moment_tag_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            tag_db_counts = _compute_tag_db_counts(cur)
            tag_catalog_by_category = _compute_tag_catalog_by_category(cur)
            metadata_struct = _build_tag_metadata_struct(saved_tags_out, session_id=session_id, moment_name=m_name)
            metadata_summary = _format_metadata_summary_str(session_tags or saved_tags_out)
            conn.commit()
            return {
                "ok": True,
                "session_id": session_id,
                "moment_name": m_name,
                "apply_to_folder_name": bool(req.apply_to_folder_name),
                "composed_name": composed if req.apply_to_folder_name else "",
                "tags_saved": len(saved_tags_out),
                "assets_tagged": len(clean_aids),
                "merged_existing_count": merged_existing_count,
                "removed_count": removed_count,
                "saved_tags": saved_tags_out,
                "metadata_summary": metadata_summary,
                "metadata_struct": metadata_struct,
                "created_at_utc": row_ts[0] if row_ts else "",
                "tag_db_counts": tag_db_counts,
                "tag_catalog_by_category": tag_catalog_by_category,
                "moment_tags_union": moment_union_tags,
                "moment_paradigm_confirmed": bool(moment_union_tags),
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/memories/tags/by-tag")
def get_assets_by_moment_tag(tag_value: str, category: str = "", exclude_moment: str = ""):
    """Query assets & Moments already tagged in media_organizer.db with the given tag pill."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    tv = re.sub(r"\s+", " ", (tag_value or "").strip())
    if not tv:
        return {"ok": False, "error": "tag_value is required"}
    cat = (category or "").strip().lower()
    excl = (exclude_moment or "").strip().lower()

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
        try:
            cur = conn.cursor()
            _ensure_moment_tag_tables(cur)
            where_clauses = ["LOWER(mt.tag_value) = LOWER(?)", "mt.asset_id != ''"]
            params: list = [tv]
            if cat:
                where_clauses.append("LOWER(mt.category) = LOWER(?)")
                params.append(cat)

            cur.execute(
                f"""
                SELECT
                    mt.asset_id,
                    COALESCE(v.original_filename, a.original_filename, mt.asset_id) AS fn,
                    COALESCE(NULLIF(TRIM(a.MomentsAlbumName), ''), mt.moment_name) AS m_name,
                    mt.category,
                    mt.tag_value,
                    COALESCE(v.score_normalized, 0.0) AS score,
                    COALESCE(v.date_created_utc, a.date_created_utc, '') AS dt_s,
                    COALESCE(za.ZKIND, 0) AS zkind
                FROM moment_tags mt
                LEFT JOIN assets a ON a.asset_id = mt.asset_id
                LEFT JOIN ranked_assets_view v ON v.asset_id = mt.asset_id
                LEFT JOIN ZASSET za ON za.ZUUID = mt.asset_id
                WHERE {" AND ".join(where_clauses)}
                GROUP BY mt.asset_id, m_name
                ORDER BY CASE WHEN LOWER(m_name) = ? THEN 1 ELSE 0 END ASC, score DESC, dt_s ASC
                LIMIT 60
                """,
                [*params, excl],
            )
            rows = cur.fetchall()
            assets_out = []
            moment_agg: dict[str, dict] = {}
            for aid, fn, m_name, m_cat, m_tv, sc, dt_s, zkind in rows:
                is_curr = bool(excl and (m_name or "").strip().lower() == excl)
                score_val = round(float(sc or 0.0), 4)
                assets_out.append(
                    {
                        "asset_id": aid,
                        "original_filename": fn or aid,
                        "moment_name": m_name or "",
                        "category": m_cat,
                        "tag_value": m_tv,
                        "score_normalized": score_val,
                        "date_created_utc": (dt_s or "")[:19],
                        "media_type": "video" if int(zkind or 0) == 1 else "photo",
                        "is_current": is_curr,
                    }
                )
                agg = moment_agg.setdefault(
                    m_name,
                    {"moment_name": m_name, "asset_count": 0, "max_score": 0.0, "is_current": is_curr},
                )
                agg["asset_count"] += 1
                if score_val > agg["max_score"]:
                    agg["max_score"] = score_val

            moments_out = sorted(
                moment_agg.values(),
                key=lambda x: (1 if x["is_current"] else 0, -x["asset_count"], -x["max_score"]),
            )
            return {
                "ok": True,
                "tag_value": tv,
                "category": cat,
                "total_assets": len(assets_out),
                "total_moments": len(moments_out),
                "moments": moments_out,
                "assets": assets_out[:48],
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/memories/search-moments")
def search_moments_for_consolidation(q: str = "", exclude_moment: str = "", anchor_moment: str = "", limit: int = 30):
    """Search existing Moments in DB for dynamic combining or merge-target lookup."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    q_clean = (q or "").strip().lower()
    excl = (exclude_moment or "").strip().lower()
    anchor = (anchor_moment or "").strip()
    lim = max(1, min(int(limit or 30), 80))

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
        try:
            cur = conn.cursor()
            _ensure_moment_tag_tables(cur)
            cur.execute("SELECT MIN(threshold_score) FROM threshold_history WHERE threshold_score > 0.0")
            min_row = cur.fetchone()
            hist_min_raw = float(min_row[0]) if min_row and min_row[0] else 0.5315

            anchor_dt = None
            if anchor:
                r_anch = cur.execute(
                    """
                    SELECT COALESCE(v.date_created_utc, a.date_created_utc)
                    FROM assets a
                    LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
                    WHERE TRIM(LOWER(COALESCE(a.MomentsAlbumName, ''))) = TRIM(LOWER(?))
                      AND COALESCE(v.date_created_utc, a.date_created_utc, '') != ''
                    ORDER BY COALESCE(v.score_normalized, 0.0) DESC
                    LIMIT 1
                    """,
                    (anchor,),
                ).fetchone()
                if r_anch and r_anch[0]:
                    anchor_dt = _parse_utc_dt(r_anch[0])
                else:
                    m_dt_prefix = re.match(r"^(\d{4}-\d{2}-\d{2})\b", anchor)
                    if m_dt_prefix:
                        anchor_dt = _parse_utc_dt(m_dt_prefix.group(1) + " 12:00:00")

            cur.execute(
                """
                SELECT
                    TRIM(a.MomentsAlbumName) AS m_alb,
                    COUNT(*) AS total_cnt,
                    SUM(CASE WHEN COALESCE(v.score_normalized, 0.0) > ? THEN 1 ELSE 0 END) AS qual_cnt,
                    MIN(COALESCE(v.date_created_utc, a.date_created_utc, '')) AS min_dt,
                    MAX(COALESCE(v.date_created_utc, a.date_created_utc, '')) AS max_dt
                FROM assets a
                LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
                LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
                WHERE a.MomentsAlbumName IS NOT NULL
                  AND TRIM(a.MomentsAlbumName) != ''
                  AND LOWER(TRIM(a.MomentsAlbumName)) NOT IN ('ignore', 'skippublishing', 'topscore excluded')
                  AND COALESCE(a.removed_from_source, 0) = 0
                  AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
                GROUP BY TRIM(a.MomentsAlbumName)
                """,
                (hist_min_raw,),
            )
            moment_rows = cur.fetchall()
            tag_cnt_rows = cur.execute(
                "SELECT TRIM(LOWER(moment_name)), COUNT(DISTINCT LOWER(category) || ':' || LOWER(tag_value)) FROM moment_tags GROUP BY TRIM(LOWER(moment_name))"
            ).fetchall()
            tag_counts = {r[0]: int(r[1] or 0) for r in tag_cnt_rows if r[0]}

            results = []
            for m_alb, total_cnt, qual_cnt, min_dt_s, max_dt_s in moment_rows:
                if excl and m_alb.lower() == excl:
                    continue
                if q_clean and q_clean not in m_alb.lower():
                    continue
                d_min = _parse_utc_dt(min_dt_s)
                d_max = _parse_utc_dt(max_dt_s)
                rel_label = ""
                sort_diff = 999999.0
                if anchor_dt and d_min and d_max:
                    mid_ts = (d_min.timestamp() + d_max.timestamp()) / 2.0
                    diff_d = (mid_ts - anchor_dt.timestamp()) / 86400.0
                    sort_diff = abs(diff_d)
                    d_int = round(abs(diff_d))
                    rel_label = f"+{d_int}d" if diff_d > 0 else (f"-{d_int}d" if diff_d < 0 else "0d")
                results.append(
                    {
                        "moment_name": m_alb,
                        "total_count": int(total_cnt or 0),
                        "qualified_count": int(qual_cnt or 0),
                        "rel_label": rel_label,
                        "min_date": (min_dt_s or "")[:10],
                        "saved_tags_count": tag_counts.get(m_alb.lower(), 0),
                        "_sort_diff": sort_diff,
                    }
                )
            results.sort(key=lambda x: (x["_sort_diff"] if q_clean == "" else 0.0, -x["qualified_count"], -x["total_count"], x["moment_name"]))
            for r in results:
                r.pop("_sort_diff", None)
            return {"ok": True, "moments": results[:lim], "total_matched": len(results)}
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/memories/moment-assets")
def get_moment_assets_preview(moment_name: str):
    """Return full tagging context, asset thumbnails, and suggestions for any existing Moment pill."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}
    m_name = (moment_name or "").strip()
    if not m_name:
        return {"ok": False, "error": "moment_name is required"}

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
        try:
            cur = conn.cursor()
            core = _load_moment_detail_core(cur, m_name, limit_assets=100)
            conn.commit()
            return {
                "ok": True,
                "moment_name": m_name,
                "historical_min": round(core["historical_min"], 4),
                "assets": core["assets_out"],
                "albums_present": core["albums_present"],
                "name_suggestion": core["name_suggestion"],
                "saved_tags": core["saved_tags"],
                "last_tag_session": core["last_tag_session"],
                "tag_db_counts": core["tag_db_counts"],
                "tag_catalog_by_category": core["tag_catalog_by_category"],
                "metadata_summary": core["metadata_summary"],
                "metadata_struct": core["metadata_struct"],
            }
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/memories/resolve-disjoint")
def resolve_disjoint_moment(req: ResolveDisjointRequest):
    """Resolve a disjoint (<2 qualified assets) Moment via Merge, SkipPublishing, or Ignore."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    src_moment = (req.source_moment or "").strip()
    action = (req.action or "").strip().lower()
    if not src_moment:
        return {"ok": False, "error": "source_moment is required"}
    if action not in ("merge", "skip_publishing", "ignore"):
        return {"ok": False, "error": f"Unsupported action: {action}"}

    top_folder = "Media Organizer on LaCie"
    target_moment = (req.target_moment or "").strip()
    target_parent = (req.target_parent_folder or "Moments").strip() or "Moments"

    if action == "merge":
        if not target_moment:
            return {"ok": False, "error": "Target Moment name is required to merge"}
        if "/" in target_moment or "/" in target_parent:
            return {"ok": False, "error": "Moment and folder names cannot contain '/'"}
        if target_parent.lower() == "curated" and target_moment.lower() != src_moment.lower():
            try:
                conn_chk = sqlite3.connect(str(MEDIA_DB_PATH), timeout=15)
                try:
                    cur_chk = conn_chk.cursor()
                    cur_exists = cur_chk.execute(
                        """
                        SELECT 1 FROM media_organizer_albums
                        WHERE is_folder = 0
                          AND LOWER(COALESCE(parent_folder_name, '')) = 'curated'
                          AND TRIM(LOWER(album_name)) = TRIM(LOWER(?))
                        LIMIT 1
                        """,
                        (target_moment,),
                    ).fetchone()
                finally:
                    conn_chk.close()
            except Exception:
                cur_exists = None
            if not cur_exists:
                return {
                    "ok": False,
                    "error": f"Cannot copy new folder '{target_moment}' directly to Curated — consolidate into Moments first.",
                }
        has_extra_sources = any((rm or "").strip() and (rm or "").strip().lower() != target_moment.lower() for rm in (req.additional_moments or []))
        if target_moment.lower() == src_moment.lower() and target_parent.lower() == "moments" and not has_extra_sources and not (req.asset_ids or []):
            return {"ok": False, "error": "Select assets or combine another Moment to add into this existing folder"}

    clean_ids: list[str] = []
    seen: set[str] = set()
    for raw_aid in req.asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen:
            seen.add(s)
            clean_ids.append(s)

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            if not clean_ids:
                cur.execute(
                    """
                    SELECT asset_id FROM assets
                    WHERE TRIM(COALESCE(MomentsAlbumName, '')) = TRIM(?)
                    """,
                    (src_moment,),
                )
                clean_ids = [r[0] for r in cur.fetchall() if r[0]]
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": str(e)}

    if action == "ignore":
        if not clean_ids:
            return {"ok": False, "error": f"No assets found in '{src_moment}' to ignore"}
        python_bin, script_path = _get_pipeline_python_and_dedup_script()
        if not script_path.exists():
            return {"ok": False, "error": f"Dedup ignore script not found at {script_path}"}
        try:
            proc = subprocess.run(
                [python_bin, str(script_path), "--apply", "--json", "--asset-ids", *clean_ids],
                cwd=str(REPOS["media-organizer-pipeline"]),
                capture_output=True,
                text=True,
                timeout=180,
            )
            if proc.returncode != 0:
                return {"ok": False, "error": proc.stderr.strip() or proc.stdout.strip() or f"Exit {proc.returncode}"}
            ign_data = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except Exception as e:
            return {"ok": False, "error": str(e)}

        if req.delete_source_albums:
            conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
            try:
                cur = conn.cursor()
                _delete_source_albums_from_db(cur, src_moment)
                conn.commit()
            finally:
                conn.close()

        return {
            "ok": True,
            "action": "ignore",
            "source_moment": src_moment,
            "photos_added": int(ign_data.get("photos_added") or 0),
            "db_updated": int(ign_data.get("db_updated") or 0),
        }

    if action == "skip_publishing":
        if not clean_ids:
            return {"ok": False, "error": f"No assets found in '{src_moment}' to move to SkipPublishing"}
        argv = [top_folder, "Moments", "SkipPublishing", "1", *clean_ids]
        try:
            proc = subprocess.run(
                ["osascript", "-", *argv],
                input=_MOMENTS_APPLESCRIPT,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except Exception as e:
            return {"ok": False, "error": f"Failed executing AppleScript: {e}"}

        out = (proc.stdout or "").strip()
        if proc.returncode != 0 or out.startswith("ERROR|"):
            return {"ok": False, "error": out or (proc.stderr or "").strip() or "AppleScript error"}

        parts = out.split("|")
        photos_added = int(parts[1] or 0) if len(parts) >= 2 and parts[1].isdigit() else 0

        try:
            conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
            conn.execute("PRAGMA busy_timeout = 30000")
            try:
                cur = conn.cursor()
                skip_row = cur.execute(
                    """
                    SELECT album_pk FROM media_organizer_albums
                    WHERE is_folder = 0 AND LOWER(album_name) = 'skippublishing'
                      AND LOWER(COALESCE(parent_folder_name, '')) = 'moments'
                    LIMIT 1
                    """
                ).fetchone()
                skip_pk = int(skip_row[0]) if skip_row else None
                if skip_pk is None:
                    skip_pk = _allocate_synthetic_album_pk(cur)
                    cur.execute(
                        """
                        INSERT INTO media_organizer_albums
                            (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
                        VALUES (?, 'SkipPublishing', NULL, 'Moments', 'Media Organizer on LaCie/Moments/SkipPublishing', 0, 3, 2, 0, datetime('now'))
                        """,
                        (skip_pk,),
                    )
                for aid in clean_ids:
                    _insert_album_asset_row_if_missing(cur, skip_pk, aid)
                cur.execute(
                    "UPDATE media_organizer_albums SET asset_count = (SELECT COUNT(*) FROM media_organizer_album_assets WHERE album_pk = ?), synced_at_utc = datetime('now') WHERE album_pk = ?",
                    (skip_pk, skip_pk),
                )
                pub_rec_sub = PUBLISHING_RECOMMENDATION_DIR / src_moment
                if pub_rec_sub.exists() and pub_rec_sub.is_dir():
                    try:
                        shutil.rmtree(pub_rec_sub)
                    except Exception:
                        pass
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            return {"ok": False, "error": f"Failed updating DB for SkipPublishing: {e}"}

        return {
            "ok": True,
            "action": "skip_publishing",
            "source_moment": src_moment,
            "photos_added": photos_added,
            "asset_count": len(clean_ids),
            "db_updated": len(clean_ids),
        }

    # action == "merge"
    add_moments: list[str] = []
    seen_moments_lc = {src_moment.lower()}
    for rm in req.additional_moments or []:
        sm = (rm or "").strip()
        if sm and sm.lower() not in seen_moments_lc:
            seen_moments_lc.add(sm.lower())
            add_moments.append(sm)

    combined_src_moments = list(add_moments) if req.is_unassigned_cluster else [src_moment, *add_moments]
    combined_asset_ids = list(clean_ids)
    seen_all_ids = set(combined_asset_ids)
    for raw_aid in req.additional_asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen_all_ids:
            seen_all_ids.add(s)
            combined_asset_ids.append(s)

    if add_moments and not req.additional_asset_ids:
        try:
            conn_a = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
            try:
                cur_a = conn_a.cursor()
                for am in add_moments:
                    rows_a = cur_a.execute(
                        """
                        SELECT DISTINCT a.asset_id
                        FROM assets a
                        LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
                        WHERE TRIM(LOWER(COALESCE(a.MomentsAlbumName, ''))) = TRIM(LOWER(?))
                          AND COALESCE(za.ZTRASHEDSTATE, 0) = 0
                          AND COALESCE(a.removed_from_source, 0) = 0
                        """,
                        (am,),
                    ).fetchall()
                    for (aid,) in rows_a:
                        if aid and aid not in seen_all_ids:
                            seen_all_ids.add(aid)
                            combined_asset_ids.append(aid)
            finally:
                conn_a.close()
        except Exception as e:
            return {"ok": False, "error": f"Failed resolving combined Moment assets: {e}"}

    del_flag = "1" if req.delete_source_albums else "0"
    argv = [top_folder, target_parent, target_moment, del_flag, str(len(combined_src_moments)), *combined_src_moments, *combined_asset_ids]
    try:
        proc = subprocess.run(
            ["osascript", "-", *argv],
            input=_MERGE_DISJOINT_APPLESCRIPT,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except Exception as e:
        return {"ok": False, "error": f"Failed executing AppleScript merge: {e}"}

    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or out.startswith("ERROR|"):
        return {"ok": False, "error": out or (proc.stderr or "").strip() or f"AppleScript error (exit {proc.returncode})"}

    parts = out.split("|")
    target_action = parts[0] if parts else "existing"
    photos_added = int(parts[1] or 0) if len(parts) >= 2 and parts[1].isdigit() else 0
    albums_deleted = int(parts[2] or 0) if len(parts) >= 3 and parts[2].isdigit() else 0

    # Optional unselected handling (e.g. when M200 Moment is consolidated into a new Moments folder)
    unselected_action_m = (req.unselected_action or "none").strip().lower()
    unselected_ids_m: list[str] = []
    seen_unsel_m = set(seen_all_ids)
    for raw_u in req.unselected_asset_ids or []:
        su = (raw_u or "").strip()
        if su and su not in seen_unsel_m:
            seen_unsel_m.add(su)
            unselected_ids_m.append(su)

    unselected_count_done = 0
    unselected_error = None
    if unselected_ids_m and unselected_action_m == "ignore":
        python_bin, script_path = _get_pipeline_python_and_dedup_script()
        if script_path.exists():
            try:
                proc_ign = subprocess.run(
                    [python_bin, str(script_path), "--apply", "--json", "--asset-ids", *unselected_ids_m],
                    cwd=str(REPOS["media-organizer-pipeline"]),
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if proc_ign.returncode == 0:
                    ign_data = json.loads(proc_ign.stdout) if proc_ign.stdout.strip() else {}
                    unselected_count_done = int(
                        ign_data.get("photos_added") or ign_data.get("db_updated") or len(unselected_ids_m)
                    )
                else:
                    unselected_error = (
                        proc_ign.stderr.strip() or proc_ign.stdout.strip() or f"dedup_ignore exited {proc_ign.returncode}"
                    )
            except Exception as e:
                unselected_error = str(e)
    elif unselected_ids_m and unselected_action_m == "skip_publishing":
        try:
            proc_skip = subprocess.run(
                ["osascript", "-", top_folder, "Moments", "SkipPublishing", "1", *unselected_ids_m],
                input=_MOMENTS_APPLESCRIPT,
                capture_output=True,
                text=True,
                timeout=120,
            )
            skip_out = (proc_skip.stdout or "").strip()
            if proc_skip.returncode == 0 and not skip_out.startswith("ERROR|"):
                unselected_count_done = len(unselected_ids_m)
            else:
                unselected_error = (
                    skip_out or (proc_skip.stderr or "").strip() or f"SkipPublishing exited {proc_skip.returncode}"
                )
        except Exception as e:
            unselected_error = str(e)

    # Reflect merge + optional tag application across all combined assets in local DB immediately
    tag_session_id = None
    tags_applied_count = 0
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            _ensure_moment_tag_tables(cur)
            full_path = f"{top_folder}/{target_parent}/{target_moment}"
            tgt_row = cur.execute(
                """
                SELECT album_pk FROM media_organizer_albums
                WHERE is_folder = 0
                  AND (LOWER(full_path) = LOWER(?) OR (LOWER(album_name) = LOWER(?) AND LOWER(COALESCE(parent_folder_name, '')) = LOWER(?)))
                LIMIT 1
                """,
                (full_path, target_moment, target_parent),
            ).fetchone()
            if tgt_row:
                tgt_pk = int(tgt_row[0])
            else:
                p_row = cur.execute(
                    "SELECT album_pk FROM media_organizer_albums WHERE is_folder = 1 AND LOWER(album_name) = LOWER(?) LIMIT 1",
                    (target_parent,),
                ).fetchone()
                p_pk = int(p_row[0]) if p_row else None
                tgt_pk = _allocate_synthetic_album_pk(cur)
                cur.execute(
                    """
                    INSERT INTO media_organizer_albums
                        (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
                    VALUES (?, ?, ?, ?, ?, 0, 3, 2, 0, datetime('now'))
                    """,
                    (tgt_pk, target_moment, p_pk, target_parent, full_path),
                )

            if target_parent.lower() in ("moments", "memories", "curated", "tobecurated", "generic moments"):
                m_exists = cur.execute(
                    "SELECT 1 FROM moments WHERE TRIM(LOWER(album_name)) = TRIM(LOWER(?)) LIMIT 1",
                    (target_moment,),
                ).fetchone()
                if not m_exists:
                    cur.execute(
                        "INSERT INTO moments (album_pk, album_name, parent_folder_pk, parent_folder_name) VALUES (?, ?, NULL, ?)",
                        (tgt_pk, target_moment, target_parent),
                    )

            # Collect only selected/combined asset IDs into target album; clear orphaned Moment ref on skipped/unchecked items when deleting source
            if combined_asset_ids:
                ph = ",".join("?" for _ in combined_asset_ids)
                cur.execute(
                    f"UPDATE assets SET MomentsAlbumName = ?, updated_at_utc = datetime('now') WHERE asset_id IN ({ph})",
                    [target_moment, *combined_asset_ids],
                )
            for aid in combined_asset_ids:
                _insert_album_asset_row_if_missing(cur, tgt_pk, aid)
            cur.execute(
                "UPDATE media_organizer_albums SET asset_count = (SELECT COUNT(*) FROM media_organizer_album_assets WHERE album_pk = ?), synced_at_utc = datetime('now') WHERE album_pk = ?",
                (tgt_pk, tgt_pk),
            )

            explicit_selection_sent = bool((req.asset_ids or []) or (req.additional_asset_ids or []))
            if req.delete_source_albums:
                for sm in combined_src_moments:
                    if sm.lower() == target_moment.lower():
                        # Remove any duplicate album copies for same name in other organizer folders (e.g. ToBeCurated/Curated)
                        extra_pks = [
                            int(r[0])
                            for r in cur.execute(
                                """
                                SELECT album_pk FROM media_organizer_albums
                                WHERE is_folder = 0
                                  AND album_pk != ?
                                  AND TRIM(LOWER(album_name)) = TRIM(LOWER(?))
                                  AND LOWER(COALESCE(parent_folder_name, '')) IN ('moments', 'curated', 'tobecurated', 'generic moments')
                                """,
                                (tgt_pk, sm),
                            ).fetchall()
                        ]
                        if extra_pks:
                            ph_e = ",".join("?" for _ in extra_pks)
                            cur.execute(f"DELETE FROM media_organizer_album_assets WHERE album_pk IN ({ph_e})", extra_pks)
                            cur.execute(f"DELETE FROM media_organizer_albums WHERE album_pk IN ({ph_e})", extra_pks)
                        continue

                    if explicit_selection_sent:
                        # Any assets not selected (e.g. skipped duplicate copies like .MOV paired with .HEIC) are detached from deleted source rather than added to target
                        cur.execute(
                            "UPDATE assets SET MomentsAlbumName = NULL, updated_at_utc = datetime('now') WHERE TRIM(LOWER(COALESCE(MomentsAlbumName, ''))) = TRIM(LOWER(?))",
                            (sm,),
                        )
                    else:
                        cur.execute(
                            "UPDATE assets SET MomentsAlbumName = ?, updated_at_utc = datetime('now') WHERE TRIM(LOWER(COALESCE(MomentsAlbumName, ''))) = TRIM(LOWER(?))",
                            (target_moment, sm),
                        )
                    cur.execute(
                        """
                        UPDATE OR IGNORE moment_tags
                        SET moment_name = ?, updated_at_utc = datetime('now')
                        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                        """,
                        (target_moment, sm),
                    )
                    cur.execute("DELETE FROM moment_tags WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))", (sm,))
                    _delete_source_albums_from_db(cur, sm)

            if req.is_unassigned_cluster and src_moment.lower() != target_moment.lower():
                cur.execute(
                    """
                    UPDATE OR IGNORE moment_tags
                    SET moment_name = ?, updated_at_utc = datetime('now')
                    WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                    """,
                    (target_moment, src_moment),
                )
                cur.execute("DELETE FROM moment_tags WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))", (src_moment,))

            if unselected_ids_m:
                ph_um = ",".join("?" for _ in unselected_ids_m)
                cur.execute(
                    f"UPDATE assets SET MomentsAlbumName = NULL, curated_album = NULL, updated_at_utc = datetime('now') WHERE asset_id IN ({ph_um})",
                    unselected_ids_m,
                )
                if unselected_action_m == "skip_publishing":
                    _upsert_album_and_assets_in_db(cur, "Moments", "SkipPublishing", unselected_ids_m)

            # Reset M status on the destination folder when a new or newly consolidated folder is saved in Moments
            _reset_new_folder_curated_moment_stage(
                cur,
                target_moment,
                target_parent,
                asset_count=len(combined_asset_ids),
                force=(
                    target_action == "created"
                    or (target_parent.lower() == "moments" and (bool(add_moments) or src_moment.lower() != target_moment.lower()))
                ),
            )

            # Apply per-Moment distinct tags and/or shared apply_tags across consolidated assets
            clean_apply_tags = _normalize_unique_moment_tags(req.apply_tags)
            clean_groups: list[tuple[list[str], list[dict]]] = []
            union_tags: list[dict] = list(clean_apply_tags)
            seen_union_vals = {t["tag_value"].lower() for t in union_tags}
            for grp in req.moment_tag_groups or []:
                g_tags = _normalize_unique_moment_tags(grp.tags)
                g_aids = [s.strip() for s in (grp.asset_ids or []) if s and s.strip()]
                if g_tags and g_aids:
                    clean_groups.append((g_aids, g_tags))
                    for t in g_tags:
                        tv_lc = t["tag_value"].lower()
                        if tv_lc not in seen_union_vals:
                            seen_union_vals.add(tv_lc)
                            union_tags.append(t)

            if clean_apply_tags or clean_groups:
                cur.execute(
                    """
                    INSERT INTO moment_tag_sessions
                        (moment_name, apply_to_folder_name, composed_name, selected_tags_json, asset_count, notes)
                    VALUES (?, 1, ?, ?, ?, ?)
                    """,
                    (
                        target_moment,
                        target_moment,
                        json.dumps(union_tags),
                        len(combined_asset_ids),
                        f"Consolidated from: {', '.join(combined_src_moments)}",
                    ),
                )
                tag_session_id = int(cur.lastrowid)

                def _upsert_tag_rows(aid_list: list[str], tag_list: list[dict]) -> None:
                    for aid in aid_list:
                        for t in tag_list:
                            cur.execute(
                                """
                                INSERT INTO moment_tags (moment_name, asset_id, category, tag_value, include_in_name, session_id, updated_at_utc)
                                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                                ON CONFLICT(LOWER(moment_name), asset_id, LOWER(tag_value))
                                DO UPDATE SET category = excluded.category, include_in_name = excluded.include_in_name, session_id = excluded.session_id, updated_at_utc = datetime('now')
                                """,
                                (
                                    target_moment,
                                    aid,
                                    t["category"],
                                    t["tag_value"],
                                    1 if t["include_in_name"] else 0,
                                    tag_session_id,
                                ),
                            )

                if union_tags:
                    _upsert_tag_rows([""], union_tags)
                for g_aids, g_tags in clean_groups:
                    _upsert_tag_rows(g_aids, g_tags)
                if clean_apply_tags and combined_asset_ids:
                    _upsert_tag_rows(combined_asset_ids, clean_apply_tags)
                for aid in combined_asset_ids:
                    cur_aid_rows = cur.execute(
                        """
                        SELECT category, tag_value, include_in_name
                        FROM moment_tags
                        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) AND asset_id = ?
                        ORDER BY id ASC
                        """,
                        (target_moment, aid),
                    ).fetchall()
                    cur_aid_tags = [
                        {"category": r[0], "tag_value": r[1], "include_in_name": bool(r[2])}
                        for r in cur_aid_rows
                    ]
                    if cur_aid_tags:
                        _sync_asset_metadata_json(cur, aid, target_moment, cur_aid_tags, tag_session_id)
                tags_applied_count = len(union_tags)

            moment_union_tags = _sync_moment_folder_metadata_json(
                cur,
                target_moment,
                tag_session_id,
                asset_ids_hint=combined_asset_ids,
                extra_union_tags=union_tags,
            )

            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": f"Failed updating DB after Photos merge: {e}"}

    return {
        "ok": True,
        "action": "merge",
        "source_moment": src_moment,
        "combined_moments": combined_src_moments,
        "target_moment": target_moment,
        "target_parent": target_parent,
        "target_action": target_action,
        "photos_added": photos_added,
        "albums_deleted": albums_deleted,
        "db_updated": len(combined_asset_ids),
        "tag_session_id": tag_session_id,
        "tags_applied": tags_applied_count,
        "moment_tags_union": moment_union_tags,
        "moment_paradigm_confirmed": bool(moment_union_tags),
        "unselected_count": unselected_count_done,
        "unselected_error": unselected_error,
    }


def _upsert_album_and_assets_in_db(
    cur: sqlite3.Cursor,
    parent_folder: str,
    moment_name: str,
    asset_ids: list[str],
) -> int:
    """Ensure media_organizer_albums & album assets entries exist locally after AppleScript updates."""
    top_folder = "Media Organizer on LaCie"
    full_path = f"{top_folder}/{parent_folder}/{moment_name}"
    alb_row = cur.execute(
        """
        SELECT album_pk FROM media_organizer_albums
        WHERE is_folder = 0
          AND (
              LOWER(full_path) = LOWER(?)
              OR (LOWER(TRIM(album_name)) = LOWER(?) AND LOWER(TRIM(COALESCE(parent_folder_name, ''))) = LOWER(?))
          )
        LIMIT 1
        """,
        (full_path, moment_name, parent_folder),
    ).fetchone()
    if alb_row:
        alb_pk = int(alb_row[0])
    else:
        p_row = cur.execute(
            "SELECT album_pk FROM media_organizer_albums WHERE is_folder = 1 AND LOWER(TRIM(album_name)) = LOWER(?) LIMIT 1",
            (parent_folder,),
        ).fetchone()
        p_pk = int(p_row[0]) if p_row else None
        alb_pk = _allocate_synthetic_album_pk(cur)
        cur.execute(
            """
            INSERT INTO media_organizer_albums
                (album_pk, album_name, parent_folder_pk, parent_folder_name, full_path, is_folder, depth, zkind, asset_count, synced_at_utc)
            VALUES (?, ?, ?, ?, ?, 0, 3, 2, 0, datetime('now'))
            """,
            (alb_pk, moment_name, p_pk, parent_folder, full_path),
        )
    for aid in asset_ids:
        _insert_album_asset_row_if_missing(cur, alb_pk, aid)
    cur.execute(
        "UPDATE media_organizer_albums SET asset_count = (SELECT COUNT(*) FROM media_organizer_album_assets WHERE album_pk = ?), synced_at_utc = datetime('now') WHERE album_pk = ?",
        (alb_pk, alb_pk),
    )
    return alb_pk


@router.post("/memories/curate-moment")
def curate_moment_action(req: CurateMomentRequest):
    """Curate an M200/ToBeCurated Moment into Curated (only when original folder name is kept)."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable"}

    src_moment = (req.source_moment or "").strip()
    target_moment = (req.target_moment or "").strip()
    unselected_action = (req.unselected_action or "ignore").strip().lower()
    if not src_moment or not target_moment:
        return {"ok": False, "error": "Both source_moment and target_moment are required"}
    if "/" in target_moment:
        return {"ok": False, "error": "Target Moment name cannot contain '/'"}
    if target_moment.lower() != src_moment.lower():
        return {
            "ok": False,
            "error": (
                f"New folder '{target_moment}' cannot be copied directly to Curated. "
                f"Keep original name '{src_moment}' to move to Curated, or consolidate into Moments for a new folder."
            ),
        }
    if unselected_action not in ("ignore", "skip_publishing", "none"):
        return {"ok": False, "error": f"Unsupported unselected_action: {unselected_action}"}

    primary_selected_ids: list[str] = []
    seen_sel: set[str] = set()
    for raw_aid in req.selected_asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen_sel:
            seen_sel.add(s)
            primary_selected_ids.append(s)

    extra_moments: list[str] = []
    seen_m_lc = {src_moment.lower()}
    for rm in req.additional_moments or []:
        sm = (rm or "").strip()
        if sm and sm.lower() not in seen_m_lc:
            seen_m_lc.add(sm.lower())
            extra_moments.append(sm)

    extra_asset_ids: list[str] = []
    for raw_aid in req.additional_asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen_sel:
            seen_sel.add(s)
            extra_asset_ids.append(s)

    selected_ids = [*primary_selected_ids, *extra_asset_ids]
    if not selected_ids:
        return {"ok": False, "error": "Select at least 1 keeper asset to approve into Curated"}

    unselected_ids: list[str] = []
    seen_unsel = set(seen_sel)
    for raw_aid in req.unselected_asset_ids or []:
        s = (raw_aid or "").strip()
        if s and s not in seen_unsel:
            seen_unsel.add(s)
            unselected_ids.append(s)

    del_tbc_flag = "1" if req.delete_tbc_album else "0"

    # 1. AppleScript: populate Curated/<target> ONLY (do NOT copy source Moment to Moments), delete ToBeCurated/<src>
    argv = [
        "Media Organizer on LaCie",
        target_moment,
        src_moment,
        del_tbc_flag,
        str(len(extra_moments)),
        *extra_moments,
        str(len(extra_asset_ids)),
        *extra_asset_ids,
        *selected_ids,
    ]
    try:
        proc = subprocess.run(
            ["osascript", "-", *argv],
            input=_CURATE_M200_APPLESCRIPT,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except Exception as e:
        return {"ok": False, "error": f"Failed running Photos curation AppleScript: {e}"}

    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or out.startswith("ERROR|"):
        return {"ok": False, "error": out or (proc.stderr or "").strip() or f"AppleScript failed (exit {proc.returncode})"}

    parts = out.split("|")
    target_action = parts[0] if parts else "created"
    photos_added = int(parts[1] or 0) if len(parts) >= 2 and parts[1].isdigit() else 0
    albums_deleted = int(parts[2] or 0) if len(parts) >= 3 and parts[2].isdigit() else 0

    # 2. Handle unselected assets (Ignore pipeline or SkipPublishing)
    unselected_count_done = 0
    unselected_error = None
    if unselected_ids and unselected_action == "ignore":
        python_bin, script_path = _get_pipeline_python_and_dedup_script()
        if script_path.exists():
            try:
                proc_ign = subprocess.run(
                    [python_bin, str(script_path), "--apply", "--json", "--asset-ids", *unselected_ids],
                    cwd=str(REPOS["media-organizer-pipeline"]),
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                if proc_ign.returncode == 0:
                    ign_data = json.loads(proc_ign.stdout) if proc_ign.stdout.strip() else {}
                    unselected_count_done = int(ign_data.get("photos_added") or ign_data.get("db_updated") or len(unselected_ids))
                else:
                    unselected_error = proc_ign.stderr.strip() or proc_ign.stdout.strip() or f"dedup_ignore exited {proc_ign.returncode}"
            except Exception as e:
                unselected_error = str(e)
    elif unselected_ids and unselected_action == "skip_publishing":
        try:
            proc_skip = subprocess.run(
                ["osascript", "-", "Media Organizer on LaCie", "Moments", "SkipPublishing", "1", *unselected_ids],
                input=_MOMENTS_APPLESCRIPT,
                capture_output=True,
                text=True,
                timeout=120,
            )
            skip_out = (proc_skip.stdout or "").strip()
            if proc_skip.returncode == 0 and not skip_out.startswith("ERROR|"):
                unselected_count_done = len(unselected_ids)
            else:
                unselected_error = skip_out or (proc_skip.stderr or "").strip() or f"SkipPublishing exited {proc_skip.returncode}"
        except Exception as e:
            unselected_error = str(e)

    # 3. Sync local DB: Curated & Moments albums, detach/remove ToBeCurated, rename cleanup, save DB tags
    tag_session_id = None
    tags_applied_count = 0
    moment_union_tags: list[dict] = []
    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
            _ensure_moment_tag_tables(cur)

            _upsert_album_and_assets_in_db(cur, "Curated", target_moment, selected_ids)
            if extra_asset_ids:
                _upsert_album_and_assets_in_db(cur, "Moments", target_moment, extra_asset_ids)

            if primary_selected_ids:
                ph_pri = ",".join("?" for _ in primary_selected_ids)
                cur.execute(
                    f"UPDATE assets SET curated_album = ?, updated_at_utc = datetime('now') WHERE asset_id IN ({ph_pri})",
                    [target_moment, *primary_selected_ids],
                )
            if extra_asset_ids:
                ph_ext = ",".join("?" for _ in extra_asset_ids)
                cur.execute(
                    f"UPDATE assets SET MomentsAlbumName = ?, curated_album = ?, updated_at_utc = datetime('now') WHERE asset_id IN ({ph_ext})",
                    [target_moment, target_moment, *extra_asset_ids],
                )

            if unselected_ids:
                ph_unsel = ",".join("?" for _ in unselected_ids)
                cur.execute(
                    f"UPDATE assets SET MomentsAlbumName = NULL, curated_album = NULL, updated_at_utc = datetime('now') WHERE asset_id IN ({ph_unsel})",
                    unselected_ids,
                )
                if unselected_action == "skip_publishing":
                    _upsert_album_and_assets_in_db(cur, "Moments", "SkipPublishing", unselected_ids)

            # Remove ToBeCurated album entries locally
            if req.delete_tbc_album:
                tbc_pks = [
                    int(r[0])
                    for r in cur.execute(
                        """
                        SELECT album_pk FROM media_organizer_albums
                        WHERE is_folder = 0
                          AND LOWER(COALESCE(parent_folder_name, '')) = 'tobecurated'
                          AND TRIM(LOWER(album_name)) = TRIM(LOWER(?))
                        """,
                        (src_moment,),
                    ).fetchall()
                ]
                if tbc_pks:
                    ph_t = ",".join("?" for _ in tbc_pks)
                    cur.execute(f"DELETE FROM media_organizer_album_assets WHERE album_pk IN ({ph_t})", tbc_pks)
                    cur.execute(f"DELETE FROM media_organizer_albums WHERE album_pk IN ({ph_t})", tbc_pks)

            for am in extra_moments:
                cur.execute(
                    """
                    UPDATE OR IGNORE moment_tags
                    SET moment_name = ?, updated_at_utc = datetime('now')
                    WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))
                    """,
                    (target_moment, am),
                )
                cur.execute("DELETE FROM moment_tags WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?))", (am,))
                _delete_source_albums_from_db(cur, am)

            cm_row = cur.execute(
                "SELECT COALESCE(memory_stage, '') FROM curated_moments WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) LIMIT 1",
                (target_moment,),
            ).fetchone()
            cur_stage = (cm_row[0] if cm_row else "") or ""
            next_stage = cur_stage if cur_stage in ("M400", "M450", "M500") else "M300"
            cur.execute(
                """
                INSERT INTO curated_moments (
                    moment_name, to_be_curated_count, curated_count, memory_stage,
                    last_pipeline_sync, photos_to_be_curated_exists, photos_curated_exists
                ) VALUES (?, 0, ?, ?, datetime('now'), 0, 1)
                ON CONFLICT(moment_name) DO UPDATE SET
                    to_be_curated_count = CASE WHEN ? = 1 THEN 0 ELSE curated_moments.to_be_curated_count END,
                    photos_to_be_curated_exists = CASE WHEN ? = 1 THEN 0 ELSE curated_moments.photos_to_be_curated_exists END,
                    curated_count = excluded.curated_count,
                    photos_curated_exists = 1,
                    memory_stage = ?,
                    last_pipeline_sync = datetime('now')
                """,
                (
                    target_moment,
                    len(selected_ids),
                    next_stage,
                    1 if req.delete_tbc_album else 0,
                    1 if req.delete_tbc_album else 0,
                    next_stage,
                ),
            )

            # Save DB tags if present
            clean_apply_tags = _normalize_unique_moment_tags(req.apply_tags)
            clean_groups: list[tuple[list[str], list[dict]]] = []
            union_tags = list(clean_apply_tags)
            seen_u = {t["tag_value"].lower() for t in union_tags}
            for grp in req.moment_tag_groups or []:
                g_tags = _normalize_unique_moment_tags(grp.tags)
                g_aids = [s.strip() for s in (grp.asset_ids or []) if s and s.strip() and s.strip() in seen_sel]
                if g_tags and g_aids:
                    clean_groups.append((g_aids, g_tags))
                    for t in g_tags:
                        tv_lc = t["tag_value"].lower()
                        if tv_lc not in seen_u:
                            seen_u.add(tv_lc)
                            union_tags.append(t)

            if clean_apply_tags or clean_groups:
                cur.execute(
                    """
                    INSERT INTO moment_tag_sessions
                        (moment_name, apply_to_folder_name, composed_name, selected_tags_json, asset_count, notes)
                    VALUES (?, 1, ?, ?, ?, ?)
                    """,
                    (
                        target_moment,
                        target_moment,
                        json.dumps(union_tags),
                        len(selected_ids),
                        f"Curated from M200: {src_moment}",
                    ),
                )
                tag_session_id = int(cur.lastrowid)

                def _upsert_cur_tags(aid_list: list[str], tag_list: list[dict]) -> None:
                    for aid in aid_list:
                        for t in tag_list:
                            cur.execute(
                                """
                                INSERT INTO moment_tags (moment_name, asset_id, category, tag_value, include_in_name, session_id, updated_at_utc)
                                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                                ON CONFLICT(LOWER(moment_name), asset_id, LOWER(tag_value))
                                DO UPDATE SET category = excluded.category, include_in_name = excluded.include_in_name, session_id = excluded.session_id, updated_at_utc = datetime('now')
                                """,
                                (target_moment, aid, t["category"], t["tag_value"], 1 if t["include_in_name"] else 0, tag_session_id),
                            )

                if union_tags:
                    _upsert_cur_tags([""], union_tags)
                for g_aids, g_tags in clean_groups:
                    _upsert_cur_tags(g_aids, g_tags)
                if clean_apply_tags:
                    _upsert_cur_tags(selected_ids, clean_apply_tags)
                for aid in selected_ids:
                    aid_rows = cur.execute(
                        """
                        SELECT category, tag_value, include_in_name FROM moment_tags
                        WHERE TRIM(LOWER(moment_name)) = TRIM(LOWER(?)) AND asset_id = ? ORDER BY id ASC
                        """,
                        (target_moment, aid),
                    ).fetchall()
                    aid_tags = [{"category": r[0], "tag_value": r[1], "include_in_name": bool(r[2])} for r in aid_rows]
                    if aid_tags:
                        _sync_asset_metadata_json(cur, aid, target_moment, aid_tags, tag_session_id)
                tags_applied_count = len(union_tags)

            moment_union_tags = _sync_moment_folder_metadata_json(
                cur,
                target_moment,
                tag_session_id,
                asset_ids_hint=selected_ids,
                extra_union_tags=union_tags,
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        return {"ok": False, "error": f"Curated in Photos, but failed updating DB: {e}"}

    # 4. Final Step: Export Curated/<target_moment> to LaCie & promote M300 -> M400
    exported_to_lacie = False
    export_error = None
    if req.export_to_lacie:
        pipe_repo = REPOS["media-organizer-pipeline"]
        sibling_repo = Path("/Users/nickolaycohen/dev/media-organizer-pipeline")
        script_root = sibling_repo if (sibling_repo / "scripts" / "export_curated_album.py").exists() else pipe_repo
        export_script = script_root / "scripts" / "export_curated_album.py"
        if export_script.exists():
            python_bin = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
            if not Path(python_bin).exists():
                python_bin = sys.executable
            try:
                proc_exp = subprocess.run(
                    [python_bin, str(export_script), target_moment],
                    cwd=str(script_root),
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if proc_exp.returncode == 0:
                    exported_to_lacie = True
                else:
                    export_error = (proc_exp.stderr or proc_exp.stdout or f"export exited {proc_exp.returncode}").strip()
            except Exception as e:
                export_error = str(e)
        else:
            export_error = f"export_curated_album.py not found at {export_script}"

    return {
        "ok": True,
        "action": "curate",
        "source_moment": src_moment,
        "target_moment": target_moment,
        "renamed": False,
        "combined_moments": [src_moment, *extra_moments],
        "selected_count": len(selected_ids),
        "photos_added": photos_added,
        "albums_deleted": albums_deleted,
        "unselected_action": unselected_action,
        "unselected_count": unselected_count_done,
        "unselected_error": unselected_error,
        "exported_to_lacie": exported_to_lacie,
        "export_error": export_error,
        "tag_session_id": tag_session_id,
        "tags_applied": tags_applied_count,
        "moment_tags_union": moment_union_tags,
        "moment_paradigm_confirmed": bool(moment_union_tags),
    }
