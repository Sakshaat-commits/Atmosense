
"use strict";

// ==========================================
// ATMOSENSE — DASHBOARD CONTROLLER
// ==========================================

const POLL_INTERVAL = 2000;
const MAX_POINTS = 30;

const mqStateNames = [
    "Warming up",
    "Calibrating",
    "Operational",
    "Sensor error"
];

const smokeNames = [
    "Satisfactory",
    "Very low",
    "Moderate",
    "Very high / unbreathable"
];

const rainNames = [
    "No rain",
    "Light rain",
    "Moderate rain",
    "Heavy rain",
    "Drying (rain stopped)",
    "Wet plate (no active rain)"
];

const history = {
    labels: [],
    temperature: [],
    humidity: []
};

let lastChartTimestamp = null;
let lastPacketTimestamp = null;
let trendChart = null;
let temperatureChart = null;
let polling = false;

// ==========================================
// GENERAL HELPERS
// ==========================================

function text(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.textContent = value;
    }
}

function number(value, decimals = 1) {
    if (value === null || value === undefined || value === "") {
        return "--";
    }

    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed.toFixed(decimals)
        : "--";
}

function isFiniteReading(value) {
    return value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value));
}

function percentage(value) {
    if (!isFiniteReading(value)) return 0;

    return Math.max(0, Math.min(100, Number(value)));
}

function setWidth(id, value) {
    const element = document.getElementById(id);

    if (element) {
        element.style.width = `${percentage(value)}%`;
    }
}

function setBadge(id, label, state = "") {
    const element = document.getElementById(id);

    if (!element) return;

    element.textContent = label;
    element.className = "live-label";

    if (state) {
        element.classList.add(state);
    }
}

function setPill(id, label, state = "") {
    const element = document.getElementById(id);

    if (!element) return;

    element.textContent = label;
    element.className = "status-pill";

    if (state) {
        element.classList.add(state);
    }
}

function setConnection(active) {
    const state = active ? "online" : "offline";
    const dotIds = ["connectionDot", "sidebarDot"];

    for (const id of dotIds) {
        const element = document.getElementById(id);

        if (element) {
            element.className =
                id === "sidebarDot"
                    ? "status-dot"
                    : "connection-dot";

            element.classList.add(state);
        }
    }

    text(
        "connectionText",
        active ? "Telemetry active" : "Waiting for data"
    );

    text(
        "sidebarStatus",
        active ? "Telemetry active" : "Awaiting telemetry"
    );
}

// ==========================================
// CHARTS
// ==========================================

function initializeCharts() {
    if (typeof Chart === "undefined") {
        console.error(
            "Chart.js is unavailable. Check your internet connection."
        );
        return;
    }

    const trendCanvas = document.getElementById("trendChart");
    const miniCanvas = document.getElementById("temperatureChart");

    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,

        plugins: {
            legend: {
                labels: {
                    color: "#748197",
                    usePointStyle: true,
                    pointStyle: "circle",
                    boxWidth: 8,
                    padding: 14,
                    font: {
                        size: 11,
                        family: "Inter, sans-serif"
                    }
                }
            }
        },

        scales: {
            x: {
                ticks: {
                    color: "#9ba5b5",
                    font: {
                        size: 10,
                        family: "Inter, sans-serif"
                    },
                    maxTicksLimit: 6
                },

                grid: {
                    display: false
                },

                border: {
                    display: false
                }
            },

            y: {
                ticks: {
                    color: "#9ba5b5",
                    font: {
                        size: 10,
                        family: "Inter, sans-serif"
                    }
                },

                grid: {
                    color: "#edf0f5"
                },

                border: {
                    display: false
                }
            }
        }
    };

    if (trendCanvas) {
        trendChart = new Chart(trendCanvas, {
            type: "line",

            data: {
                labels: history.labels,

                datasets: [
                    {
                        label: "Temperature °C",
                        data: history.temperature,
                        borderColor: "#4d8df7",
                        backgroundColor: "rgba(77,141,247,0.08)",
                        fill: true,
                        borderWidth: 2,
                        tension: 0.35,
                        pointRadius: 2,
                        pointHoverRadius: 4,
                        spanGaps: false
                    },

                    {
                        label: "Humidity %",
                        data: history.humidity,
                        borderColor: "#43bda1",
                        backgroundColor: "rgba(67,189,161,0.06)",
                        fill: false,
                        borderWidth: 2,
                        tension: 0.35,
                        pointRadius: 2,
                        pointHoverRadius: 4,
                        spanGaps: false
                    }
                ]
            },

            options: {
                ...commonOptions,

                interaction: {
                    intersect: false,
                    mode: "index"
                }
            }
        });
    }

    if (miniCanvas) {
        temperatureChart = new Chart(miniCanvas, {
            type: "line",

            data: {
                labels: [],

                datasets: [
                    {
                        data: [],
                        borderColor: "#4d8df7",
                        borderWidth: 2,
                        tension: 0.4,
                        pointRadius: 0,
                        fill: true,
                        backgroundColor: "rgba(77,141,247,0.07)",
                        spanGaps: false
                    }
                ]
            },

            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,

                plugins: {
                    legend: {
                        display: false
                    },

                    tooltip: {
                        enabled: false
                    }
                },

                scales: {
                    x: {
                        display: false
                    },

                    y: {
                        display: false
                    }
                }
            }
        });
    }
}

// ==========================================
// ENVIRONMENTAL READINGS
// ==========================================

function updateEnvironment(data) {
    const bmp = data.bmp || {};
    const dht = data.dht || {};
    const rain = data.rain || {};

    const bmpOK = bmp.ok === true;
    const dhtOK = dht.ok === true;
    const rainOK = rain.ok === true;

    const temp =
        bmpOK && isFiniteReading(bmp.tmp)
            ? Number(bmp.tmp)
            : null;

    const pressure =
        bmpOK && isFiniteReading(bmp.prs)
            ? Number(bmp.prs)
            : null;

    const humidity =
        dhtOK && isFiniteReading(dht.hum)
            ? Number(dht.hum)
            : null;

    text("temperature", number(temp));
    text("tempCard", number(temp));

    text("humidity", number(humidity, 0));
    text("humidityCard", number(humidity, 0));

    text("pressure", number(pressure));
    text("pressureCard", number(pressure));

    setWidth("humidityProgress", humidity);

    setBadge(
        "bmpBadge",
        bmpOK ? "ONLINE" : "UNAVAILABLE",
        bmpOK ? "" : "offline"
    );

    setBadge(
        "dhtBadge",
        dhtOK ? "ONLINE" : "UNAVAILABLE",
        dhtOK ? "" : "offline"
    );

    setBadge(
        "pressureBadge",
        bmpOK ? "ONLINE" : "UNAVAILABLE",
        bmpOK ? "" : "offline"
    );

    if (temp === null) {
        text("condition", "Temperature unavailable");

        text(
            "temperatureDescription",
            "Check the BMP280 sensor or incoming packet."
        );

    } else if (temp < 15) {
        text("condition", "Cool conditions");

        text(
            "temperatureDescription",
            "The measured temperature is relatively cool."
        );

    } else if (temp < 25) {
        text("condition", "Comfortable conditions");

        text(
            "temperatureDescription",
            "The measured temperature is in a moderate range."
        );

    } else if (temp < 35) {
        text("condition", "Warm conditions");

        text(
            "temperatureDescription",
            "The measured temperature is relatively warm."
        );

    } else {
        text("condition", "High temperature");

        text(
            "temperatureDescription",
            "The measured temperature is elevated."
        );
    }

    if (temp !== null && humidity !== null) {
        text("serverMessage", "Environmental readings available");
    } else {
        text(
            "serverMessage",
            "Some environmental readings are unavailable"
        );
    }

    const rainState = Number(rain.st);

    const validRainState =
        rain.st !== null &&
        rain.st !== undefined &&
        Number.isInteger(rainState) &&
        rainState >= 0 &&
        rainState < rainNames.length;

    const rainText =
        rainOK && validRainState
            ? rainNames[rainState]
            : "Sensor unavailable";

    text("rainWetness", rainOK ? number(rain.pct, 0) : "--");
    text("rainWetnessDetail", rainOK ? number(rain.pct, 0) : "--");
    text("rainADC", rainOK ? number(rain.adc, 0) : "--");

    text("rainStatus", rainText);
    text("rainCondition", rainText);

    text(
        "rainDescription",
        rainOK
            ? `Local wetness reading: ${number(rain.pct, 0)}%. This is not a forecast probability.`
            : "Waiting for a valid rain sensor reading."
    );

    setWidth("rainProgress", rainOK ? rain.pct : 0);

    setBadge(
        "rainBadge",
        rainOK ? "ONLINE" : "UNAVAILABLE",
        rainOK ? "" : "offline"
    );

    text(
        "uptime",
        isFiniteReading(data.up)
            ? `${number(data.up, 0)} s`
            : "--"
    );

    if (data.updated_at) {
        const parsed = new Date(data.updated_at);

        text(
            "lastUpdate",
            Number.isNaN(parsed.getTime())
                ? "Recent packet received"
                : `Updated ${parsed.toLocaleTimeString()}`
        );
    } else {
        text("lastUpdate", "No recent update");
    }
}

// ==========================================
// AIR QUALITY
// ==========================================

function updateAirQuality(data) {
    const mq = data.mq || {};

    const stateIndex = Number(mq.s);

    const validState =
        mq.s !== null &&
        mq.s !== undefined &&
        Number.isInteger(stateIndex) &&
        stateIndex >= 0 &&
        stateIndex < mqStateNames.length;

    const ready = validState && stateIndex === 2;
    const sensorError = validState && stateIndex === 3;

    const stateName = validState
        ? mqStateNames[stateIndex]
        : "Unavailable";

    text("mqState", stateName);

    text(
        "mqDescription",
        ready
            ? "Gas estimates available"
            : "Estimates unavailable"
    );

    text("mqDetailStatus", stateName);

    setBadge(
        "airBadge",
        ready
            ? "ONLINE"
            : sensorError
                ? "ERROR"
                : "PENDING",
        ready ? "" : "offline"
    );

    setPill(
        "mqDetailBadge",
        ready
            ? "READY"
            : sensorError
                ? "ERROR"
                : "PENDING",
        ready
            ? "good"
            : sensorError
                ? "bad"
                : "warn"
    );

    const smokeIndex = Number(mq.smk);

    const smokeValid =
        mq.smk !== null &&
        mq.smk !== undefined &&
        Number.isInteger(smokeIndex) &&
        smokeIndex >= 0 &&
        smokeIndex < smokeNames.length;

    text(
        "smokeLevel",
        ready && smokeValid
            ? smokeNames[smokeIndex]
            : "Not available"
    );

    const gases = [
        ["co2", "co2"],
        ["co", "co"],
        ["nh4", "nh4"],
        ["alcohol", "alc"],
        ["toluene", "tol"],
        ["acetone", "ace"]
    ];

    for (const [elementId, key] of gases) {
        const value =
            ready && isFiniteReading(mq[key])
                ? `${number(mq[key])} ppm`
                : "--";

        text(elementId, value);
    }
}

// ==========================================
// DIAGNOSTICS
// ==========================================

function updateDiagnostics(data) {
    const diagnostics = data.diagnostics || {};

    text("deviceId", data.id ?? "--");
    text("sidebarDevice", data.id ?? "Device not detected");
    text("packetNumber", data.n ?? "--");
    text("pktOk", diagnostics.ok ?? 0);
    text("pktBad", diagnostics.bad ?? "--");
    text("pktMissed", diagnostics.missed ?? 0);

    text(
        "uptime",
        isFiniteReading(data.up)
            ? `${number(data.up, 0)} s`
            : "--"
    );

    if (data.updated_at) {
        const parsed = new Date(data.updated_at);

        text(
            "lastUpdate",
            Number.isNaN(parsed.getTime())
                ? "Recent packet received"
                : `Updated ${parsed.toLocaleTimeString()}`
        );
    } else {
        text("lastUpdate", "No recent update");
    }
}

// ==========================================
// LIVE HISTORY
// ==========================================

function updateHistory(data) {
    if (
        !data.updated_at ||
        data.updated_at === lastChartTimestamp
    ) {
        return;
    }

    lastChartTimestamp = data.updated_at;

    const bmp = data.bmp || {};
    const dht = data.dht || {};

    const temp =
        bmp.ok === true && isFiniteReading(bmp.tmp)
            ? Number(bmp.tmp)
            : null;

    const humidity =
        dht.ok === true && isFiniteReading(dht.hum)
            ? Number(dht.hum)
            : null;

    const timestamp = new Date(data.updated_at);

    const label = Number.isNaN(timestamp.getTime())
        ? "--:--:--"
        : timestamp.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });

    history.labels.push(label);
    history.temperature.push(temp);
    history.humidity.push(humidity);

    if (history.labels.length > MAX_POINTS) {
        history.labels.shift();
        history.temperature.shift();
        history.humidity.shift();
    }

    if (trendChart) {
        trendChart.update("none");
    }

    if (temperatureChart) {
        temperatureChart.data.labels = history.labels;
        temperatureChart.data.datasets[0].data = history.temperature;
        temperatureChart.update("none");
    }
}

// ==========================================
// DASHBOARD RENDERING
// ==========================================

function renderDashboard(data) {
    const connected = data.link_up === true;

    setConnection(connected);

    updateEnvironment(data);
    updateAirQuality(data);
    updateDiagnostics(data);
    updateHistory(data);

    lastPacketTimestamp =
        data.updated_at || lastPacketTimestamp;
}

// ==========================================
// FETCH LIVE DATA
// ==========================================

async function updateDashboard() {
    if (polling) return;

    polling = true;

    try {
        const response = await fetch("/data", {
            method: "GET",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        renderDashboard(data);

    } catch (error) {
        setConnection(false);

        text(
            "serverMessage",
            "Unable to contact Flask server"
        );

        console.error(
            "Dashboard update failed:",
            error
        );

    } finally {
        polling = false;
    }
}

// ==========================================
// DASHBOARD INITIALIZATION
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
    initializeCharts();

    const refreshButton =
        document.getElementById("refreshButton");

    if (refreshButton) {
        refreshButton.addEventListener(
            "click",
            updateDashboard
        );
    }

    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", () => {
            document.querySelectorAll(".nav-item").forEach(link => {
                link.classList.remove("active");
            });

            item.classList.add("active");
        });
    });

    updateDashboard();

    setInterval(updateDashboard, POLL_INTERVAL);
});

// ==========================================
// ATMOSENSE AI CHAT CONTROLLER
// ==========================================

let aiConversation = [];
let aiIsSending = false;

// ==========================================
// VOICE ASSISTANT STATE
// ==========================================

let mediaRecorder = null;
let microphoneStream = null;
let recordedAudioChunks = [];

let isRecordingVoice = false;
let isStartingVoice = false;
let isProcessingVoice = false;

let currentSpeechAudio = null;
let currentSpeechUrl = null;

let micButton = null;
let micStatus = null;

// ==========================================
// AI HELPERS
// ==========================================

function getAIElement(id) {
    return document.getElementById(id);
}

// ==========================================
// VOICE UI STYLES
// ==========================================

function initializeVoiceStyles() {
    if (document.getElementById("atmosenseVoiceStyles")) {
        return;
    }

    const style = document.createElement("style");

    style.id = "atmosenseVoiceStyles";

    style.textContent = `
        .ai-mic-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 42px;
            min-width: 42px;
            height: 42px;
            padding: 0;
            border: 1px solid #dbe3ef;
            border-radius: 12px;
            background: #ffffff;
            color: #53647d;
            cursor: pointer;
            transition: all 0.2s ease;
            flex-shrink: 0;
        }

        .ai-mic-button:hover:not(:disabled) {
            background: #f1f5ff;
            border-color: #9bb9f5;
            color: #3976df;
        }

        .ai-mic-button.recording {
            background: #fff0f0;
            color: #dc4545;
            border-color: #f1a6a6;
            animation: atmosenseMicPulse 1.5s infinite;
        }

        .ai-mic-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .ai-mic-button svg {
            display: block;
            width: 19px;
            height: 19px;
            flex-shrink: 0;
        }

        .ai-mic-status,
        .ai-voice-status {
            display: block;
            width: 100%;
            padding: 4px 2px;
            color: #7b8798;
            font-size: 11px;
            line-height: 1.5;
        }

        .ai-mic-status:empty,
        .ai-voice-status:empty {
            display: none;
        }

        @keyframes atmosenseMicPulse {
            0%, 100% {
                box-shadow: 0 0 0 0 rgba(220, 69, 69, 0.12);
            }

            50% {
                box-shadow: 0 0 0 5px rgba(220, 69, 69, 0.06);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .ai-mic-button.recording {
                animation: none;
            }
        }
    `;

    document.head.appendChild(style);
}

// ==========================================
// INITIALIZE MICROPHONE UI
// ==========================================

function initializeVoiceUI() {
    const form = getAIElement("aiChatForm");
    const sendButton = getAIElement("aiSend");

    if (!form) return;

    initializeVoiceStyles();

    micButton =
        getAIElement("aiMic") ||
        getAIElement("aiMicButton");

    if (!micButton) {
        micButton = document.createElement("button");

        micButton.type = "button";
        micButton.id = "aiMic";
        micButton.className = "ai-mic-button";

        if (sendButton && sendButton.parentNode) {
            sendButton.parentNode.insertBefore(
                micButton,
                sendButton
            );
        } else {
            form.appendChild(micButton);
        }
    }

    micButton.type = "button";
    micButton.classList.add("ai-mic-button");

    micStatus =
        getAIElement("aiVoiceStatus") ||
        getAIElement("aiMicStatus");

    if (!micStatus) {
        micStatus = document.createElement("div");

        micStatus.id = "aiVoiceStatus";
        micStatus.className = "ai-voice-status";
        micStatus.setAttribute("role", "status");
        micStatus.setAttribute("aria-live", "polite");

        form.insertAdjacentElement("afterend", micStatus);
    }

    if (!micButton.dataset.voiceInitialized) {
        micButton.addEventListener(
            "click",
            toggleVoiceRecording
        );

        micButton.dataset.voiceInitialized = "true";
    }

    updateMicButton();
}

// ==========================================
// MICROPHONE UI STATE
// ICON ONLY — NO "MIC" OR "STOP" LABEL
// ==========================================

function updateMicButton() {
    if (!micButton) return;

    const icon = `
        <svg viewBox="0 0 24 24"
             fill="none"
             stroke="currentColor"
             stroke-width="1.8"
             stroke-linecap="round"
             stroke-linejoin="round"
             aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3"></rect>
            <path d="M5 10v2a7 7 0 0 0 14 0v-2"></path>
            <path d="M12 19v3"></path>
            <path d="M8 22h8"></path>
        </svg>
    `;

    // Only the microphone icon is rendered.
    micButton.innerHTML = icon;

    if (isRecordingVoice) {
        micButton.classList.add("recording");
        micButton.title = "Stop recording";
        micButton.setAttribute("aria-label", "Stop recording");
        micButton.setAttribute("aria-pressed", "true");

    } else {
        micButton.classList.remove("recording");
        micButton.title = "Start voice command";
        micButton.setAttribute("aria-label", "Start voice command");
        micButton.setAttribute("aria-pressed", "false");
    }

    micButton.disabled =
        aiIsSending ||
        isProcessingVoice ||
        isStartingVoice;
}

// ==========================================
// AUDIO PLAYBACK CLEANUP
// ==========================================

function stopCurrentSpeech() {
    if (currentSpeechAudio) {
        currentSpeechAudio.pause();
        currentSpeechAudio.currentTime = 0;

        currentSpeechAudio.onended = null;
        currentSpeechAudio.onerror = null;

        currentSpeechAudio = null;
    }

    if (currentSpeechUrl) {
        URL.revokeObjectURL(currentSpeechUrl);
        currentSpeechUrl = null;
    }
}

// ==========================================
// MICROPHONE RECORDING
// ==========================================

async function toggleVoiceRecording() {
    if (isRecordingVoice) {
        stopVoiceRecording();
        return;
    }

    if (
        aiIsSending ||
        isProcessingVoice ||
        isStartingVoice
    ) {
        return;
    }

    await startVoiceRecording();
}

function setMicStatus(message, type = "") {
    const statusElement = document.getElementById("aiVoiceStatus");

    if (!statusElement) return;

    statusElement.textContent = message;
    statusElement.className = "ai-voice-status";

    if (type) {
        statusElement.classList.add(type);
    }
}
async function startVoiceRecording() {
    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {
        setMicStatus(
            "Microphone access requires HTTPS or localhost."
        );

        return;
    }

    if (typeof MediaRecorder === "undefined") {
        setMicStatus(
            "Your browser does not support audio recording."
        );

        return;
    }

    if (isStartingVoice || isRecordingVoice) return;

    isStartingVoice = true;
    updateMicButton();

    stopCurrentSpeech();

    try {
        setMicStatus("Requesting microphone access...");

        const stream =
            await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

        if (aiIsSending || isProcessingVoice) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        microphoneStream = stream;

        const mimeTypes = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/ogg;codecs=opus"
        ];

        let selectedMimeType = "";

        for (const type of mimeTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                selectedMimeType = type;
                break;
            }
        }

        const recorder = selectedMimeType
            ? new MediaRecorder(
                microphoneStream,
                { mimeType: selectedMimeType }
            )
            : new MediaRecorder(microphoneStream);

        mediaRecorder = recorder;

        recordedAudioChunks = [];

        let recordingFailed = false;

        recorder.ondataavailable = event => {
            if (event.data && event.data.size > 0) {
                recordedAudioChunks.push(event.data);
            }
        };

        recorder.onerror = event => {
            console.error(
                "MediaRecorder error:",
                event.error
            );

            recordingFailed = true;
            isRecordingVoice = false;

            setMicStatus(
                "Recording error. Please try again."
            );

            cleanupMicrophone();

            if (recorder.state !== "inactive") {
                try {
                    recorder.stop();
                } catch (error) {
                    console.warn("Recorder stop failed:", error);
                }
            }
        };

        recorder.onstop = async () => {
            const recordedType =
                recorder.mimeType ||
                selectedMimeType ||
                "audio/webm";

            const audioBlob = new Blob(
                recordedAudioChunks,
                { type: recordedType }
            );

            cleanupMicrophone();

            if (mediaRecorder === recorder) {
                mediaRecorder = null;
            }

            if (recordingFailed) {
                recordedAudioChunks = [];
                return;
            }

            if (!audioBlob.size) {
                recordedAudioChunks = [];

                setMicStatus(
                    "No audio captured. Please try again."
                );

                return;
            }

            await processVoiceRecording(audioBlob);
        };

        recorder.start(250);

        isRecordingVoice = true;

        updateMicButton();

        setMicStatus(
            "Listening... Speak your command, then press the microphone button again to stop."
        );

    } catch (error) {
        console.error(
            "Microphone access error:",
            error
        );

        cleanupMicrophone();

        if (error.name === "NotAllowedError") {
            setMicStatus(
                "Microphone permission denied. Allow access in your browser."
            );
        } else if (error.name === "NotFoundError") {
            setMicStatus(
                "No microphone was detected on this device."
            );
        } else {
            setMicStatus(
                "Unable to access the microphone. Please try again."
            );
        }

    } finally {
        isStartingVoice = false;
        updateMicButton();
    }
}

// ==========================================
// STOP RECORDING
// ==========================================

function stopVoiceRecording() {
    const recorder = mediaRecorder;

    if (!recorder || !isRecordingVoice) return;

    isRecordingVoice = false;

    updateMicButton();

    setMicStatus("Recording stopped. Processing audio...");

    if (recorder.state !== "inactive") {
        try {
            recorder.stop();
        } catch (error) {
            console.error("Unable to stop recorder:", error);

            cleanupMicrophone();

            if (mediaRecorder === recorder) {
                mediaRecorder = null;
            }

            setMicStatus(
                "Unable to finish recording. Please try again."
            );
        }
    }
}

// ==========================================
// CLEANUP MICROPHONE
// ==========================================

function cleanupMicrophone() {
    isRecordingVoice = false;

    if (microphoneStream) {
        microphoneStream.getTracks().forEach(track => {
            track.stop();
        });

        microphoneStream = null;
    }

    updateMicButton();
}

// ==========================================
// WHISPER LARGE V3 TRANSCRIPTION
// ==========================================

async function processVoiceRecording(audioBlob) {
    if (isProcessingVoice || aiIsSending) return;

    isProcessingVoice = true;

    updateMicButton();

    try {
        setMicStatus("Sending audio to Whisper Large V3...");

        const formData = new FormData();

        let extension = "webm";

        if (audioBlob.type.includes("ogg")) {
            extension = "ogg";
        } else if (audioBlob.type.includes("mp4")) {
            extension = "mp4";
        } else if (audioBlob.type.includes("wav")) {
            extension = "wav";
        }

        formData.append(
            "audio",
            audioBlob,
            `atmosense-recording.${extension}`
        );

        const response = await fetch("/api/transcribe", {
            method: "POST",
            body: formData
        });

        let result;

        try {
            result = await response.json();
        } catch (_) {
            throw new Error(
                "The transcription server returned an invalid response."
            );
        }

        if (!response.ok) {
            throw new Error(
                result.error || "Speech recognition failed."
            );
        }

        const transcript = String(result.text || "").trim();

        if (!transcript) {
            throw new Error("No speech was recognized.");
        }

        console.log("[VOICE] Recognized:", transcript);

        setMicStatus(`Recognized: "${transcript}"`);

        recordedAudioChunks = [];

        isProcessingVoice = false;

        updateMicButton();

        await sendAIMessage(transcript, {
            voiceCommand: true
        });

    } catch (error) {
        console.error(
            "Voice transcription error:",
            error
        );

        setMicStatus(
            error.message ||
            "Unable to process your voice command."
        );

    } finally {
        isProcessingVoice = false;
        updateMicButton();
    }
}


// ==========================================
// MICROSOFT EDGE TTS — HANNAH TEXT TO SPEECH
// ==========================================

async function speakAIResponse(answer) {
    if (!answer) return;

    stopCurrentSpeech();

    try {
        setMicStatus("Hannah is preparing your response...");

        const response = await fetch("/api/speak", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                text: answer
            })
        });

        if (!response.ok) {
            let errorMessage = "Voice generation failed.";

            try {
                const result = await response.json();
                errorMessage = result.error || errorMessage;
            } catch (_) {
                // Keep fallback error.
            }

            throw new Error(errorMessage);
        }

        // Edge TTS returns MP3 audio.
        const audioBlob = await response.blob();

        if (!audioBlob.size) {
            throw new Error("Hannah generated empty audio.");
        }

        currentSpeechUrl = URL.createObjectURL(audioBlob);

        const audio = new Audio(currentSpeechUrl);

        currentSpeechAudio = audio;

        audio.onended = () => {
            if (currentSpeechAudio === audio) {
                stopCurrentSpeech();
                setMicStatus("");
            }
        };

        audio.onerror = () => {
            if (currentSpeechAudio === audio) {
                stopCurrentSpeech();

                setMicStatus(
                    "Unable to play Hannah's voice."
                );
            }
        };

        await audio.play();

        setMicStatus("Hannah is speaking...");

    } catch (error) {
        console.error(
            "[EDGE TTS ERROR]",
            error
        );

        setMicStatus(
            `Hannah's voice is unavailable: ${error.message}`
        );

        stopCurrentSpeech();
    }
}

// ==========================================
// SAFE MARKDOWN RENDERING
// ==========================================

function renderAIMarkdown(bubble, content) {
    const markdown = String(content || "");

    if (
        typeof marked !== "undefined" &&
        typeof DOMPurify !== "undefined"
    ) {
        try {
            const html = marked.parse(markdown, {
                breaks: true,
                gfm: true
            });

            bubble.innerHTML = DOMPurify.sanitize(html, {
                USE_PROFILES: {
                    html: true
                }
            });

            return;

        } catch (error) {
            console.error(
                "Markdown rendering failed:",
                error
            );
        }
    }

    bubble.textContent = markdown;
}

// ==========================================
// ADD AI MESSAGE
// ==========================================

function addAIMessage(role, content) {
    const messages = getAIElement("aiMessages");

    if (!messages) return;

    const message = document.createElement("div");

    message.className = `ai-message ${role}`;

    if (role === "assistant") {
        const avatar = document.createElement("div");

        avatar.className = "ai-message-avatar";
        avatar.textContent = "✦";

        message.appendChild(avatar);
    }

    const messageContent = document.createElement("div");

    messageContent.className = "ai-message-content";

    if (role === "assistant") {
        const name = document.createElement("div");

        name.className = "ai-message-name";
        name.textContent = "ATMOSENSE AI";

        messageContent.appendChild(name);
    }

    const bubble = document.createElement("div");

    bubble.className = "ai-message-bubble";

    if (role === "assistant") {
        renderAIMarkdown(bubble, content);
    } else {
        bubble.textContent = content;
    }

    messageContent.appendChild(bubble);
    message.appendChild(messageContent);

    messages.appendChild(message);

    messages.scrollTop = messages.scrollHeight;

    return message;
}

// ==========================================
// AI TYPING INDICATOR
// ==========================================

function showAITyping() {
    const messages = getAIElement("aiMessages");

    if (!messages) return null;

    const typing = document.createElement("div");

    typing.className = "ai-message assistant";
    typing.id = "aiTyping";

    const avatar = document.createElement("div");

    avatar.className = "ai-message-avatar";
    avatar.textContent = "✦";

    const content = document.createElement("div");

    content.className = "ai-message-content";

    const name = document.createElement("div");

    name.className = "ai-message-name";
    name.textContent = "ATMOSENSE AI";

    const indicator = document.createElement("div");

    indicator.className = "ai-message-bubble ai-typing";

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        indicator.appendChild(dot);
    }

    content.appendChild(name);
    content.appendChild(indicator);

    typing.appendChild(avatar);
    typing.appendChild(content);

    messages.appendChild(typing);

    messages.scrollTop = messages.scrollHeight;

    return typing;
}

// ==========================================
// SEND AI MESSAGE
// ==========================================

async function sendAIMessage(message, options = {}) {
    if (aiIsSending) return;

    const question = String(message || "").trim();

    if (!question) return;

    const isVoiceRequest = options.voiceCommand === true;

    const input = getAIElement("aiInput");
    const sendButton = getAIElement("aiSend");
    const suggestions = getAIElement("aiSuggestions");

    aiIsSending = true;

    if (input) {
        if (!isVoiceRequest) {
            input.value = "";
        }

        input.disabled = true;
    }

    if (sendButton) {
        sendButton.disabled = true;
    }

    if (suggestions) {
        suggestions.style.display = "none";
    }

    updateMicButton();

    const previousHistory = aiConversation.slice(-8);

    addAIMessage("user", question);

    aiConversation.push({
        role: "user",
        content: question
    });

    const typing = showAITyping();

    try {
        const response = await fetch("/api/chat", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                message: question,
                history: previousHistory,

                response_mode: isVoiceRequest
                    ? "voice"
                    : "text"
            })
        });

        let result;

        try {
            result = await response.json();
        } catch (_) {
            throw new Error(
                "The AI server returned an invalid response."
            );
        }

        if (!response.ok) {
            throw new Error(
                result.error ||
                "Unable to contact ATMOSENSE AI."
            );
        }

        // For voice commands, the backend should return
        // the exact spoken script in result.reply.
        const answer = String(result.reply || "").trim();

        if (!answer) {
            throw new Error(
                "The AI returned an empty response."
            );
        }

        if (typing) {
            typing.remove();
        }

        // Display exactly the same response that will be spoken.
        addAIMessage("assistant", answer);

        aiConversation.push({
            role: "assistant",
            content: answer
        });

        if (aiConversation.length > 16) {
            aiConversation = aiConversation.slice(-16);
        }

        // Voice requests use the same canonical reply for TTS.
        // No separate speech_text is used here.
        if (isVoiceRequest) {
            await speakAIResponse(answer);
        }

    } catch (error) {
        if (typing) {
            typing.remove();
        }

        console.error(
            "ATMOSENSE AI error:",
            error
        );

        addAIMessage(
            "assistant",
            `Sorry, I couldn't process that request.\n\n${error.message}`
        );

        if (isVoiceRequest) {
            setMicStatus(
                "Voice command could not be completed."
            );
        }

    } finally {
        aiIsSending = false;

        if (input) {
            input.disabled = false;

            if (!isVoiceRequest) {
                input.focus();
            }
        }

        if (sendButton) {
            sendButton.disabled = false;
        }

        updateMicButton();
    }
}

// ==========================================
// CLEAR AI CONVERSATION
// ==========================================

function clearAIConversation() {
    if (
        aiIsSending ||
        isRecordingVoice ||
        isStartingVoice ||
        isProcessingVoice
    ) {
        return;
    }

    stopCurrentSpeech();

    aiConversation = [];

    const messages = getAIElement("aiMessages");
    const suggestions = getAIElement("aiSuggestions");

    if (messages) {
        messages.innerHTML = "";
    }

    if (suggestions) {
        suggestions.style.display = "flex";
    }

    setMicStatus("");

    addAIMessage(
        "assistant",
        "Hello! I'm your environmental intelligence assistant.\n\nI can analyse your live sensor readings, explain environmental conditions, and help evaluate agricultural suitability.\n\nWhat would you like to know?"
    );
}

// ==========================================
// AI CHAT FULLSCREEN
// ==========================================

function setAIFullscreen(enabled) {
    const panel = getAIElement("aiChatPanel");
    const fullscreenButton = getAIElement("aiFullscreen");

    if (!panel) return;

    panel.classList.toggle("ai-fullscreen", enabled);

    if (fullscreenButton) {
        fullscreenButton.setAttribute(
            "aria-pressed",
            String(enabled)
        );

        fullscreenButton.setAttribute(
            "aria-label",
            enabled
                ? "Exit fullscreen"
                : "Expand chat"
        );

        fullscreenButton.title = enabled
            ? "Exit fullscreen"
            : "Expand chat";
    }

    document.body.classList.toggle(
        "ai-chat-expanded",
        enabled
    );
}

// ==========================================
// AI CHAT OPEN / CLOSE
// ==========================================

function openAIChat() {
    const launcher = getAIElement("aiLauncher");
    const panel = getAIElement("aiChatPanel");
    const input = getAIElement("aiInput");

    if (!panel) return;

    panel.hidden = false;

    if (launcher) {
        launcher.setAttribute("aria-expanded", "true");
    }

    if (input) {
        input.focus();
    }
}

function closeAIChat() {
    const launcher = getAIElement("aiLauncher");
    const panel = getAIElement("aiChatPanel");

    if (!panel) return;

    if (isRecordingVoice) {
        stopVoiceRecording();
    }

    stopCurrentSpeech();

    setAIFullscreen(false);

    panel.hidden = true;

    if (launcher) {
        launcher.setAttribute("aria-expanded", "false");
        launcher.focus();
    }
}

// ==========================================
// AI CHAT INITIALIZATION
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
    const launcher = getAIElement("aiLauncher");
    const panel = getAIElement("aiChatPanel");

    const closeButton = getAIElement("aiClose");
    const clearButton = getAIElement("aiClear");
    const fullscreenButton = getAIElement("aiFullscreen");

    const form = getAIElement("aiChatForm");
    const input = getAIElement("aiInput");

    const suggestions =
        document.querySelectorAll(".ai-suggestions button");

    initializeVoiceUI();

    if (launcher && panel) {
        launcher.addEventListener("click", () => {
            if (panel.hidden) {
                openAIChat();
            } else {
                closeAIChat();
            }
        });
    }

    if (closeButton) {
        closeButton.addEventListener(
            "click",
            closeAIChat
        );
    }

    if (clearButton) {
        clearButton.addEventListener(
            "click",
            clearAIConversation
        );
    }

    if (fullscreenButton) {
        fullscreenButton.addEventListener("click", () => {
            const isFullscreen =
                panel?.classList.contains("ai-fullscreen") || false;

            setAIFullscreen(!isFullscreen);
        });
    }

    if (form) {
        form.addEventListener("submit", event => {
            event.preventDefault();

            if (input) {
                sendAIMessage(input.value, {
                    voiceCommand: false
                });
            }
        });
    }

    suggestions.forEach(button => {
        button.addEventListener("click", () => {
            const question = button.dataset.question;

            if (question) {
                sendAIMessage(question, {
                    voiceCommand: false
                });
            }
        });
    });

    document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        if (!panel || panel.hidden) return;

        if (panel.classList.contains("ai-fullscreen")) {
            setAIFullscreen(false);
        } else {
            closeAIChat();
        }
    });
});

// ==========================================
// PAGE CLEANUP
// ==========================================

window.addEventListener("beforeunload", () => {
    stopCurrentSpeech();

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
            mediaRecorder.stop();
        } catch (_) {
            // Ignore recorder cleanup errors during unload.
        }
    }

    if (microphoneStream) {
        microphoneStream.getTracks().forEach(track => {
            track.stop();
        });

        microphoneStream = null;
    }
});
