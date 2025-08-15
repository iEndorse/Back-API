

#!/bin/bash
set -e

NEW_RELEASE=$(cat /tmp/deploy_path.txt)
cd "$NEW_RELEASE"

echo "Installing production dependencies..."
npm ci --omit=dev
echo "AfterInstall completed."
