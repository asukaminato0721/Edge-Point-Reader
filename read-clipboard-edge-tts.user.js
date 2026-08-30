// ==UserScript==
// @name         Edge Point Reader (Linux)
// @namespace    edge-point-reader
// @version      1.6.0
// @description  Stream Edge neural speech with word tracking for selected text
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
  const NON_SPEECH_SELECTOR = "rt,rp,script,style,noscript,[aria-hidden=true]";
  const TIMED_STREAM_TYPE = "application/vnd.edge-point-reader.timed-stream";
  const FRAME_AUDIO = 1;
  const FRAME_WORD_BOUNDARY = 2;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let busy = false;
  let requestHandle = null;
  let abortController = null;
  let audio = null;
  let mediaSource = null;
  let objectUrl = null;
  let highlightedBlock = null;
  let requestSerial = 0;
  let errorTimer = null;
  let selectionFrame = 0;
  let dragState = null;
  let draggedBadge = false;
  let badgePosition = null;
  let speechMap = null;
  let wordTimeline = [];
  let wordSearchOffset = 0;
  let wordFrame = 0;
  let highlightedWord = -1;

  const selectionButton = document.createElement("button");
  selectionButton.type = "button";
  selectionButton.textContent = "朗";
  selectionButton.className = "edge-point-reader-selection-button";
  selectionButton.title = "朗读选中文字";
  selectionButton.setAttribute("aria-label", "朗读选中文字");
  selectionButton.hidden = true;
  selectionButton.style.cssText = [
    "all:initial", "display:none", "position:fixed", "z-index:2147483647", "box-sizing:border-box",
    "width:30px", "height:30px", "border-radius:9px", "border:1px solid #ffffff88",
    "background:#1769e0", "color:white", "font:600 14px/28px system-ui,sans-serif",
    "text-align:center", "box-shadow:0 2px 9px #0005", "cursor:grab", "user-select:none",
    "touch-action:none",
  ].join(";");
  document.documentElement.append(selectionButton);

  const style = document.createElement("style");
  style.textContent = `
    ::highlight(edge-point-reader-current) { background: rgba(255, 205, 40, .20); }
    ::highlight(edge-point-reader-word) { background: rgba(255, 145, 0, .72); }
    .edge-point-reader-block { outline: 3px solid rgba(255, 190, 20, .65) !important; outline-offset: 2px !important; }
    .edge-point-reader-selection-button { opacity: .52 !important; transition: opacity .15s ease !important; }
    .edge-point-reader-selection-button:hover,
    .edge-point-reader-selection-button:focus-visible { opacity: .95 !important; }
    .edge-point-reader-selection-button.edge-point-reader-dragging,
    .edge-point-reader-selection-button.edge-point-reader-error { opacity: .82 !important; }
  `;
  document.documentElement.append(style);

  selectionButton.addEventListener("pointerdown", (event) => {
    // Keep the document selection intact until the click handler reads it.
    event.preventDefault();
    event.stopPropagation();
    draggedBadge = false;
    const rect = selectionButton.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    selectionButton.style.cursor = "grabbing";
    selectionButton.classList.add("edge-point-reader-dragging");
    try { selectionButton.setPointerCapture?.(event.pointerId); } catch {}
  });

  selectionButton.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) draggedBadge = true;
    if (!draggedBadge) return;
    badgePosition = clampBadgePosition(dragState.left + dx, dragState.top + dy);
    applyBadgePosition(badgePosition);
  });

  selectionButton.addEventListener("pointerup", finishBadgeDrag);
  selectionButton.addEventListener("pointercancel", finishBadgeDrag);

  function finishBadgeDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    try { selectionButton.releasePointerCapture?.(event.pointerId); } catch {}
    selectionButton.style.cursor = "grab";
    selectionButton.classList.remove("edge-point-reader-dragging");
    dragState = null;
  }

  selectionButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (draggedBadge) {
      draggedBadge = false;
      return;
    }
    const selected = getSelectedContent();
    if (!selected.text) {
      hideSelectionButton();
      return;
    }
    void speak(selected.text, selected.range, selected.block, selected.map);
  });

  document.addEventListener("pointerdown", (event) => {
    if (!busy || event.button !== 0) return;
    const word = wordAtPoint(event.clientX, event.clientY);
    if (!word) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    seekToWord(word);
  }, true);

  document.addEventListener("click", (event) => {
    if (!busy || event.button !== 0) return;
    const word = wordAtPoint(event.clientX, event.clientY);
    if (!word) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("selectionchange", () => {
    clearTimeout(errorTimer);
    errorTimer = null;
    resetSelectionButton();
    badgePosition = null;
    scheduleSelectionButton();
  });
  document.addEventListener("pointerup", scheduleSelectionButton);
  document.addEventListener("keyup", scheduleSelectionButton);
  window.addEventListener("resize", scheduleSelectionButton);
  document.addEventListener("scroll", scheduleSelectionButton, true);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      stop();
    } else if (isReadSelectionShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;

      const selected = getSelectedContent();
      if (!selected.text) {
        showError("请先选择要朗读的文字");
        return;
      }
      void speak(selected.text, selected.range, selected.block, selected.map);
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
        map: null,
      };
    }

    const selection = getSelection();
    const range = selection && !selection.isCollapsed && selection.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null;
    const map = range ? readableRangeMap(range) : null;
    const text = map?.text || selection?.toString().trim() || "";
    const common = range?.commonAncestorContainer;
    return {
      text,
      range,
      block: common?.nodeType === Node.ELEMENT_NODE ? common : common?.parentElement,
      map,
    };
  }

  function scheduleSelectionButton() {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(updateSelectionButton);
  }

  function updateSelectionButton() {
    selectionFrame = 0;
    if (busy) {
      hideSelectionButton();
      return;
    }

    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      if (start === end || !active.value.slice(start, end).trim()) {
        hideSelectionButton();
        return;
      }
      placeSelectionButton(active.getBoundingClientRect());
      return;
    }

    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim() || !selection.rangeCount) {
      hideSelectionButton();
      return;
    }

    const range = selection.getRangeAt(0);
    placeSelectionButton(selectionEndpointRect(selection, range));
  }

  function selectionEndpointRect(selection, range) {
    try {
      const endpoint = document.createRange();
      endpoint.setStart(selection.focusNode, selection.focusOffset);
      endpoint.collapse(true);
      const rect = endpoint.getClientRects()[0];
      // A collapsed caret is thin in its inline direction. Some vertical-layout
      // engines instead return the containing line box for element boundaries.
      if (rect && (rect.width || rect.height) && (rect.width <= 2 || rect.height <= 2)) return rect;
    } catch {}

    const rects = range.getClientRects();
    return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  }

  function placeSelectionButton(rect) {
    if (!rect || (!rect.width && !rect.height)) {
      hideSelectionButton();
      return;
    }
    if (!badgePosition) {
      const gap = 6;
      const size = 30;
      const preferredLeft = rect.right + gap;
      const preferredTop = rect.bottom + gap;
      const alternateLeft = rect.left - size - gap;
      const alternateTop = rect.top - size - gap;
      const left = preferredLeft + size <= innerWidth - gap ? preferredLeft : alternateLeft;
      const top = preferredTop + size <= innerHeight - gap ? preferredTop : alternateTop;
      badgePosition = clampBadgePosition(left, top);
    } else {
      badgePosition = clampBadgePosition(badgePosition.left, badgePosition.top);
    }
    applyBadgePosition(badgePosition);
    selectionButton.style.display = "block";
    selectionButton.hidden = false;
  }

  function clampBadgePosition(left, top) {
    const gap = 6;
    const size = 30;
    return {
      left: Math.max(gap, Math.min(left, innerWidth - size - gap)),
      top: Math.max(gap, Math.min(top, innerHeight - size - gap)),
    };
  }

  function applyBadgePosition(position) {
    selectionButton.style.left = `${position.left}px`;
    selectionButton.style.top = `${position.top}px`;
  }

  function hideSelectionButton() {
    selectionButton.hidden = true;
    selectionButton.style.display = "none";
  }

  function readableRangeMap(range) {
    try {
      const common = range.commonAncestorContainer;
      const root = common.nodeType === Node.TEXT_NODE ? common.parentNode : common;
      if (!root) return null;

      const nodes = [];
      if (common.nodeType === Node.TEXT_NODE) nodes.push(common);
      else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      }

      const segments = [];
      let text = "";
      for (const node of nodes) {
        if (node.parentElement?.closest(NON_SPEECH_SELECTOR)) continue;
        if (!range.intersectsNode(node)) continue;
        const nodeStart = node === range.startContainer ? range.startOffset : 0;
        const nodeEnd = node === range.endContainer ? range.endOffset : node.data.length;
        if (nodeEnd <= nodeStart) continue;
        const value = node.data.slice(nodeStart, nodeEnd);
        segments.push({
          node,
          nodeStart,
          nodeEnd,
          textStart: text.length,
          textEnd: text.length + value.length,
        });
        text += value;
      }

      const leading = text.length - text.trimStart().length;
      const contentEnd = text.trimEnd().length;
      if (contentEnd <= leading) return null;
      const trimmedSegments = [];
      for (const segment of segments) {
        const start = Math.max(segment.textStart, leading);
        const end = Math.min(segment.textEnd, contentEnd);
        if (end <= start) continue;
        trimmedSegments.push({
          node: segment.node,
          nodeStart: segment.nodeStart + start - segment.textStart,
          nodeEnd: segment.nodeStart + end - segment.textStart,
          textStart: start - leading,
          textEnd: end - leading,
        });
      }
      return { text: text.slice(leading, contentEnd), segments: trimmedSegments };
    } catch {
      return null;
    }
  }

  async function speak(text, range, block, textMap) {
    stop();
    const serial = ++requestSerial;
    const endpoint = getEndpoint();
    if (!endpoint) return;

    busy = true;
    highlight(range, block);

    const spokenText = trimUtf8(text, 4000);
    prepareWordTracking(textMap, spokenText);

    const payload = JSON.stringify({
      text: spokenText,
      voice: getValue("voice", "ja-JP-NanamiNeural"),
      rate: getValue("rate", "-20%"),
    });

    const token = getValue("token", "");
    try {
      if (canStreamMp3()) {
        await streamAudio(endpoint, token, payload, serial);
      } else {
        const blob = await requestAudio(endpoint, token, payload, serial);
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
    if (!response.headers.get("Content-Type")?.toLowerCase().includes(TIMED_STREAM_TYPE)) {
      throw new Error("Worker 没有返回逐词时间轴数据");
    }
    if (!response.body) throw new Error("浏览器没有提供流式响应");

    const sourceBuffer = source.addSourceBuffer("audio/mpeg");
    const reader = response.body.getReader();
    const frameParser = createFrameParser();
    let receivedBytes = 0;
    let receivedBoundaries = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (serial !== requestSerial) {
          await reader.cancel();
          return;
        }
        if (!value?.byteLength) continue;
        for (const frame of frameParser.push(value)) {
          if (frame.type === FRAME_AUDIO) {
            receivedBytes += frame.payload.byteLength;
            await appendBuffer(sourceBuffer, frame.payload, controller.signal);
          } else if (frame.type === FRAME_WORD_BOUNDARY) {
            if (addWordBoundary(JSON.parse(decoder.decode(frame.payload)), serial)) {
              receivedBoundaries++;
            }
          }
        }
      }

      frameParser.finish();
      if (!receivedBytes) throw new Error("Worker 返回了空音频");
      if (!receivedBoundaries) throw new Error("Worker 没有返回词边界时间轴");
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
    player.ontimeupdate = scheduleWordFrame;
    player.onplaying = scheduleWordFrame;
    player.onseeked = scheduleWordFrame;
    player.onpause = cancelWordFrame;
    player.onerror = () => {
      if (audio === player && serial === requestSerial) fail("音频播放失败");
    };

    // This is called before the first await, while the click still counts as a
    // user gesture. MediaSource will feed audio to the pending player shortly.
    void player.play().then(
      undefined,
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

  function createFrameParser() {
    let pending = new Uint8Array(0);
    return {
      push(chunk) {
        const input = new Uint8Array(pending.byteLength + chunk.byteLength);
        input.set(pending);
        input.set(chunk, pending.byteLength);
        const frames = [];
        let offset = 0;
        while (input.byteLength - offset >= 5) {
          const type = input[offset];
          if (type !== FRAME_AUDIO && type !== FRAME_WORD_BOUNDARY) {
            throw new Error("Worker 返回了无效的数据帧类型");
          }
          const length = new DataView(input.buffer, input.byteOffset + offset + 1, 4)
            .getUint32(0);
          if (length > 32 * 1024 * 1024) throw new Error("Worker 返回了无效的数据帧");
          if (input.byteLength - offset - 5 < length) break;
          frames.push({
            type,
            payload: input.slice(offset + 5, offset + 5 + length),
          });
          offset += 5 + length;
        }
        pending = input.slice(offset);
        return frames;
      },
      finish() {
        if (pending.byteLength) throw new Error("Worker 返回了不完整的数据帧");
      },
    };
  }

  function decodeTimedAudio(buffer, serial) {
    if (!(buffer instanceof ArrayBuffer)) throw new Error("Worker 没有返回音频数据");
    const parser = createFrameParser();
    const audioChunks = [];
    let receivedBoundaries = 0;
    for (const frame of parser.push(new Uint8Array(buffer))) {
      if (frame.type === FRAME_AUDIO) audioChunks.push(frame.payload);
      else if (addWordBoundary(JSON.parse(decoder.decode(frame.payload)), serial)) {
        receivedBoundaries++;
      }
    }
    parser.finish();
    const blob = new Blob(audioChunks, { type: "audio/mpeg" });
    if (!blob.size) throw new Error("Worker 返回了空音频");
    if (!receivedBoundaries) throw new Error("Worker 没有返回词边界时间轴");
    return blob;
  }

  function prepareWordTracking(map, text) {
    speechMap = map && map.text.startsWith(text)
      ? { text, segments: map.segments }
      : null;
    wordTimeline = [];
    wordSearchOffset = 0;
    highlightedWord = -1;
  }

  function addWordBoundary(boundary, serial) {
    if (serial !== requestSerial) return false;
    const offset = Number(boundary?.offset);
    const duration = Number(boundary?.duration);
    const text = typeof boundary?.text === "string" ? boundary.text : "";
    if (!Number.isFinite(offset) || !Number.isFinite(duration) || !text) return false;

    let textStart = -1;
    let range = null;
    if (speechMap) {
      textStart = speechMap.text.indexOf(text, wordSearchOffset);
      if (textStart >= 0) {
        wordSearchOffset = textStart + text.length;
        range = rangeForTextOffsets(textStart, wordSearchOffset);
      }
    }

    wordTimeline.push({
      start: offset / 10_000_000,
      duration: duration / 10_000_000,
      textStart,
      text,
      range,
    });
    scheduleWordFrame();
    return true;
  }

  function rangeForTextOffsets(start, end) {
    const startPoint = pointForTextOffset(start, false);
    const endPoint = pointForTextOffset(end, true);
    if (!startPoint || !endPoint) return null;
    try {
      const range = document.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      return range;
    } catch {
      return null;
    }
  }

  function pointForTextOffset(offset, endBias) {
    if (!speechMap) return null;
    for (const segment of speechMap.segments) {
      const inside = endBias
        ? offset > segment.textStart && offset <= segment.textEnd
        : offset >= segment.textStart && offset < segment.textEnd;
      if (!inside) continue;
      return {
        node: segment.node,
        offset: segment.nodeStart + offset - segment.textStart,
      };
    }
    return null;
  }

  function scheduleWordFrame() {
    cancelAnimationFrame(wordFrame);
    wordFrame = requestAnimationFrame(updateWordHighlight);
  }

  function cancelWordFrame() {
    cancelAnimationFrame(wordFrame);
    wordFrame = 0;
  }

  function updateWordHighlight() {
    wordFrame = 0;
    const player = audio;
    if (!player) return;
    setHighlightedWord(wordIndexAtTime(player.currentTime));
    if (!player.paused && !player.ended) {
      wordFrame = requestAnimationFrame(updateWordHighlight);
    }
  }

  function wordIndexAtTime(time) {
    let low = 0;
    let high = wordTimeline.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (wordTimeline[middle].start <= time + 0.015) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (found < 0) return -1;
    const word = wordTimeline[found];
    if (found === wordTimeline.length - 1 && time > word.start + word.duration + 0.15) {
      return -1;
    }
    return found;
  }

  function setHighlightedWord(index) {
    if (highlightedWord === index) return;
    highlightedWord = index;
    globalThis.CSS?.highlights?.delete?.("edge-point-reader-word");
    const range = wordTimeline[index]?.range;
    if (!range || !globalThis.Highlight || !globalThis.CSS?.highlights) return;
    const highlight = new Highlight(range);
    highlight.priority = 1;
    CSS.highlights.set("edge-point-reader-word", highlight);
  }

  function wordAtPoint(x, y) {
    for (const word of wordTimeline) {
      if (!word.range) continue;
      for (const rect of word.range.getClientRects()) {
        if (x >= rect.left - 2 && x <= rect.right + 2 &&
            y >= rect.top - 2 && y <= rect.bottom + 2) return word;
      }
    }
    return null;
  }

  function seekToWord(word) {
    const player = audio;
    if (!player) return;
    try {
      player.currentTime = Math.max(0, word.start);
      setHighlightedWord(wordTimeline.indexOf(word));
      if (player.paused) void player.play();
    } catch (error) {
      console.warn("[Edge 点读] 无法跳到所点文字", error);
    }
  }

  function clearWordTracking() {
    cancelWordFrame();
    globalThis.CSS?.highlights?.delete?.("edge-point-reader-word");
    speechMap = null;
    wordTimeline = [];
    wordSearchOffset = 0;
    highlightedWord = -1;
  }

  function requestAudio(endpoint, token, payload, serial) {
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
        responseType: "arraybuffer",
        timeout: 35000,
        onload(response) {
          requestHandle = null;
          if (response.status >= 200 && response.status < 300) {
            try {
              resolve(decodeTimedAudio(response.response, serial));
            } catch (error) {
              reject(error);
            }
            return;
          }
          const detail = response.response
            ? decoder.decode(new Uint8Array(response.response))
            : "";
          reject(new Error(detail
            ? `TTS ${response.status}: ${detail}`
            : `TTS 请求失败：HTTP ${response.status}`));
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
    player.ontimeupdate = null;
    player.onplaying = null;
    player.onseeked = null;
    player.onpause = null;
    audio = null;
    mediaSource = null;
    busy = false;
    revokeAudioUrl();
    clearHighlight();
    clearWordTracking();
    resetSelectionButton();
    scheduleSelectionButton();
  }

  function stop() {
    requestSerial++;
    clearTimeout(errorTimer);
    errorTimer = null;
    hideSelectionButton();

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
      player.ontimeupdate = null;
      player.onplaying = null;
      player.onseeked = null;
      player.onpause = null;
      try { player.pause(); } catch {}
      player.removeAttribute("src");
    }

    mediaSource = null;

    busy = false;
    revokeAudioUrl();
    clearHighlight();
    clearWordTracking();
    resetSelectionButton();
    scheduleSelectionButton();
  }

  function fail(message) {
    console.error("[Edge 点读]", message);
    stop();
    showError(message);
  }

  function showError(message) {
    resetSelectionButton();
    updateSelectionButton();
    if (selectionButton.hidden) return;
    selectionButton.textContent = "!";
    selectionButton.title = `Edge 点读：${message}`;
    selectionButton.setAttribute("aria-label", `Edge 点读错误：${message}`);
    selectionButton.style.background = "#c62828";
    selectionButton.classList.add("edge-point-reader-error");
    errorTimer = setTimeout(() => {
      resetSelectionButton();
      scheduleSelectionButton();
    }, 4000);
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
    globalThis.CSS?.highlights?.delete?.("edge-point-reader-word");
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

  function resetSelectionButton() {
    selectionButton.textContent = "朗";
    selectionButton.title = "朗读选中文字";
    selectionButton.setAttribute("aria-label", "朗读选中文字");
    selectionButton.style.background = "#1769e0";
    selectionButton.classList.remove("edge-point-reader-error");
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
