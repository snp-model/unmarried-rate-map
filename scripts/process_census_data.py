#!/usr/bin/env python3
"""Convert e-Stat's 2025 Census unknown-imputed tables 4-4 and 4-3 into compact JSON."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ROW_TAG = f"{{{NS['m']}}}row"
CELL_TAG = f"{{{NS['m']}}}c"
VALUE_TAG = f"{{{NS['m']}}}v"
TEXT_TAG = f"{{{NS['m']}}}t"

SEX_CODES = {"0_総数": "total", "1_男": "male", "2_女": "female"}
AGE_RE = re.compile(r"^\d+_(\d+)～(\d+)歳$")
AGE_OPEN_RE = re.compile(r"^\d+_(\d+)歳以上$")
KNOWN_MARITAL_STATUSES = {"1_未婚", "2_有配偶", "3_死別", "4_離別"}
UNMARRIED_STATUS = "1_未婚"
AGE_80_PLUS_IDS = {"80-84", "85-89", "90-94", "95-99", "100+"}


def col_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference)
    if not letters:
        raise ValueError(f"Unexpected Excel cell reference: {reference}")
    result = 0
    for char in letters.group(0):
        result = result * 26 + ord(char) - ord("A") + 1
    return result


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    root = ET.parse(archive.open("xl/sharedStrings.xml")).getroot()
    return ["".join(text.text or "" for text in item.iter(TEXT_TAG)) for item in root]


def cell_values(row: ET.Element, strings: list[str]) -> dict[int, str]:
    values: dict[int, str] = {}
    for cell in row.findall("m:c", NS):
        value = cell.find("m:v", NS)
        if value is None or value.text is None:
            continue
        raw = value.text
        if cell.get("t") == "s":
            raw = strings[int(raw)]
        values[col_index(cell.get("r", ""))] = raw.strip()
    return values


def parse_age_columns(headers: dict[int, str]) -> list[tuple[int, str, str]]:
    columns: list[tuple[int, str, str]] = []
    for column, header in headers.items():
        match = AGE_RE.fullmatch(header)
        if match:
            start, end = map(int, match.groups())
            columns.append((column, f"{start}-{end}", f"{start}～{end}歳"))
            continue
        match = AGE_OPEN_RE.fullmatch(header)
        if match:
            start = int(match.group(1))
            columns.append((column, f"{start}+", f"{start}歳以上"))
    columns.sort(key=lambda item: int(item[1].split("-")[0].rstrip("+")))
    expected = 18
    if len(columns) != expected:
        raise ValueError(f"Expected {expected} age groups, found {len(columns)}: {columns}")
    return columns


def number_or_none(value: str | None) -> float | None:
    if not value or value in {"-", "***", "…"}:
        return None
    result = float(value)
    if not 0 <= result <= 100:
        raise ValueError(f"Unmarried rate is outside 0-100: {value}")
    return round(result, 5)


def population_count(value: str | None) -> int | None:
    if value is None or value in {"***", "…"}:
        return None
    if value == "-":
        return 0
    result = float(value)
    if result < 0 or not result.is_integer():
        raise ValueError(f"Invalid population count: {value}")
    return int(result)


def age_start(age_id: str) -> int:
    return int(age_id.split("-", 1)[0].rstrip("+"))


def aggregate_count_data(
    source: Path,
) -> tuple[
    dict[str, dict[str, float | None]],
    dict[str, dict[str, dict[str, int | None]]],
]:
    totals: dict[tuple[str, str], list[int]] = {}
    population_sums: dict[tuple[str, str, str], int] = {}
    populations: dict[str, dict[str, dict[str, int | None]]] = {}
    with zipfile.ZipFile(source) as archive:
        strings = shared_strings(archive)
        sheet = archive.open("xl/worksheets/sheet1.xml")
        age_columns: list[tuple[int, str, str]] | None = None
        for _, row in ET.iterparse(sheet, events=("end",)):
            if row.tag != ROW_TAG:
                continue
            row_number = int(row.get("r", "0"))
            values = cell_values(row, strings)
            if row_number == 8:
                headers = {column: value for column, value in values.items() if column >= 7}
                age_columns = parse_age_columns(headers)
                available_80_plus = {age_id for _, age_id, _ in age_columns if age_start(age_id) >= 80}
                if available_80_plus != AGE_80_PLUS_IDS:
                    raise ValueError(f"Unexpected 80+ age groups in count table: {available_80_plus}")
                display_age_groups = [
                    age_id for _, age_id, _ in age_columns if age_start(age_id) < 80
                ] + ["80+"]
                populations = {
                    sex: {age_id: {} for age_id in display_age_groups}
                    for sex in SEX_CODES.values()
                }
            elif row_number >= 12 and age_columns:
                if values.get(4) != "0_国籍総数":
                    row.clear()
                    continue
                sex = SEX_CODES.get(values.get(5, ""))
                status = values.get(6, "")
                raw_region_code = values.get(3, "").split("_", 1)[0]
                if (
                    not sex
                    or not re.fullmatch(r"[0-9]{1,5}", raw_region_code)
                ):
                    row.clear()
                    continue
                region_code = raw_region_code.zfill(5)
                if status == "0_総数":
                    for column, age_id, _ in age_columns:
                        count = population_count(values.get(column))
                        if age_id in AGE_80_PLUS_IDS:
                            if count is not None:
                                key = (sex, region_code, "80+")
                                population_sums[key] = population_sums.get(key, 0) + count
                        else:
                            populations[sex][age_id][region_code] = count
                elif status in KNOWN_MARITAL_STATUSES:
                    totals_for_region = totals.setdefault((sex, region_code), [0, 0])
                    for column, age_id, _ in age_columns:
                        if age_id not in AGE_80_PLUS_IDS:
                            continue
                        count = population_count(values.get(column))
                        if count is None:
                            continue
                        totals_for_region[1] += count
                        if status == UNMARRIED_STATUS:
                            totals_for_region[0] += count
            row.clear()

    if not age_columns:
        raise ValueError("Could not find the age columns in the count table")

    result: dict[str, dict[str, float | None]] = {sex: {} for sex in SEX_CODES.values()}
    for (sex, region_code), (unmarried, known_total) in totals.items():
        result[sex][region_code] = round(unmarried / known_total * 100, 5) if known_total else None

    for (sex, region_code, age_id), count in population_sums.items():
        populations[sex][age_id][region_code] = count

    missing_national = [sex for sex in SEX_CODES.values() if "00000" not in result[sex]]
    if missing_national:
        raise ValueError(f"Missing national 80+ counts: {missing_national}")
    missing_national_populations = [
        (sex, age_id)
        for sex, age_groups in populations.items()
        for age_id, regional_populations in age_groups.items()
        if regional_populations.get("00000") is None
    ]
    if missing_national_populations:
        raise ValueError(f"Missing national population counts: {missing_national_populations[:5]}")
    return result, populations


def process(source: Path, count_source: Path, destination: Path) -> None:
    rates: dict[str, dict[str, dict[str, float | None]]] = {}

    with zipfile.ZipFile(source) as archive:
        strings = shared_strings(archive)
        sheet = archive.open("xl/worksheets/sheet1.xml")
        age_columns: list[tuple[int, str, str]] | None = None
        for _, row in ET.iterparse(sheet, events=("end",)):
            if row.tag != ROW_TAG:
                continue
            row_number = int(row.get("r", "0"))
            values = cell_values(row, strings)
            if row_number == 8:
                headers = {column: value for column, value in values.items() if column >= 7}
                age_columns = parse_age_columns(headers)
                display_age_groups = [
                    (age_id, label)
                    for _, age_id, label in age_columns
                    if age_start(age_id) < 80
                ] + [("80+", "80歳以上")]
                rates = {
                    sex: {age_id: {} for age_id, _ in display_age_groups}
                    for sex in SEX_CODES.values()
                }
            elif row_number >= 12 and age_columns:
                # Excel A-F: region id, prefecture, region code/name, nationality, sex, marital status.
                if values.get(4) != "0_国籍総数" or values.get(6) != "1_未婚":
                    row.clear()
                    continue
                sex = SEX_CODES.get(values.get(5, ""))
                raw_region_code = values.get(3, "").split("_", 1)[0]
                if not sex or not re.fullmatch(r"[0-9]{1,5}", raw_region_code):
                    row.clear()
                    continue
                region_code = raw_region_code.zfill(5)
                for column, age_id, _ in age_columns:
                    if age_start(age_id) < 80:
                        rates[sex][age_id][region_code] = number_or_none(values.get(column))
            row.clear()

    if not age_columns:
        raise ValueError("Could not find the age columns in row 8")

    age_80_plus_rates, populations = aggregate_count_data(count_source)
    for sex, regional_rates in age_80_plus_rates.items():
        rates[sex]["80+"] = regional_rates

    expected_sexes = set(SEX_CODES.values())
    if set(rates) != expected_sexes:
        raise ValueError("The workbook is missing a sex category")
    missing_national = [
        (sex, age_id)
        for sex in SEX_CODES.values()
        for age_id, _ in display_age_groups
        if "00000" not in rates[sex][age_id]
    ]
    if missing_national:
        raise ValueError(f"Missing national rates: {missing_national[:5]}")

    metadata = {
        "year": 2025,
        "table": "第4-4表（80歳以上は第4-3表の人口から合算）［不詳補完値］",
        "source": "総務省統計局・令和7年国勢調査 人口等基本集計（不詳補完値）",
        "sourceUrl": "https://www.e-stat.go.jp/dbview?sid=0004066272",
        "denominator": "配偶関係の不詳を補完した人口構成比（80歳以上は補完後の既知の配偶関係人口を分母に算出）",
        "nationality": "国籍総数（日本人・外国人を含む。日本人・外国人の別不詳を含む）",
        "ageGroups": [{"id": age_id, "label": label} for age_id, label in display_age_groups],
        "sexes": [
            {"id": "total", "label": "男女計"},
            {"id": "male", "label": "男性"},
            {"id": "female", "label": "女性"},
        ],
    }
    result = {"metadata": metadata, "rates": rates, "populations": populations}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {destination}: {len(rates['total']['30-34']):,} regions, "
        f"{len(display_age_groups)} age groups, {destination.stat().st_size:,} bytes"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/source/census2025_table_4-4_imputed.xlsx"))
    parser.add_argument("--count-source", type=Path, default=Path("data/source/census2025_table_4-3_imputed.xlsx"))
    parser.add_argument("--output", type=Path, default=Path("public/data/unmarried-rates-2025.json"))
    args = parser.parse_args()
    process(args.source, args.count_source, args.output)


if __name__ == "__main__":
    main()
