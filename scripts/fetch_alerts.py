#!/usr/bin/env python3
"""Fetch and normalize Oref alert history for static publishing."""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

CSV_URL = "https://raw.githubusercontent.com/yuval-harpaz/alarms/master/data/alarms.csv"
OREF_URL = "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=2"
OREF_HEADERS = {
    "Referer": "https://alerts-history.oref.org.il/12481-he/Pakar.aspx",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0",
}
CSV_HEADERS = {"User-Agent": "Mozilla/5.0"}


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


def fetch_oref_alerts() -> list[dict[str, str]]:
    request = urllib.request.Request(OREF_URL, headers=OREF_HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read().decode("utf-8", errors="ignore"))

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


def merge_alerts(csv_alerts: list[dict[str, str]], oref_alerts: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()
    merged: list[dict[str, str]] = []

    for alert in csv_alerts + oref_alerts:
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
        writer = csv.DictWriter(handle, fieldnames=["time", "city", "description", "origin", "source"])
        writer.writeheader()
        writer.writerows(alerts)


def write_json(path: Path, payload: object) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    csv_alerts = fetch_csv_alerts()
    oref_error = None
    try:
        oref_alerts = fetch_oref_alerts()
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError) as exc:
        oref_alerts = []
        oref_error = str(exc)

    alerts = merge_alerts(csv_alerts, oref_alerts)
    cities = normalize_city_names(alerts)
    generated_at = datetime.now(timezone.utc).isoformat()

    metadata = OrderedDict(
        [
            ("generated_at", generated_at),
            ("total_alerts", len(alerts)),
            ("total_cities", len(cities)),
            ("csv_alerts", len(csv_alerts)),
            ("oref_alerts", len(oref_alerts)),
            ("oref_status", "ok" if oref_error is None else "fallback_csv_only"),
            ("oref_error", oref_error),
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

    print(json.dumps(metadata, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
