#!/bin/zsh
# Local API on :8080, with the secrets from the gitignored .env (Qloo, Tavily, the GCP project).
cd "$(dirname "$0")/../api"
set -a; source ../.env; set +a
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080 --reload --reload-dir app
