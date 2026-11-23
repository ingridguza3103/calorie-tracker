#!/bin/sh
set -eu

cd "$(dirname "$0")"
python -m alembic upgrade head
exec python -m uvicorn app.web:create_app --factory \
  --host 0.0.0.0 --port "${PORT:-10000}" --workers 1
