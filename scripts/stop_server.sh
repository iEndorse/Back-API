#!/bin/bash
set -e

echo "Stopping PM2 process if it exists..."
pm2 describe iendorse > /dev/null 2>&1 && pm2 stop iendorse || true
echo "Stop server completed."
