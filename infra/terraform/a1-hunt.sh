#!/usr/bin/env bash
#
# a1-hunt.sh — keep retrying the VM.Standard.A1.Flex launch until OCI has free
# ARM capacity, then let Terraform swap it in for the running E2.1.Micro.
#
# How it works:
#   * Your stack currently runs the always-available x86 micro (see tfvars).
#   * This loop runs `terraform apply` with -var overrides that flip the shape
#     to VM.Standard.A1.Flex, rotating across the three us-chicago-1 ADs.
#   * compute.tf uses create_before_destroy, so a failed A1 launch leaves the
#     micro untouched. When A1 finally launches, Terraform creates it, repoints
#     the load balancer, and only then destroys the micro -> zero downtime.
#
# Usage:
#   cd infra/terraform
#   export OCI_CLI_PROFILE=DEFAULT
#   ./a1-hunt.sh                       # run in foreground
#   nohup ./a1-hunt.sh > a1-hunt.log 2>&1 &   # run detached, survives logout
#
# Tunables (env vars):
#   RETRY_INTERVAL   seconds between attempts (default 60)
#   A1_OCPUS         A1 OCPUs (default 1, free-tier max 4 total)
#   A1_MEMORY_GBS    A1 memory GB (default 6, free-tier max 24 total)
#   ADS              space-separated AD names to rotate (default all 3 Chicago)

set -u

RETRY_INTERVAL="${RETRY_INTERVAL:-60}"
A1_OCPUS="${A1_OCPUS:-1}"
A1_MEMORY_GBS="${A1_MEMORY_GBS:-6}"
ADS="${ADS:-EYNM:US-CHICAGO-1-AD-1 EYNM:US-CHICAGO-1-AD-2 EYNM:US-CHICAGO-1-AD-3}"

# Error fragments that mean "no capacity right now, just keep trying".
RETRYABLE='Out of host capacity|OutOfHostCapacity|500-InternalError|429|TooManyRequests|InternalError'

read -r -a AD_ARR <<<"$ADS"
attempt=0

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "[$(ts)] Starting A1 hunt. shape=VM.Standard.A1.Flex ocpus=${A1_OCPUS} mem=${A1_MEMORY_GBS}GB interval=${RETRY_INTERVAL}s"
echo "[$(ts)] Rotating ADs: ${AD_ARR[*]}"

while true; do
  ad="${AD_ARR[$(( attempt % ${#AD_ARR[@]} ))]}"
  attempt=$(( attempt + 1 ))
  echo "[$(ts)] Attempt #${attempt} in AD: ${ad}"

  out="$(terraform apply -auto-approve -input=false -lock-timeout=120s \
      -var "instance_shape=VM.Standard.A1.Flex" \
      -var "instance_ocpus=${A1_OCPUS}" \
      -var "instance_memory_gbs=${A1_MEMORY_GBS}" \
      -var "availability_domain_name=${ad}" 2>&1)"
  code=$?
  echo "$out"

  if [ "$code" -eq 0 ]; then
    echo "[$(ts)] SUCCESS: A1 instance launched in ${ad} after ${attempt} attempt(s)."
    printf '\a'  # terminal bell
    command -v osascript >/dev/null 2>&1 && \
      osascript -e 'display notification "A1.Flex launched on OCI" with title "a1-hunt"' >/dev/null 2>&1
    echo "[$(ts)] IMPORTANT: tfvars still says E2.1.Micro. Pin the A1 shape so a"
    echo "          later plain 'terraform apply' does not revert you to the micro:"
    echo "          set instance_shape = \"VM.Standard.A1.Flex\" in terraform.tfvars."
    exit 0
  fi

  if echo "$out" | grep -Eq "$RETRYABLE"; then
    echo "[$(ts)] No capacity yet (retryable). Sleeping ${RETRY_INTERVAL}s..."
    sleep "$RETRY_INTERVAL"
    continue
  fi

  echo "[$(ts)] STOPPING: apply failed with a non-capacity error (likely a config/auth"
  echo "          problem). Fix it, then re-run this script. See output above."
  exit 1
done
