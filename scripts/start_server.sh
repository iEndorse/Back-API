#!/bin/bash
set -e

echo "Starting Node app with PM2..."

# Navigate to project folder
cd /home/ubuntu/iendorse/Back-API/graphAPI

# Start the app if not already running
if ! pm2 list | grep -q iendorse; then
  pm2 start server.js --name iendorse
  echo "App started."
else
  pm2 reload iendorse
  echo "App reloaded."
fi
