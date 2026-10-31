from fastapi import APIRouter
from backend.config import DEVICE_REGISTRY_DB_PATH, IDRIVE_AUDIT_DB_PATH, REPOS, get_db_connection

router = APIRouter(prefix="/api/idrive", tags=["idrive"])

@router.get("/metrics")
def get_idrive_metrics():
    reg_conn = get_db_connection(DEVICE_REGISTRY_DB_PATH)
    audit_conn = get_db_connection(IDRIVE_AUDIT_DB_PATH)
    
    # Cookie check
    cookie_file = REPOS["idrive-audit"] / ".idrive_cookie"
    cookie_exists = cookie_file.exists() and cookie_file.stat().st_size > 10
    cookie_mtime = cookie_file.stat().st_mtime if cookie_file.exists() else None

    result = {
        "connected": False,
        "cookie_valid": cookie_exists,
        "cookie_mtime": cookie_mtime,
        "devices": [],
        "policies": [],
        "priorities": [],
        "api_calls_count": 0
    }

    if reg_conn:
        try:
            result["connected"] = True
            cur = reg_conn.cursor()
            
            cur.execute("SELECT device_id, device_name, device_type, capacity_bytes, last_seen FROM devices")
            result["devices"] = [
                {
                    "id": r["device_id"],
                    "name": r["device_name"],
                    "type": r["device_type"],
                    "capacity_tb": round(r["capacity_bytes"] / (1024**4), 2) if r["capacity_bytes"] else 0,
                    "last_seen": r["last_seen"]
                }
                for r in cur.fetchall()
            ]

            cur.execute("SELECT policy_id, policy_name FROM backup_policies")
            result["policies"] = [dict(r) for r in cur.fetchall()]

            cur.execute("SELECT priority_id, priority_name, backup_policy_id FROM folder_priorities")
            result["priorities"] = [dict(r) for r in cur.fetchall()]
        except Exception as e:
            result["error"] = str(e)
        finally:
            reg_conn.close()

    if audit_conn:
        try:
            acur = audit_conn.cursor()
            acur.execute("SELECT count(*) FROM api_calls")
            result["api_calls_count"] = acur.fetchone()[0]
        except Exception:
            pass
        finally:
            audit_conn.close()

    return result
