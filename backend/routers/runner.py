import asyncio
import os
import signal
import time
import uuid
from typing import Dict, Any, Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from pydantic import BaseModel
from backend.config import REPOS, BASE_DIR

router = APIRouter(prefix="/api/runner", tags=["runner"])

class RunRequest(BaseModel):
    task_id: str
    args: Optional[list[str]] = None

# Active processes and history
RUNNING_PROCESSES: Dict[str, asyncio.subprocess.Process] = {}
PROCESS_OUTPUTS: Dict[str, list[str]] = {}
ACTIVE_WEBSOCKETS: Dict[str, list[WebSocket]] = {}
RUN_HISTORY: list[Dict[str, Any]] = []

TASK_DEFINITIONS = {
    "media_triage": {
        "name": "Pre-Intake Triage Gateway",
        "pillar": "media-organizer-pipeline",
        "description": "Scans intake directory, pairs Live Photos, and partitions duplicates vs new assets.",
        "cwd_repo": "media-organizer-pipeline",
        "cmd": ["python3", "scripts/triage_media_intake.py"]
    },
    "media_verify": {
        "name": "Verify Export Album",
        "pillar": "media-organizer-pipeline",
        "description": "Checks asset readiness and integrity in Media Organizer DB.",
        "cwd_repo": "media-organizer-pipeline",
        "cmd": ["python3", "scripts/verify_export_album.py"]
    },
    "media_dedupe": {
        "name": "Deduplicate Staging Assets",
        "pillar": "media-organizer-pipeline",
        "description": "Deduplicates temporary staging media assets.",
        "cwd_repo": "media-organizer-pipeline",
        "cmd": ["python3", "scripts/deduplicate_assets.py"]
    },
    "drive_audit": {
        "name": "Drive Audit Finder & Classifier",
        "pillar": "drive-audit-cli",
        "description": "Scans directories, catalogs file metadata, and tags Priority 1–4 folders.",
        "cwd_repo": "drive-audit-cli",
        "cmd": ["python3", "python/drive_audit_finder.py"]
    },
    "drive_benchmarks": {
        "name": "Drive IO Benchmarks",
        "pillar": "drive-audit-cli",
        "description": "Benchmarks read/write speeds across connected external and local drives.",
        "cwd_repo": "drive-audit-cli",
        "cmd": ["python3", "python/drive_benchmarks.py"]
    },
    "idrive_wizard": {
        "name": "IDrive Device Backup Wizard",
        "pillar": "idrive-audit",
        "description": "Wizard to register devices, configure backup policies, and reconcile cloud trees.",
        "cwd_repo": "idrive-audit",
        "cmd": ["python3", "device_backup_wizard.py"]
    },
    "idrive_audit": {
        "name": "IDrive EVS Cloud Audit",
        "pillar": "idrive-audit",
        "description": "Queries remote iDrive EVS web APIs using active session cookie.",
        "cwd_repo": "idrive-audit",
        "cmd": ["python3", "idrive-audit.py"]
    },
    "gmail_planner": {
        "name": "Gmail Cleanup Planner Report",
        "pillar": "gmail-cleanup-planner",
        "description": "Analyzes Gmail mailbox, groups senders into rule families, and proposes actions.",
        "cwd_repo": "gmail-cleanup-planner",
        "cmd": ["python3", "planner-report.py"]
    }
}

@router.get("/tasks")
def list_tasks():
    return {
        "tasks": [
            {"id": k, **v} for k, v in TASK_DEFINITIONS.items()
        ],
        "running": list(RUNNING_PROCESSES.keys()),
        "history": RUN_HISTORY[-15:]
    }

@router.post("/start")
async def start_task(req: RunRequest):
    if req.task_id not in TASK_DEFINITIONS:
        raise HTTPException(status_code=400, detail="Unknown task ID")

    defn = TASK_DEFINITIONS[req.task_id]
    cwd = REPOS[defn["cwd_repo"]]

    if not cwd.exists():
        raise HTTPException(status_code=400, detail=f"Repository directory {cwd} does not exist")

    execution_id = str(uuid.uuid4())[:8]
    full_cmd = list(defn["cmd"])
    if req.args:
        full_cmd.extend(req.args)

    # Virtualenv python check
    venv_python = cwd / ".venv" / "bin" / "python3"
    if venv_python.exists():
        full_cmd[0] = str(venv_python)

    history_entry = {
        "id": execution_id,
        "task_id": req.task_id,
        "task_name": defn["name"],
        "pillar": defn["pillar"],
        "cmd": full_cmd,
        "start_time": time.time(),
        "status": "running",
        "exit_code": None
    }
    RUN_HISTORY.append(history_entry)
    PROCESS_OUTPUTS[execution_id] = [f"[START] Executing: {' '.join(full_cmd)}\n[INFO] Working Directory: {cwd}\n"]

    asyncio.create_task(_run_process(execution_id, full_cmd, str(cwd), history_entry))

    return {
        "execution_id": execution_id,
        "task_id": req.task_id,
        "name": defn["name"],
        "status": "started"
    }

async def _run_process(execution_id: str, cmd: list[str], cwd: str, entry: Dict[str, Any]):
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        RUNNING_PROCESSES[execution_id] = proc

        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace")
            PROCESS_OUTPUTS[execution_id].append(text)
            
            # Broadcast to connected websockets
            if execution_id in ACTIVE_WEBSOCKETS:
                for ws in list(ACTIVE_WEBSOCKETS[execution_id]):
                    try:
                        await ws.send_json({"type": "log", "text": text})
                    except Exception:
                        pass

        await proc.wait()
        entry["exit_code"] = proc.returncode
        entry["status"] = "success" if proc.returncode == 0 else "failed"
        final_msg = f"\n[COMPLETED] Process exited with code {proc.returncode}\n"
        PROCESS_OUTPUTS[execution_id].append(final_msg)
        
        if execution_id in ACTIVE_WEBSOCKETS:
            for ws in list(ACTIVE_WEBSOCKETS[execution_id]):
                try:
                    await ws.send_json({"type": "done", "exit_code": proc.returncode})
                except Exception:
                    pass

    except Exception as e:
        entry["status"] = "error"
        err_msg = f"\n[ERROR] Failed to run process: {e}\n"
        PROCESS_OUTPUTS[execution_id].append(err_msg)
    finally:
        RUNNING_PROCESSES.pop(execution_id, None)

@router.post("/kill/{execution_id}")
def kill_task(execution_id: str):
    proc = RUNNING_PROCESSES.get(execution_id)
    if not proc:
        raise HTTPException(status_code=404, detail="Process not running")
    try:
        proc.terminate()
        return {"status": "terminated"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/logs/{execution_id}")
def get_logs(execution_id: str):
    logs = PROCESS_OUTPUTS.get(execution_id, [])
    return {"execution_id": execution_id, "logs": logs}

@router.websocket("/ws/{execution_id}")
async def websocket_logs(websocket: WebSocket, execution_id: str):
    await websocket.accept()
    if execution_id not in ACTIVE_WEBSOCKETS:
        ACTIVE_WEBSOCKETS[execution_id] = []
    ACTIVE_WEBSOCKETS[execution_id].append(websocket)

    # Replay existing logs
    for log in PROCESS_OUTPUTS.get(execution_id, []):
        await websocket.send_json({"type": "log", "text": log})

    try:
        while True:
            # Keep socket alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        ACTIVE_WEBSOCKETS[execution_id].remove(websocket)
