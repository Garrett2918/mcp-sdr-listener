// SDR Listener on Cloudflare: the Worker forwards everything to one Durable
// Object, which runs the same app.js as the local server. The object holds the
// receiver session, so the page, the API and Claude share it, as they do locally.
//
// Differences from Node, handled here:
//   - storage is the object's SQLite database instead of files on disk;
//   - outbound sockets are opened with fetch() so they can carry a User-Agent
//     (the receiver refuses a socket whose client differs from the one that
//     registered the session);
//   - API keys are Worker secrets, so the Settings page cannot change them;
//   - an alarm keeps the object awake while it holds a receiver session.

import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../../../app.js';

const UA = 'sdr-listener/0.1 (Cloudflare Worker)';
const KEEPALIVE_MS = 30000;
const FILE_PART = 1 << 20;   // SQLite rows top out at 2 MB; clips are split below that
const KEEP_FILES = 300;      // per kind
const KEEP_TRANSCRIPTS = 5000;

export default {
    async fetch(req, env) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith('/api/') || pathname === '/stream' || pathname === '/spectrum') {
            return env.RECEIVER.get(env.RECEIVER.idFromName('main')).fetch(req);
        }
        return env.ASSETS.fetch(req);
    },
};

export class Receiver extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.ready = createApp({
            host: env.SDR_HOST || 'ubersdr.k3fef.com',
            store: sqlStore(ctx.storage.sql),
            openSocket,
            receiverFetch,
        });
    }

    async fetch(req) {
        const app = await this.ready;
        const url = new URL(req.url);
        try {
            if (req.headers.get('Upgrade') === 'websocket') {
                const attach = url.pathname === '/stream' ? app.attachStream : url.pathname === '/spectrum' ? app.attachSpectrum : null;
                if (!attach) return new Response('Not found', { status: 404 });
                const [client, server] = Object.values(new WebSocketPair());
                server.accept();
                attach(pageSocket(server));
                return new Response(null, { status: 101, webSocket: client });
            }
            const body = async () => { const t = await req.text(); return t ? JSON.parse(t) : {}; };
            const r = await app.route({ method: req.method, pathname: url.pathname, query: url.searchParams, body });
            if (!r) return Response.json({ error: 'Not found.' }, { status: 404 });
            if (r.json !== undefined) return Response.json(r.json, { status: r.status });
            return new Response(r.bytes, { status: r.status, headers: { 'Content-Type': r.type } });
        } finally {
            await this.keepAlive(app);
        }
    }

    async alarm() {
        await this.keepAlive(await this.ready);
    }

    async keepAlive(app) {
        if (!app.busy()) return;
        const at = await this.ctx.storage.getAlarm();
        if (at === null || at > Date.now() + KEEPALIVE_MS) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
}

// ---------- receiver connections ----------

const receiverFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': UA } });

// A browser-style WebSocket over a Workers fetch() upgrade. app.js assigns its
// handlers right after creating the socket, so connecting is deferred to a
// promise and onopen fires once the upgrade is done.
function openSocket(url) {
    const sock = {
        readyState: 0, binaryType: 'arraybuffer',
        onopen: null, onmessage: null, onclose: null, onerror: null,
        inner: null, closing: false,
        send(data) { if (this.inner && this.readyState === 1) this.inner.send(data); },
        close(code = 1000, reason) {
            this.closing = true;
            this.readyState = 3;
            try { this.inner?.close(code, reason); } catch { /* already closed */ }
        },
    };
    (async () => {
        try {
            const res = await receiverFetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket' } });
            const ws = res.webSocket;
            if (!ws) throw new Error(`Receiver refused the socket (HTTP ${res.status}).`);
            ws.binaryType = 'arraybuffer';
            ws.accept();
            if (sock.closing) { ws.close(1000); return; }
            sock.inner = ws;
            sock.readyState = 1;
            ws.addEventListener('message', (ev) => sock.onmessage?.({ data: ev.data }));
            ws.addEventListener('close', (ev) => { sock.readyState = 3; sock.onclose?.({ code: ev.code, reason: ev.reason }); });
            ws.addEventListener('error', (ev) => sock.onerror?.(ev));
            sock.onopen?.({});
        } catch (e) {
            sock.readyState = 3;
            sock.onerror?.(e);
            sock.onclose?.({ code: 1006, reason: e.message });
        }
    })();
    return sock;
}

// Adapts a page WebSocket to the shape app.js expects. Workers buffer outgoing
// frames themselves and do not report how much is queued.
function pageSocket(ws) {
    return {
        send: (data) => { try { ws.send(data); } catch { /* closing */ } },
        open: () => ws.readyState === 1,
        buffered: () => 0,
        onMessage: (fn) => ws.addEventListener('message', (ev) => { if (typeof ev.data === 'string') fn(ev.data); }),
        onClose: (fn) => {
            let done = false;
            const once = () => { if (!done) { done = true; fn(); } };
            ws.addEventListener('close', once);
            ws.addEventListener('error', once);
        },
    };
}

// ---------- storage ----------

function sqlStore(sql) {
    sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transcripts (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files (
            kind TEXT NOT NULL, name TEXT NOT NULL, part INTEGER NOT NULL,
            bytes BLOB NOT NULL, created INTEGER NOT NULL,
            PRIMARY KEY (kind, name, part)
        );
    `);
    const rows = (q, ...args) => sql.exec(q, ...args).toArray();
    return {
        async getJson(name) {
            const r = rows('SELECT value FROM kv WHERE name = ?', name)[0];
            return r ? JSON.parse(r.value) : null;
        },
        async putJson(name, value) {
            sql.exec('INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)', name, JSON.stringify(value));
        },
        async appendTranscript(entry) {
            sql.exec('INSERT INTO transcripts (entry) VALUES (?)', JSON.stringify(entry));
            sql.exec('DELETE FROM transcripts WHERE seq <= (SELECT MAX(seq) FROM transcripts) - ?', KEEP_TRANSCRIPTS);
        },
        async readTranscripts(limit = 20) {
            return rows('SELECT entry FROM transcripts ORDER BY seq DESC LIMIT ?', limit).map((r) => JSON.parse(r.entry));
        },
        async putFile(kind, name, bytes) {
            const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const now = Date.now();
            sql.exec('DELETE FROM files WHERE kind = ? AND name = ?', kind, name);
            for (let i = 0, part = 0; i < u8.length || part === 0; i += FILE_PART, part++) {
                sql.exec('INSERT INTO files (kind, name, part, bytes, created) VALUES (?, ?, ?, ?, ?)',
                    kind, name, part, u8.slice(i, i + FILE_PART).buffer, now);
            }
            sql.exec(`DELETE FROM files WHERE kind = ? AND name NOT IN (
                SELECT name FROM files WHERE kind = ? GROUP BY name ORDER BY MAX(created) DESC LIMIT ?)`, kind, kind, KEEP_FILES);
        },
        async getFile(kind, name) {
            const parts = rows('SELECT bytes FROM files WHERE kind = ? AND name = ? ORDER BY part', kind, name);
            return parts.length ? Buffer.concat(parts.map((p) => Buffer.from(p.bytes))) : null;
        },
        async latestFile(kind) {
            const r = rows('SELECT name FROM files WHERE kind = ? ORDER BY created DESC, name DESC LIMIT 1', kind)[0];
            return r ? { name: r.name, bytes: await this.getFile(kind, r.name) } : null;
        },
        async setSecret(name) {
            throw new Error(`On Cloudflare, API keys are Worker secrets. Set this one with: npx wrangler secret put ${name}`);
        },
    };
}
