#!/usr/bin/env python3
"""Maintain an owned alert archive for static publishing.

Default behavior:
- Load the repository's existing archive from `data/alarms.csv`
- Fetch current alerts from the live Oref endpoint
- Merge and deduplicate
- Write the updated archive back into this repository

Bootstrap behavior:
- `--bootstrap-from-third-party` imports the historical GitHub CSV once
- This is intended for one-time backfill, not recurring updates
"""

from __future__ import annotations

import csv
import io
import json
import sys
import argparse
import http.cookiejar
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

CSV_URL = "https://raw.githubusercontent.com/yuval-harpaz/alarms/master/data/alarms.csv"
OREF_URL = "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=2"
OREF_PAGE_URL = "https://alerts-history.oref.org.il/12481-he/Pakar.aspx"
OREF_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "he,en-US;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Origin": "https://alerts-history.oref.org.il",
    "Referer": "https://alerts-history.oref.org.il/12481-he/Pakar.aspx",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
}
CSV_HEADERS = {"User-Agent": "Mozilla/5.0"}
CSV_FIELDS = ["time", "city", "description", "origin", "source"]


def fetch_csv_alerts() -> list[dict[str, str]]:
    request = urllib.request.Request(CSV_URL, headers=CSV_HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        text = response.read().decode("utf-8", errors="ignore")

    reader = csv.DictReader(io.StringIO(text))
    results: list[dict[str, str]] = []
    for row in reader:
        results.append(
            {
                "time": row.get("time", ""),
                "city": row.get("cities", ""),
                "description": row.get("description", ""),
                "origin": row.get("origin", ""),
                "source": "github_csv",
            }
        )
    return results


def build_oref_opener() -> urllib.request.OpenerDirector:
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    bootstrap = urllib.request.Request(
        OREF_PAGE_URL,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "he,en-US;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "User-Agent": OREF_HEADERS["User-Agent"],
        },
    )
    with opener.open(bootstrap, timeout=60):
        pass
    return opener


def load_owned_archive(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []

    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        results: list[dict[str, str]] = []
        for row in reader:
            results.append(
                {
                    "time": row.get("time", ""),
                    "city": row.get("city", ""),
                    "description": row.get("description", ""),
                    "origin": row.get("origin", ""),
                    "source": row.get("source", "owned_archive"),
                }
            )
    return results


def _fetch_oref_simple() -> list:
    """Try fetching Oref API with minimal headers (no cookie bootstrap)."""
    simple_headers = {
        "Referer": "https://alerts-history.oref.org.il/12481-he/Pakar.aspx",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
    }
    request = urllib.request.Request(OREF_URL, headers=simple_headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8", errors="ignore"))


def fetch_oref_alerts() -> list[dict[str, str]]:
    last_error: Exception | None = None
    # Strategy 1: cookie-based opener
    for attempt in range(2):
        try:
            opener = build_oref_opener()
            request = urllib.request.Request(OREF_URL, headers=OREF_HEADERS)
            with opener.open(request, timeout=60) as response:
                payload = json.loads(response.read().decode("utf-8", errors="ignore"))
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
            last_error = exc
            time.sleep(2 + attempt)
    else:
        # Strategy 2: simple headers fallback
        try:
            payload = _fetch_oref_simple()
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
            last_error = exc
            raise

    results: list[dict[str, str]] = []
    for alert in payload:
        category = alert.get("category_desc", "")
        if not category:
            continue
        if "האירוע הסתיים" in category:
            continue
        alert_date = (alert.get("alertDate", "") or "").replace("T", " ")
        results.append(
            {
                "time": alert_date,
                "city": alert.get("data", ""),
                "description": category,
                "origin": "",
                "source": "oref_api",
            }
        )
    return results


def merge_alerts(existing_alerts: list[dict[str, str]], new_alerts: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()
    merged: list[dict[str, str]] = []

    for alert in existing_alerts + new_alerts:
        key = (alert.get("time", "")[:16], alert.get("city", ""), alert.get("description", ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(alert)

    merged.sort(key=lambda item: item.get("time", ""))
    return merged


def normalize_city_names(alerts: list[dict[str, str]]) -> list[str]:
    names = {alert.get("city", "").strip() for alert in alerts if alert.get("city", "").strip()}
    return sorted(names)


def write_csv(path: Path, alerts: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(alerts)


def write_json(path: Path, payload: object) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh the owned Oref alerts archive")
    parser.add_argument(
        "--bootstrap-from-third-party",
        action="store_true",
        help="Import historical alerts from the third-party GitHub CSV before merging live Oref data",
    )
    parser.add_argument(
        "--output-status",
        action="store_true",
        help="Write data/.fetch_status with CHANGED=true/false for CI integration",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    archive_path = data_dir / "alarms.csv"

    owned_archive = load_owned_archive(archive_path)
    bootstrap_imported = 0
    bootstrap_mode = "skipped"
    bootstrap_error = None

    if args.bootstrap_from_third_party:
        try:
            third_party_alerts = fetch_csv_alerts()
            owned_archive = merge_alerts(owned_archive, third_party_alerts)
            bootstrap_imported = len(third_party_alerts)
            bootstrap_mode = "imported"
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
            bootstrap_mode = "failed"
            bootstrap_error = str(exc)

    oref_error = None
    try:
        oref_alerts = fetch_oref_alerts()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
        oref_alerts = []
        oref_error = str(exc)

    alerts = merge_alerts(owned_archive, oref_alerts)
    cities = normalize_city_names(alerts)
    generated_at = datetime.now(timezone.utc).isoformat()

    metadata = OrderedDict(
        [
            ("generated_at", generated_at),
            ("total_alerts", len(alerts)),
            ("total_cities", len(cities)),
            ("archive_alerts_before_refresh", len(owned_archive)),
            ("bootstrap_mode", bootstrap_mode),
            ("bootstrap_imported", bootstrap_imported),
            ("bootstrap_error", bootstrap_error),
            ("oref_alerts", len(oref_alerts)),
            ("oref_status", "ok" if oref_error is None else "owned_archive_only"),
            ("oref_error", oref_error),
            ("archive_owner", "this_repository"),
        ]
    )

    write_csv(data_dir / "alarms.csv", alerts)
    write_json(
        data_dir / "alerts.json",
        {
            "metadata": metadata,
            "cities": cities,
            "alerts": alerts,
        },
    )
    write_json(data_dir / "metadata.json", metadata)

    changed = len(alerts) != len(owned_archive) or len(oref_alerts) > 0
    if args.output_status:
        status_path = data_dir / ".fetch_status"
        status_path.write_text(f"CHANGED={'true' if changed else 'false'}\n")

    print(json.dumps(metadata, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
