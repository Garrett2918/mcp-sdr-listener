// Demodulating stations out of a wideband IQ recording.
//
// The receiver's iq96 mode sends 96 kHz of raw complex baseband around a centre
// frequency. Each station inside it is mixed down to 0 Hz, low-pass filtered,
// decimated to 12 kHz, and detected as AM (envelope) or SSB (one sideband).

export const AUDIO_RATE = 12000;

function lowpassTaps(cutoffHz, rate, n) {
    const h = new Float64Array(n), m = (n - 1) / 2;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const x = i - m;
        const sinc = x === 0 ? 2 * cutoffHz / rate : Math.sin(2 * Math.PI * cutoffHz * x / rate) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1)); // Blackman
        h[i] = sinc * w;
        sum += h[i];
    }
    for (let i = 0; i < n; i++) h[i] /= sum;
    return h;
}

// i, q: Float32Array planes at `rate`. offsetHz: station dial frequency minus
// the recording's centre. mode: am | sam | usb | lsb. Returns Int16Array audio
// at AUDIO_RATE, normalised.
export function demodulate(i, q, rate, offsetHz, mode) {
    const D = Math.round(rate / AUDIO_RATE);
    const ssb = mode === 'usb' || mode === 'lsb';
    // SSB: centre the 3 kHz voice band on 0 Hz, then move it back up after decimating.
    const voiceShift = mode === 'usb' ? 1500 : mode === 'lsb' ? -1500 : 0;
    const h = lowpassTaps(ssb ? 1500 : 5000, rate, 127);
    const n = h.length, N = i.length;

    const xr = new Float32Array(N), xi = new Float32Array(N);
    const w = -2 * Math.PI * (offsetHz + voiceShift) / rate;
    for (let k = 0; k < N; k++) {
        const c = Math.cos(w * k), s = Math.sin(w * k);
        xr[k] = i[k] * c - q[k] * s;
        xi[k] = i[k] * s + q[k] * c;
    }

    const M = Math.max(0, Math.floor((N - n) / D));
    const out = new Float32Array(M);
    const back = 2 * Math.PI * voiceShift / AUDIO_RATE;
    let dc = 0;
    for (let m = 0; m < M; m++) {
        let yr = 0, yi = 0;
        const base = m * D;
        for (let k = 0; k < n; k++) { yr += h[k] * xr[base + k]; yi += h[k] * xi[base + k]; }
        if (ssb) {
            out[m] = yr * Math.cos(back * m) - yi * Math.sin(back * m);
        } else {
            // AM: the envelope, minus a slowly tracked carrier level.
            const env = Math.hypot(yr, yi);
            dc += (env - dc) * (m < AUDIO_RATE / 10 ? 0.05 : 0.002);
            out[m] = env - dc;
        }
    }

    // Normalise to a comfortable level, ignoring the filter's start-up.
    let peak = 1e-9;
    for (let m = Math.floor(AUDIO_RATE * 0.2); m < M; m++) peak = Math.max(peak, Math.abs(out[m]));
    const pcm = new Int16Array(M);
    for (let m = 0; m < M; m++) pcm[m] = Math.max(-32767, Math.min(32767, Math.round((out[m] / peak) * 0.9 * 32767)));
    return pcm;
}
