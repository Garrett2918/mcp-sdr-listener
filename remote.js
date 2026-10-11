// Remote access, switched on by PUBLIC_URL (for example a Tailscale Funnel
// address). Everything then needs the password in SDR_PASSWORD:
//   - Claude connects to /mcp with an OAuth access token. Claude registers
//     itself, sends the user to /authorize, which shows the login form, and
//     trades the resulting code for tokens (OAuth 2.1 with PKCE, via the MCP SDK);
//   - the page and its API use a session cookie set by the same login form.
//
// Clients, tokens and sessions are kept as SHA-256 hashes in data/oauth.json,
// so a restart does not log anyone out and the file holds nothing reusable.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { registerTools } from './tools.js';

const ACCESS_TTL = 60 * 60;             // s
const REFRESH_TTL = 30 * 24 * 60 * 60;  // s
const SESSION_TTL = 30 * 24 * 60 * 60;  // s
const CODE_TTL = 5 * 60;                // s
const LOGIN_TTL = 15 * 60;              // s, to finish the login form
const MAX_CLIENTS = 50;
const MAX_FAILURES = 10;                // wrong passwords per 15 minutes, from anywhere
const COOKIE = 'sdr_session';

const ROUTES = /^\/(\.well-known\/oauth-(authorization-server|protected-resource)(\/.*)?|authorize|token|register|revoke|login|mcp)$/;

const now = () => Math.floor(Date.now() / 1000);
const token = () => crypto.randomBytes(32).toString('base64url');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createRemote({ publicUrl, password, dataDir, app }) {
    const base = new URL(publicUrl);
    const mcpUrl = new URL('/mcp', base);
    const secure = base.protocol === 'https:';
    const file = path.join(dataDir, 'oauth.json');

    // ---------- persisted state ----------

    let db = { clients: {}, access: {}, refresh: {}, sessions: {} };
    try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
    function save() {
        const t = now();
        for (const k of ['access', 'refresh', 'sessions']) {
            for (const [h, v] of Object.entries(db[k])) if (v.expires < t) delete db[k][h];
        }
        fs.writeFileSync(file, JSON.stringify(db, null, 2), { mode: 0o600 });
    }

    const pending = new Map(); // login form id -> { client, params, expires }
    const codes = new Map();   // hash(code) -> { clientId, challenge, redirectUri, expires }
    let failures = [];         // times of wrong passwords

    function issueTokens(clientId) {
        const access = token(), refresh = token();
        db.access[hash(access)] = { clientId, expires: now() + ACCESS_TTL };
        db.refresh[hash(refresh)] = { clientId, expires: now() + REFRESH_TTL };
        save();
        return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, refresh_token: refresh };
    }

    // ---------- OAuth provider for the MCP SDK ----------

    const provider = {
        clientsStore: {
            getClient: (id) => db.clients[id],
            registerClient(client) {
                // Registration is open to anyone, so keep only the newest few.
                const ids = Object.keys(db.clients).sort((a, b) => db.clients[a].client_id_issued_at - db.clients[b].client_id_issued_at);
                while (ids.length >= MAX_CLIENTS) delete db.clients[ids.shift()];
                db.clients[client.client_id] = client;
                save();
                return client;
            },
        },

        async authorize(client, params, res) {
            const id = token();
            pending.set(id, { client, params, expires: now() + LOGIN_TTL });
            res.status(200).type('html').send(loginPage({ request: id, clientName: client.client_name }));
        },

        async challengeForAuthorizationCode(client, code) {
            const c = codes.get(hash(code));
            if (!c || c.clientId !== client.client_id || c.expires < now()) throw new InvalidGrantError('Invalid or expired authorization code.');
            return c.challenge;
        },

        async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
            const c = codes.get(hash(code));
            codes.delete(hash(code));
            if (!c || c.clientId !== client.client_id || c.expires < now()) throw new InvalidGrantError('Invalid or expired authorization code.');
            if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri does not match.');
            return issueTokens(client.client_id);
        },

        async exchangeRefreshToken(client, refreshToken) {
            const h = hash(refreshToken), r = db.refresh[h];
            if (!r || r.clientId !== client.client_id || r.expires < now()) throw new InvalidGrantError('Invalid or expired refresh token.');
            delete db.refresh[h];
            return issueTokens(client.client_id);
        },

        async verifyAccessToken(accessToken) {
            const a = db.access[hash(accessToken)];
            if (!a || a.expires < now()) throw new InvalidTokenError('Invalid or expired access token.');
            return { token: accessToken, clientId: a.clientId, scopes: [], expiresAt: a.expires };
        },

        async revokeToken(client, { token: t }) {
            const h = hash(t);
            for (const k of ['access', 'refresh']) if (db[k][h]?.clientId === client.client_id) delete db[k][h];
            save();
        },
    };

    // ---------- login form ----------

    function loginPage({ request = '', next = '', clientName, error } = {}) {
        const who = request ? `<p><b>${escape(clientName || 'An MCP client')}</b> wants to use your receiver.</p>` : '';
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SDR Listener login</title><style>
body{font:16px system-ui,sans-serif;background:#0f1419;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#1a2129;padding:24px;border-radius:10px;width:min(320px,90vw)}h1{font-size:20px;margin:0 0 12px}
input,button{width:100%;box-sizing:border-box;padding:10px;margin-top:10px;border-radius:6px;border:1px solid #334;font:inherit}
input{background:#0f1419;color:inherit}button{background:#2f7dd1;color:#fff;border:0;cursor:pointer}.err{color:#ff8080}
</style></head><body><form method="post" action="/login"><h1>SDR Listener</h1>${who}
${error ? `<p class="err">${escape(error)}</p>` : ''}
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<input type="hidden" name="request" value="${escape(request)}"><input type="hidden" name="next" value="${escape(next)}">
<button type="submit">Log in</button></form></body></html>`;
    }

    function passwordOk(given) {
        const a = crypto.createHash('sha256').update(String(given || '')).digest();
        const b = crypto.createHash('sha256').update(password).digest();
        return crypto.timingSafeEqual(a, b);
    }

    // Only same-site paths, so the form cannot be used to bounce to another site.
    const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : '/');

    // ---------- express app for the remote-only routes ----------

    const ex = express();
    ex.set('trust proxy', 'loopback');
    ex.use(mcpAuthRouter({
        provider, issuerUrl: base, resourceServerUrl: mcpUrl, resourceName: 'SDR Listener',
    }));

    ex.get('/login', (req, res) => res.type('html').send(loginPage({ next: safeNext(req.query.next) })));

    ex.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
        const { password: given, request, next } = req.body || {};
        const p = request ? pending.get(request) : null;
        const again = (status, error) => res.status(status).type('html').send(loginPage({ request: p ? request : '', next: safeNext(next), clientName: p?.client.client_name, error }));
        if (request && (!p || p.expires < now())) { pending.delete(request); return again(400, 'This login link has expired. Start again from Claude.'); }

        failures = failures.filter((t) => t > now() - 900);
        if (failures.length >= MAX_FAILURES) return again(429, 'Too many wrong passwords. Try again in 15 minutes.');
        if (!passwordOk(given)) { failures.push(now()); return again(401, 'Wrong password.'); }

        // The login also signs this browser in to the page.
        const session = token();
        db.sessions[hash(session)] = { expires: now() + SESSION_TTL };
        save();
        res.cookie(COOKIE, session, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_TTL * 1000 });

        if (!p) return res.redirect(303, safeNext(next));
        pending.delete(request);
        const code = token();
        codes.set(hash(code), { clientId: p.client.client_id, challenge: p.params.codeChallenge, redirectUri: p.params.redirectUri, expires: now() + CODE_TTL });
        const to = new URL(p.params.redirectUri);
        to.searchParams.set('code', code);
        if (p.params.state) to.searchParams.set('state', p.params.state);
        res.redirect(302, to.href);
    });

    // MCP over Streamable HTTP, stateless: a fresh server per request, with
    // tools that call the API in-process.
    const api = async (p, body) => {
        const u = new URL(p, base);
        const r = await app.route({ method: body === undefined ? 'GET' : 'POST', pathname: u.pathname, query: u.searchParams, body: async () => body });
        if (!r || r.status >= 400) throw new Error(r?.json?.error || `HTTP ${r?.status ?? 404}`);
        return r.json;
    };
    const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
    ex.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
        const server = new McpServer({ name: 'sdr', version: '0.1.0' });
        registerTools(server, api, `${base.origin}/`);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); server.close(); });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.error('mcp request failed', e);
            if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
        }
    });
    ex.all('/mcp', bearer, (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));

    // ---------- what server.js calls ----------

    return {
        host: base.host,

        // Handles the OAuth, login and MCP routes; false for everything else.
        handle(req, res) {
            const { pathname } = new URL(req.url, base);
            if (!ROUTES.test(pathname)) return false;
            ex(req, res);
            return true;
        },

        // Whether a page or API request carries a valid session cookie.
        authorized(req) {
            const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
            const s = m && db.sessions[hash(m[1])];
            return !!s && s.expires > now();
        },
    };
}
