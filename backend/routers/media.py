from fastapi import APIRouter
from backend.config import MEDIA_DB_PATH, get_db_connection

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
