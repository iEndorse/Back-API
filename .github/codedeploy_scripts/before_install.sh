# before_install.sh
#!/bin/bash
set -e

echo "Before Install: Creating backup and preparing environment"

APP_DIR="/home/ubuntu/iendorse/Back-API/graphAPI"
BACKUP_DIR="/home/ubuntu/iendorse_backup"

# Create backup directory with consistent naming
if [ -d "$APP_DIR" ]; then
    echo "Creating backup of current version..."
    rm -rf "$BACKUP_DIR" || true
    cp -r "$APP_DIR" "$BACKUP_DIR"
fi

# Ensure directory structure exists with correct permissions
mkdir -p /home/ubuntu/iendorse/Back-API/graphAPI
chown -R ubuntu:ubuntu /home/ubuntu/iendorse

# Install Node.js if not present
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    apt-get install -y nodejs
fi

# Install PM2 globally if not present
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
fi

---

# stop_application.sh
#!/bin/bash
set -e

echo "Stopping application..."

# Stop PM2 process if running (consistent naming)
if pm2 list | grep -q "iendorse"; then
    echo "Stopping iendorse process..."
    pm2 stop iendorse || true
else
    echo "iendorse process not running"
fi

---

# start_application.sh
#!/bin/bash
set -e

echo "Starting application..."

APP_DIR="/home/ubuntu/iendorse/Back-API/graphAPI"
cd "$APP_DIR"

# Install production dependencies
echo "Installing dependencies..."
if [ -f package-lock.json ]; then
    npm ci --omit=dev
else
    npm install --omit=dev
fi

# Start or reload the application with PM2
echo "Starting/reloading application with PM2..."
if pm2 list | grep -q "iendorse"; then
    echo "Reloading existing iendorse process..."
    pm2 reload iendorse
else
    echo "Starting new iendorse process..."
    pm2 start server.js --name iendorse
fi

# Save PM2 process list
pm2 save

echo "Application started successfully"

---

# validate_service.sh
#!/bin/bash
set -e

echo "Validating service..."

APP_DIR="/home/ubuntu/iendorse/Back-API/graphAPI"
BACKUP_DIR="/home/ubuntu/iendorse_backup"

# Wait for application to start
sleep 10

# Check if PM2 process is running
if ! pm2 list | grep -q "iendorse.*online"; then
    echo "❌ PM2 process is not running!"
    
    # Check PM2 logs for errors
    echo "PM2 logs:"
    pm2 logs iendorse --lines 20 || true
    
    # Attempt rollback
    echo "Attempting rollback..."
    if [ -d "$BACKUP_DIR" ]; then
        rm -rf "$APP_DIR"
        cp -r "$BACKUP_DIR" "$APP_DIR"
        cd "$APP_DIR"
        npm ci --omit=dev || true
        pm2 start server.js --name iendorse || pm2 reload iendorse
        pm2 save
        echo "Rollback completed"
    fi
    
    exit 1
fi

# Test health endpoint (if available)
MAX_ATTEMPTS=5
ATTEMPT=1

while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
    echo "Health check attempt $ATTEMPT/$MAX_ATTEMPTS"
    
    # Adjust this URL based on your setup (localhost, port, health endpoint)
    STATUS_CODE=$(curl -o /dev/null -s -w "%{http_code}" \
        http://localhost:3000/health || echo 000)
    
    if [ "$STATUS_CODE" -eq 200 ]; then
        echo "✅ Health check passed!"
        # Clean up backup on successful deployment
        rm -rf "$BACKUP_DIR" || true
        exit 0
    else
        echo "❌ Health check failed (HTTP $STATUS_CODE)"
        if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
            echo "All health check attempts failed"
            
            # Attempt rollback
            echo "Attempting rollback..."
            if [ -d "$BACKUP_DIR" ]; then
                pm2 stop iendorse || true
                rm -rf "$APP_DIR"
                cp -r "$BACKUP_DIR" "$APP_DIR"
                cd "$APP_DIR"
                npm ci --omit=dev || true
                pm2 start server.js --name iendorse || pm2 reload iendorse
                pm2 save
                echo "Rollback completed"
            fi
            
            exit 1
        fi
        sleep 15
        ATTEMPT=$((ATTEMPT + 1))
    fi
done
