#!/bin/bash
#
# Build StenoAI Python backend as standalone executable
#
# This script bundles the Python backend using PyInstaller so that
# users don't need Python installed to run the app.
#
# Prerequisites:
#   - Python 3.9+ with pip
#   - Virtual environment activated (optional but recommended)
#
# Usage:
#   ./scripts/build-backend.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "==================================="
echo "  StenoAI Backend Builder"
echo "==================================="
echo ""

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not found"
    exit 1
fi

echo "Python version: $(python3 --version)"
echo ""

# Install PyInstaller if not present
if ! python3 -c "import PyInstaller" 2>/dev/null; then
    echo "Installing PyInstaller..."
    pip install pyinstaller
    echo ""
fi

# Install project dependencies
echo "Installing project dependencies..."
pip install -r requirements.txt
echo ""

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf build/ dist/
echo ""

# Run PyInstaller
echo "Building standalone executable..."
echo "This may take several minutes..."
echo ""

if [ "$(uname -s)" = "Darwin" ]; then
    echo "Building required speaker-diarization sidecar..."
    "$SCRIPT_DIR/build-diarize-sidecar.sh" "$(uname -m)"
    if [ ! -x bin/steno-diarize ]; then
        echo "Error: speaker-diarization sidecar was not built at bin/steno-diarize" >&2
        exit 1
    fi
    echo ""
    echo "Building Apple LM sidecar (needs macOS 26+ SDK)..."
    if ! "$SCRIPT_DIR/build-apple-lm-sidecar.sh" "$(uname -m)"; then
        echo "Warning: Apple LM sidecar was not built at bin/steno-apple-lm." >&2
        echo "Summaries will use Ollama until a host with the macOS 26+ SDK produces that binary." >&2
    fi
fi

python3 -m PyInstaller stenoai.spec --noconfirm

# Check if build succeeded
if [ -d "dist/stenoai" ]; then
    echo ""
    echo "==================================="
    echo "  Build Successful!"
    echo "==================================="
    echo ""
    echo "Bundled executable is at: dist/stenoai/"
    echo ""

    # Show size
    SIZE=$(du -sh dist/stenoai | cut -f1)
    echo "Bundle size: $SIZE"
    echo ""

    # Test the executable
    echo "Testing executable..."
    if ./dist/stenoai/stenoai --help > /dev/null 2>&1; then
        echo "Executable test: PASSED"
    else
        echo "Executable test: WARNING - may need additional testing"
    fi
    echo ""
    echo "To use with Electron app, update main.js to use:"
    echo "  path.join(__dirname, '..', 'dist', 'stenoai', 'stenoai')"
else
    echo ""
    echo "Build FAILED!"
    echo "Check the output above for errors."
    exit 1
fi
