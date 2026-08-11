#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT:-apron-dev-504523}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="apron"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "Building container via Cloud Build..."
gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}"

echo "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --allow-unauthenticated \
  --session-affinity \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 3 \
  --timeout 3600 \
  --update-env-vars "NODE_ENV=production,TZ=America/New_York"

echo ""
echo "Deployed! URL:"
gcloud run services describe "${SERVICE_NAME}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format 'value(status.url)'
