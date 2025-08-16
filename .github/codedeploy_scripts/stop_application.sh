#!/bin/bash
set -e

echo "Stopping application..."

# Stop PM2 process if running
if pm2 list | grep -q "iendorse"; then
    echo "Stopping iendorse process..."
    pm2 stop iendorse || true
else
    echo "iendorse process not running"
fi

echo "Stop application completed successfully"