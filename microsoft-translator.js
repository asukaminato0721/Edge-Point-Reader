// Translator authorization follows Hoshi Reader Android's client protocol.
// The signing key is a public client constant, not a user's subscription key.
const ENDPOINT = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
const APPLICATION = "MSTranslatorAndroidApp";
const SIGNING_KEY = "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==";
const encoder = new TextEncoder();
let cachedToken;
let pendingToken;
let userId;

async function token() {
  if (cachedToken?.expiresAt > Date.now() / 1000 + 60) return cachedToken;
  if (pendingToken) return pendingToken;
  pendingToken = authorize();
  try {
    cachedToken = await pendingToken;
    return cachedToken;
  } finally {
    pendingToken = undefined;
  }
}

async function authorize() {
  const date = new Date().toUTCString().toLowerCase();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  userId ??= crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(SIGNING_KEY), (ch) => ch.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const input = (APPLICATION + encodeURIComponent(ENDPOINT.split("://")[1]) + date + nonce).toLowerCase();
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(input)));
  const response = await fetch(ENDPOINT, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: {
      "X-ClientVersion": "4.0.530a 5fe1dc6c", "X-UserId": userId,
      "X-ClientTraceId": crypto.randomUUID(), "Accept-Language": "ja-JP",
      "X-MT-Signature": `${APPLICATION}::${btoa(String.fromCharCode(...signature))}::${date}::${nonce}`,
    },
    body: new Uint8Array(0),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Translator authorization returned HTTP ${response.status}`);
  }
  try {
    const { r: region, t: bearer } = await response.json();
    if (typeof region !== "string" || !/^[a-z][a-z0-9]{1,39}$/.test(region) ||
        typeof bearer !== "string" || bearer.length > 16384 || /[^\x21-\x7e]/.test(bearer)) throw new Error();
    const parts = bearer.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();
    const claims = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const { exp: expiresAt } = JSON.parse(atob(claims.padEnd(Math.ceil(claims.length / 4) * 4, "=")));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) throw new Error();
    return { region, bearer, expiresAt };
  } catch {
    // Do not expose the token or authorization response in diagnostics.
    throw new Error("Translator returned invalid authorization data");
  }
}

export async function connectToTranslator() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const authorization = await token();
    const response = await fetch(`https://${authorization.region}.tts.speech.microsoft.com/tts/cognitiveservices/websocket/v1`, {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: {
        Upgrade: "websocket", Authorization: `Bearer ${authorization.bearer}`,
        "X-ConnectionId": crypto.randomUUID().replaceAll("-", ""), "User-Agent": "Hoshi",
      },
    });
    if (response.webSocket) return response;
    await response.body?.cancel();
    if (attempt === 0 && (response.status === 401 || response.status === 403)) {
      if (cachedToken === authorization) cachedToken = undefined;
      continue;
    }
    throw new Error(`Translator WebSocket handshake returned HTTP ${response.status}`);
  }
}
