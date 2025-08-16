#!/bin/bash
set -e

echo "Starting application..."

APP_DIR="/home/ubuntu/iendorse/Back-API/graphAPI"
cd "$APP_DIR"

# Install production dependencies
echo "Installing dependencies..."
npm install --omit=dev

# Start or reload the application with PM2
echo "Starting/reloading application with PM2..."
if pm2 list | grep -q "iendorse"; then
    echo "Reloading existing iendorse process..."
    pm2 reload iendorse
else
    echo "Starting new iendorse process..."
    pm2 start server.js --name iendorse
fi

# Save PM2 process list
pm2 save

echo "Application started successfully"