#!/bin/zsh

set -euo pipefail

ROOT_DIR=${0:A:h:h}
DSPY_PYTHON="$ROOT_DIR/dspy_service/.venv/bin/python"
DSPY_HOST=${DSPY_HOST:-0.0.0.0}
DSPY_PORT=${DSPY_PORT:-8001}
BUN_BIN=${BUN_BIN:-$(command -v bun || true)}

if [[ -z "$BUN_BIN" && -x "$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi

if [[ ! -x "$DSPY_PYTHON" ]]; then
  echo "No existe el entorno virtual en dspy_service/.venv." >&2
  echo "Ejecuta: python3 -m venv dspy_service/.venv && dspy_service/.venv/bin/pip install -r dspy_service/requirements.txt" >&2
  exit 1
fi

if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "No se encontro bun en el PATH ni en ~/.bun/bin/bun." >&2
  exit 1
fi

cleanup() {
  trap - INT TERM EXIT
  [[ -n "${DSPY_PID:-}" ]] && kill "$DSPY_PID" 2>/dev/null || true
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

cd "$ROOT_DIR"

"$DSPY_PYTHON" -m uvicorn app:app --app-dir "$ROOT_DIR/dspy_service" --host "$DSPY_HOST" --port "$DSPY_PORT" &
DSPY_PID=$!

"$BUN_BIN" --watch "$ROOT_DIR/src/index.ts" &
APP_PID=$!

while kill -0 "$DSPY_PID" 2>/dev/null && kill -0 "$APP_PID" 2>/dev/null; do
  sleep 1
done

DSPY_STATUS=0
APP_STATUS=0

wait "$DSPY_PID" || DSPY_STATUS=$?
wait "$APP_PID" || APP_STATUS=$?

if [[ "$DSPY_STATUS" -ne 0 ]]; then
  exit "$DSPY_STATUS"
fi

exit "$APP_STATUS"
