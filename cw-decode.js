// Morse (CW) decoder, command line.
//
//   node cw-decode.js [seconds=30] [--next]   decode buffered audio (or the next N s) via the server
//   node cw-decode.js --wav clip.wav          decode a saved recording
//
// Tune to the CW signal in cwu/cwl mode first.

import fs from 'node:fs';
import { decodeCw } from './cw.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (opt('--wav')) {
    const b = fs.readFileSync(opt('--wav'));
    const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)));
    console.log(JSON.stringify(decodeCw(pcm, b.readUInt32LE(24)), null, 2));
} else {
    const seconds = Number(args.find((a) => /^\d+$/.test(a)) || 30);
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 8737}/api/decode-cw`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds, when: args.includes('--next') ? 'next' : 'past' }),
    });
    console.log(JSON.stringify(await res.json(), null, 2));
}
