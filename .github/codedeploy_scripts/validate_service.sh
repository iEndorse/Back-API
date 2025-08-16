#!/bin/bash
set -e

echo "Validating service..."

# Wait for application to start
sleep 15

# Check if PM2 process is running
if pm2 list | grep -q "iendorse.*online"; then
    echo "✅ PM2 process is running successfully!"
    # Clean up backup on successful deployment
    rm -rf /home/ubuntu/iendorse_backup || true
    echo "Validation completed successfully"
    exit 0
else
    echo "❌ PM2 process is not running!"
    pm2 logs iendorse --lines 10 || true
    exit 1
fi