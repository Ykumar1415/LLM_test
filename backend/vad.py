from __future__ import annotations

import logging
import numpy as np
from . import config

logger = logging.getLogger(__name__)

class VoiceActivityDetector:
    def __init__(
        self,
        energy_threshold: float = config.VAD_ENERGY_THRESHOLD,
        silence_duration: float = config.VAD_SILENCE_DURATION_SEC,
        min_speech_duration: float = config.VAD_MIN_SPEECH_DURATION_SEC,
        min_buffer: float = config.VAD_MIN_BUFFER_SEC,
        max_buffer: float = config.VAD_MAX_BUFFER_SEC,
        pre_speech: float = config.VAD_PRE_SPEECH_SEC,
        sample_rate: int = config.SAMPLE_RATE,
        chunk_duration: float = config.CHUNK_DURATION_SEC
    ):
        self._energy_threshold = energy_threshold
        self._silence_frames = int(silence_duration / chunk_duration)
        self._min_speech_frames = int(min_speech_duration / chunk_duration)
        self._min_buffer_samples = int(min_buffer * sample_rate)
        self._max_buffer_samples = int(max_buffer * sample_rate)
        
        pre_samples = int(pre_speech * sample_rate)
        self._ring_buffer = np.zeros(pre_samples, dtype=np.float32)
        self._ring_pos = 0

        self._buffer: list[np.ndarray] = []
        self._buffer_len: int = 0
        self._silence_counter: int = 0
        self._speech_counter: int = 0
        self._is_speaking_flag: bool = False

    @property
    def is_speaking(self) -> bool:
        return self._is_speaking_flag

    def _add_to_ring_buffer(self, chunk: np.ndarray) -> None:
        if len(self._ring_buffer) == 0:
            return
        n = len(chunk)
        if n >= len(self._ring_buffer):
            self._ring_buffer[:] = chunk[-len(self._ring_buffer):]
            self._ring_pos = 0
        else:
            space_at_end = len(self._ring_buffer) - self._ring_pos
            if n <= space_at_end:
                self._ring_buffer[self._ring_pos:self._ring_pos + n] = chunk
            else:
                self._ring_buffer[self._ring_pos:] = chunk[:space_at_end]
                self._ring_buffer[:n - space_at_end] = chunk[space_at_end:]
            self._ring_pos = (self._ring_pos + n) % len(self._ring_buffer)

    def _get_ring_buffer(self) -> np.ndarray:
        if len(self._ring_buffer) == 0:
            return np.array([], dtype=np.float32)
        return np.concatenate((self._ring_buffer[self._ring_pos:], self._ring_buffer[:self._ring_pos]))

    def get_current_buffer(self) -> np.ndarray:
        if not self._buffer:
            return np.array([], dtype=np.float32)
        return np.concatenate(self._buffer)

    def process(self, chunk: np.ndarray) -> np.ndarray | None:
        rms = np.sqrt(np.mean(chunk**2)) if len(chunk) > 0 else 0.0
        is_speech_chunk = rms > self._energy_threshold

        if is_speech_chunk:
            self._speech_counter += 1
            self._silence_counter = 0
            if not self._is_speaking_flag and self._speech_counter >= self._min_speech_frames:
                self._is_speaking_flag = True
                pre_audio = self._get_ring_buffer()
                if len(pre_audio) > 0:
                    self._buffer.append(pre_audio)
                    self._buffer_len += len(pre_audio)
        else:
            if self._is_speaking_flag:
                self._silence_counter += 1
            else:
                self._speech_counter = 0

        if self._is_speaking_flag:
            self._buffer.append(chunk)
            self._buffer_len += len(chunk)

            if self._buffer_len >= self._max_buffer_samples:
                return self._flush()

            if self._silence_counter >= self._silence_frames:
                if self._buffer_len >= self._min_buffer_samples:
                    return self._flush()
                else:
                    self._reset()
        else:
            self._add_to_ring_buffer(chunk)

        return None

    def _flush(self) -> np.ndarray | None:
        if not self._buffer:
            self._reset()
            return None
            
        audio_data = np.concatenate(self._buffer)
        self._reset()
        return audio_data

    def _reset(self) -> None:
        self._buffer = []
        self._buffer_len = 0
        self._silence_counter = 0
        self._speech_counter = 0
        self._is_speaking_flag = False
