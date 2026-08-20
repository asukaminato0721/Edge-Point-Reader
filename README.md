# Edge Point Reader for Linux

Edge Point Reader adds Edge-style click-to-read speech to normal web pages on
Linux. A userscript detects the sentence under the pointer, while a Cloudflare
Worker streams Microsoft Edge neural TTS audio back to the browser.

The default voice is `ja-JP-NanamiNeural` at `-20%` rate.

## Features

- Click a sentence to read it while point mode is enabled.
- Use `Alt` + click without enabling point mode.
- Read selected text with `Alt` + `R`.
- Highlight the sentence being read.
- Stream MP3 audio with `fetch()` and `MediaSource` for faster startup.
- Fall back to buffered Blob playback when MP3 `MediaSource` is unavailable.
- Configure the Worker endpoint, API token, voice, and rate from the userscript
  menu.
- Stop the request and playback immediately with the floating button or `Esc`.

## Files

- `read-clipboard-edge-tts.js`: Cloudflare Module Worker and Edge TTS proxy.
- `read-clipboard-edge-tts.user.js`: standalone Tampermonkey/Violentmonkey
  userscript.

The Worker does not generate or serve the userscript. The files are independent
so Cloudflare's bundler cannot inject helper functions into the userscript.

## Architecture

```text
Web page
   │ click / Alt+click / selected text
   ▼
Userscript ── POST /tts ──► Cloudflare Worker
   ▲                              │
   │ streamed MP3                 │ outbound WebSocket
   └──────────────────────────────┤
                                  ▼
                         Microsoft Edge TTS
```

The text being read is sent to both the deployed Worker and Microsoft's online
speech service.

## Requirements

- A Cloudflare account with Workers enabled.
- Node.js and `npx`, or another way to run Wrangler.
- Tampermonkey or Violentmonkey.
- A current Chromium-based browser is recommended for streaming MP3 playback.
  Other browsers can use the buffered fallback.

## Deploy the Worker with Wrangler

Authenticate Wrangler:

```bash
npx wrangler login
```

Deploy the Worker:

```bash
npx wrangler deploy ./bin/read-clipboard-edge-tts.js \
  --name edge-point-reader \
  --compatibility-date 2026-08-21
```

Wrangler prints the deployed HTTPS address after a successful deployment.

Protect the endpoint with a secret. This is strongly recommended because an
unprotected deployment can be used by anyone as a public TTS proxy:

```bash
npx wrangler secret put API_TOKEN --name edge-point-reader
```

Enter a random secret when prompted. Keep it private.

Check the deployment:

```bash
curl https://YOUR_WORKER_HOST/health
```

Expected response:

```json
{
  "ok": true,
  "service": "edge-point-reader"
}
```

### Dashboard deployment

The Worker can also be deployed without Wrangler:

1. Open Cloudflare Dashboard and go to **Workers & Pages**.
2. Create a Worker.
3. Replace the generated code with `read-clipboard-edge-tts.js`.
4. Deploy it.
5. Add an encrypted secret named `API_TOKEN` under the Worker's variables and
   secrets settings.
6. Copy the deployed HTTPS address.

## Install and configure the userscript

1. Open the Tampermonkey or Violentmonkey dashboard.
2. Import `read-clipboard-edge-tts.user.js`, or create a new userscript and
   paste the file contents into it.
3. Save and enable the userscript.
4. Open the userscript menu and choose **Set Worker endpoint**.
5. Enter the deployed Worker address with `/tts` appended.
6. If `API_TOKEN` was configured, choose **Set API_TOKEN** and enter the same
   value.
7. Reload the target web page.

No deployment hostname is embedded in the userscript. On first use, it asks for
the endpoint if none has been saved.

The metadata contains `@connect *` because the Worker hostname is configured at
runtime. To use a narrower permission, replace it after deployment with the
specific Worker hostname:

```javascript
// @connect      YOUR_WORKER_HOST
```

## Usage

### Point mode

Click the floating `朗` button. It changes to `点`. Click any readable sentence
to start speech. Click the button again to leave point mode.

### Shortcut mode

- `Alt` + click: read the sentence under the pointer.
- Select text, then press `Alt` + `R`: read the selection. The userscript uses
  the physical `KeyR` code so the shortcut also works with non-Latin keyboard
  layouts and input methods.
- `Esc`: stop playback and leave point mode.

Button states:

- `朗`: idle.
- `点`: point mode enabled.
- `…`: waiting for the first audio data.
- `■`: playing; click to stop.
- `!`: an error occurred; hover over the button for details.

### Settings

The userscript menu provides:

- **Set Worker endpoint**
- **Set API_TOKEN**
- **Set voice**
- **Set rate (for example -20%)**
- **停止朗读**

Voice names use Microsoft short-name format, for example:

```text
ja-JP-NanamiNeural
ja-JP-KeitaNeural
zh-CN-XiaoxiaoNeural
en-US-EmmaMultilingualNeural
```

Rates must include a sign and percent suffix, such as `-20%`, `+0%`, or `+25%`.

## Worker API

### `POST /tts`

Request:

```bash
curl https://YOUR_WORKER_HOST/tts \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_TOKEN' \
  --data '{
    "text": "こんにちは。",
    "voice": "ja-JP-NanamiNeural",
    "rate": "-20%"
  }' \
  --output speech.mp3
```

The response is a streamed `audio/mpeg` body. The `Authorization` header is only
required when the Worker has an `API_TOKEN` secret.

Limits and validation:

- Text is limited to 4,000 UTF-8 bytes per request.
- Voice names may contain letters, digits, and hyphens.
- Rate must be between `-100%` and `+100%`.

### `GET /health`

Returns a small JSON health response. It does not test the upstream Microsoft
speech connection.

### `GET /`

Returns a basic deployment and privacy information page.

## Troubleshooting

### The button asks for a Worker address

Use the complete HTTPS `/tts` endpoint, not only the Worker origin.

### HTTP 401

The Worker has `API_TOKEN` enabled, but the userscript token is absent or does
not match. Set it again from the userscript menu.

### HTTP 502, 403, or 503

Microsoft's Edge speech endpoint is unofficial and can reject or temporarily
throttle connections. Check that the Worker clock and compatibility date are
current, then retry. A Microsoft protocol change may require updating the
Chromium version and token-generation constants in the Worker.

### Playback starts slowly

On Chromium, verify in the console that `MediaSource.isTypeSupported("audio/mpeg")`
returns `true`. The first request can still include Worker startup and upstream
WebSocket connection latency. Long sentences take longer to synthesize.

### Playback is blocked

Start reading with a direct click or keyboard shortcut. Browser autoplay rules
can reject playback that is not associated with a user gesture.

### It does not work on a browser PDF or internal page

Userscripts cannot normally run on `chrome://`, extension pages, or built-in PDF
viewer pages. Use a normal HTML/PDF.js page or a dedicated browser extension for
those cases.

### A page click activates a link instead of speech

Enable point mode first, or hold `Alt` while clicking. Interactive controls such
as inputs, text areas, selects, and buttons are intentionally ignored.

## Related projects

- [`travisvn/edge-tts-extension`](https://github.com/travisvn/edge-tts-extension)
  is a ready-made browser extension, but it does not provide the Japanese voice
  required for this use case.
- [`yangyaofei/edge-tts`](https://github.com/yangyaofei/edge-tts) provides
  streaming, preloading, and click navigation, but requires a local backend.
- [`ken107/read-aloud`](https://github.com/ken107/read-aloud) is a convenient
  general read-aloud extension, but its available voice quality is generally
  below the Edge neural voice used here.
- [`linshenkx/edge-tts-openai-cf-worker`](https://github.com/linshenkx/edge-tts-openai-cf-worker)
  provides a similar Cloudflare Worker approach. This project builds on that
  general design and adds the standalone click-to-read userscript and browser
  streaming playback.
- [`beanwl/read-aloud`](https://github.com/beanwl/read-aloud) supports a Linux
  browser integration but requires a local daemon.

## Security and maintenance notes

- Configure `API_TOKEN` before sharing the Worker address.
- The userscript stores its endpoint, token, voice, and rate in userscript
  manager storage.
- Do not commit a real API token into either JavaScript file.
- Edge TTS is an unofficial interface and can change without notice.
- This implementation is intended for personal use. Review Microsoft's and
  Cloudflare's applicable terms and limits before broader deployment.
