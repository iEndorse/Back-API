


# login to aws
python3 -m pip install --user awscli
export PATH="$HOME/.local/bin:$PATH"
aws --version


aws configure
arn:aws:iam::730335624385:user/squaremethods
Verify identity: 
aws sts get-caller-identity
# Create repository for container
aws ecr create-repository --repository-name iendorse
# downlaod docker and confirm version running
docker --version

# login to docker online
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 730335624385.dkr.ecr.us-east-1.amazonaws.com

# Create Lambda Handler. lambda.js

const serverless = require('serverless-http');
const app = require('./server');

module.exports.handler = serverless(app);


# Install serverless-http
npm install serverless-http

Modify your server.js from
app.listen(3000, () => {
    console.log('Server running on port 3000');
});

# To
// Only start server if not in Lambda
if (process.env.AWS_EXECUTION_ENV === undefined) {
    app.listen(3000, () => {
        console.log('Server running on port 3000');
    });
}

module.exports = app;


# Build and push:
docker build -t ai-video-app .


docker run -p 9000:8080   -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}"   -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}"   -e AWS_DEFAULT_REGION="us-east-1"   -e PAGE_ID="${PAGE_ID}"   ai-video-app

# Docker tag
# Tag the image with your existing repository name
docker tag ai-video-app:latest 730335624385.dkr.ecr.us-east-1.amazonaws.com/iendorse:latest

# Push to ECR
docker push 730335624385.dkr.ecr.us-east-1.amazonaws.com/iendorse:latest



#### Create or update Lambda function
# Create IAM role (if it doesn't exist)
aws iam create-role \
    --role-name ai-video-app-role \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' 2>/dev/null || echo "Role already exists"

# Attach policies
aws iam attach-role-policy \
    --role-name ai-video-app-role \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam attach-role-policy \
    --role-name ai-video-app-role \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess

# Wait for role propagation
sleep 15

# Create Lambda function with CORRECT image URI
aws lambda create-function \
    --function-name ai-video-app \
    --package-type Image \
    --code ImageUri=730335624385.dkr.ecr.us-east-1.amazonaws.com/iendorse:latest \
    --role arn:aws:iam::730335624385:role/ai-video-app-role \
    --timeout 300 \
    --memory-size 2048 \
    --region us-east-1


# Update lambda function if exist
aws lambda update-function-code \
    --function-name ai-video-app \
    --image-uri 730335624385.dkr.ecr.us-east-1.amazonaws.com/iendorse:latest \
    --region us-east-1




# Check the image architecture
docker inspect ai-video-app | grep Architecture
# Build


 # Clean the current image
aws ecr batch-delete-image --repository-name fastapi-backend --region us-east-1 --image-ids imageTag=latest


aws ecr list-images --repository-name fastapi-backend --region us-east-1 --query 'imageIds[*]' --output json | \
aws ecr batch-delete-image --repository-name fastapi-backend --region us-east-1 --image-ids file:///dev/stdin

# Try building with explicit docker output
docker buildx build --platform linux/amd64 \
  --output type=docker \
  --provenance=false \
  --sbom=false \
  -t fastapi-backend-docker .

# Tag and push
docker tag fastapi-back-docker:latest 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest


docker push 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest





# describe image
 aws ecr describe-images --repository-name ai-video-app --region us-east-1

 make sure that "imageManifestMediaType": "application/vnd.docker.distribution.manifest.v2+json"

 # Test Locally with Lambda Runtime Interface Emulator

# Pull the image from ECR (if you haven't already)
docker pull 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest

# Run the container locally on port 9000
docker run -p 9000:8080 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest


# Run locally
docker run --env-file .env -d  -p 8000:8000 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest
docker run --env-file .env -p 8000:8000 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest

# update lambda image
aws lambda update-function-code \
  --function-name squaremethods_API \
  --image-uri 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest \
  --region us-east-1


# see all containers
docker ps -a




# Complete build and push
# 1. Build with the correct tag name
docker buildx build --platform linux/amd64 \
  --output type=docker \
  --provenance=false \
  --sbom=false \
  -t fastapi-back-docker .


docker tag fastapi-back-docker:latest 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest


docker push 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest

aws lambda update-function-code \
  --function-name squaremethods_API \
  --image-uri 730335624385.dkr.ecr.us-east-1.amazonaws.com/fastapi-backend:latest \
  --region us-east-1



#  Create trigger 
  Option 1: Quick Setup via AWS Console

Go to API Gateway Console
Create API → REST API → Build
API Name: fastapi-backend-api
Create API
Create Resource:

Actions → Create Resource
Resource Name: {proxy+}
Resource Path: {proxy+}
✅ Enable API Gateway CORS
Create Resource


Create Method:

Select the {proxy+} resource
Actions → Create Method → ANY
Integration type: Lambda Function Proxy
Lambda Function: squaremethods_API
✅ Use Lambda Proxy integration
Save


Deploy API:

Actions → Deploy API
Deployment stage: [New Stage]
Stage name: prod
Deploy