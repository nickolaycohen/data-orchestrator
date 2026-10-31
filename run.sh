#!/usr/bin/env bash
# ==============================================================================
# run.sh — Data Orchestrator Web Dashboard Launcher
# ==============================================================================
# Activates virtualenv, ensures dependencies, and starts both the FastAPI
# backend and Vite frontend development server.
# ==============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

echo "🌐 Starting Data Orchestrator Dashboard..."

# 1. Check Python virtual environment
if [ ! -d ".venv" ]; then
    echo "📦 Creating Python virtual environment..."
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
else
    source .venv/bin/activate
fi

# 2. Check Node dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 Installing npm dependencies..."
    npm install
fi

# 3. Launch unified dev servers
echo "🚀 Launching FastAPI (port 8008) and Vite Dashboard (port 5173)..."
exec npm run dev
