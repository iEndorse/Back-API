#!/bin/bash
set -e

NEW_RELEASE=$(cat /tmp/deploy_path.txt)
CURRENT_LINK="/home/ubuntu/iendorse/Back-API/current"

# Point symlink to new release
ln -sfn "$NEW_RELEASE" "$CURRENT_LINK"

cd "$CURRENT_LINK"

# Zero-downtime reload
pm2 describe iendorse > /dev/null 2>&1 && pm2 reload iendorse || pm2 start server.js --name iendorse

echo "ApplicationStart completed."
