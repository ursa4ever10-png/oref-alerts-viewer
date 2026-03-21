# Oref Alerts Viewer

Static GitHub Pages site plus a scheduled GitHub Actions workflow that refreshes alert history every 5 minutes and stores the generated data in this repository.

## Features

- **Owned archive** as the source of truth with one-time bootstrap support
- **Live alert fetching** via tzevaadom API (primary) with official Oref API fallback
- **Featured city panel** with quick stats (default: Yeruham)
- **Volley grouping** - alerts within 2-minute windows grouped as a single volley
- **URL parameters** - bookmark filters with `?city=ירוחם&from=...&to=...`
- **Category color coding** - rockets (red), aircraft (orange), earthquake (teal), other (yellow)
- **Pagination** - handles 150K+ alerts without browser crash
- **Quick city buttons** for common cities
- **Recent alert indicators** - pulsing dot on alerts from the last hour
- **Responsive design** - works on desktop and mobile
- **Heatmap visualization** - calendar-style heatmap of alert frequency over time
- **Statistics dashboard** - aggregated stats by city, category, and time period

## Repository layout

- `scripts/fetch_alerts.py`: fetch and normalize alert history
- `data/`: tracked generated data
- `docs/`: GitHub Pages site (index.html, app.js, styles.css)
- `.github/workflows/update-alerts.yml`: 5-minute refresh and Pages deployment

## URL parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `city` | `?city=ירוחם` | Filter by city name |
| `from` | `?from=2026-03-19T20:00` | Start date/time |
| `to` | `?to=2026-03-20T23:59` | End date/time |

## Local usage

```bash
python scripts/fetch_alerts.py
python scripts/fetch_alerts.py --output-status
python -m http.server 8000 --directory docs
```

Then open `http://localhost:8000`.

## Data ownership model

- `data/alarms.csv` is the owned archive for this repository
- Normal runs do not depend on a third-party CSV

## GitHub setup

1. Push this repository to GitHub.
2. In repository settings, ensure GitHub Pages is configured to use GitHub Actions.
3. The `update-alerts` workflow runs every 5 minutes and can also be triggered manually.
