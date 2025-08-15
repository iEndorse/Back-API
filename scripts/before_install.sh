#!/bin/bash
set -e

RELEASES_DIR="/home/ubuntu/iendorse/Back-API/releases"
TIMESTAMP=$(date +%Y%m%d%H%M%S)
NEW_RELEASE="$RELEASES_DIR/$TIMESTAMP"

# Ensure parent folder exists and is writable
mkdir -p "$RELEASES_DIR"
chmod u+rwx "$RELEASES_DIR"

echo "Creating new release folder: $NEW_RELEASE"
mkdir -p "$NEW_RELEASE"

# Store path for after_install and start_server scripts
echo "$NEW_RELEASE" > /tmp/deploy_path.txt
