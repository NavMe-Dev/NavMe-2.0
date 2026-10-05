"""Language definitions for the navme_pois multilingual columns.

The `navme_pois` table stores a base `poi_name` plus one text column per
language (`poi_name_<code>`) and a `poi_names` jsonb map keyed by the short
language code.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    """A target language for POI name translation.

    Attributes:
        code: Short code stored in the `poi_names` jsonb and used as the
            `poi_name_<code>` column suffix (e.g. "zh").
        name: Human readable language name.
        google_code: Code understood by the Google translation backend, which
            sometimes differs from the DB code (e.g. "zh-CN" for Chinese).
    """

    code: str
    name: str
    google_code: str

    @property
    def column(self) -> str:
        return f"poi_name_{self.code}"

    @property
    def description_column(self) -> str:
        return f"description_{self.code}"


# Order matters only for display; English is kept first as the usual base.
LANGUAGES = (
    Language("en", "English", "en"),
    Language("es", "Spanish", "es"),
    Language("fr", "French", "fr"),
    Language("ar", "Arabic", "ar"),
    Language("zh", "Chinese (Simplified)", "zh-CN"),
    Language("ja", "Japanese", "ja"),
    Language("hi", "Hindi", "hi"),
    Language("kn", "Kannada", "kn"),
    Language("pt", "Portuguese", "pt"),
    Language("ta", "Tamil", "ta"),
    Language("te", "Telugu", "te"),
    Language("ml", "Malayalam", "ml"),
    Language("bn", "Bengali", "bn"),
)

LANGUAGES_BY_CODE = {lang.code: lang for lang in LANGUAGES}


def resolve_languages(codes=None):
    """Return the Language objects for the given codes (all if None).

    Raises:
        ValueError: if an unknown code is requested.
    """
    if not codes:
        return list(LANGUAGES)
    resolved = []
    for code in codes:
        lang = LANGUAGES_BY_CODE.get(code)
        if lang is None:
            valid = ", ".join(LANGUAGES_BY_CODE)
            raise ValueError(f"Unknown language code '{code}'. Valid codes: {valid}")
        resolved.append(lang)
    return resolved
