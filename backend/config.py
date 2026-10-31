import os
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional

BASE_DIR = Path(__file__).resolve().parent.parent

# Paths to the 4 underlying repositories (checks submodule first, then sibling folder)
def resolve_repo_path(repo_name: str) -> Path:
    submodule_path = BASE_DIR / "submodules" / repo_name
    sibling_path = BASE_DIR.parent / repo_name
    if submodule_path.exists() and any(submodule_path.iterdir()):
        return submodule_path
    if sibling_path.exists():
        return sibling_path
    return submodule_path

REPOS = {
    "media-organizer-pipeline": resolve_repo_path("media-organizer-pipeline"),
    "drive-audit-cli": resolve_repo_path("drive-audit-cli"),
    "idrive-audit": resolve_repo_path("idrive-audit"),
    "gmail-cleanup-planner": resolve_repo_path("gmail-cleanup-planner"),
}

# Resolve SQLite databases with live fallback
def resolve_db_path(primary: Path, fallbacks: list[Path]) -> Optional[Path]:
    if primary.exists() and primary.stat().st_size > 0:
        return primary
    for fb in fallbacks:
        if fb.exists() and fb.stat().st_size > 0:
            return fb
    return primary if primary.exists() else (fallbacks[0] if fallbacks else None)

MEDIA_DB_PATH = resolve_db_path(
    REPOS["media-organizer-pipeline"] / "db" / "media_organizer.db",
    [
        BASE_DIR.parent / "media-organizer-pipeline" / "db" / "media_organizer.db",
        REPOS["media-organizer-pipeline"] / "media_organizer.db",
    ]
)

DRIVE_AUDIT_DB_PATH = resolve_db_path(
    Path("/Volumes/Extreme Pro/Data/sqlite/drive-audit/drive_audit.db"),
    [
        REPOS["drive-audit-cli"] / "db" / "drive_audit.db",
        BASE_DIR.parent / "drive-audit-cli" / "db" / "drive_audit.db",
        REPOS["drive-audit-cli"] / "drive_audit.db",
    ]
)

SHARED_RULES_DB_PATH = resolve_db_path(
    REPOS["drive-audit-cli"] / "shared_storage_rules.db",
    [
        BASE_DIR.parent / "drive-audit-cli" / "shared_storage_rules.db",
    ]
)

DEVICE_REGISTRY_DB_PATH = resolve_db_path(
    REPOS["idrive-audit"] / "device_registry.db",
    [
        BASE_DIR.parent / "idrive-audit" / "device_registry.db",
    ]
)

IDRIVE_AUDIT_DB_PATH = resolve_db_path(
    REPOS["idrive-audit"] / "idrive_audit.db",
    [
        BASE_DIR.parent / "idrive-audit" / "idrive_audit.db",
    ]
)

def get_db_connection(db_path: Optional[Path]):
    if not db_path or not db_path.exists():
        return None
    try:
        # Open in URI read-only mode to prevent write locking
        uri = f"file:{db_path.resolve()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        try:
            conn = sqlite3.connect(str(db_path), timeout=5)
            conn.row_factory = sqlite3.Row
            return conn
        except Exception:
            return None

def get_git_info(repo_path: Path) -> Dict[str, Any]:
    if not repo_path.exists() or not (repo_path / ".git").exists():
        return {"exists": repo_path.exists(), "is_git": False, "branch": "unknown", "commit": "", "dirty": False}
    try:
        branch = subprocess.check_output(
            ["git", "-C", str(repo_path), "branch", "--show-current"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        commit = subprocess.check_output(
            ["git", "-C", str(repo_path), "rev-parse", "--short", "HEAD"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        status = subprocess.check_output(
            ["git", "-C", str(repo_path), "status", "--porcelain"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        return {
            "exists": True,
            "is_git": True,
            "branch": branch or "detached",
            "commit": commit,
            "dirty": len(status) > 0,
            "path": str(repo_path)
        }
    except Exception as e:
        return {"exists": True, "is_git": True, "branch": "error", "commit": "", "dirty": False, "error": str(e)}

def get_mount_stats() -> list[Dict[str, Any]]:
    mounts = [
        {"name": "Canonical Storage (LaCie)", "path": "/Volumes/LaCie"},
        {"name": "Active DB Disk (Extreme Pro)", "path": "/Volumes/Extreme Pro"},
        {"name": "Duplicate Triage (DELL1TB02)", "path": "/Volumes/DELL1TB02"},
        {"name": "Secondary Storage (asd)", "path": "/Volumes/asd"},
        {"name": "Host System Root (/)", "path": "/"},
    ]
    results = []
    for m in mounts:
        p = Path(m["path"])
        if p.exists():
            try:
                stat = shutil.disk_usage(str(p))
                total_gb = round(stat.total / (1024**3), 1)
                used_gb = round(stat.used / (1024**3), 1)
                free_gb = round(stat.free / (1024**3), 1)
                pct_used = round((stat.used / stat.total) * 100, 1) if stat.total > 0 else 0
                results.append({
                    "name": m["name"],
                    "path": m["path"],
                    "mounted": True,
                    "total_gb": total_gb,
                    "used_gb": used_gb,
                    "free_gb": free_gb,
                    "pct_used": pct_used
                })
            except Exception:
                results.append({
                    "name": m["name"],
                    "path": m["path"],
                    "mounted": True,
                    "error": "Failed to read stat"
                })
        else:
            results.append({
                "name": m["name"],
                "path": m["path"],
                "mounted": False
            })
    return results
