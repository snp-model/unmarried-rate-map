#!/usr/bin/env python3
"""Download the official 2025 Census unknown-imputed tables used by the rate processor."""

from __future__ import annotations

import hashlib
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "data/source/census2025_table_4-4_imputed.xlsx"
URL = "https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000040506667"
SHA256 = "da4a1e2e7affd70083c9a49ee045562b413972bb776135124b3f7ff9a1bb7a26"
COUNT_DESTINATION = ROOT / "data/source/census2025_table_4-3_imputed.xlsx"
COUNT_URL = "https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000040506666"
COUNT_SHA256 = "0fa0ba099a496484b74fe5834ae3fd9fc0c3cb267dfc25a1c61f769e3fb681db"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_table(destination: Path, url: str, expected_sha256: str | None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        actual = sha256_file(destination)
        if expected_sha256 is None or actual == expected_sha256:
            print(f"Verified existing official table: {destination}")
            return

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.stem}.", suffix=".part", dir=destination.parent, delete=False
        ) as output:
            temporary_path = Path(output.name)
            request = urllib.request.Request(url, headers={"User-Agent": "unmarried-rate-map/0.1"})
            with urllib.request.urlopen(request, timeout=120) as response:
                shutil.copyfileobj(response, output, length=1024 * 1024)

        actual = sha256_file(temporary_path)
        if expected_sha256 is not None and actual != expected_sha256:
            raise ValueError(f"SHA-256 mismatch: expected {expected_sha256}, got {actual}")
        with zipfile.ZipFile(temporary_path) as archive:
            if archive.testzip() is not None:
                raise ValueError("The downloaded Excel workbook is damaged")
        temporary_path.replace(destination)
        print(f"Downloaded official table: {destination} (SHA-256 {actual})")
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> None:
    download_table(DESTINATION, URL, SHA256)
    download_table(COUNT_DESTINATION, COUNT_URL, COUNT_SHA256)


if __name__ == "__main__":
    main()
