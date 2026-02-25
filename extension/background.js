let state = {
    isCapturing: false,
    meetTabId: null,
    offscreenReady: false,
};

const OFFSCREEN_DOC = "offscreen.html";
const BACKEND_URL = "ws://localhost:8765";

chrome.runtime.onStartup.addListener(() => {
    closeOffscreen();
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
});

chrome.runtime.onInstalled.addListener(() => {
    closeOffscreen();
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
});

chrome.action.onClicked.addListener(async (tab) => {
    try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (e) {
        console.error("Side panel open error", e);
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case "start-capture":
            handleStartCapture(msg.tabId, msg.streamId).then(sendResponse);
            return true;
        case "stop-capture":
            handleStopCapture().then(sendResponse);
            return true;
        case "get-state":
            sendResponse({ ...state });
            return false;
        case "offscreen-ready":
            state.offscreenReady = true;
            sendResponse({ ok: true });
            return false;
        default:
            return false;
    }
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command === "toggle-translation") {
        if (state.isCapturing) {
            await handleStopCapture();
        } else {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && (tab.url?.includes("meet.google.com") || tab.url?.includes("youtube.com"))) {
                await handleStartCapture(tab.id);
            }
        }
    }
});

async function handleStartCapture(tabId, preCapturedStreamId) {
    try {
        if (state.isCapturing) return { ok: false, error: "Already capturing." };

        let streamId = preCapturedStreamId;
        if (!streamId) {
            streamId = await new Promise((resolve, reject) => {
                chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
                    if (chrome.runtime.lastError) {
                        let errMsg = chrome.runtime.lastError.message;
                        if (errMsg.includes("has not been invoked") || errMsg.includes("activeTab")) {
                            errMsg = "Please click the extension icon again on this tab to grant audio permissions.";
                        }
                        reject(new Error(errMsg));
                    } else if (!id) {
                        reject(new Error("Failed to get MediaStreamId: stream may be active."));
                    } else {
                        resolve(id);
                    }
                });
            });
        }

        await ensureOffscreen();

        const prefs = await new Promise((res) => chrome.storage.local.get(["archSelect", "spokenLangSelect"], res));
        const arch = prefs.archSelect || "vad_whisper_translate";
        const spokenLang = prefs.spokenLangSelect || "auto";

        await chrome.runtime.sendMessage({
            type: "start-audio-capture",
            target: "offscreen",
            streamId: streamId,
            backendUrl: BACKEND_URL,
            archSelect: arch,
            spokenLangSelect: spokenLang
        });

        state.isCapturing = true;
        state.meetTabId = tabId;
        return { ok: true };
    } catch (err) {
        await closeOffscreen();
        state.isCapturing = false;
        state.offscreenReady = false;
        return { ok: false, error: err.message };
    }
}

async function handleStopCapture() {
    try {
        try {
            await chrome.runtime.sendMessage({ type: "stop-audio-capture", target: "offscreen" });
        } catch (e) { }

        await closeOffscreen();
        state.isCapturing = false;
        state.meetTabId = null;
        state.offscreenReady = false;

        chrome.tabCapture.getCapturedTabs(() => { });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function ensureOffscreen() {
    const existing = await chrome.offscreen.hasDocument();
    if (!existing) {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOC,
            reasons: [chrome.offscreen.Reason.USER_MEDIA],
            justification: "Capture tab audio for live translation.",
        });
        await waitForOffscreenReady(3000);
    }
}

async function closeOffscreen() {
    try {
        const existing = await chrome.offscreen.hasDocument();
        if (existing) {
            await chrome.offscreen.closeDocument();
        }
    } catch (e) { }
}

function waitForOffscreenReady(timeoutMs) {
    return new Promise((resolve) => {
        if (state.offscreenReady) {
            resolve();
            return;
        }
        const start = Date.now();
        const interval = setInterval(() => {
            if (state.offscreenReady || Date.now() - start > timeoutMs) {
                clearInterval(interval);
                resolve();
            }
        }, 100);
    });
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.meetTabId) {
        handleStopCapture();
    }
});
