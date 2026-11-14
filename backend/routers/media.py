import os
import re
import sys
import math
import json
import time
import errno
import signal
import subprocess
import sqlite3
from typing import Optional
from pathlib import Path
from datetime import datetime, timezone
import calendar
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from backend.config import MEDIA_DB_PATH, REPOS, get_db_connection

APPLE_PHOTOS_LIBRARY_PATH = Path("/Volumes/Extreme Pro/Photos Library/All-Media.photoslibrary")

router = APIRouter(prefix="/api/media", tags=["media"])

class BgServiceControlRequest(BaseModel):
    action: str  # "start" or "stop"

class PublishedUrlUpdateRequest(BaseModel):
    moment_name: str
    shutterfly_url: Optional[str] = None
    youtube_url: Optional[str] = None

class MarkRemovedRequest(BaseModel):
    asset_ids: list[str]
    action: Optional[str] = "remove"  # "remove" or "restore"

class PlannerBatchActionRequest(BaseModel):
    month: str
    action: str  # "queue" | "remove_queue" | "confirm_500" | "bypass_500" | "reset_000"

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
            for row in cur.fetchall():
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

                published_moments.append({
                    "moment_name": r_dict["moment_name"] or "Untitled Moment",
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
                    "curated_count": int(r_dict.get("curated_count") or 0)
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

    return {
        "timestamp": now_str,
        "executor": {
            "is_running": is_running,
            "pid": pid,
            "status": status,
            "status_banner": f"ACTIVE (PID: {pid})" if is_running else ("STALE (PID: {pid})" if status == "STALE" else "IDLE")
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
                        COALESCE(a.carrier_device, zea.ZCAMERAMODEL, 'Unknown') AS camera_model,
                        COALESCE(do.owner_name, 'Shared/Other') AS primary_owner,
                        COALESCE(do.is_active, 0) AS is_active,
                        COALESCE(o.is_family, 0) AS is_family,
                        do.start_date AS owner_start_date,
                        do.end_date AS owner_end_date,
                        COALESCE(v.score_normalized, 0.0) AS score_normalized,
                        COALESCE(aaa.ZORIGINALFILESIZE, 0) AS file_size_bytes,
                        NTILE(4) OVER (
                            PARTITION BY COALESCE(a.carrier_device, zea.ZCAMERAMODEL, 'Unknown')
                            ORDER BY COALESCE(v.score_normalized, 0.0) ASC
                        ) AS score_quartile
                    FROM assets a
                    LEFT JOIN ZASSET za ON za.ZUUID = a.asset_id
                    LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON za.ZADDITIONALATTRIBUTES = aaa.Z_PK
                    LEFT JOIN ZEXTENDEDATTRIBUTES zea ON za.ZEXTENDEDATTRIBUTES = zea.Z_PK
                    LEFT JOIN device_owners do ON do.camera_model = COALESCE(a.carrier_device, zea.ZCAMERAMODEL)
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
        "id": "time_gps_session",
        "priority": 3,
        "name": "Time & GPS Session Clustering",
        "description": "Group remaining uncategorized assets within ≤2h and ≤500m GPS into finer sub-event sessions instead of full-day buckets.",
        "default_enabled": False,
    },
    {
        "id": "same_date",
        "priority": 4,
        "name": "Same-Date Fallback Grouping",
        "description": "Imply remaining uncategorized assets captured on the same calendar date belong together (YYYY-MM-DD - Uncategorized). Refuse to keep individual.",
        "default_enabled": True,
    },
]

_RULE_LABELS = {
    "existing_proximity": "Existing Moment Proximity",
    "photos_moment": "Apple Photos Moment Title",
    "time_gps_session": "Time & GPS Session",
    "same_date": "Same-Date Grouping",
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


def _load_grouping_rules_state(cur) -> tuple[dict[str, bool], set[str]]:
    rules_map = {r["id"]: bool(r["default_enabled"]) for r in DEFAULT_GROUPING_RULES}
    refused: set[str] = set()
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
    except Exception:
        pass
    return rules_map, refused


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
    for aid, sc in cur.fetchall():
        if aid not in excluded_aids and sc is not None:
            live_curr_th = float(sc)
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
            COALESCE(ze.ZCAMERAMODEL, ast.carrier_device, 'Unknown'),
            COALESCE(do.owner_name, 'Shared/Other'),
            COALESCE(za.ZDUPLICATEASSETVISIBILITYSTATE, 0)
        FROM ranked_assets_view v
        JOIN month_batches mb ON v.month = mb.month
        JOIN assets ast ON ast.asset_id = v.asset_id
        LEFT JOIN ZASSET za ON za.ZUUID = v.asset_id
        LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.Z_PK = za.ZADDITIONALATTRIBUTES
        LEFT JOIN ZEXTENDEDATTRIBUTES ze ON ze.Z_PK = za.ZEXTENDEDATTRIBUTES
        LEFT JOIN device_owners do ON do.camera_model = COALESCE(ast.carrier_device, ze.ZCAMERAMODEL)
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

    rules_map, refused_clusters = _load_grouping_rules_state(cur)
    grouped_moments = {}
    uncat_items = []

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
        captured_str = _utc_to_local_str(dt_utc_str)
        captured_date = captured_str[:10] if captured_str != "—" else ((dt_utc_str or "")[:10] or month)

        m_title, m_subtitle = moment_titles.get(aid, (None, None))
        moment_parts = []
        if m_title:
            moment_parts.append(m_title.replace("\xa0", " ").strip())
        if m_subtitle:
            moment_parts.append(m_subtitle.replace("\xa0", " ").strip())
        suggested_new = f"{captured_date} - {' - '.join(moment_parts)}" if moment_parts else None
        effective_suggested = suggested_new if rules_map.get("photos_moment", True) else None

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
        grp["months"] = ", ".join(sorted(grp["months"]))
        grp["score_span"] = f"{grp['max_score']:.4f}" if cnt == 1 else f"{grp['max_score']:.4f} .. {grp['min_score']:.4f}"
        rid = grp.get("rule_id") or "same_date"
        rule_cluster_counts[rid] = rule_cluster_counts.get(rid, 0) + 1
        rule_asset_counts[rid] = rule_asset_counts.get(rid, 0) + cnt
        unassigned_clusters.append(grp)
    unassigned_clusters.sort(key=lambda g: (-len(g["assets"]), -g["max_score"], g["folder"]))

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
        "ungrouped_count": rule_asset_counts.get("ungrouped", 0) + rule_asset_counts.get("refused_cluster", 0),
    }

    # 3. Qualified Moment Stats -> needs_sync_moments + actionable/disjoint recommendations
    cur.execute(
        """
        SELECT asset_id FROM media_organizer_album_assets moaa
        JOIN media_organizer_albums moa ON moa.album_pk = moaa.album_pk
        WHERE moa.full_path LIKE 'Media Organizer on LaCie/ToBeCurated/%'
          AND LOWER(moa.album_name) NOT IN ('skippublishing', 'ignore')
        """
    )
    tbc_aids = {r[0] for r in cur.fetchall()}

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

    cur.execute("SELECT asset_uuid, moment_name FROM publications")
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
            COUNT(DISTINCT p.asset_uuid)
        FROM publications p
        GROUP BY p.moment_name
        """
    )
    pub_info = {r[0]: {"last_pub_utc": r[1], "pub_count": r[2]} for r in cur.fetchall()}

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
                "all_dates": [],
            },
        )
        md["total_qualified"] += 1
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

    # Compute needs_sync_moments, recommendations, and disjoint moments
    needs_sync_moments = []
    moment_midpoints = {}
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
        p_info = pub_info.get(name, {})
        pub_count = p_info.get("pub_count", 0)
        unpub = md["unpublished_scores"]
        avg_score = sum(unpub) / len(unpub) if unpub else 0.0
        rank_score = avg_score * math.log(md["total_qualified"] + 1)

        if stage == "M500" or (pub_count >= md["total_qualified"] and md["total_qualified"] > 0):
            display_stage = "M500"
        elif stage == "M450" or pub_count > 0:
            display_stage = "M450"
        elif stage == "M400":
            display_stage = "M400"
        elif cm.get("curated_exists") or md["curated_count"] > 0:
            display_stage = "M300"
        elif cm.get("tbc_exists") or md["proposed_count"] > 0:
            display_stage = "M200"
        else:
            display_stage = "M100"

        if (md["proposed_count"] + md["curated_count"]) < md["total_qualified"]:
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
    actionable_recs = []
    disjoint_recs = []
    now_local = datetime.now()
    for name, md in moments_data.items():
        cm = cm_meta.get(name, {})
        p_info = pub_info.get(name, {})
        pub_count = p_info.get("pub_count", 0)
        last_pub_raw = p_info.get("last_pub_utc")
        cur_files_cnt = max(cm.get("curated_count", 0), md["curated_count"], len(curated_aids_by_album.get(name.strip(), ())))

        if md["total_qualified"] < 2 and pub_count == 0:
            # Find nearest moment with >= 2 assets
            merge_hint = "Merge candidate (<2 assets)"
            if name in moment_midpoints:
                t_mid = moment_midpoints[name]["mid"]
                best_diff = None
                best_other = None
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

            unpub = md["unpublished_scores"]
            disjoint_recs.append({
                "moment_name": name,
                "avg_score": round(sum(unpub) / len(unpub), 4) if unpub else 0.0,
                "files": md["total_qualified"],
                "published": str(pub_count) if pub_count > 0 else "0",
                "recommended": 0,
                "action": "Disjoint: Merge needed (<2 assets)",
                "details": merge_hint,
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

        actionable_recs.append({
            "idx": 0,
            "moment_name": name,
            "avg_score": round(rec_avg, 4),
            "files": cur_files_cnt,
            "published": str(pub_count),
            "recommended": len(rec_batch),
            "action": action,
            "details": details_str or "—",
        })

    actionable_recs.sort(key=lambda x: -x["avg_score"])
    for idx, rec in enumerate(actionable_recs, 1):
        rec["idx"] = idx
    disjoint_recs.sort(key=lambda x: -x["avg_score"])

    return {
        "threshold_aligned": threshold_aligned,
        "current_threshold": curr_thresh,
        "historical_min": hist_min,
        "last_checked_utc": last_th_utc,
        "actionable_recs": actionable_recs,
        "disjoint_recs": disjoint_recs,
        "needs_sync_moments": needs_sync_moments,
        "unassigned_clusters": unassigned_clusters,
        "grouping_rules": grouping_rules_payload,
    }


def _enrich_batch_candidates_with_devices(cur, candidates):
    """Enrich candidate month batch dicts with device counts and active family device coverage comparison."""
    if not candidates:
        return
    months = [c["month"] for c in candidates if c.get("month")]
    if not months:
        return

    try:
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
            SELECT a.month, COALESCE(zea.ZCAMERAMODEL, 'Unknown') as camera_model, COUNT(*) as cnt
            FROM assets a
            JOIN ZASSET za ON a.asset_id = za.ZUUID
            LEFT JOIN ZEXTENDEDATTRIBUTES zea ON za.ZEXTENDEDATTRIBUTES = zea.Z_PK
            WHERE a.month IN ({ph})
            GROUP BY a.month, zea.ZCAMERAMODEL
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
                        if fav_a > 0:
                            item["readiness"] = "ready"
                            item["next_step"] = f"Confirm Google Photos Curation (400 ➜ 500) — {fav_a} favorites detected"
                        elif elapsed_days is not None and elapsed_days < 3.0:
                            item["readiness"] = "cooldown"
                            item["next_step"] = f"Wait for Google AI curation ({elapsed_days:.1f}d / 3.0d elapsed)"
                        else:
                            item["readiness"] = "action_needed"
                            item["next_step"] = "Star favorites in Google Photos album or Bypass to Direct-Rank (400 ➜ 500)"
                        manual_400_candidates.append(item)
                    elif sc_str in ("500", "550"):
                        item["transition_path"] = "500 ➜ 550 (Pull Favorites) ➜ 600 (Rank & Export) ➜ 650 (Cloud Retain)"
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
                        "last_checked_utc": last_th_utc
                    },
                    "stage_counts": {
                        "M400": moment_stage_counts.get("M400", 0),
                        "M450": moment_stage_counts.get("M450", 0),
                        "M500": moment_stage_counts.get("M500", 0),
                        "needs_sync": len(mode_m_live["needs_sync_moments"]),
                        "total_moments": sum(moment_stage_counts.values()),
                        "published_moments_total": published_moments_total,
                        "published_assets_total": published_assets_total
                    },
                    "needs_sync_moments": mode_m_live["needs_sync_moments"],
                    "unassigned_total_assets": total_unassigned_assets,
                    "unassigned_total_clusters": len(unassigned_clusters),
                    "unassigned_clusters": unassigned_clusters,
                    "grouping_rules": mode_m_live["grouping_rules"],
                    "actionable_recommendations": mode_m_live["actionable_recs"][:12],
                    "disjoint_recommendations": mode_m_live["disjoint_recs"][:10]
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
                cur.execute("SELECT id FROM planned_execution WHERE planned_month = ? AND active = 1", (month,))
                existing = cur.fetchone()
                if existing:
                    cur.execute("UPDATE planned_execution SET set_at_utc = datetime('now') WHERE id = ?", (existing[0],))
                    msg = f"Updated existing queue entry for batch {month} (ID #{existing[0]})"
                else:
                    cur.execute("INSERT INTO planned_execution (planned_month, active, set_at_utc) VALUES (?, 1, datetime('now'))", (month,))
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


def _get_intake_duplicate_ids(force: bool = False) -> set[str]:
    """Computes duplicate unassigned asset IDs via Media-Intake dedup (cached 5m) instead of Photos Merge."""
    now = time.time()
    if not force and (now - _intake_dedup_cache["timestamp"] < 300.0) and _intake_dedup_cache["dup_ids"]:
        return set(_intake_dedup_cache["dup_ids"])
    scripts_dir = str(REPOS["media-organizer-pipeline"] / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    try:
        from dedup_unassigned_moments import analyze_unassigned_duplicates
        res = analyze_unassigned_duplicates(db_path=str(MEDIA_DB_PATH), use_phash=True)
        dup_ids = {d["duplicate_asset_id"] for d in res.get("duplicates", [])}
        _intake_dedup_cache["timestamp"] = now
        _intake_dedup_cache["dup_ids"] = dup_ids
        return set(dup_ids)
    except Exception:
        return set(_intake_dedup_cache["dup_ids"])


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
    reset_defaults: bool = False


@router.post("/mode-m/grouping-rules")
def update_mode_m_grouping_rules(req: GroupingRulesUpdateRequest):
    """Persist enabled/refused grouping rules and refused cluster overrides in media_organizer.db."""
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

            conn.commit()
            rules_map, refused = _load_grouping_rules_state(cur)
            return {
                "ok": True,
                "rules": rules_map,
                "refused_clusters": sorted(refused),
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
            items = [
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
                }
                for r in rows
            ]

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
                    exists = cur.execute(
                        "SELECT 1 FROM media_organizer_album_assets WHERE album_pk = ? AND asset_id = ? LIMIT 1",
                        (album_pk_out, aid),
                    ).fetchone()
                    if not exists:
                        cur.execute(
                            "INSERT INTO media_organizer_album_assets (album_pk, asset_id) VALUES (?, ?)",
                            (album_pk_out, aid),
                        )
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

            if clean_ids and parent_folder.lower() in ("moments", "curated", "tobecurated"):
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
