// SDR Listener core: the receiver session, audio buffer, transcription, live
// captions, spectrum tools and the HTTP API, with no ties to where it runs.
//
// server.js runs it under Node, passing in a `store` for persistence (files
// on disk). A host can also pass its own way of opening sockets and fetching
// from the receiver.
//
// One upstream audio session is shared by everything: the page, the REST API
// and the MCP tools. It connects when someone is listening or a tool asks for
// audio, and drops after IDLE_MS of neither, so a volunteer-run receiver is not
// held open while nobody is using it.

import { EventEmitter } from 'node:events';
import { PCMv4StreamDecoder, isV4Frame } from './vendor/pcm-v4.js';
import { decodeCw } from './cw.js';
import { SpectrumFeed, findSignals } from './spectrum.js';
import { SpotFeed } from './spots.js';
import { renderWaterfall } from './png.js';
import { demodulate, AUDIO_RATE } from './dsp.js';
import { PROVIDERS, DEFAULT_SETTINGS, DEFAULT_PROMPT, transcribe as transcribeWith, callModel, validChoice, maskKey } from './transcribe.js';

const BUFFER_SECONDS = 300;
const IDLE_MS = 5 * 60 * 1000;

export const MODES = {
    am: [-5000, 5000], sam: [-5000, 5000], usb: [50, 2700], lsb: [-2700, -50],
    cwu: [-200, 200], cwl: [-200, 200], nfm: [-5000, 5000], fm: [-8000, 8000],
    iq96: [-48000, 48000], // wideband raw IQ, used internally by sample()
};
const isWideIQ = (mode) => /^iq\d+$/.test(String(mode || ''));

// A store persists, asynchronously:
//   getJson(name) / putJson(name, value)        small documents (state, settings)
//   appendTranscript(entry) / readTranscripts(n) the transcript log, newest first
//   putFile(kind, name, bytes) / getFile(kind, name) / latestFile(kind)
//                                               clips and waterfall images (Buffers)
//   setSecret(name, value)                      API keys (may refuse)
export async function createApp({
    host,
    store,
    openSocket = (url) => new WebSocket(url),
    receiverFetch = fetch,
}) {
    const SDR_HOST = host;
    const events = new EventEmitter();
    const saveState = (s) => store.putJson('state', s).catch((e) => console.error('state save failed', e.message));

    // ---------- radio ----------

    class Radio extends EventEmitter {
        constructor(s) {
            super();
            // Reusing one session id keeps this app to a single "unique user" on
            // the receiver, which limits how many each IP may hold.
            this.sessionId = s.sessionId || crypto.randomUUID();
            this.tuning = s.tuning || { frequency: 3873000, mode: 'am', bandwidthLow: -5000, bandwidthHigh: 5000 };
            saveState({ sessionId: this.sessionId, tuning: this.tuning });
            this.status = 'idle';
            this.message = '';
            this.ws = null;
            this.listeners = 0;
            this.lastUse = 0;
            this.sampleRate = 0;
            this.ring = null;
            this.written = 0;
            this.tuneMark = 0;
            this.signal = { power: null, noise: null };
            this.retryMs = 5000;
            this.retryTimer = null;
            setInterval(() => this._idleCheck(), 15000).unref?.();
        }

        get wanted() { return this.listeners > 0 || Date.now() - this.lastUse < IDLE_MS; }

        snapshot() {
            const t = this.tuning;
            return {
                host: SDR_HOST, status: this.status, message: this.message,
                frequency: t.frequency, mode: t.mode, bandwidthLow: t.bandwidthLow, bandwidthHigh: t.bandwidthHigh,
                sampleRate: this.sampleRate, listeners: this.listeners,
                bufferedSeconds: this.sampleRate ? Math.round(Math.min(this.written - this.tuneMark, this.ring.length) / this.sampleRate) : 0,
                signalDb: this.signal.power, noiseDb: this.signal.noise,
                snrDb: this.signal.power != null && this.signal.noise != null ? +(this.signal.power - this.signal.noise).toFixed(1) : null,
            };
        }

        _set(status, message = '') {
            if (this.status === status && this.message === message) return;
            this.status = status; this.message = message;
            this.emit('status');
        }

        touch() { this.lastUse = Date.now(); this.ensure(); }

        ensure() {
            if (this.ws || this.retryTimer || this.status === 'connecting') return;
            this._connect();
        }

        _idleCheck() {
            if (this.ws && !this.wanted) {
                console.log('idle, disconnecting from receiver');
                this.disconnect();
            }
        }

        disconnect() {
            clearTimeout(this.retryTimer); this.retryTimer = null;
            const ws = this.ws; this.ws = null;
            if (ws) { try { ws.close(1000); } catch { /* closed */ } }
            clearInterval(this.pingTimer);
            this._set('idle');
        }

        _retry(reason) {
            this.ws = null;
            clearInterval(this.pingTimer);
            if (!this.wanted) { this._set('idle'); return; }
            const wait = this.retryMs;
            this.retryMs = Math.min(this.retryMs * 2, 60000);
            this._set(this.status === 'refused' ? 'refused' : 'reconnecting', `${reason} Retrying in ${Math.round(wait / 1000)} s.`);
            this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.wanted) this._connect(); else this._set('idle'); }, wait);
        }

        // Registers this app's session with the receiver; the audio, spectrum and
        // spot sockets all ride on it. A yes is reused for a minute.
        async register() {
            if (this.registered && Date.now() - this.registered.at < 60000) return this.registered.check;
            const check = await this._check();
            if (!check.allowed) throw new Error(`Receiver refused the connection: ${check.reason || 'no reason given'}.`);
            return check;
        }

        // POST /connection. A session the receiver has ended ("terminated", "invalid
        // session") is replaced with a fresh id, which is what reloading the page does.
        async _check() {
            const post = async () => (await receiverFetch(`https://${SDR_HOST}/connection`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_session_id: this.sessionId }),
            })).json();
            let check = await post();
            if (!check.allowed && /terminated|invalid session|expired/i.test(check.reason || '')) {
                console.log(`session ended by receiver (${check.reason}); starting a new one`);
                this.sessionId = crypto.randomUUID();
                saveState({ sessionId: this.sessionId, tuning: this.tuning });
                check = await post();
            }
            if (check.allowed) this.registered = { at: Date.now(), check };
            return check;
        }

        async _connect() {
            this._set('connecting');
            let check;
            try {
                check = await this._check();
            } catch (e) {
                this._retry(`Could not reach ${SDR_HOST}.`);
                return;
            }
            if (!check.allowed) {
                this.status = 'refused';
                this._retry(`Receiver refused the connection: ${check.reason || 'no reason given'}.`);
                return;
            }
            const t = this.tuning;
            const q = new URLSearchParams({
                frequency: String(t.frequency), mode: t.mode,
                bandwidthLow: String(t.bandwidthLow), bandwidthHigh: String(t.bandwidthHigh),
                user_session_id: this.sessionId, format: 'pcm-zstd', version: '4',
            });
            // Wide IQ keeps its preset's edges; the receiver ignores or refuses others.
            if (isWideIQ(t.mode)) { q.delete('bandwidthLow'); q.delete('bandwidthHigh'); }
            const ws = openSocket(`wss://${SDR_HOST}/ws?${q}`);
            ws.binaryType = 'arraybuffer';
            this.ws = ws;
            const decoder = new PCMv4StreamDecoder();
            let serverError = '';
            ws.onopen = () => {
                this.retryMs = 5000;
                this.pingTimer = setInterval(() => this._send({ type: 'ping' }), 30000);
            };
            ws.onmessage = (ev) => {
                if (ws !== this.ws) return;
                if (typeof ev.data === 'string') {
                    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
                    if (msg.type === 'error') serverError = msg.error || 'server error';
                    return;
                }
                if (!isV4Frame(ev.data)) return;
                const r = decoder.decode(ev.data);
                if (!r) return;
                if (this.status !== 'live') this._set('live');
                this.signal = { power: r.signal.basebandPower, noise: r.signal.noisePower };
                // Wideband IQ (used by sample) goes to its listeners, not the audio buffer.
                if (r.channels === 2) { this.emit('iq', r.planes, r.sampleRate); return; }
                this._push(r.planes[0], r.sampleRate);
            };
            ws.onclose = () => {
                if (ws !== this.ws) return;
                this.registered = null;
                this._retry(serverError ? `Receiver said: ${serverError}.` : 'Connection to the receiver closed.');
            };
            ws.onerror = () => { /* onclose follows */ };
        }

        _send(obj) {
            if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
        }

        _push(plane, rate) {
            if (rate !== this.sampleRate || !this.ring) {
                this.sampleRate = rate;
                this.ring = new Int16Array(rate * BUFFER_SECONDS);
                this.written = 0;
                this.tuneMark = 0;
                this.emit('status');
            }
            const pcm = new Int16Array(plane.length);
            for (let i = 0; i < plane.length; i++) {
                const v = Math.max(-1, Math.min(1, plane[i]));
                pcm[i] = v < 0 ? v * 32768 : v * 32767;
            }
            const n = this.ring.length;
            for (let i = 0; i < pcm.length; i++) this.ring[(this.written + i) % n] = pcm[i];
            this.written += pcm.length;
            this.emit('pcm', pcm, rate);
        }

        tune(next) {
            const mode = String(next.mode || this.tuning.mode).toLowerCase();
            if (!MODES[mode]) throw new Error(`Unknown mode "${mode}". Use one of: ${Object.keys(MODES).join(', ')}.`);
            const frequency = Math.round(Number(next.frequency ?? this.tuning.frequency));
            if (!Number.isFinite(frequency) || frequency < 10000 || frequency > 60000000) throw new Error('Frequency must be between 10 kHz and 60 MHz, in Hz.');
            const modeChanged = mode !== this.tuning.mode;
            const [dl, dh] = MODES[mode];
            const bandwidthLow = Math.round(Number(next.bandwidthLow ?? (modeChanged ? dl : this.tuning.bandwidthLow)));
            const bandwidthHigh = Math.round(Number(next.bandwidthHigh ?? (modeChanged ? dh : this.tuning.bandwidthHigh)));
            if (!(bandwidthLow < bandwidthHigh)) throw new Error('bandwidthLow must be below bandwidthHigh.');
            this.tuning = { frequency, mode, bandwidthLow, bandwidthHigh };
            saveState({ sessionId: this.sessionId, tuning: this.tuning });
            // The receiver rejects a whole retune into a wide IQ mode if it carries edges.
            if (isWideIQ(mode)) this._send({ type: 'tune', frequency, mode });
            else this._send({ type: 'tune', ...this.tuning });
            // Audio from before a retune belongs to a different signal.
            this.tuneMark = this.written;
            this.emit('status');
            return this.snapshot();
        }

        // The last `seconds` of audio on the current tuning, or less if not that much exists.
        recent(seconds) {
            if (!this.ring) return null;
            const want = Math.round(seconds * this.sampleRate);
            const from = Math.max(this.tuneMark, this.written - want, this.written - this.ring.length);
            return this._slice(from, this.written);
        }

        _slice(from, to) {
            const n = this.ring.length, out = new Int16Array(to - from);
            for (let i = 0; i < out.length; i++) out[i] = this.ring[(from + i) % n];
            return { pcm: out, sampleRate: this.sampleRate };
        }

        // The next `seconds` of audio, waiting for it to arrive.
        next(seconds) {
            this.touch();
            return new Promise((resolve, reject) => {
                const deadline = Date.now() + seconds * 1000 + 30000;
                let start = null, startTune = null;
                const tick = () => {
                    this.lastUse = Date.now();
                    if (this.ring && start === null) { start = this.written; startTune = this.tuneMark; }
                    if (start !== null) {
                        if (this.tuneMark !== startTune) { start = this.tuneMark; startTune = this.tuneMark; }
                        const need = Math.round(seconds * this.sampleRate);
                        if (this.written - start >= need) { resolve(this._slice(start, start + need)); return; }
                    }
                    if (Date.now() > deadline) {
                        reject(new Error(this.status === 'live' ? 'Timed out waiting for audio.' : `No audio from the receiver (${this.status}${this.message ? ': ' + this.message : ''}).`));
                        return;
                    }
                    setTimeout(tick, 250);
                };
                tick();
            });
        }
    }

    const radio = new Radio((await store.getJson('state')) || {});

    // ---------- audio helpers ----------

    function wav(pcm, sampleRate) {
        const buf = Buffer.alloc(44 + pcm.length * 2);
        buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
        buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
        buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
        buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
        Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
        return buf;
    }

    // Audio on the current tuning: buffered ('past'), or recorded forward ('next')
    // when asked or when too little is buffered.
    async function getClip(seconds, when, max = 120) {
        seconds = Math.max(5, Math.min(max, Number(seconds) || 30));
        if (when !== 'next') {
            radio.touch();
            const clip = radio.recent(seconds);
            if (clip && clip.pcm.length >= clip.sampleRate * Math.min(5, seconds)) return clip;
        }
        return radio.next(seconds);
    }

    async function decodeCwAudio({ seconds = 60, when = 'past' } = {}) {
        const tuning = { ...radio.tuning };
        const clip = await getClip(seconds, when, 300);
        const result = decodeCw(clip.pcm, clip.sampleRate);
        const hint = ['cwu', 'cwl'].includes(tuning.mode) ? {} : { hint: `Tuned in ${tuning.mode.toUpperCase()}; CW decodes best in CWU/CWL mode.` };
        return { frequencyKhz: tuning.frequency / 1000, mode: tuning.mode, seconds: +(clip.pcm.length / clip.sampleRate).toFixed(1), ...result, ...hint };
    }

    // ---------- settings ----------
    // Model choices live in the store; API keys live in the environment and are
    // only ever shown masked.

    function checkSettings(s) {
        if (!s) return structuredClone(DEFAULT_SETTINGS);
        return {
            primary: validChoice(s.primary) ? s.primary : DEFAULT_SETTINGS.primary,
            fallback: s.fallback === null ? null : validChoice(s.fallback) ? s.fallback : DEFAULT_SETTINGS.fallback,
        };
    }
    let settings = checkSettings(await store.getJson('settings'));

    function settingsView() {
        return {
            ...settings,
            providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, {
                name: p.name, keyUrl: p.keyUrl, key: maskKey(process.env[p.keyEnv]), hasKey: !!process.env[p.keyEnv], models: p.models,
            }])),
        };
    }

    async function saveSettings(next) {
        if (!validChoice(next.primary)) throw new Error('Choose a valid first-choice model.');
        if (next.fallback !== null && !validChoice(next.fallback)) throw new Error('Choose a valid fallback model, or none.');
        settings = { primary: next.primary, fallback: next.fallback };
        await store.putJson('settings', settings);
        return settingsView();
    }

    async function setProviderKey(providerId, key) {
        const p = PROVIDERS[providerId];
        if (!p) throw new Error('Unknown provider.');
        key = String(key || '').trim();
        if (key && !/^[\w.:-]{8,200}$/.test(key)) throw new Error('That does not look like an API key.');
        await store.setSecret(p.keyEnv, key);
        return settingsView();
    }

    // Try one model on the most recent saved clip.
    async function testModel(choice) {
        const latest = await store.latestFile('clips');
        if (!latest) throw new Error('No saved clips yet. Transcribe something first, then test.');
        const t0 = Date.now();
        const r = await callModel(choice, latest.bytes, {});
        return { ...r, ms: Date.now() - t0, clip: latest.name };
    }

    const transcribeAudio = (audio, opts) => transcribeWith(audio, opts, settings);

    // Transcribe a clip, keep its audio, and add it to the transcript log.
    async function transcribeClip(clip, tuning, snrDb, opts) {
        const audio = wav(clip.pcm, clip.sampleRate);
        const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.round(tuning.frequency / 1000);
        await store.putFile('clips', `${id}.wav`, audio);
        const { text, language, english, engine } = await transcribeAudio(audio, opts);
        const entry = {
            id, time: new Date().toISOString(),
            frequency: tuning.frequency, mode: tuning.mode,
            seconds: +(clip.pcm.length / clip.sampleRate).toFixed(1),
            snrDb, text, language, english, engine, clip: `/api/clips/${id}.wav`,
        };
        await store.appendTranscript(entry);
        events.emit('transcript', entry);
        return entry;
    }

    async function transcribe({ seconds = 30, when = 'past', language, prompt } = {}) {
        const tuning = { ...radio.tuning };
        const clip = await getClip(seconds, when);
        return transcribeClip(clip, tuning, radio.snapshot().snrDb, { language, prompt });
    }

    // Judge several frequencies quickly:
    //   1. one spectrum snapshot skips frequencies with nothing on them;
    //   2. stations within IQ_CLUSTER_HZ of each other share one wideband IQ
    //      recording and are demodulated here, all at once;
    //   3. the rest are tuned one at a time.
    // Transcription runs in parallel with the recording. The original tuning is
    // restored at the end, since the receiver is shared with whoever is listening.
    const IQ_CLUSTER_HZ = 80000;
    const PRESCREEN_DB = 10;

    async function sample({ frequencies = [], seconds = 10, language, prescreen: screen = true } = {}) {
        if (!frequencies.length) throw new Error('Give at least one frequency.');
        if (frequencies.length > 12) throw new Error('At most 12 frequencies per call.');
        seconds = Math.max(8, Math.min(60, Number(seconds) || 10));
        const started = Date.now();
        const original = { ...radio.tuning };
        const items = frequencies.map((f, idx) => ({
            idx, hz: Math.round((typeof f === 'number' ? f : f.khz) * 1000),
            mode: (typeof f === 'object' && f.mode) || (original.mode === 'iq96' ? 'am' : original.mode),
        }));
        for (const it of items) if (!MODES[it.mode] || it.mode === 'iq96') throw new Error(`Unsupported mode "${it.mode}" for sampling.`);

        // 1. Pre-screen from the spectrum.
        const levels = screen ? await prescreen(items) : new Map();
        const results = new Array(items.length);
        const live = [];
        for (const it of items) {
            it.levelDb = levels.get(it.idx);
            if (it.levelDb != null && it.levelDb < PRESCREEN_DB) {
                results[it.idx] = { frequencyKhz: it.hz / 1000, mode: it.mode, levelDb: it.levelDb, skipped: 'no signal' };
            } else live.push(it);
        }

        // 2. Group what is left. Only AM and SSB can be demodulated from IQ here.
        live.sort((a, b) => a.hz - b.hz);
        const groups = [];
        for (const it of live) {
            const g = groups.at(-1);
            const iqOk = ['am', 'sam', 'usb', 'lsb'].includes(it.mode);
            if (g && g.iq && iqOk && it.hz - g.items[0].hz <= IQ_CLUSTER_HZ) g.items.push(it);
            else groups.push({ iq: iqOk, items: [it] });
        }

        const pending = [];
        const finish = (it, clip, snrDb, via) => {
            pending.push(transcribeClip(clip, { frequency: it.hz, mode: it.mode }, snrDb, { language })
                .then((e) => { results[it.idx] = { frequencyKhz: it.hz / 1000, mode: it.mode, levelDb: it.levelDb, via, language: e.language, text: e.text || '(no speech recognized)', english: e.english }; })
                .catch((err) => { results[it.idx] = { frequencyKhz: it.hz / 1000, mode: it.mode, levelDb: it.levelDb, via, error: err.message }; }));
        };

        try {
            for (const g of groups) {
                if (g.iq && g.items.length > 1) {
                    // 3a. One IQ recording, every station in it demodulated locally.
                    const lo = g.items[0].hz, hi = g.items.at(-1).hz;
                    const center = Math.round((lo + hi) / 2);
                    const { i, q, rate } = await recordIq(center, seconds);
                    for (const it of g.items) finish(it, { pcm: demodulate(i, q, rate, it.hz - center, it.mode), sampleRate: AUDIO_RATE }, it.levelDb, 'iq');
                } else {
                    // 3b. A lone station: tune to it normally.
                    for (const it of g.items) {
                        radio.tune({ frequency: it.hz, mode: it.mode });
                        const clip = await radio.next(seconds);
                        finish(it, clip, radio.snapshot().snrDb, 'tuned');
                    }
                }
            }
        } finally {
            radio.tune(original);
        }
        await Promise.all(pending);
        return {
            seconds, totalSeconds: Math.round((Date.now() - started) / 1000),
            note: 'levelDb is the signal peak above the noise floor from a pre-scan; frequencies under 10 dB were skipped.',
            results,
        };
    }

    // Peak level above the noise floor for each frequency, from short spectrum
    // snapshots (one per 4 MHz stretch). Returns Map idx -> dB, or no entry if the
    // snapshot failed (then the frequency is sampled anyway).
    async function prescreen(items) {
        const out = new Map();
        const sorted = [...items].sort((a, b) => a.hz - b.hz);
        const spans = [];
        for (const it of sorted) {
            const s = spans.at(-1);
            if (s && it.hz - s[0].hz <= 4e6) s.push(it); else spans.push([it]);
        }
        for (const s of spans) {
            const lo = s[0].hz, hi = s.at(-1).hz;
            try {
                const cap = await spectrum.capture({ centerHz: (lo + hi) / 2, spanHz: Math.max(50000, hi - lo + 40000), seconds: 2 });
                const n = cap.rows[0].length;
                const avg = new Float32Array(n), peak = new Float32Array(n).fill(-300);
                for (const r of cap.rows) for (let k = 0; k < n; k++) { avg[k] += r[k] / cap.rows.length; if (r[k] > peak[k]) peak[k] = r[k]; }
                const floor = [...avg].sort((a, b) => a - b)[n >> 1];
                for (const it of s) {
                    // Look across the station's own passband (AM ±5 kHz, SSB 0-3 kHz on its side).
                    const [bl, bh] = it.mode === 'usb' ? [0, 3000] : it.mode === 'lsb' ? [-3000, 0] : it.mode.startsWith('cw') ? [-500, 500] : [-5000, 5000];
                    const a = Math.max(0, Math.floor((it.hz + bl - cap.startHz) / cap.binHz));
                    const b = Math.min(n - 1, Math.ceil((it.hz + bh - cap.startHz) / cap.binHz));
                    let best = -300;
                    for (let k = a; k <= b; k++) best = Math.max(best, peak[k]);
                    if (b >= a) out.set(it.idx, +(best - floor).toFixed(1));
                }
            } catch (e) {
                console.log(`prescreen failed: ${e.message}`);
            }
        }
        return out;
    }

    // Record `seconds` of wideband IQ around `center` on the app's audio session.
    async function recordIq(center, seconds) {
        radio.touch();
        radio.tune({ frequency: center, mode: 'iq96', bandwidthLow: -48000, bandwidthHigh: 48000 });
        const I = [], Q = [];
        let rate = 0, have = 0, settle = 0;
        await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => { radio.off('iq', onIq); have > 0 ? resolve() : reject(new Error('No IQ data arrived from the receiver.')); }, (seconds + 15) * 1000);
            function onIq(planes, r) {
                // Skip the first 0.3 s: frames still in flight from before the retune.
                if (settle < r * 0.3) { settle += planes[0].length; return; }
                rate = r; I.push(planes[0]); Q.push(planes[1]); have += planes[0].length;
                if (have >= seconds * r) { clearTimeout(deadline); radio.off('iq', onIq); resolve(); }
            }
            radio.on('iq', onIq);
        });
        const cat = (parts) => { const o = new Float32Array(have); let p = 0; for (const x of parts) { o.set(x.subarray(0, Math.min(x.length, have - p)), p); p += x.length; if (p >= have) break; } return o; };
        return { i: cat(I), q: cat(Q), rate };
    }

    // ---------- live captions ----------
    // While on, every `chunk` seconds of new audio on the current tuning is sent to
    // Whisper, and the text is kept in a rolling log the page and Claude read from.
    // Retuning starts a fresh chunk. It switches itself off after `minutes`.

    const live = { on: false, chunk: 15, until: 0, cursor: null, mark: null, seq: 0, entries: [], language: undefined, timer: null };

    function liveState() {
        return { on: live.on, chunkSeconds: live.chunk, minutesLeft: live.on ? Math.max(0, Math.round((live.until - Date.now()) / 60000)) : 0, latestSeq: live.seq };
    }

    function startLive({ chunkSeconds = 15, minutes = 10, language } = {}) {
        live.chunk = Math.max(8, Math.min(30, Number(chunkSeconds) || 15));
        live.until = Date.now() + Math.max(1, Math.min(120, Number(minutes) || 10)) * 60000;
        live.language = language;
        live.cursor = null;
        if (!live.on) {
            live.on = true;
            live.timer = setInterval(liveTick, 500);
        }
        radio.touch();
        events.emit('live-state', liveState());
        return liveState();
    }

    function stopLive() {
        live.on = false;
        clearInterval(live.timer);
        events.emit('live-state', liveState());
        return liveState();
    }

    function liveTick() {
        if (Date.now() > live.until) { stopLive(); return; }
        radio.lastUse = Date.now();
        radio.ensure();
        if (!radio.ring) return;
        // A retune (or a sample-rate change) restarts the chunking from that point.
        if (live.cursor === null || live.mark !== radio.tuneMark || live.cursor > radio.written) {
            live.cursor = Math.max(radio.tuneMark, radio.written);
            live.mark = radio.tuneMark;
            return;
        }
        const need = live.chunk * radio.sampleRate;
        if (radio.written - live.cursor < need) return;
        const clip = radio._slice(live.cursor, live.cursor + need);
        live.cursor += need;
        const tuning = { ...radio.tuning }, snrDb = radio.snapshot().snrDb;
        const prev = live.entries.at(-1);
        const prompt = prev && prev.frequency === tuning.frequency ? `${DEFAULT_PROMPT} Previous: ${prev.text.slice(-200)}` : undefined;
        const seq = ++live.seq;
        const startedAt = new Date(Date.now() - live.chunk * 1000).toISOString();
        transcribeAudio(wav(clip.pcm, clip.sampleRate), { language: live.language, prompt })
            .then(({ text, language, english }) => {
                const entry = { seq, time: startedAt, frequency: tuning.frequency, mode: tuning.mode, snrDb, language, text, english };
                live.entries.push(entry);
                if (live.entries.length > 400) live.entries.shift();
                events.emit('live', entry);
            })
            .catch((e) => console.log(`live caption ${seq} failed: ${e.message}`));
    }

    function readLive({ since = 0, limit = 20 } = {}) {
        const entries = live.entries.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq).slice(-limit);
        return { ...liveState(), entries };
    }

    // ---------- receiver data ----------

    let activeCache = { at: 0, data: null };
    async function activeSignals({ minConfidence = 0.6, band } = {}) {
        if (Date.now() - activeCache.at > 20000) {
            const res = await receiverFetch(`https://${SDR_HOST}/api/noisefloor/voice-activity/all?min_confidence=0.3`);
            if (!res.ok) throw new Error(`Receiver voice-activity request failed (${res.status}).`);
            activeCache = { at: Date.now(), data: await res.json() };
        }
        const out = [];
        for (const [name, list] of Object.entries(activeCache.data.bands || {})) {
            if (band && name.toLowerCase() !== String(band).toLowerCase()) continue;
            for (const s of list || []) {
                if ((s.confidence ?? 0) < minConfidence) continue;
                out.push({
                    band: name,
                    frequency: s.estimated_dial_freq || s.center_freq,
                    mode: String(s.mode || 'usb').toLowerCase(),
                    snrDb: +(s.snr ?? 0).toFixed(1),
                    confidence: +(s.confidence ?? 0).toFixed(2),
                    bandwidthHz: s.bandwidth,
                });
            }
        }
        // The same transmission is often reported twice a few hundred Hz apart.
        out.sort((a, b) => b.snrDb - a.snrDb);
        const kept = [];
        for (const s of out) if (!kept.some((k) => Math.abs(k.frequency - s.frequency) < 1500)) kept.push(s);
        return { updated: new Date(activeCache.at).toISOString(), signals: kept };
    }

    const spectrum = new SpectrumFeed({ host: SDR_HOST, radio, openSocket });
    const spots = new SpotFeed({ host: SDR_HOST, radio, openSocket });

    const clampSpan = (khz) => Math.max(2, Math.min(30000, Number(khz) || 50)) * 1000;

    // A waterfall image around a frequency, plus the signals found in it.
    async function waterfall({ centerKhz, spanKhz = 50, seconds = 8 } = {}) {
        const centerHz = (Number(centerKhz) || radio.tuning.frequency / 1000) * 1000;
        const cap = await spectrum.capture({ centerHz, spanHz: clampSpan(spanKhz), seconds: Math.max(2, Math.min(30, Number(seconds) || 8)) });
        const analysis = findSignals(cap);
        const t = radio.tuning;
        const { png, axis } = renderWaterfall({
            rows: cap.rows, startHz: cap.startHz, binHz: cap.binHz, floorDb: analysis.noiseFloorDb,
            marker: t.frequency, bandwidth: [t.bandwidthLow, t.bandwidthHigh],
            rowHeight: Math.max(1, Math.round(240 / cap.rows.length)),
        });
        const id = new Date().toISOString().replace(/[:.]/g, '-');
        await store.putFile('waterfalls', `${id}.png`, png);
        return {
            png,
            info: {
                image: `/api/waterfalls/${id}.png`,
                startKhz: axis.startHz / 1000, endKhz: axis.endHz / 1000, seconds: cap.rows.length / 10,
                rows: cap.rows.length, tunedKhz: t.frequency / 1000, tunedMode: t.mode,
                legend: 'Newest at top; x axis kHz; pink dashed line = current tuning; colour 0-40 dB above noise.',
                ...analysis,
            },
        };
    }

    async function scan({ startKhz, endKhz, seconds = 6, thresholdDb } = {}) {
        const a = Number(startKhz) * 1000, b = Number(endKhz) * 1000;
        if (!(b > a)) throw new Error('end_khz must be above start_khz.');
        const cap = await spectrum.capture({ centerHz: (a + b) / 2, spanHz: b - a, seconds: Math.max(2, Math.min(30, Number(seconds) || 6)) });
        const r = findSignals(cap, { thresholdDb: Number(thresholdDb) || 8, limit: 60 });
        r.signals = r.signals.filter((s) => s.frequencyKhz * 1000 >= a && s.frequencyKhz * 1000 <= b);
        return { rangeKhz: [a / 1000, b / 1000], ...r };
    }

    async function receiverJson(p) {
        const res = await receiverFetch(`https://${SDR_HOST}${p}`);
        if (!res.ok) throw new Error(`Receiver request ${p} failed (${res.status}).`);
        return res.json();
    }

    // Call sign lookup through the receiver: the prefix table (country, zones) and,
    // when available, the license record the receiver fetches for its listeners.
    // Only what helps identify a station is passed on; home coordinates, county,
    // phone area code and photos are dropped. Cached for a day.
    const callCache = new Map();

    // The record's "QSL manager" field holds either a manager's call sign or free
    // text listing methods; the flags add methods it may not mention.
    function qslRoutes(r) {
        const parts = [];
        const mgr = String(r.qslmgr || '').trim();
        if (/^[A-Z0-9/]{3,15}$/i.test(mgr) && /\d/.test(mgr)) parts.push(`via ${mgr.toUpperCase()}`);
        else if (mgr) parts.push(mgr);
        const text = mgr.toUpperCase();
        if (r.lotw === '1' && !text.includes('LOTW')) parts.push('LoTW');
        if (r.eqsl === '1' && !text.includes('EQSL')) parts.push('eQSL');
        if (r.mqsl === '1' && !text.includes('DIRECT')) parts.push('direct mail');
        return parts.join(', ') || undefined;
    }
    async function callsignLookup(call) {
        call = String(call || '').trim().toUpperCase();
        if (!/^[A-Z0-9/]{3,15}$/.test(call) || !/\d/.test(call)) throw new Error('That does not look like a call sign.');
        const hit = callCache.get(call);
        if (hit && Date.now() - hit.at < 86400000) return hit.data;

        const out = { call };
        try {
            const p = await receiverJson(`/api/cty/lookup?callsign=${encodeURIComponent(call)}`);
            if (p.success && p.data) {
                const d = p.data;
                out.prefix = { entity: d.country, continent: d.continent, cqZone: d.cq_zone, ituZone: d.itu_zone, timezone: d.timezone, utcOffset: d.time_offset };
            }
        } catch { /* prefix table unavailable */ }
        try {
            // The receiver only answers for a session with its audio connected.
            radio.touch();
            for (let t = 0; t < 40 && radio.status !== 'live'; t++) await new Promise((r) => setTimeout(r, 250));
            const r = await receiverJson(`/api/lookup?callsign=${encodeURIComponent(call)}&uuid=${radio.sessionId}`);
            if (r && !r.error && r.call) {
                out.license = {
                    name: r.name_fmt || [r.fname, r.name].filter(Boolean).join(' ') || undefined,
                    town: r.addr2 || undefined,
                    state: r.state || undefined,
                    country: r.country || undefined,
                    operatingFrom: r.land && r.land !== r.country ? r.land : undefined,
                    grid: r.grid || undefined,
                    licenseClass: r.class || undefined,
                    expires: r.expdate || undefined,
                    timezone: r.tz_iana || undefined,
                    born: r.born ? Number(r.born) : undefined,
                    qsl: qslRoutes(r),
                };
            } else if (r?.error) {
                out.licenseNote = r.error;
            }
        } catch (e) {
            out.licenseNote = `Full lookup unavailable: ${e.message}`;
        }
        if (!out.prefix && !out.license) throw new Error(`Nothing found for ${call}.`);
        // Keep only complete answers, so a temporary failure is retried next time.
        if (out.license) callCache.set(call, { at: Date.now(), data: out });
        return out;
    }

    async function conditions() {
        const w = await receiverJson('/api/spaceweather');
        const { solar_flux, k_index, k_index_status, a_index, propagation_quality, band_conditions_day, band_conditions_night, forecast } = w;
        return { solarFlux: solar_flux, kIndex: k_index, kStatus: k_index_status, aIndex: a_index, overall: propagation_quality, bandsDay: band_conditions_day, bandsNight: band_conditions_night, forecast };
    }

    async function dxpeditions({ activeOnly = true } = {}) {
        const d = await receiverJson('/api/dxpeditions');
        return (d.entries || [])
            .filter((e) => !activeOnly || e.active)
            .map((e) => ({ call: e.call, place: e.entity, dates: e.dates, active: e.active, bands: e.bands, modes: e.modes, info: e.info }));
    }

    // ---------- HTTP API ----------
    // route() answers one API request. It returns { status, json } or
    // { status, bytes, type }, or null when the path is not part of the API.
    // `body` is an async function giving the parsed JSON body.

    async function route({ method, pathname, query, body }) {
        const ok = (json) => ({ status: 200, json });
        try {
            if (pathname === '/api/settings' && method === 'GET') return ok(settingsView());
            if (pathname === '/api/settings' && method === 'POST') return ok(await saveSettings(await body()));
            if (pathname === '/api/settings/key' && method === 'POST') {
                const b = await body();
                return ok(await setProviderKey(b.provider, b.key));
            }
            if (pathname === '/api/settings/test' && method === 'POST') return ok(await testModel(await body()));
            if (pathname === '/api/health') return ok({ ok: true });
            if (pathname === '/api/status') return ok(radio.snapshot());
            if (pathname === '/api/connect' && method === 'POST') { radio.touch(); return ok(radio.snapshot()); }
            if (pathname === '/api/tune' && method === 'POST') {
                const b = await body();
                radio.touch();
                return ok(radio.tune(b));
            }
            if (pathname === '/api/active') {
                return ok(await activeSignals({
                    minConfidence: Number(query.get('min_confidence') || 0.6),
                    band: query.get('band') || undefined,
                }));
            }
            if (pathname === '/api/transcribe' && method === 'POST') return ok(await transcribe(await body()));
            if (pathname === '/api/transcripts') return ok(await store.readTranscripts(Number(query.get('limit') || 20)));
            if (pathname === '/api/sample' && method === 'POST') return ok(await sample(await body()));
            if (pathname === '/api/live' && method === 'POST') {
                const b = await body();
                return ok(b.on === false ? stopLive() : startLive({ chunkSeconds: b.chunk_seconds, minutes: b.minutes, language: b.language }));
            }
            if (pathname === '/api/live') {
                return ok(readLive({ since: Number(query.get('since') || 0), limit: Number(query.get('limit') || 20) }));
            }
            if (pathname === '/api/decode-cw' && method === 'POST') return ok(await decodeCwAudio(await body()));
            if (pathname === '/api/waterfall' && method === 'POST') {
                const b = await body();
                const { png, info } = await waterfall({ centerKhz: b.center_khz, spanKhz: b.span_khz, seconds: b.seconds });
                return ok({ ...info, pngBase64: png.toString('base64') });
            }
            if (pathname === '/api/scan' && method === 'POST') {
                const b = await body();
                return ok(await scan({ startKhz: b.start_khz, endKhz: b.end_khz, seconds: b.seconds, thresholdDb: b.threshold_db }));
            }
            if (pathname === '/api/spots') {
                return ok(await spots.query({
                    kind: query.get('kind') || 'dx', band: query.get('band') || undefined, callsign: query.get('callsign') || undefined,
                    mode: query.get('mode') || undefined, minutes: Number(query.get('minutes') || 30), limit: Number(query.get('limit') || 40),
                }));
            }
            if (pathname === '/api/conditions') return ok(await conditions());
            if (pathname === '/api/callsign') return ok(await callsignLookup(query.get('call')));
            if (pathname === '/api/dxpeditions') return ok(await dxpeditions({ activeOnly: query.get('all') !== '1' }));
            if (pathname === '/api/bookmarks') return ok(await receiverJson('/api/bookmarks'));
            const file = pathname.match(/^\/api\/(clips|waterfalls)\/([\w-]+\.(wav|png))$/);
            if (file) {
                const bytes = await store.getFile(file[1], file[2]);
                if (!bytes) return { status: 404, json: { error: 'No such file.' } };
                return { status: 200, bytes, type: file[3] === 'wav' ? 'audio/wav' : 'image/png' };
            }
            if (pathname.startsWith('/api/')) return { status: 404, json: { error: 'Not found.' } };
            return null;
        } catch (e) {
            return { status: 400, json: { error: e.message } };
        }
    }

    // ---------- browser streams ----------
    // A page socket is passed in as { send(data), open(), buffered(),
    // onMessage(fn(text)), onClose(fn) }, so either platform's WebSocket fits.

    // Live waterfall for the page: rows pooled to 1024 columns of dB+256 (uint8),
    // each prefixed by start Hz and Hz per column (two float64), at up to 10/s.
    // The view follows the tuned frequency; the page picks the span.
    function attachSpectrum(ws) {
        const COLS = 1024;
        let spanHz = 100000;
        spectrum.viewers++;
        const follow = () => spectrum.setView(radio.tuning.frequency, spanHz / (spectrum.config?.binCount || 2048));
        const onRow = ({ row, startHz, binHz }) => {
            if (!ws.open() || ws.buffered() > 1 << 18) return;
            const pool = row.length / COLS;
            const buf = Buffer.alloc(16 + COLS);
            buf.writeDoubleLE(startHz, 0); buf.writeDoubleLE(binHz * pool, 8);
            for (let x = 0; x < COLS; x++) {
                let m = -256;
                for (let i = Math.floor(x * pool); i < Math.floor((x + 1) * pool); i++) if (row[i] > m) m = row[i];
                buf[16 + x] = Math.max(0, Math.min(255, Math.round(m + 256)));
            }
            ws.send(buf);
        };
        const onStatus = () => { if (spectrum.busy === 0 && Math.abs(spectrum.view.frequency - radio.tuning.frequency) > 1) follow(); };
        spectrum.on('row', onRow);
        radio.on('status', onStatus);
        follow();
        spectrum.ensure().catch((e) => ws.open() && ws.send(JSON.stringify({ type: 'error', error: e.message })));
        ws.onMessage((data) => {
            let m; try { m = JSON.parse(data); } catch { return; }
            if (m.type === 'span' && m.spanHz > 0) { spanHz = Math.max(2000, Math.min(30e6, m.spanHz)); follow(); }
        });
        ws.onClose(() => {
            spectrum.off('row', onRow);
            radio.off('status', onStatus);
            spectrum.viewers--;
            spectrum.release();
        });
    }

    function attachStream(ws) {
        let listening = false;
        const json = (o) => ws.open() && ws.send(JSON.stringify(o));
        const onStatus = () => json({ type: 'status', ...radio.snapshot() });
        const onPcm = (pcm) => { if (listening && ws.open() && ws.buffered() < 1 << 20) ws.send(pcm); };
        const onTranscript = (t) => json({ type: 'transcript', entry: t });
        const onLive = (e) => json({ type: 'live', entry: e });
        const onLiveState = (s) => json({ type: 'live-state', ...s });
        radio.on('status', onStatus); radio.on('pcm', onPcm); events.on('transcript', onTranscript);
        events.on('live', onLive); events.on('live-state', onLiveState);
        const meter = setInterval(onStatus, 1000);
        onStatus();
        onLiveState(liveState());
        for (const e of live.entries.slice(-8)) onLive(e);
        ws.onMessage((data) => {
            let m; try { m = JSON.parse(data); } catch { return; }
            if (m.type === 'listen') {
                if (m.on && !listening) { listening = true; radio.listeners++; radio.touch(); }
                if (!m.on && listening) { listening = false; radio.listeners--; radio.lastUse = Date.now(); }
                onStatus();
            }
        });
        ws.onClose(() => {
            clearInterval(meter);
            radio.off('status', onStatus); radio.off('pcm', onPcm); events.off('transcript', onTranscript);
            events.off('live', onLive); events.off('live-state', onLiveState);
            if (listening) { radio.listeners--; radio.lastUse = Date.now(); }
        });
    }

    // Whether anything still needs this process kept running: a receiver
    // socket, a pending reconnect, or live captions.
    const busy = () => !!(radio.ws || radio.retryTimer || radio.wanted || spectrum.ws || spots.ws || live.on);

    return { host: SDR_HOST, radio, spectrum, spots, route, attachStream, attachSpectrum, busy };
}
