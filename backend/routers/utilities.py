import os
import re
from pathlib import Path
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from backend.config import REPOS, BASE_DIR

router = APIRouter(prefix="/api/utilities", tags=["utilities"])

class DirectoryValidationRequest(BaseModel):
    source: str
    destination: str

def _get_merge_log_files() -> List[Path]:
    log_candidates = [
        REPOS["media-organizer-pipeline"] / "logs" / "merge_directories.log",
        BASE_DIR / "submodules" / "media-organizer-pipeline" / "logs" / "merge_directories.log",
        BASE_DIR.parent / "media-organizer-pipeline" / "logs" / "merge_directories.log",
        Path("/Users/nickolaycohen/dev/media-organizer-pipeline/logs/merge_directories.log"),
    ]
    existing = []
    seen = set()
    for p in log_candidates:
        try:
            resolved = p.resolve()
            if resolved.exists() and resolved not in seen:
                seen.add(resolved)
                existing.append(resolved)
        except Exception:
            if p.exists() and p not in seen:
                seen.add(p)
                existing.append(p)
    return existing

@router.get("/merge-log")
def get_merge_log(tail_lines: int = Query(250, ge=10, le=5000)):
    log_files = _get_merge_log_files()

    if not log_files:
        return {
            "exists": False,
            "path": "logs/merge_directories.log",
            "size_bytes": 0,
            "size_formatted": "0 B",
            "modified": "—",
            "lines": [],
            "raw": "",
            "summary": {
                "last_run": None
            }
        }

    # Sort files chronologically by mtime (older first, newest last)
    sorted_files = sorted(log_files, key=lambda f: f.stat().st_mtime)
    newest_file = sorted_files[-1]
    newest_stat = newest_file.stat()
    newest_mod_str = datetime.fromtimestamp(newest_stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")

    # Read lines from all files and deduplicate chronologically
    combined_lines = []
    seen_lines = set()

    for p in sorted_files:
        try:
            size_bytes = p.stat().st_size
            read_bytes = min(size_bytes, 4 * 1024 * 1024)
            with open(p, "rb") as f:
                if size_bytes > read_bytes:
                    f.seek(size_bytes - read_bytes)
                raw_bytes = f.read()
            lines = raw_bytes.decode("utf-8", errors="replace").splitlines()
            if size_bytes > read_bytes and lines:
                lines = lines[1:]  # drop partial line
            for line in lines:
                if line not in seen_lines:
                    seen_lines.add(line)
                    combined_lines.append(line)
        except Exception:
            pass

    tail = combined_lines[-tail_lines:] if tail_lines and len(combined_lines) > tail_lines else combined_lines

    last_run = None
    for line in reversed(combined_lines[-100:]):
        if "Merge Finished in" in line:
            last_run = line.strip()
            break
        elif "Starting Directory Merge:" in line and not last_run:
            last_run = line.strip()
            break

    # Total size across all log sources
    total_size = sum(f.stat().st_size for f in sorted_files)
    sz = float(total_size)
    for unit in ['B', 'KB', 'MB', 'GB']:
        if sz < 1024.0:
            sz_fmt = f"{sz:.1f} {unit}"
            break
        sz /= 1024.0
    else:
        sz_fmt = f"{sz:.1f} TB"

    return {
        "exists": True,
        "path": str(newest_file),
        "size_bytes": total_size,
        "size_formatted": sz_fmt,
        "modified": newest_mod_str,
        "line_count": len(combined_lines),
        "lines": tail,
        "raw": "\n".join(tail),
        "summary": {
            "last_run": last_run
        }
    }

def clean_path_str(p: Optional[str]) -> str:
    if not p:
        return ""
    p = p.strip()
    while (p.startswith("'") and p.endswith("'")) or (p.startswith('"') and p.endswith('"')):
        p = p[1:-1].strip()
    return p.strip("'\"").strip()

@router.post("/validate-directories")
def validate_directories(req: DirectoryValidationRequest):
    src = clean_path_str(req.source)
    dst = clean_path_str(req.destination)

    src_path = Path(src) if src else None
    dst_path = Path(dst) if dst else None

    src_res = {
        "provided": bool(src),
        "exists": src_path.exists() if src_path else False,
        "is_dir": src_path.is_dir() if (src_path and src_path.exists()) else False,
        "readable": os.access(src_path, os.R_OK) if (src_path and src_path.exists()) else False,
        "writable": os.access(src_path, os.W_OK) if (src_path and src_path.exists()) else False,
    }

    dst_res = {
        "provided": bool(dst),
        "exists": dst_path.exists() if dst_path else False,
        "is_dir": dst_path.is_dir() if (dst_path and dst_path.exists()) else False,
        "writable": os.access(dst_path, os.W_OK) if (dst_path and dst_path.exists()) else False,
        "parent_exists": dst_path.parent.exists() if dst_path else False,
    }

    same_dir = False
    if src_path and dst_path and src_path.exists() and dst_path.exists():
        try:
            same_dir = src_path.resolve() == dst_path.resolve()
        except Exception:
            pass

    return {
        "source": src_res,
        "destination": dst_res,
        "same_directory": same_dir,
        "ready": src_res["exists"] and src_res["is_dir"] and dst_res["provided"] and not same_dir
    }
