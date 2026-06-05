#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${NYABASE_TEST_ENV_FILE:-test/config/local.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Run: bash test/scripts/reset-local.sh" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

BASE_URL="${NYABASE_BACKEND_URL%/}/api"
FRONTEND_URL="${NYABASE_FRONTEND_URL%/}"
ADMIN_PASSWORD="${ADMIN_INIT_PASSWORD:-admin123}"
ADMIN_USER="${ADMIN_USERNAME:-admin}"
RUN_ID="${NYABASE_FUNCTIONAL_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ | tr '[:upper:]' '[:lower:]')-$(openssl rand -hex 3)}"
PREFIX="functional-${RUN_ID}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()
TOKEN=""
USER_TOKEN=""
USER_ID=""
GROUP_ID=""
IMAGE_ID=""
CPU_SERVER_ID=""
GPU_SERVER_ID=""
SERVER_GRANTED=false
IMAGE_GRANTED=false

pass() { echo -e "  ${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); }
skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; SKIP=$((SKIP + 1)); }
section() { echo -e "\n${CYAN}== $1 ==${NC}"; }

http() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local args=(-sS -w "\n%{http_code}" -X "$method" "$BASE_URL$path")
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}" 2>/dev/null || printf '\n000'
}

status_of() { echo "$1" | tail -1; }
body_of() { echo "$1" | sed '$d'; }
json_get() {
  local resp="$1"
  local expr="$2"
  body_of "$resp" | node -e "const expr = process.argv[1]; let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{try{const v=Function('data', 'return data' + expr)(JSON.parse(data)); if(v!==undefined&&v!==null) process.stdout.write(String(v));}catch{}})" "$expr"
}
json_len() {
  body_of "$1" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{try{const v=JSON.parse(data); process.stdout.write(String(Array.isArray(v)?v.length:0));}catch{process.stdout.write('0')}})"
}

assert_status() {
  local name="$1" resp="$2" expected="$3"
  local got
  got="$(status_of "$resp")"
  if [[ "$got" == "$expected" ]]; then
    pass "$name (HTTP $got)"
  else
    fail "$name (expected HTTP $expected, got HTTP $got: $(body_of "$resp" | head -c 160))"
  fi
}

cleanup() {
  if [[ -n "$TOKEN" ]]; then
    if [[ "$IMAGE_GRANTED" == true && -n "$USER_ID" && -n "$IMAGE_ID" && -n "$CPU_SERVER_ID" ]]; then
      http DELETE "/admin/users/$USER_ID/image-grants/$IMAGE_ID/$CPU_SERVER_ID" "$TOKEN" >/dev/null || true
    fi
    if [[ "$SERVER_GRANTED" == true && -n "$USER_ID" && -n "$CPU_SERVER_ID" ]]; then
      http DELETE "/admin/users/$USER_ID/server-grants/$CPU_SERVER_ID" "$TOKEN" >/dev/null || true
    fi
    [[ -n "$GROUP_ID" ]] && http DELETE "/admin/groups/$GROUP_ID" "$TOKEN" >/dev/null || true
    [[ -n "$USER_ID" ]] && http DELETE "/admin/users/$USER_ID" "$TOKEN" >/dev/null || true
    [[ -n "$IMAGE_ID" ]] && http DELETE "/admin/images/$IMAGE_ID" "$TOKEN" >/dev/null || true
  fi
}
trap cleanup EXIT

section "Shared Instance"

auth_status="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/auth/me" || true)"
if [[ "$auth_status" == "401" || "$auth_status" == "200" ]]; then
  pass "backend reachable at $BASE_URL"
else
  fail "backend not reachable at $BASE_URL (HTTP $auth_status)"
  exit 1
fi

if curl -sS "$FRONTEND_URL/" >/dev/null; then
  pass "frontend reachable at $FRONTEND_URL"
else
  fail "frontend not reachable at $FRONTEND_URL"
fi

if curl -sS "$VICTORIA_METRICS_URL/health" >/dev/null; then
  pass "VictoriaMetrics reachable at $VICTORIA_METRICS_URL"
else
  fail "VictoriaMetrics not reachable at $VICTORIA_METRICS_URL"
fi

section "Auth"

resp="$(http POST /auth/login "" "{\"username\":\"$ADMIN_USER\",\"password\":\"wrong\"}")"
assert_status "wrong admin password rejected" "$resp" "401"

resp="$(http POST /auth/login "" "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}")"
assert_status "admin login" "$resp" "200"
TOKEN="$(json_get "$resp" "['accessToken']")"
[[ -n "$TOKEN" ]] && pass "admin token returned" || fail "admin token missing"

resp="$(http GET /auth/me "$TOKEN")"
assert_status "admin /auth/me" "$resp" "200"

section "Fixed Agents"

resp="$(http GET /admin/servers "$TOKEN")"
assert_status "list servers" "$resp" "200"
CPU_SERVER_ID="$(body_of "$resp" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const rows=JSON.parse(s); const row=rows.find(r=>r.name==='nyabase-test-cpu'&&!r.isGpuServer); if(row) process.stdout.write(row.id);})" 2>/dev/null || true)"
GPU_SERVER_ID="$(body_of "$resp" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const rows=JSON.parse(s); const row=rows.find(r=>r.name==='nyabase-test-gpu'&&r.isGpuServer); if(row) process.stdout.write(row.id);})" 2>/dev/null || true)"
CPU_STATUS="$(body_of "$resp" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const rows=JSON.parse(s); const row=rows.find(r=>r.name==='nyabase-test-cpu'&&!r.isGpuServer); if(row) process.stdout.write(row.status);})" 2>/dev/null || true)"
GPU_STATUS="$(body_of "$resp" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const rows=JSON.parse(s); const row=rows.find(r=>r.name==='nyabase-test-gpu'&&r.isGpuServer); if(row) process.stdout.write(row.status);})" 2>/dev/null || true)"
[[ -n "$CPU_SERVER_ID" ]] && pass "CPU agent row exists" || fail "CPU agent row missing"
[[ -n "$GPU_SERVER_ID" ]] && pass "GPU agent row exists" || fail "GPU agent row missing"
[[ "$CPU_STATUS" == "online" ]] && pass "CPU agent online" || fail "CPU agent not online (status=$CPU_STATUS)"
[[ "$GPU_STATUS" == "online" ]] && pass "GPU agent online" || fail "GPU agent not online (status=$GPU_STATUS)"

section "Users And Groups"

username="${PREFIX}-user"
resp="$(http POST /admin/users "$TOKEN" "{\"username\":\"$username\",\"password\":\"Test@12345\",\"displayName\":\"Functional User\"}")"
assert_status "create functional user" "$resp" "201"
USER_ID="$(json_get "$resp" "['id']")"

resp="$(http POST /auth/login "" "{\"username\":\"$username\",\"password\":\"Test@12345\"}")"
assert_status "functional user login" "$resp" "200"
USER_TOKEN="$(json_get "$resp" "['accessToken']")"

resp="$(http POST /admin/groups "$TOKEN" "{\"name\":\"${PREFIX}-group\",\"priority\":5,\"capabilities\":[\"manage_images\"]}")"
assert_status "create functional group" "$resp" "201"
GROUP_ID="$(json_get "$resp" "['id']")"

resp="$(http POST "/admin/groups/$GROUP_ID/members" "$TOKEN" "{\"userId\":\"$USER_ID\"}")"
assert_status "add functional user to group" "$resp" "201"

resp="$(http GET "/admin/users/$USER_ID" "$TOKEN")"
assert_status "read functional user" "$resp" "200"

section "Images And Grants"

resp="$(http POST /admin/images "$TOKEN" "{\"name\":\"${PREFIX}-image\",\"dockerImage\":\"alpine:3.20\",\"defaultUid\":0}")"
assert_status "create functional image" "$resp" "201"
IMAGE_ID="$(json_get "$resp" "['id']")"

if [[ -n "$CPU_SERVER_ID" ]]; then
  resp="$(http POST "/admin/users/$USER_ID/server-grants/$CPU_SERVER_ID" "$TOKEN" '{"cpuMillis":500,"memBytes":268435456,"diskBytes":67108864,"gpuMode":"none","gpuIndices":[]}')"
  assert_status "grant CPU server to functional user" "$resp" "201"
  [[ "$(status_of "$resp")" == "201" ]] && SERVER_GRANTED=true

  resp="$(http POST "/admin/users/$USER_ID/image-grants" "$TOKEN" "{\"imageId\":\"$IMAGE_ID\",\"serverId\":\"$CPU_SERVER_ID\"}")"
  assert_status "grant image to functional user" "$resp" "201"
  [[ "$(status_of "$resp")" == "201" ]] && IMAGE_GRANTED=true

  resp="$(http GET /servers "$USER_TOKEN")"
  assert_status "functional user lists accessible servers" "$resp" "200"
  visible="$(json_len "$resp")"
  [[ "$visible" -ge 1 ]] && pass "functional user sees at least one server" || fail "functional user sees no servers"

  resp="$(http GET /me/access "$USER_TOKEN")"
  assert_status "functional user access summary" "$resp" "200"
else
  skip "grant checks skipped because CPU server is missing"
fi

section "Isolation"

resp="$(http GET /audit "$USER_TOKEN")"
assert_status "ordinary user cannot read audit" "$resp" "403"

resp="$(http POST /admin/users "$USER_TOKEN" "{\"username\":\"${PREFIX}-hacker\",\"password\":\"Test@12345\",\"displayName\":\"Hacker\"}")"
assert_status "ordinary user cannot create user" "$resp" "403"

section "Summary"
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo -e "  ${YELLOW}Skipped: $SKIP${NC}"
if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
  echo "Failed tests:"
  for item in "${FAILED_TESTS[@]}"; do
    echo "  - $item"
  done
fi

[[ "$FAIL" == "0" ]]
