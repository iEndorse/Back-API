#!/bin/bash

# Pre-deployment cleanup script for CodeDeploy
# Add this to your appspec.yml BeforeInstall hooks

LOG_FILE="/var/log/deployment-cleanup.log"
CODEDEPLOY_ROOT="/opt/codedeploy-agent/deployment-root"
MIN_FREE_SPACE_GB=2

log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | sudo tee -a $LOG_FILE
}

check_disk_space() {
    # Get available space in GB
    AVAILABLE_SPACE=$(df --output=avail -BG / | tail -n1 | sed 's/G//')
    log_message "Available space: ${AVAILABLE_SPACE}GB"
    
    if [ "$AVAILABLE_SPACE" -lt "$MIN_FREE_SPACE_GB" ]; then
        log_message "WARNING: Low disk space detected (${AVAILABLE_SPACE}GB available)"
        return 1
    fi
    return 0
}

cleanup_old_deployments() {
    log_message "Starting deployment cleanup..."
    
    # Find all deployment directories except the 2 most recent
    if [ -d "$CODEDEPLOY_ROOT" ]; then
        # Keep only the 2 most recent deployments
        OLD_DEPLOYMENTS=$(find $CODEDEPLOY_ROOT -maxdepth 2 -name "d-*" -type d -printf '%T@ %p\n' | sort -n | head -n -2 | cut -d' ' -f2-)
        
        for deployment in $OLD_DEPLOYMENTS; do
            if [ -d "$deployment" ]; then
                log_message "Removing old deployment: $deployment"
                sudo rm -rf "$deployment"
            fi
        done
    fi
}

cleanup_logs() {
    log_message "Cleaning up old log files..."
    
    # Clean logs older than 7 days
    sudo find /var/log -name "*.log" -type f -mtime +7 -delete 2>/dev/null
    sudo find /var/log -name "*.gz" -type f -mtime +7 -delete 2>/dev/null
    
    # Clean journal logs
    sudo journalctl --vacuum-time=7d
}

cleanup_apt_cache() {
    log_message "Cleaning package cache..."
    sudo apt-get clean
    sudo apt-get autoremove -y
}

main() {
    log_message "=== Starting pre-deployment cleanup ==="
    
    # Always run cleanup
    cleanup_old_deployments
    cleanup_logs
    cleanup_apt_cache
    
    # Check if we have enough space now
    if ! check_disk_space; then
        log_message "ERROR: Still insufficient disk space after cleanup"
        exit 1
    fi
    
    log_message "=== Cleanup completed successfully ==="
}

# Run the main function
main
