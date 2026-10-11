// MCP server for Claude: thin tools over the local SDR Listener API.
// Starts server.js in the background if it isn't already running, so the page
// and Claude always share one receiver session.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }
const BASE = `http://127.0.0.1:${process.env.PORT || 8737}`;

async function up() {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
}

async function ensureServer() {
    if (await up()) return;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await up()) return;
    }
    throw new Error('Could not start the SDR Listener server (server.js).');
}

async function api(p, body) {
    await ensureServer();
    const res = await fetch(BASE + p, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

const server = new McpServer({ name: 'sdr', version: '0.1.0' });
registerTools(server, api, `${BASE.replace('127.0.0.1', 'localhost')}/`);

await server.connect(new StdioServerTransport());
