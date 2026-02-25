const BACKEND_HEALTH_URL = "http://localhost:8765/health";

const toggleBtn = document.getElementById("toggle-btn");
const btnIcon = document.getElementById("btn-icon");
const btnLabel = document.getElementById("btn-label");
const errorBanner = document.getElementById("error-banner");
const errorText = document.getElementById("error-text");
const modelSelect = document.getElementById("modelSelect");
const archSelect = document.getElementById("archSelect");
const spokenLangSelect = document.getElementById("spokenLangSelect");
const vadSlider = document.getElementById("vadSlider");
const vadValue = document.getElementById("vadValue");

const transcriptContainer = document.getElementById("transcript-container");
const transcriptEmpty = document.getElementById("transcript-empty");
const settingsToggleBtn = document.getElementById("settings-toggle-btn");
const settingsBlock = document.getElementById("settings-block");

let isCapturing = false;
let backendReady = false;
let healthInterval = null;
let sidebarWs = null;
let latestSummary = "";
let segmentCount = 0;

document.addEventListener("DOMContentLoaded", async () => {
    await checkBackendHealth();

    if (!backendReady) {
        healthInterval = setInterval(checkBackendHealth, 2000);
    }

    initSidebarWebSocket();
    chrome.storage.local.get(["vadThreshold", "archSelect", "spokenLangSelect", "ollamaModel"], (res) => {
        if (res.vadThreshold !== undefined) {
            if (vadSlider) vadSlider.value = res.vadThreshold;
            if (vadValue) vadValue.textContent = res.vadThreshold;
        }
        if (res.archSelect !== undefined) {
            archSelect.value = res.archSelect;
        }
        if (res.spokenLangSelect !== undefined) {
            spokenLangSelect.value = res.spokenLangSelect;
        } else {
            spokenLangSelect.value = "ja";
            chrome.storage.local.set({ spokenLangSelect: "ja" });
        }
    });

    await populateModels();
    await syncState();
    setupEventListeners();
});

async function populateModels() {
    try {
        const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
        if (!resp.ok) throw new Error("Ollama not responding");
        const data = await resp.json();

        modelSelect.innerHTML = "";
        data.models.forEach(m => {
            const opt = document.createElement("option");
            opt.value = m.name;
            opt.textContent = m.name;
            modelSelect.appendChild(opt);
        });

        chrome.storage.local.get(["ollamaModel"], (res) => {
            if (res.ollamaModel) modelSelect.value = res.ollamaModel;
            else modelSelect.value = "qwen2.5:1.5b";
        });
    } catch (e) {
        modelSelect.innerHTML = '<option value="qwen2.5:1.5b">qwen2.5:1.5b</option>';
        modelSelect.value = "qwen2.5:1.5b";
    }
}

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
    archSelect.addEventListener("change", (e) => chrome.storage.local.set({ archSelect: e.target.value }));
    spokenLangSelect.addEventListener("change", (e) => chrome.storage.local.set({ spokenLangSelect: e.target.value }));
    modelSelect.addEventListener("change", (e) => chrome.storage.local.set({ ollamaModel: e.target.value }));

    vadSlider.addEventListener("input", (e) => vadValue.textContent = e.target.value);
    vadSlider.addEventListener("change", (e) => chrome.storage.local.set({ vadThreshold: e.target.value }));

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

    settingsToggleBtn.addEventListener("click", () => {
        settingsBlock.style.display = settingsBlock.style.display === "none" ? "flex" : "none";
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
    if (isCapturing) {
        btnIcon.textContent = "⏹";
        btnLabel.textContent = "Stop";
        toggleBtn.classList.add("active");
        setCaptureStatus("active", "Live");
    } else {
        btnIcon.textContent = "▶";
        btnLabel.textContent = "Start";
        toggleBtn.classList.remove("active");
        setCaptureStatus("idle", "Idle");
    }
}

function setBackendStatus(state, text) {
    const badge = document.getElementById("backend-status");
    if (!badge) return;
    const dot = badge.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${state}`;
    badge.title = `Backend Status: ${text}`;
}

function setCaptureStatus(state, text) {
    const badge = document.getElementById("capture-status");
    if (!badge) return;
    const dot = badge.querySelector(".status-dot");
    if (dot) dot.className = `status-dot ${state}`;
    badge.title = `Audio Capture: ${text}`;
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
            const displayText = msg.translated && msg.translated !== "..." ? msg.translated : msg.original;
            const lang = msg.source_lang || "ja";
            appendOrUpdateTranscript(msg.id, displayText, msg.is_final === true, lang);
        } else if (msg.type === "translation_update") {
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
