// SDR Listener: a local bridge between an UberSDR receiver, a browser player,
// hosted transcription and Claude (through mcp.js).
//
// This file is the Node shell around app.js: it keeps state in data/ and API
// keys in .env, serves the page, and only answers this computer.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }

const SDR_HOST = process.env.SDR_HOST || 'ubersdr.k3fef.com';
const PORT = Number(process.env.PORT || 8737);
const DATA = process.env.SDR_DATA ? path.resolve(process.env.SDR_DATA) : path.join(ROOT, 'data');
const ENV_FILE = path.join(ROOT, '.env');
const DIRS = { clips: path.join(DATA, 'clips'), waterfalls: path.join(DATA, 'waterfalls') };
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

// ---------- storage on disk ----------

const TRANSCRIPTS = path.join(DATA, 'transcripts.jsonl');

const store = {
    async getJson(name) {
        try { return JSON.parse(fs.readFileSync(path.join(DATA, `${name}.json`), 'utf8')); } catch { return null; }
    },
    async putJson(name, value) {
        fs.writeFileSync(path.join(DATA, `${name}.json`), JSON.stringify(value, null, 2));
    },
    async appendTranscript(entry) {
        fs.appendFileSync(TRANSCRIPTS, JSON.stringify(entry) + '\n');
    },
    async readTranscripts(limit = 20) {
        let lines = [];
        try { lines = fs.readFileSync(TRANSCRIPTS, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
        return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
    },
    async putFile(kind, name, bytes) {
        fs.writeFileSync(path.join(DIRS[kind], name), bytes);
    },
    async getFile(kind, name) {
        try { return fs.readFileSync(path.join(DIRS[kind], name)); } catch { return null; }
    },
    async latestFile(kind) {
        const files = fs.readdirSync(DIRS[kind]).sort();
        if (!files.length) return null;
        return { name: files.at(-1), bytes: fs.readFileSync(path.join(DIRS[kind], files.at(-1))) };
    },
    // Set or remove one KEY=value line in .env, keeping everything else.
    async setSecret(name, value) {
        let lines = [];
        try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch { /* new file */ }
        lines = lines.filter((l) => !l.startsWith(`${name}=`) && l !== '');
        if (value) lines.push(`${name}=${value}`);
        fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
        if (value) process.env[name] = value; else delete process.env[name];
    },
};

const app = await createApp({ host: SDR_HOST, store });
export const radio = app.radio;

// ---------- HTTP + browser stream ----------

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/player-worklet.js': 'player-worklet.js', '/settings': 'settings.html', '/settings.js': 'settings.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

async function readJson(req) {
    let s = '';
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
}

// Only this machine's own pages and tools may use the API. The Host check stops
// DNS-rebinding pages; the Origin check stops other sites posting to localhost.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function allowed(req) {
    if (!LOCAL_HOSTS.has(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return false;
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return false;
    return true;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!allowed(req)) return send(res, 403, { error: 'Requests are only accepted from this computer\'s SDR Listener page and tools.' });
    if (STATIC[url.pathname]) {
        const f = path.join(ROOT, 'public', STATIC[url.pathname]);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)], 'Cache-Control': 'no-store' });
        fs.createReadStream(f).pipe(res);
        return;
    }
    const r = await app.route({ method: req.method, pathname: url.pathname, query: url.searchParams, body: () => readJson(req) });
    if (!r) return send(res, 404, { error: 'Not found.' });
    if (r.json !== undefined) return send(res, r.status, r.json);
    res.writeHead(r.status, { 'Content-Type': r.type });
    res.end(r.bytes);
});

// Adapts a `ws` socket to the shape app.js expects.
function pageSocket(ws) {
    return {
        send: (data) => ws.send(data),
        open: () => ws.readyState === 1,
        buffered: () => ws.bufferedAmount,
        onMessage: (fn) => ws.on('message', (data, isBinary) => { if (!isBinary) fn(data.toString()); }),
        onClose: (fn) => ws.on('close', fn),
    };
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const attach = pathname === '/stream' ? app.attachStream : pathname === '/spectrum' ? app.attachSpectrum : null;
    const origin = req.headers.origin;
    const local = LOCAL_HOSTS.has(req.headers.host) && (!origin || LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '')));
    if (!attach || !local) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => attach(pageSocket(ws)));
});

server.listen(PORT, '127.0.0.1', () => console.log(`SDR Listener on http://localhost:${PORT} (receiver ${SDR_HOST})`));
