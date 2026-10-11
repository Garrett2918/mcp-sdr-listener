// The SDR tools Claude sees, shared by the local stdio server (mcp.js) and the
// remote HTTP endpoint (remote.js). Each tool is a thin call into the HTTP API;
// `api(path, body)` performs it (GET without a body, POST with one) and returns
// the parsed JSON or throws.

import { z } from 'zod';

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

export function registerTools(server, api, pageUrl) {
    server.registerTool('sdr_status', {
        description: 'Current receiver state: frequency (Hz), mode, filter, connection status, signal and noise (dB), S/N, and seconds of audio buffered on this tuning. Also prints the web page address.',
        inputSchema: {},
    }, wrap(async () => ({ ...(await api('/api/status')), page: pageUrl })));

    server.registerTool('sdr_tune', {
        description: 'Tune the shared receiver (the user hears the change if they are listening). Frequency in kHz, e.g. 3873 for 3.873 MHz. Mode: am, sam, usb, lsb, cwu, cwl, nfm, fm. Convention: LSB below 10 MHz, USB above; 75 m AM is around 3870-3890 kHz. Changing mode resets the filter to that mode\'s default unless bandwidth_low/high are given (Hz relative to the carrier).',
        inputSchema: {
            frequency_khz: z.number().optional().describe('Frequency in kHz'),
            mode: z.enum(['am', 'sam', 'usb', 'lsb', 'cwu', 'cwl', 'nfm', 'fm']).optional(),
            bandwidth_low: z.number().optional(),
            bandwidth_high: z.number().optional(),
        },
    }, wrap(async (a) => api('/api/tune', {
        frequency: a.frequency_khz != null ? Math.round(a.frequency_khz * 1000) : undefined,
        mode: a.mode, bandwidthLow: a.bandwidth_low, bandwidthHigh: a.bandwidth_high,
    })));

    server.registerTool('sdr_active_signals', {
        description: 'Voice transmissions the receiver\'s own detector currently hears, strongest first, with band, dial frequency (Hz), suggested mode, S/N and confidence. Updated by the receiver about every 20 s. Use this to find something to listen to, then sdr_tune to it.',
        inputSchema: {
            band: z.string().optional().describe('Band name as the receiver labels it, e.g. "40m", "20m", "75m"'),
            min_confidence: z.number().min(0).max(1).optional().describe('Default 0.6'),
        },
    }, wrap(async (a) => {
        const q = new URLSearchParams({ min_confidence: String(a.min_confidence ?? 0.6) });
        if (a.band) q.set('band', a.band);
        return api(`/api/active?${q}`);
    }));

    server.registerTool('sdr_transcribe', {
        description: 'Transcribe audio on the current tuning with the model chosen on the Settings page (default Gemini 3.8 Flash, falling back to Whisper large-v3). Gemini also returns the language and, for non-English speech, an English translation. when="past" uses audio already buffered since the last retune (falls back to recording if there is too little); when="next" records the next N seconds first. After a fresh sdr_tune use "next". Transcripts of noisy HF audio are often partial and may contain invented filler on pure noise, so check S/N. Saved to the page\'s transcript log.',
        inputSchema: {
            seconds: z.number().min(5).max(120).optional().describe('Default 30'),
            when: z.enum(['past', 'next']).optional().describe('Default past'),
            language: z.string().optional().describe('ISO code like "en" to skip language detection'),
        },
    }, wrap(async (a) => api('/api/transcribe', { seconds: a.seconds ?? 30, when: a.when ?? 'past', language: a.language })));

    server.registerTool('sdr_recent_transcripts', {
        description: 'Most recent transcripts from the log (newest first), including ones the user made from the page.',
        inputSchema: { limit: z.number().min(1).max(100).optional().describe('Default 10') },
    }, wrap(async (a) => api(`/api/transcripts?limit=${a.limit ?? 10}`)));

    server.registerTool('sdr_sample', {
        description: 'Quickly judge several frequencies. A spectrum pre-scan skips ones with no signal (levelDb under 10); stations within 80 kHz of each other (AM, USB, LSB) are recorded together as one wideband IQ capture and demodulated at once; the rest are tuned one at a time. Every clip is transcribed in parallel, with language and English translation when the model supports it. Restores the original tuning afterwards. Speed depends on clustering: each 80 kHz group costs one `seconds`-long recording (12 frequencies spread over 2 MHz take about 70 s). Pass prescreen=false when the list comes straight from a fresh sdr_scan.',
        inputSchema: {
            frequencies: z.array(z.object({ khz: z.number(), mode: z.enum(['am', 'sam', 'usb', 'lsb', 'cwu', 'cwl', 'nfm', 'fm']).optional() })).min(1).max(12),
            seconds: z.number().min(8).max(60).optional().describe('Default 10'),
            language: z.string().optional(),
            prescreen: z.boolean().optional().describe('Default true: skip frequencies with no signal first'),
        },
    }, wrap(async (a) => api('/api/sample', { frequencies: a.frequencies, seconds: a.seconds, language: a.language, prescreen: a.prescreen })));

    server.registerTool('sdr_live', {
        description: 'Live captions on the current tuning: action="start" makes the server transcribe every chunk_seconds (default 15) of new audio until stopped or `minutes` (default 10) run out; action="read" returns caption chunks newer than `since` (pass the latestSeq from your last read); action="stop" ends it. Captions follow retunes and also appear on the user\'s page. Captions arrive roughly chunk_seconds + 5 s behind live. Cheap with Gemini, but stop it when done.',
        inputSchema: {
            action: z.enum(['start', 'read', 'stop']),
            since: z.number().optional(),
            chunk_seconds: z.number().min(8).max(30).optional(),
            minutes: z.number().min(1).max(120).optional(),
            language: z.string().optional(),
        },
    }, wrap(async (a) => {
        if (a.action === 'start') return api('/api/live', { on: true, chunk_seconds: a.chunk_seconds, minutes: a.minutes, language: a.language });
        if (a.action === 'stop') return api('/api/live', { on: false });
        return api(`/api/live?since=${a.since ?? 0}`);
    }));

    server.registerTool('sdr_decode_cw', {
        description: 'Decode Morse code (CW) on the current tuning. Tune to the signal in cwu (or cwl) mode first. when="past" (default) decodes audio already buffered since the last retune, so it catches transmissions that just ended; "next" records first. Best on clean, machine-sent CW (contests, beacons); hand-sent or weak CW decodes less reliably, so check keyingSnrDb (under ~10 dB is unreliable). Free (no transcription cost).',
        inputSchema: {
            seconds: z.number().min(5).max(300).optional().describe('Default 60'),
            when: z.enum(['past', 'next']).optional(),
        },
    }, wrap(async (a) => api('/api/decode-cw', { seconds: a.seconds ?? 60, when: a.when ?? 'past' })));

    server.registerTool('sdr_waterfall', {
        description: 'Look at a waterfall (spectrum over time) as an image, plus a list of detected signals with frequency, width, strength and a guess at their type. Use it to see what is on a band, find AM/broadcast/CW/digital signals the voice detector misses, or check a signal\'s shape before tuning. Spans: ~10 kHz for detail around one signal, 50-200 kHz for a ham band segment, up to 30000 kHz for the whole HF range (coarse). The image is shared with the user\'s page view while it runs.',
        inputSchema: {
            center_khz: z.number().optional().describe('Default: current tuning'),
            span_khz: z.number().min(2).max(30000).optional().describe('Default 50'),
            seconds: z.number().min(2).max(30).optional().describe('Default 8'),
        },
    }, async (a) => {
        try {
            const r = await api('/api/waterfall', { center_khz: a.center_khz, span_khz: a.span_khz, seconds: a.seconds });
            const { pngBase64, ...info } = r;
            return { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(info, null, 2) }] };
        } catch (e) { return fail(e); }
    });

    server.registerTool('sdr_scan', {
        description: 'Find signals between two frequencies from the live spectrum (no image). Works for any mode, including AM broadcast and AM voice, CW and digital, unlike sdr_active_signals which only reports SSB-style voice. Resolution is (end-start)/2048, so scan a few hundred kHz at a time for detail. Each signal has frequency, width, strength above noise, how much of the time it was present, and a type guess.',
        inputSchema: {
            start_khz: z.number(),
            end_khz: z.number(),
            seconds: z.number().min(2).max(30).optional().describe('Default 6; longer catches intermittent signals'),
            threshold_db: z.number().optional().describe('Default 8 dB above noise'),
        },
    }, wrap(async (a) => api('/api/scan', a)));

    server.registerTool('sdr_spots', {
        description: 'Spot feeds. kind="digital": FT8/FT4/WSPR stations this receiver has decoded itself (who is being heard, from where, how far; good for judging propagation to a region). kind="dx": the worldwide DX cluster, where hams post interesting stations with frequency and comments (not necessarily audible here). Filter by band (e.g. "20m"), callsign (substring), mode (FT8/FT4/WSPR for digital), and minutes back.',
        inputSchema: {
            kind: z.enum(['dx', 'digital']),
            band: z.string().optional(),
            callsign: z.string().optional(),
            mode: z.string().optional(),
            minutes: z.number().min(1).max(240).optional().describe('Default 30'),
            limit: z.number().min(1).max(200).optional().describe('Default 40'),
        },
    }, wrap(async (a) => {
        const q = new URLSearchParams({ kind: a.kind });
        for (const k of ['band', 'callsign', 'mode', 'minutes', 'limit']) if (a[k] != null) q.set(k, String(a[k]));
        return api(`/api/spots?${q}`);
    }));

    server.registerTool('sdr_callsign', {
        description: 'Look up an amateur radio call sign through the receiver: country, continent, zones and time zone from the prefix, plus (when available) the license holder\'s name, birth year when listed, town, grid square, license class and QSL routes. Use it to identify stations heard in transcripts, Morse or spots. Call signs heard on air are often garbled by transcription, so check the result fits what was said.',
        inputSchema: { callsign: z.string().describe('e.g. "W1FM" or "5W0AF"') },
    }, wrap(async (a) => api(`/api/callsign?call=${encodeURIComponent(a.callsign)}`)));

    server.registerTool('sdr_conditions', {
        description: 'Space weather and HF band conditions (solar flux, K/A index, per-band day/night ratings, forecast). Use to explain why a band is quiet or to suggest where to listen.',
        inputSchema: {},
    }, wrap(async () => api('/api/conditions')));

    server.registerTool('sdr_dxpeditions', {
        description: 'DX-peditions (operators on the air from rare places), with dates, bands and modes. Active ones by default.',
        inputSchema: { include_upcoming: z.boolean().optional() },
    }, wrap(async (a) => api(`/api/dxpeditions${a.include_upcoming ? '?all=1' : ''}`)));

    server.registerTool('sdr_bookmarks', {
        description: 'The receiver operator\'s preset frequencies (FT8, CW, broadcast, utility stations, etc.).',
        inputSchema: {},
    }, wrap(async () => api('/api/bookmarks')));
}
