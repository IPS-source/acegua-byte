const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');
const crypto = require('crypto');
const BotManager = require('./bot/manager');

// ========== FIREBASE ==========
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString())
    : JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://ips-source-pedidos-default-rtdb.firebaseio.com/"
});
const db = admin.database();

const SALT = '-aceguabyte-salt';

// ========== EXPRESS + SOCKET.IO ==========
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir arquivos estáticos da pasta public/
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
console.log('🌐 BASE_URL:', BASE_URL);

// Bot Manager
const botManager = new BotManager(db, io, BASE_URL);

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
    console.log('🔌 Socket conectado:', socket.id);

    // Cliente se autentica e entra na sala do restaurante
    socket.on('join', async ({ slug, token }) => {
        if (!slug) {
            socket.emit('error', 'slug é obrigatório');
            return;
        }
        // Validar token (base64 JSON com slug/email)
        if (!token) {
            socket.emit('error', 'Token obrigatório');
            return;
        }
        try {
            const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
            if (decoded.slug !== slug) {
                socket.emit('error', 'Token inválido para este restaurante');
                return;
            }
            // Verificar se o restaurante existe
            const snap = await db.ref('restaurants/' + slug).once('value');
            if (!snap.exists()) {
                socket.emit('error', 'Restaurante não encontrado');
                return;
            }
            socket.join(slug);
            console.log(`🏠 Socket ${socket.id} entrou na sala: ${slug}`);

            // Enviar status atual do bot
            const status = botManager.getStatus(slug);
            socket.emit('whatsapp:status', { slug, ...status });

            socket.emit('joined', { slug });
        } catch (e) {
            console.error('Erro na validação de token:', e.message);
            socket.emit('error', 'Token inválido');
        }
    });

    // Vincular WhatsApp
    socket.on('whatsapp:connect', async ({ slug }) => {
        if (!slug) return;
        console.log(`📱 [${slug}] Solicitação de vínculo WhatsApp`);
        await botManager.start(slug);
    });

    // Desconectar WhatsApp
    socket.on('whatsapp:disconnect', async ({ slug }) => {
        if (!slug) return;
        console.log(`📱 [${slug}] Solicitação de desconexão`);
        await botManager.stop(slug);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Socket desconectado:', socket.id);
    });
});

// ========== FALLBACK: SPA ==========
// Para rotas do lado cliente (dashboard, cardapio, etc.)
app.get('*', (req, res) => {
    // Se a URL corresponde a um arquivo estático conhecido, servir
    const staticFiles = ['/', '/login', '/register', '/painel', '/proposta-comercial'];
    const pathname = req.url.split('?')[0];

    if (pathname === '/' || pathname === '') {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    if (pathname === '/login') {
        return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
    if (pathname === '/register') {
        return res.sendFile(path.join(__dirname, 'public', 'register.html'));
    }
    if (pathname === '/painel') {
        return res.sendFile(path.join(__dirname, 'public', 'painel.html'));
    }
    if (pathname === '/proposta-comercial') {
        return res.sendFile(path.join(__dirname, 'public', 'proposta-comercial.html'));
    }
    if (pathname.startsWith('/dashboard/')) {
        return res.sendFile(path.join(__dirname, 'public', 'dashboard-restaurante.html'));
    }
    if (pathname.startsWith('/cardapio/')) {
        return res.sendFile(path.join(__dirname, 'public', 'cardapio.html'));
    }

    res.status(404).send('<h1>404 — Página não encontrada</h1>');
});

// ========== INICIAR ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🖥️ Aceguá Byte — Servidor rodando em: http://localhost:${PORT}`);
    console.log(`📝 Registro: http://localhost:${PORT}/register`);
    console.log(`🔑 Login:    http://localhost:${PORT}/login`);
    console.log(`📋 Painel:   http://localhost:${PORT}/painel`);
    console.log(`🍽️ Cardápio: http://localhost:${PORT}/cardapio/{slug}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Encerrando...');
    await botManager.stopAll();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Encerrando...');
    await botManager.stopAll();
    process.exit(0);
});
