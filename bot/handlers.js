const { formatMoney, nomeCliente, agora, sanitizar, resumoItens, menuCategorias, menuItens, salvarCliente, clienteHistorico, obterNomeContato } = require('./utils');
const admin = require('firebase-admin');

async function processarPedidoCardapio(texto, chatId, ctx) {
    const { client, db, slug } = ctx;
    const itemRegex = /\d+\.\s*([^—]+)—\s*R\$\s*([0-9,]+)/g;
    const itens = [];
    let match;
    while ((match = itemRegex.exec(texto)) !== null) {
        itens.push({ nome: match[1].trim(), preco: parseFloat(match[2].replace(',', '.')) });
    }

    const totalMatch = texto.match(/Total:\s*R\$\s*([0-9,]+)/);
    const total = totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : 0;

    // Extrair entrega (Delivery ou Retirada)
    let entrega = 'Pendiente';
    if (texto.includes('*Delivery*')) entrega = 'Delivery';
    else if (texto.includes('*Retirar no Local*')) entrega = 'Retirada no Local';

    // Extrair endereço (linha após o ícone de entrega)
    let endereco = '';
    const addrMatch = texto.match(/📍\s*(.+?)(?:\n|$)/g);
    if (addrMatch) {
        // Última linha com 📍 é o endereço do cliente (não do restaurante)
        const addrLines = addrMatch.filter(l => !l.includes('NOVO PEDIDO'));
        if (addrLines.length > 0) {
            const lastAddr = addrLines[addrLines.length - 1];
            endereco = lastAddr.replace(/📍\s*/, '').trim();
        }
    }

    // Extrair pagamento
    let pago = 'Pendiente';
    if (texto.includes('*Efectivo*')) pago = 'Efectivo';
    else if (texto.includes('*Tarjeta*')) pago = 'Tarjeta';
    else if (texto.includes('*PIX*')) pago = 'PIX';

    // Extrair troco
    let troco = 'Pendiente';
    const trocoMatch = texto.match(/Troco pra R\$\s*(\d+)/);
    if (trocoMatch) troco = 'Sim — Paga com R$' + trocoMatch[1];

    const ref = db.ref('restaurants/' + slug + '/pedidos');
    const pedidoId = ref.push().key;
    const clienteNome = await obterNomeContato(client, chatId);

    const novoPedido = {
        clienteChat: chatId,
        cliente: clienteNome,
        contenido: texto,
        total: total,
        itens: itens,
        fecha: agora(),
        status: "Pendiente",
        entrega: entrega,
        endereco: endereco,
        pago: pago,
        troco: troco,
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

async function mostrarConfirmacao(chatId, s, ctx) {
    const { client } = ctx;
    const r = resumoItens(s.itens);
    let msg = `📋 *CONFIRMAR PEDIDO*\n\n${r.texto}\n`;
    msg += `\n🚚 *Entrega:* ${s.entrega}`;
    if (s.endereco) msg += `\n📍 *Endereço:* ${s.endereco}`;
    msg += `\n💳 *Pagamento:* ${s.pago}`;
    if (s.troco) msg += `\n💵 *Troco:* ${s.troco}`;
    msg += `\n\n1️⃣ ✅ *Confirmar pedido*\n2️⃣ ✏️ *Alterar pedido*`;
    await client.sendMessage(chatId, msg);
}

async function finalizarPedido(chatId, s, ctx) {
    const { client, db, slug, sessoes } = ctx;
    try {
        const r = resumoItens(s.itens);
        const pedidosRef = db.ref('restaurants/' + slug + '/pedidos');
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
            restaurante: slug,
            itens: s.itens
        };

        await pedidosRef.child(pedidoId).set(novoPedido);

        const clienteId = nomeCliente(chatId);
        await db.ref('restaurants/' + slug + '/clientes').child(clienteId).child('pedidos').push({
            id: pedidoId, total: r.total, fecha: agora(), status: 'Pendiente'
        });
        await db.ref('restaurants/' + slug + '/clientes').child(clienteId).update({
            ultimaVisita: agora(), visitas: admin.database.ServerValue.increment(1)
        });

        await client.sendMessage(chatId,
            `✅ *PEDIDO CONFIRMADO!*\n\n` +
            `🎉 Teu pedido já entrou na fila.\n` +
            `👨‍🍳 Avisamos quando estiver pronto!\n\n` +
            `📋 *Resumo:*\n${conteudo}\n\n💰 *Total: R$ ${formatMoney(r.total)}*\n🚚 ${s.entrega}\n💳 ${s.pago}\n\n📌 *Nº do pedido:* #${pedidoId.slice(-6)}\n\n⚡ *Aceguá Byte — Obrigado!*`);

        console.log(`✅ Pedido #${pedidoId.slice(-6)} — ${s.entrega} — ${s.pago} — R$ ${formatMoney(r.total)}`);

        if (s.timeout) clearTimeout(s.timeout);
        delete sessoes[chatId];
    } catch (e) {
        console.error('❌ Erro ao salvar pedido:', e.message);
        await client.sendMessage(chatId, '❌ Ocorreu um erro ao processar teu pedido. Tente novamente.');
    }
}

async function handleMessage(msg, ctx) {
    const { client, db, slug, sessoes, cardapioCache } = ctx;
    console.log(`🔄 [${slug}] handleMessage chamado: from=${msg.from} body="${(msg.body||'').substring(0,60)}"`);

    if (msg.fromMe) return;

    const chatId = msg.from;
    const texto = (msg.body || '').trim();

    // Midia (audio, video, image) — cliente nao pode digitar
    if (msg.type === 'ptt' || msg.type === 'audio' || (msg.hasMedia && !texto.trim())) {
        const clienteNome = msg._data?.notifyName || nomeCliente(chatId);
        await client.sendMessage(chatId,
            '📵 *Atendimento Humano*\n\n' +
            'Você enviou um áudio, mas sou um robô e não entendo áudios.\n\n' +
            '🔔 Um atendente humano foi avisado e vai falar com você em breve!\n\n' +
            'Se preferir, pode *digitar* sua mensagem que eu entendo.');
        await db.ref('restaurants/' + slug + '/assistencias').push({
            cliente: clienteNome,
            chatId: chatId,
            tipo: msg.type || 'midia',
            timestamp: agora(),
            status: 'pendente'
        });
        console.log(`🔔 [${slug}] Atendimento humano solicitado por ${clienteNome} (${chatId})`);
        return;
    }
    const s = sessoes[chatId];
    const st = sanitizar(texto);

    console.log(`📢 [${slug}] ${nomeCliente(chatId)}: "${texto.substring(0, 120)}"`);

    // PRIORIDADE 1: Pedido vindo do cardápio web
    const slugPattern = texto.match(/slug:\s*([a-zA-Z0-9-]+)/i) || texto.match(/🍽️\s*([a-zA-Z0-9-]+)/);
    if (texto.includes('NOVO PEDIDO') && slugPattern) {
        const orderSlug = slugPattern[1];
        console.log(`📦 Pedido WEB detectado para slug: "${orderSlug}"`);
        const processado = await processarPedidoCardapio(texto, chatId, ctx);
        if (processado) {
            console.log(`✅ Pedido WEB processado com sucesso para ${orderSlug}`);
            return;
        }
    }

    // PRIORIDADE 2: Comandos globais (funcionam sem sessão)
    if (['cancelar', 'sair', 'menu principal', 'inicio'].includes(st)) {
        if (s) {
            if (s.timeout) clearTimeout(s.timeout);
            delete sessoes[chatId];
        }
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

    // PRIORIDADE 3: Iniciar sessão ou comandos sem sessão
    if (!s) {
        const hist = await clienteHistorico(db, slug, chatId);
        const ehConhecido = hist.visitas > 0;

        if (['ola', 'oi', 'olá', 'menu', 'cardapio', 'iniciar', 'bom dia', 'boa tarde', 'boa noite', 'oie', 'começar'].includes(st)) {
            // Construir link do cardápio digital
            let cardapioUrl = null;
            try {
                const restSnap = await db.ref('restaurants/' + slug).once('value');
                if (restSnap.exists()) {
                    cardapioUrl = restSnap.val().cardapioUrl || null;
                }
            } catch (e) { /* silencioso */ }
            if (!cardapioUrl && ctx.baseUrl) {
                cardapioUrl = ctx.baseUrl + '/cardapio/' + slug;
            }

            const welcome = ehConhecido ? `🌟 *Bem-vindo de volta!*` : `⚡ *Bem-vindo ao Aceguá Byte!*`;
            const link = cardapioUrl || 'https://joinside.quest/cardapio/' + slug;

            await client.sendMessage(chatId,
                `${welcome}\n\n📱 *Acesse o cardápio digital clicando no link abaixo:* 👇`);
            await client.sendMessage(chatId, link);
            await client.sendMessage(chatId,
                `📋 *pedido* — Fazer pedido pelo chat\n` +
                `📋 *meus pedidos* — Histórico\n` +
                `❌ *cancelar* — Sair`);
            await salvarCliente(db, slug, chatId, msg._data?.notifyName || '');
            return;
        }

        if (['pedido', 'quero pedir', 'fazer pedido'].includes(st)) {
            const menu = menuCategorias(cardapioCache);
            if (!menu) {
                await client.sendMessage(chatId, `⚠️ Cardápio indisponível.`);
                return;
            }
            await client.sendMessage(chatId, '🎉 Vamos começar!\n\n' + menu);
            sessoes[chatId] = { etapa: 'categoria', itens: [], catKey: null };
            return;
        }

        if (st.includes('meus pedidos') || st.includes('historico') || st.includes('histórico')) {
            const hist = await clienteHistorico(db, slug, chatId);
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

        // Fallback: ajuda com comandos disponíveis
        if (texto.length > 2) {
            let cardapioUrl = null;
            try {
                const restSnap = await db.ref('restaurants/' + slug).once('value');
                if (restSnap.exists()) {
                    cardapioUrl = restSnap.val().cardapioUrl || null;
                }
            } catch (e) { /* silencioso */ }
            if (!cardapioUrl && ctx.baseUrl) {
                cardapioUrl = ctx.baseUrl + '/cardapio/' + slug;
            }

            let msg = '⚡ *Aceguá Byte*\n\n';
            msg += `📱 *Cardápio Digital:*\n${cardapioUrl || 'https://joinside.quest/cardapio/' + slug}\n\n`;
            msg += `📋 *menu* — Ver cardápio\n` +
                   `🛒 *pedido* — Fazer pedido\n` +
                   `📋 *meus pedidos* — Histórico\n` +
                   `❌ *cancelar* — Sair`;
            await client.sendMessage(chatId, msg);
        }
        return;
    }

    // ========== FLUXO DE SESSÃO ==========
    if (s.etapa === 'categoria') {
        const cats = (cardapioCache && cardapioCache.categorias) || {};
        const keys = Object.keys(cats).sort((a, b) => (cats[a].ordem || 999) - (cats[b].ordem || 999));
        const num = parseInt(texto);
        if (num >= 1 && num <= keys.length) {
            s.catKey = keys[num - 1];
            s.etapa = 'item';
            await client.sendMessage(chatId, menuItens(s.catKey, cardapioCache));
        } else if (st === 'menu') {
            await client.sendMessage(chatId, menuCategorias(cardapioCache));
        } else {
            await client.sendMessage(chatId, `⚠️ Escolha um número entre 1 e ${keys.length}, ou *menu* pra ver as categorias.`);
        }
        return;
    }

    if (s.etapa === 'item') {
        const cat = (cardapioCache && cardapioCache.categorias && cardapioCache.categorias[s.catKey]);
        if (!cat) { delete sessoes[chatId]; return; }
        const itens = cat.itens || {};
        const keys = Object.keys(itens);
        const num = parseInt(texto);

        if (num >= 1 && num <= keys.length) {
            const item = itens[keys[num - 1]];
            s.itens.push({ nome: item.nome, preco: item.preco, desc: item.desc || '' });
            const r = resumoItens(s.itens);
            await client.sendMessage(chatId,
                `✅ *${item.nome}* adicionado! (R$ ${formatMoney(item.preco)})\n\n${r.texto}\n\n📋 *menu* pra + itens  |  🗑️ *remover N*  |  ✅ *finalizar*`);
        } else if (st === 'menu') {
            s.etapa = 'categoria';
            await client.sendMessage(chatId, menuCategorias(cardapioCache));
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
            await mostrarConfirmacao(chatId, s, ctx);
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
            await mostrarConfirmacao(chatId, s, ctx);
        } else {
            await client.sendMessage(chatId, '⚠️ Precisa de troco? 1️⃣ Sim ou 2️⃣ Não.');
        }
        return;
    }

    // ========== FLUXO: MONTO DO TROCO ==========
    if (s.etapa === 'monto_troco') {
        const monto = texto.replace(/[^\d]/g, '');
        if (monto && parseInt(monto) > 0) {
            s.troco = `Sim — Paga com R$${parseInt(monto)}`;
            s.etapa = 'confirmar';
            await mostrarConfirmacao(chatId, s, ctx);
        } else {
            await client.sendMessage(chatId, '⚠️ Informe um valor numérico válido (ex: 100).');
        }
        return;
    }

    // ========== FLUXO: PIX AGUARDANDO ==========
    if (s.etapa === 'pix_aguardando') {
        if (st.includes('paguei') || st.includes('ja paguei') || st.includes('já paguei') || st.includes('feito') || st.includes('pronto')) {
            s.etapa = 'confirmar';
            await mostrarConfirmacao(chatId, s, ctx);
        } else {
            if (msg.hasMedia) {
                s.etapa = 'confirmar';
                await client.sendMessage(chatId, '✅ Comprovante recebido!');
                await mostrarConfirmacao(chatId, s, ctx);
            } else {
                await client.sendMessage(chatId, '📱 Aguardando confirmação do PIX. Envie *já paguei* ou o comprovante.');
            }
        }
        return;
    }

    // ========== FLUXO: CONFIRMAR ==========
    if (s.etapa === 'confirmar') {
        if (st.includes('sim') || st.includes('confirmar') || st.includes('pode') || st.includes('pode ser') || texto === '1') {
            await finalizarPedido(chatId, s, ctx);
        } else if (st.includes('nao') || st.includes('não') || st.includes('voltar') || st.includes('corrigir') || texto === '2') {
            s.etapa = 'item';
            await client.sendMessage(chatId, '✏️ *Pedido alterado!* Pode continuar adicionando itens ou digite *finalizar* quando estiver pronto.\n\n📋 *menu* pra ver categorias');
        } else {
            await client.sendMessage(chatId, '⚠️ Digite *1* pra confirmar ou *2* pra alterar o pedido.');
        }
        return;
    }
}

function setupPedidoListener(db, slug, clientesMap) {
    const pedidosRef = db.ref('restaurants/' + slug + '/pedidos');
    pedidosRef.on('child_changed', async (snap) => {
        const pedido = snap.val();
        if (!pedido || !pedido.status) return;

        let destino = pedido.clienteChat;
        if (!destino && pedido.cliente) destino = pedido.cliente + '@c.us';
        if (!destino) return;

        const botEntry = clientesMap.get(slug);
        if (!botEntry || !botEntry.client) return;
        const client = botEntry.client;

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

module.exports = {
    handleMessage,
    setupPedidoListener,
    processarPedidoCardapio,
    mostrarConfirmacao,
    finalizarPedido
};
