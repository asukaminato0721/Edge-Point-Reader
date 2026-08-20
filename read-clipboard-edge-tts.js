/**
 * Cloudflare Module Worker for read-clipboard-edge-tts.user.js.
 *
 * Deployment:
 * 1. Authenticate Wrangler if necessary:
 *      npx wrangler login
 * 2. Deploy this file:
 *      npx wrangler deploy ./bin/read-clipboard-edge-tts.js \
 *        --name edge-point-reader --compatibility-date 2026-08-21
 * 3. Protect the endpoint with a secret (strongly recommended):
 *      npx wrangler secret put API_TOKEN --name edge-point-reader
 * 4. Copy the resulting Worker URL, append /tts, and enter it through the
 *    userscript menu item "Set Worker endpoint". Enter the same API_TOKEN
 *    through "Set API_TOKEN" if step 3 was used.
 *
 * Related projects and trade-offs:
 * - travisvn/edge-tts-extension does not provide the Japanese voice needed here.
 * - yangyaofei/edge-tts requires a local backend.
 * - ken107/read-aloud is convenient, but its available voice quality is
 *   generally below the Edge neural voice used here.
 * - This implementation follows a similar Cloudflare Worker approach to
 *   linshenkx/edge-tts-openai-cf-worker and adds a click-to-read userscript.
 * - beanwl/read-aloud requires a local daemon.
 *
 * The Microsoft speech endpoint and XML namespace below are protocol
 * constants, not deployment-specific URLs.
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const EDGE_ENDPOINT =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_EXTENSION_ORIGIN =
  "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const DEFAULT_VOICE = "ja-JP-NanamiNeural";
const DEFAULT_RATE = "-20%";
const MAX_TEXT_BYTES = 4000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return homePage(Boolean(env.API_TOKEN));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "edge-point-reader" });
    }

    if (request.method !== "POST" || url.pathname !== "/tts") {
      return json({ error: "Not found" }, 404);
    }

    if (!isAuthorized(request, env.API_TOKEN)) {
      return json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": 'Bearer realm="edge-point-reader"',
      });
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: "Request body must be JSON" }, 400);
    }

    const text = cleanText(input?.text);
    const voice = typeof input?.voice === "string" ? input.voice : DEFAULT_VOICE;
    const rate = typeof input?.rate === "string" ? input.rate : DEFAULT_RATE;

    if (!text) return json({ error: "text is required" }, 400);
    if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) {
      return json({ error: `text must not exceed ${MAX_TEXT_BYTES} UTF-8 bytes` }, 413);
    }
    if (!/^[A-Za-z][A-Za-z0-9-]{2,79}$/.test(voice)) {
      return json({ error: "invalid voice name" }, 400);
    }
    if (!/^[+-](?:100|[0-9]{1,2})%$/.test(rate)) {
      return json({ error: "rate must be between -100% and +100%" }, 400);
    }

    try {
      return await synthesize(text, voice, rate);
    } catch (error) {
      return json(
        { error: "Edge TTS request failed", detail: String(error?.message || error) },
        502,
      );
    }
  },
};

function isAuthorized(request, configuredToken) {
  if (!configuredToken) return true;
  const authorization = request.headers.get("Authorization") || "";
  return authorization === `Bearer ${configuredToken}`;
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/[\t \f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function synthesize(text, voice, rate) {
  let handshake = await connectToEdge();

  // A 403 is commonly a clock-skew error. Retry once using Microsoft's Date.
  if (!handshake.webSocket && handshake.status === 403) {
    const serverDate = Date.parse(handshake.headers.get("Date") || "");
    if (Number.isFinite(serverDate)) {
      handshake = await connectToEdge(Math.floor(serverDate / 1000));
    }
  }

  const socket = handshake.webSocket;
  if (!socket) {
    throw new Error(`WebSocket handshake returned HTTP ${handshake.status}`);
  }

  socket.binaryType = "arraybuffer";
  socket.accept();

  let controller;
  let completed = false;
  let receivedAudio = false;
  let timeoutId;
  let pendingBinary = Promise.resolve();

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      finish();
    },
  });

  function finish(error) {
    if (completed) return;
    completed = true;
    clearTimeout(timeoutId);
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch {
      // The browser may already have cancelled the response stream.
    }
    try {
      socket.close(1000, "done");
    } catch {
      // The peer may already have closed the socket.
    }
  }

  function handleBinary(data) {
    pendingBinary = pendingBinary.then(async () => {
      if (completed) return;
      const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
      const packet = new Uint8Array(buffer);
      if (packet.byteLength < 2) throw new Error("Invalid Edge TTS audio packet");

      const headerLength = (packet[0] << 8) | packet[1];
      const audioStart = 2 + headerLength;
      if (audioStart > packet.byteLength) throw new Error("Invalid audio header length");

      const headers = new TextDecoder().decode(packet.subarray(2, audioStart));
      if (protocolPath(headers) !== "audio") return;

      const audio = packet.slice(audioStart);
      if (audio.byteLength) {
        receivedAudio = true;
        controller.enqueue(audio);
      }
    });
    pendingBinary.catch(finish);
  }

  socket.addEventListener("message", (event) => {
    if (completed) return;
    try {
      if (typeof event.data === "string") {
        const path = protocolPath(event.data);
        if (path === "turn.end") {
          pendingBinary.then(() => {
            if (!receivedAudio) finish(new Error("Microsoft returned no audio"));
            else finish();
          }, finish);
        } else if (
          path &&
          path !== "audio.metadata" &&
          path !== "response" &&
          path !== "turn.start"
        ) {
          throw new Error(`Unexpected Edge TTS message: ${path}`);
        }
        return;
      }
      handleBinary(event.data);
    } catch (error) {
      finish(error);
    }
  });

  socket.addEventListener("error", () => finish(new Error("Edge TTS WebSocket error")));
  socket.addEventListener("close", () => {
    if (!completed) {
      pendingBinary.then(
        () => finish(receivedAudio ? undefined : new Error("Edge TTS closed early")),
        finish,
      );
    }
  });

  const timestamp = edgeTimestamp();
  socket.send(
    `X-Timestamp:${timestamp}\r\n` +
      "Content-Type:application/json; charset=utf-8\r\n" +
      "Path:speech.config\r\n\r\n" +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
      '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
  );

  const requestId = randomHex(16).toLowerCase();
  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`;
  socket.send(
    `X-RequestId:${requestId}\r\n` +
      "Content-Type:application/ssml+xml\r\n" +
      `X-Timestamp:${timestamp}Z\r\n` +
      `Path:ssml\r\n\r\n${ssml}`,
  );

  timeoutId = setTimeout(() => finish(new Error("Edge TTS timed out")), 30_000);

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function connectToEdge(unixSeconds = Math.floor(Date.now() / 1000)) {
  const connectionId = randomHex(16).toLowerCase();
  const token = await secMsGec(unixSeconds);
  const url = new URL(EDGE_ENDPOINT);
  url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
  url.searchParams.set("ConnectionId", connectionId);
  url.searchParams.set("Sec-MS-GEC", token);
  url.searchParams.set("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION);

  return fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: EDGE_EXTENSION_ORIGIN,
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-WebSocket-Version": "13",
      "User-Agent":
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
        `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
      Cookie: `muid=${randomHex(16)};`,
    },
  });
}

async function secMsGec(unixSeconds) {
  const rounded = BigInt(unixSeconds - (unixSeconds % 300));
  const windowsTicks = (rounded + 11644473600n) * 10000000n;
  const data = new TextEncoder().encode(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function protocolPath(headers) {
  return headers.match(/(?:^|\r\n)Path:([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || "";
}

function edgeTimestamp() {
  const date = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (number) => String(number).padStart(2, "0");
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${two(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:` +
    `${two(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function homePage(tokenEnabled) {
  const tokenStatus = tokenEnabled
    ? "此 Worker 已启用 API_TOKEN。安装后请在油猴菜单中填写同一个令牌。"
    : "此 Worker 未启用 API_TOKEN；任何人都能调用。建议用 wrangler secret put API_TOKEN 设置令牌。";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Edge 点读</title><style>
body{max-width:720px;margin:48px auto;padding:0 20px;font:16px/1.7 system-ui,sans-serif;color:#18202a}
a.button{display:inline-block;padding:10px 16px;border-radius:10px;background:#1769e0;color:#fff;text-decoration:none}
code{background:#eef1f5;padding:2px 5px;border-radius:4px} .warn{padding:12px 15px;background:#fff5cf;border-radius:10px}
</style></head><body><h1>Edge 点读</h1>
<p>在 Linux 的 Chrome、Edge 或 Firefox 中，用 Microsoft Edge 在线语音朗读网页句子。</p>
<p>Worker 已运行。请单独安装 <code>read-clipboard-edge-tts.user.js</code>，并在油猴菜单中设置此 Worker 的 <code>/tts</code> 地址。</p>
<p>脚本中可按住 <code>Alt</code> 点击句子，或点右下角“朗”进入连续点读模式；选中文本后按 <code>Alt+R</code> 也可朗读。</p>
<p class="warn">${tokenStatus}</p>
<p>隐私提示：朗读文字会发往此 Worker 和 Microsoft 的在线语音服务。Edge TTS 是非公开接口，微软升级协议后可能需要同步更新脚本。</p>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
