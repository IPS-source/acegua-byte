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

function resumoItens(itens) {
    if (!itens || !itens.length) return { texto: '🛒 *Carrinho vazio*', total: 0 };
    let total = 0;
    let r = '🛒 *SEU PEDIDO*\n\n';
    itens.forEach((item, i) => {
        r += `${i + 1}. ${item.nome} — R$ ${formatMoney(item.preco)}\n`;
        total += item.preco;
    });
    r += `\n💰 *Total: R$ ${formatMoney(total)}*`;
    return { texto: r, total };
}

function menuCategorias(cardapioCache) {
    const cats = (cardapioCache && cardapioCache.categorias) || {};
    const keys = Object.keys(cats).sort((a, b) => (cats[a].ordem || 999) - (cats[b].ordem || 999));
    if (!keys.length) return null;
    return '📋 *CARDÁPIO*\n\n' + keys.map((k, i) =>
        `${i + 1}️⃣  ${cats[k].nome}`
    ).join('\n') + '\n\n_Responda com o número da categoria._\n💬 *carrinho* pra ver teu pedido\n❌ *cancelar* pra sair';
}

function menuItens(catKey, cardapioCache) {
    const cat = (cardapioCache && cardapioCache.categorias && cardapioCache.categorias[catKey]);
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

async function salvarCliente(db, slug, chatId, nome) {
    try {
        const id = nomeCliente(chatId);
        await db.ref(`restaurants/${slug}/clientes`).child(id).update({
            ultimaVisita: agora(),
            nome: nome || id,
            chatId: chatId
        });
    } catch (e) { /* silencioso */ }
}

async function clienteHistorico(db, slug, chatId) {
    try {
        const id = nomeCliente(chatId);
        const snap = await db.ref(`restaurants/${slug}/clientes`).child(id).once('value');
        if (!snap.exists()) return { visitas: 0, pedidos: [] };
        return snap.val();
    } catch { return { visitas: 0, pedidos: [] }; }
}

module.exports = {
    formatMoney, nomeCliente, agora, sanitizar,
    resumoItens, menuCategorias, menuItens,
    salvarCliente, clienteHistorico
};
