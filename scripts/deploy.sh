#!/bin/bash
# Run from your Mac to manually deploy to EC2
# Usage: bash scripts/deploy.sh

EC2_HOST="${EC2_HOST:-your-ec2-ip-here}"
EC2_KEY="${EC2_KEY:-~/.ssh/cerebro-ec2.pem}"

echo "🚀 Deploying Cerebro to EC2 at $EC2_HOST..."

ssh -i "$EC2_KEY" ubuntu@"$EC2_HOST" << 'REMOTE'
  set -e
  cd ~/Cerebro
  git pull origin main
  npm install --silent
  cd backend && venv/bin/pip install -r requirements.txt -q && cd ..
  pm2 restart cerebro
  pm2 status
  echo "✅ Deployed!"
REMOTE
