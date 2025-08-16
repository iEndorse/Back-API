#!/bin/bash
set -e

echo "Stopping Node app with PM2..."

# Navigate to project folder
cd /home/ubuntu/iendorse/Back-API/graphAPI

# Stop the app safely if it exists
if pm2 list | grep -q iendorse; then
  pm2 stop iendorse
  echo "App stopped."
else
  echo "PM2 process not found, skipping stop."
fi
