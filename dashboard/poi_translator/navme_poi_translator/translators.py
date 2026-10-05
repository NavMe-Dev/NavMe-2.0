"""Pluggable translation backends.

Default backend is Google via `deep-translator` (no API key needed). An
optional DeepL backend is available when the `deepl` package and an API key are
configured.
"""

from abc import ABC, abstractmethod
from typing import Optional

from .languages import Language

# Optional third-party backends. Imported at module load (guarded) so the rest
# of the package still works when only one backend is installed.
try:
    from deep_translator import GoogleTranslator as _GoogleTranslator
except ImportError:  # pragma: no cover - optional dependency
    _GoogleTranslator = None

try:
    import deepl as _deepl
except ImportError:  # pragma: no cover - optional dependency
    _deepl = None


class TranslationError(RuntimeError):
    pass


class Translator(ABC):
    """Translate a single string into a target language."""

    @abstractmethod
    def translate(self, text: str, target: Language, source: str = "auto") -> str:
        ...


class PassthroughTranslator(Translator):
    """Returns the input unchanged. Useful for tests / dry runs."""

    def translate(self, text: str, target: Language, source: str = "auto") -> str:
        return text


class GoogleTranslatorBackend(Translator):
    """Google Translate via the `deep-translator` library."""

    def __init__(self) -> None:
        if _GoogleTranslator is None:
            raise TranslationError(
                "deep-translator is not installed. Run `pip install deep-translator`."
            )

    def translate(self, text: str, target: Language, source: str = "auto") -> str:
        if not text or not text.strip():
            return text
        translated = _GoogleTranslator(
            source=source or "auto", target=target.google_code
        ).translate(text)
        return translated if translated is not None else text


class DeepLTranslatorBackend(Translator):
    """DeepL translation (higher quality, requires an API key)."""

    def __init__(self, api_key: Optional[str]) -> None:
        if _deepl is None:
            raise TranslationError(
                "deepl is not installed. Run `pip install deepl` and set DEEPL_API_KEY."
            )
        if not api_key:
            raise TranslationError("DEEPL_API_KEY is required for the deepl backend.")
        self._client = _deepl.Translator(api_key)

    def translate(self, text: str, target: Language, source: str = "auto") -> str:
        if not text or not text.strip():
            return text
        # DeepL expects e.g. EN, ES, FR, AR, ZH, JA (uppercase, no region here).
        target_lang = target.code.upper()
        source_lang = None if source in (None, "", "auto") else source.upper()
        result = self._client.translate_text(
            text, target_lang=target_lang, source_lang=source_lang
        )
        return result.text


def build_translator(backend: str, deepl_api_key: Optional[str] = None) -> Translator:
    """Factory that returns a Translator for the configured backend."""
    normalized = (backend or "google").lower()
    if normalized == "google":
        return GoogleTranslatorBackend()
    if normalized == "deepl":
        return DeepLTranslatorBackend(deepl_api_key)
    if normalized in ("passthrough", "none", "noop"):
        return PassthroughTranslator()
    raise TranslationError(
        f"Unknown translator backend '{backend}'. Use 'google', 'deepl' or 'passthrough'."
    )
