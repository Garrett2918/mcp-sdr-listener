// Morse (CW) decoding: find the tone, follow its envelope, classify keying by timing.
// Works best on clean, machine-timed CW; weak or hand-sent signals decode less reliably.

const MORSE = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I',
    '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R',
    '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z',
    '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7',
    '---..': '8', '----.': '9', '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/', '-...-': '=',
    '.-.-.': '<AR>', '...-.-': '<SK>', '-.--.': '<KN>', '-....-': '-', '.-...': '<AS>', '...---...': '<SOS>',
};

function goertzel(x, from, n, k) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s = x[from + i] + k * s1 - s2; s2 = s1; s1 = s; }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
}

// Strongest tone between 200 and 1200 Hz, over the whole recording.
function findTone(x, rate) {
    const n = Math.round(rate * 0.05);
    let best = 0, bestF = 600;
    for (let f = 200; f <= 1200; f += 10) {
        const k = 2 * Math.cos(2 * Math.PI * f / rate);
        let p = 0;
        for (let o = 0; o + n <= x.length; o += n) p += goertzel(x, o, n, k);
        if (p > best) { best = p; bestF = f; }
    }
    return bestF;
}

export function decodeCw(samples, rate) {
    const x = samples instanceof Int16Array ? Float64Array.from(samples, (v) => v / 32768) : samples;
    const tone = findTone(x, rate);
    const block = Math.round(rate * 0.004); // 4 ms resolution
    const k = 2 * Math.cos(2 * Math.PI * tone / rate);
    const env = [];
    for (let o = 0; o + block * 2 <= x.length; o += block) env.push(Math.sqrt(goertzel(x, o, block * 2, k)));
    // Light smoothing, then a threshold between the noise floor and the key-down level.
    const sm = env.map((_, i) => (env[Math.max(0, i - 1)] + env[i] + env[Math.min(env.length - 1, i + 1)]) / 3);
    const sorted = [...sm].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.2)], hi = sorted[Math.floor(sorted.length * 0.97)];
    const on = lo + (hi - lo) * 0.5, off = lo + (hi - lo) * 0.35;
    const runs = [];
    let state = false, len = 0;
    for (const v of sm) {
        const next = state ? v > off : v > on;
        if (next === state) len++; else { runs.push([state, len]); state = next; len = 1; }
    }
    runs.push([state, len]);
    const marks = runs.filter(([s, l]) => s && l >= 3).map(([, l]) => l).sort((a, b) => a - b);
    const keyingSnrDb = +(20 * Math.log10(hi / Math.max(lo, 1e-9))).toFixed(1);
    if (marks.length < 4) return { toneHz: tone, wpm: null, keyingSnrDb, text: '', note: 'No keying found. Check the tuning and signal strength.' };
    // Dit length: the median of the shortest cluster of marks (anything under twice the shortest).
    const shortest = marks[Math.floor(marks.length * 0.05)];
    const dits = marks.filter((m) => m < shortest * 2);
    const dit = Math.max(3, dits[Math.floor(dits.length / 2)]);
    let text = '', sym = '';
    const flush = () => { if (sym) { text += MORSE[sym] || '*'; sym = ''; } };
    for (const [s, l] of runs) {
        if (s) { if (l >= dit * 0.4) sym += l < dit * 2 ? '.' : '-'; }
        else if (l >= dit * 5) { flush(); text += ' '; }
        else if (l >= dit * 2) flush();
    }
    flush();
    const ditMs = dit * block * 1000 / rate;
    const result = { toneHz: tone, wpm: Math.round(1200 / ditMs), keyingSnrDb, text: text.replace(/\s+/g, ' ').trim() };
    if (keyingSnrDb < 10) result.note = 'Weak keying; the text is likely unreliable.';
    return result;
}
