// Minimal PNG writer and waterfall renderer (no dependencies).

import zlib from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});
function crc32(buf) {
    let c = -1;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

export function encodePng(width, height, rgb) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
    ]);
}

// Dark blue -> blue -> cyan -> yellow -> red -> white.
const STOPS = [[0, [4, 8, 30]], [0.25, [20, 40, 160]], [0.45, [0, 170, 220]], [0.65, [240, 230, 40]], [0.85, [240, 60, 30]], [1, [255, 255, 255]]];
export function colormap(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < STOPS.length; i++) {
        if (t <= STOPS[i][0]) {
            const [t0, a] = STOPS[i - 1], [t1, b] = STOPS[i], f = (t - t0) / (t1 - t0);
            return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
        }
    }
    return STOPS.at(-1)[1];
}

// 3x5 pixel font for axis labels.
const FONT = {
    0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
    5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
    '.': '000000000000010', k: '100101110101101', M: '101111111101101', H: '101101111101101', z: '000111001010111',
    s: '000011010001110', ' ': '000000000000000', '-': '000000111000000',
};

class Canvas {
    constructor(w, h) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 3); }
    set(x, y, [r, g, b], a = 1) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const i = (y * this.w + x) * 3;
        this.px[i] = this.px[i] * (1 - a) + r * a;
        this.px[i + 1] = this.px[i + 1] * (1 - a) + g * a;
        this.px[i + 2] = this.px[i + 2] * (1 - a) + b * a;
    }
    rect(x, y, w, h, c, a) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c, a); }
    text(str, x, y, c, scale = 2) {
        for (const ch of String(str)) {
            const g = FONT[ch];
            if (g) for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === '1') this.rect(x + q * scale, y + r * scale, scale, scale, c);
            x += 4 * scale;
        }
        return x;
    }
    textWidth(str, scale = 2) { return String(str).length * 4 * scale; }
}

function niceStep(spanHz, maxTicks) {
    const raw = spanHz / maxTicks;
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
}

export function fmtKhz(hz) {
    const k = hz / 1000;
    return Number.isInteger(k) ? String(k) : k.toFixed(k % 0.1 === 0 ? 1 : 2).replace(/0+$/, '');
}

// rows: array of Float32Array dB rows (oldest first). Returns { png, axis }.
export function renderWaterfall({ rows, startHz, binHz, marker, floorDb, width = 1024, rowHeight = 2, bandwidth }) {
    const bins = rows[0].length;
    const W = Math.min(width, bins);
    const pool = bins / W;
    const AXIS = 22, LEGEND = 16;
    const H = AXIS + rows.length * rowHeight + LEGEND;
    const cv = new Canvas(W, H);
    const lo = floorDb - 3, hi = floorDb + 40;
    const spanHz = bins * binHz;
    const xOf = (hz) => Math.round(((hz - startHz) / spanHz) * W);

    // Waterfall: newest row at the top.
    for (let r = 0; r < rows.length; r++) {
        const row = rows[rows.length - 1 - r];
        const y0 = AXIS + r * rowHeight;
        for (let x = 0; x < W; x++) {
            let m = -300;
            const a = Math.floor(x * pool), b = Math.max(a + 1, Math.floor((x + 1) * pool));
            for (let i = a; i < b; i++) if (row[i] > m) m = row[i];
            const c = colormap((m - lo) / (hi - lo));
            for (let k = 0; k < rowHeight; k++) cv.set(x, y0 + k, c);
        }
    }

    // Axis strip with frequency ticks and labels.
    cv.rect(0, 0, W, AXIS, [12, 14, 18]);
    const step = niceStep(spanHz, 8);
    const ticks = [];
    for (let f = Math.ceil(startHz / step) * step; f <= startHz + spanHz; f += step) {
        const x = xOf(f);
        ticks.push({ hz: f, x });
        cv.rect(x, AXIS - 6, 1, 6, [200, 200, 200]);
        for (let y = AXIS; y < H - LEGEND; y += 6) cv.set(x, y, [255, 255, 255], 0.25);
        const label = fmtKhz(f);
        const lx = Math.max(1, Math.min(W - cv.textWidth(label) - 1, x - cv.textWidth(label) / 2));
        cv.text(label, lx, 3, [220, 220, 220]);
    }

    // Tuned frequency and passband.
    if (marker != null && marker >= startHz && marker <= startHz + spanHz) {
        const x = xOf(marker);
        if (bandwidth) {
            const x0 = xOf(marker + bandwidth[0]), x1 = xOf(marker + bandwidth[1]);
            cv.rect(Math.min(x0, x1), AXIS - 4, Math.max(1, Math.abs(x1 - x0)), 4, [255, 80, 200]);
        }
        for (let y = AXIS; y < H - LEGEND; y++) if ((y >> 2) % 2 === 0) cv.set(x, y, [255, 80, 200], 0.9);
    }

    // Legend: colour scale in dB above the noise floor.
    const ly = H - LEGEND;
    cv.rect(0, ly, W, LEGEND, [12, 14, 18]);
    let x = cv.text('0', 4, ly + 3, [200, 200, 200]) + 4;
    const lw = Math.min(200, W / 3);
    for (let i = 0; i < lw; i++) cv.rect(x + i, ly + 4, 1, 8, colormap(i / lw));
    cv.text('40', x + lw + 4, ly + 3, [200, 200, 200]);

    return { png: encodePng(W, H, cv.px), axis: { widthPx: W, heightPx: H, startHz, endHz: startHz + spanHz, tickHz: ticks.map((t) => t.hz), rowsNewestAtTop: true, scale: `color 0..40 dB above noise floor (${floorDb.toFixed(0)} dB)` } };
}
