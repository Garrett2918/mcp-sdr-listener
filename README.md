# SDR Listener

Listen to and tune a [UberSDR](https://github.com/madpsy/ka9q_ubersdr) web
receiver from a page on your own computer. The default receiver is K3FEF in
Milford, PA. You can watch a live waterfall, find active signals, decode Morse,
and transcribe or translate speech with Gemini or Whisper.

Claude gets the same controls through an MCP server. Ask it to "find shortwave
broadcasters on 31 m and tell me what they're saying" and it tunes, listens and
reports back.

## Requirements

- Node.js 22 or newer
- An API key from [Surplus Intelligence](https://www.surplusintelligence.ai) or
  [OpenRouter](https://openrouter.ai/keys) for transcription. Listening, tuning,
  the waterfall, scanning, spots and Morse decoding work without one.

## Run

```bash
npm install
node server.js
```

Open http://localhost:8737, press **Listen**, and add an API key under
**Settings**.

## Features

- **Listen and tune:** frequency entry and scroll-tuning, step buttons, modes
  (AM, SAM, USB, LSB, CW, FM), band shortcuts, signal meter.
- **Live waterfall:** follows the tuning; click a signal to tune to it.
- **Active signals:** the receiver's own voice detector, strongest first.
- **Transcripts:** transcribe the last or next 15–60 seconds, or turn on live
  captions in 15-second chunks. Gemini models also name the language and
  translate to English. Each transcript keeps its audio clip.
- **Morse decoding** of buffered or upcoming audio.

## Settings

The **Settings** page (`/settings`) sets API keys and picks a first-choice and
fallback transcription model:

| Provider | Models |
|---|---|
| Surplus Intelligence | Gemini 3.8 Flash, Whisper large-v3 (Venice) |
| OpenRouter | Gemini 3.8 Flash, Whisper large-v3, Whisper large-v3 turbo |

The app saves keys to `.env` (see `.env.example`) and model choices to
`data/settings.json`. Git ignores both. Set `SDR_HOST` in `.env` to use a
different UberSDR receiver, or `PORT` to move the page off 8737.

The API answers requests from your own page and tools and refuses requests
from other websites.

## Connect Claude

```bash
claude mcp add --scope user sdr -- node "<full path to this folder>/mcp.js"
```

The MCP server starts `server.js` itself if it isn't running. Tools:

| Tool | What it does |
|---|---|
| `sdr_status`, `sdr_tune` | Read and set the tuning |
| `sdr_active_signals` | The receiver's voice detector (SSB voice only) |
| `sdr_waterfall` | Waterfall image plus detected signals, for any span up to 30 MHz |
| `sdr_scan` | Detected signals between two frequencies (any mode, including AM and CW) |
| `sdr_transcribe`, `sdr_recent_transcripts` | Transcription (with language and English translation) and the transcript log |
| `sdr_sample` | Listen to several frequencies in turn and transcribe each |
| `sdr_live` | Start, read and stop live captions |
| `sdr_decode_cw` | Morse decoding of buffered or upcoming audio |
| `sdr_spots` | FT8/FT4/WSPR stations this receiver decoded, or the worldwide DX cluster |
| `sdr_conditions`, `sdr_dxpeditions`, `sdr_bookmarks` | Band conditions, active DX-peditions, operator presets |

Morse from the command line: `node cw-decode.js 30` (buffered audio) or
`node cw-decode.js --wav clip.wav`.

## Notes

- Volunteers run public receivers. The app holds one session and drops it after
  5 minutes with nobody listening and no tool calls. It finds signals by reading
  the spectrum, so it doesn't hammer the receiver with retunes.
- Receivers limit users per IP, and K3FEF allows 2. Other people on a shared
  VPN exit can take those slots. The page shows the receiver's refusal and
  keeps retrying.
- If the receiver ends the session, the app starts a new one.
- The live waterfall and Claude's snapshots share one spectrum view. When Claude
  takes a snapshot, your waterfall jumps to that frequency and then returns.
- The app saves transcripts, audio clips and waterfall images in `data/`.

## License

GPL-3.0. `vendor/pcm-v4.js` is UberSDR's audio decoder from
[madpsy/ka9q_ubersdr](https://github.com/madpsy/ka9q_ubersdr), also GPL-3.0.
