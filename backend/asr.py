from __future__ import annotations

import logging
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
    def __init__(
        self,
        model_size: str = config.WHISPER_MODEL_SIZE,
        device: str = config.WHISPER_DEVICE,
        compute_type: str = config.WHISPER_COMPUTE_TYPE,
    ) -> None:
        self._lock = threading.Lock()
        self._model = None
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type

    def load(self) -> None:
        from faster_whisper import WhisperModel

        logger.info(
            "Loading Whisper model '%s' (device=%s, compute=%s)",
            self._model_size,
            self._device,
            self._compute_type,
        )
        self._model = WhisperModel(
            self._model_size,
            device=self._device,
            compute_type=self._compute_type,
            cpu_threads=config.WHISPER_CPU_THREADS,
        )
        logger.info("Whisper model loaded successfully.")

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def transcribe(
        self,
        audio: np.ndarray,
        initial_prompt: str | None = None,
        task: str = "transcribe",
        language: str | None = None,
    ) -> TranscriptionResult | None:
        if self._model is None:
            raise RuntimeError("ASR model not loaded. Call .load() first.")

        if len(audio) == 0:
            return None

        duration_sec = len(audio) / config.SAMPLE_RATE

        with self._lock:
            try:
                segments_gen, info = self._model.transcribe(
                    audio,
                    language=language if language and language != "auto" else config.WHISPER_LANGUAGE,
                    beam_size=config.WHISPER_BEAM_SIZE,
                    best_of=config.WHISPER_BEST_OF,
                    temperature=config.WHISPER_TEMPERATURE,
                    vad_filter=config.WHISPER_VAD_FILTER,
                    task=task,
                    vad_parameters=dict(
                        min_silence_duration_ms=300,
                        speech_pad_ms=100,
                    ),
                    word_timestamps=False,
                    condition_on_previous_text=False,
                    initial_prompt=initial_prompt,
                    no_speech_threshold=0.4,
                    log_prob_threshold=-0.5,
                    repetition_penalty=1.2,
                )

                texts: list[str] = []
                for seg in segments_gen:
                    text = seg.text.strip()
                    if text:
                        texts.append(text)

                full_text = " ".join(texts).strip()

                full_text = self._clean_whisper_output(full_text)

                if not full_text:
                    return None

                result = TranscriptionResult(
                    text=full_text,
                    language=info.language,
                    language_probability=info.language_probability,
                    duration_sec=duration_sec,
                )
                logger.info(
                    "ASR [%s %.0f%%]: \"%s\" (%.1fs audio)",
                    result.language,
                    result.language_probability * 100,
                    result.text[:80],
                    result.duration_sec,
                )
                return result

            except Exception:
                logger.exception("ASR transcription failed")
                return None

    @staticmethod
    def _clean_whisper_output(text: str) -> str:
        import re

        if not text:
            return text

        text = re.sub(r'(\b\w{1,15}[.!?]?\s*)\1{2,}', r'\1', text)
        text = re.sub(r'([\u3000-\u9fff]{1,5}[。、]?\s*)\1{2,}', r'\1', text)

        text = re.sub(r'>>', '', text)
        text = re.sub(r'<<', '', text)
        text = re.sub(r'\[.*?\]', '', text)
        text = re.sub(r'\(.*?\)', '', text)

        noise_patterns = [
            r'(?i)thanks?\s+for\s+watching\.?',
            r'(?i)please\s+subscribe\.?',
            r'(?i)like\s+and\s+subscribe\.?',
            r'ご視聴ありがとうございました。?',
            r'チャンネル登録お願いします。?',
        ]
        for pattern in noise_patterns:
            text = re.sub(pattern, '', text)

        text = re.sub(r'\s+', ' ', text).strip()
        return text
