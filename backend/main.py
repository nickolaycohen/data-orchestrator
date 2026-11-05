from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from backend.routers import system, media, storage, idrive, gmail, runner, reports, utilities

app = FastAPI(
    title="Data Orchestrator API",
    description="Central Orchestration Hub managing Media Organizer, Drive Audit, IDrive, and Gmail Cleanup",
    version="1.0.0"
)

# Enable CORS for local dev servers (Vite on port 5173, etc.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all sub-routers
app.include_router(system.router)
app.include_router(media.router)
app.include_router(storage.router)
app.include_router(idrive.router)
app.include_router(gmail.router)
app.include_router(runner.router)
app.include_router(reports.router)
app.include_router(utilities.router)

@app.websocket("/ws/{execution_id}")
async def direct_ws_endpoint(websocket: WebSocket, execution_id: str):
    await runner.websocket_logs(websocket, execution_id)

@app.get("/")
def root():
    return {
        "service": "Data Orchestrator Backend",
        "status": "online",
        "docs_url": "/docs",
        "api_endpoints": [
            "/api/system/status",
            "/api/media/metrics",
            "/api/storage/metrics",
            "/api/idrive/metrics",
            "/api/gmail/metrics",
            "/api/runner/tasks",
            "/api/reports/list"
        ]
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)
