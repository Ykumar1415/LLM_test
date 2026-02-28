# Meet Live Translator

A 100% local, privacy-first, ultra-fast Google Meet translation extension. It captures tab audio from Google Meet or YouTube, streams it to a local Python backend via WebSockets, and uses MLX Whisper and Ollama to translate speech into real-time subtitle bubbles.

## Technical Architecture

- **Frontend:** Chrome Extension (Manifest V3) using an Offscreen Document and `AudioWorklet` to stream raw Float32 PCM audio.
- **Backend:** Python 3.10+ FastAPI server using asyncio and WebSockets.
- **ASR Engine:** MLX Whisper (Apple MLX framework) - optimized for Apple Silicon.
- **Translation Engine:** Ollama running quantized SLMs (Small Language Models) locally.

---

## Part 1: Backend Installation & Setup

### Prerequisites

- **macOS:** Apple Silicon Mac (M1/M2/M3/M4)
- **Python:** 3.10, 3.11, or 3.12
- **ffmpeg:** Required for audio processing
- **Ollama:** For translation

### Quick Setup

```bash
# Install ffmpeg
brew install ffmpeg

# Install Ollama and download translation model
brew install ollama
brew services start ollama
ollama pull qwen2.5:1.5b

# Install Python dependencies
cd backend
pip install -r requirements.txt

# Run the server
python -m backend
```

### Model Configuration

The default Whisper model is `mlx-community/whisper-large-v3-turbo` for best accuracy. You can change it via environment variable:

```bash
# Use a different model (examples)
WHISPER_MODEL="mlx-community/whisper-small-mlx" python -m backend
WHISPER_MODEL="mlx-community/whisper-large-v3-mlx" python -m backend
```

Available models (from Hugging Face MLX Community):

- `mlx-community/whisper-tiny-mlx` - Fastest, lower accuracy
- `mlx-community/whisper-base-mlx` - Fast, good accuracy
- `mlx-community/whisper-small-mlx` - Balanced
- `mlx-community/whisper-medium-mlx` - Good accuracy
- `mlx-community/whisper-large-v3-mlx` - Best accuracy
- `mlx-community/whisper-large-v3-turbo` - Best accuracy, optimized (default)

---

## Part 2: Browser Extension Setup

1. Open a Chromium-based browser (Chrome, Edge, Brave).
2. Go to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** in the top left corner.
5. Select the `extension/` folder from this repository.
6. Pin the "Meet Live Translator" icon to your toolbar for easy access.

---

## Usage Guide

1. Make sure your Python backend is running (`python -m backend`).
2. Join a Google Meet call or open a YouTube video containing speech.
3. Click the extension icon in your toolbar. This opens the translation sidebar.
4. Click the extension icon again to ensure the browser prompts for audio capture permissions.
5. In the sidebar, click the **[ Start ]** button.
6. Speak or let the video play. Translated chat bubbles will appear in real time.

### Troubleshooting

- **"WebSocket Error" or "Disconnected":** Make sure the Python server is running on `ws://localhost:8765`.
- **It takes 2-3 seconds for text to appear:** This is by design. The VAD waits for a 0.8-second pause in speech before processing.
- **First run is slow:** The MLX model is downloaded and cached on first use (~1.6GB for large-v3-turbo). Subsequent runs are instant.
