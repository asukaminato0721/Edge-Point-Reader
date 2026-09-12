// ==UserScript==
// @name         Edge Point Reader (Linux)
// @namespace    edge-point-reader
// @version      1.7.5
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
  // Optional defaults; userscript menu settings override these values.
  const SEMANTIC_API_URL = ""; // Full HTTPS /chat/completions or /responses URL.
  const SEMANTIC_MODEL = "";
  const NON_SPEECH_SELECTOR = "rt,rp,script,style,noscript,[aria-hidden=true]";
  const TIMED_STREAM_TYPE = "application/vnd.edge-point-reader.timed-stream";
  const FRAME_AUDIO = 1;
  const FRAME_WORD_BOUNDARY = 2;
  const FRAME_SEMANTIC_BOUNDARY = 3;
  const MAX_TEXT_BYTES = 4000;
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
  let speechSession = null;
  let semanticTimeline = [];
  let semanticPauseTimer = null;
  let semanticSeekOffset = -1;
  // Keep the last reading's received data in memory after playback stops.
  let semanticPreviewRecords = [];
  let currentSemanticPreview = null;
  let semanticPreviewDialog = null;
  let semanticPreviewText = null;

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
    if (semanticPreviewDialog?.contains(event.target)) return;
    if (!busy || event.button !== 0) return;
    const word = wordAtPoint(event.clientX, event.clientY);
    if (!word) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    seekToWord(word);
  }, true);

  document.addEventListener("click", (event) => {
    if (semanticPreviewDialog?.contains(event.target)) return;
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
    if (semanticPreviewDialog?.open) return;
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
  registerMenu("Set semantic API URL", "semanticApiUrl", SEMANTIC_API_URL);
  registerMenu("Set semantic model", "semanticModel", SEMANTIC_MODEL);
  registerMenu("Set voice", "voice", "ja-JP-NanamiNeural");
  registerMenu("Set rate (for example -20%)", "rate", "-20%");
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("查看本次切分", showSemanticPreview);
    GM_registerMenuCommand("切换意义停顿（下次朗读生效）", () => {
      const enabled = !getValue("semantic", true);
      setValue("semantic", enabled);
      alert(`意义停顿已${enabled ? "开启" : "关闭"}，下次朗读生效`);
    });
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

    const chunks = splitTextUtf8(text, MAX_TEXT_BYTES);
    if (!chunks.length) return;
    semanticPreviewRecords = [];
    currentSemanticPreview = null;
    refreshSemanticPreview();

    busy = true;
    highlight(range, block);
    speechSession = {
      serial,
      endpoint,
      token: getValue("token", ""),
      voice: getValue("voice", "ja-JP-NanamiNeural"),
      rate: getValue("rate", "-20%"),
      semantic: getValue("semantic", true),
      semanticApiUrl: getValue("semanticApiUrl", SEMANTIC_API_URL),
      semanticModel: getValue("semanticModel", SEMANTIC_MODEL),
      chunks,
      index: 0,
      textMap,
      words: new Map(),
      player: new Audio(),
    };

    void playSpeechChunk(speechSession);
  }

  async function playSpeechChunk(session, textOffset) {
    if (speechSession !== session || session.serial !== requestSerial) return;
    const serial = session.serial;
    const originalChunk = session.chunks[session.index];
    if (!originalChunk) return;
    const start = textOffset ?? originalChunk.start;
    const chunk = {
      text: originalChunk.text.slice(start - originalChunk.start),
      start,
      end: originalChunk.end,
    };

    prepareWordTracking(session.textMap, chunk);
    currentSemanticPreview = {
      text: chunk.text,
      start: chunk.start,
      chunkIndex: session.index,
      source: session.semantic ? "pending" : "disabled",
      state: "receiving",
      boundaries: [],
    };
    semanticPreviewRecords.push(currentSemanticPreview);
    refreshSemanticPreview();
    const payload = JSON.stringify({
      text: chunk.text,
      voice: session.voice,
      rate: session.rate,
      semantic: session.semantic,
      semanticApiUrl: session.semanticApiUrl,
      semanticModel: session.semanticModel,
    });

    try {
      if (canStreamMp3()) {
        await streamAudio(
          session.endpoint,
          session.token,
          payload,
          serial,
          session.player,
        );
      } else {
        const blob = await requestAudio(
          session.endpoint,
          session.token,
          payload,
          serial,
        );
        if (speechSession !== session || serial !== requestSerial) return;
        if (!blob?.size) throw new Error("Worker 返回了空音频");
        objectUrl = URL.createObjectURL(blob);
        session.player.src = objectUrl;
        startPlayer(session.player, serial);
      }
    } catch (error) {
      if (speechSession !== session || serial !== requestSerial) return;
      if (error?.name === "AbortError") return;
      finishSemanticPreview(currentSemanticPreview, "failed", serial);
      fail(error?.message || String(error));
    }
  }

  function canStreamMp3() {
    return Boolean(globalThis.MediaSource?.isTypeSupported?.("audio/mpeg"));
  }

  async function streamAudio(endpoint, token, payload, serial, player) {
    const preview = currentSemanticPreview;
    const controller = new AbortController();
    abortController = controller;

    const source = new MediaSource();
    mediaSource = source;
    objectUrl = URL.createObjectURL(source);
    player.src = objectUrl;
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
    setSemanticPreviewSource(preview, response.headers.get("X-Semantic-Source"), serial,
      response.headers.get("X-Semantic-Error"));

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
          } else if (frame.type === FRAME_SEMANTIC_BOUNDARY) {
            addSemanticBoundary(JSON.parse(decoder.decode(frame.payload)), serial);
          }
        }
      }

      frameParser.finish();
      if (!receivedBytes) throw new Error("Worker 返回了空音频");
      if (!receivedBoundaries) throw new Error("Worker 没有返回词边界时间轴");
      finishSemanticPreview(preview, "complete", serial);
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
    player.onplaying = () => {
      clearSemanticPause();
      scheduleWordFrame();
    };
    player.onseeking = () => resetSemanticSeek(player.currentTime);
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
          if (type !== FRAME_AUDIO && type !== FRAME_WORD_BOUNDARY &&
              type !== FRAME_SEMANTIC_BOUNDARY) {
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
      else if (frame.type === FRAME_WORD_BOUNDARY) {
        if (addWordBoundary(JSON.parse(decoder.decode(frame.payload)), serial)) {
          receivedBoundaries++;
        }
      } else if (frame.type === FRAME_SEMANTIC_BOUNDARY) {
        addSemanticBoundary(JSON.parse(decoder.decode(frame.payload)), serial);
      }
    }
    parser.finish();
    const blob = new Blob(audioChunks, { type: "audio/mpeg" });
    if (!blob.size) throw new Error("Worker 返回了空音频");
    if (!receivedBoundaries) throw new Error("Worker 没有返回词边界时间轴");
    return blob;
  }

  function prepareWordTracking(map, chunk) {
    clearWordTracking();
    speechMap = map && map.text.slice(chunk.start, chunk.end) === chunk.text
      ? { text: chunk.text, textOffset: chunk.start, segments: map.segments }
      : { text: chunk.text, textOffset: chunk.start, segments: [] };
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

    const word = {
      start: offset / 10_000_000,
      duration: duration / 10_000_000,
      textStart,
      text,
      range,
      textOffset: textStart >= 0 ? speechMap.textOffset + textStart : -1,
      chunkIndex: speechSession?.index,
    };
    wordTimeline.push(word);
    // Keep DOM positions for earlier chunks after their audio is released.
    if (range) speechSession?.words.set(word.textOffset, word);
    resolveSemanticTimes();
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
    const documentOffset = speechMap.textOffset + offset;
    for (const segment of speechMap.segments) {
      const inside = endBias
        ? documentOffset > segment.textStart && documentOffset <= segment.textEnd
        : documentOffset >= segment.textStart && documentOffset < segment.textEnd;
      if (!inside) continue;
      return {
        node: segment.node,
        offset: segment.nodeStart + documentOffset - segment.textStart,
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
    if (maybePauseAtSemanticBoundary(player)) return;
    setHighlightedWord(wordIndexAtTime(player.currentTime));
    if (!player.paused && !player.ended) {
      wordFrame = requestAnimationFrame(updateWordHighlight);
    }
  }

  function addSemanticBoundary(boundary, serial) {
    if (serial !== requestSerial || !speechMap) return;
    // Older Workers can still send punctuation fallback frames. Do not play them.
    if (["fallback", "failed", "disabled"].includes(currentSemanticPreview?.source)) return;
    const offset = boundary?.offset;
    const pauseMs = boundary?.pauseMs;
    if (!Number.isInteger(offset) || offset <= 0 || offset >= speechMap.text.length ||
        !Number.isFinite(pauseMs) || pauseMs <= 0 || pauseMs > 2000) return;
    const existing = semanticTimeline.find((item) => item.offset === offset);
    if (existing) existing.pauseMs = Math.max(existing.pauseMs, pauseMs);
    else {
      semanticTimeline.push({
        offset, pauseMs, level: boundary.level === "large" ? "large" : "small",
        time: null, used: offset <= semanticSeekOffset,
      });
      semanticTimeline.sort((a, b) => a.offset - b.offset);
    }
    if (existing && boundary.level === "large") existing.level = "large";
    if (currentSemanticPreview) {
      currentSemanticPreview.boundaries = semanticTimeline.map(({ offset, pauseMs, level }) => ({ offset, pauseMs, level }));
      refreshSemanticPreview();
    }
    resolveSemanticTimes();
  }

  function setSemanticPreviewSource(preview, source, serial, errorCode) {
    if (!preview || preview !== currentSemanticPreview || serial !== requestSerial) return;
    preview.source = ["ai", "fallback", "failed", "disabled"].includes(source) ? source : "unknown";
    preview.error = semanticErrorDescription(errorCode);
    refreshSemanticPreview();
  }

  function semanticErrorDescription(code) {
    const errors = {
      missing_api_url: "未设置 AI API 地址，请检查 Set semantic API URL。",
      missing_model: "未设置模型，请检查 Set semantic model。",
      missing_token: "Worker 未配置 SEMANTIC_API_TOKEN secret。",
      invalid_api_url: "AI API 地址无效，需要完整的 HTTPS 接口地址。",
      timeout: "AI 请求超过 25 秒，已停止等待。",
      invalid_response: "AI 接口未返回预期的文本格式，请检查接口路径和兼容性。",
      empty_output: "AI 返回了空文本。",
      truncated_output: "AI 输出达到长度限制，未返回完整原文。",
      changed_text: "AI 改动了原文（包括标点、空白或换行），切分结果已拒绝。",
      split_character: "AI 把边界插入了一个 Unicode 字符内部，切分结果已拒绝。",
      network_error: "Worker 无法完成 AI 请求，请检查接口连通性。",
      internal_error: "Worker 处理 AI 结果时出错。",
    };
    if (Object.hasOwn(errors, code)) return errors[code];
    const status = typeof code === "string" ? code.match(/^http_(\d{3})$/)?.[1] : null;
    if (status) {
      if (Number(status) >= 300 && Number(status) < 400) {
        return `AI 接口返回 HTTP ${status} 重定向，请将 Set semantic API URL 改为最终接口地址。`;
      }
      const hints = {
        400: "请求参数被拒绝，请检查模型与接口兼容性。",
        401: "AI Token 无效或已过期。", 403: "AI Token 没有访问权限。",
        404: "接口路径或模型不存在。", 429: "AI 服务限流或额度不足。",
      };
      return `AI 接口返回 HTTP ${status}。${hints[status] || "请检查 AI 服务状态。"}`;
    }
    return "";
  }

  function finishSemanticPreview(preview, state, serial) {
    if (!preview || preview !== currentSemanticPreview || serial !== requestSerial) return;
    preview.state = state;
    refreshSemanticPreview();
  }

  function semanticPreviewContent() {
    if (!semanticPreviewRecords.length) return "还没有朗读记录。请先选择文字并开始朗读。";
    const sources = {
      ai: "AI 切分", fallback: "旧版 Worker 标点回退（已忽略，请更新 Worker）",
      failed: "AI 切分失败（未添加意义停顿）", disabled: "意义停顿已关闭",
      pending: "等待 Worker 返回结果", unknown: "来源未知（请更新 Worker）",
    };
    const states = { receiving: "接收中", complete: "接收完成", stopped: "已中断", failed: "请求失败" };
    const sections = semanticPreviewRecords.map((record, index) => {
      let marked = "";
      let previous = 0;
      for (const boundary of record.boundaries) {
        marked += record.text.slice(previous, boundary.offset) + (boundary.level === "large" ? "‖" : "｜");
        previous = boundary.offset;
      }
      marked += record.text.slice(previous);
      const positions = record.boundaries.length
        ? "边界（本段 UTF-16 偏移 → 停顿）：" + record.boundaries
          .map((boundary) => `${boundary.offset} → ${boundary.pauseMs}ms`).join("；")
        : ["failed", "fallback"].includes(record.source) ? "本段未添加意义停顿。"
          : record.state === "complete" ? "本段没有意义边界。" : "尚未收到意义边界。";
      const error = record.source === "failed" ? `\n原因：${record.error || "Worker 未提供错误详情，请更新 Worker。"}` : "";
      return `请求 ${index + 1} · 第 ${record.chunkIndex + 1} 段 · 选区偏移 ${record.start}\n` +
        `${sources[record.source]} · ${states[record.state]}${error}\n\n${marked}\n\n${positions}`;
    });
    return "｜ 小边界（默认 200ms）  ‖ 大边界（默认 380ms）\n" +
      "以下为本次播放实际收到的切分，不会再次请求 AI。原文自带的 ｜ 和 ‖ 会保留。\n" +
      "这里只确认切分位置；实际暂停会对齐到后一个词，后台播放可能跳过迟到的边界。\n\n" + sections.join("\n\n────────────\n\n");
  }

  function refreshSemanticPreview() {
    const output = semanticPreviewText;
    if (!output) return;
    const content = semanticPreviewContent();
    if (output.value === content) return;
    const { scrollTop, scrollLeft, selectionStart, selectionEnd, selectionDirection } = output;
    output.value = content;
    output.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    output.scrollTop = scrollTop;
    output.scrollLeft = scrollLeft;
  }

  function showSemanticPreview() {
    if (semanticPreviewDialog) {
      refreshSemanticPreview();
      semanticPreviewDialog.focus({ preventScroll: true });
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "本次意义切分");
    dialog.style.cssText = "position:fixed;inset:0;margin:auto;width:min(800px,90vw);max-height:85vh;box-sizing:border-box;padding:20px;border:1px solid #aaa;border-radius:12px;background:#fff;color:#18202a;writing-mode:horizontal-tb;font:16px/1.5 system-ui,sans-serif;";
    const title = document.createElement("h2");
    title.textContent = "本次意义切分";
    title.style.cssText = "margin:0 0 12px;font:600 20px/1.5 system-ui,sans-serif;color:#18202a;";
    const output = document.createElement("textarea");
    output.readOnly = true;
    output.setAttribute("aria-label", "切分结果（可选择复制）");
    output.style.cssText = "display:block;width:100%;height:50vh;box-sizing:border-box;padding:12px;border:1px solid #aaa;background:#f7f8fa;color:#18202a;writing-mode:horizontal-tb;direction:ltr;white-space:pre-wrap;font:16px/1.8 system-ui,sans-serif;resize:vertical;";
    const close = document.createElement("button");
    close.type = "button";
    // Avoid auto-focusing the textarea at the end of its populated value.
    close.autofocus = true;
    close.textContent = "关闭";
    close.style.cssText = "margin-top:12px;padding:6px 18px;border:1px solid #aaa;border-radius:6px;background:#fff;color:#18202a;font:16px/1.5 system-ui,sans-serif;cursor:pointer;";
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      semanticPreviewDialog = null;
      semanticPreviewText = null;
    });
    dialog.append(title, output, close);
    document.documentElement.append(dialog);
    semanticPreviewDialog = dialog;
    semanticPreviewText = output;
    refreshSemanticPreview();
    dialog.showModal();
  }

  function resolveSemanticTimes() {
    for (const boundary of semanticTimeline) {
      if (boundary.time !== null) continue;
      const nextWord = wordTimeline.find((word) => word.textStart >= boundary.offset);
      if (!nextWord) continue;
      boundary.time = nextWord.start;
      // A seek can precede arrival of this word's metadata.
      boundary.used ||= boundary.offset <= semanticSeekOffset ||
        Boolean(audio && boundary.time < audio.currentTime - 0.12);
    }
  }

  function clearSemanticPause() {
    clearTimeout(semanticPauseTimer);
    semanticPauseTimer = null;
  }

  function resetSemanticSeek(time) {
    clearSemanticPause();
    semanticSeekOffset = -1;
    for (const word of wordTimeline) {
      if (word.start <= time + 0.015) semanticSeekOffset = Math.max(semanticSeekOffset, word.textStart);
    }
    for (const boundary of semanticTimeline) {
      boundary.used = boundary.offset <= semanticSeekOffset ||
        (boundary.time !== null && boundary.time <= time + 0.015);
    }
  }

  function maybePauseAtSemanticBoundary(player) {
    if (semanticPauseTimer !== null || player.paused || player.ended || player.seeking) return false;
    const current = player.currentTime;
    let pauseMs = 0;
    for (const boundary of semanticTimeline) {
      if (boundary.used || boundary.time === null || current < boundary.time - 0.015) continue;
      boundary.used = true;
      // Skip stale metadata or background-tab delays; never rewind audible speech.
      if (current <= boundary.time + 0.12) pauseMs = Math.max(pauseMs, boundary.pauseMs);
    }
    if (!pauseMs) return false;
    const session = speechSession;
    const serial = requestSerial;
    player.pause();
    const timer = setTimeout(() => {
      if (semanticPauseTimer !== timer) return;
      semanticPauseTimer = null;
      if (audio !== player || !session || speechSession !== session ||
          requestSerial !== serial || !player.paused || player.ended) return;
      void player.play().catch((error) => {
        if (audio === player && requestSerial === serial && error?.name !== "AbortError") {
          fail(error?.message || "浏览器阻止了音频播放");
        }
      });
    }, pauseMs);
    semanticPauseTimer = timer;
    return true;
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
    if (!range) return;
    keepRangeVisible(range);
    if (!globalThis.Highlight || !globalThis.CSS?.highlights) return;
    const highlight = new Highlight(range);
    highlight.priority = 1;
    CSS.highlights.set("edge-point-reader-word", highlight);
  }

  function keepRangeVisible(range) {
    // Reading continues behind the modal, but must not move the page being inspected.
    if (semanticPreviewDialog?.open) return;
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;

    for (let container = startElement; container; container = container.parentElement) {
      if (container === document.body || container === document.documentElement) continue;
      const axes = scrollableAxes(container);
      if (!axes.x && !axes.y) continue;
      scrollRangeWithin(range, container, axes, 24);
    }

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const margin = Math.min(48, innerWidth / 4, innerHeight / 4);
    const left = overflowDelta(rect.left, rect.right, 0, innerWidth, margin);
    const top = overflowDelta(rect.top, rect.bottom, 0, innerHeight, margin);
    if (!left && !top) return;
    const behavior = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
      ? "auto"
      : "smooth";
    window.scrollBy({ left, top, behavior });
  }

  function scrollableAxes(element) {
    const style = getComputedStyle(element);
    return {
      x: /^(auto|scroll|overlay|hidden)$/.test(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1,
      y: /^(auto|scroll|overlay|hidden)$/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 1,
    };
  }

  function scrollRangeWithin(range, container, axes, margin) {
    const wordRect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const leftEdge = containerRect.left + container.clientLeft;
    const topEdge = containerRect.top + container.clientTop;
    const rightEdge = leftEdge + container.clientWidth;
    const bottomEdge = topEdge + container.clientHeight;
    const horizontalMargin = Math.min(margin, container.clientWidth / 4);
    const verticalMargin = Math.min(margin, container.clientHeight / 4);
    const left = axes.x
      ? overflowDelta(wordRect.left, wordRect.right, leftEdge, rightEdge, horizontalMargin)
      : 0;
    const top = axes.y
      ? overflowDelta(wordRect.top, wordRect.bottom, topEdge, bottomEdge, verticalMargin)
      : 0;
    if (left) container.scrollLeft += left;
    if (top) container.scrollTop += top;
  }

  function overflowDelta(start, end, visibleStart, visibleEnd, margin) {
    if (start < visibleStart + margin) return start - visibleStart - margin;
    if (end > visibleEnd - margin) return end - visibleEnd + margin;
    return 0;
  }

  function wordAtPoint(x, y) {
    // Prefer the current request if synthesis changed word segmentation.
    for (const words of [wordTimeline, speechSession?.words.values() ?? []]) {
      for (const word of words) {
        if (!word.range) continue;
        for (const rect of word.range.getClientRects()) {
          if (x >= rect.left - 2 && x <= rect.right + 2 &&
              y >= rect.top - 2 && y <= rect.bottom + 2) return word;
        }
      }
    }
    return null;
  }

  function seekToWord(word) {
    const session = speechSession;
    if (!session || session.serial !== requestSerial) return;
    const index = wordTimeline.indexOf(word);
    if (index < 0) {
      // Timings belong to one audio request. Re-synthesize from the saved
      // text position when the clicked word is outside the current request.
      session.serial = ++requestSerial;
      releasePlayback();
      session.index = word.chunkIndex;
      void playSpeechChunk(session, word.textOffset);
      return;
    }
    const player = audio;
    if (!player) return;
    try {
      resetSemanticSeek(word.start);
      player.currentTime = Math.max(0, word.start);
      setHighlightedWord(index);
      if (player.paused) void player.play();
    } catch (error) {
      console.warn("[Edge 点读] 无法跳到所点文字", error);
    }
  }

  function clearWordTracking() {
    cancelWordFrame();
    clearSemanticPause();
    semanticTimeline = [];
    semanticSeekOffset = -1;
    globalThis.CSS?.highlights?.delete?.("edge-point-reader-word");
    speechMap = null;
    wordTimeline = [];
    wordSearchOffset = 0;
    highlightedWord = -1;
  }

  function requestAudio(endpoint, token, payload, serial) {
    const preview = currentSemanticPreview;
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
        timeout: 65000,
        onload(response) {
          if (serial !== requestSerial) {
            reject(new DOMException("已停止", "AbortError"));
            return;
          }
          requestHandle = null;
          if (response.status >= 200 && response.status < 300) {
            try {
              const source = response.responseHeaders?.match(/^X-Semantic-Source:\s*([^\r\n]+)/im)?.[1]?.trim();
              const errorCode = response.responseHeaders?.match(/^X-Semantic-Error:\s*([^\r\n]+)/im)?.[1]?.trim();
              setSemanticPreviewSource(preview, source, serial, errorCode);
              const blob = decodeTimedAudio(response.response, serial);
              finishSemanticPreview(preview, "complete", serial);
              resolve(blob);
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
          if (serial === requestSerial) requestHandle = null;
          reject(new Error("无法连接 TTS Worker"));
        },
        ontimeout() {
          if (serial === requestSerial) requestHandle = null;
          reject(new Error("TTS 请求超时"));
        },
        onabort() {
          if (serial === requestSerial) requestHandle = null;
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
    detachPlayer(player);
    audio = null;
    mediaSource = null;
    revokeAudioUrl();
    clearWordTracking();

    const session = speechSession;
    if (session && session.serial === requestSerial && session.index + 1 < session.chunks.length) {
      session.index++;
      void playSpeechChunk(session);
      return;
    }

    speechSession = null;
    busy = false;
    clearHighlight();
    resetSelectionButton();
    scheduleSelectionButton();
  }

  function detachPlayer(player) {
    player.onended = null;
    player.onerror = null;
    player.ontimeupdate = null;
    player.onplaying = null;
    player.onseeked = null;
    player.onseeking = null;
    player.onpause = null;
  }

  function stop() {
    requestSerial++;
    speechSession = null;
    clearTimeout(errorTimer);
    errorTimer = null;
    hideSelectionButton();

    releasePlayback();
    busy = false;
    clearHighlight();
    resetSelectionButton();
    scheduleSelectionButton();
  }

  function releasePlayback() {
    if (currentSemanticPreview?.state === "receiving") {
      currentSemanticPreview.state = "stopped";
      refreshSemanticPreview();
    }
    currentSemanticPreview = null;
    const pending = requestHandle;
    requestHandle = null;
    try { pending?.abort?.(); } catch {}

    const streamingRequest = abortController;
    abortController = null;
    streamingRequest?.abort();

    const player = audio;
    audio = null;
    if (player) {
      detachPlayer(player);
      try { player.pause(); } catch {}
      player.removeAttribute("src");
    }

    mediaSource = null;

    revokeAudioUrl();
    clearWordTracking();
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

  function splitTextUtf8(text, maxBytes) {
    const chunks = [];
    let start = 0;

    while (start < text.length) {
      let end = utf8End(text, start, maxBytes);
      if (end < text.length) end = naturalSplit(text, start, end);
      if (end <= start) end = utf8End(text, start, maxBytes);

      const value = text.slice(start, end);
      if (value.trim()) chunks.push({ text: value, start, end });
      start = end;
    }

    return chunks;
  }

  function utf8End(text, start, maxBytes) {
    if (encoder.encode(text.slice(start)).byteLength <= maxBytes) return text.length;
    let low = 0;
    let high = text.length - start;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(text.slice(start, start + middle)).byteLength <= maxBytes) low = middle;
      else high = middle - 1;
    }
    let end = start + low;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] || "")) end--;
    return end;
  }

  function naturalSplit(text, start, byteEnd) {
    const candidate = text.slice(start, byteEnd);
    const minimum = Math.floor(candidate.length / 2);
    const sentenceEnd = lastBoundary(candidate, /[。！？!?；;\n][」』】）》”’]*[\t ]*/g, minimum);
    if (sentenceEnd > 0) return start + sentenceEnd;
    const phraseEnd = lastBoundary(candidate, /[，,、：:\s]+/g, minimum);
    return phraseEnd > 0 ? start + phraseEnd : byteEnd;
  }

  function lastBoundary(text, pattern, minimum) {
    let boundary = -1;
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end >= minimum) boundary = end;
    }
    return boundary;
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
