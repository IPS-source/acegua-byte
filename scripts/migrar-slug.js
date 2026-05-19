const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync("./serviceAccountKey.json", "utf8"));
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://ips-source-pedidos-default-rtdb.firebaseio.com/"
});
const db = admin.database();

const OLD_SLUG = 'https-ips-source-github-io-meu-cardapio-digital';
const NEW_SLUG = 'tita-tanches';

async function migrate() {
    console.log(`📦 Migrando ${OLD_SLUG} → ${NEW_SLUG}...`);

    const snap = await db.ref('restaurants/' + OLD_SLUG).once('value');
    if (!snap.exists()) {
        console.error('❌ Slug antigo não encontrado no Firebase');
        process.exit(1);
    }

    const data = snap.val();
    data.slug = NEW_SLUG;

    console.log(`📋 Dados encontrados:`, Object.keys(data).join(', '));

    await db.ref('restaurants/' + NEW_SLUG).set(data);
    console.log('✅ Dados copiados para o novo slug');

    await db.ref('restaurants/' + OLD_SLUG).remove();
    console.log('✅ Slug antigo removido');

    console.log('🎉 Migração concluída com sucesso!');
    process.exit(0);
}

migrate().catch(e => {
    console.error('❌ Erro:', e.message, e.stack);
    process.exit(1);
});
