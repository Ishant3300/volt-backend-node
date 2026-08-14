#!/bin/bash
# Deploy stocker-backend-node to EC2 production server
# Usage: ./deploy-prod.sh

set -e

EC2_HOST="13.204.61.199"
EC2_USER="ec2-user"
SSH_KEY="/Users/devarshukani/Work/Keys/apex/my-ec2-key"
REMOTE_DIR="/home/ec2-user/stocker-backend-node"
PM2_APP="stocker-backend-node"

echo "🚀 Deploying to production ($EC2_HOST)..."

echo "🧹 Cleaning up remote server to free up space..."
ssh -i $SSH_KEY ${EC2_USER}@${EC2_HOST} << 'EOF'
  pm2 flush || true
  npm cache clean --force || true
  sudo journalctl --vacuum-size=100M || true
  sudo rm -rf /tmp/rsync* || true
EOF

# Sync source files (exclude node_modules, .env, logs, downloads, etc.)
echo "📦 Uploading files..."
rsync -avz --inplace --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'dump.rdb' \
  --exclude 'scripts/downloads' \
  --exclude '.git' \
  --exclude 'test' \
  --exclude 'tests' \
  ./ ${EC2_USER}@${EC2_HOST}:${REMOTE_DIR}/

# Install dependencies and restart
echo "🔄 Installing dependencies and restarting..."
ssh -i $SSH_KEY ${EC2_USER}@${EC2_HOST} << 'EOF'
  cd ~/stocker-backend-node
  npm install --production
  pm2 restart stocker-backend-node --update-env || pm2 start src/index.js --name stocker-backend-node
  echo "✅ Deployed and restarted"
EOF

echo "✅ Deploy complete!"
