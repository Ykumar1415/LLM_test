/**
 * Meet Live Translator — Content Script
 *
 * Injected into Google Meet pages. Creates a Shadow DOM overlay
 * that displays live transcription and translation segments.
 * Connects to the backend text WebSocket for real-time updates.
 */

(() => {
  "use strict";

  // ── Prevent double-injection ─────────────────────

  if (window.__meetTranslatorInjected) return;
  window.__meetTranslatorInjected = true;

  // ── Constants ────────────────────────────────────

  const MAX_SEGMENTS = 15;
  const BACKEND_WS_URL = "ws://localhost:8765/ws/text";
  const LANG_FLAGS = {
    en: "🇺🇸",
    ja: "🇯🇵",
  };

  // ── State ────────────────────────────────────────

  let ws = null;
  let reconnectTimer = null;
  let pingIntervalId = null;
  let currentBackendUrl = null;
  let isVisible = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  // ── Shadow DOM Setup ─────────────────────────────

  const host = document.createElement("div");
  host.id = "meet-translator-host";
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });

  // Inject styles into shadow DOM
  const styleEl = document.createElement("style");
  styleEl.textContent = getOverlayCSS();
  shadow.appendChild(styleEl);

  // Build overlay structure
  const overlay = document.createElement("div");
  overlay.className = "translator-overlay";
  overlay.innerHTML = `
    <div class="translator-header" id="drag-handle">
      <div class="translator-title">
        <span class="translator-icon">🌐</span>
        <span>Live Translator</span>
      </div>
      <div class="translator-controls">
        <span class="translator-status" id="status-dot"></span>
        <button class="translator-btn" id="btn-minimize" title="Minimize">─</button>
        <button class="translator-btn" id="btn-close" title="Close">✕</button>
      </div>
    </div>
    <div class="translator-body" id="segments-container">
      <div class="translator-empty" id="empty-state">
        Waiting for speech…
      </div>
    </div>
  `;
  shadow.appendChild(overlay);

  // ── References ───────────────────────────────────

  const segmentsContainer = shadow.getElementById("segments-container");
  const statusDot = shadow.getElementById("status-dot");
  const emptyState = shadow.getElementById("empty-state");
  const btnMinimize = shadow.getElementById("btn-minimize");
  const btnClose = shadow.getElementById("btn-close");
  const dragHandle = shadow.getElementById("drag-handle");

  // ── Event handlers ───────────────────────────────

  btnMinimize.addEventListener("click", () => {
    const body = shadow.querySelector(".translator-body");
    body.classList.toggle("minimized");
    btnMinimize.textContent = body.classList.contains("minimized") ? "□" : "─";
  });

  btnClose.addEventListener("click", () => {
    hideOverlay();
  });

  // Dragging
  dragHandle.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    isDragging = true;
    const rect = overlay.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    overlay.style.transition = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const x = e.clientX - dragOffset.x;
    const y = e.clientY - dragOffset.y;
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.right = "auto";
    overlay.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      overlay.style.transition = "";
    }
  });

  // ── Message handler from background ──────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "show-overlay":
        showOverlay(msg.backendUrl);
        sendResponse({ ok: true });
        break;

      case "hide-overlay":
        hideOverlay();
        sendResponse({ ok: true });
        break;
    }
  });

  // ── Show / Hide ──────────────────────────────────

  function showOverlay(backendUrl) {
    overlay.classList.add("visible");
    isVisible = true;
    currentBackendUrl = backendUrl;
    connectWebSocket(backendUrl);
  }

  function hideOverlay() {
    overlay.classList.remove("visible");
    isVisible = false;
    disconnectWebSocket();
    clearSegments();
  }

  // ── WebSocket connection ─────────────────────────

  function connectWebSocket(backendUrl) {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const url = backendUrl
      ? `${backendUrl}/ws/text`
      : BACKEND_WS_URL;

    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[Translator] Text WS connected.");
      setStatus("connected");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWSMessage(data);
      } catch (e) {
        console.error("[Translator] Bad message:", e);
      }
    };

    ws.onclose = () => {
      console.log("[Translator] Text WS closed.");
      setStatus("disconnected");
      ws = null;
      clearPingInterval();
      if (isVisible) {
        scheduleReconnect(currentBackendUrl);
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    // Keep-alive pings (clear any previous first)
    clearPingInterval();
    pingIntervalId = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
  }

  function disconnectWebSocket() {
    clearPingInterval();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close(1000);
      ws = null;
    }
  }

  function clearPingInterval() {
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
    }
  }

  function scheduleReconnect(backendUrl) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (isVisible) connectWebSocket(backendUrl);
    }, 3000);
  }

  // ── Handle incoming messages ─────────────────────

  function handleWSMessage(data) {
    switch (data.type) {
      case "status":
        if (data.state === "endpoint") {
          // Status endpoint is no longer heavily relied upon since segments manage their own lifecycles
        } else {
          setStatus(data.state === "ready" ? "connected" : "processing");
        }
        break;

      case "partial_transcript":
        updatePartialTranscript(data);
        break;

      case "segment":
        addSegment(data);
        break;

      case "translation_update":
        updateSegmentTranslation(data);
        break;

      case "pong":
        break;
    }
  }



  // ── UI updates ───────────────────────────────────

  function setStatus(state) {
    statusDot.className = `translator-status ${state}`;
    statusDot.title =
      state === "connected"
        ? "Connected"
        : state === "processing"
          ? "Processing…"
          : state === "error"
            ? "Error"
            : "Disconnected";
  }

  function updatePartialTranscript(data) {
    let partial = shadow.getElementById("partial-segment");
    if (!partial) {
      partial = createSegmentEl("partial-segment");
      segmentsContainer.appendChild(partial);
    }

    const flag = LANG_FLAGS[data.lang] || "🌍";
    partial.querySelector(".seg-original").textContent = data.text;
    partial.querySelector(".seg-translated").textContent = "…";
    partial.querySelector(".seg-direction").textContent = `${flag} `;
    partial.classList.add("partial");

    hideEmptyState();
    scrollToBottom();
  }

  async function addSegment(data) {
    let el = shadow.getElementById(data.id);
    if (!el) {
      el = createSegmentEl(data.id);
      segmentsContainer.appendChild(el);
    }

    const srcFlag = LANG_FLAGS[data.source_lang] || "🌍";
    const tgtFlag = LANG_FLAGS[data.target_lang] || "🌍";

    el.querySelector(".seg-direction").textContent = `${srcFlag}→${tgtFlag}`;
    el.querySelector(".seg-original").textContent = data.original;

    const translatedEl = el.querySelector(".seg-translated");

    // Only set loading state if a translation hasn't arrived yet
    if (!translatedEl.textContent || translatedEl.textContent === "..." || translatedEl.classList.contains("loading")) {
      translatedEl.textContent = "...";
      translatedEl.classList.add("loading");
    }

    if (data.cached) {
      translatedEl.classList.add("cached");
    }

    hideEmptyState();
    trimSegments();
    scrollToBottom();

    if (!el.classList.contains("visible")) {
      requestAnimationFrame(() => el.classList.add("visible"));
    }
  }

  function updateSegmentTranslation(data) {
    const el = shadow.getElementById(data.id);
    if (!el) return; // Segment might have been trimmed away already

    const translatedEl = el.querySelector(".seg-translated");
    translatedEl.textContent = data.translated;
    translatedEl.classList.remove("loading");

    if (data.cached) {
      translatedEl.classList.add("cached");
    }
    scrollToBottom();
  }

  function createSegmentEl(id) {
    const el = document.createElement("div");
    el.className = "translator-segment";
    el.id = id;
    el.innerHTML = `
      <div class="seg-meta">
        <span class="seg-direction"></span>
        <span class="seg-time">${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}</span>
      </div>
      <div class="seg-original"></div>
      <div class="seg-translated"></div>
    `;
    return el;
  }

  function trimSegments() {
    let segments = segmentsContainer.querySelectorAll(".translator-segment");
    while (segments.length > MAX_SEGMENTS) {
      segments[0].remove();
      segments = segmentsContainer.querySelectorAll(".translator-segment");
    }
  }

  function clearSegments() {
    segmentsContainer
      .querySelectorAll(".translator-segment")
      .forEach((el) => el.remove());
    showEmptyState();
  }

  function scrollToBottom() {
    segmentsContainer.scrollTop = segmentsContainer.scrollHeight;
  }

  function hideEmptyState() {
    if (emptyState) emptyState.style.display = "none";
  }

  function showEmptyState() {
    if (emptyState) emptyState.style.display = "";
  }

  // ── Overlay CSS (injected into Shadow DOM) ───────

  function getOverlayCSS() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

      :host {
        all: initial;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      .translator-overlay {
        position: fixed;
        bottom: 100px;
        right: 24px;
        width: 800px;
        max-height: 90vh;
        min-width: 250px;
        min-height: 400px;
        resize: both;
        background: rgba(15, 15, 25, 0.92);
        backdrop-filter: blur(20px) saturate(1.5);
        -webkit-backdrop-filter: blur(20px) saturate(1.5);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 16px;
        box-shadow:
          0 8px 32px rgba(0, 0, 0, 0.5),
          0 0 0 1px rgba(255, 255, 255, 0.05),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
        color: #e8e8f0;
        font-size: 14px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;
        z-index: 2147483647;
      }

      .translator-overlay.visible {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: all;
      }

      /* ── Header ─────────────────── */

      .translator-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        background: rgba(255, 255, 255, 0.03);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        cursor: grab;
        user-select: none;
      }

      .translator-header:active {
        cursor: grabbing;
      }

      .translator-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.3px;
        color: #c8c8f0;
      }

      .translator-icon {
        font-size: 18px;
      }

      .translator-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .translator-btn {
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        color: #a0a0b8;
        width: 26px;
        height: 26px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }

      .translator-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        border-color: rgba(255, 255, 255, 0.15);
      }

      /* ── Status dot ─────────────── */

      .translator-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #555;
        transition: background 0.3s ease;
      }

      .translator-status.connected {
        background: #34d399;
        box-shadow: 0 0 8px rgba(52, 211, 153, 0.4);
      }

      .translator-status.processing {
        background: #fbbf24;
        box-shadow: 0 0 8px rgba(251, 191, 36, 0.4);
        animation: pulse 1.5s infinite;
      }

      .translator-status.disconnected {
        background: #666;
      }

      .translator-status.error {
        background: #ef4444;
        box-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      /* ── Body / Segments ────────── */

      .translator-body {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 90vh;
        transition: max-height 0.3s ease;
      }

      .translator-body.minimized {
        max-height: 0;
        padding: 0 8px;
        overflow: hidden;
      }

      .translator-body::-webkit-scrollbar {
        width: 4px;
      }

      .translator-body::-webkit-scrollbar-track {
        background: transparent;
      }

      .translator-body::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
      }

      .translator-empty {
        color: #5a5a75;
        text-align: center;
        padding: 40px 20px;
        font-size: 13px;
        font-style: italic;
      }

      /* ── Segment card ───────────── */

      .translator-segment {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        padding: 10px 14px;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.3s ease, transform 0.3s ease;
      }

      .translator-segment.visible {
        opacity: 1;
        transform: translateY(0);
      }

      .translator-segment.partial {
        opacity: 0.6;
        border-style: dashed;
      }

      .seg-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
        font-size: 11px;
      }

      .seg-direction {
        font-size: 13px;
      }

      .seg-time {
        color: #5a5a75;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
      }

      .seg-original {
        color: #8888a8;
        font-size: 12px;
        line-height: 1.4;
        margin-bottom: 4px;
        word-break: break-word;
      }

      .seg-translated {
        color: #e8e8f0;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.5;
        word-break: break-word;
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(139, 92, 246, 0.08));
        border-radius: 8px;
        padding: 6px 10px;
      }

      .seg-translated.cached {
        border-left: 2px solid rgba(52, 211, 153, 0.4);
      }

      .seg-translated.local-ai {
        border-left: 2px solid #fca311;
        box-shadow: inset 0 0 10px rgba(252, 163, 17, 0.05);
      }
    `;
  }
})();
