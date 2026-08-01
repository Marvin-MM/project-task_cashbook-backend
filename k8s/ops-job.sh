#!/usr/bin/env bash
#
# Run a one-off operational script (backfill, repair, rebuild) against the
# cluster's database.
#
#   ./k8s/ops-job.sh backfill-ledger.js
#   ./k8s/ops-job.sh backfill-ledger.js --apply
#   ./k8s/ops-job.sh repair-financial-balances.js --apply
#   ./k8s/ops-job.sh rebuild-attendance-days.js --from 2026-05-01
#
# WHY A JOB AND NOT `kubectl exec`
#
# `exec` runs inside a serving pod. A rollout, an eviction, a failed liveness
# probe or a node drain kills it mid-run, and it competes for that pod's memory
# and connection budget while it does. A Job gets its own pod with its own
# lifecycle: nothing reschedules it, and its logs survive the run.
#
# RUN IT ONCE, NOT ONCE PER REPLICA
#
# These scripts act on the shared Postgres, not on anything pod-local. Two
# replicas is a serving concern; the database is singular. One Job is one pod is
# one execution — which is exactly right. Running it per pod would at best do
# identical work twice and at worst have the two fight over the same rows.
#
# The env comes from the live Deployment rather than being duplicated here, so
# DATABASE_URL and every secret are by construction the ones the app itself
# uses. Copying them into a checked-in manifest is how a backfill ends up
# pointed at the wrong database.
set -euo pipefail

NAMESPACE="${NAMESPACE:-inchange-app}"
DEPLOYMENT="${DEPLOYMENT:-inchange-app}"

if [ $# -lt 1 ]; then
    echo "usage: $0 <script.js> [args...]" >&2
    echo "       $0 --exec <command> [args...]" >&2
    echo "  e.g. $0 backfill-ledger.js --apply" >&2
    echo "       $0 --exec npx prisma migrate status" >&2
    exit 64
fi

if [ "$1" = "--exec" ]; then
    # Escape hatch for one-offs that are not scripts/ — `prisma migrate status`,
    # `migrate resolve`, `migrate deploy`. Same pod, same env, same reasoning.
    shift
    LABEL="$(echo "$1" | tr -cd 'a-z0-9-')"
    COMMAND_JSON=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
    DESCRIPTION="$*"
else
    SCRIPT="$1"; shift
    LABEL="$(echo "${SCRIPT%.js}" | tr '._' '--')"
    COMMAND_JSON=$(printf '%s\n' node "dist-scripts/scripts/${SCRIPT}" "$@" \
        | jq -R . | jq -sc .)
    DESCRIPTION="node dist-scripts/scripts/${SCRIPT} $*"
fi

JOB_NAME="ops-${LABEL}-$(date +%s)"

echo "Namespace : ${NAMESPACE}"
echo "Job       : ${JOB_NAME}"
echo "Command   : ${DESCRIPTION}"
echo

# Build the Job from the Deployment's own pod spec.
#
# Deliberately NOT copied across:
#   initContainers — that is the migration step; migrations are the Deployment's
#                    job and running them again here would be noise at best.
#   probes/ports   — a batch pod serves nothing, and a liveness probe against a
#                    port nothing listens on would kill the run.
#   replicas       — see above; one execution is the whole point.
MANIFEST=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o json | jq \
    --arg name "$JOB_NAME" \
    --arg ns "$NAMESPACE" \
    --argjson cmd "$COMMAND_JSON" '
    .spec.template.spec as $pod
    | $pod.containers[0] as $app
    | {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: $name, namespace: $ns },
        spec: {
          # No retries. These scripts are idempotent, but a money operation that
          # failed halfway deserves a human reading the log before it runs
          # again — not a silent second attempt against half-written state.
          backoffLimit: 0,
          # Keep the finished pod around for a day so the logs are still there
          # tomorrow, then clean up without anyone having to remember.
          ttlSecondsAfterFinished: 86400,
          template: {
            spec: {
              restartPolicy: "Never",
              imagePullSecrets: ($pod.imagePullSecrets // []),
              serviceAccountName: ($pod.serviceAccountName // "default"),
              volumes: ($pod.volumes // []),
              containers: [{
                name: "ops",
                image: $app.image,
                command: $cmd,
                env: ($app.env // []),
                envFrom: ($app.envFrom // []),
                volumeMounts: ($app.volumeMounts // []),
                resources: ($app.resources // {})
              }]
            }
          }
        }
      }')

echo "$MANIFEST" | kubectl apply -f -

echo
echo "Following logs (Ctrl-C detaches; the job keeps running)…"
echo
kubectl wait --for=condition=ready pod -l "job-name=${JOB_NAME}" \
    -n "$NAMESPACE" --timeout=120s 2>/dev/null || true
kubectl logs -f "job/${JOB_NAME}" -n "$NAMESPACE" || true

echo
kubectl get job "${JOB_NAME}" -n "$NAMESPACE"
echo
echo "Full logs later:  kubectl logs job/${JOB_NAME} -n ${NAMESPACE}"
