const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const admin = require('firebase-admin');
const { handleMessage, setupPedidoListener } = require('./handlers');

class BotManager {
    constructor(db, io, baseUrl) {
        this.db = db;
        this.io = io;
        this.baseUrl = baseUrl;
        this.bots = new Map();
        this.pedidoListeners = new Map();
    }

    async start(slug, clearSession = false) {
        if (this.bots.has(slug)) {
            const existing = this.bots.get(slug);
            if (existing.client && existing.status === 'connected') {
                this.io.to(slug).emit('whatsapp:status', { slug, status: 'connected', info: 'Já conectado' });
                return;
            }
            await this.stop(slug);
            clearSession = true;
        }

        if (clearSession) {
            const authPath = require('path').join(process.cwd(), '.wwebjs_auth', 'session-rest-' + slug);
            try { require('fs').rmSync(authPath, { recursive: true, force: true }); } catch (e) {}
            console.log(`🗑️ [${slug}] Sessão anterior removida`);
        }

        const botState = {
            client: null,
            status: 'connecting',
            qr: null,
            sessoes: {},
            cardapioCache: { categorias: {} }
        };
        this.bots.set(slug, botState);
        this.emitStatus(slug, 'connecting', 'Iniciando...');

        // Carregar cardápio do Firebase
        try {
            const snap = await this.db.ref('restaurants/' + slug + '/cardapio').once('value');
            if (snap.exists()) {
                botState.cardapioCache = snap.val();
                console.log(`📋 Cardápio carregado para ${slug}: ${Object.keys(botState.cardapioCache.categorias || {}).length} categorias`);
            }
            this.db.ref('restaurants/' + slug + '/cardapio').on('value', snap => {
                if (snap.exists()) botState.cardapioCache = snap.val();
            });
        } catch (e) {
            console.error(`❌ Erro ao carregar cardápio de ${slug}:`, e.message);
        }

        const client = new Client({
            authStrategy: new LocalAuth({ clientId: 'rest-' + slug }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
                timeout: 120000
            }
        });

        client.on('loading_screen', (percent, msg) => {
            console.log(`🔄 [${slug}] Carregando WhatsApp: ${percent}%`);
        });

        client.on('qr', async (qr) => {
            botState.qr = qr;
            botState.status = 'qr';
            try {
                const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                this.io.to(slug).emit('whatsapp:qr', { slug, qr: dataUrl });
            } catch (err) {
                console.error('❌ Erro ao gerar QR:', err.message);
            }
        });

        client.on('authenticated', () => {
            console.log(`🔑 [${slug}] Sessão autenticada!`);
        });

        client.on('auth_failure', (msg) => {
            console.error(`❌ [${slug}] Falha na autenticação:`, msg);
            botState.status = 'auth_failure';
            this.emitStatus(slug, 'auth_failure', 'Falha na autenticação');
        });

        client.on('ready', async () => {
            console.log(`✅ [${slug}] BOT CONECTADO!`);
            botState.status = 'connected';

            // Obter o número do WhatsApp conectado
            try {
                const info = await client.getContactById(client.info.wid._serialized);
                const numero = info.id.user || client.info.wid.user;
                botState.numero = numero;
                this.emitStatus(slug, 'connected', 'Conectado', numero);
                // Salvar número no Firebase
                await this.db.ref('restaurants/' + slug + '/centralBotNumber').set(numero);
                console.log(`📱 [${slug}] Número conectado: ${numero}`);
            } catch (e) {
                console.log(`📱 [${slug}] Conectado (número não detectado)`);
                this.emitStatus(slug, 'connected', 'Conectado');
            }
        });

        client.on('disconnected', (reason) => {
            console.log(`🔌 [${slug}] Desconectado:`, reason);
            botState.status = 'disconnected';
            this.emitStatus(slug, 'disconnected', 'Desconectado: ' + reason);
            this.bots.delete(slug);
        });

        client.on('message_create', async (msg) => {
            try {
                if (msg.fromMe) return;
                console.log(`📩 [${slug}] Mensagem recebida de ${msg.from}: "${(msg.body || '').substring(0, 80)}"`);
                const ctx = {
                    client,
                    db: this.db,
                    slug,
                    baseUrl: this.baseUrl,
                    sessoes: botState.sessoes,
                    cardapioCache: botState.cardapioCache
                };
                await handleMessage(msg, ctx);
            } catch (e) {
                console.error(`❌ [${slug}] Erro no message handler:`, e.message, e.stack);
                try {
                    await client.sendMessage(msg.from, '❌ Ocorreu um erro. Tente novamente.');
                } catch (_) {}
            }
        });

        botState.client = client;

        try {
            await client.initialize();
        } catch (err) {
            console.error(`❌ [${slug}] Falha ao iniciar WhatsApp:`, err.message);
            botState.status = 'error';
            this.emitStatus(slug, 'error', 'Falha ao iniciar: ' + err.message);
            this.bots.delete(slug);
        }

        // Configurar listener de notificações de pedido
        if (!this.pedidoListeners.has(slug)) {
            const clientesMap = new Map();
            const entry = { client, slug };
            this.bots.forEach((v, k) => clientesMap.set(k, v));

            const listener = { ref: null, callback: null };
            const cb = (snap) => {
                const pedido = snap.val();
                if (!pedido || !pedido.status) return;

                let destino = pedido.clienteChat;
                if (!destino && pedido.cliente) destino = pedido.cliente + '@c.us';
                if (!destino) return;

                const botEntry = this.bots.get(slug);
                if (!botEntry || !botEntry.client) return;

                (async () => {
                    try {
                        if (pedido.status === 'En Cocina') {
                            await new Promise(r => setTimeout(r, 2000));
                            await botEntry.client.sendMessage(destino,
                                `👨‍🍳 *TEU PEDIDO ESTÁ SENDO PREPARADO!*\n\n` +
                                `Já entrou na cozinha. Tempo estimado: *25 a 40 min*.\n` +
                                `Te avisamos quando sair! 🔥`);
                            console.log('✅ Notificado: Em Preparo →', pedido.cliente);
                        }
                        if (pedido.status === 'Finalizado') {
                            await new Promise(r => setTimeout(r, 2000));
                            const delivery = pedido.entrega === 'Delivery';
                            await botEntry.client.sendMessage(destino,
                                `✅ *TEU PEDIDO ESTÁ PRONTO!*\n\n` +
                                (delivery
                                    ? `🛵 O entregador já está saindo pra entrega!`
                                    : `🏪 Já pode passar pra retirar!`) +
                                `\n\n⭐ *Obrigado por pedir no Aceguá Byte!*`);
                            console.log('✅ Notificado: Finalizado →', pedido.cliente);
                        }
                    } catch (e) {
                        console.error('❌ Erro notificação:', e.message);
                    }
                })();
            };
            listener.ref = this.db.ref('restaurants/' + slug + '/pedidos');
            listener.ref.on('child_changed', cb);
            listener.callback = cb;
            this.pedidoListeners.set(slug, listener);
        }
    }

    async stop(slug) {
        const bot = this.bots.get(slug);
        if (bot && bot.client) {
            try {
                await bot.client.destroy();
            } catch (e) {
                console.error(`❌ Erro ao destruir cliente ${slug}:`, e.message);
            }
        }
        this.bots.delete(slug);

        // Remover listener de pedidos se existir
        const listener = this.pedidoListeners.get(slug);
        if (listener && listener.ref && listener.callback) {
            listener.ref.off('child_changed', listener.callback);
            this.pedidoListeners.delete(slug);
        }

        this.emitStatus(slug, 'disconnected', 'Desconectado');
    }

    getStatus(slug) {
        const bot = this.bots.get(slug);
        if (!bot) return { status: 'disconnected', info: 'Não conectado' };
        return { status: bot.status, info: bot.numero || '', numero: bot.numero || '' };
    }

    emitStatus(slug, status, info, numero) {
        this.io.to(slug).emit('whatsapp:status', { slug, status, info, numero: numero || '' });
    }

    async stopAll() {
        for (const slug of this.bots.keys()) {
            await this.stop(slug);
        }
    }
}

module.exports = BotManager;
