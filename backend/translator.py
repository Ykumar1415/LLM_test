from __future__ import annotations

import logging
import json
import urllib.request
import urllib.error
from typing import NamedTuple

from . import config

logger = logging.getLogger(__name__)


class TranslationResult(NamedTuple):
    text: str
    source_lang: str
    target_lang: str
    cached: bool = False


class TranslationEngine:
    def __init__(self, engine_type: str = config.TRANSLATION_ENGINE):
        self._engine_type = engine_type
        if self._engine_type == "ollama":
            self.model_id = config.OLLAMA_MODEL
        else:
            raise ValueError(f"Unknown translation engine: {engine_type}")

    def load(self) -> None:
        logger.info("Translation engine initialized: %s (%s)", self._engine_type, self.model_id)

    @property
    def is_loaded(self) -> bool:
        return True

    def translate(self, text: str, source_lang: str, session_context=None) -> TranslationResult:
        if not text.strip() or source_lang == "en":
            return TranslationResult(text=text, source_lang="en", target_lang="en", cached=True)

        if self._engine_type == "ollama":
            return self._translate_ollama(text, source_lang, session_context)
            
        return TranslationResult(text="[Error] Unsupported engine", source_lang=source_lang, target_lang="en")

    def summarize(self, history: list[str], previous_summary: str | None = None) -> str | None:
        if not history:
            return None
            
        if self._engine_type == "ollama":
            return self._summarize_ollama(history, previous_summary)
            
        return None

    def _translate_ollama(self, text: str, source_lang: str, session_context) -> TranslationResult:
        url = "http://localhost:11434/api/generate"
        
        if source_lang == "ja":
            direction = "Japanese to English"
        elif source_lang == "en":
            direction = "English to Japanese"
        else:
            direction = f"'{source_lang}' to English"

        model_name = self.model_id.lower()
        
        if "tinyllama" in model_name or "gemma2" in model_name:
            if source_lang == "ja":
                prompt = f"Japanese: こんにちは\nEnglish: Hello\nJapanese: ありがとうございます\nEnglish: Thank you\nJapanese: {text}\nEnglish:"
            else:
                prompt = f"English: Hello\nJapanese: こんにちは\nEnglish: Thank you\nJapanese: ありがとうございます\nEnglish: {text}\nJapanese:"
        else:
            prompt = (
                f"You are a professional {direction} translator. "
                "Output ONLY the translation, without any notes, apologies, or extra text.\n\n"
            )
            
            recent_context = session_context.get_prompt() if session_context else None
            if recent_context:
                prompt += f"Recent conversation context: {recent_context}\n\n"
            
            prompt += f"Text to translate:\n<text>\n{text}\n</text>\nTranslation:"

        data = {
            "model": self.model_id,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.1, 
                "num_ctx": 4096,
                "num_thread": 4
            }
        }

        req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
                translated = result.get("response", "").strip()
                
                if translated.lower().startswith("here is the translation"):
                    translated = translated.split("\n", 1)[-1].strip()
                    
                return TranslationResult(
                    text=translated, 
                    source_lang=source_lang, 
                    target_lang="en"
                )
        except Exception as e:
            logger.error("Ollama translation failed: %s", e)
            return TranslationResult(text="[Local LLM Error]", source_lang=source_lang, target_lang="en")

    def _summarize_ollama(self, history: list[str], previous_summary: str | None = None) -> str | None:
        url = "http://localhost:11434/api/generate"
        
        conversation = "\n".join(history)
        prompt = (
            "You are an AI assistant. Summarize the following meeting conversation concisely in 1-2 sentences. "
            "Highlight the main topics and any key decisions or actions based ONLY on the Original Text provided.\n\n"
        )
        if previous_summary:
            prompt += f"[Previous Summary Context]: {previous_summary}\n\n"
            
        prompt += f"[Original Text]:\n{conversation}\n\nSummary:"

        data = {
            "model": self.model_id,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.3,
                "num_ctx": 4096,
                "num_thread": 4
            }
        }

        req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.loads(response.read().decode("utf-8"))
                return result.get("response", "").strip()
        except urllib.error.URLError as e:
            logger.error("Ollama summary error: %s", e)
            return None
