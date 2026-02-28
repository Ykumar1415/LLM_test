import os

# Server
HOST: str = os.getenv("TRANSLATION_HOST", "127.0.0.1")
PORT: int = int(os.getenv("TRANSLATION_PORT", "8765"))

# Audio
SAMPLE_RATE: int = 16_000
CHANNELS: int = 1
BYTES_PER_SAMPLE: int = 4
CHUNK_DURATION_SEC: float = 0.1

# VAD (Voice Activity Detection)
VAD_ENERGY_THRESHOLD: float = 0.010
VAD_SILENCE_DURATION_SEC: float = 1.5
VAD_MIN_SPEECH_DURATION_SEC: float = 0.3
VAD_MIN_BUFFER_SEC: float = 2.0
VAD_MAX_BUFFER_SEC: float = 20.0
VAD_PRE_SPEECH_SEC: float = 0.5

# ASR (Whisper)
WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "mlx-community/whisper-medium")

# Translation (Ollama)
OLLAMA_URL: str = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "qwen2.5:1.5b")

# Misc
MAX_SEGMENTS_KEPT: int = 50
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
