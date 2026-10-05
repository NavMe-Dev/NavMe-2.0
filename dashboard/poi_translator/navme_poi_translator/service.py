"""High-level service: translate a POI name and insert it into navme_pois."""

import logging
from typing import Any, Dict, List, Optional

from .config import Settings
from .languages import Language, resolve_languages
from .supabase_client import SupabaseClient
from .translators import Translator, build_translator

logger = logging.getLogger(__name__)


class PoiTranslatorService:
    def __init__(
        self,
        settings: Settings,
        translator: Optional[Translator] = None,
        client: Optional[SupabaseClient] = None,
    ) -> None:
        settings.validate()
        self.settings = settings
        self.translator = translator or build_translator(
            settings.translator_backend, settings.deepl_api_key
        )
        self.client = client or SupabaseClient(
            settings.supabase_url, settings.supabase_key
        )

    def translate_name(
        self,
        name: str,
        source: Optional[str] = None,
        languages: Optional[List[Language]] = None,
    ) -> Dict[str, str]:
        """Translate `name` into each target language.

        Returns a dict mapping the short language code to the translated string.
        On a per-language failure the original name is used as a safe fallback.
        """
        source = source or self.settings.source_language
        targets = languages if languages is not None else resolve_languages()
        result: Dict[str, str] = {}
        for lang in targets:
            # Skip a translation round-trip when the target equals the source.
            if source not in (None, "", "auto") and source.lower() == lang.code.lower():
                result[lang.code] = name
                continue
            try:
                result[lang.code] = self.translator.translate(name, lang, source)
            except Exception as exc:  # noqa: BLE001 - fall back, never block insert
                logger.warning(
                    "Translation to %s failed (%s); using original text.",
                    lang.code,
                    exc,
                )
                result[lang.code] = name
        return result

    def build_poi_row(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        category_type: Optional[str] = None,
        poi_type: Optional[str] = None,
        node_id: Optional[str] = None,
        icon_url: Optional[str] = None,
        pos_x: float = 0.0,
        pos_y: float = 0.0,
        pos_z: float = 0.0,
        show_in_ar: bool = True,
        is_active: bool = True,
        amenities_desc: Optional[str] = None,
        highlight_desc: Optional[str] = None,
        technology_desc: Optional[str] = None,
        source: Optional[str] = None,
        translations: Optional[Dict[str, str]] = None,
        description_translations: Optional[Dict[str, str]] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build the row dict (translations + metadata) ready for insertion."""
        if translations is None:
            translations = self.translate_name(name, source)

        desc_text = (description or "").strip()
        if description_translations is None and desc_text:
            description_translations = self.translate_name(desc_text, source)

        row: Dict[str, Any] = {
            "poi_name": name,
            "description": description,
            "category_type": category_type,
            "poi_type": poi_type if poi_type is not None else self.settings.poi_type,
            "organization_id": self.settings.organization_id,
            "node_id": node_id,
            "icon_url": icon_url,
            "pos_x": pos_x,
            "pos_y": pos_y,
            "pos_z": pos_z,
            "show_in_ar": show_in_ar,
            "is_active": is_active,
            "amenities_desc": amenities_desc,
            "highlight_desc": highlight_desc,
            "technology_desc": technology_desc,
            "poi_names": translations,
        }
        for lang in resolve_languages():
            row[lang.column] = translations.get(lang.code, name)

        if description_translations:
            row["descriptions"] = description_translations
            for lang in resolve_languages():
                row[lang.description_column] = description_translations.get(
                    lang.code, desc_text
                )

        if extra:
            row.update(extra)

        # PostgREST rejects None for some columns; drop them so DB defaults apply.
        return {k: v for k, v in row.items() if v is not None}

    def add_poi(self, name: str, **kwargs: Any) -> Dict[str, Any]:
        """Translate `name`, insert the POI, and return the created row.

        Accepts the same keyword arguments as `build_poi_row`.
        """
        row = self.build_poi_row(name, **kwargs)
        logger.info("Inserting POI '%s' with %d translations.", name, len(row.get("poi_names", {})))
        return self.client.insert_poi(row)

    def backfill_translations(
        self, poi_type: Optional[str] = None, overwrite: bool = False
    ) -> int:
        """Fill in missing language columns for existing POIs.

        Backfills both `poi_name_*` / `poi_names` and `description_*` /
        `descriptions` when a base description is present.

        Returns the number of rows updated.
        """
        scope = poi_type if poi_type is not None else self.settings.poi_type
        rows = self.client.fetch_pois(poi_type=scope)
        languages = resolve_languages()
        updated = 0
        for row in rows:
            name = row.get("poi_name")
            if not name:
                continue

            patch: Dict[str, Any] = {}

            missing_names = [
                lang
                for lang in languages
                if overwrite or not str(row.get(lang.column) or "").strip()
            ]
            if missing_names:
                translations = self.translate_name(name, languages=missing_names)
                patch.update({lang.column: translations[lang.code] for lang in missing_names})
                merged_names = dict(row.get("poi_names") or {})
                merged_names.update(translations)
                patch["poi_names"] = merged_names

            desc_text = str(row.get("description") or "").strip()
            if desc_text:
                missing_descriptions = [
                    lang
                    for lang in languages
                    if overwrite
                    or not str(row.get(lang.description_column) or "").strip()
                    or str(row.get(lang.description_column) or "").strip() == desc_text
                ]
                # Always keep English aligned with the base description when missing.
                if "en" not in {lang.code for lang in missing_descriptions}:
                    en_val = str(row.get("description_en") or "").strip()
                    if overwrite or not en_val or en_val != desc_text:
                        missing_descriptions = list(
                            dict.fromkeys(
                                missing_descriptions
                                + [lang for lang in languages if lang.code == "en"]
                            )
                        )
                if missing_descriptions:
                    description_translations = self.translate_name(
                        desc_text, languages=missing_descriptions
                    )
                    if any(lang.code == "en" for lang in missing_descriptions):
                        description_translations["en"] = desc_text
                    patch.update(
                        {
                            lang.description_column: description_translations[lang.code]
                            for lang in missing_descriptions
                        }
                    )
                    merged_descriptions = dict(row.get("descriptions") or {})
                    merged_descriptions.update(description_translations)
                    patch["descriptions"] = merged_descriptions

            if not patch:
                continue
            self.client.update_poi(row["id"], patch)
            updated += 1
            logger.info("Backfilled translations for '%s'.", name)
        return updated
