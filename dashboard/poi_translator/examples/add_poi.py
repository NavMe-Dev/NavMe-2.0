"""Example: translate a POI name and insert it into navme_pois.

Run from the poi_translator/ folder after creating a .env file:

    python examples/add_poi.py
"""

from navme_poi_translator import PoiTranslatorService, Settings


def main() -> None:
    service = PoiTranslatorService(Settings.from_env())

    # 1) Preview the translations only (no DB write).
    translations = service.translate_name("Main Lobby")
    print("Translations:")
    for code, text in translations.items():
        print(f"  {code}: {text}")

    # 2) Translate + insert a new POI. Uncomment to actually write to Supabase.
    # created = service.add_poi(
    #     "Main Lobby",
    #     description="Ground floor reception area.",
    #     poi_type="suhas_house",   # or leave None to use NAVME_POI_TYPE from .env
    #     pos_x=1.2,
    #     pos_y=0.0,
    #     pos_z=-3.4,
    # )
    # print("Created POI id:", created.get("id"))


if __name__ == "__main__":
    main()
