from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import NamedTuple

from . import config

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a professional translator. "
    "Translate English to natural Japanese. "
    "Output ONLY the Japanese translation with no explanations, notes, or English text."
)


class TranslationResult(NamedTuple):
    text: str
    source_lang: str
    target_lang: str
    cached: bool = False


class TranslationEngine:
    """Translates English text to Japanese using Ollama."""

    def __init__(self):
        self.model_id = config.OLLAMA_MODEL

    def load(self) -> None:
        logger.info("Translation engine initialized: Ollama (%s)", self.model_id)

    @property
    def is_loaded(self) -> bool:
        return True

    def translate(
        self, text: str, source_lang: str = "en", session_context=None
    ) -> TranslationResult:
        """Translate English text to Japanese."""
        if not text.strip():
            return TranslationResult(
                text=text, source_lang="en", target_lang="ja", cached=True
            )

        return self._translate_ollama(text)

    def _translate_ollama(self, text: str) -> TranslationResult:
        prompt = f"Translate this English to natural Japanese:\n\n{text}\n\nJapanese:"
        data = {
            "model": self.model_id,
            "prompt": prompt,
            "stream": False,
            "system": SYSTEM_PROMPT,
            "options": {"temperature": 0.3, "num_ctx": 4096, "num_thread": 4},
        }

        req = urllib.request.Request(
            config.OLLAMA_URL,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
                translated = result.get("response", "").strip()

                cleanup_phrases = [
                    "You are a professional English to Japanese translator",
                    "Your task is to translate",
                    "Follow these rules",
                    "Here is the translation",
                    "Translation:",
                    "Japanese:",
                    "Natural Japanese translation:",
                ]

                for phrase in cleanup_phrases:
                    if phrase.lower() in translated.lower():
                        idx = translated.lower().rfind(phrase.lower())
                        translated = translated[idx + len(phrase) :].strip()

                for i, char in enumerate(translated):
                    if (
                        "\u3040" <= char <= "\u309f"
                        or "\u30a0" <= char <= "\u30ff"
                        or "\u4e00" <= char <= "\u9fff"
                    ):
                        translated = translated[i:]
                        break

                if translated.startswith(('"', "'", "「")):
                    translated = translated.strip("\"'「」")

                if any(
                    eng_word in translated
                    for eng_word in [
                        "translate",
                        "English",
                        "Japanese",
                        "task",
                        "professional",
                    ]
                ):
                    lines = translated.split("\n")
                    japanese_lines = []
                    for line in lines:
                        if any(
                            "\u3040" <= c <= "\u309f"
                            or "\u30a0" <= c <= "\u30ff"
                            or "\u4e00" <= c <= "\u9fff"
                            for c in line
                        ):
                            if not any(
                                word in line.lower()
                                for word in [
                                    "you are",
                                    "translate",
                                    "task",
                                    "follow",
                                    "rules",
                                ]
                            ):
                                japanese_lines.append(line.strip())

                    if japanese_lines:
                        translated = "\n".join(japanese_lines)

                return TranslationResult(
                    text=translated, source_lang="en", target_lang="ja"
                )
        except urllib.error.URLError as e:
            logger.error("Ollama connection failed: %s", e)
            return TranslationResult(
                text="{Translation Error}", source_lang="en", target_lang="ja"
            )
        except Exception as e:
            logger.error("Ollama translation failed: %s", e)
            return TranslationResult(
                text="{Translation Error}", source_lang="en", target_lang="ja"
            )

    @staticmethod
    def _is_japanese(char: str) -> bool:
        return (
            "\u3040" <= char <= "\u309f"
            or "\u30a0" <= char <= "\u30ff"
            or "\u4e00" <= char <= "\u9fff"
        )
