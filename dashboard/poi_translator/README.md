# navme-poi-translator

A small Python package that translates a NavMe POI name into multiple languages
and inserts the POI into the `navme_pois` Supabase table — so every new POI is
saved with all its language variants automatically.

## What it does

When you add a POI, the base `poi_name` is translated into:

| Code | Language              | Column          |
| ---- | --------------------- | --------------- |
| `en` | English               | `poi_name_en`   |
| `es` | Spanish               | `poi_name_es`   |
| `fr` | French                | `poi_name_fr`   |
| `ar` | Arabic                | `poi_name_ar`   |
| `zh` | Chinese (Simplified)  | `poi_name_zh`   |
| `ja` | Japanese              | `poi_name_ja`   |
| `hi` | Hindi                 | `poi_name_hi`   |
| `kn` | Kannada               | `poi_name_kn`   |
| `pt` | Portuguese            | `poi_name_pt`   |
| `ta` | Tamil                 | `poi_name_ta`   |
| `te` | Telugu                | `poi_name_te`   |
| `ml` | Malayalam             | `poi_name_ml`   |
| `bn` | Bengali               | `poi_name_bn`   |

All translations are also written to the `poi_names` jsonb column (e.g.
`{"en": "...", "es": "...", ...}`), matching the shape already used in your table.

## Install

From the `poi_translator/` folder:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e .                 # or: pip install -r requirements.txt
```

The default translator is Google via `deep-translator` and needs **no API key**.

## Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

Key variables:

- `SUPABASE_URL` — your project URL (e.g. `https://znfwcohrpkiccibqcfpn.supabase.co`).
- `SUPABASE_KEY` — service role key recommended for a backend script (bypasses RLS).
  The anon key works too if your RLS policy allows anon inserts.
- `NAVME_ORGANIZATION_ID` — required on `navme_pois` (defaults to the shared NavMe org).
- `NAVME_POI_TYPE` — the project scope for the POIs you add.
- `TRANSLATOR_BACKEND` — `google` (default) or `deepl`.
- `SOURCE_LANGUAGE` — language of the name you type (`auto` by default).

## Use it — CLI

```bash
# Preview translations only (no DB write)
navme-poi translate --name "Main Lobby"

# Translate + insert a new POI
navme-poi add --name "Main Lobby" --poi-type suhas_house --x 1.2 --y 0 --z -3.4

# See the exact row without writing (handy for debugging)
navme-poi add --name "Main Lobby" --dry-run

# Backfill missing translations on POIs you already added
navme-poi backfill --poi-type suhas_house
```

Add `-v` for info logs. You can also run it as a module: `python -m navme_poi_translator ...`.

## Use it — Python

```python
from navme_poi_translator import PoiTranslatorService, Settings

service = PoiTranslatorService(Settings.from_env())

# Just translate
names = service.translate_name("Main Lobby")
# -> {"en": "Main Lobby", "es": "Vestíbulo principal", "fr": "Hall principal", ...}

# Translate and insert
created = service.add_poi(
    "Main Lobby",
    description="Ground floor reception area.",
    poi_type="suhas_house",
    pos_x=1.2, pos_y=0.0, pos_z=-3.4,
)
print(created["id"])
```

## Notes

- If a single language translation fails, the original name is used as a fallback
  so an insert never fails just because of a translation hiccup.
- `id`, `created_at`, `updated_at`, `show_in_ar`, and `is_active` use the table's
  own defaults unless you override them.
- To use DeepL instead of Google: `pip install deepl`, set `TRANSLATOR_BACKEND=deepl`
  and `DEEPL_API_KEY=...`.
