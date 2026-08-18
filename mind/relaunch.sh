#!/bin/bash
# Restart SHIVA — used by SHIVA himself after self-modification, or manually.
# Detached so the restart survives the caller (including SHIVA) dying.
ROOT="$(cd "$(dirname "$0")" && pwd)"
nohup bash -c "sleep 1; pkill -if '[p]ython -m shiva'; sleep 2; cd '$ROOT' && nohup ./.venv/bin/python -m shiva >/tmp/shiva.log 2>&1 &" >/dev/null 2>&1 &
echo "SHIVA relaunching…"
