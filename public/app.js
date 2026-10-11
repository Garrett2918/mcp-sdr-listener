const $ = (id) => document.getElementById(id);
const MODES = ['am', 'sam', 'usb', 'lsb', 'cwu', 'cwl', 'nfm', 'fm'];
const BANDS = [
    ['160m', 1900000, 'lsb'], ['75m AM', 3873000, 'am'], ['80m', 3750000, 'lsb'], ['60m', 5357000, 'usb'],
    ['49m BC', 6000000, 'am'], ['40m', 7200000, 'lsb'], ['31m BC', 9650000, 'am'], ['20m', 14250000, 'usb'],
    ['17m', 18140000, 'usb'], ['15m', 21300000, 'usb'], ['12m', 24960000, 'usb'], ['10m', 28400000, 'usb'],
];

// wss:// when the page itself came over HTTPS (served publicly behind a proxy).
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

let state = { frequency: 3873000, mode: 'am', bandwidthLow: -5000, bandwidthHigh: 5000 };
let ws = null, ctx = null, node = null, listening = false, gain = 0.8;

// ---------- server stream ----------

function connect() {
    ws = new WebSocket(`${WS_BASE}/stream`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (listening) ws.send(JSON.stringify({ type: 'listen', on: true })); };
    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) { play(new Int16Array(e.data)); return; }
        const m = JSON.parse(e.data);
        if (m.type === 'status') renderStatus(m);
        if (m.type === 'transcript') addEntry(m.entry, true);
        if (m.type === 'live') addCaption(m.entry);
        if (m.type === 'live-state') renderLive(m);
    };
    ws.onclose = () => {
        renderStatus({ ...state, status: 'offline', message: 'Lost contact with the local server. Is server.js still running?' });
        setTimeout(connect, 2000);
    };
}

function renderStatus(s) {
    $('host').textContent = s.host || '';
    const chip = $('chip');
    chip.dataset.s = s.status;
    chip.textContent = s.status === 'idle' && !listening ? 'idle · press Listen' : s.status;
    const show = ['refused', 'reconnecting', 'offline'].includes(s.status) && s.message;
    $('notice').hidden = !show;
    if (show) $('notice').textContent = s.message;

    const changed = s.frequency !== state.frequency || s.mode !== state.mode;
    state = { frequency: s.frequency, mode: s.mode, bandwidthLow: s.bandwidthLow, bandwidthHigh: s.bandwidthHigh, sampleRate: s.sampleRate };
    if (document.activeElement !== $('freq')) $('freq').value = (s.frequency / 1000).toFixed(2);
    $('mode-read').textContent = s.mode.toUpperCase();
    $('bw-read').textContent = `BW ${((s.bandwidthHigh - s.bandwidthLow) / 1000).toFixed(1)} kHz`;
    $('snr-read').textContent = `S/N ${s.snrDb == null ? '--' : s.snrDb.toFixed(1) + ' dB'}`;
    $('buf-read').textContent = `buffer ${s.bufferedSeconds || 0} s`;
    $('meter').style.width = `${Math.max(0, Math.min(100, ((s.snrDb ?? 0) / 40) * 100))}%`;
    for (const b of $('modes').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === s.mode));
    if (changed) { markCurrent(); drawAxis(); }
}

// ---------- audio ----------

// Called from the Listen tap: iOS only starts audio inside a user gesture, so
// the context is created and resumed before anything is awaited, and never
// rebuilt afterwards (the worklet resamples whatever rate the stream has).
async function startAudio() {
    // iOS: play as media, so the ring/silent switch does not mute it.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    ctx = new AudioContext({ latencyHint: 'playback' });
    const resumed = ctx.resume();
    await ctx.audioWorklet.addModule('/player-worklet.js');
    await resumed;
    node = new AudioWorkletNode(ctx, 'radio-player', { outputChannelCount: [2] });
    node.port.postMessage({ gain });
    node.connect(ctx.destination);
}

function play(pcm) {
    if (!node) return;
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    node.port.postMessage({ pcm: f, rate: state.sampleRate || 12000 }, [f.buffer]);
}

$('play').onclick = async () => {
    listening = !listening;
    $('play').textContent = listening ? 'Stop' : 'Listen';
    if (listening) {
        await startAudio();
        ws?.send(JSON.stringify({ type: 'listen', on: true }));
    } else {
        ws?.send(JSON.stringify({ type: 'listen', on: false }));
        if (ctx) { await ctx.close(); ctx = null; node = null; }
    }
};

// Phones suspend audio when the page is hidden; pick up again on return.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && listening && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
});

$('vol').oninput = (e) => {
    gain = (e.target.value / 100) ** 2;
    node?.port.postMessage({ gain });
};

// ---------- tuning ----------

async function tune(next) {
    node?.port.postMessage({ flush: true });
    const res = await fetch('/api/tune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const body = await res.json();
    if (!res.ok) { $('notice').hidden = false; $('notice').textContent = body.error; return; }
    renderStatus({ ...body });
}

$('freq').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const khz = parseFloat($('freq').value.replace(',', '.'));
    if (Number.isFinite(khz)) tune({ frequency: Math.round(khz * 1000) });
    $('freq').blur();
});
$('freq').addEventListener('blur', () => { $('freq').value = (state.frequency / 1000).toFixed(2); });

let wheelTimer = null, wheelFreq = null;
$('freq').addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = (state.mode === 'am' || state.mode === 'sam' ? 1000 : 100) * (e.shiftKey ? 10 : 1);
    wheelFreq = (wheelFreq ?? state.frequency) + (e.deltaY < 0 ? step : -step);
    $('freq').value = (wheelFreq / 1000).toFixed(2);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { tune({ frequency: wheelFreq }); wheelFreq = null; }, 250);
}, { passive: false });

for (const b of document.querySelectorAll('[data-step]')) b.onclick = () => tune({ frequency: state.frequency + Number(b.dataset.step) });

for (const m of MODES) {
    const b = document.createElement('button');
    b.dataset.mode = m; b.textContent = m.toUpperCase(); b.setAttribute('aria-pressed', 'false');
    b.onclick = () => tune({ mode: m });
    $('modes').append(b);
}
for (const [label, f, mode] of BANDS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => tune({ frequency: f, mode });
    $('bands').append(b);
}

// ---------- active signals ----------

let signals = [];
async function loadSignals() {
    $('refresh').disabled = true;
    try {
        const band = $('band-filter').value;
        const res = await fetch(`/api/active?min_confidence=0.6${band ? '&band=' + encodeURIComponent(band) : ''}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        signals = body.signals;
        const bands = [...new Set(signals.map((s) => s.band))];
        const sel = $('band-filter');
        for (const name of bands) if (![...sel.options].some((o) => o.value === name)) sel.append(new Option(name, name));
        $('active-sub').textContent = `${signals.length} found · updated ${new Date(body.updated).toLocaleTimeString()}`;
        renderSignals();
    } catch (e) {
        $('signals-empty').hidden = false;
        $('signals-empty').textContent = `Could not load signals: ${e.message}`;
    } finally {
        $('refresh').disabled = false;
    }
}

function renderSignals() {
    const tb = $('signals');
    tb.replaceChildren();
    $('signals-empty').hidden = signals.length > 0;
    if (!signals.length) $('signals-empty').textContent = 'No voice signals detected right now. Try another band or lower the bar later.';
    for (const s of signals) {
        const tr = document.createElement('tr');
        tr.dataset.f = s.frequency;
        const cells = [s.band, (s.frequency / 1000).toFixed(1), s.mode.toUpperCase(), null, s.confidence.toFixed(2)];
        cells.forEach((c, i) => {
            const td = document.createElement('td');
            if (i === 3) {
                const n = document.createElement('span'); n.className = 'snr'; n.textContent = s.snrDb.toFixed(0);
                const bar = document.createElement('span'); bar.className = 'bar'; bar.style.width = `${Math.min(60, s.snrDb * 1.5)}px`;
                td.append(n, bar);
            } else td.textContent = c;
            tr.append(td);
        });
        tr.onclick = () => tune({ frequency: s.frequency, mode: s.mode });
        tb.append(tr);
    }
    markCurrent();
}

function markCurrent() {
    for (const tr of $('signals').children) tr.classList.toggle('current', Math.abs(Number(tr.dataset.f) - state.frequency) < 1500);
}

$('refresh').onclick = loadSignals;
$('band-filter').onchange = loadSignals;
setInterval(loadSignals, 60000);

// ---------- transcripts ----------

function addEntry(t, prepend) {
    if (document.querySelector(`[data-id="${t.id}"]`)) return;
    const el = document.createElement('article');
    el.className = 'entry'; el.dataset.id = t.id;
    const meta = document.createElement('div'); meta.className = 'entry-meta';
    const f = document.createElement('b'); f.textContent = `${(t.frequency / 1000).toFixed(1)} kHz ${t.mode.toUpperCase()}`;
    const when = document.createElement('span'); when.textContent = new Date(t.time).toLocaleString();
    const len = document.createElement('span'); len.textContent = `${t.seconds} s${t.snrDb != null ? ` · S/N ${t.snrDb} dB` : ''}`;
    const tuneLink = document.createElement('a'); tuneLink.href = '#'; tuneLink.textContent = 'Tune here';
    tuneLink.onclick = (e) => { e.preventDefault(); tune({ frequency: t.frequency, mode: t.mode }); };
    meta.append(f, when, len, tuneLink);
    const p = document.createElement('p');
    p.textContent = t.text || 'No speech recognized.';
    if (!t.text) p.className = 'blank';
    if (t.english) { const en = document.createElement('p'); en.className = 'en'; en.textContent = `${t.language ? t.language + ' → ' : ''}English: ${t.english}`; el.append(meta, p, en); }
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = t.clip;
    if (!t.english) el.append(meta, p);
    el.append(audio);
    $('log')[prepend ? 'prepend' : 'append'](el);
    $('log-empty').hidden = true;
}

async function loadTranscripts() {
    const list = await (await fetch('/api/transcripts?limit=50')).json();
    list.forEach((t) => addEntry(t, false));
    $('log-empty').hidden = list.length > 0;
}

for (const b of document.querySelectorAll('[data-tx]')) {
    b.onclick = async () => {
        const btns = document.querySelectorAll('[data-tx]');
        btns.forEach((x) => { x.disabled = true; });
        const sec = Number(b.dataset.sec);
        $('tx-busy').hidden = false;
        $('tx-busy').textContent = b.dataset.tx === 'next' ? `Recording the next ${sec} s, then transcribing…` : 'Transcribing…';
        try {
            const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds: sec, when: b.dataset.tx }) });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error);
            addEntry(body, true);
            $('tx-busy').hidden = true;
        } catch (e) {
            $('tx-busy').textContent = e.message;
        } finally {
            btns.forEach((x) => { x.disabled = false; });
        }
    };
}

// ---------- call sign lookup ----------

$('call-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const call = $('call-input').value.trim();
    if (!call) return;
    const out = $('call-result'), msg = $('call-msg');
    out.hidden = true; msg.hidden = false; msg.textContent = `Looking up ${call.toUpperCase()}…`;
    try {
        const res = await fetch(`/api/callsign?call=${encodeURIComponent(call)}`);
        const r = await res.json();
        if (!res.ok) throw new Error(r.error);
        const L = r.license || {}, P = r.prefix || {};
        const where = [L.town, L.state, L.country].filter(Boolean).join(', ');
        const rows = [
            ['Call', r.call, 'big'],
            ['Name', L.name],
            ['Born', L.born],
            ['From', where],
            ['Operating in', L.operatingFrom],
            ['Entity', P.entity && `${P.entity} (${P.continent}) · CQ ${P.cqZone} · ITU ${P.ituZone}`],
            ['Grid', L.grid],
            ['Local time', (L.timezone || P.timezone) && new Date().toLocaleTimeString([], { timeZone: L.timezone || P.timezone, hour: '2-digit', minute: '2-digit' }) + ` (${L.timezone || P.timezone})`],
            ['License', [L.licenseClass && `Class ${L.licenseClass}`, L.expires && `expires ${L.expires}`].filter(Boolean).join(', ')],
            ['QSL', L.qsl],
        ].filter(([, v]) => v);
        out.replaceChildren(...rows.flatMap(([k, v, cls]) => {
            const dt = document.createElement('dt'); dt.textContent = k;
            const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
            return [dt, dd];
        }));
        out.hidden = false;
        msg.hidden = !r.licenseNote;
        msg.textContent = r.licenseNote ? `License record: ${r.licenseNote}` : '';
    } catch (err) {
        msg.textContent = err.message;
    }
});

// ---------- live captions ----------

let liveOn = false;
function renderLive(s) {
    liveOn = s.on;
    $('live-toggle').setAttribute('aria-pressed', String(s.on));
    $('live-toggle').textContent = s.on ? 'Stop live captions' : 'Start live captions';
    $('live-state').textContent = s.on
        ? `On · ${s.chunkSeconds} s chunks · stops in ${s.minutesLeft} min`
        : '15 s chunks · stops after 10 min';
}

function addCaption(e) {
    const box = $('captions');
    if (box.querySelector(`[data-seq="${e.seq}"]`)) return;
    box.hidden = false;
    const p = document.createElement('p');
    p.dataset.seq = e.seq;
    const t = document.createElement('time');
    t.textContent = `${new Date(e.time).toLocaleTimeString()} · ${(e.frequency / 1000).toFixed(1)}`;
    p.append(t, document.createTextNode(e.text || '…'));
    if (e.english) { const en = document.createElement('span'); en.className = 'en'; en.textContent = ` — ${e.english}`; p.append(en); }
    // Keep chunks in order even if transcriptions finish out of order.
    const after = [...box.children].find((c) => Number(c.dataset.seq) > e.seq);
    box.insertBefore(p, after || null);
    while (box.children.length > 60) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
}

$('live-toggle').onclick = async () => {
    const res = await fetch('/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !liveOn }) });
    renderLive(await res.json());
};

// ---------- waterfall ----------

const STOPS = [[0, [4, 8, 30]], [0.25, [20, 40, 160]], [0.45, [0, 170, 220]], [0.65, [240, 230, 40]], [0.85, [240, 60, 30]], [1, [255, 255, 255]]];
const LUT = new Uint8Array(256 * 3);
for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < STOPS.length - 1 && t > STOPS[k][0]) k++;
    const [t0, a] = STOPS[k - 1], [t1, b] = STOPS[k], f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let c = 0; c < 3; c++) LUT[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
}

const wf = $('wf'), wfx = wf.getContext('2d');
wf.width = 1024;
const axis = $('wf-axis'), ax = axis.getContext('2d');
let wfView = { startHz: 0, hzPerCol: 0 }, wfFloor = null, wfPaused = false, wfSock = null, wfRow = 0;

function wfConnect() {
    wfSock = new WebSocket(`${WS_BASE}/spectrum`);
    wfSock.binaryType = 'arraybuffer';
    wfSock.onopen = () => wfSock.send(JSON.stringify({ type: 'span', spanHz: Number($('wf-span').value) }));
    wfSock.onmessage = (e) => {
        if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.error) $('wf-sub').textContent = m.error; return; }
        const dv = new DataView(e.data);
        const startHz = dv.getFloat64(0, true), hzPerCol = dv.getFloat64(8, true);
        const vals = new Uint8Array(e.data, 16);
        if (startHz !== wfView.startHz || hzPerCol !== wfView.hzPerCol) { wfView = { startHz, hzPerCol }; drawAxis(); }
        if (!wfPaused) drawRow(vals);
    };
    wfSock.onclose = () => setTimeout(wfConnect, 3000);
}

function drawRow(vals) {
    const sorted = Array.from(vals).sort((a, b) => a - b);
    const f = sorted[Math.floor(sorted.length * 0.2)];
    wfFloor = wfFloor == null ? f : wfFloor * 0.95 + f * 0.05;
    const lo = wfFloor - 3, span = 43;
    wfx.drawImage(wf, 0, 1);
    const img = wfx.createImageData(1024, 1);
    for (let x = 0; x < 1024; x++) {
        const i = Math.max(0, Math.min(255, Math.round(((vals[x] - lo) / span) * 255))) * 3;
        img.data[x * 4] = LUT[i]; img.data[x * 4 + 1] = LUT[i + 1]; img.data[x * 4 + 2] = LUT[i + 2]; img.data[x * 4 + 3] = 255;
    }
    // Dashed marker at the tuned frequency.
    const mx = Math.round((state.frequency - wfView.startHz) / wfView.hzPerCol);
    if (mx >= 0 && mx < 1024 && (wfRow++ >> 2) % 2 === 0) img.data.set([255, 80, 200, 255], mx * 4);
    wfx.putImageData(img, 0, 0);
}

function niceStep(span, maxTicks) {
    const raw = span / maxTicks, p = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
}

function drawAxis() {
    const dpr = window.devicePixelRatio || 1;
    axis.width = axis.clientWidth * dpr; axis.height = 22 * dpr;
    ax.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = axis.clientWidth, cs = getComputedStyle(document.documentElement);
    ax.clearRect(0, 0, W, 22);
    if (!wfView.hzPerCol) return;
    const span = wfView.hzPerCol * 1024, xOf = (hz) => ((hz - wfView.startHz) / span) * W;
    const step = niceStep(span, Math.max(3, Math.floor(W / 90)));
    ax.font = `11px ${cs.getPropertyValue('--mono')}`;
    ax.fillStyle = cs.getPropertyValue('--lcd-fg');
    ax.textAlign = 'center';
    for (let hz = Math.ceil(wfView.startHz / step) * step; hz <= wfView.startHz + span; hz += step) {
        const x = xOf(hz);
        ax.fillRect(x, 16, 1, 6);
        ax.fillText((hz / 1000).toFixed(step < 1000 ? 1 : 0), Math.min(W - 24, Math.max(24, x)), 12);
    }
    // Passband of the current tuning.
    ax.fillStyle = 'rgba(255, 80, 200, .85)';
    const a = xOf(state.frequency + state.bandwidthLow), b = xOf(state.frequency + state.bandwidthHigh);
    ax.fillRect(Math.min(a, b), 18, Math.max(2, Math.abs(b - a)), 4);
    $('wf-sub').textContent = `${(wfView.startHz / 1000).toFixed(1)}–${((wfView.startHz + span) / 1000).toFixed(1)} kHz · click a signal to tune`;
}

// Clicking a signal tunes to it. Sideband signals sit beside their dial
// frequency, so the click on the voice is shifted back to where the dial goes.
wf.addEventListener('click', (e) => {
    if (!wfView.hzPerCol) return;
    const r = wf.getBoundingClientRect();
    let hz = wfView.startHz + ((e.clientX - r.left) / r.width) * wfView.hzPerCol * 1024;
    if (state.mode === 'usb') hz -= 1400;
    else if (state.mode === 'lsb') hz += 1400;
    const grid = ['am', 'sam'].includes(state.mode) ? 1000 : ['usb', 'lsb'].includes(state.mode) ? 500 : 10;
    tune({ frequency: Math.round(hz / grid) * grid });
});

$('wf-span').onchange = () => wfSock?.readyState === 1 && wfSock.send(JSON.stringify({ type: 'span', spanHz: Number($('wf-span').value) }));
$('wf-toggle').onclick = () => { wfPaused = !wfPaused; $('wf-toggle').textContent = wfPaused ? 'Resume' : 'Pause'; };
window.addEventListener('resize', drawAxis);

connect();
wfConnect();
loadSignals();
loadTranscripts();
