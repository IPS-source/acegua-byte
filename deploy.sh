#!/bin/bash
# Script de deploy para DigitalOcean / VPS Ubuntu
# Uso: bash deploy.sh

echo "=== Aceguá Byte — Deploy ==="

# 1. Instalar dependências do sistema
sudo apt update
sudo apt install -y nodejs npm git chromium-browser

# 2. Clonar ou atualizar o projeto
if [ -d "/opt/aceguabyte" ]; then
    cd /opt/aceguabyte && git pull
else
    git clone <SEU-REPO> /opt/aceguabyte
    cd /opt/aceguabyte
fi

# 3. Instalar dependências Node
npm install

# 4. Criar serviço systemd para o servidor
sudo tee /etc/systemd/system/aceguabyte-web.service > /dev/null <<'EOF'
[Unit]
Description=Aceguá Byte Web Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/aceguabyte
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 5. Criar serviço para o bot (se for usar)
sudo tee /etc/systemd/system/aceguabyte-bot.service > /dev/null <<'EOF'
[Unit]
Description=Aceguá Byte WhatsApp Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/aceguabyte
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
Environment=REST_SLUG=geral

[Install]
WantedBy=multi-user.target
EOF

# 6. Habilitar e iniciar serviços
sudo systemctl daemon-reload
sudo systemctl enable aceguabyte-web
sudo systemctl restart aceguabyte-web
echo "=== Servidor rodando em http://$(curl -s ifconfig.me):3000 ==="
echo ""
echo "Para iniciar o bot: sudo systemctl start aceguabyte-bot"
echo "Para ver logs: sudo journalctl -u aceguabyte-web -f"
