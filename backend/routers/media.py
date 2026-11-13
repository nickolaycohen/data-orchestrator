import os
import re
import sys
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

_cleanup_devices_cache = {
    "timestamp": 0.0,
    "payload": None
}


def _ensure_carrier_device_schema(conn: sqlite3.Connection) -> None:
    """Ensures carrier_device column and index exist on assets table."""
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(assets);")
        columns = [row[1] for row in cur.fetchall()]
        if "carrier_device" not in columns:
            cur.execute("ALTER TABLE assets ADD COLUMN carrier_device TEXT DEFAULT NULL;")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_assets_carrier_device ON assets(carrier_device);")
            conn.commit()
    except Exception as e:
        logger.warning(f"Failed to ensure carrier_device schema on assets: {e}")


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

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            _ensure_carrier_device_schema(conn)
            cur = conn.cursor()
            cur.execute("""
                WITH scored_assets AS (
                    SELECT 
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
                )
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
                ORDER BY primary_owner ASC, low_quality_gb DESC, low_quality_count DESC;
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
                    "end_date": e_date
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
    quartile: str = "all",       # "all" (Q1+Q2), "1", "2"
    media_type: str = "all",     # "all", "video", "photo"
    limit: int = 50,
    offset: int = 0
):
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"ok": False, "error": "Media database unavailable", "candidates": [], "total_count": 0}

    limit = max(1, min(limit, 250))
    offset = max(0, offset)

    quartile_cond = "score_quartile IN (1, 2)"
    if quartile == "1":
        quartile_cond = "score_quartile = 1"
    elif quartile == "2":
        quartile_cond = "score_quartile = 2"

    media_cond = ""
    if media_type == "video":
        media_cond = "AND media_type = 'video'"
    elif media_type == "photo":
        media_cond = "AND media_type = 'photo'"

    owner_cond = ""
    if owner and owner != "all":
        owner_cond = "AND primary_owner = ?"

    query = f"""
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
                ROUND(COALESCE(aaa.ZORIGINALFILESIZE, 0) / 1048576.0, 2) AS file_size_mb,
                ROUND(COALESCE(aaa.ZORIGINALFILESIZE, 0) / 1073741824.0, 3) AS file_size_gb,
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
            LEFT JOIN (
                SELECT asset_uuid, GROUP_CONCAT(DISTINCT moment_name) AS published_moments, MAX(published_at_utc) AS last_asset_pub 
                FROM publications 
                GROUP BY asset_uuid
            ) ps ON ps.asset_uuid = a.asset_id
            LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
            WHERE COALESCE(a.carrier_device, zea.ZCAMERAMODEL, 'Unknown') = ?
              AND COALESCE(a.removed_from_source, 0) = 0
        ),
        filtered AS (
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
                COUNT(*) OVER () as filtered_total_count,
                ROUND(SUM(file_size_bytes) OVER () / 1048576.0, 2) as filtered_total_mb
            FROM all_assets_with_moments
            WHERE {quartile_cond} {media_cond} {owner_cond}
        )
        SELECT * FROM filtered
        ORDER BY file_size_bytes DESC
        LIMIT ? OFFSET ?;
    """

    def _normalize_timestamp(exif_ts: Optional[str], utc_ts: Optional[str]) -> str:
        if exif_ts and len(exif_ts) >= 19:
            # Convert EXIF '2025:02:16 14:20:06' -> '2025-02-16 14:20:06'
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
            params = [camera_model]
            if owner and owner != "all":
                params.append(owner)
            params.extend([limit, offset])

            cur.execute(query, tuple(params))
            rows = cur.fetchall()

            total_count = 0
            total_mb = 0.0
            candidates = []

            for r in rows:
                total_count = r[20] or 0
                total_mb = r[21] or 0.0
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
                    "fps": fps_val
                })

            if not rows and offset > 0:
                count_params = [camera_model]
                if owner and owner != "all":
                    count_params.append(owner)
                cur.execute(f"""
                    WITH all_assets_with_moments AS (
                        SELECT 
                            a.asset_id,
                            COALESCE(do.owner_name, 'Shared/Other') AS primary_owner,
                            COALESCE(aaa.ZORIGINALFILESIZE, 0) AS file_size_bytes,
                            CASE 
                                WHEN COALESCE(za.ZKIND, 0) = 1 
                                     OR lower(a.original_filename) LIKE '%.mov' 
                                     OR lower(a.original_filename) LIKE '%.mp4' 
                                     OR lower(a.original_filename) LIKE '%.m4v' 
                                     OR lower(a.original_filename) LIKE '%.avi' 
                                THEN 'video' 
                                ELSE 'photo' 
                            END AS media_type,
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
                        LEFT JOIN ranked_assets_view v ON v.asset_id = a.asset_id
                        WHERE COALESCE(a.carrier_device, zea.ZCAMERAMODEL, 'Unknown') = ?
                          AND COALESCE(a.removed_from_source, 0) = 0
                    )
                    SELECT COUNT(*), ROUND(SUM(file_size_bytes) / 1048576.0, 2)
                    FROM all_assets_with_moments
                    WHERE {quartile_cond} {media_cond} {owner_cond}
                """, tuple(count_params))
                c_row = cur.fetchone()
                if c_row:
                    total_count = c_row[0] or 0
                    total_mb = c_row[1] or 0.0

            total_gb = round(total_mb / 1024.0, 2)

            return {
                "ok": True,
                "camera_model": camera_model,
                "owner": owner,
                "quartile": quartile,
                "media_type": media_type,
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


def _parse_mode_m_logs(log_dir: Path):
    """Parse publishing_recommendations.log, publishing_candidates.log, and curation_threshold_status.log."""
    actionable_recs = []
    disjoint_recs = []
    needs_sync_moments = []
    unassigned_clusters = []
    threshold_aligned = True
    current_threshold = None
    historical_min = None

    thresh_log = log_dir / "curation_threshold_status.log"
    if thresh_log.exists():
        try:
            text = thresh_log.read_text(encoding="utf-8", errors="replace")
            m_cur = re.search(r"Current dynamic threshold:\s+(\d+\.\d+)", text)
            m_min = re.search(r"Historical minimum target:\s+(\d+\.\d+)", text)
            if m_cur:
                current_threshold = float(m_cur.group(1))
            if m_min:
                historical_min = float(m_min.group(1))
            if "Threshold aligned" in text:
                threshold_aligned = True
            elif current_threshold is not None and historical_min is not None:
                threshold_aligned = current_threshold <= (historical_min + 1e-4)

            cur_cluster = None
            for raw_line in text.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                m_hdr = re.match(
                    r"^\[\s*(\d+)\]\s*📁\s*(.+?)\s+\[(.+?)\]\s+—\s*(\d+)\s*asset\(s\)\s*\|\s*Score:\s*([^|]+?)\s*\|\s*Month\(s\):\s*(.+)$",
                    line
                )
                if m_hdr:
                    score_span_str = m_hdr.group(5).strip()
                    score_parts = score_span_str.split()
                    max_sc = float(score_parts[0]) if score_parts else 0.0
                    min_sc = float(score_parts[-1]) if len(score_parts) >= 3 else max_sc
                    cur_cluster = {
                        "orig_rank": int(m_hdr.group(1)),
                        "folder": m_hdr.group(2).strip(),
                        "group_type": m_hdr.group(3).strip(),
                        "asset_count": int(m_hdr.group(4)),
                        "score_span": score_span_str,
                        "max_score": max_sc,
                        "min_score": min_sc,
                        "months": m_hdr.group(6).strip(),
                        "assets": []
                    }
                    unassigned_clusters.append(cur_cluster)
                    continue

                if cur_cluster is not None and line.startswith("•"):
                    m_ast = re.match(
                        r"^•\s*(.+?)\s*\|\s*Score:\s*(\d+\.\d+)\s*\|\s*Captured:\s*([^|]+?)\s*\|\s*Month:\s*(\d{4}-\d{2})(?:\s+\((.+)\))?$",
                        line
                    )
                    if m_ast:
                        cur_cluster["assets"].append({
                            "original_filename": m_ast.group(1).strip(),
                            "score_normalized": float(m_ast.group(2)),
                            "capture_timestamp": m_ast.group(3).strip(),
                            "month": m_ast.group(4).strip(),
                            "notes": (m_ast.group(5) or "").strip()
                        })
        except Exception:
            pass

    rec_log = log_dir / "publishing_recommendations.log"
    if rec_log.exists():
        try:
            in_disjoint = False
            for raw_line in rec_log.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                if "Disjoint Moments (Need Merge)" in line:
                    in_disjoint = True
                    continue
                m = re.match(
                    r"^(\d+)\s+(.+?)\s+(\d+\.\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(Republish:.*?\)|Publish .*?\)|Publish Whole Album|Disjoint:.*?\))\s+(.+)$",
                    line
                )
                if m:
                    item = {
                        "idx": int(m.group(1)),
                        "moment_name": m.group(2).strip(),
                        "avg_score": float(m.group(3)),
                        "files": int(m.group(4)),
                        "published": int(m.group(5)),
                        "recommended": int(m.group(6)),
                        "action": m.group(7).strip(),
                        "details": m.group(8).strip()
                    }
                    if in_disjoint or item["action"].startswith("Disjoint"):
                        disjoint_recs.append(item)
                    else:
                        actionable_recs.append(item)
        except Exception:
            pass

    cand_log = log_dir / "publishing_candidates.log"
    if cand_log.exists():
        try:
            in_needs_update = False
            for raw_line in cand_log.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw_line.strip()
                if "Moments Requiring Curation Updates" in line:
                    in_needs_update = True
                    continue
                if "Up-To-Date Moments" in line:
                    in_needs_update = False
                    break
                if in_needs_update:
                    m = re.match(
                        r"^(\d+)\s+(.+?)\s+(M\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+)\s+(\S+)",
                        line
                    )
                    if m:
                        needs_sync_moments.append({
                            "idx": int(m.group(1)),
                            "moment_name": m.group(2).strip(),
                            "stage": m.group(3),
                            "rank_score": float(m.group(4)),
                            "avg_score": float(m.group(5)),
                            "assets": int(m.group(8)),
                            "published": m.group(9)
                        })
        except Exception:
            pass

    return {
        "threshold_aligned": threshold_aligned,
        "current_threshold": current_threshold,
        "historical_min": historical_min,
        "actionable_recs": actionable_recs,
        "disjoint_recs": disjoint_recs,
        "needs_sync_moments": needs_sync_moments,
        "unassigned_clusters": unassigned_clusters
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
def get_planner_overview():
    """Return comprehensive next-step overview for Mode [B] Batch Management and Mode [M] Memory Feature & Publishing."""
    if not MEDIA_DB_PATH or not MEDIA_DB_PATH.exists():
        return {"connected": False, "error": "Media database unavailable"}

    try:
        conn = sqlite3.connect(str(MEDIA_DB_PATH), timeout=30)
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            cur = conn.cursor()
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

            # -----------------------------------------------------------------
            # 2. Mode [M]: Memory Feature & Publishing Overview & Next Steps
            # -----------------------------------------------------------------
            cur.execute("SELECT MIN(threshold_score) FROM threshold_history WHERE threshold_score > 0.0")
            min_th_row = cur.fetchone()
            db_hist_min = round(min_th_row[0], 4) if min_th_row and min_th_row[0] else 0.5315

            cur.execute("SELECT threshold_score, threshold_met, recorded_at_utc FROM threshold_history ORDER BY id DESC LIMIT 1")
            last_th_row = cur.fetchone()
            db_curr_th = round(last_th_row[0], 4) if last_th_row and last_th_row[0] else db_hist_min
            db_th_met = bool(last_th_row[1]) if last_th_row and last_th_row[1] is not None else True
            last_th_utc = last_th_row[2] if last_th_row else None

            cur.execute("SELECT memory_stage, COUNT(*) FROM curated_moments GROUP BY memory_stage")
            moment_stage_counts = {r[0]: r[1] for r in cur.fetchall()}

            cur.execute("SELECT COUNT(DISTINCT moment_name), COUNT(DISTINCT asset_uuid) FROM publications")
            pub_totals = cur.fetchone()
            published_moments_total = pub_totals[0] if pub_totals else 0
            published_assets_total = pub_totals[1] if pub_totals else 0

            log_dir = MEDIA_DB_PATH.resolve().parent.parent / "logs"
            parsed_logs = _parse_mode_m_logs(log_dir)

            curr_thresh = parsed_logs["current_threshold"] if parsed_logs["current_threshold"] is not None else db_curr_th
            hist_min = parsed_logs["historical_min"] if parsed_logs["historical_min"] is not None else db_hist_min
            thresh_aligned = parsed_logs["threshold_aligned"] if parsed_logs["current_threshold"] is not None else db_th_met

            # Enrich unassigned high-rank clusters with asset_id and ZASSET metadata for previews
            unassigned_clusters = parsed_logs.get("unassigned_clusters", [])
            if unassigned_clusters:
                floor_sc = max(0.50, (hist_min or 0.5315) - 0.01)
                cur.execute("""
                    SELECT v.asset_id, v.original_filename, ROUND(v.score_normalized, 4) as score, v.month, v.date_created_utc
                    FROM ranked_assets_view v
                    JOIN month_batches mb ON v.month = mb.month
                    WHERE mb.status_code >= '600'
                      AND (v.MomentsAlbumName IS NULL OR v.MomentsAlbumName = '')
                      AND v.score_normalized >= ?
                    ORDER BY v.score_normalized DESC
                """, (floor_sc,))
                base_unassigned = cur.fetchall()
                u_aids = [r[0] for r in base_unassigned]
                u_meta = {}
                if u_aids:
                    ph_u = ",".join("?" for _ in u_aids)
                    cur.execute(f"""
                        SELECT 
                            za.ZUUID,
                            COALESCE(za.ZKIND, 0),
                            ROUND(COALESCE(za.ZDURATION, zea.ZDURATION, 0.0), 2),
                            COALESCE(aaa.ZORIGINALWIDTH, za.ZWIDTH, 0),
                            COALESCE(aaa.ZORIGINALHEIGHT, za.ZHEIGHT, 0),
                            ROUND(COALESCE(zea.ZFPS, 0.0), 1),
                            ROUND(COALESCE(aaa.ZORIGINALFILESIZE, 0) / 1048576.0, 2),
                            COALESCE(aaa.ZORIGINALFILESIZE, 0),
                            COALESCE(zea.ZCAMERAMODEL, 'Unknown'),
                            COALESCE(do.owner_name, 'Shared/Other')
                        FROM ZASSET za
                        LEFT JOIN ZADDITIONALASSETATTRIBUTES aaa ON aaa.Z_PK = za.ZADDITIONALATTRIBUTES
                        LEFT JOIN ZEXTENDEDATTRIBUTES zea ON zea.Z_PK = za.ZEXTENDEDATTRIBUTES
                        LEFT JOIN device_owners do ON do.camera_model = zea.ZCAMERAMODEL
                            AND (do.start_date IS NULL OR do.start_date <= date(za.ZDATECREATED + 978307200, 'unixepoch'))
                            AND (do.end_date IS NULL OR do.end_date >= date(za.ZDATECREATED + 978307200, 'unixepoch'))
                        WHERE za.ZUUID IN ({ph_u})
                    """, u_aids)
                    for mr in cur.fetchall():
                        u_meta[mr[0]] = mr

                by_fn_month = {}
                by_month = {}
                for aid, fn, sc, mo, dt in base_unassigned:
                    key = ((fn or "").lower(), mo)
                    by_fn_month.setdefault(key, []).append((aid, fn, sc, mo, dt))
                    by_month.setdefault(mo, []).append((aid, fn, sc, mo, dt))

                used_aids = set()
                for c in unassigned_clusters:
                    for a in c["assets"]:
                        fn_lower = (a["original_filename"] or "").lower()
                        key = (fn_lower, a["month"])
                        cands = by_fn_month.get(key, [])
                        chosen = None
                        if cands:
                            unused = [x for x in cands if x[0] not in used_aids]
                            pool = unused if unused else cands
                            pool.sort(key=lambda x: abs(x[2] - a["score_normalized"]))
                            chosen = pool[0]
                        else:
                            m_cands = by_month.get(a["month"], [])
                            if m_cands:
                                m_cands.sort(key=lambda x: abs(x[2] - a["score_normalized"]))
                                chosen = m_cands[0]

                        if chosen:
                            aid, full_fn, _, _, dt_utc = chosen
                            used_aids.add(aid)
                            m_info = u_meta.get(aid)
                            zkind = m_info[1] if m_info else 0
                            is_vid = zkind == 1 or full_fn.lower().endswith((".mov", ".mp4", ".m4v", ".avi", ".mpg"))
                            a["asset_id"] = aid
                            a["original_filename"] = full_fn
                            a["date_created_utc"] = dt_utc or a["capture_timestamp"]
                            a["media_type"] = "video" if is_vid else "photo"
                            a["duration_sec"] = m_info[2] if m_info else 0.0
                            a["width"] = m_info[3] if m_info else 0
                            a["height"] = m_info[4] if m_info else 0
                            a["fps"] = m_info[5] if m_info else 0.0
                            a["file_size_mb"] = m_info[6] if m_info else 0.0
                            a["file_size_bytes"] = m_info[7] if m_info else 0
                            a["camera_model"] = m_info[8] if m_info else "Unknown"
                            a["primary_owner"] = m_info[9] if m_info else "Shared/Other"
                            a["assigned_moment"] = f"Proposed: {c['folder']}"

                # Sort clusters by cluster size descending, then max_score descending
                unassigned_clusters.sort(key=lambda g: (-len(g["assets"]), -g["max_score"], g["folder"]))

            total_unassigned_assets = sum(len(c["assets"]) for c in unassigned_clusters)

            # Enrich candidate batches with device summary vs active family devices
            top_000_batches = pipeline_000_candidates[:8]
            _enrich_batch_candidates_with_devices(cur, top_000_batches)
            if manual_400_candidates:
                _enrich_batch_candidates_with_devices(cur, manual_400_candidates)
            if pipeline_500_candidates:
                _enrich_batch_candidates_with_devices(cur, pipeline_500_candidates)

            return {
                "connected": True,
                "mode_b": {
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
                },
                "mode_m": {
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
                        "needs_sync": len(parsed_logs["needs_sync_moments"]),
                        "total_moments": sum(moment_stage_counts.values()),
                        "published_moments_total": published_moments_total,
                        "published_assets_total": published_assets_total
                    },
                    "needs_sync_moments": parsed_logs["needs_sync_moments"],
                    "unassigned_total_assets": total_unassigned_assets,
                    "unassigned_total_clusters": len(unassigned_clusters),
                    "unassigned_clusters": unassigned_clusters,
                    "actionable_recommendations": parsed_logs["actionable_recs"][:12],
                    "disjoint_recommendations": parsed_logs["disjoint_recs"][:10]
                }
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
