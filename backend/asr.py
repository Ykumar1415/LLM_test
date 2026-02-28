from __future__ import annotations

import logging
import re
import threading
from typing import NamedTuple

import numpy as np

from . import config

logger = logging.getLogger(__name__)


class TranscriptionResult(NamedTuple):
    text: str
    language: str
    language_probability: float
    duration_sec: float


class ASREngine:
    def __init__(self, model_path: str = config.WHISPER_MODEL) -> None:
        self._lock = threading.Lock()
        self._model_path = model_path
        self._loaded = False

    def load(self) -> None:
        import mlx_whisper

        self._mlx_whisper = mlx_whisper
        logger.info("Loading MLX Whisper model: %s", self._model_path)
        result = self._mlx_whisper.transcribe(
            np.zeros(16000, dtype=np.float32),
            path_or_hf_repo=self._model_path,
        )
        self._loaded = True
        logger.info("MLX Whisper model loaded successfully")

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def transcribe(
        self,
        audio: np.ndarray,
        initial_prompt: str | None = None,
        task: str = "transcribe",
        language: str | None = None,
    ) -> TranscriptionResult | None:
        if not self._loaded:
            raise RuntimeError("ASR model not loaded")

        if len(audio) == 0:
            return None

        duration_sec = len(audio) / config.SAMPLE_RATE

        with self._lock:
            try:
                transcribe_opts = {
                    "path_or_hf_repo": self._model_path,
                    "task": task,
                    "fp16": True,
                    "verbose": False,
                }
                if language and language != "auto":
                    transcribe_opts["language"] = language
                if initial_prompt:
                    transcribe_opts["initial_prompt"] = initial_prompt

                result = self._mlx_whisper.transcribe(audio, **transcribe_opts)

                full_text = result.get("text", "").strip()
                full_text = self._clean_output(full_text)

                if not full_text:
                    return None

                detected_lang = result.get("language", "en")

                output = TranscriptionResult(
                    text=full_text,
                    language=detected_lang,
                    language_probability=1.0,
                    duration_sec=duration_sec,
                )
                logger.info(
                    'ASR [%s]: "%s" (%.1fs)',
                    output.language,
                    output.text[:80],
                    output.duration_sec,
                )
                return output

            except Exception:
                logger.exception("Transcription failed")
                return None

    @staticmethod
    def _clean_output(text: str) -> str:
        if not text:
            return text
        text = re.sub(r"(\b\w{1,15}[.!?]?\s*)\1{2,}", r"\1", text)
        text = re.sub(r"([\u3000-\u9fff]{1,5}[。、]?\s*)\1{2,}", r"\1", text)
        text = re.sub(r">>|<<", "", text)
        text = re.sub(r"\[.*?\]|\(.*?\)", "", text)
        noise = [
            r"(?i)thanks?\s+for\s+watching\.?",
            r"(?i)please\s+subscribe\.?",
            r"(?i)like\s+and\s+subscribe\.?",
            r"ご視聴ありがとうございました。?",
            r"チャンネル登録お願いします。?",
        ]
        for pattern in noise:
            text = re.sub(pattern, "", text)
        return re.sub(r"\s+", " ", text).strip()
