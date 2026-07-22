#!/usr/bin/env bash
#
# End-to-end integration proof for the MCP + copy-files change.
#
# Spins up an ISOLATED claude-kanban server (its own port / DB / worktree base /
# agent command) so it never touches the user's running instance, then drives the
# real HTTP API to prove:
#   (a) <sessionRoot>/.mcp.json is a SYMLINK resolving to the chosen .mcp.json
#   (b) <worktreePath>/.env EXISTS as a REAL COPY (not a symlink) with identical
#       contents to the source repo's gitignored .env
# Finally it deletes the task + project and removes all temp dirs.
#
# Exits 0 only when every assertion passes.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
PORT=8989
BASE="$(mktemp -d "${HOME}/ck-itest.XXXXXX")"
SRC_REPO="${BASE}/source-repo"
DATA_DIR="${BASE}/ck-data"
WT_BASE="${BASE}/ck-sessions"
AGENT_CMD="${BASE}/fake-agent.sh"
SERVER_LOG="${BASE}/server.log"
API="http://localhost:${PORT}/api"

SERVER_PID=""
PROJECT_ID=""
TASK_ID=""
FAILED=0

log()  { printf '\n=== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; FAILED=1; }
ok()   { printf 'OK:   %s\n' "$*"; }

cleanup() {
  # Best-effort delete of the created task + project via the API (exercises the
  # teardown path: removeConfigLinks unlinks the .mcp.json symlink, etc.).
  if [[ -n "${TASK_ID}" ]]; then
    curl -s -o /dev/null -X DELETE "${API}/tasks/${TASK_ID}" || true
  fi
  if [[ -n "${PROJECT_ID}" ]]; then
    curl -s -o /dev/null -X DELETE "${API}/projects/${PROJECT_ID}" || true
  fi
  # The server runs in its OWN process group (setsid), so a negative-pid kill
  # takes down the tsx parent AND the node child AND any spawned fake-agent ptys —
  # no orphan can survive to hold the port or leak a temp dir.
  if [[ -n "${SERVER_PID}" ]]; then
    kill -TERM "-${SERVER_PID}" 2>/dev/null || kill -TERM "${SERVER_PID}" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "${SERVER_PID}" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "-${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  # Belt-and-braces: kill any fake-agent (sleep) ptys still alive, then nuke temp.
  pkill -f "${AGENT_CMD}" 2>/dev/null || true
  rm -rf "${BASE}" 2>/dev/null || true
}
trap cleanup EXIT

# ── JSON field extractor via node (robust: returns the TOP-LEVEL key only) ─────
# Reads JSON on stdin, prints the value at the given top-level key ("" if absent).
json_field() { # $1=key
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const o = JSON.parse(s);
        const v = o && typeof o === "object" ? o[process.argv[1]] : undefined;
        process.stdout.write(v == null ? "" : String(v));
      } catch {
        process.stdout.write("");
      }
    });
  ' "$1"
}

# ── 1. Build the source git repo: committed file + gitignored .env + .mcp.json ─
log "Building source repo at ${SRC_REPO}"
mkdir -p "${SRC_REPO}"
git -C "${SRC_REPO}" init -q -b main
git -C "${SRC_REPO}" config user.email itest@example.com
git -C "${SRC_REPO}" config user.name "itest"
printf 'committed content\n' > "${SRC_REPO}/README.md"
printf '.env\n' > "${SRC_REPO}/.gitignore"
git -C "${SRC_REPO}" add README.md .gitignore
git -C "${SRC_REPO}" commit -q -m "initial commit"
# Untracked, gitignored secret to be COPIED into the worktree.
ENV_CONTENT="SECRET=super-secret-$(date +%s)-$$"
printf '%s\n' "${ENV_CONTENT}" > "${SRC_REPO}/.env"
# The per-project .mcp.json file to be SYMLINKED into the session root.
printf '{"mcpServers":{"demo":{"command":"echo"}}}\n' > "${SRC_REPO}/.mcp.json"
MCP_SRC="${SRC_REPO}/.mcp.json"

# Sanity: .env must be untracked + ignored (proves it is a real untracked file).
if git -C "${SRC_REPO}" check-ignore -q .env; then
  ok ".env is gitignored/untracked in the source repo"
else
  fail ".env is NOT gitignored in the source repo"
fi

# ── 2. Fake agent so the pty spawn succeeds WITHOUT a real interactive claude ──
# It ignores its args (the server appends --settings <hooksFile>) and just sleeps.
cat > "${AGENT_CMD}" <<'EOS'
#!/usr/bin/env bash
exec sleep 600
EOS
chmod +x "${AGENT_CMD}"

# ── 3. Start an isolated server ───────────────────────────────────────────────
log "Starting isolated server on :${PORT}"
# Fail fast if the chosen port is already taken — a stale listener would make the
# proof silently test the WRONG instance.
if curl -s -o /dev/null --max-time 2 "${API}/health" 2>/dev/null; then
  fail "port ${PORT} already serving an API — refusing to run against a stale instance"
  exit 1
fi
mkdir -p "${DATA_DIR}" "${WT_BASE}"
# setsid → the server gets its own process group so cleanup can kill the whole
# tree (tsx + node child + fake-agent ptys) with a single negative-pid signal.
setsid bash -c "
  cd '${REPO_ROOT}' || exit 1
  CK_PORT='${PORT}' \
  CK_DATA_DIR='${DATA_DIR}' \
  CK_DB_PATH='${DATA_DIR}/ck.db' \
  CK_WORKTREE_BASE='${WT_BASE}' \
  CK_AGENT_COMMAND='${AGENT_CMD}' \
  CK_AGENT_ARGS='' \
  CK_BROWSE_ROOTS='${HOME}' \
  exec npx tsx src/server/index.ts
" > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

# Wait for /api/health to answer 200 (up to ~30s).
HEALTH_CODE=000
for _ in $(seq 1 60); do
  HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${API}/health" 2>/dev/null || echo 000)"
  [[ "${HEALTH_CODE}" == "200" ]] && break
  kill -0 "${SERVER_PID}" 2>/dev/null || { fail "server process died during boot"; cat "${SERVER_LOG}"; exit 1; }
  sleep 0.5
done
if [[ "${HEALTH_CODE}" == "200" ]]; then
  ok "GET /api/health = 200"
else
  fail "GET /api/health = ${HEALTH_CODE} (expected 200)"
  cat "${SERVER_LOG}"
  exit 1
fi

# ── 4. Create the project (mcpConfigPath + copyFiles=[".env"]) ─────────────────
log "Creating project via POST /api/projects"
PROJECT_JSON="$(curl -s -X POST "${API}/projects" \
  -H 'Content-Type: application/json' \
  -d "{
        \"name\": \"itest-proj\",
        \"repos\": [{\"name\": \"src\", \"repoPath\": \"${SRC_REPO}\", \"baseBranch\": \"main\"}],
        \"mcpConfigPath\": \"${MCP_SRC}\",
        \"copyFiles\": [\".env\"]
      }")"
PROJECT_ID="$(printf '%s' "${PROJECT_JSON}" | json_field id)"
if [[ -n "${PROJECT_ID}" ]]; then
  ok "project created id=${PROJECT_ID}"
else
  fail "could not create project; response: ${PROJECT_JSON}"
  exit 1
fi
# Confirm the server stored + echoes back mcpConfigPath and copyFiles.
RET_MCP="$(printf '%s' "${PROJECT_JSON}" | json_field mcpConfigPath)"
if [[ "${RET_MCP}" == "${MCP_SRC}" ]]; then
  ok "project mcpConfigPath round-tripped: ${RET_MCP}"
else
  fail "project mcpConfigPath mismatch: got '${RET_MCP}' want '${MCP_SRC}'"
fi
if printf '%s' "${PROJECT_JSON}" | grep -q '\.env'; then
  ok "project copyFiles contains .env"
else
  fail "project copyFiles does not contain .env; response: ${PROJECT_JSON}"
fi

# ── 5. Create a task ──────────────────────────────────────────────────────────
log "Creating task via POST /api/tasks"
TASK_JSON="$(curl -s -X POST "${API}/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\": \"${PROJECT_ID}\", \"title\": \"itest task\"}")"
TASK_ID="$(printf '%s' "${TASK_JSON}" | json_field id)"
SESSION_ROOT="$(printf '%s' "${TASK_JSON}" | json_field sessionRoot)"
# worktreePath is nested under repos[0]; pull it with a dedicated node reader.
WORKTREE_PATH="$(printf '%s' "${TASK_JSON}" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
    try { const t=JSON.parse(s); const r=(t.repos||[])[0]; process.stdout.write(r&&r.worktreePath?String(r.worktreePath):""); }
    catch { process.stdout.write(""); }
  });')"
if [[ -n "${TASK_ID}" && -n "${SESSION_ROOT}" && -n "${WORKTREE_PATH}" ]]; then
  ok "task created id=${TASK_ID}"
  ok "  sessionRoot=${SESSION_ROOT}"
  ok "  worktreePath=${WORKTREE_PATH}"
else
  fail "could not create task; response: ${TASK_JSON}"
  exit 1
fi

# ── 6a. ASSERT: <sessionRoot>/.mcp.json is a SYMLINK resolving to the source ───
log "Assertion (a): .mcp.json symlink"
MCP_LINK="${SESSION_ROOT}/.mcp.json"
if [[ -L "${MCP_LINK}" ]]; then
  ok ".mcp.json at session root IS a symlink"
  RESOLVED="$(readlink -f "${MCP_LINK}")"
  MCP_SRC_REAL="$(readlink -f "${MCP_SRC}")"
  if [[ "${RESOLVED}" == "${MCP_SRC_REAL}" ]]; then
    ok ".mcp.json symlink resolves to the chosen file (${RESOLVED})"
  else
    fail ".mcp.json symlink resolves to '${RESOLVED}', expected '${MCP_SRC_REAL}'"
  fi
else
  fail ".mcp.json at session root is NOT a symlink (or missing)"
  ls -la "${SESSION_ROOT}" || true
fi

# ── 6b. ASSERT: <worktreePath>/.env EXISTS as a REAL COPY (not symlink) ────────
log "Assertion (b): .env real copy in worktree"
ENV_COPY="${WORKTREE_PATH}/.env"
if [[ -e "${ENV_COPY}" ]]; then
  ok ".env EXISTS in the worktree"
  if [[ -L "${ENV_COPY}" ]]; then
    fail ".env in the worktree is a SYMLINK (must be a real copy)"
  else
    ok ".env in the worktree is a real file (not a symlink)"
  fi
  if [[ -f "${ENV_COPY}" ]] && diff -q "${SRC_REPO}/.env" "${ENV_COPY}" >/dev/null 2>&1; then
    ok ".env copy contents match the source"
  else
    fail ".env copy contents DIFFER from the source"
    echo "  source: $(cat "${SRC_REPO}/.env" 2>/dev/null)"
    echo "  copy:   $(cat "${ENV_COPY}" 2>/dev/null)"
  fi
else
  fail ".env does NOT exist in the worktree"
  ls -la "${WORKTREE_PATH}" || true
fi

# ── 7. Tear down task + project via the API, assert the symlink is gone ────────
log "Deleting task + project via the API"
DEL_TASK_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${API}/tasks/${TASK_ID}")"
if [[ "${DEL_TASK_CODE}" == "204" || "${DEL_TASK_CODE}" == "200" ]]; then
  ok "task deleted (HTTP ${DEL_TASK_CODE})"
  TASK_ID=""  # already deleted; skip in cleanup
else
  fail "task delete returned HTTP ${DEL_TASK_CODE}"
fi
# After teardown the symlink (the LINK only) must be gone, and the source .mcp.json
# it pointed at must still exist (unlink must never delete the target).
if [[ -e "${MCP_LINK}" || -L "${MCP_LINK}" ]]; then
  fail ".mcp.json symlink still present after task teardown"
else
  ok ".mcp.json symlink removed by teardown"
fi
if [[ -f "${MCP_SRC}" ]]; then
  ok "source .mcp.json target preserved (teardown unlinked the LINK only)"
else
  fail "source .mcp.json target was deleted by teardown (must never happen)"
fi

DEL_PROJ_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${API}/projects/${PROJECT_ID}")"
if [[ "${DEL_PROJ_CODE}" == "204" || "${DEL_PROJ_CODE}" == "200" ]]; then
  ok "project deleted (HTTP ${DEL_PROJ_CODE})"
  PROJECT_ID=""
else
  fail "project delete returned HTTP ${DEL_PROJ_CODE}"
fi

log "RESULT"
if [[ "${FAILED}" -eq 0 ]]; then
  echo "INTEGRATION PROOF: PASS"
  exit 0
else
  echo "INTEGRATION PROOF: FAIL"
  exit 1
fi
