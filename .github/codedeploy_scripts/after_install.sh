#!/bin/bash
set -e

echo "After Install: Setting correct permissions"

APP_DIR="/home/ubuntu/iendorse/Back-API/graphAPI"

# Fix ownership of all files and directories
chown -R ubuntu:ubuntu /home/ubuntu/iendorse

# Set proper permissions
find "$APP_DIR" -type d -exec chmod 755 {} \;
find "$APP_DIR" -type f -exec chmod 644 {} \;

# Make script files executable if they exist
if [ -d "$APP_DIR/scripts" ]; then
    chmod +x "$APP_DIR"/scripts/*.sh || true
fi

echo "After Install completed successfully"