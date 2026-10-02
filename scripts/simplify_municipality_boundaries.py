#!/usr/bin/env python3
"""Dissolve N03 2025 polygons and simplify them as a shared coverage."""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

import geopandas as gpd
import shapely


FIELDS = ["N03_001", "N03_003", "N03_004", "N03_005", "N03_007"]
DEFAULT_TOLERANCE = 0.01
MIN_COMPONENT_AREA = 0.0001  # roughly 1 km² around Japan


def keep_visible_components(geometry: shapely.Geometry) -> tuple[shapely.Geometry, int]:
    if geometry.geom_type == "Polygon":
        return geometry, 0
    if geometry.geom_type != "MultiPolygon":
        raise ValueError(f"Unexpected municipality geometry: {geometry.geom_type}")

    parts = list(geometry.geoms)
    kept = [part for part in parts if part.area >= MIN_COMPONENT_AREA]
    if not kept:
        kept = [max(parts, key=lambda part: part.area)]
    result = kept[0] if len(kept) == 1 else shapely.MultiPolygon(kept)
    return result, len(parts) - len(kept)


def write_geojson(data: gpd.GeoDataFrame, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.stem}-", suffix=".geojson", dir=destination.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        data.to_file(temporary_path, driver="GeoJSON", index=False)
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)


def simplify_boundaries(source: Path, municipalities_path: Path, prefectures_path: Path, tolerance: float) -> None:
    if not hasattr(shapely, "coverage_simplify"):
        raise RuntimeError("Shapely 2.1 or newer is required for coverage_simplify")

    areas = gpd.read_file(source, columns=FIELDS)
    missing = [field for field in FIELDS if field not in areas.columns]
    if missing:
        raise ValueError(f"N03 source is missing fields: {missing}")

    areas = areas.loc[areas["N03_007"].notna(), FIELDS + ["geometry"]].copy()
    areas["N03_007"] = areas["N03_007"].astype(str).str.strip().str.zfill(5)
    if areas["N03_007"].duplicated().any():
        municipalities = areas.dissolve(by="N03_007", as_index=False, aggfunc="first")
    else:
        municipalities = areas
    geometries = municipalities.geometry.to_list()

    if not shapely.coverage_is_valid(geometries):
        raise ValueError("Dissolved N03 municipality geometries do not form a valid coverage")

    simplified = shapely.coverage_simplify(
        geometries,
        tolerance=tolerance,
        simplify_boundary=True,
    )
    if len(simplified) != len(municipalities):
        raise ValueError("Coverage simplification changed the municipality count")
    visible_geometries = [keep_visible_components(geometry) for geometry in simplified]
    simplified = [geometry for geometry, _ in visible_geometries]
    dropped_components = sum(count for _, count in visible_geometries)
    if any(geometry.is_empty or not geometry.is_valid for geometry in simplified):
        raise ValueError("Coverage simplification produced an empty or invalid geometry")
    if not shapely.coverage_is_valid(simplified):
        raise ValueError("Simplified municipalities no longer form a valid coverage")

    municipalities["geometry"] = simplified
    municipalities.sort_values("N03_007", inplace=True)
    prefectures = municipalities[["N03_001", "geometry"]].dissolve(
        by="N03_001", as_index=False, aggfunc="first"
    )
    prefectures.sort_values("N03_001", inplace=True)

    write_geojson(municipalities, municipalities_path)
    write_geojson(prefectures, prefectures_path)
    print(
        f"Wrote {len(municipalities):,} municipalities and {len(prefectures):,} prefectures "
        f"with coverage simplification (tolerance {tolerance:g}); "
        f"omitted {dropped_components:,} sub-km² isolated components."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("data/source/N03-20250101.geojson"),
        help="Raw MLIT N03-2025 GeoJSON before municipality-level simplification",
    )
    parser.add_argument(
        "--municipalities",
        type=Path,
        default=Path("public/data/municipalities.geojson"),
    )
    parser.add_argument(
        "--prefectures",
        type=Path,
        default=Path("public/data/prefectures.geojson"),
    )
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    args = parser.parse_args()

    if args.tolerance <= 0:
        parser.error("--tolerance must be greater than zero")
    simplify_boundaries(args.source, args.municipalities, args.prefectures, args.tolerance)


if __name__ == "__main__":
    main()
