#!/bin/bash
echo "Installing dependencies..."
cd /home/ubuntu/iendorse/Back-API/graphAPI
npm install --omit=dev

# Optional health check
STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
if [ "$STATUS_CODE" -ne 200 ]; then
  echo "Health check failed with status $STATUS_CODE"
  exit 1
fi
