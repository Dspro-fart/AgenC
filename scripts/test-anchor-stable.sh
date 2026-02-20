#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"

RETRY_COUNT="${ANCHOR_RETRY_COUNT:-3}"
RETRY_DELAY_SEC="${ANCHOR_RETRY_DELAY_SEC:-2}"

if ! command -v solana >/dev/null 2>&1; then
  echo "ERROR: solana CLI not found in PATH." >&2
  exit 1
fi

if ! command -v anchor >/dev/null 2>&1; then
  echo "ERROR: anchor CLI not found in PATH." >&2
  exit 1
fi

if [ ! -f "${ANCHOR_WALLET}" ]; then
  echo "ERROR: Anchor wallet not found at ${ANCHOR_WALLET}" >&2
  exit 1
fi

if ! solana block-height --url "${ANCHOR_PROVIDER_URL}" >/dev/null 2>&1; then
  echo "ERROR: Cannot reach validator at ${ANCHOR_PROVIDER_URL}" >&2
  echo "Start validator first, then rerun." >&2
  echo "Example: solana-test-validator --rpc-port 8899 --faucet-port 9901 --gossip-port 8902 --dynamic-port-range 8903-8930 --reset" >&2
  exit 1
fi

run_with_retry() {
  local label="$1"
  local command="$2"

  local attempt=1
  local out_file
  out_file="$(mktemp)"

  while true; do
    echo "=== [${label}] attempt ${attempt}/${RETRY_COUNT} ==="

    set +e
    bash -lc "${command}" 2>&1 | tee "${out_file}"
    local status=${PIPESTATUS[0]}
    set -e

    if [ "${status}" -eq 0 ]; then
      rm -f "${out_file}"
      return 0
    fi

    if [ "${attempt}" -ge "${RETRY_COUNT}" ]; then
      echo "FAILED: ${label}" >&2
      rm -f "${out_file}"
      return "${status}"
    fi

    if grep -Eq "TypeError: fetch failed|connect EPERM|ECONNREFUSED|ECONNRESET|socket hang up|failed to get balance" "${out_file}"; then
      local sleep_sec=$((RETRY_DELAY_SEC * attempt))
      echo "Transient RPC failure detected for ${label}; retrying in ${sleep_sec}s..."
      sleep "${sleep_sec}"
      attempt=$((attempt + 1))
      continue
    fi

    echo "Non-transient failure in ${label}; not retrying." >&2
    rm -f "${out_file}"
    return "${status}"
  done
}

FILES=(
  "tests/audit-high-severity.ts"
  "tests/coordination-security.ts"
  "tests/integration.ts"
  "tests/minimal-debug.ts"
  "tests/rate-limiting.ts"
  "tests/security-audit-fixes.ts"
  "tests/smoke.ts"
  "tests/sybil-attack.ts"
  "tests/test_cu_benchmarks.ts"
  "tests/complete_task_private.ts"
  "tests/zk-proof-lifecycle.ts"
  "tests/litesvm-poc.ts"
  "tests/minimal.ts"
  "tests/reputation-economy.ts"
  "tests/upgrades.ts"
)

echo "Anchor provider: ${ANCHOR_PROVIDER_URL}"
echo "Anchor wallet: ${ANCHOR_WALLET}"
echo "Retry policy: ${RETRY_COUNT} attempts, base delay ${RETRY_DELAY_SEC}s"

if [ "${ANCHOR_SKIP_DEPLOY:-0}" != "1" ]; then
  run_with_retry "anchor build" "anchor build"
  run_with_retry \
    "anchor deploy agenc_coordination" \
    "ANCHOR_PROVIDER_URL='${ANCHOR_PROVIDER_URL}' ANCHOR_WALLET='${ANCHOR_WALLET}' anchor deploy --provider.cluster '${ANCHOR_PROVIDER_URL}' --provider.wallet '${ANCHOR_WALLET}' --program-name agenc_coordination"
fi

for file in "${FILES[@]}"; do
  run_with_retry "${file}" "ANCHOR_PROVIDER_URL='${ANCHOR_PROVIDER_URL}' ANCHOR_WALLET='${ANCHOR_WALLET}' npx ts-mocha -p ./tsconfig.json -t 1000000 '${file}'"
done

echo "All validator-backed Anchor test files passed."
