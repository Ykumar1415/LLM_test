# Meet Live Translator

A 100% local, privacy-first, ultra-fast Google Meet translation extension. It captures tab audio from Google Meet or YouTube, streams it to a local Python backend via WebSockets, and uses `faster-whisper` and large language models (via Ollama) to translate speech into real-time subtitle bubbles.

## Technical Architecture

*   **Frontend:** Chrome Extension (Manifest V3) using an Offscreen Document and `AudioWorklet` to stream raw Float32 PCM audio.
*   **Backend:** Python 3.10+ FastAPI server using asyncio and WebSockets.
*   **ASR Engine:** `faster-whisper` (CTranslate2 backend).
*   **Translation Engine:** Ollama running quantized SLMs (Small Language Models) locally.

---

## Part 1: Backend Installation & Setup

You must run the Python backend on the same machine (or same local network) as the browser running the extension.

### 1. Prerequisites
*   **Python:** Install Python 3.10, 3.11, or 3.12. (3.13 may not have full pre-built dependency wheels yet).
*   **Ollama:** Install [Ollama](https://ollama.com/).

### 2. Download LLM Models
Start Ollama, then open your terminal and download a translation model. The extension defaults to `qwen2.5:1.5b` because of its excellent speed-to-accuracy ratio.

```bash
ollama pull qwen2.5:1.5b
```

*(Optional: If you want to use the dual-tier translation architecture, also pull a summarizer model like `smollm:1.7b`)*.

### 3. Install Python Dependencies
Navigate to the `backend/` directory in this repository and install the requirements:

```bash
cd backend
pip install -r requirements.txt
```

### 4. Running the Backend (Hardware Optimization Profiles)

How you run the backend depends entirely on your hardware. **Please read the section matching your computer.**

#### A. Standard PC (CPU Only)
If you have a modern Intel or AMD processor without a dedicated NVIDIA GPU, `faster-whisper` is highly optimized using INT8 quantization and standard blas threads.

To run:
```bash
python server.py
```
*Note: By default, `config.py` limits Whisper to exactly 4 CPU threads (`WHISPER_CPU_THREADS = 4`) to prevent the translation from freezing your actual Google Meet tab in the browser.*

#### B. Mac (Apple Silicon: M1 / M2 / M3)
`faster-whisper` works on Mac, but it cannot currently utilize the Apple Neural Engine natively via CTranslate2. It runs purely on the CPU cores.
Because M-series chips have highly efficient cores, you can usually increase the thread limit.
1. Open `backend/config.py`.
2. Change `WHISPER_CPU_THREADS = 4` to `WHISPER_CPU_THREADS = 8`.
3. Run `python server.py`.

*(Advanced Note for Mac Users: If `faster-whisper` is too slow on your Mac, you must replace the `backend/asr.py` wrapper to use `whisper-cpp-python` instead, which ties directly into Apple's Metal framework. This requires C++ compilation on your machine).*

#### C. PC with NVIDIA GPU (CUDA)
If you have an NVIDIA GPU (RTX series), you can get massive speed improvements by forcing Whisper onto the GPU.
1. Ensure you have the CUDA toolkit installed on your OS.
2. Open `backend/config.py`.
3. Change `WHISPER_DEVICE = "cpu"` to `WHISPER_DEVICE = "cuda"`.
4. Run `python server.py`.

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

1. Make sure your Python backend is running (`python server.py`).
2. Join a Google Meet call or open a YouTube video containing speech.
3. Click the extension icon in your toolbar. This opens the translation sidebar.
4. (Important) Click the extension icon again to ensure the browser prompts for audio capture permissions if it hasn't already.
5. In the sidebar, click the **[ Start ]** button.
6. Speak or let the video play. The extension will stream the audio, and translated chat bubbles will appear in the sidebar in real time.

### Troubleshooting

*   **"WebSocket Error" or "Disconnected":** Make sure the Python server is running and listening on `ws://localhost:8765`.
*   **It takes 2-3 seconds for text to appear:** This is by design. The system uses Voice Activity Detection (VAD) to wait for a 0.8-second pause in speech before sending the audio to the AI. This ensures the AI gets a complete sentence context rather than breaking translations halfway through a word.
*   **The UI causes lag on my computer:** Check your CPU usage in Task Manager / Activity Monitor. If it's hitting 100%, lower `WHISPER_CPU_THREADS` in `config.py` to 2.
