// Jitter buffer for the radio stream. Chunks arrive as { pcm: Float32Array, rate }
// at the stream's own rate (12 kHz for SSB, 24 kHz for AM) and are resampled here
// to the context's rate, so the page never has to rebuild its AudioContext (iOS
// only lets audio start from a tap). Playback starts once PREROLL is queued, and
// the queue is trimmed if network bunching lets it grow past MAX_LAG.
class RadioPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.queue = [];
        this.offset = 0;
        this.queued = 0;
        this.playing = false;
        this.gain = 1;
        this.PREROLL = sampleRate * 0.4;
        this.MAX_LAG = sampleRate * 1.5;
        this.prev = 0;  // last input sample of the previous chunk
        this.t = 0;     // next output position, in input samples from the current chunk's start
        this.port.onmessage = (e) => {
            if (e.data.gain !== undefined) { this.gain = e.data.gain; return; }
            if (e.data.flush) { this.queue = []; this.offset = 0; this.queued = 0; this.playing = false; return; }
            const chunk = this.resample(e.data.pcm, e.data.rate);
            this.queue.push(chunk);
            this.queued += chunk.length;
            while (this.queued > this.MAX_LAG && this.queue.length > 1) {
                const head = this.queue.shift();
                this.queued -= head.length - this.offset;
                this.offset = 0;
            }
        };
    }

    // Linear interpolation, continuous across chunks: position -1 is the previous
    // chunk's last sample, so no clicks at chunk edges.
    resample(x, rate) {
        if (!rate || rate === sampleRate) return x;
        const step = rate / sampleRate, n = x.length;
        const out = new Float32Array(Math.ceil((n + 1) / step) + 1);
        let k = 0, t = this.t;
        while (t < n - 1) {
            const i = Math.floor(t), f = t - i;
            const a = i < 0 ? this.prev : x[i];
            out[k++] = a + (x[i + 1] - a) * f;
            t += step;
        }
        this.t = t - n;
        this.prev = x[n - 1];
        return out.subarray(0, k);
    }

    process(_inputs, outputs) {
        const out = outputs[0][0];
        if (!this.playing && this.queued >= this.PREROLL) this.playing = true;
        let i = 0;
        if (this.playing) {
            while (i < out.length && this.queue.length) {
                const head = this.queue[0];
                const n = Math.min(out.length - i, head.length - this.offset);
                for (let k = 0; k < n; k++) out[i + k] = head[this.offset + k] * this.gain;
                i += n; this.offset += n; this.queued -= n;
                if (this.offset >= head.length) { this.queue.shift(); this.offset = 0; }
            }
            if (i < out.length) this.playing = false; // ran dry: rebuffer
        }
        for (; i < out.length; i++) out[i] = 0;
        for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
        return true;
    }
}
registerProcessor('radio-player', RadioPlayer);
