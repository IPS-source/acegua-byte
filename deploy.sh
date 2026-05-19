#!/bin/bash
# Script de deploy para DigitalOcean / VPS Ubuntu
# Uso: bash deploy.sh
# Primeiro configure o repositório: git remote set-url origin <SEU-REPO>

echo "=== Aceguá Byte — Deploy ==="

# 1. Instalar dependências do sistema
sudo apt update
sudo apt install -y nodejs npm git chromium-browser

# 2. Clonar ou atualizar o projeto
if [ -d "/opt/aceguabyte" ]; then
    cd /opt/aceguabyte && git pull
else
    git clone https://github.com/IPS-source/acegua-byte /opt/aceguabyte
    cd /opt/aceguabyte
fi

# 3. Colocar serviceAccountKey.json (faça upload manual para /opt/aceguabyte/)

# 4. Instalar dependências Node
npm install

# 5. Criar serviço systemd (único: servidor + bots integrados)
sudo tee /etc/systemd/system/aceguabyte.service > /dev/null <<'EOF'
[Unit]
Description=Aceguá Byte — Servidor + WhatsApp Bots
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

# 6. Habilitar e iniciar
sudo systemctl daemon-reload
sudo systemctl enable aceguabyte
sudo systemctl restart aceguabyte

echo ""
echo "✅ Deploy concluído!"
echo "🖥️ Servidor: http://$(curl -s ifconfig.me):3000"
echo ""
echo "Para ver logs: sudo journalctl -u aceguabyte -f"
echo "Para reiniciar: sudo systemctl restart aceguabyte"
echo ""
echo "IMPORTANTE: Faça upload do serviceAccountKey.json para /opt/aceguabyte/"
echo "IMPORTANTE: Configure Nginx + Certbot para HTTPS (recomendado)"
