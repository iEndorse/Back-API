


#!/bin/bash

echo "Starting application..."
# Navigate to app directory
cd /home/ubuntu/iendorse/Back-API/graphAPI || exit 1

# Install dependencies just in case
npm ci --omit=dev

# Reload PM2 process if it exists, else start it
if pm2 list | grep -q iendorse; then
  pm2 reload iendorse
else
  pm2 start server.js --name iendorse
fi

# Save PM2 process list
pm2 save
