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

# Ensure directory structure exists with correct permissions
mkdir -p /home/ubuntu/iendorse/Back-API/graphAPI
chown -R ubuntu:ubuntu /home/ubuntu/iendorse

echo "Before Install completed successfully"