#!/bin/bash
set -e

echo "Before Install: Creating backup and preparing environment"

APP_DIR="/home/ubuntu/iendorse/Back-API/graphAPI"
BACKUP_DIR="/home/ubuntu/iendorse_backup"

# Create backup directory
if [ -d "$APP_DIR" ]; then
    echo "Creating backup of current version..."
    rm -rf "$BACKUP_DIR" || true
    cp -r "$APP_DIR" "$BACKUP_DIR"
fi

# Ensure directory structure exists
mkdir -p /home/ubuntu/iendorse/Back-API/graphAPI

echo "Before Install completed successfully"