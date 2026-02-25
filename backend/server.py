from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import json
import logging
import uuid
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config
from .asr import ASREngine
from .vad import VoiceActivityDetector
from .translator import TranslationEngine


logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

asr_engine = ASREngine()
translator = TranslationEngine()


class AudioRingBuffer:
    def __init__(self, max_seconds: float = config.RING_BUFFER_SEC, sample_rate: int = config.SAMPLE_RATE):
        self._sr = sample_rate
        self._max_samples = int(max_seconds * sample_rate)
        self._buffer = np.zeros(self._max_samples, dtype=np.float32)
        self._write_pos = 0        
        self._total_written = 0

    def append(self, chunk: np.ndarray) -> None:
        n = len(chunk)
        if n == 0: return
        start = self._write_pos % self._max_samples
        if start + n <= self._max_samples:
            self._buffer[start:start + n] = chunk
        else:
            first = self._max_samples - start
            self._buffer[start:] = chunk[:first]
            self._buffer[:n - first] = chunk[first:]
        self._write_pos += n
        self._total_written += n

    def get_range(self, start_pos: int, end_pos: int) -> np.ndarray:
        if end_pos <= start_pos: return np.array([], dtype=np.float32)
        actual_start = max(start_pos, self._total_written - self._max_samples, 0)
        actual_end = min(end_pos, self._total_written)
        n_samples = actual_end - actual_start
        if n_samples <= 0: return np.array([], dtype=np.float32)
        start_idx = actual_start % self._max_samples
        end_idx = actual_end % self._max_samples
        if start_idx < end_idx:
            return self._buffer[start_idx:end_idx].copy()
        
        return np.concatenate([
            self._buffer[start_idx:],
            self._buffer[:end_idx],
        ])

    @property
    def write_pos(self) -> int:
        return self._total_written


def extract_new_text(committed: str, current: str) -> str:
    if not committed: return current.strip()
    if not current: return ""

    committed_clean = committed.strip()
    current_clean = current.strip()

    is_japanese = any("\u3000" <= c <= "\u9fff" for c in current_clean)
    if is_japanese:
        best_overlap = 0
        max_check = min(len(committed_clean), len(current_clean))
        for i in range(1, max_check + 1):
            if committed_clean[-i:] == current_clean[:i]:
                best_overlap = i
        return current_clean[best_overlap:].strip()
    
    committed_words = committed_clean.split()
    current_words = current_clean.split()
    best_overlap = 0
    for i in range(1, min(len(committed_words), len(current_words)) + 1):
        if committed_words[-i:] == current_words[:i]:
            best_overlap = i
    orig_current_words = current_clean.split()
    return " ".join(orig_current_words[best_overlap:]).strip()


class SessionContext:
    def __init__(self):
        self.transcript_history = collections.deque(maxlen=5)
        self.full_history = []
        self.last_summary_index = 0
        self.last_summary: str | None = None

    def get_prompt(self) -> str | None:
        if not self.transcript_history:
            return None
        return " ".join(list(self.transcript_history)[-2:])

    def add_transcript(self, text: str):
        self.transcript_history.append(text)
        self.full_history.append(text)

    def should_summarize(self) -> bool:
        return len(self.full_history) - self.last_summary_index >= 5
        
    def get_unsummarized_history(self) -> list[str]:
        return self.full_history[self.last_summary_index:]
        
    def mark_summarized(self):
        self.last_summary_index = len(self.full_history)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Meet Live Translation Backend")
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, asr_engine.load)
    await loop.run_in_executor(None, translator.load)
    logger.info("Server ready on port %d", config.PORT)
    yield
    logger.info("Shutting down...")


app = FastAPI(title="Meet Live Translation", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return JSONResponse({
        "status": "ready" if asr_engine.is_loaded else "loading",
        "asr_model": config.WHISPER_MODEL_SIZE,
        "asr_loaded": asr_engine.is_loaded,
        "architecture": "sliding_window_v2",
    })

class ConnectionManager:
    def __init__(self):
        self._text_connections: dict[str, WebSocket] = {}

    async def connect_text(self, ws: WebSocket) -> str:
        await ws.accept()
        conn_id = str(uuid.uuid4())[:8]
        self._text_connections[conn_id] = ws
        logger.info("Text client connected: %s", conn_id)
        return conn_id

    def disconnect_text(self, conn_id: str) -> None:
        self._text_connections.pop(conn_id, None)
        logger.info("Text client disconnected: %s", conn_id)

    async def broadcast_json(self, data: dict) -> None:
        dead: list[str] = []
        for cid, ws in self._text_connections.items():
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self._text_connections.pop(cid, None)

manager = ConnectionManager()


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket, arch: str = "vad_qwen", lang: str = "auto"):
    await ws.accept()
    client_id = str(uuid.uuid4())[:8]
    logger.info("Audio client connected: %s (arch=%s, lang=%s)", client_id, arch, lang)

    vad = VoiceActivityDetector()
    session_context = SessionContext()
    processing_lock = asyncio.Lock()
    llm_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)

    await manager.broadcast_json({
        "type": "status",
        "state": "ready",
        "message": f"Backend ready. Arch: {arch}"
    })

    if arch.startswith("sliding_window"):
        ring = AudioRingBuffer()
        segment_counter = 0
        last_committed_text = ""
        last_interim_text = ""
        last_read_pos = 0

        async def _sliding_window_tick():
            nonlocal last_committed_text, last_interim_text, last_read_pos, segment_counter
            overlap_samples = int(config.WINDOW_OVERLAP_SEC * config.SAMPLE_RATE)
            start_pos = max(0, last_read_pos - overlap_samples)
            end_pos = ring.write_pos
            if (end_pos - start_pos) / config.SAMPLE_RATE < 1.0: return
            if processing_lock.locked(): return

            async with processing_lock:
                segment_counter += 1
                seg_id = f"{client_id}-{segment_counter}"
                audio_window = ring.get_range(start_pos, end_pos)
                if len(audio_window) < config.SAMPLE_RATE: return
                rms = float(np.sqrt(np.mean(audio_window.astype(np.float64) ** 2)))
                if rms < 0.003:
                    last_read_pos = end_pos
                    return

                loop = asyncio.get_event_loop()
                try:
                    context_prompt = last_committed_text[-200:] if last_committed_text else None
                    result = await loop.run_in_executor(
                        None, asr_engine.transcribe, audio_window, context_prompt, "transcribe", lang
                    )
                    if not result or not result.text.strip(): return
                    new_text = extract_new_text(last_committed_text, result.text.strip())
                    if not new_text or len(new_text) < 2 or new_text == last_interim_text: return

                    last_interim_text = new_text
                    session_context.add_transcript(new_text)

                    await manager.broadcast_json({
                        "type": "segment",
                        "id": seg_id,
                        "original": new_text,
                        "translated": "...",
                        "source_lang": result.language,
                        "target_lang": "en",
                        "cached": False,
                    })

                    async def _bg_trans(s_id: str, text: str, s_lang: str):
                        try:
                            t_result = await loop.run_in_executor(llm_pool, translator.translate, text, s_lang, session_context)
                            await manager.broadcast_json({
                                "type": "translation_update",
                                "id": s_id,
                                "translated": t_result.text,
                                "cached": t_result.cached,
                            })
                        except Exception as e:
                            logger.error("Error: %s", e)
                    asyncio.create_task(_bg_trans(seg_id, new_text, result.language))
                    last_read_pos = end_pos
                except Exception:
                    logger.exception("Context tick err")

        async def _timer_loop():
            while True:
                await asyncio.sleep(config.WINDOW_INTERVAL_SEC)
                try: await _sliding_window_tick()
                except asyncio.CancelledError: raise
                except Exception: logger.exception("Timer err")

        timer_task = asyncio.create_task(_timer_loop())

        try:
            while True:
                data = await ws.receive_bytes()
                try: audio_chunk = np.frombuffer(data, dtype=np.float32).copy()
                except Exception: continue
                ring.append(audio_chunk)
                vad_result = vad.process(audio_chunk)
                if vad_result is not None:
                    if last_interim_text:
                        last_committed_text += " " + last_interim_text
                        last_committed_text = last_committed_text.strip()
                        last_interim_text = ""
        except WebSocketDisconnect: pass
        except Exception: pass
        finally:
            try: await timer_task
            except: pass

    else:
        active_segment_id = None
        chunks_since_interim = 0

        async def _transcribe_and_broadcast(audio_data: np.ndarray, is_final: bool):
            nonlocal active_segment_id
            if len(audio_data) < config.SAMPLE_RATE * 0.4: return

            if active_segment_id is None:
                active_segment_id = f"{client_id}-{uuid.uuid4().hex[:6]}"
            current_id = active_segment_id
            loop = asyncio.get_event_loop()

            try:
                whisper_task = "translate" if arch == "vad_whisper_translate" else "transcribe"
                context_prompt = session_context.get_prompt()
                result = await loop.run_in_executor(
                    None, asr_engine.transcribe, audio_data, context_prompt, whisper_task, lang
                )

                if not result or not result.text.strip(): return

                new_text = result.text.strip()
                source_lang = result.language
                target_lang = "en"
                is_native_translation = (arch == "vad_whisper_translate")
                is_raw_only = (arch == "vad_raw")

                await manager.broadcast_json({
                    "type": "segment",
                    "id": current_id,
                    "original": new_text if not is_native_translation else f"[Native] {new_text}",
                    "translated": new_text if is_native_translation else "...",
                    "source_lang": source_lang,
                    "target_lang": target_lang,
                    "cached": is_native_translation,
                    "is_final": is_final
                })

                if is_final:
                    if not is_native_translation and not is_raw_only:
                        session_context.add_transcript(new_text)
                        
                        async def _background_translate(s_id: str, text: str, s_lang: str):
                            try:
                                t_result = await loop.run_in_executor(llm_pool, translator.translate, text, s_lang, session_context)
                                await manager.broadcast_json({
                                    "type": "translation_update",
                                    "id": s_id,
                                    "translated": t_result.text,
                                    "cached": t_result.cached,
                                })
                            except Exception as e:
                                logger.error("Translation fail: %s", e)
                        asyncio.create_task(_background_translate(current_id, new_text, source_lang))

                    elif is_raw_only or is_native_translation:
                        session_context.add_transcript(new_text)
                        if is_raw_only:
                            await manager.broadcast_json({
                                "type": "translation_update",
                                "id": current_id,
                                "translated": "[Raw Mode]",
                                "cached": True,
                            })

                    if session_context.should_summarize():
                        history = session_context.get_unsummarized_history()
                        previous_summary = session_context.last_summary
                        session_context.mark_summarized()
                        
                        async def _background_summarize(h: list[str], prev: str | None):
                            try:
                                await manager.broadcast_json({"type": "summary_status", "status": "generating"})
                                summary = await loop.run_in_executor(llm_pool, translator.summarize, h, prev)
                                if summary:
                                    session_context.last_summary = summary
                                    await manager.broadcast_json({"type": "summary", "text": summary})
                            except Exception as e:
                                logger.error("Summary fail: %s", e)
                                await manager.broadcast_json({"type": "summary_status", "status": "error"})

                        asyncio.create_task(_background_summarize(history, previous_summary))

                    active_segment_id = None

            except asyncio.CancelledError: raise
            except Exception: logger.exception("Error in transcription")

        try:
            while True:
                data = await ws.receive_bytes()
                try: audio_chunk = np.frombuffer(data, dtype=np.float32).copy()
                except Exception: continue

                vad_result = vad.process(audio_chunk)

                if vad.is_speaking:
                    chunks_since_interim += 1
                    if chunks_since_interim >= 12: 
                        chunks_since_interim = 0
                        current_audio = vad.get_current_buffer()
                        if not processing_lock.locked():
                            async def run_interim():
                                async with processing_lock:
                                    await _transcribe_and_broadcast(current_audio, is_final=False)
                            asyncio.create_task(run_interim())

                if vad_result is not None:
                    chunks_since_interim = 0
                    async with processing_lock:
                        await _transcribe_and_broadcast(vad_result, is_final=True)

        except WebSocketDisconnect: pass
        except Exception: pass


@app.websocket("/ws/text")
async def ws_text(ws: WebSocket):
    conn_id = await manager.connect_text(ws)
    await ws.send_json({
        "type": "status",
        "state": "ready" if asr_engine.is_loaded else "loading",
        "message": "Connected to translation backend.",
    })
    try:
        while True:
            msg = await ws.receive_text()
            try:
                data = json.loads(msg)
                if data.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
            except json.JSONDecodeError: pass
    except WebSocketDisconnect: pass
    finally: manager.disconnect_text(conn_id)


def main():
    import uvicorn
    uvicorn.run(
        "backend.server:app",
        host=config.HOST,
        port=config.PORT,
        log_level=config.LOG_LEVEL.lower(),
        ws_ping_interval=30,
        ws_ping_timeout=30,
    )

if __name__ == "__main__":
    main()
