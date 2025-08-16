#!/bin/bash
set -e

echo "Running AfterInstall steps..."

cd /home/ubuntu/iendorse/Back-API

# Fix permissions (again, just in case)
sudo chown -R ubuntu:ubuntu /home/ubuntu/iendorse

# Install dependencies using npm ci (clean install from package-lock.json)
echo "Installing dependencies with npm ci..."
npm ci --only=production

# Build the app (optional — only if your Node app needs a build step)
if [ -f "package.json" ] && grep -q "\"build\":" package.json; then
  echo "Running npm build..."
  npm run build
fi

echo "AfterInstall step completed successfully."
