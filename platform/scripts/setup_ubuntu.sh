#!/usr/bin/env bash
# One-shot setup of a fresh Ubuntu 22.04/24.04 VM: Docker, firewall, .env with random secrets.
set -euo pipefail
sudo apt-get update && sudo apt-get install -y ca-certificates curl ufw git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" || true
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
  echo "Edit .env: set DOMAIN (and MATTERPORT_SDK_KEY / VPS_URL if used)"
fi
mkdir -p matterpaks
echo "Next: docker compose up -d --build && docker compose exec api wayfinding create-admin you@example.com"
