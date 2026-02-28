#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==================================="
echo "  Meet Live Translator - Starting"
echo "==================================="

# Kill any existing backend server
pkill -f "python.*backend" 2>/dev/null || true
lsof -ti:8765 | xargs kill -9 2>/dev/null || true
sleep 1

if ! command -v ollama &> /dev/null; then
    echo "Error: Ollama is not installed."
    echo "Please run setup.sh first or install Ollama from https://ollama.ai"
    exit 1
fi

if ! pgrep -x "ollama" > /dev/null; then
    echo "Starting Ollama..."
    ollama serve &
    OLLAMA_PID=$!
    sleep 3
    echo "Ollama started (PID: $OLLAMA_PID)"
else
    echo "Ollama is already running"
fi

if [ -d ".venv" ]; then
    source .venv/bin/activate
elif [ -d "venv" ]; then
    source venv/bin/activate
elif [ -d "backend/venv" ]; then
    source backend/venv/bin/activate
fi

echo ""
echo "Starting backend server on port 8765..."
echo "Press Ctrl+C to stop"
echo ""

trap "echo 'Shutting down...'; pkill -f 'python.*backend' 2>/dev/null; exit 0" SIGINT SIGTERM

python -m backend
