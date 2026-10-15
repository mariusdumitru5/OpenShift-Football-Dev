#!/usr/bin/env bash
# Deploy completo con un solo comando:
#   ./scripts/deploy.sh            (usa l'overlay dev, namespace "football")
#   ./scripts/deploy.sh prod       (usa openshift/overlays/prod, se lo crei)
set -euo pipefail

OVERLAY="${1:-dev}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NS="$(grep -E '^namespace:' "$DIR/openshift/overlays/$OVERLAY/kustomization.yaml" | awk '{print $2}')"

echo ">> Progetto: $NS (overlay $OVERLAY)"
oc get project "$NS" >/dev/null 2>&1 || oc new-project "$NS" >/dev/null

echo ">> Applico tutte le risorse generate da Kustomize"
oc apply -k "$DIR/openshift/overlays/$OVERLAY"

echo ">> Le BuildConfig partono da sole (trigger ConfigChange). Attendo le build..."
for bc in frontend auth backend; do
  for i in $(seq 1 60); do
    phase="$(oc get builds -n "$NS" -l buildconfig="$bc" --sort-by=.metadata.creationTimestamp \
             -o jsonpath='{.items[-1:].status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Complete) echo "   build $bc: completata"; break ;;
      Failed|Error|Cancelled) echo "   build $bc: $phase"; oc logs -n "$NS" "bc/$bc" | tail -30; exit 1 ;;
      *) sleep 10 ;;
    esac
  done
done

echo ">> Attendo database e rollout"
oc rollout status -n "$NS" statefulset/db --timeout=5m
for d in auth backend frontend; do
  oc rollout status -n "$NS" "deployment/$d" --timeout=10m
done

HOST="$(oc get route frontend -n "$NS" -o jsonpath='{.spec.host}')"
echo
echo ">> Pronto: https://$HOST"
echo ">> URL webhook GitHub (uno per BuildConfig):"
for bc in frontend auth backend; do
  oc describe bc "$bc" -n "$NS" | grep -A1 "Webhook GitHub" | tail -1 | sed "s/^/   $bc: /"
done
