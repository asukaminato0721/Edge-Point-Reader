# Edge Point Reader for Linux

Edge Point Reader adds Edge-style selection-to-read speech to normal web pages
on Linux. A userscript shows a small read badge beside selected text, while a
Cloudflare Worker streams Microsoft Edge neural TTS audio back to the browser.

The default voice is `ja-JP-NanamiNeural` at `-20%` rate.

## Features

- Show a small `朗` badge only when text is selected.
- Drag the badge anywhere in the viewport, then click it to read the selection.
- Hide the badge during playback and restore it when playback finishes.
- Read selected text with `Alt` + `R`.
- Support horizontal and vertical EPUB selections; ruby annotations are omitted
  from speech.
- Highlight the word currently being spoken without changing the EPUB DOM.
- Add meaning-based pauses (200 ms / 380 ms) using a user-configured AI API,
  while synthesizing each full request as one continuous Edge utterance.
- While speech is playing, click any word in the selection to continue from
  that word.
- Stream framed MP3 audio and word-boundary timing data with `fetch()` and
  `MediaSource` for faster startup.
- Fall back to buffered playback of the same framed stream when MP3
  `MediaSource` is unavailable.
- Configure the Worker endpoint, API token, voice, and rate from the userscript
  menu.
- Stop the request and playback immediately with `Esc` or the userscript menu.

## Files

- `read-clipboard-edge-tts.js`: Cloudflare Module Worker and Edge TTS proxy.
- `read-clipboard-edge-tts.user.js`: standalone Tampermonkey/Violentmonkey
  userscript.
- `wrangler.jsonc`: Worker deployment configuration.

The Worker does not generate or serve the userscript. The files are independent
so Cloudflare's bundler cannot inject helper functions into the userscript.

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
npx wrangler deploy
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

### Configure semantic chunking

Use your own OpenAI-compatible provider. Set these Worker variables in the
Cloudflare dashboard (Settings → Variables and Secrets), or in `wrangler.jsonc`
under `vars`:

```json
{
  "SEMANTIC_API_URL": "https://YOUR_AI_HOST/v1/chat/completions",
  "SEMANTIC_MODEL": "YOUR_MODEL_ID"
}
```

`SEMANTIC_API_URL` must be the full HTTPS endpoint. A path ending in `/responses`
uses the Responses API; otherwise the Worker uses Chat Completions. Responses
requests use `input` and read message `output_text` content, following the
[Responses API format](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create).
The model is selected by you; no Workers AI binding is required.

Store the provider token as a secret:

```bash
npx wrangler secret put SEMANTIC_API_TOKEN
```

This is separate from `API_TOKEN`, which protects your `/tts` endpoint. Provider
credentials stay in the Worker and are never sent to the userscript. When enabled,
the selected text is also sent to your configured AI provider. The AI may only
insert `｜` and `‖`; any other change, including whitespace changes, rejects the
result. Missing configuration, API errors, or an 8-second timeout fall back to
punctuation boundaries, so speech can continue. No boundary means no extra pause.

Update both the Worker and userscript before enabling this feature: older
userscripts cannot decode type `3` frames. The userscript enables semantic pauses
by default; the menu toggle applies to the next reading session.

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

### Selection badge

Select text to show a small, semi-transparent `朗` badge beside the selection.
It becomes more opaque when hovered. Drag the badge to move it without changing
the selection, or click it to start speech. The badge is hidden during playback
and appears again when playback ends. The current word is highlighted as it is
spoken. During playback, click another word in the selected passage to seek to
it. Long selections are split at sentence or whitespace boundaries and all
chunks are played automatically. When the current word moves outside the visible
area, the page or its scrollable reading container follows it automatically.
After automatic continuation, words from earlier chunks remain clickable.
Clicking one requests new audio starting at that word, then continues through
the remaining chunks. Seeking within the current audio uses its existing timeline.
Clearing the selection hides the badge.

Word highlighting and click-to-seek apply to normal page text, including
horizontal and vertical EPUB content. Text selected inside an `<input>` or
`<textarea>` can still be read, but it has no DOM ranges for per-word tracking.

### Shortcut mode

- Select text, then press `Alt` + `R`: read the selection. The userscript uses
  the physical `KeyR` code so the shortcut also works with non-Latin keyboard
  layouts and input methods.
- `Esc`: stop playback.

Badge states:

- `朗`: the current selection can be read.
- `!`: an error occurred; hover over the badge for details.

### Settings

The userscript menu provides:

- **Set Worker endpoint**
- **Set API_TOKEN**
- **Set voice**
- **Set rate (for example -20%)**
- **切换意义停顿（下次朗读生效）**: toggle semantic pauses, enabled by default.
- **停止朗读**

Voice names use Microsoft short-name format, for example:

```text
ja-JP-NanamiNeural
ja-JP-KeitaNeural
zh-CN-XiaoxiaoNeural
en-US-EmmaMultilingualNeural
```

Rates must include a sign and percent suffix, such as `-20%`, `+0%`, or `+25%`.

Semantic pauses add 200 ms at small boundaries and 380 ms at large boundaries,
on top of Edge's own pauses. The text and DOM are unchanged. Word metadata maps
each boundary to the next word's start; boundaries inside a word move to the next
word. Seeking skips earlier boundaries and rearms later ones. Stopping or changing
chunks cancels pending resume timers. These are browser playback pauses, so timing
is approximate; background-tab throttling may cause pauses to be skipped.

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
    "rate": "-20%",
    "semantic": true
  }' \
  --output speech.epr
```

The response is a streamed
`application/vnd.edge-point-reader.timed-stream` body. It is the only `/tts`
response format; it is not a directly playable MP3. Each frame has a one-byte
type, a four-byte big-endian payload length, and the payload:

- Type `1`: MP3 bytes.
- Type `2`: UTF-8 JSON with `offset`, `duration`, and `text` for a word boundary.
  Offset and duration use 100-nanosecond ticks.
- Type `3`: UTF-8 JSON with `offset`, `pauseMs`, and `level` (`small` or `large`).
  Offset counts UTF-16 code units in the original request text, before whitespace
  cleanup, relative to the current request. These frames precede the audio and
  word frames and are only sent when `semantic` is exactly `true`.

The userscript decodes these frames while it feeds the MP3 payloads to the
player. The `Authorization` header is only required when the Worker has an
`API_TOKEN` secret.

Omit `semantic` or set it to `false` to skip the AI request and extra pauses.

Limits and validation:

- Text is limited to 4,000 UTF-8 bytes per request. The userscript automatically
  splits longer selections into consecutive requests.
- Voice names may contain letters, digits, and hyphens.
- Rate must be between `-100%` and `+100%`.

## Troubleshooting

### The badge asks for a Worker address

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
Semantic chunking adds one AI request before synthesis; disable it from the menu
to compare startup time and phrasing.

### Only punctuation pauses are audible

Check `SEMANTIC_API_URL`, `SEMANTIC_MODEL`, and `SEMANTIC_API_TOKEN`. Worker logs
report when chunking falls back, without logging reading text or provider tokens.
Malformed output, changed text, unsupported provider parameters, and slow responses
all trigger this fallback. Compare models using the same passage and API endpoint;
support for both API formats does not imply identical segmentation quality.

### Playback is blocked

Start reading with a direct click or keyboard shortcut. Browser autoplay rules
can reject playback that is not associated with a user gesture.

### It does not work on a browser PDF or internal page

Userscripts cannot normally run on `chrome://`, extension pages, or built-in PDF
viewer pages. Use a normal HTML/PDF.js page or a dedicated browser extension for
those cases.

### The selection badge does not appear

Make sure the selection contains non-whitespace text. The badge disappears while
audio is playing and returns when playback ends or is stopped.

## Local checks

Run the tests without external services or provider credentials:

```bash
node tests/semantic.test.mjs
node --check read-clipboard-edge-tts.js
node --check read-clipboard-edge-tts.user.js
```

The tests mock the provider, Edge socket, and browser media APIs. They check
protocol handling and playback state; use a deployed Worker and a browser to
evaluate actual Japanese segmentation and pause timing.

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

---

disclaim: This project is helped by gpt 5.6 sol high.
