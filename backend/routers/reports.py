import os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from backend.config import REPOS

router = APIRouter(prefix="/api/reports", tags=["reports"])

@router.get("/list")
def list_reports():
    reports = []
    
    # 1. Drive Audit docs & reports
    drive_docs = REPOS["drive-audit-cli"] / "docs"
    if drive_docs.exists():
        for f in drive_docs.glob("*.md"):
            reports.append({
                "id": f"drive:{f.name}",
                "title": f"Drive Audit: {f.name}",
                "pillar": "drive-audit-cli",
                "filename": f.name,
                "path": str(f),
                "size_kb": round(f.stat().st_size / 1024, 1),
                "modified": f.stat().st_mtime,
                "type": "markdown"
            })

    # 2. IDrive reports
    idrive_path = REPOS["idrive-audit"]
    if idrive_path.exists():
        for ext in ["*.txt", "*.md"]:
            for f in idrive_path.glob(ext):
                reports.append({
                    "id": f"idrive:{f.name}",
                    "title": f"IDrive: {f.name}",
                    "pillar": "idrive-audit",
                    "filename": f.name,
                    "path": str(f),
                    "size_kb": round(f.stat().st_size / 1024, 1),
                    "modified": f.stat().st_mtime,
                    "type": "text" if f.suffix == ".txt" else "markdown"
                })

    # 3. Media Organizer reports
    media_reports = REPOS["media-organizer-pipeline"] / "reports"
    if media_reports.exists():
        for f in sorted(media_reports.glob("*.csv"), key=lambda x: x.stat().st_mtime, reverse=True)[:6]:
            reports.append({
                "id": f"media:{f.name}",
                "title": f"Media Triage: {f.name}",
                "pillar": "media-organizer-pipeline",
                "filename": f.name,
                "path": str(f),
                "size_kb": round(f.stat().st_size / 1024, 1),
                "modified": f.stat().st_mtime,
                "type": "csv"
            })

    return {"reports": reports}

@router.get("/content")
def get_report_content(report_id: str = Query(...)):
    prefix, _, filename = report_id.partition(":")
    if prefix == "drive":
        target = REPOS["drive-audit-cli"] / "docs" / filename
    elif prefix == "idrive":
        target = REPOS["idrive-audit"] / filename
    elif prefix == "media":
        target = REPOS["media-organizer-pipeline"] / "reports" / filename
    else:
        raise HTTPException(status_code=400, detail="Invalid report id format")

    if not target.exists():
        raise HTTPException(status_code=404, detail="Report file not found")

    try:
        # Cap read size to 100KB for large CSVs/files
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(100 * 1024)
        return {
            "id": report_id,
            "filename": filename,
            "content": content,
            "is_truncated": target.stat().st_size > 100 * 1024,
            "total_size_kb": round(target.stat().st_size / 1024, 1)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
