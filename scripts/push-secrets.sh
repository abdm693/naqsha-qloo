#!/bin/zsh
# Copies QLOO_API_KEY and TAVILY_API_KEY from the local .env into Secret Manager in the GCP project,
# and lets the Cloud Run runtime service account read them. Prints names only, never values.
set -e
cd "$(dirname "$0")/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=hack2skill
P=project-d5fe6dd3-2b61-40b3-932
for k in QLOO_API_KEY TAVILY_API_KEY; do
  name=${${k//_/-}:l}
  val=$(grep "^$k=" .env | cut -d= -f2-)
  [[ -z $val ]] && { print "$k missing from .env"; exit 1; }
  if gcloud secrets describe $name --project $P >/dev/null 2>&1; then
    print -rn -- $val | gcloud secrets versions add $name --data-file=- --project $P >/dev/null
  else
    print -rn -- $val | gcloud secrets create $name --data-file=- --replication-policy=automatic --project $P >/dev/null
  fi
  print "stored $name"
done
unset val
print "done"
