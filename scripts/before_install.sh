#!/bin/bash
set -e

RELEASES_DIR="/home/ubuntu/iendorse/Back-API/releases"
TIMESTAMP=$(date +%Y%m%d%H%M%S)
NEW_RELEASE="$RELEASES_DIR/$TIMESTAMP"

echo "Creating new release folder: $NEW_RELEASE"
mkdir -p "$NEW_RELEASE"

# Store path for after_install and start_server scripts
echo "$NEW_RELEASE" > /tmp/deploy_path.txt
