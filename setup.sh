#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==================================="
echo "  Meet Live Translator - Setup"
echo "==================================="

echo ""
echo "Checking Python..."
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is not installed."
    echo "Please install Python 3.10+ from https://www.python.org"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2 | cut -d'.' -f1,2)
echo "Found Python $PYTHON_VERSION"

if [ ! -d "venv" ]; then
    echo ""
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

echo "Activating virtual environment..."
source venv/bin/activate

echo ""
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install -r backend/requirements.txt

echo ""
echo "Checking Ollama..."
if ! command -v ollama &> /dev/null; then
    echo "Ollama is not installed."
    echo ""
    echo "Please install Ollama:"
    echo "  macOS/Linux: curl -fsSL https://ollama.ai/install.sh | sh"
    echo "  Or visit: https://ollama.ai"
    echo ""
    read -p "Press Enter after installing Ollama to continue..."
fi

echo ""
echo "Pulling Qwen translation model..."
ollama pull qwen2.5:1.5b

echo ""
echo "==================================="
echo "  Setup Complete!"
echo "==================================="
echo ""
echo "To run: ./run.sh"
echo ""
