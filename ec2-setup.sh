#!/bin/bash
# ─────────────────────────────────────────────
# LinkedIn AI Agent — EC2 t2.micro Setup Script
# Run this on a fresh Ubuntu 22.04 EC2 instance
# ─────────────────────────────────────────────

set -e

echo "==> Updating system..."
sudo apt update && sudo apt upgrade -y

echo "==> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "==> Installing PM2..."
sudo npm install -g pm2

echo "==> Installing Nginx..."
sudo apt install -y nginx

echo "==> Installing Git..."
sudo apt install -y git

echo "==> Cloning your repo..."
# Replace with your actual GitHub repo URL
git clone https://github.com/YOUR_USERNAME/linkedin-agent-server.git /home/ubuntu/app
cd /home/ubuntu/app

echo "==> Installing dependencies..."
npm install --production

echo "==> Creating .env file..."
cat > .env << 'EOF'
MONGO_URI=your_mongodb_atlas_uri
JWT_SECRET=your_strong_jwt_secret_here
PORT=5000
EOF
echo "⚠️  Edit /home/ubuntu/app/.env with your real values!"

echo "==> Creating uploads and logs directories..."
mkdir -p uploads logs

echo "==> Starting app with PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo "==> Configuring Nginx reverse proxy..."
sudo tee /etc/nginx/sites-available/linkedin-agent << 'NGINX'
server {
    listen 80;
    server_name _;

    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/linkedin-agent /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

echo ""
echo "✅ Setup complete!"
echo "Your server is running at: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
echo ""
echo "Next steps:"
echo "1. Edit /home/ubuntu/app/.env with your real values"
echo "2. Run: pm2 restart linkedin-agent"
echo "3. Update your frontend API URL to: http://YOUR_EC2_IP"
