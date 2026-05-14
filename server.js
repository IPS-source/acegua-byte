const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

function serveFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 — Página não encontrada</h1>');
        } else {
            res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
            res.end(content);
        }
    });
}

const server = http.createServer((req, res) => {
    let url = req.url.split('?')[0];

    // Rotas do sistema multi-tenant
    if (url === '/') {
        return serveFile(res, './index.html', 'text/html');
    }
    if (url === '/login') {
        return serveFile(res, './login.html', 'text/html');
    }
    if (url === '/register') {
        return serveFile(res, './register.html', 'text/html');
    }
    if (url.startsWith('/dashboard/')) {
        return serveFile(res, './dashboard-restaurante.html', 'text/html');
    }
    if (url.startsWith('/cardapio/')) {
        return serveFile(res, './cardapio.html', 'text/html');
    }
    if (url === '/painel') {
        return serveFile(res, './painel.html', 'text/html');
    }

    // Arquivos estáticos
    let filePath = '.' + url;
    let extname = path.extname(filePath);
    let contentType = MIME[extname] || 'text/html';

    if (extname === '.html' && url.startsWith('/')) {
        filePath = '.' + url;
    } else if (!extname) {
        filePath = './index.html';
    }

    serveFile(res, filePath, contentType);
});

server.listen(PORT, () => {
    console.log(`🖥️ Aceguá Byte — Servidor rodando em: http://localhost:${PORT}`);
    console.log(`📝 Registro: http://localhost:${PORT}/register`);
    console.log(`🔑 Login:    http://localhost:${PORT}/login`);
    console.log(`📋 Painel:   http://localhost:${PORT}/painel`);
    console.log(`🍽️ Cardápio: http://localhost:${PORT}/cardapio/{slug}`);
});
