#!/bin/zsh
# Build and deploy Naqsha x Qloo to Cloud Run (service naqsha-qloo, its own Firestore database and bucket). Keys come from
# Secret Manager. Scales to zero when idle; CPU stays allocated while an instance is up so a design run keeps going.
set -e
cd "$(dirname "$0")/.."
export CLOUDSDK_ACTIVE_CONFIG_NAME=naqsha-nebius
P=naqsha-nebius-424e
gcloud run deploy naqsha-qloo --source . --region us-central1 --project $P \
  --service-account agent-runtime@$P.iam.gserviceaccount.com --allow-unauthenticated \
  --cpu 2 --memory 2Gi --timeout 3600 --concurrency 40 --min-instances 0 --max-instances 2 \
  --no-cpu-throttling --session-affinity \
  --set-env-vars GOOGLE_CLOUD_PROJECT=$P,GOOGLE_CLOUD_LOCATION=global,GOOGLE_GENAI_USE_ENTERPRISE=TRUE,GOOGLE_GENAI_USE_VERTEXAI=TRUE,FIRESTORE_DB=qloo,ASSETS_BUCKET=$P-qloo-assets \
  --set-secrets QLOO_API_KEY=qloo-api-key:latest,TAVILY_API_KEY=tavily-api-key:latest "$@"
