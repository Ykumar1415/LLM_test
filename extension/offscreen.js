let audioContext = null;
let mediaStream = null;
let workletNode = null;
let ws = null;
let reconnectTimer = null;
let backendUrl = "ws://localhost:8765";

const TARGET_SAMPLE_RATE = 16000;

chrome.runtime.sendMessage({ type: "offscreen-ready" });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== "offscreen") return;

    switch (msg.type) {
        case "start-audio-capture":
            startCapture(msg)
                .then(() => sendResponse({ ok: true }))
                .catch((err) => sendResponse({ ok: false, error: err.message }));
            return true;
        case "stop-audio-capture":
            stopCapture();
            sendResponse({ ok: true });
            return false;
    }
});

async function startCapture(msg) {
    const streamId = msg.streamId;
    backendUrl = msg.backendUrl || "ws://localhost:8765";

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
            },
            optional: [
                { echoCancellation: false },
                { noiseSuppression: false },
                { autoGainControl: false },
            ]
        },
    });

    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

    const processorUrl = chrome.runtime.getURL("audio-processor.js");
    await audioContext.audioWorklet.addModule(processorUrl);

    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
        processorOptions: { bufferSize: 2048 },
    });

    workletNode.port.onmessage = (event) => {
        sendAudioChunk(event.data);
    };

    source.connect(workletNode);
    workletNode.connect(audioContext.destination);

    connectWebSocket();
}

function stopCapture() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close(1000, "Capture stopped");
        ws = null;
    }
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (audioContext) {
        audioContext.close().catch(() => { });
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
    }
}

function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const url = `${backendUrl}/ws/audio?lang=auto`;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    };

    ws.onclose = () => {
        ws = null;
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error("Offscreen WebSocket error:", err);
    };
}

function scheduleReconnect() {
    if (reconnectTimer || !audioContext) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
    }, 2000);
}

function sendAudioChunk(pcmFloat32) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 65536) return;
    ws.send(pcmFloat32.buffer);
}
