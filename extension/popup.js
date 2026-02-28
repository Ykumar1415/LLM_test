const BACKEND_HEALTH_URL = "http://localhost:8765/health";

const toggleBtn = document.getElementById("toggle-btn");
const btnLabel = document.getElementById("btn-label");
const errorBanner = document.getElementById("error-banner");
const errorText = document.getElementById("error-text");
const downloadBtn = document.getElementById("download-btn");

const transcriptContainer = document.getElementById("transcript-container");
const transcriptEmpty = document.getElementById("transcript-empty");

// Fixed defaults
const FIXED_SETTINGS = {
    vadThreshold: 1.2,
    archSelect: "vad_whisper_translate",
    spokenLangSelect: "ja",
    ollamaModel: "qwen2.5:1.5b"
};

let isCapturing = false;
let backendReady = false;
let healthInterval = null;
let sidebarWs = null;
let latestSummary = "";
let segmentCount = 0;
let currentLang = "en"; // Track current active tab
let englishMessages = new Map(); // Store English messages
let japaneseMessages = new Map(); // Store Japanese messages

document.addEventListener("DOMContentLoaded", async () => {
    // Set fixed defaults in storage
    chrome.storage.local.set(FIXED_SETTINGS);

    await checkBackendHealth();

    if (!backendReady) {
        healthInterval = setInterval(checkBackendHealth, 2000);
    }

    initSidebarWebSocket();
    await syncState();
    setupEventListeners();
    setupTabSwitching();
});

async function checkBackendHealth() {
    try {
        const resp = await fetch(BACKEND_HEALTH_URL, { signal: AbortSignal.timeout(2000) });
        const data = await resp.json();

        if (data.status === "ready") {
            setBackendStatus("connected", "Ready");
            backendReady = true;
            if (healthInterval) {
                clearInterval(healthInterval);
                healthInterval = null;
            }
        } else {
            setBackendStatus("loading", "Loading...");
            backendReady = false;
        }
    } catch (e) {
        setBackendStatus("disconnected", "Offline");
        backendReady = false;
    }

    toggleBtn.disabled = !backendReady;
}

async function syncState() {
    try {
        const state = await chrome.runtime.sendMessage({ type: "get-state" });
        isCapturing = state.isCapturing || false;
        updateUI();
    } catch (e) { }
}

function setupEventListeners() {
    toggleBtn.addEventListener("click", async () => {
        toggleBtn.disabled = true;
        hideError();

        if (isCapturing) {
            await stopCapture();
        } else {
            await startCapture();
        }

        toggleBtn.disabled = false;
    });

    downloadBtn.addEventListener("click", () => {
        downloadConversation();
    });
}

function setupTabSwitching() {
    const tabEn = document.getElementById("tab-en");
    const tabJa = document.getElementById("tab-ja");

    tabEn.addEventListener("click", () => {
        currentLang = "en";
        tabEn.classList.add("active");
        tabJa.classList.remove("active");
        refreshTranscriptDisplay();
    });

    tabJa.addEventListener("click", () => {
        currentLang = "ja";
        tabJa.classList.add("active");
        tabEn.classList.remove("active");
        refreshTranscriptDisplay();
    });
}

async function startCapture() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab || !(tab.url?.includes("meet.google.com") || tab.url?.includes("youtube.com"))) {
            showError("Please navigate to a Google Meet or YouTube tab first.");
            return;
        }

        const streamId = await new Promise((resolve, reject) => {
            chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
                if (chrome.runtime.lastError) {
                    let err = chrome.runtime.lastError.message;
                    if (err.includes("invoked") || err.includes("activeTab")) {
                        err = "Click extension icon to grant permissions, then click Start.";
                    }
                    reject(new Error(err));
                } else if (!id) {
                    reject(new Error("Unable to capture audio. Stream may be active."));
                } else {
                    resolve(id);
                }
            });
        });

        const response = await chrome.runtime.sendMessage({
            type: "start-capture",
            tabId: tab.id,
            streamId: streamId
        });

        if (response.ok) {
            isCapturing = true;
            updateUI();
        } else {
            showError(response.error || "Failed to start capture.");
        }
    } catch (e) {
        showError(e.message);
    }
}

async function stopCapture() {
    try {
        const response = await chrome.runtime.sendMessage({ type: "stop-capture" });
        if (response.ok) {
            isCapturing = false;
            updateUI();
        } else {
            showError(response.error || "Failed to stop capture.");
        }
    } catch (e) {
        showError(e.message);
    }
}

function updateUI() {
    const playIcon = toggleBtn.querySelector(".play-icon");
    const stopIcon = toggleBtn.querySelector(".stop-icon");
    const btnLabel = toggleBtn.querySelector(".btn-label");

    if (isCapturing) {
        if (playIcon) playIcon.style.display = "none";
        if (stopIcon) stopIcon.style.display = "block";
        if (btnLabel) btnLabel.textContent = "Stop";
        toggleBtn.classList.add("active");
        setCaptureStatus("active", "Live");
    } else {
        if (playIcon) playIcon.style.display = "block";
        if (stopIcon) stopIcon.style.display = "none";
        if (btnLabel) btnLabel.textContent = "Start";
        toggleBtn.classList.remove("active");
        setCaptureStatus("idle", "Idle");
    }
}

function setBackendStatus(state, text) {
    const badge = document.getElementById("backend-status");
    if (!badge) return;
    const dot = badge.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${state}`;
    badge.title = `Backend: ${text}`;
    badge.className = `status-badge ${state}`;
}

function setCaptureStatus(state, text) {
    const badge = document.getElementById("capture-status");
    if (!badge) return;
    const dot = badge.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${state}`;
    badge.title = `Audio: ${text}`;
    badge.className = `status-badge ${state}`;
}

function showError(msg) {
    errorText.textContent = msg;
    errorBanner.style.display = "flex";
}

function hideError() {
    errorBanner.style.display = "none";
}

function initSidebarWebSocket() {
    sidebarWs = new WebSocket("ws://localhost:8765/ws/text");

    sidebarWs.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) { return; }

        if (msg.type === "segment") {
            // English translation from Whisper
            const displayText = msg.translated && msg.translated !== "..." ? msg.translated : msg.original;
            englishMessages.set(msg.id, displayText);

            // Only set Japanese placeholder for FINAL segments (when user stops speaking)
            // Interim segments don't get translated to reduce Ollama load
            if (msg.is_final === true && !japaneseMessages.has(msg.id)) {
                japaneseMessages.set(msg.id, "...");
            }

            // Update display for both tabs
            if (currentLang === "en") {
                appendOrUpdateTranscript(msg.id, displayText, msg.is_final === true, "en");
            } else if (currentLang === "ja" && msg.is_final === true) {
                // Only show placeholder in Japanese tab for final segments
                appendOrUpdateTranscript(msg.id, "...", false, "ja");
            }
        } else if (msg.type === "segment_japanese") {
            // Japanese translation from Ollama - update the actual translation
            japaneseMessages.set(msg.id, msg.translated);
            if (currentLang === "ja") {
                appendOrUpdateTranscript(msg.id, msg.translated, true, "ja");
            }
        } else if (msg.type === "translation_update") {
            // Legacy support for old translation updates
            appendOrUpdateTranscript(msg.id, msg.translated || msg.text, true, "translated");
        } else if (msg.type === "summary") {
            latestSummary = msg.text;
            addInlineSummary(latestSummary);
        }
    };

    sidebarWs.onclose = () => {
        setTimeout(initSidebarWebSocket, 3000);
    };
}

function refreshTranscriptDisplay() {
    // Clear the transcript container
    transcriptContainer.innerHTML = '<div class="transcript-empty" id="transcript-empty" style="display: none;">[ Waiting for Audio / Click Start ]</div>';

    // Select the appropriate message map based on current language
    const messages = currentLang === "en" ? englishMessages : japaneseMessages;

    // Re-render all messages for the current language
    if (messages.size === 0) {
        document.getElementById("transcript-empty").style.display = "block";
    } else {
        messages.forEach((text, id) => {
            appendOrUpdateTranscript(id, text, true, currentLang);
        });
    }
}

function appendOrUpdateTranscript(id, text, isFinal, lang) {
    if (transcriptEmpty) transcriptEmpty.style.display = "none";

    let bubble = document.getElementById(`bubble-${id}`);
    const isNew = !bubble;

    if (isNew) {
        bubble = document.createElement("div");
        bubble.id = `bubble-${id}`;
        bubble.className = "msg-bubble";

        const speaker = document.createElement("div");
        speaker.className = "msg-speaker";

        // Replaced emoji icons with standard clean text abbreviations
        const langTag = lang === "ja" ? "[JA]" : lang === "en" ? "[EN]" : "[T]";
        speaker.textContent = `${langTag} Speaker`;
        bubble.appendChild(speaker);

        const textEl = document.createElement("div");
        textEl.className = "msg-text";
        textEl.textContent = text;
        bubble.appendChild(textEl);

        const timeEl = document.createElement("div");
        timeEl.className = "msg-time";
        timeEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        bubble.appendChild(timeEl);

        transcriptContainer.appendChild(bubble);
    } else {
        const textEl = bubble.querySelector(".msg-text");
        if (textEl) textEl.textContent = text;

        // Remove loading class when actual translation arrives
        if (text !== "...") {
            bubble.classList.remove("loading");
        }
    }

    // Add loading class for placeholder text
    if (text === "...") {
        bubble.classList.add("loading");
    }

    if (isFinal) {
        bubble.classList.add("translated");
        if (isNew) segmentCount++;
    }

    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function addInlineSummary(summaryText) {
    if (transcriptEmpty) transcriptEmpty.style.display = "none";

    const btn = document.createElement("button");
    btn.className = "inline-summary-btn";
    btn.innerHTML = "[View AI Summary]";

    btn.addEventListener("click", () => {
        const box = document.createElement("div");
        box.className = "inline-summary-box";
        box.textContent = summaryText;
        transcriptContainer.replaceChild(box, btn);
    });

    transcriptContainer.appendChild(btn);
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
}

function downloadConversation() {
    if (englishMessages.size === 0 && japaneseMessages.size === 0) {
        showError("No conversation to download yet.");
        setTimeout(hideError, 3000);
        return;
    }

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Build English conversation
    let englishContent = '';
    englishMessages.forEach((text, id) => {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        englishContent += `        <div class="message">
            <div class="message-header">
                <span class="speaker-label">[EN] Speaker</span>
                <span class="timestamp">${timestamp}</span>
            </div>
            <div class="message-text">${escapeHtml(text)}</div>
        </div>\n`;
    });

    // Build Japanese conversation
    let japaneseContent = '';
    japaneseMessages.forEach((text, id) => {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        japaneseContent += `        <div class="message">
            <div class="message-header">
                <span class="speaker-label">[JA] Speaker</span>
                <span class="timestamp">${timestamp}</span>
            </div>
            <div class="message-text">${escapeHtml(text)}</div>
        </div>\n`;
    });

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Conversation Transcript - ${dateStr}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #faf8f3;
            color: #2a2822;
            line-height: 1.6;
            padding: 40px 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }
        .header {
            background: #5a6f4a;
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 8px;
        }
        .header .date {
            font-size: 14px;
            opacity: 0.9;
        }
        .section {
            padding: 30px;
            border-bottom: 2px solid #e8dfc7;
        }
        .section:last-child {
            border-bottom: none;
        }
        .section-title {
            font-size: 20px;
            font-weight: 700;
            color: #4a5d3e;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #c09858;
            display: inline-block;
        }
        .message {
            background: #fdfbf5;
            border: 1px solid #e8dfc7;
            border-left: 4px solid #78a55a;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .message:last-child {
            margin-bottom: 0;
        }
        .message-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .speaker-label {
            font-weight: 600;
            font-size: 12px;
            color: #5a6f4a;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .timestamp {
            font-size: 11px;
            color: #9ca38f;
        }
        .message-text {
            font-size: 15px;
            color: #2a2822;
            line-height: 1.7;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #9ca38f;
            font-size: 12px;
        }
        @media print {
            body {
                padding: 0;
                background: white;
            }
            .container {
                box-shadow: none;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📝 Conversation Transcript</h1>
            <div class="date">${dateStr} at ${timeStr}</div>
        </div>
        
        <div class="section">
            <div class="section-title">English Conversation</div>
${englishContent || '            <div class="message"><div class="message-text" style="color: #9ca38f; font-style: italic;">No English messages recorded.</div></div>'}
        </div>
        
        <div class="section">
            <div class="section-title">Japanese Conversation (日本語)</div>
${japaneseContent || '            <div class="message"><div class="message-text" style="color: #9ca38f; font-style: italic;">No Japanese messages recorded.</div></div>'}
        </div>
        
        <div class="footer">
            Generated by Meet Live Translator
        </div>
    </div>
</body>
</html>`;

    // Create and download the file
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-transcript-${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
