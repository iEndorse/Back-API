#!/bin/bash
echo "Stopping application..."
pm2 stop iendorse-api || true
