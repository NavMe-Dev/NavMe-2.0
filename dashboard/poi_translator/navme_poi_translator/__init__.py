"""navme-poi-translator

Translate NavMe POI names into multiple languages (English, Spanish, French,
Arabic, Chinese, Japanese) and insert them into the `navme_pois` Supabase table.
"""

from .config import Settings
from .languages import LANGUAGES, LANGUAGES_BY_CODE, Language, resolve_languages
from .service import PoiTranslatorService
from .supabase_client import SupabaseClient, SupabaseError
from .translators import (
    DeepLTranslatorBackend,
    GoogleTranslatorBackend,
    PassthroughTranslator,
    TranslationError,
    Translator,
    build_translator,
)

__version__ = "0.1.0"

__all__ = [
    "Settings",
    "LANGUAGES",
    "LANGUAGES_BY_CODE",
    "Language",
    "resolve_languages",
    "PoiTranslatorService",
    "SupabaseClient",
    "SupabaseError",
    "Translator",
    "GoogleTranslatorBackend",
    "DeepLTranslatorBackend",
    "PassthroughTranslator",
    "TranslationError",
    "build_translator",
]
