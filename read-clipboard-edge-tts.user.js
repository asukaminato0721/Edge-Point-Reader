// ==UserScript==
// @name         Edge Point Reader (Linux)
// @namespace    edge-point-reader
// @version      1.3.1
// @description  Stream Edge neural speech by Alt-clicking or enabling point mode
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// ==/UserScript==

(() => {
  "use strict";

  /*
   * Setup:
   * 1. Deploy read-clipboard-edge-tts.js to Cloudflare Workers.
   * 2. Open the userscript manager menu and choose "Set Worker endpoint".
   * 3. Enter the deployed HTTPS URL with /tts appended.
   * 4. If the Worker uses API_TOKEN, set the same value with "Set API_TOKEN".
   */
  const KEY = "edge-point-reader:";
  const BLOCK_SELECTOR = "p,li,blockquote,pre,td,th,figcaption,dd,dt,h1,h2,h3,h4,h5,h6";
  const IGNORE_SELECTOR = "input,textarea,select,option,button,[contenteditable=true]";
  const encoder = new TextEncoder();

  let pointMode = false;
  let busy = false;
  let requestHandle = null;
  let abortController = null;
  let audio = null;
  let mediaSource = null;
  let objectUrl = null;
  let highlightedBlock = null;
  let requestSerial = 0;
  let errorTimer = null;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "朗";
  button.title = "开启点读；Alt+点击可随时朗读";
  button.setAttribute("aria-label", "Edge 点读");
  button.style.cssText = [
    "all:initial", "position:fixed", "right:20px", "bottom:20px", "z-index:2147483647",
    "width:46px", "height:46px", "border-radius:50%", "border:1px solid #ffffff55",
    "background:#1769e0", "color:white", "font:600 18px/46px system-ui,sans-serif",
    "text-align:center", "box-shadow:0 3px 14px #0005", "cursor:pointer", "user-select:none",
  ].join(";");
  document.documentElement.append(button);

  const style = document.createElement("style");
  style.textContent = `
    ::highlight(edge-point-reader-current) { background: rgba(255, 205, 40, .48); }
    .edge-point-reader-block { outline: 3px solid rgba(255, 190, 20, .65) !important; outline-offset: 2px !important; }
    html.edge-point-reader-picking, html.edge-point-reader-picking * { cursor: crosshair !important; }
  `;
  document.documentElement.append(style);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      stop();
      return;
    }
    setPointMode(!pointMode);
  });

  document.addEventListener("click", (event) => {
    if (event.target === button || (!pointMode && !event.altKey)) return;
    if (event.target instanceof Element && event.target.closest(IGNORE_SELECTOR)) return;

    const located = locateSentence(event.clientX, event.clientY, event.target);
    if (!located?.text) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void speak(located.text, located.range, located.block);
  }, true);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      stop();
      setPointMode(false);
    } else if (isReadSelectionShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;

      const selected = getSelectedContent();
      if (!selected.text) {
        showError("请先选择要朗读的文字");
        return;
      }
      void speak(selected.text, selected.range, selected.block);
    }
  }, true);

  registerMenu("Set Worker endpoint", "endpoint", "");
  registerMenu("Set API_TOKEN", "token", "", true);
  registerMenu("Set voice", "voice", "ja-JP-NanamiNeural");
  registerMenu("Set rate (for example -20%)", "rate", "-20%");
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("停止朗读", stop);
  }

  function registerMenu(label, key, fallback, secret = false) {
    if (typeof GM_registerMenuCommand !== "function") return;
    GM_registerMenuCommand(label, () => {
      const current = getValue(key, fallback);
      const hint = secret ? "\n留空表示不使用令牌" : "";
      const value = prompt(`${label}${hint}`, current);
      if (value !== null) setValue(key, value.trim());
    });
  }

  function setPointMode(enabled) {
    pointMode = enabled;
    document.documentElement.classList.toggle("edge-point-reader-picking", enabled);
    resetButton();
  }

  function isReadSelectionShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return false;
    return event.code === "KeyR" || event.key?.toLowerCase() === "r";
  }

  function getSelectedContent() {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      return {
        text: active.value.slice(start, end).trim(),
        range: null,
        block: active,
      };
    }

    const selection = getSelection();
    const text = selection?.toString().trim() || "";
    const range = text && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const common = range?.commonAncestorContainer;
    return {
      text,
      range,
      block: common?.nodeType === Node.ELEMENT_NODE ? common : common?.parentElement,
    };
  }

  function locateSentence(x, y, target) {
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      return {
        text: trimUtf8(selection.toString().trim(), 4000),
        range: selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
        block: selection.anchorNode?.parentElement,
      };
    }

    const caret = document.caretPositionFromPoint?.(x, y);
    const rangeAtPoint = !caret && document.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode || rangeAtPoint?.startContainer;
    const offset = caret?.offset ?? rangeAtPoint?.startOffset;
    if (!node) return null;

    const nodeElement = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    let block = nodeElement?.closest?.(BLOCK_SELECTOR);
    if (!block) block = nearestReadableBlock(target instanceof Element ? target : target?.parentElement);
    if (!block || !block.contains(node) || !block.textContent.trim()) return null;

    const raw = block.textContent;
    const point = characterOffset(block, node, offset);
    if (point === null) return null;
    const bounds = sentenceBounds(raw, point);
    const text = trimUtf8(raw.slice(bounds.start, bounds.end).replace(/\s+/g, " ").trim(), 4000);
    return { text, range: domRange(block, bounds.start, bounds.end), block };
  }

  function nearestReadableBlock(element) {
    let candidate = element;
    while (candidate && candidate !== document.body) {
      const display = getComputedStyle(candidate).display;
      const length = candidate.textContent?.trim().length || 0;
      if ((display === "block" || display === "list-item") && length > 0 && length <= 5000) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return null;
  }

  function characterOffset(root, targetNode, targetOffset) {
    try {
      const prefix = document.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(targetNode, targetOffset);
      return prefix.toString().length;
    } catch {
      return null;
    }
  }

  function sentenceBounds(text, point) {
    if (globalThis.Intl?.Segmenter) {
      const locale = document.documentElement.lang || navigator.language;
      const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
      for (const part of segmenter.segment(text)) {
        const end = part.index + part.segment.length;
        if (point >= part.index && point <= end) {
          let start = part.index;
          while (start < end && /\s/.test(text[start])) start++;
          return { start, end };
        }
      }
    }

    const separators = /[。！？.!?；;\n]/;
    let start = Math.max(0, Math.min(point, text.length));
    let end = start;
    while (start > 0 && !separators.test(text[start - 1])) start--;
    while (end < text.length && !separators.test(text[end])) end++;
    if (end < text.length) end++;
    while (end < text.length && /[」』”’）)】\]\s]/.test(text[end])) end++;
    while (start < end && /\s/.test(text[start])) start++;
    return { start, end };
  }

  function domRange(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let total = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = total + node.data.length;
      if (!started && start <= next) {
        range.setStart(node, Math.max(0, start - total));
        started = true;
      }
      if (started && end <= next) {
        range.setEnd(node, Math.max(0, end - total));
        return range;
      }
      total = next;
    }
    if (started) range.setEnd(root, root.childNodes.length);
    return started ? range : null;
  }

  async function speak(text, range, block) {
    stop();
    const serial = ++requestSerial;
    const endpoint = getEndpoint();
    if (!endpoint) return;

    busy = true;
    highlight(range, block);
    setButton("…", "正在生成语音；点击停止");

    const payload = JSON.stringify({
      text: trimUtf8(text, 4000),
      voice: getValue("voice", "ja-JP-NanamiNeural"),
      rate: getValue("rate", "-20%"),
    });

    const token = getValue("token", "");
    try {
      if (canStreamMp3()) {
        await streamAudio(endpoint, token, payload, serial);
      } else {
        const blob = await requestAudio(endpoint, token, payload);
        if (serial !== requestSerial) return;
        if (!blob?.size) throw new Error("Worker 返回了空音频");
        objectUrl = URL.createObjectURL(blob);
        startPlayer(new Audio(objectUrl), serial);
      }
    } catch (error) {
      if (serial !== requestSerial) return;
      if (error?.name === "AbortError") return;
      fail(error?.message || String(error));
    }
  }

  function canStreamMp3() {
    return Boolean(globalThis.MediaSource?.isTypeSupported?.("audio/mpeg"));
  }

  async function streamAudio(endpoint, token, payload, serial) {
    const controller = new AbortController();
    abortController = controller;

    const source = new MediaSource();
    mediaSource = source;
    objectUrl = URL.createObjectURL(source);
    const player = new Audio(objectUrl);
    startPlayer(player, serial);

    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const [response] = await Promise.all([
      fetch(endpoint, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
        cache: "no-store",
      }),
      waitForEvent(source, "sourceopen", controller.signal),
    ]);

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`TTS ${response.status}: ${detail}`);
    }
    if (!response.body) throw new Error("浏览器没有提供流式响应");

    const sourceBuffer = source.addSourceBuffer("audio/mpeg");
    const reader = response.body.getReader();
    let receivedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (serial !== requestSerial) {
          await reader.cancel();
          return;
        }
        if (!value?.byteLength) continue;
        receivedBytes += value.byteLength;
        await appendBuffer(sourceBuffer, value, controller.signal);
      }

      if (!receivedBytes) throw new Error("Worker 返回了空音频");
      if (source.readyState === "open") {
        if (sourceBuffer.updating) {
          await waitForEvent(sourceBuffer, "updateend", controller.signal);
        }
        source.endOfStream();
      }
    } finally {
      reader.releaseLock();
      if (abortController === controller) abortController = null;
    }
  }

  function startPlayer(player, serial) {
    audio = player;
    player.onended = () => finishPlayback(player);
    player.onerror = () => {
      if (audio === player && serial === requestSerial) fail("音频播放失败");
    };

    // This is called before the first await, while the click still counts as a
    // user gesture. MediaSource will feed audio to the pending player shortly.
    void player.play().then(
      () => {
        if (audio === player && serial === requestSerial) {
          setButton("■", "正在流式朗读；点击停止");
        }
      },
      (error) => {
        if (audio === player && serial === requestSerial && error?.name !== "AbortError") {
          fail(error?.message || "浏览器阻止了音频播放");
        }
      },
    );
  }

  function waitForEvent(target, type, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("已停止", "AbortError"));
        return;
      }
      const cleanup = () => {
        target.removeEventListener(type, onEvent);
        target.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onEvent = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`${type} 失败`));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("已停止", "AbortError"));
      };
      target.addEventListener(type, onEvent, { once: true });
      target.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function appendBuffer(sourceBuffer, chunk, signal) {
    if (sourceBuffer.updating) {
      await waitForEvent(sourceBuffer, "updateend", signal);
    }
    sourceBuffer.appendBuffer(chunk);
    await waitForEvent(sourceBuffer, "updateend", signal);
  }

  function requestAudio(endpoint, token, payload) {
    return new Promise((resolve, reject) => {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("油猴未提供 GM_xmlhttpRequest"));
        return;
      }

      requestHandle = GM_xmlhttpRequest({
        method: "POST",
        url: endpoint,
        headers,
        data: payload,
        responseType: "blob",
        timeout: 35000,
        onload(response) {
          requestHandle = null;
          if (response.status >= 200 && response.status < 300) {
            resolve(response.response);
            return;
          }
          if (response.response?.text) {
            response.response.text().then(
              (value) => reject(new Error(`TTS ${response.status}: ${value}`)),
              () => reject(new Error(`TTS 请求失败：HTTP ${response.status}`)),
            );
          } else {
            reject(new Error(`TTS 请求失败：HTTP ${response.status}`));
          }
        },
        onerror() {
          requestHandle = null;
          reject(new Error("无法连接 TTS Worker"));
        },
        ontimeout() {
          requestHandle = null;
          reject(new Error("TTS 请求超时"));
        },
        onabort() {
          requestHandle = null;
          reject(new DOMException("已停止", "AbortError"));
        },
      });
    });
  }

  function getEndpoint() {
    let endpoint = getValue("endpoint", "").trim();
    if (!/^https:\/\//i.test(endpoint)) {
      const value = prompt("请输入已部署 Worker 的 /tts 地址", endpoint);
      if (value === null) return "";
      endpoint = value.trim();
      if (!/^https:\/\//i.test(endpoint)) {
        showError("Worker 地址必须以 https:// 开头");
        return "";
      }
      setValue("endpoint", endpoint);
    }
    return endpoint.replace(/\/+$/, "");
  }

  function finishPlayback(player) {
    if (audio !== player) return;
    player.onended = null;
    player.onerror = null;
    audio = null;
    mediaSource = null;
    busy = false;
    revokeAudioUrl();
    clearHighlight();
    resetButton();
  }

  function stop() {
    requestSerial++;
    clearTimeout(errorTimer);
    errorTimer = null;

    const pending = requestHandle;
    requestHandle = null;
    try { pending?.abort?.(); } catch {}

    const streamingRequest = abortController;
    abortController = null;
    streamingRequest?.abort();

    const player = audio;
    audio = null;
    if (player) {
      player.onended = null;
      player.onerror = null;
      try { player.pause(); } catch {}
      player.removeAttribute("src");
    }

    mediaSource = null;

    busy = false;
    revokeAudioUrl();
    clearHighlight();
    resetButton();
  }

  function fail(message) {
    console.error("[Edge 点读]", message);
    stop();
    showError(message);
  }

  function showError(message) {
    setButton("!", `Edge 点读：${message}`);
    errorTimer = setTimeout(resetButton, 4000);
  }

  function revokeAudioUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  function highlight(range, block) {
    clearHighlight();
    if (range && globalThis.Highlight && globalThis.CSS?.highlights) {
      CSS.highlights.set("edge-point-reader-current", new Highlight(range));
    } else if (block instanceof Element) {
      highlightedBlock = block;
      block.classList.add("edge-point-reader-block");
    }
  }

  function clearHighlight() {
    globalThis.CSS?.highlights?.delete?.("edge-point-reader-current");
    highlightedBlock?.classList.remove("edge-point-reader-block");
    highlightedBlock = null;
  }

  function trimUtf8(text, maxBytes) {
    if (encoder.encode(text).byteLength <= maxBytes) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(text.slice(0, middle)).byteLength <= maxBytes) low = middle;
      else high = middle - 1;
    }
    const result = text.slice(0, low);
    return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
  }

  function resetButton() {
    setButton(
      pointMode ? "点" : "朗",
      pointMode ? "点读已开启；点击句子朗读" : "开启点读；Alt+点击可随时朗读",
    );
  }

  function setButton(text, title) {
    button.textContent = text;
    button.title = title;
  }

  function getValue(key, fallback) {
    try {
      return typeof GM_getValue === "function" ? GM_getValue(KEY + key, fallback) : fallback;
    } catch {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      if (typeof GM_setValue === "function") GM_setValue(KEY + key, value);
    } catch {}
  }
})();
