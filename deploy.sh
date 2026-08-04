#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT:-apron-dev-504523}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="apron"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "Building container..."
docker build -t "${IMAGE}" .

echo "Pushing to Container Registry..."
docker push "${IMAGE}"

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
  --max-instances 3 \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production"

echo ""
echo "Deployed! URL:"
gcloud run services describe "${SERVICE_NAME}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format 'value(status.url)'
