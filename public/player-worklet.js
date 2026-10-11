// Jitter buffer for the radio stream. Chunks arrive as Float32Arrays at the
// context's own sample rate; playback starts once PREROLL is queued, and the
// queue is trimmed if network bunching lets it grow past MAX_LAG.
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
        this.port.onmessage = (e) => {
            if (e.data.gain !== undefined) { this.gain = e.data.gain; return; }
            if (e.data.flush) { this.queue = []; this.offset = 0; this.queued = 0; this.playing = false; return; }
            this.queue.push(e.data);
            this.queued += e.data.length;
            while (this.queued > this.MAX_LAG && this.queue.length > 1) {
                const head = this.queue.shift();
                this.queued -= head.length - this.offset;
                this.offset = 0;
            }
        };
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
