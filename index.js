const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const fs = require('fs');

// ========== FIREBASE ==========
const serviceAccount = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://ips-source-pedidos-default-rtdb.firebaseio.com/"
});
const db = admin.database();

// ========== CONFIG ==========
const REST_SLUG = process.env.REST_SLUG || '';
const isMulti = !REST_SLUG;
const restPath = isMulti ? null : 'restaurants/' + REST_SLUG;
const pedidosRef = isMulti ? db.ref('pedidos') : db.ref(restPath + '/pedidos');
const cardapioRef = isMulti ? null : db.ref(restPath + '/cardapio');
const clientesRef = isMulti ? db.ref('clientes') : db.ref(restPath + '/clientes');

console.log('=== ACEGUÁ BYTE BOT v2 ===');
console.log('Modo:', isMulti ? 'Multi-restaurante' : 'Restaurante: ' + REST_SLUG);

// ========== WHATSAPP ==========
const client = new Client({
    authStrategy: new LocalAuth({ clientId: REST_SLUG || "aceguabyte-multi" }),
    puppeteer: {
        headless: true,
        args: ['--disable-dev-shm-usage']
    }
});

const sessoes = {};

console.log('=== ACEGUÁ BYTE BOT v2 ===');
console.log('Modo:', isMulti ? 'Multi-restaurante' : 'Restaurante: ' + REST_SLUG);
console.log('Iniciando Puppeteer/Chromium...');

client.on('loading_screen', (percent, msg) => {
    console.log(`🔄 Carregando WhatsApp: ${percent}% — ${msg || ''}`);
});

client.on('qr', (qr) => {
    console.log('\n⚠️  QR CODE GERADO — Escaneie com o WhatsApp!\n');
    qrcode.generate(qr, {small: true});
    console.log('\n⚠️  Escaneie o QR acima com WhatsApp > Menu > WhatsApp Web\n');
});

client.on('authenticated', () => {
    console.log('🔑 Sessão autenticada!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Falha na autenticação:', msg);
});

client.on('ready', () => {
    console.log('✅ BOT CONECTADO! WhatsApp pronto para receber mensagens.');
});

client.on('disconnected', (reason) => {
    console.log('🔌 Desconectado:', reason);
});

// ========== UTILITÁRIOS ==========
function formatMoney(v) {
    return Number(v).toFixed(2).replace('.', ',');
}

function nomeCliente(chatId) {
    return chatId.replace('@c.us', '').replace('@g.us', '');
}

function agora() {
    const d = new Date();
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function sanitizar(texto) {
    return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ========== CARREGAR CARDÁPIO ==========
let cardapioCache = { categorias: {} };

async function carregarCardapio() {
    if (isMulti) return;
    try {
        const snap = await cardapioRef.once('value');
        if (snap.exists()) cardapioCache = snap.val();
        console.log('Cardápio carregado:', Object.keys(cardapioCache.categorias || {}).length, 'categorias');
    } catch (e) {
        console.error('Erro ao carregar cardápio:', e.message);
    }
}

if (!isMulti) {
    carregarCardapio();
    cardapioRef.on('value', snap => {
        if (snap.exists()) cardapioCache = snap.val();
    });
}

// ========== MONTAR MENU ==========
function menuCategorias() {
    const cats = cardapioCache.categorias || {};
    const keys = Object.keys(cats).sort((a, b) => (cats[a].ordem || 999) - (cats[b].ordem || 999));
    if (!keys.length) return null;
    return '📋 *CARDÁPIO*\n\n' + keys.map((k, i) =>
        `${i + 1}️⃣  ${cats[k].nome}`
    ).join('\n') + '\n\n_Responda com o número da categoria._\n💬 *carrinho* pra ver teu pedido\n❌ *cancelar* pra sair';
}

function menuItens(catKey) {
    const cat = cardapioCache.categorias[catKey];
    if (!cat) return null;
    const itens = cat.itens || {};
    const keys = Object.keys(itens);
    if (!keys.length) return '⚠️ Essa categoria está vazia.';
    let menu = `🍽️ *${cat.nome}*\n\n`;
    keys.forEach((k, i) => {
        const item = itens[k];
        menu += `${i + 1}. ${item.nome} — *R$ ${formatMoney(item.preco)}*\n`;
        if (item.desc) menu += `   ${item.desc}\n`;
    });
    menu += '\n_Responda com o número do item para adicionar._\n📋 *menu* pra voltar  |  ✅ *finalizar* pra fechar pedido';
    return menu;
}

function resumoItens(itens) {
    if (!itens || !itens.length) return '🛒 *Carrinho vazio*';
    let total = 0;
    let r = '🛒 *SEU PEDIDO*\n\n';
    itens.forEach((item, i) => {
        r += `${i + 1}. ${item.nome} — R$ ${formatMoney(item.preco)}\n`;
        total += item.preco;
    });
    r += `\n💰 *Total: R$ ${formatMoney(total)}*`;
    return { texto: r, total };
}

async function salvarCliente(chatId, nome) {
    try {
        const id = nomeCliente(chatId);
        await clientesRef.child(id).update({
            ultimaVisita: agora(),
            nome: nome || id,
            chatId: chatId
        });
    } catch (e) { /* silencioso */ }
}

async function clienteHistorico(chatId) {
    try {
        const id = nomeCliente(chatId);
        const snap = await clientesRef.child(id).once('value');
        if (!snap.exists()) return { visitas: 0, pedidos: [] };
        return snap.val();
    } catch { return { visitas: 0, pedidos: [] }; }
}

// ========== DETECTAR PEDIDO DO CARDÁPIO WEB ==========
async function processarPedidoCardapio(texto, chatId) {
    // O cardápio envia: ⚡ *NOVO PEDIDO*📍 Nome🍽️ slug...itens...💰 *Total: R$ XX*
    const slugMatch = texto.match(/🍽️\s*([a-zA-Z0-9-]+)/);
    const slug = slugMatch ? slugMatch[1] : null;

    if (!slug) return false;

    // Extrair itens e total
    const itemRegex = /\d+\.\s*([^—]+)—\s*R\$\s*([0-9,]+)/g;
    const itens = [];
    let match;
    while ((match = itemRegex.exec(texto)) !== null) {
        itens.push({ nome: match[1].trim(), preco: parseFloat(match[2].replace(',', '.')) });
    }

    const totalMatch = texto.match(/Total:\s*R\$\s*([0-9,]+)/);
    const total = totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : 0;

    // Salvar no restaurante correto
    const ref = db.ref('restaurants/' + slug + '/pedidos');
    const pedidoId = ref.push().key;
    const clienteNome = nomeCliente(chatId);

    const novoPedido = {
        clienteChat: chatId,
        cliente: clienteNome,
        contenido: texto,
        total: total,
        itens: itens,
        fecha: agora(),
        status: "Pendiente",
        entrega: "Pendiente",
        pago: "Pendiente",
        troco: "Pendiente",
        pedidoId: pedidoId,
        origem: "cardapio_web",
        restaurante: slug
    };

    await ref.child(pedidoId).set(novoPedido);
    console.log(`✅ Pedido WEB #${pedidoId.slice(-6)} → ${slug} — R$ ${formatMoney(total)}`);

    await client.sendMessage(chatId,
        `✅ *PEDIDO RECEBIDO!*\n\n` +
        `🎉 Teu pedido foi enviado para *${slug}*!\n` +
        `👨‍🍳 Avisamos quando estiver pronto.\n\n` +
        `📌 *Nº do pedido:* #${pedidoId.slice(-6)}\n\n` +
        `📋 *menu* pra ver o cardápio\n📋 *meus pedidos* pra histórico`);

    // Salvar no histórico do cliente
    try {
        const clienteId = nomeCliente(chatId);
        await db.ref('restaurants/' + slug + '/clientes').child(clienteId).child('pedidos').push({
            id: pedidoId, total, fecha: agora(), status: 'Pendiente'
        });
        await db.ref('restaurants/' + slug + '/clientes').child(clienteId).update({
            ultimaVisita: agora(), visitas: admin.database.ServerValue.increment(1), chatId
        });
    } catch (e) { /* silencioso */ }

    return true;
}

// ========== OUVIR PEDIDOS DO CARDÁPIO EM MODO CENTRAL ==========
async function ouvirCardapioPedidos() {
    // Escuta todos os restaurantes por novos pedidos com origem = cardapio_web
    // Esse listener é só uma garantia extra, o principal é o fluxo acima
}

// ========== FLUXO PRINCIPAL ==========
client.on('message_create', async (msg) => {
    try {
        if (msg.fromMe) return;

        const texto = msg.body.trim();
        const chatId = msg.from;
        const s = sessoes[chatId];

        console.log(`📢 ${nomeCliente(chatId)}: "${texto.substring(0, 120)}"`);
        console.log(`   FromMe: ${msg.fromMe} | HasMedia: ${msg.hasMedia} | Type: ${msg.type}`);

        // PRIORIDADE 1: Pedido vindo do cardápio web
        // Detecta por: "NOVO PEDIDO" + padrão de slug (palavra com hífen)
        const slugPattern = texto.match(/🍽️\s*([a-zA-Z0-9-]+)/) || texto.match(/slug:\s*([a-zA-Z0-9-]+)/i);
        if (texto.includes('NOVO PEDIDO') && slugPattern) {
            const slug = slugPattern[1];
            console.log(`📦 Pedido WEB detectado para slug: "${slug}"`);
            const processado = await processarPedidoCardapio(texto, chatId);
            if (processado) {
                console.log(`✅ Pedido WEB processado com sucesso para ${slug}`);
                return;
            } else {
                console.log(`⚠️ Falha ao processar pedido WEB para ${slug}, caindo no fluxo normal`);
            }
        }

        // PRIORIDADE 2: Comandos globais
        const st = sanitizar(texto);
        if (['cancelar', 'sair', 'menu principal', 'inicio'].includes(st)) {
            if (s) delete sessoes[chatId];
            await client.sendMessage(chatId, '✅ Pedido cancelado. Quando quiser, é só chamar!');
            return;
        }
        if (['carrinho', 'meu pedido', 'resumo'].includes(st)) {
            if (s && s.itens && s.itens.length) {
                const r = resumoItens(s.itens);
                await client.sendMessage(chatId, r.texto + '\n\n📋 *menu* pra continuar  |  ✅ *finalizar* pra fechar');
            } else {
                await client.sendMessage(chatId, '🛒 Teu carrinho está vazio.');
            }
            return;
        }
        if (['quanto tempo', 'estimativa', 'demora'].includes(st)) {
            await client.sendMessage(chatId, '👨‍🍳 O tempo médio de preparo é de *25 a 40 minutos*. Se já pediu, avisamos quando estiver pronto!');
            return;
        }

        // PRIORIDADE 3: Modo multi (central) — sem menu interativo
        if (isMulti) {
            console.log(`🗣️ Modo central: "${texto.substring(0, 50)}..."`);
            if (st.includes('meus pedidos') || st.includes('historico') || st.includes('histórico')) {
                await client.sendMessage(chatId, '📭 Para ver teus pedidos, acesse o cardápio do restaurante.');
            } else if (texto.length > 2) {
                await client.sendMessage(chatId,
                    `⚡ *Aceguá Byte — Central de Pedidos*\n\n` +
                    `📱 Teu pedido foi enviado pelo cardápio digital!\n` +
                    `📋 Envia *menu* pro cardápio do restaurante`);
            }
            return;
        }

        // PRIORIDADE 4: Modo restaurante único — menu interativo
        if (!s) {
            const hist = await clienteHistorico(chatId);
            const ehConhecido = hist.visitas > 0;

            if (['ola', 'oi', 'olá', 'menu', 'cardapio', 'iniciar', 'bom dia', 'boa tarde', 'boa noite', 'oie', 'começar'].includes(st)) {
                const menu = menuCategorias();
                if (!menu) {
                    await client.sendMessage(chatId, `⚠️ Cardápio não configurado. Acesse: https://joinside.quest/cardapio/${REST_SLUG}`);
                    return;
                }
                const welcome = ehConhecido ? `🌟 *Bem-vindo de volta!*` : `⚡ *Bem-vindo ao Aceguá Byte!*`;
                await client.sendMessage(chatId, welcome + '\n\n' + menu);
                sessoes[chatId] = { etapa: 'categoria', itens: [], catKey: null };
                await salvarCliente(chatId, msg._data?.notifyName || '');
                return;
            }

            if (['pedido', 'quero pedir', 'fazer pedido'].includes(st)) {
                const menu = menuCategorias();
                if (!menu) {
                    await client.sendMessage(chatId, `⚠️ Cardápio indisponível. Use: https://joinside.quest/cardapio/${REST_SLUG}`);
                    return;
                }
                await client.sendMessage(chatId, '🎉 Vamos começar!\n\n' + menu);
                sessoes[chatId] = { etapa: 'categoria', itens: [], catKey: null };
                return;
            }

            if (st.includes('meus pedidos') || st.includes('historico') || st.includes('histórico')) {
                const hist = await clienteHistorico(chatId);
                const pedidos = hist.pedidos || [];
                if (!pedidos.length) {
                    await client.sendMessage(chatId, '📭 Nenhum pedido anterior.');
                } else {
                    const ultimos = pedidos.slice(-5).reverse();
                    let r = '📋 *TEUS ÚLTIMOS PEDIDOS*\n\n';
                    ultimos.forEach(p => { r += `#${(p.id||'').slice(-6)} — ${p.fecha||''} — ${p.status||''}\n`; });
                    await client.sendMessage(chatId, r);
                }
                return;
            }

            // Fallback: responde qualquer coisa com +3 chars
            if (texto.length > 2) {
                await client.sendMessage(chatId,
                    `⚡ *Aceguá Byte*\n\n` +
                    `📋 *menu* — Ver cardápio\n` +
                    `🛒 *pedido* — Fazer pedido\n` +
                    `📋 *meus pedidos* — Histórico`);
            }
            return;
        }

        // ========== FLUXO DE SESSÃO ==========
        if (s.etapa === 'categoria') {
            const cats = cardapioCache.categorias || {};
            const keys = Object.keys(cats).sort((a, b) => (cats[a].ordem || 999) - (cats[b].ordem || 999));
            const num = parseInt(texto);
            if (num >= 1 && num <= keys.length) {
                s.catKey = keys[num - 1];
                s.etapa = 'item';
                await client.sendMessage(chatId, menuItens(s.catKey));
            } else if (st === 'menu') {
                await client.sendMessage(chatId, menuCategorias());
            } else {
                await client.sendMessage(chatId, `⚠️ Escolha um número entre 1 e ${keys.length}, ou *menu* pra ver as categorias.`);
            }
            return;
        }

        if (s.etapa === 'item') {
        const cat = cardapioCache.categorias[s.catKey];
        if (!cat) { delete sessoes[chatId]; return; }
        const itens = cat.itens || {};
        const keys = Object.keys(itens);
        const num = parseInt(texto);

        if (num >= 1 && num <= keys.length) {
            const item = itens[keys[num - 1]];
            s.itens.push({ nome: item.nome, preco: item.preco, desc: item.desc || '' });
            const r = resumoItens(s.itens);
            await client.sendMessage(chatId,
                `✅ *${item.nome}* adicionado! (R$ ${formatMoney(item.preco)})\n\n${r.texto}\n\n📋 *menu* pra + itens  |  🗑️ *remover* (n°)  |  ✅ *finalizar*`);
        } else if (st === 'menu') {
            s.etapa = 'categoria';
            const menu = menuCategorias();
            await client.sendMessage(chatId, menu);
        } else if (st === 'finalizar' || st === 'fechar' || st === 'confirmar') {
            if (!s.itens.length) {
                await client.sendMessage(chatId, '⚠️ Teu carrinho está vazio! Adicione itens primeiro.');
                return;
            }
            s.etapa = 'entrega';
            await client.sendMessage(chatId,
                `📍 *Como quer receber?*\n\n1️⃣ 🛵 *Delivery* (entrego em casa)\n2️⃣ 🏪 *Retirar no Local*\n\n_Responda com 1 ou 2._`);
        } else if (st.startsWith('remover') || st.startsWith('remove')) {
            const partes = texto.split(' ');
            const idx = parseInt(partes[1]) - 1;
            if (idx >= 0 && idx < s.itens.length) {
                const removido = s.itens.splice(idx, 1)[0];
                const r = resumoItens(s.itens);
                await client.sendMessage(chatId, `🗑️ *${removido.nome}* removido.\n\n${r.texto}`);
            } else {
                await client.sendMessage(chatId, `⚠️ Digite *remover N* onde N é o número do item no carrinho.`);
            }
        } else if (st === 'carrinho') {
            const r = resumoItens(s.itens);
            await client.sendMessage(chatId, r.texto + '\n\n📋 *menu* pra + itens  |  ✅ *finalizar*');
        } else {
            await client.sendMessage(chatId, `⚠️ Responda com o número do item, *menu* pra ver categorias, *finalizar* pra fechar pedido, ou *remover N* pra tirar um item.`);
        }
        return;
    }

    // ========== FLUXO: ENTREGA ==========
    if (s.etapa === 'entrega') {
        if (texto === '1' || st.includes('delivery') || st.includes('entrega') || st.includes('casa')) {
            s.entrega = 'Delivery';
            s.etapa = 'endereco';
            await client.sendMessage(chatId, '📍 *Informe teu endereço de entrega:*\n\nRua, número, bairro, referência.');
        } else if (texto === '2' || st.includes('retir') || st.includes('local') || st.includes('buscar')) {
            s.entrega = 'Retirada no Local';
            s.etapa = 'pago';
            await client.sendMessage(chatId,
                `💳 *Forma de pagamento*\n\n1️⃣ 💵 *Efectivo* (dinheiro)\n2️⃣ 💳 *Tarjeta* (débito/crédito)\n3️⃣ 📱 *PIX*\n\n_Responda com 1, 2 ou 3._`);
        } else {
            await client.sendMessage(chatId, '⚠️ Escolha 1️⃣ *Delivery* ou 2️⃣ *Retirar no Local*.');
        }
        return;
    }

    // ========== FLUXO: ENDEREÇO ==========
    if (s.etapa === 'endereco') {
        if (texto.length < 5) {
            await client.sendMessage(chatId, '⚠️ Informe um endereço válido (rua, número, bairro).');
            return;
        }
        s.endereco = texto;
        s.etapa = 'pago';
        await client.sendMessage(chatId,
            `💳 *Forma de pagamento*\n\n1️⃣ 💵 *Efectivo* (dinheiro)\n2️⃣ 💳 *Tarjeta* (débito/crédito)\n3️⃣ 📱 *PIX*\n\n_Responda com 1, 2 ou 3._`);
        return;
    }

    // ========== FLUXO: PAGAMENTO ==========
    if (s.etapa === 'pago') {
        if (texto === '1' || st.includes('efectivo') || st.includes('dinheiro')) {
            s.pago = 'Efectivo';
            s.etapa = 'troco';
            await client.sendMessage(chatId, '💵 *Troco?*\n\n1️⃣ ✅ Sim, preciso de troco\n2️⃣ ❌ Não, tenho o valor exato');
        } else if (texto === '2' || st.includes('tarjeta') || st.includes('cartão') || st.includes('card')) {
            s.pago = 'Tarjeta';
            s.etapa = 'confirmar';
            await mostrarConfirmacao(chatId, s);
        } else if (texto === '3' || st.includes('pix')) {
            s.pago = 'PIX';
            s.etapa = 'pix_aguardando';
            await client.sendMessage(chatId,
                `📱 *PAGAMENTO PIX*\n\nChave Pix:\n🔑 *44884265068*\n\nApós fazer o PIX, envie o *comprovante* ou digite *já paguei* pra confirmar.`);
        } else {
            await client.sendMessage(chatId, '⚠️ Escolha 1️⃣ Efectivo, 2️⃣ Tarjeta ou 3️⃣ PIX.');
        }
        return;
    }

    // ========== FLUXO: TROCO ==========
    if (s.etapa === 'troco') {
        if (texto === '1' || st.includes('sim') || st.includes('s')) {
            s.troco = 'Sim (cliente informará)';
            s.etapa = 'monto_troco';
            await client.sendMessage(chatId, '💬 *Com quanto vai pagar?*\n\nResponda com o valor (ex: 100, 50, 200).');
        } else if (texto === '2' || st.includes('não') || st.includes('nao') || st.includes('exato')) {
            s.troco = 'Não (valor exato)';
            s.etapa = 'confirmar';
            await mostrarConfirmacao(chatId, s);
        } else {
            await client.sendMessage(chatId, '⚠️ Precisa de troco? 1️⃣ Sim ou 2️⃣ Não.');
        }
        return;
    }

    // ========== FLUXO: MONTO DO TROCO ==========
    if (s.etapa === 'monto_troco') {
        const monto = texto.replace(/[^\d]/g, '');
        if (monto && parseInt(monto) > 0) {
            s.troco = `Sim — Paga com $${parseInt(monto)}`;
            s.etapa = 'confirmar';
            await mostrarConfirmacao(chatId, s);
        } else {
            await client.sendMessage(chatId, '⚠️ Informe um valor numérico válido (ex: 100).');
        }
        return;
    }

    // ========== FLUXO: PIX AGUARDANDO ==========
    if (s.etapa === 'pix_aguardando') {
        if (st.includes('paguei') || st.includes('ja paguei') || st.includes('já paguei') || st.includes('feito') || st.includes('pronto')) {
            s.etapa = 'confirmar';
            await mostrarConfirmacao(chatId, s);
        } else {
            // Se enviou imagem (comprovante), aceita
            if (msg.hasMedia) {
                s.etapa = 'confirmar';
                await client.sendMessage(chatId, '✅ Comprovante recebido!');
                await mostrarConfirmacao(chatId, s);
            } else {
                await client.sendMessage(chatId, '📱 Aguardando confirmação do PIX. Envie *já paguei* ou o comprovante.');
            }
        }
        return;
    }

    // ========== FLUXO: CONFIRMAR ==========
    if (s.etapa === 'confirmar') {
        if (st.includes('sim') || st.includes('confirmar') || st.includes('pode') || st.includes('pode ser') || texto === '1') {
            await finalizarPedido(chatId, s);
        } else if (st.includes('nao') || st.includes('não') || st.includes('voltar') || st.includes('corrigir') || texto === '2') {
            s.etapa = 'item';
            await client.sendMessage(chatId, '✏️ *Pedido alterado!* Pode continuar adicionando itens ou digite *finalizar* quando estiver pronto.\n\n📋 *menu* pra ver categorias');
        } else {
            await client.sendMessage(chatId, '⚠️ Digite *1* pra confirmar ou *2* pra alterar o pedido.');
        }
        return;
    }

    } catch (e) {
        console.error('❌ ERRO no message_create:', e.message);
        console.error(e.stack);
        try { await client.sendMessage(chatId, '❌ Ocorreu um erro. Tente novamente.'); } catch (_) {}
    }
});

// ========== MOSTRAR CONFIRMAÇÃO ==========
async function mostrarConfirmacao(chatId, s) {
    const r = resumoItens(s.itens);
    let msg = `📋 *CONFIRMAR PEDIDO*\n\n${r.texto}\n`;
    msg += `\n🚚 *Entrega:* ${s.entrega}`;
    if (s.endereco) msg += `\n📍 *Endereço:* ${s.endereco}`;
    msg += `\n💳 *Pagamento:* ${s.pago}`;
    if (s.troco) msg += `\n💵 *Troco:* ${s.troco}`;
    msg += `\n\n1️⃣ ✅ *Confirmar pedido*\n2️⃣ ✏️ *Alterar pedido*`;
    await client.sendMessage(chatId, msg);
}

// ========== FINALIZAR PEDIDO ==========
async function finalizarPedido(chatId, s) {
    try {
        const r = resumoItens(s.itens);
        const pedidoId = pedidosRef.push().key;

        const conteudo = s.itens.map((item, i) =>
            `${i+1}. ${item.nome} — R$ ${formatMoney(item.preco)}`
        ).join('\n');

        const novoPedido = {
            clienteChat: chatId,
            cliente: nomeCliente(chatId),
            contenido: conteudo,
            total: r.total,
            fecha: agora(),
            status: "Pendiente",
            entrega: s.entrega || 'Pendiente',
            endereco: s.endereco || '',
            pago: s.pago || 'Pendiente',
            troco: s.troco || 'Pendiente',
            pedidoId: pedidoId,
            restaurante: REST_SLUG || 'geral',
            itens: s.itens
        };

        await pedidosRef.child(pedidoId).set(novoPedido);

        // Salvar no histórico do cliente
        const clienteId = nomeCliente(chatId);
        if (!isMulti) {
            await clientesRef.child(clienteId).child('pedidos').push({
                id: pedidoId,
                total: r.total,
                fecha: agora(),
                status: 'Pendiente'
            });
            await clientesRef.child(clienteId).update({ ultimaVisita: agora(), visitas: admin.database.ServerValue.increment(1) });
        }

        await client.sendMessage(chatId,
            `✅ *PEDIDO CONFIRMADO!*\n\n` +
            `🎉 Teu pedido já entrou na fila.\n` +
            `👨‍🍳 Avisamos quando estiver pronto!\n\n` +
            `📋 *Resumo:*\n${conteudo}\n\n💰 *Total: R$ ${formatMoney(r.total)}*\n🚚 ${s.entrega}\n💳 ${s.pago}\n\n📌 *Nº do pedido:* #${pedidoId.slice(-6)}\n\n⚡ *Aceguá Byte — Obrigado!*`);

        console.log(`✅ Pedido #${pedidoId.slice(-6)} — ${s.entrega} — ${s.pago} — R$ ${formatMoney(r.total)}`);
        delete sessoes[chatId];

    } catch (e) {
        console.error('❌ Erro ao salvar pedido:', e.message);
        await client.sendMessage(chatId, '❌ Ocorreu um erro ao processar teu pedido. Tente novamente.');
    }
}

// ========== OUVIR MUDANÇAS DE STATUS ==========
function ouvirPedidos(ref) {
    ref.on('child_changed', async (snap) => {
        const pedido = snap.val();
        if (!pedido || !pedido.status) return;

        let destino = pedido.clienteChat;
        if (!destino && pedido.cliente) destino = pedido.cliente + '@c.us';
        if (!destino) return;

        try {
            if (pedido.status === 'En Cocina') {
                await new Promise(r => setTimeout(r, 2000));
                await client.sendMessage(destino,
                    `👨‍🍳 *TEU PEDIDO ESTÁ SENDO PREPARADO!*\n\n` +
                    `Já entrou na cozinha. Tempo estimado: *25 a 40 min*.\n` +
                    `Te avisamos quando sair! 🔥`);
                console.log('✅ Notificado: Em Preparo →', pedido.cliente);
            }

            if (pedido.status === 'Finalizado') {
                await new Promise(r => setTimeout(r, 2000));
                const delivery = pedido.entrega === 'Delivery';
                await client.sendMessage(destino,
                    `✅ *TEU PEDIDO ESTÁ PRONTO!*\n\n` +
                    (delivery
                        ? `🛵 O repórter já está saindo pra entrega!`
                        : `🏪 Já pode passar pra retirar!`) +
                    `\n\n⭐ *Obrigado por pedir no Aceguá Byte!*`);
                console.log('✅ Notificado: Finalizado →', pedido.cliente);
            }
        } catch (e) {
            console.error('❌ Erro notificação:', e.message);
        }
    });
}

// ========== INICIAR LISTENERS ==========
if (isMulti) {
    db.ref('restaurants').once('value').then(snap => {
        if (snap.exists()) {
            snap.forEach(child => {
                ouvirPedidos(db.ref('restaurants/' + child.key + '/pedidos'));
            });
        }
    });
    ouvirPedidos(db.ref('pedidos'));
} else {
    ouvirPedidos(pedidosRef);
}

process.on('unhandledRejection', (reason) => {
    console.error('❌ Erro não tratado:', reason?.message || reason);
    if (reason?.message?.includes('browser is already running')) {
        console.log('   💡 Dica: Remova a pasta .wwebjs_auth e tente novamente');
    }
});

client.initialize().catch(err => {
    console.error('❌ Falha ao iniciar WhatsApp:', err.message);
    console.log('   Possíveis causas:');
    console.log('   1. Chromium não encontrado — rode: npx puppeteer install');
    console.log('   2. Sessão corrompida — delete a pasta .wwebjs_auth');
    console.log('   3. Outro processo do node rodando — mate com: taskkill /F /IM node.exe');
});
