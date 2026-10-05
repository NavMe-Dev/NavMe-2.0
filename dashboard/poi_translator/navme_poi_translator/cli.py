"""Command-line interface for the NavMe POI translator.

Examples:
    navme-poi translate --name "Main Lobby"
    navme-poi add --name "Main Lobby" --poi-type suhas_house --x 1.2 --y 0 --z -3.4
    navme-poi backfill --poi-type suhas_house
"""

import argparse
import json
import logging
import sys
from typing import List, Optional

from .config import Settings
from .service import PoiTranslatorService


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="navme-poi",
        description="Translate NavMe POI names and insert them into navme_pois.",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable info logging."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    translate = sub.add_parser("translate", help="Translate a name and print JSON (no DB write).")
    translate.add_argument("--name", required=True, help="POI name to translate.")
    translate.add_argument("--source", default=None, help="Source language code (default: auto).")

    add = sub.add_parser("add", help="Translate a name and insert a new POI.")
    add.add_argument("--name", required=True, help="POI name (base text).")
    add.add_argument("--description", default=None)
    add.add_argument("--category-type", default=None, help="category_type UUID.")
    add.add_argument("--poi-type", default=None, help="Project poi_type scope.")
    add.add_argument("--node-id", default=None, help="Nav node UUID.")
    add.add_argument("--icon-url", default=None)
    add.add_argument("--x", type=float, default=0.0, dest="pos_x")
    add.add_argument("--y", type=float, default=0.0, dest="pos_y")
    add.add_argument("--z", type=float, default=0.0, dest="pos_z")
    add.add_argument("--hidden-in-ar", action="store_true", help="Set show_in_ar=false.")
    add.add_argument("--inactive", action="store_true", help="Set is_active=false.")
    add.add_argument("--source", default=None, help="Source language code (default: auto).")
    add.add_argument("--dry-run", action="store_true", help="Print the row instead of inserting.")

    backfill = sub.add_parser(
        "backfill", help="Fill missing translations for existing POIs."
    )
    backfill.add_argument("--poi-type", default=None, help="Limit to a project poi_type.")
    backfill.add_argument(
        "--overwrite", action="store_true", help="Re-translate even if a value exists."
    )

    return parser


def _cmd_translate(service: PoiTranslatorService, args: argparse.Namespace) -> int:
    translations = service.translate_name(args.name, source=args.source)
    print(json.dumps(translations, ensure_ascii=False, indent=2))
    return 0


def _cmd_add(service: PoiTranslatorService, args: argparse.Namespace) -> int:
    kwargs = dict(
        description=args.description,
        category_type=args.category_type,
        poi_type=args.poi_type,
        node_id=args.node_id,
        icon_url=args.icon_url,
        pos_x=args.pos_x,
        pos_y=args.pos_y,
        pos_z=args.pos_z,
        show_in_ar=not args.hidden_in_ar,
        is_active=not args.inactive,
        source=args.source,
    )
    if args.dry_run:
        row = service.build_poi_row(args.name, **kwargs)
        print(json.dumps(row, ensure_ascii=False, indent=2))
        return 0
    created = service.add_poi(args.name, **kwargs)
    print(json.dumps(created, ensure_ascii=False, indent=2))
    return 0


def _cmd_backfill(service: PoiTranslatorService, args: argparse.Namespace) -> int:
    count = service.backfill_translations(poi_type=args.poi_type, overwrite=args.overwrite)
    print(f"Updated {count} POI row(s).")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    try:
        service = PoiTranslatorService(Settings.from_env())
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    command = args.command
    if command == "translate":
        return _cmd_translate(service, args)
    if command == "add":
        return _cmd_add(service, args)
    if command == "backfill":
        return _cmd_backfill(service, args)
    # argparse enforces a valid subcommand, so this is unreachable.
    raise AssertionError(f"Unhandled command: {command}")


if __name__ == "__main__":
    raise SystemExit(main())
