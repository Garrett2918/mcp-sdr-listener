// Throwaway probe: can a Cloudflare Worker hold an UberSDR session?
// GET /?seconds=10 registers a session, opens the audio WebSocket, decodes the
// PCM v4 frames with the same decoder server.js uses, and reports what arrived.

import { PCMv4StreamDecoder, isV4Frame } from '../../../vendor/pcm-v4.js';

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (url.pathname !== '/') return new Response('Not found', { status: 404 });
        const host = env.SDR_HOST || 'ubersdr.k3fef.com';
        const seconds = Math.min(30, Math.max(2, Number(url.searchParams.get('seconds')) || 10));
        const report = { host, seconds, colo: req.cf?.colo };

        try {
            const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text();
            report.egressIp = /^ip=(.*)$/m.exec(trace)?.[1];
        } catch { /* informational only */ }

        const sessionId = crypto.randomUUID();
        const check = await fetch(`https://${host}/connection`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ user_session_id: sessionId }),
        });
        report.connection = { status: check.status, body: await check.text() };
        let allowed = false;
        try { allowed = JSON.parse(report.connection.body).allowed === true; } catch { /* not JSON */ }
        if (!allowed) return json({ ok: false, stage: 'connection', ...report });

        const q = new URLSearchParams({
            frequency: '7200000', mode: 'lsb', bandwidthLow: '-2700', bandwidthHigh: '-50',
            user_session_id: sessionId, format: 'pcm-zstd', version: '4',
        });
        const res = await fetch(`https://${host}/ws?${q}`, { headers: { Upgrade: 'websocket', 'User-Agent': UA } });
        const ws = res.webSocket;
        if (!ws) return json({ ok: false, stage: 'websocket', upgradeStatus: res.status, upgradeBody: await res.text(), ...report });
        ws.binaryType = 'arraybuffer';
        ws.accept();

        const decoder = new PCMv4StreamDecoder();
        const stats = { textMessages: [], binaryFrames: 0, bytes: 0, decodedFrames: 0, samples: 0, sampleRate: null, lastSignal: null, closed: null };
        const t0 = Date.now();
        await new Promise((resolve) => {
            const done = setTimeout(resolve, seconds * 1000);
            ws.addEventListener('message', (ev) => {
                if (typeof ev.data === 'string') {
                    if (stats.textMessages.length < 5) stats.textMessages.push(ev.data.slice(0, 300));
                    return;
                }
                stats.binaryFrames++;
                stats.bytes += ev.data.byteLength;
                if (!isV4Frame(ev.data)) return;
                const r = decoder.decode(ev.data);
                if (!r) return;
                stats.decodedFrames++;
                stats.samples += r.planes[0].length;
                stats.sampleRate = r.sampleRate;
                stats.lastSignal = { power: r.signal.basebandPower, noise: r.signal.noisePower };
            });
            ws.addEventListener('close', (ev) => { stats.closed = { code: ev.code, reason: ev.reason }; clearTimeout(done); resolve(); });
            ws.addEventListener('error', (ev) => { stats.closed ??= { error: String(ev.message || ev.error || 'error') }; });
        });
        try { ws.close(1000, 'probe done'); } catch { /* already closed */ }

        stats.elapsedSec = (Date.now() - t0) / 1000;
        stats.audioSec = stats.sampleRate ? stats.samples / stats.sampleRate : 0;
        return json({ ok: stats.decodedFrames > 0, stage: 'audio', ...report, stats });
    },
};

// The receiver ties a session to the client that registered it.
const UA = 'sdr-listener-probe/0.1';
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { 'Content-Type': 'application/json' } });
