#!/bin/bash
# One-time setup for Ubuntu EC2 instance
# Run as: bash setup-ec2.sh

set -e

echo "=== Installing system dependencies ==="
sudo apt-get update -y
sudo apt-get install -y \
  git curl wget \
  xvfb x11-xserver-utils \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libcairo2 \
  python3 python3-pip python3-venv \
  build-essential

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Installing Claude Code CLI ==="
npm install -g @anthropic-ai/claude-code

echo "=== Installing PM2 (process manager) ==="
sudo npm install -g pm2
pm2 startup systemd -u ubuntu --hp /home/ubuntu | sudo bash

echo "=== Cloning Cerebro ==="
# Replace with your actual repo
git clone https://github.com/hepulido/Cerebro.git ~/Cerebro
cd ~/Cerebro
npm install

echo "=== Setting up Python backend ==="
cd ~/Cerebro/backend
python3 -m venv venv
venv/bin/pip install -r requirements.txt

echo "=== Creating PM2 ecosystem file ==="
cat > ~/cerebro-pm2.config.js << 'PMEOF'
module.exports = {
  apps: [{
    name: 'cerebro',
    script: 'npm',
    args: 'start',
    cwd: '/home/ubuntu/Cerebro',
    interpreter: '/bin/bash',
    env: {
      DISPLAY: ':99',
      NODE_ENV: 'production',
    },
    restart_delay: 5000,
    max_restarts: 10,
  }]
};
PMEOF

echo "=== Starting virtual display ==="
cat > /etc/systemd/system/xvfb.service << 'XVEOF'
[Unit]
Description=X Virtual Frame Buffer
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1024x768x24
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
XVEOF

sudo systemctl daemon-reload
sudo systemctl enable xvfb
sudo systemctl start xvfb

echo "=== Starting Cerebro ==="
cd ~/Cerebro
DISPLAY=:99 pm2 start ~/cerebro-pm2.config.js
pm2 save

echo ""
echo "✅ Done! Cerebro is running."
echo "   Check status: pm2 status"
echo "   View logs: pm2 logs cerebro"
echo "   Restart: pm2 restart cerebro"
