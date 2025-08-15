#!/bin/bash
set -e

APP_NAME="iendorse"

echo "Stopping PM2 process $APP_NAME if it exists..."

# Graceful stop; delete if it hangs
pm2 describe $APP_NAME > /dev/null 2>&1
if [ $? -eq 0 ]; then
    pm2 stop $APP_NAME || pm2 delete $APP_NAME || true
else
    echo "PM2 process $APP_NAME not running. Skipping stop."
fi

echo "Stop server completed."
