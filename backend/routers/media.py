import os
import re
import errno
from pathlib import Path
from datetime import datetime
from fastapi import APIRouter
from backend.config import MEDIA_DB_PATH, REPOS, get_db_connection

router = APIRouter(prefix="/api/media", tags=["media"])

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

    # 4. Tail Log & parse progress
    log_candidates = [sibling_repo / "logs" / "media_organizer.log", pipe_repo / "logs" / "media_organizer.log"]
    current_step = "—"
    upload_progress = None
    upload_details = None
    log_lines = []
    for lp in log_candidates:
        if lp.exists():
            try:
                lines = lp.read_text(encoding="utf-8", errors="replace").splitlines()[-120:]
                log_lines = [l for l in lines[-8:] if l.strip()]
                live_asset_ratio = None
                for line in reversed(lines):
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
                break
            except Exception:
                pass

    schedule_items = [
        {"time": "03:00 AM", "title": "macOS Time Machine Backup", "command": "tmutil startbackup", "target": "Local & External Disks"},
        {"time": "05:30 AM", "title": "Apple Photos Albums Backup", "command": "reconstruct_apple_albums.py --backup", "target": "Album Manifest DB"},
        {"time": "06:00 AM", "title": "SQLite Master Hot Backup", "command": "backup_database.py", "target": "media_organizer.db.gz"}
    ]

    return {
        "timestamp": now_str,
        "executor": {
            "is_running": is_running,
            "pid": pid,
            "status": status,
            "status_banner": f"ACTIVE (PID: {pid})" if is_running else ("STALE (PID: {pid})" if status == "STALE" else "IDLE")
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
        }
    }
