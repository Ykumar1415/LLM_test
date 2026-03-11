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


class SessionContext:
    def __init__(self):
        self.transcript_history: collections.deque = collections.deque(maxlen=5)

    def get_prompt(self) -> str | None:
        if not self.transcript_history:
            return None
        return " ".join(list(self.transcript_history)[-2:])

    def add_transcript(self, text: str):
        self.transcript_history.append(text)


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
    return JSONResponse(
        {
            "status": "ready" if asr_engine.is_loaded else "loading",
            "asr_model": config.WHISPER_MODEL,
            "asr_loaded": asr_engine.is_loaded,
            "architecture": "vad_whisper_translate",
        }
    )


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
_current_speaker: str = "Speaker"


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket, lang: str = "auto"):
    await ws.accept()
    client_id = str(uuid.uuid4())[:8]
    logger.info("Audio client connected: %s (lang=%s)", client_id, lang)

    vad = VoiceActivityDetector()
    session_context = SessionContext()
    processing_lock = asyncio.Lock()
    llm_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)

    await manager.broadcast_json(
        {"type": "status", "state": "ready", "message": "Backend ready"}
    )

    active_segment_id = None
    chunks_since_interim = 0

    async def _transcribe_and_broadcast(audio_data: np.ndarray, is_final: bool):
        nonlocal active_segment_id
        if len(audio_data) < config.SAMPLE_RATE * 0.4:
            return

        if active_segment_id is None:
            active_segment_id = f"{client_id}-{uuid.uuid4().hex[:6]}"
        current_id = active_segment_id
        loop = asyncio.get_event_loop()

        try:
            context_prompt = session_context.get_prompt()
            result = await loop.run_in_executor(
                None,
                asr_engine.transcribe,
                audio_data,
                context_prompt,
                "translate",
                lang,
            )

            if not result or not result.text.strip():
                return

            english_text = result.text.strip()
            source_lang = result.language

            await manager.broadcast_json(
                {
                    "type": "segment",
                    "id": current_id,
                    "original": f"[{source_lang}]",
                    "translated": english_text,
                    "source_lang": source_lang,
                    "target_lang": "en",
                    "cached": False,
                    "is_final": is_final,
                    "speaker": _current_speaker,
                }
            )

            if is_final:

                async def _translate_to_japanese(s_id: str, en_txt: str):
                    try:
                        jp_result = await loop.run_in_executor(
                            llm_pool,
                            translator.translate,
                            en_txt,
                            "en",
                            session_context,
                        )
                        await manager.broadcast_json(
                            {
                                "type": "segment_japanese",
                                "id": s_id,
                                "original": en_txt,
                                "translated": jp_result.text,
                                "source_lang": "en",
                                "target_lang": "ja",
                                "cached": jp_result.cached,
                            }
                        )
                    except Exception as e:
                        logger.error("Japanese translation error: %s", e)
                        await manager.broadcast_json(
                            {
                                "type": "segment_japanese",
                                "id": s_id,
                                "original": en_txt,
                                "translated": "{Translation Error}",
                                "source_lang": "en",
                                "target_lang": "ja",
                                "cached": False,
                            }
                        )

                asyncio.create_task(_translate_to_japanese(current_id, english_text))
                session_context.add_transcript(english_text)
                active_segment_id = None

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Error in transcription")

    try:
        while True:
            data = await ws.receive_bytes()
            try:
                audio_chunk = np.frombuffer(data, dtype=np.float32).copy()
            except Exception:
                continue

            vad_result = vad.process(audio_chunk)

            if vad.is_speaking:
                chunks_since_interim += 1
                if chunks_since_interim >= 12:
                    chunks_since_interim = 0
                    current_audio = vad.get_current_buffer()
                    if not processing_lock.locked():

                        async def run_interim():
                            async with processing_lock:
                                await _transcribe_and_broadcast(
                                    current_audio, is_final=False
                                )

                        asyncio.create_task(run_interim())

            if vad_result is not None:
                chunks_since_interim = 0
                async with processing_lock:
                    await _transcribe_and_broadcast(vad_result, is_final=True)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass


@app.websocket("/ws/text")
async def ws_text(ws: WebSocket):
    conn_id = await manager.connect_text(ws)
    await ws.send_json(
        {
            "type": "status",
            "state": "ready" if asr_engine.is_loaded else "loading",
            "message": "Connected to translation backend.",
        }
    )
    try:
        while True:
            msg = await ws.receive_text()
            try:
                data = json.loads(msg)
                if data.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
                elif data.get("type") == "speaker_update":
                    global _current_speaker
                    _current_speaker = data.get("speaker", "Speaker")
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect_text(conn_id)


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
