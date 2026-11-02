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
from pydantic import BaseModel
from fastapi import APIRouter
from backend.config import MEDIA_DB_PATH, REPOS, get_db_connection

router = APIRouter(prefix="/api/media", tags=["media"])

class BgServiceControlRequest(BaseModel):
    action: str  # "start" or "stop"

class PublishedUrlUpdateRequest(BaseModel):
    moment_name: str
    shutterfly_url: Optional[str] = None
    youtube_url: Optional[str] = None

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
        
        # Month batches
        cur.execute("SELECT count(*), sum(assets_count) FROM month_batches")
        batches_row = cur.fetchone()
        month_batches_count = batches_row[0]
        batch_assets_count = batches_row[1] or 0
        
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
                "triage_saved_gb": round(triage_bytes / (1024**3), 2)
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
