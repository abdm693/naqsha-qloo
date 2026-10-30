#!/bin/zsh
# Build and deploy Naqsha x Qloo to Cloud Run as its own service, naqsha-qloo, with its own Firestore database and bucket;
# the project's original naqsha service and data are never touched. Keys come from
# Secret Manager. Scales to zero when idle; CPU stays allocated while an instance is up so a design run keeps going.
set -e
cd "$(dirname "$0")/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=hack2skill
P=project-d5fe6dd3-2b61-40b3-932
# The Identity Platform browser key (public by design) is read from the project's existing service, never stored here.
AUTH=$(gcloud run services describe naqsha --region us-central1 --project $P --format=json | python3 -c "import json,sys
d = json.load(sys.stdin)['spec']['template']['spec']['containers'][0]['env']
print(next((e.get('value', '') for e in d if e['name'] == 'NAQSHA_AUTH_API_KEY'), ''))")
gcloud run deploy naqsha-qloo --source . --region us-central1 --project $P \
  --service-account agent-runtime@$P.iam.gserviceaccount.com --allow-unauthenticated \
  --cpu 2 --memory 2Gi --timeout 3600 --concurrency 40 --min-instances 0 --max-instances 2 \
  --no-cpu-throttling --session-affinity \
  --set-env-vars GOOGLE_CLOUD_PROJECT=$P,GOOGLE_CLOUD_LOCATION=global,GOOGLE_GENAI_USE_ENTERPRISE=TRUE,GOOGLE_GENAI_USE_VERTEXAI=TRUE,FIRESTORE_DB=qloo,ASSETS_BUCKET=$P-qloo-assets,NAQSHA_AUTH_API_KEY=$AUTH \
  --set-secrets QLOO_API_KEY=qloo-api-key:latest,TAVILY_API_KEY=tavily-api-key:latest "$@"
