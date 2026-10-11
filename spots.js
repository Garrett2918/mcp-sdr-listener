// Spot feeds from the receiver's /ws/dxcluster socket:
//   dx_spots       the worldwide DX cluster (hams posting stations they hear, with comments)
//   digital_spots  FT8/FT4/WSPR decodes made by this receiver
// Connected on demand; the server replays a backlog on subscribe.

const IDLE_MS = 15 * 60 * 1000;
const KEEP = { dx: 1500, digital: 6000 };

export class SpotFeed {
    constructor({ host, radio, openSocket = (url) => new WebSocket(url) }) {
        this.host = host;
        this.radio = radio;
        this.openSocket = openSocket;
        this.ws = null;
        this.opening = null;
        this.lastUse = 0;
        this.spots = { dx: [], digital: [] };
        setInterval(() => {
            if (this.ws && Date.now() - this.lastUse > IDLE_MS) { try { this.ws.close(1000); } catch { /* closed */ } this.ws = null; }
        }, 60000).unref?.();
    }

    async ensure() {
        this.lastUse = Date.now();
        if (this.ws && this.ws.readyState === 1) return;
        if (!this.opening) this.opening = this._open().finally(() => { this.opening = null; });
        await this.opening;
    }

    async _open() {
        await this.radio.register();
        const ws = this.openSocket(`wss://${this.host}/ws/dxcluster?user_session_id=${this.radio.sessionId}`);
        this.ws = ws;
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.type === 'dx_spot') this._add('dx', m.data);
            else if (m.type === 'digital_spot') this._add('digital', m.data);
        };
        ws.onclose = () => { if (this.ws === ws) this.ws = null; };
        await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Spot connection timed out.')), 10000);
            ws.onopen = () => {
                clearTimeout(t);
                ws.send(JSON.stringify({ type: 'subscribe_dx_spots' }));
                ws.send(JSON.stringify({ type: 'subscribe_digital_spots' }));
                resolve();
            };
            ws.onerror = () => { clearTimeout(t); reject(new Error('Spot connection failed.')); };
        });
        // Let the backlog arrive before the first answer.
        await new Promise((r) => setTimeout(r, 3000));
    }

    _add(kind, d) {
        const list = this.spots[kind];
        list.push(d);
        if (list.length > KEEP[kind]) list.splice(0, list.length - KEEP[kind]);
    }

    async query({ kind = 'dx', band, callsign, mode, minutes = 30, limit = 40 } = {}) {
        await this.ensure();
        const since = Date.now() - minutes * 60000;
        const call = callsign?.toUpperCase();
        if (kind === 'dx') {
            const out = this.spots.dx
                .filter((s) => Date.parse(s.time) >= since)
                .filter((s) => !band || s.band === band)
                .filter((s) => !call || s.dx_call?.toUpperCase().includes(call) || s.spotter?.toUpperCase().includes(call))
                .map((s) => ({
                    time: s.time?.slice(11, 16) + 'Z', frequencyKhz: s.frequency / 1000, call: s.dx_call,
                    country: s.country, band: s.band, spotter: s.spotter, comment: s.comment?.trim() || undefined,
                }));
            return { kind: 'dx', note: 'Posted by hams worldwide; not necessarily audible on this receiver.', count: out.length, spots: out.slice(-limit).reverse() };
        }
        // Digital: one entry per station (latest decode), plus per-band counts.
        const rows = this.spots.digital
            .filter((s) => Date.parse(s.timestamp) >= since)
            .filter((s) => !band || s.band === band)
            .filter((s) => !mode || s.mode?.toUpperCase() === mode.toUpperCase())
            .filter((s) => !call || s.callsign?.toUpperCase().includes(call) || s.message?.toUpperCase().includes(call));
        const byCall = new Map();
        const perBand = {};
        for (const s of rows) {
            byCall.set(s.callsign, s);
            perBand[s.band] = (perBand[s.band] || 0) + 1;
        }
        const stations = [...byCall.values()]
            .sort((a, b) => (b.distance_km || 0) - (a.distance_km || 0))
            .slice(0, limit)
            .map((s) => ({
                time: s.timestamp?.slice(11, 16) + 'Z', call: s.callsign, mode: s.mode, band: s.band,
                frequencyKhz: +(s.frequency / 1000).toFixed(2), snrDb: s.snr, country: s.country,
                distanceKm: s.distance_km ? Math.round(s.distance_km) : undefined, grid: s.locator || undefined,
                message: s.message,
            }));
        return { kind: 'digital', note: 'Decoded by this receiver; sorted by distance, farthest first.', decodes: rows.length, uniqueStations: byCall.size, decodesPerBand: perBand, stations };
    }
}
