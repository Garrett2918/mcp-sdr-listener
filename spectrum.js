// Live spectrum from the receiver's /ws/user-spectrum (protocol v1, binary8).
//
// One upstream socket, shared by the page's live waterfall and by captures
// (Claude's waterfall snapshots and signal scans). A capture moves the view
// where it needs it and puts it back afterwards.

import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';

const LINGER_MS = 20000;

export class SpectrumFeed extends EventEmitter {
    constructor({ host, radio }) {
        super();
        this.host = host;
        this.radio = radio;
        this.ws = null;
        this.connecting = null;
        this.viewers = 0;
        this.busy = 0;
        this.config = null; // { centerFreq, binBandwidth, binCount }
        this.raw = null;
        this.view = { frequency: radio.tuning.frequency, binBandwidth: 50 }; // ~100 kHz
        this.lingerTimer = null;
    }

    get wanted() { return this.viewers > 0 || this.busy > 0; }

    async ensure() {
        clearTimeout(this.lingerTimer);
        if (this.ws && this.ws.readyState === 1) return;
        if (this.connecting) return this.connecting;
        this.connecting = this._open().finally(() => { this.connecting = null; });
        return this.connecting;
    }

    async _open() {
        await this.radio.register();
        const q = new URLSearchParams({
            user_session_id: this.radio.sessionId, mode: 'binary8', version: '1',
            frequency: String(Math.round(this.view.frequency)), bin_bandwidth: String(this.view.binBandwidth),
        });
        const ws = new WebSocket(`wss://${this.host}/ws/user-spectrum?${q}`);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.raw = null;
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Spectrum connection timed out.')), 10000);
            ws.onopen = () => { clearTimeout(t); resolve(); };
            ws.onerror = () => { clearTimeout(t); reject(new Error('Spectrum connection failed.')); };
        });
        ws.onmessage = (ev) => this._onMessage(ev.data);
        ws.onclose = () => {
            if (this.ws === ws) this.ws = null;
            this.emit('closed');
            if (this.wanted) setTimeout(() => this.wanted && this.ensure().catch(() => {}), 3000);
        };
    }

    release() {
        clearTimeout(this.lingerTimer);
        if (this.wanted) return;
        this.lingerTimer = setTimeout(() => {
            if (!this.wanted && this.ws) { try { this.ws.close(1000); } catch { /* closed */ } this.ws = null; }
        }, LINGER_MS);
    }

    setView(frequency, binBandwidth) {
        this.view = { frequency: Math.round(frequency), binBandwidth: binBandwidth ?? this.view.binBandwidth };
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'zoom', ...this.view }));
    }

    _onMessage(data) {
        if (typeof data === 'string') return this._control(data);
        const u8 = new Uint8Array(data);
        if (!(u8[0] === 0x53 && u8[1] === 0x50 && u8[2] === 0x45 && u8[3] === 0x43)) {
            try { this._control(zlib.gunzipSync(Buffer.from(u8)).toString()); } catch { /* not a control frame */ }
            return;
        }
        if (u8[4] !== 1 || !this.config) return;
        const flags = u8[5], H = 22;
        const view = new DataView(data);
        if (flags === 3) {
            this.raw = u8.slice(H);
        } else if (flags === 4) {
            if (!this.raw) return;
            const count = view.getUint16(H, true);
            let off = H + 2;
            for (let i = 0; i < count; i++) { this.raw[view.getUint16(off, true)] = u8[off + 2]; off += 3; }
        } else return;
        // Raw FFT order is [DC..+Nyquist, -Nyquist..DC]; rotate to ascending frequency, in dB.
        const n = this.raw.length, half = n >> 1, row = new Float32Array(n);
        for (let i = 0; i < n; i++) row[i] = this.raw[(i + half) % n] - 256;
        const { centerFreq, binBandwidth } = this.config;
        this.emit('row', { row, startHz: centerFreq - (n * binBandwidth) / 2, binHz: binBandwidth, t: Date.now() });
    }

    _control(text) {
        let msg; try { msg = JSON.parse(text); } catch { return; }
        if (msg.type === 'config' || msg.type === 'status') {
            this.config = {
                centerFreq: msg.centerFreq ?? this.config?.centerFreq,
                binBandwidth: msg.binBandwidth ?? this.config?.binBandwidth,
                binCount: msg.binCount ?? this.config?.binCount ?? 2048,
            };
            // Delta frames keep coming after a zoom, so the accumulator survives
            // unless the bin count itself changed.
            if (this.raw && this.raw.length !== this.config.binCount) this.raw = null;
            this.emit('config', this.config);
        } else if (msg.type === 'error') {
            this.emit('error-msg', msg.error);
        }
    }

    // Collect `seconds` of rows for a view, then restore the previous view.
    async capture({ centerHz, spanHz, seconds = 6 }) {
        this.busy++;
        const prev = { ...this.view };
        try {
            await this.ensure();
            const bins = this.config?.binCount || 2048;
            // The receiver snaps bin width to its own ladder, sometimes downward;
            // ask for the next 1-2-5 step up so the span is covered, then crop.
            const want = niceUp(Math.max(0.5, spanHz / bins));
            const configured = new Promise((resolve) => {
                const t = setTimeout(resolve, 4000);
                this.once('config', () => { clearTimeout(t); resolve(); });
            });
            this.setView(centerHz, want);
            await configured;
            const rows = [];
            let skip = 2; // frames already in flight for the old view
            const onRow = (r) => { if (skip-- > 0) return; rows.push(r); };
            this.on('row', onRow);
            await new Promise((r) => setTimeout(r, seconds * 1000));
            this.off('row', onRow);
            if (!rows.length) throw new Error('No spectrum data arrived from the receiver.');
            const last = rows.at(-1);
            const same = rows.filter((r) => r.startHz === last.startHz && r.binHz === last.binHz).map((r) => r.row);
            // Crop to the span that was asked for.
            const a = Math.max(0, Math.floor((centerHz - spanHz / 2 - last.startHz) / last.binHz));
            const b = Math.min(last.row.length, Math.ceil((centerHz + spanHz / 2 - last.startHz) / last.binHz));
            if (b - a < 16) return { rows: same, startHz: last.startHz, binHz: last.binHz };
            return { rows: same.map((r) => r.slice(a, b)), startHz: last.startHz + a * last.binHz, binHz: last.binHz };
        } finally {
            this.busy--;
            if (this.viewers > 0) this.setView(prev.frequency, prev.binBandwidth);
            this.release();
        }
    }
}

// Find signals in a capture. Each one gets its centre, width, strength above the
// local noise floor, how much of the time it was present, and a rough guess at
// what kind of transmission that shape suggests.
export function findSignals({ rows: allRows, startHz, binHz }, { thresholdDb = 8, limit = 40 } = {}) {
    // Static crashes and other impulse noise lift a whole row at once and would
    // otherwise show up as dozens of brief "signals". Drop rows whose median sits
    // well above the typical row median.
    const medianOf = (r) => { const s = Array.from(r).sort((a, b) => a - b); return s[s.length >> 1]; };
    const meds = allRows.map(medianOf);
    const typical = [...meds].sort((a, b) => a - b)[meds.length >> 1];
    const rows = allRows.filter((_, i) => meds[i] < typical + 4);
    if (rows.length < Math.max(3, allRows.length * 0.3)) rows.splice(0, rows.length, ...allRows);
    const n = rows[0].length;
    const avg = new Float32Array(n), peak = new Float32Array(n).fill(-300);
    for (const r of rows) for (let i = 0; i < n; i++) { avg[i] += r[i] / rows.length; if (r[i] > peak[i]) peak[i] = r[i]; }

    // Local noise floor: 25th percentile in a sliding window.
    const W = 64, floor = new Float32Array(n);
    for (let i = 0; i < n; i += 8) {
        const seg = Array.from(avg.subarray(Math.max(0, i - W), Math.min(n, i + W))).sort((a, b) => a - b);
        const f = seg[Math.floor(seg.length * 0.25)];
        for (let k = i; k < Math.min(n, i + 8); k++) floor[k] = f;
    }
    const duty = new Float32Array(n);
    for (const r of rows) for (let i = 0; i < n; i++) if (r[i] > floor[i] + thresholdDb) duty[i] += 1 / rows.length;

    const hot = (i) => avg[i] > floor[i] + thresholdDb || (duty[i] > 0.1 && peak[i] > floor[i] + thresholdDb + 6);
    // Hot bins up to two quiet bins apart belong to the same signal.
    const groups = [];
    let start = -1, lastHot = -10;
    for (let i = 0; i < n; i++) {
        if (!hot(i)) continue;
        if (start < 0 || i - lastHot > 3) { if (start >= 0) groups.push([start, lastHot]); start = i; }
        lastHot = i;
    }
    if (start >= 0) groups.push([start, lastHot]);

    const signals = groups.map(([a, b]) => {
        let wsum = 0, fsum = 0, best = -300, bestAbove = -300, d = 0;
        for (let i = a; i <= b; i++) {
            const lin = 10 ** ((avg[i] - floor[i]) / 10);
            wsum += lin; fsum += lin * i;
            best = Math.max(best, avg[i]);
            bestAbove = Math.max(bestAbove, peak[i] - floor[i]);
            d = Math.max(d, duty[i]);
        }
        const widthHz = (b - a + 1) * binHz;
        const centerHz = Math.round(startHz + (fsum / wsum + 0.5) * binHz);
        return {
            frequencyKhz: +(centerHz / 1000).toFixed(binHz < 100 ? 2 : 1),
            widthHz: Math.round(widthHz),
            avgAboveNoiseDb: +(best - floor[Math.round(fsum / wsum)]).toFixed(1),
            peakAboveNoiseDb: +bestAbove.toFixed(1),
            presentPct: Math.round(d * 100),
            guess: guessKind(widthHz, d, binHz),
        };
    // What survives as barely-above-noise and mostly absent is leftover static.
    }).filter((s) => !(s.avgAboveNoiseDb < 4 && s.presentPct < 30));
    signals.sort((x, y) => y.peakAboveNoiseDb - x.peakAboveNoiseDb);
    const sortedFloor = Array.from(floor).sort((a, b) => a - b);
    return {
        noiseFloorDb: +sortedFloor[Math.floor(n / 2)].toFixed(1), resolutionHz: binHz,
        rowsUsed: rows.length, rowsDroppedAsStatic: allRows.length - rows.length,
        signals: signals.slice(0, limit),
    };
}

function niceUp(x) {
    const p = 10 ** Math.floor(Math.log10(x));
    for (const m of [1, 2, 5, 10]) if (m * p >= x - 1e-9) return m * p;
    return 10 * p;
}

function guessKind(widthHz, duty, binHz) {
    if (widthHz <= Math.max(600, binHz * 3)) return duty > 0.8 ? 'steady narrow carrier (beacon, digital, time signal, or AM carrier)' : 'narrow, intermittent (CW or digital)';
    if (widthHz <= 4000) return duty > 0.8 ? 'steady ~3 kHz (digital/data, or busy SSB)' : 'intermittent ~3 kHz (likely SSB voice)';
    if (widthHz <= 14000) return duty > 0.6 ? 'steady wide (AM broadcast or AM voice)' : 'intermittent wide (AM voice or several signals)';
    return 'very wide (several signals merged, or wideband noise)';
}
