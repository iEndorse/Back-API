#!/bin/bash
echo "Starting application..."
cd /home/ubuntu/iendorse/Back-API/graphAPI
pm2 start server.js --name iendorse-api || pm2 reload iendorse-api
pm2 save
