# Oref Alerts Viewer

Static GitHub Pages site plus a scheduled GitHub Actions workflow that refreshes alert history every hour and stores the generated data in this repository.

## What it does

- Uses this repository's own tracked archive as the source of truth
- Supports a one-time historical bootstrap from a third-party CSV
- Fetches current alerts from the live Oref endpoint for ongoing updates
- Writes normalized data to `data/alarms.csv`, `data/alerts.json`, and `data/metadata.json`
- Publishes a static site from `docs/` that lets you filter by city and date/time
- Falls back to the repository's owned archive if the live Oref endpoint is unavailable

## Repository layout

- `scripts/fetch_alerts.py`: fetch and normalize alert history
- `data/`: tracked generated data
- `docs/`: GitHub Pages site
- `.github/workflows/update-alerts.yml`: hourly refresh and Pages deployment

## Local usage

```bash
python scripts/fetch_alerts.py
python scripts/fetch_alerts.py --bootstrap-from-third-party
python -m http.server 8000 --directory docs
```

Then open `http://localhost:8000`.

## Data ownership model

- `data/alarms.csv` is the owned archive for this repository
- `--bootstrap-from-third-party` is for one-time historical import only
- normal hourly runs do not depend on a third-party CSV

## GitHub setup

1. Push this repository to GitHub.
2. In repository settings, ensure GitHub Pages is configured to use GitHub Actions.
3. The `update-alerts` workflow will run hourly and can also be triggered manually.
