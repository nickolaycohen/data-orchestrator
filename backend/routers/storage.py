from fastapi import APIRouter
from backend.config import DRIVE_AUDIT_DB_PATH, SHARED_RULES_DB_PATH, get_db_connection

router = APIRouter(prefix="/api/storage", tags=["storage"])

@router.get("/metrics")
def get_storage_metrics():
    drive_conn = get_db_connection(DRIVE_AUDIT_DB_PATH)
    rules_conn = get_db_connection(SHARED_RULES_DB_PATH)
    
    result = {
        "connected": False,
        "total_files": 0,
        "total_size_gb": 0,
        "total_directories": 0,
        "tags": [],
        "priority_tiers": [
            {
                "tier": "Priority 1",
                "color": "crimson",
                "label": "Active Personal & Financial DBs",
                "tag": "priority 1",
                "description": "Vital records, Quicken DBs, active tax returns, personal master archives."
            },
            {
                "tier": "Priority 2",
                "color": "dodgerblue",
                "label": "Systems & Dev Environments",
                "tag": "priority 2",
                "description": "User profiles, SDKs, developer environments, utilities & binaries."
            },
            {
                "tier": "Priority 3",
                "color": "purple",
                "label": "Historical & Archival Media",
                "tag": "priority 3",
                "description": "Long-term documents, cold archival data, foreign legacy media."
            },
            {
                "tier": "Priority 4",
                "color": "goldenrod",
                "label": "Media Organizer Intake Depot",
                "tag": "priority 4",
                "description": "Photos & Home Videos awaiting triage and Apple Photos ingestion."
            },
            {
                "tier": "Review",
                "color": "gray",
                "label": "Needs Inspection",
                "tag": "legacy",
                "description": "Ambiguous legacy restores requiring human-in-the-loop review."
            },
            {
                "tier": "Purge",
                "color": "darkorange",
                "label": "Proposed Purge",
                "tag": "purge",
                "description": "Disposable OS/app caches (Thumbs.db, imgCache) staged for sign-off."
            }
        ],
        "rules": [],
        "recent_files": []
    }
    
    if drive_conn:
        try:
            result["connected"] = True
            cur = drive_conn.cursor()
            
            # File count and total size
            cur.execute("SELECT count(*), coalesce(sum(size_bytes), 0) FROM files")
            f_row = cur.fetchone()
            result["total_files"] = f_row[0]
            result["total_size_gb"] = round(f_row[1] / (1024**3), 2)
            
            # Directory count
            cur.execute("SELECT count(*) FROM directories")
            result["total_directories"] = cur.fetchone()[0]
            
            # Tags breakdown
            cur.execute("""
                SELECT tag_name, count(*) as count 
                FROM directory_tags 
                GROUP BY tag_name 
                ORDER BY count DESC
            """)
            result["tags"] = [{"tag": r["tag_name"], "count": r["count"]} for r in cur.fetchall()]
            
            # Priority locations
            cur.execute("SELECT priority_tier, path, label, description FROM priority_locations")
            result["locations"] = [dict(r) for r in cur.fetchall()]

            # Sample large files
            cur.execute("""
                SELECT name, category, extension, size_bytes 
                FROM files 
                ORDER BY size_bytes DESC LIMIT 6
            """)
            result["recent_files"] = [
                {
                    "name": r["name"],
                    "category": r["category"],
                    "ext": r["extension"],
                    "size_mb": round(r["size_bytes"] / (1024**2), 1)
                } for r in cur.fetchall()
            ]
        except Exception as e:
            result["error"] = str(e)
        finally:
            drive_conn.close()

    if rules_conn:
        try:
            rcur = rules_conn.cursor()
            rcur.execute("SELECT id, name, device_pattern, path_pattern, category, description, priority_tier FROM storage_rules")
            result["rules"] = [dict(r) for r in rcur.fetchall()]
        except Exception:
            pass
        finally:
            rules_conn.close()
            
    return result
