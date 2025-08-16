#!/bin/bash
set -e

echo "Running BeforeInstall steps..."

# Navigate to project root
cd /home/ubuntu/iendorse/Back-API/graphAPI

# Fix permissions
sudo chown -R ubuntu:ubuntu /home/ubuntu/iendorse

# Create a release folder (with timestamp)
RELEASE_DIR="/home/ubuntu/iendorse/Back-API/releases/$(date +%Y%m%d%H%M%S)"
mkdir -p "$RELEASE_DIR"
echo "Created release folder: $RELEASE_DIR"

echo "BeforeInstall completed."
