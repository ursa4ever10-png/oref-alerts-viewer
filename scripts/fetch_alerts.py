#!/usr/bin/env python3
"""Maintain an owned alert archive for static publishing.

Default behavior (every run):
1. Load the repository's existing archive from `data/alarms.csv`
2. Sync new alerts from yuval-harpaz/alarms public CSV (always accessible)
3. Try to fetch current alerts directly from the live Oref endpoint
4. Merge and deduplicate all sources
5. Write the updated archive back into this repository

The archive in this repo is the source of truth. yuval's CSV is used
as a reliable sync source since the Oref API blocks cloud/datacenter IPs.
If yuval's repo ever goes away, we keep everything already collected.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
import argparse
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

CSV_URL = "https://raw.githubusercontent.com/yuval-harpaz/alarms/master/data/alarms.csv"

# Oref endpoints - tried in order. The env var OREF_HIST_URL (set via GitHub
# secret) is tried first so a proxy can be used from cloud runners where the
# direct endpoints return 403.
OREF_ENDPOINTS = [
    {
        "url": "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json",
        "headers": {"Referer": "https://www.oref.org.il/", "User-Agent": "Mozilla/5.0"},
        "format": "www",  # {alertDate, title, data, category}
    },
    {
        "url": "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1",
        "headers": {
            "Referer": "https://www.oref.org.il/",
            "X-Requested-With": "XMLHttpRequest",
            "User-Agent": "Mozilla/5.0",
        },
        "format": "history",  # {alertDate, category_desc, data, ...}
    },
]

CSV_HEADERS = {"User-Agent": "Mozilla/5.0"}
CSV_FIELDS = ["time", "city", "description", "origin", "source"]

# Map category numbers from www endpoint to descriptions
CATEGORY_MAP = {
    1: "\u05D9\u05E8\u05D9 \u05E8\u05E7\u05D8\u05D5\u05EA \u05D5\u05D8\u05D9\u05DC\u05D9\u05DD",
    2: "\u05D7\u05D3\u05D9\u05E8\u05EA \u05DB\u05DC\u05D9 \u05D8\u05D9\u05E1 \u05E2\u05D5\u05D9\u05DF",
    3: "\u05E8\u05E2\u05D9\u05D3\u05EA \u05D0\u05D3\u05DE\u05D4",
    4: "\u05D7\u05D5\u05DE\u05E8\u05D9\u05DD \u05DE\u05E1\u05D5\u05DB\u05E0\u05D9\u05DD",
    6: "\u05D0\u05D9\u05E8\u05D5\u05E2 \u05D7\u05D5\u05DE\u05E8\u05D9\u05DD \u05DE\u05E1\u05D5\u05DB\u05E0\u05D9\u05DD",
    7: "\u05D7\u05D3\u05D9\u05E8\u05EA \u05DE\u05E1\u05D5\u05E7\u05D9\u05DD",
    13: "\u05D4\u05D0\u05D9\u05E8\u05D5\u05E2 \u05D4\u05E1\u05EA\u05D9\u05D9\u05DD",
}


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


def _parse_oref_payload(payload: list, fmt: str) -> list[dict[str, str]]:
    """Parse Oref JSON into normalized alert dicts."""
    results: list[dict[str, str]] = []
    for alert in payload:
        if fmt == "www":
            title = alert.get("title", "")
            cat_num = alert.get("category")
            category = title or CATEGORY_MAP.get(cat_num, str(cat_num or ""))
        else:
            category = alert.get("category_desc", "")

        if not category:
            continue
        if "\u05D4\u05D0\u05D9\u05E8\u05D5\u05E2 \u05D4\u05E1\u05EA\u05D9\u05D9\u05DD" in category:
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


def fetch_oref_alerts() -> list[dict[str, str]]:
    """Try each Oref endpoint in order; return alerts from the first that works."""
    last_error: Exception | None = None

    # Allow override via env var (GitHub secret) - same pattern as yuval-harpaz
    env_url = os.environ.get("OREF_HIST_URL", "").strip()
    endpoints = list(OREF_ENDPOINTS)
    if env_url:
        endpoints.insert(0, {
            "url": env_url,
            "headers": {"User-Agent": "python-requests/2.28.1"},
            "format": "history",
        })

    for endpoint in endpoints:
        url = endpoint["url"]
        headers = endpoint["headers"]
        fmt = endpoint["format"]

        for attempt in range(2):
            try:
                request = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(request, timeout=60) as response:
                    raw = response.read().decode("utf-8", errors="ignore").strip()
                    # Handle BOM
                    if raw.startswith("\ufeff"):
                        raw = raw[1:]
                    if not raw or not raw.startswith("["):
                        raise ValueError(f"Unexpected response from {url}: {raw[:80]}")
                    payload = json.loads(raw)

                results = _parse_oref_payload(payload, fmt)
                print(f"Oref OK via {url} -> {len(results)} alerts", file=sys.stderr)
                return results
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
                last_error = exc
                if attempt < 1:
                    time.sleep(2)

        print(f"Oref FAILED via {url}: {last_error}", file=sys.stderr)

    raise last_error or RuntimeError("All Oref endpoints failed")


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
    archive_count_before = len(owned_archive)

    # Always sync from yuval's public CSV to pick up new alerts
    csv_sync_count = 0
    csv_sync_error = None
    try:
        csv_alerts = fetch_csv_alerts()
        csv_sync_count = len(csv_alerts)
        owned_archive = merge_alerts(owned_archive, csv_alerts)
        print(f"CSV sync: {csv_sync_count} rows fetched, archive now {len(owned_archive)}", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
        csv_sync_error = str(exc)
        print(f"CSV sync failed (non-fatal): {exc}", file=sys.stderr)

    # Also try Oref directly (works locally, usually 403 from cloud)
    oref_error = None
    oref_alerts: list[dict[str, str]] = []
    try:
        oref_alerts = fetch_oref_alerts()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
        oref_error = str(exc)

    alerts = merge_alerts(owned_archive, oref_alerts)
    cities = normalize_city_names(alerts)
    generated_at = datetime.now(timezone.utc).isoformat()

    metadata = OrderedDict(
        [
            ("generated_at", generated_at),
            ("total_alerts", len(alerts)),
            ("total_cities", len(cities)),
            ("archive_before_refresh", archive_count_before),
            ("new_alerts_added", len(alerts) - archive_count_before),
            ("csv_sync_rows", csv_sync_count),
            ("csv_sync_error", csv_sync_error),
            ("oref_alerts", len(oref_alerts)),
            ("oref_status", "ok" if oref_error is None else "csv_sync_only"),
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

    changed = len(alerts) != archive_count_before
    if args.output_status:
        status_path = data_dir / ".fetch_status"
        status_path.write_text(f"CHANGED={'true' if changed else 'false'}\n")

    print(json.dumps(metadata, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
