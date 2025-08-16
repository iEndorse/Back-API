#!/bin/bash
set -e

echo "Running AfterInstall steps..."

# Navigate to the actual project folder
cd /home/ubuntu/iendorse/Back-API/graphAPI

# Fix permissions
sudo chown -R ubuntu:ubuntu /home/ubuntu/iendorse

# Install dependencies safely
if [ -f "package-lock.json" ]; then
  echo "Installing dependencies with npm ci..."
  npm ci --only=production
else
  echo "No package-lock.json found. Installing with npm install..."
  npm install --omit=dev
fi

# Build the app if a build script exists
if [ -f "package.json" ] && grep -q "\"build\":" package.json; then
  echo "Running npm build..."
  npm run build
fi

echo "AfterInstall step completed successfully."
