#!/usr/bin/env bash

# Stream Cloud Run logs for the service. Override SERVICE/PROJECT/REGION if needed.
SERVICE="${SERVICE:-bvis}"
PROJECT="${PROJECT:-your-gcp-project}"
REGION="${REGION:-your-gcp-region}"

set -euo pipefail

echo "Tailing logs for service=${SERVICE} project=${PROJECT} region=${REGION}..."
echo "Press Ctrl+C to stop."
gcloud logging tail \
  "resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE}" \
  --project "${PROJECT}" --location "${REGION}"
