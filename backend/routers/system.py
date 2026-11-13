import os
from fastapi import APIRouter
from backend.config import (
    REPOS, get_git_info, get_mount_stats,
    MEDIA_DB_PATH, DRIVE_AUDIT_DB_PATH,
    SHARED_RULES_DB_PATH, DEVICE_REGISTRY_DB_PATH, IDRIVE_AUDIT_DB_PATH
)

router = APIRouter(prefix="/api/system", tags=["system"])

@router.get("/status")
def get_system_status():
    mounts = get_mount_stats()
    
    # Submodules status
    submodules_status = {}
    for name, path in REPOS.items():
        submodules_status[name] = get_git_info(path)
        
    # Database status
    dbs = {
        "media_organizer": {
            "name": "Media Organizer DB",
            "path": str(MEDIA_DB_PATH) if MEDIA_DB_PATH else None,
            "connected": MEDIA_DB_PATH.exists() and MEDIA_DB_PATH.stat().st_size > 0 if MEDIA_DB_PATH else False,
            "size_mb": round(MEDIA_DB_PATH.stat().st_size / (1024**2), 1) if MEDIA_DB_PATH and MEDIA_DB_PATH.exists() else 0
        },
        "drive_audit": {
            "name": "Drive Audit Master DB",
            "path": str(DRIVE_AUDIT_DB_PATH) if DRIVE_AUDIT_DB_PATH else None,
            "connected": DRIVE_AUDIT_DB_PATH.exists() and DRIVE_AUDIT_DB_PATH.stat().st_size > 0 if DRIVE_AUDIT_DB_PATH else False,
            "size_mb": round(DRIVE_AUDIT_DB_PATH.stat().st_size / (1024**2), 1) if DRIVE_AUDIT_DB_PATH and DRIVE_AUDIT_DB_PATH.exists() else 0
        },
        "shared_rules": {
            "name": "Shared Storage Rules DB",
            "path": str(SHARED_RULES_DB_PATH) if SHARED_RULES_DB_PATH else None,
            "connected": SHARED_RULES_DB_PATH.exists() and SHARED_RULES_DB_PATH.stat().st_size > 0 if SHARED_RULES_DB_PATH else False,
            "size_mb": round(SHARED_RULES_DB_PATH.stat().st_size / (1024**2), 1) if SHARED_RULES_DB_PATH and SHARED_RULES_DB_PATH.exists() else 0
        },
        "device_registry": {
            "name": "IDrive Device Registry DB",
            "path": str(DEVICE_REGISTRY_DB_PATH) if DEVICE_REGISTRY_DB_PATH else None,
            "connected": DEVICE_REGISTRY_DB_PATH.exists() and DEVICE_REGISTRY_DB_PATH.stat().st_size > 0 if DEVICE_REGISTRY_DB_PATH else False,
            "size_mb": round(DEVICE_REGISTRY_DB_PATH.stat().st_size / (1024**2), 1) if DEVICE_REGISTRY_DB_PATH and DEVICE_REGISTRY_DB_PATH.exists() else 0
        },
    }

    # Auth & Tokens
    idrive_cookie_path = REPOS["idrive-audit"] / ".idrive_cookie"
    drive_cookie_path = REPOS["drive-audit-cli"] / ".idrive_cookie"
    has_idrive_cookie = (idrive_cookie_path.exists() and idrive_cookie_path.stat().st_size > 10) or \
                        (drive_cookie_path.exists() and drive_cookie_path.stat().st_size > 10)
    
    gmail_token_path = REPOS["gmail-cleanup-planner"] / "token.json"
    gmail_creds_path = REPOS["gmail-cleanup-planner"] / "credentials.json"
    has_gmail_token = gmail_token_path.exists() and gmail_token_path.stat().st_size > 20
    has_gmail_creds = gmail_creds_path.exists() and gmail_creds_path.stat().st_size > 20

    # Alerts & recommendations
    alerts = []
    lacie_mount = next((m for m in mounts if m["path"] == "/Volumes/LaCie"), None)
    if not lacie_mount or not lacie_mount.get("mounted"):
        alerts.append({
            "level": "warning",
            "title": "LaCie Volume Unmounted",
            "message": "Canonical storage target /Volumes/LaCie is not currently mounted."
        })
    elif lacie_mount.get("pct_used", 0) > 85:
        alerts.append({
            "level": "warning",
            "title": "LaCie Storage High",
            "message": f"Storage is at {lacie_mount.get('pct_used')}% capacity."
        })

    extreme_mount = next((m for m in mounts if m["path"] == "/Volumes/Extreme Pro"), None)
    if not extreme_mount or not extreme_mount.get("mounted"):
        alerts.append({
            "level": "warning",
            "title": "Extreme Pro Disk Unmounted",
            "message": "Primary SQLite drive_audit.db volume is not mounted."
        })

    if not has_idrive_cookie:
        alerts.append({
            "level": "info",
            "title": "IDrive Session Cookie",
            "message": "IDrive EVS session cookie (.idrive_cookie) requires update for cloud queries."
        })

    if not has_gmail_token:
        alerts.append({
            "level": "info",
            "title": "Gmail OAuth Token",
            "message": "Gmail token.json needs authentication before planner report can fetch mail."
        })

    return {
        "status": "healthy",
        "mounts": mounts,
        "submodules": submodules_status,
        "databases": dbs,
        "auth": {
            "idrive_cookie": has_idrive_cookie,
            "gmail_token": has_gmail_token,
            "gmail_creds": has_gmail_creds
        },
        "alerts": alerts
    }

@router.post("/open-image-capture")
def open_image_capture():
    import subprocess
    try:
        subprocess.run(["open", "-a", "Image Capture"], check=True)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@router.post("/reveal-path")
def reveal_path(payload: dict):
    import subprocess
    target = payload.get("path")
    if not target:
        return {"ok": False, "error": "No path provided"}
    try:
        # Create directory if it doesn't exist yet so Finder can reveal it
        os.makedirs(target, exist_ok=True)
        subprocess.run(["open", target], check=True)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

