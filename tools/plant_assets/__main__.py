from __future__ import annotations

import argparse
from pathlib import Path

from .catalog import export_catalog


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare reproducible Plant Friends offline assets")
    commands = parser.add_subparsers(dest="command", required=True)
    catalog = commands.add_parser("catalog", help="Read-only PFAF SQLite export")
    catalog.add_argument("--database", required=True, type=Path)
    catalog.add_argument("--output", type=Path, default=Path("public/packs/pfaf"))
    model = commands.add_parser("prepare-model", help="Export the full BioCLIP 2 encoder and catalog vectors")
    model.add_argument("--catalog", required=True, type=Path)
    model.add_argument("--revision", required=True)
    model.add_argument("--output", type=Path, default=Path("public/packs/bioclip2"))
    model.add_argument("--limit", type=int, help="Explicit feasibility-only subset; omit for the full catalog")
    fixtures = commands.add_parser("fixtures", help="Retrieve pinned licensed evaluation photos")
    fixtures.add_argument("--manifest", type=Path, default=Path("fixtures/photos.json"))
    fixtures.add_argument("--discover", action="store_true", help="Select a small initial exact-name sample")
    reference = commands.add_parser("reference", help="Generate real image reference tensors and check the FP32 ONNX export")
    reference.add_argument("--pack", required=True, type=Path)
    reference.add_argument("--check-export", action="store_true")
    args = parser.parse_args()
    if args.command == "catalog":
        print(export_catalog(args.database, args.output))
    elif args.command == "prepare-model":
        from .model import prepare_model
        print(prepare_model(args.catalog, args.revision, args.output, args.limit))
    elif args.command == "fixtures":
        from .fixtures import fetch_fixtures
        fetch_fixtures(args.manifest, args.discover)
    elif args.command == "reference":
        from .reference import create_references
        print(create_references(args.pack, args.check_export))


if __name__ == "__main__":
    main()
