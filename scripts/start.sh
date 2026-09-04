#!/usr/bin/env bash
#
# claude-kanban launcher — runs the app in PRODUCTION mode on a single port
# (default :8787), serving the built frontend from web/dist. Used by the
# systemd user service (claude-kanban.service) and runnable by hand:
#
#     ./scripts/start.sh   (from the repo root)
#
# It builds the web bundle the first time if it is missing. After you change
# code, rebuild + restart:  npm run build && systemctl --user restart claude-kanban
#
set -uo pipefail

# Make `node`/`npm` (nvm) and `claude` (~/.local/bin) available even under the
# minimal environment of a systemd service. Source nvm so we track your default
# node and survive node upgrades; keep an explicit path + ~/.local/bin as belt
# and suspenders (claude CLI lives there — tasks spawn `claude`).
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$HOME/.local/bin:$PATH"

export NODE_ENV=production
# Optional override:  CK_PORT=9000 scripts/start.sh
export CK_PORT="${CK_PORT:-8787}"

# Project root = parent of this scripts/ dir (relocatable).
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1

# First run / after a clean: build the frontend bundle the server serves.
if [ ! -f web/dist/index.html ]; then
  echo "[claude-kanban] web/dist missing — building frontend…"
  npm run build
fi

echo "[claude-kanban] starting on http://localhost:${CK_PORT} (NODE_ENV=production)"
exec node_modules/.bin/tsx src/server/index.ts
