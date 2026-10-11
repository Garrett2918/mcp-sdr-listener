// Speech-to-text through hosted providers.
//
// Three call styles cover the models offered here:
//   chat       OpenAI-style chat completion with an input_audio part (Gemini);
//              also returns the language and an English translation
//   stt-form   multipart /audio/transcriptions (Surplus Whisper)
//   stt-json   JSON /audio/transcriptions with base64 audio (OpenRouter Whisper)
//
// Settings pick a first-choice model and an optional fallback; each gets one
// retry when a request stalls or the provider errors.

export const PROVIDERS = {
    surplus: {
        name: 'Surplus Intelligence',
        base: 'https://api.surplusintelligence.ai/v1',
        keyEnv: 'SURPLUS_API_KEY',
        keyUrl: 'https://www.surplusintelligence.ai',
        models: [
            { id: 'gemini-3.8-flash', kind: 'chat', label: 'Gemini 3.8 Flash', note: 'Fast; adds language and English translation' },
            { id: 'venice-whisper-large-v3', kind: 'stt-form', label: 'Whisper large-v3 (Venice)', note: '$0.006/min; transcript only' },
        ],
    },
    openrouter: {
        name: 'OpenRouter',
        base: 'https://openrouter.ai/api/v1',
        keyEnv: 'OPENROUTER_API_KEY',
        keyUrl: 'https://openrouter.ai/keys',
        models: [
            { id: 'google/gemini-3.8-flash', kind: 'chat', label: 'Gemini 3.8 Flash', note: 'Fast; adds language and English translation' },
            { id: 'openai/whisper-large-v3', kind: 'stt-json', label: 'Whisper large-v3', note: 'Transcript only' },
            { id: 'openai/whisper-large-v3-turbo', kind: 'stt-json', label: 'Whisper large-v3 turbo', note: 'Faster, cheaper Whisper; transcript only' },
        ],
    },
};

export const DEFAULT_SETTINGS = {
    primary: { provider: 'surplus', model: 'gemini-3.8-flash' },
    fallback: { provider: 'surplus', model: 'venice-whisper-large-v3' },
};

export const DEFAULT_PROMPT = 'Shortwave radio: amateur radio contacts, broadcasts, sermons, talk shows, news. Call signs, names, places.';

const TIMEOUT_MS = 30000;

export function findModel(choice) {
    const p = PROVIDERS[choice?.provider];
    const m = p?.models.find((x) => x.id === choice.model);
    return p && m ? { provider: p, providerId: choice.provider, model: m } : null;
}

export function validChoice(choice) {
    return !!findModel(choice);
}

// Transcribe a WAV buffer with the configured models. Returns
// { text, language?, english?, engine }.
export async function transcribe(audio, opts, settings) {
    const chain = [settings.primary, settings.fallback].filter((c) => c && validChoice(c));
    if (!chain.length) throw new Error('No transcription model is configured. Open Settings to choose one.');
    let lastError;
    for (const choice of chain) {
        try {
            return await withRetry(choice, audio, opts);
        } catch (e) {
            lastError = e;
            console.log(`${choice.provider}/${choice.model} failed: ${e.message}`);
        }
    }
    throw lastError;
}

async function withRetry(choice, audio, opts) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await callModel(choice, audio, opts);
        } catch (e) {
            lastError = e;
            if (!e.retryable) break;
        }
    }
    throw lastError;
}

export async function callModel(choice, audio, { language, prompt } = {}) {
    const found = findModel(choice);
    if (!found) throw new Error(`Unknown model ${choice?.provider}/${choice?.model}.`);
    const { provider, providerId, model } = found;
    const key = process.env[provider.keyEnv];
    if (!key) throw new Error(`No ${provider.name} API key. Add one in Settings.`);
    const engine = `${providerId}/${model.id}`;
    const auth = { Authorization: `Bearer ${key}` };
    if (providerId === 'openrouter') Object.assign(auth, { 'HTTP-Referer': 'http://localhost', 'X-Title': 'SDR Listener' });

    if (model.kind === 'chat') {
        const instructions = [
            'This is a clip of shortwave radio audio (amateur radio, broadcasts, sermons, talk shows, news).',
            'Transcribe the speech verbatim in its original language. Do not invent words for noise, music or silence; use "" if there is no intelligible speech.',
            'Reply with JSON only: {"language": "<language name in English>", "transcript": "<verbatim>", "english": "<English translation, or empty if already English>"}.',
            language ? `The speech is expected to be in "${language}".` : '',
            prompt && prompt !== DEFAULT_PROMPT ? `Context: ${prompt}` : '',
        ].filter(Boolean).join(' ');
        const body = await post(`${provider.base}/chat/completions`, auth, JSON.stringify({
            model: model.id,
            messages: [{ role: 'user', content: [
                { type: 'text', text: instructions },
                { type: 'input_audio', input_audio: { data: audio.toString('base64'), format: 'wav' } },
            ] }],
        }), 'application/json');
        const raw = String(body.choices?.[0]?.message?.content || '').trim();
        try {
            const p = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
            return { text: String(p.transcript || '').trim(), language: p.language || undefined, english: String(p.english || '').trim() || undefined, engine };
        } catch {
            return { text: raw, engine };
        }
    }

    if (model.kind === 'stt-form') {
        const form = new FormData();
        form.append('model', model.id);
        form.append('response_format', 'json');
        form.append('prompt', prompt || DEFAULT_PROMPT);
        if (language) form.append('language', language);
        form.append('file', new Blob([audio], { type: 'audio/wav' }), 'clip.wav');
        const body = await post(`${provider.base}/audio/transcriptions`, auth, form);
        return { text: String(body.text || '').trim(), engine };
    }

    if (model.kind === 'stt-json') {
        const req = { model: model.id, input_audio: { data: audio.toString('base64'), format: 'wav' } };
        if (language) req.language = language;
        const body = await post(`${provider.base}/audio/transcriptions`, auth, JSON.stringify(req), 'application/json');
        return { text: String(body.text || '').trim(), engine };
    }

    throw new Error(`Unsupported model kind ${model.kind}.`);
}

async function post(url, headers, body, contentType) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: contentType ? { ...headers, 'Content-Type': contentType } : headers,
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        const err = new Error(e.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s.` : `Request failed: ${e.message}`);
        err.retryable = true;
        throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${data?.error?.message || 'no details'}`);
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
    }
    return data;
}

// Mask a key for display: enough to recognise it, never enough to use it.
export function maskKey(k) {
    return k ? `set, ending in ${k.slice(-4)}` : 'not set';
}
