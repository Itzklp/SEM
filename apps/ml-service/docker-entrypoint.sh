#!/bin/sh
set -e

# First run only: the mounted ml/models volume has no registry.json yet,
# so there's no active model for main.py to load. Train once, deterministically
# (train.py's own defaults: 100,000 rows, seed 20261031) — every later
# container start finds the registry already there and skips straight to serving.
if [ ! -f ml/models/registry.json ]; then
  echo "[ml-service] no trained model found on the mounted volume — training one now (first run only)"
  python apps/ml-service/app/train.py
fi

exec python -m uvicorn app.main:app --app-dir apps/ml-service --host 0.0.0.0 --port 8000
