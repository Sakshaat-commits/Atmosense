
from flask import Flask, jsonify, render_template, request, Response
from datetime import datetime, timezone
from threading import Lock, Thread, Event
from zeroconf import Zeroconf, ServiceInfo
from dotenv import load_dotenv
from groq import Groq

import asyncio
import edge_tts
import os
import re
import json
import socket
import time
import atexit
import traceback


app = Flask(__name__)

# ============================================================
# GROQ AI CONFIGURATION
# ============================================================

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

WHISPER_MODEL = "whisper-large-v3"

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


# ============================================================
# MICROSOFT EDGE TTS CONFIGURATION
# ============================================================

# Hannah's voice engine
# These settings can also be changed in your .env file.

EDGE_TTS_VOICE = os.getenv(
    "EDGE_TTS_VOICE",
    "en-US-JennyNeural"
)

EDGE_TTS_RATE = os.getenv(
    "EDGE_TTS_RATE",
    "-5%"
)

EDGE_TTS_VOLUME = os.getenv(
    "EDGE_TTS_VOLUME",
    "+0%"
)


# ============================================================
# APPLICATION CONFIGURATION
# ============================================================

FLASK_PORT = 5000
LINK_TIMEOUT_SECONDS = 10

MAX_AUDIO_SIZE = 25 * 1024 * 1024
MAX_CONTENT_LENGTH = MAX_AUDIO_SIZE + (1024 * 1024)
MAX_VOICE_TEXT_LENGTH = 190

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

MDNS_HOSTNAME = "atmosense.local."
MDNS_SERVICE_TYPE = "_http._tcp.local."
MDNS_SERVICE_NAME = "ATMOSENSE Flask._http._tcp.local."

lock = Lock()


# ============================================================
# SENSOR DATA
# ============================================================

latest_data = {
    "id": None,
    "n": None,
    "up": None,

    "bmp": {
        "ok": False,
        "tmp": None,
        "prs": None
    },

    "dht": {
        "ok": False,
        "hum": None
    },

    "mq": {
        "s": None,
        "co2": None,
        "co": None,
        "nh4": None,
        "alc": None,
        "tol": None,
        "ace": None,
        "smk": None,
    },

    "rain": {
        "ok": False,
        "st": None,
        "pct": None,
        "adc": None
    },

    "diagnostics": {
        "ok": 0,
        "bad": None,
        "missed": 0
    },

    "link_up": False,
    "updated_at": None,
}

last_received = None
last_sequence = None
last_device_id = None
last_device_uptime = None

packet_count = 0
missed_count = 0

section_last_received = {
    "bmp": None,
    "dht": None,
    "mq": None,
    "rain": None,
}

section_updated_at = {
    "bmp": None,
    "dht": None,
    "mq": None,
    "rain": None,
}


# ============================================================
# mDNS SERVER DISCOVERY
# ============================================================

zeroconf_instance = None
mdns_service_info = None

mdns_lock = Lock()
mdns_stop_event = Event()


def get_local_ip():
    """Determine the laptop's local network IP."""

    sock = socket.socket(
        socket.AF_INET,
        socket.SOCK_DGRAM
    )

    try:
        sock.connect(("192.0.2.1", 80))

        local_ip = sock.getsockname()[0]

        return (
            None
            if local_ip.startswith("127.")
            else local_ip
        )

    except OSError:
        return None

    finally:
        sock.close()


def create_mdns_service(ip):
    """Create the mDNS service advertisement."""

    return ServiceInfo(
        type_=MDNS_SERVICE_TYPE,
        name=MDNS_SERVICE_NAME,
        addresses=[socket.inet_aton(ip)],
        port=FLASK_PORT,
        properties={
            "path": "/data",
            "device": "ATMOSENSE"
        },
        server=MDNS_HOSTNAME,
    )


def mdns_worker():
    """Periodically advertise the Flask server."""

    global mdns_service_info

    print("[mDNS] Discovery service starting...")

    while not mdns_stop_event.is_set():

        current_ip = get_local_ip()

        if current_ip is None:

            print("[mDNS] Waiting for network connection...")

        else:

            with mdns_lock:

                if mdns_service_info is None:

                    try:

                        service = create_mdns_service(current_ip)

                        zeroconf_instance.register_service(
                            service,
                            allow_name_change=True,
                        )

                        mdns_service_info = service

                        print("[mDNS] Service registered successfully")
                        print(f"[mDNS] Hostname: {MDNS_HOSTNAME}")
                        print(f"[mDNS] IP address: {current_ip}")
                        print(f"[mDNS] Port: {FLASK_PORT}")

                    except Exception as error:

                        print(
                            f"[mDNS] Registration failed: {error}"
                        )

                else:

                    old_addresses = (
                        mdns_service_info.parsed_addresses()
                    )

                    old_ip = (
                        old_addresses[0]
                        if old_addresses
                        else None
                    )

                    if old_ip != current_ip:

                        print("[mDNS] Network IP changed!")

                        try:

                            zeroconf_instance.unregister_service(
                                mdns_service_info
                            )

                            new_service = create_mdns_service(
                                current_ip
                            )

                            zeroconf_instance.register_service(
                                new_service,
                                allow_name_change=True,
                            )

                            mdns_service_info = new_service

                            print("[mDNS] Advertisement updated")

                        except Exception as error:

                            print(
                                f"[mDNS] Update failed: {error}"
                            )

                            mdns_service_info = None

        mdns_stop_event.wait(15)


def start_mdns_service():
    """Start mDNS and its background worker."""

    global zeroconf_instance

    if zeroconf_instance is not None:
        return

    try:

        zeroconf_instance = Zeroconf()

        mdns_stop_event.clear()

        worker = Thread(
            target=mdns_worker,
            daemon=True
        )

        worker.start()

        print("[mDNS] Background discovery worker started")

    except Exception as error:

        print(
            f"[mDNS] Could not start discovery service: {error}"
        )


def stop_mdns_service():
    """Stop mDNS and release network resources."""

    global zeroconf_instance, mdns_service_info

    mdns_stop_event.set()

    with mdns_lock:

        if zeroconf_instance is not None:

            try:

                if mdns_service_info is not None:

                    zeroconf_instance.unregister_service(
                        mdns_service_info
                    )

                zeroconf_instance.close()

                print("[mDNS] Discovery service stopped")

            except Exception as error:

                print(
                    f"[mDNS] Shutdown error: {error}"
                )

            zeroconf_instance = None
            mdns_service_info = None


atexit.register(stop_mdns_service)


# ============================================================
# HELPER FUNCTIONS
# ============================================================

def timestamp():

    return datetime.now(timezone.utc).isoformat()


def numeric(value):

    if value is None or isinstance(value, bool):
        return None

    try:

        result = float(value)

        if result != result or result in (
            float("inf"),
            float("-inf"),
        ):
            return None

        return result

    except (ValueError, TypeError):

        return None


def parse_bool(value):

    if isinstance(value, bool):
        return value

    if isinstance(value, (int, float)):
        return value == 1

    if isinstance(value, str):

        return value.strip().lower() in (
            "true",
            "1",
            "yes",
            "ok"
        )

    return False


def clean_section(section, fields):

    if not isinstance(section, dict):
        return None

    result = {}

    for field in fields:

        if field not in section:
            continue

        value = section[field]

        if field == "ok":

            result[field] = parse_bool(value)

        elif field in ("s", "smk", "st", "adc"):

            try:

                result[field] = (
                    int(value)
                    if value is not None
                    else None
                )

            except (ValueError, TypeError):

                result[field] = None

        else:

            result[field] = numeric(value)

    return result


# ============================================================
# SPEECH TEXT FORMATTING
# ============================================================

def make_speech_friendly(text):
    """
    Normalize text for speech.

    The normalized string is both displayed and spoken.
    """

    if not isinstance(text, str):
        return ""

    text = re.sub(
        r"\*\*(.*?)\*\*",
        r"\1",
        text
    )

    text = re.sub(
        r"__(.*?)__",
        r"\1",
        text
    )

    text = re.sub(
        r"(?<!\w)\*(.*?)\*(?!\w)",
        r"\1",
        text
    )

    text = re.sub(
        r"(?<!\w)_(.*?)_(?!\w)",
        r"\1",
        text
    )

    text = text.replace("`", "")

    text = re.sub(
        r"(?m)^\s*#{1,6}\s*",
        "",
        text
    )

    text = re.sub(
        r"(?m)^\s*[-•]\s*",
        "",
        text
    )

    text = re.sub(
        r"(?m)^\s*\d+[.)]\s*",
        "",
        text
    )

    text = re.sub(
        r"(-?\d+(?:\.\d+)?)\s*°\s*C\b",
        r"\1 degrees Celsius",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"(-?\d+(?:\.\d+)?)\s*°\s*F\b",
        r"\1 degrees Fahrenheit",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"(-?\d+(?:\.\d+)?)\s*hPa\b",
        r"\1 hectopascals",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"(-?\d+(?:\.\d+)?)\s*%",
        r"\1 percent",
        text,
    )

    return re.sub(
        r"\s+",
        " ",
        text
    ).strip()


def limit_voice_text(
    text,
    max_length=MAX_VOICE_TEXT_LENGTH
):
    """Keep a complete spoken response within the TTS input limit."""

    text = (text or "").strip()

    if len(text) <= max_length:
        return text

    shortened = (
        text[:max_length + 1]
        .rsplit(" ", 1)[0]
        .rstrip(" ,;:-")
    )

    sentence_end = max(
        shortened.rfind("."),
        shortened.rfind("!"),
        shortened.rfind("?"),
    )

    if sentence_end >= max_length // 2:

        return shortened[
            :sentence_end + 1
        ].strip()

    return shortened.rstrip(".!?") + "."


# ============================================================
# SENSOR SNAPSHOT
# ============================================================

def snapshot():
    """Return a thread-safe copy of the latest sensor data."""

    with lock:

        current_monotonic = time.monotonic()

        result = {
            **latest_data,

            "bmp": dict(latest_data["bmp"]),
            "dht": dict(latest_data["dht"]),
            "mq": dict(latest_data["mq"]),
            "rain": dict(latest_data["rain"]),

            "diagnostics": dict(
                latest_data["diagnostics"]
            ),
        }

        telemetry_age = (
            round(
                current_monotonic - last_received,
                2
            )
            if last_received is not None
            else None
        )

        result["telemetry_age_seconds"] = telemetry_age

        result["link_up"] = (
            telemetry_age is not None
            and telemetry_age <= LINK_TIMEOUT_SECONDS
        )

        sensor_ages = {}

        for section, received_time in section_last_received.items():

            sensor_ages[section] = (
                round(
                    current_monotonic - received_time,
                    2
                )
                if received_time is not None
                else None
            )

        result["sensor_age_seconds"] = sensor_ages

        result["sensor_updated_at"] = dict(
            section_updated_at
        )

        return result


# ============================================================
# AI SENSOR DATA SANITIZATION
# ============================================================

def build_ai_sensor_snapshot(sensor_data):

    ai_data = {
        **sensor_data,

        "bmp": dict(sensor_data["bmp"]),
        "dht": dict(sensor_data["dht"]),
        "mq": dict(sensor_data["mq"]),
        "rain": dict(sensor_data["rain"]),

        "diagnostics": dict(
            sensor_data["diagnostics"]
        ),
    }

    sensor_ages = sensor_data.get(
        "sensor_age_seconds",
        {}
    )

    for section in ("bmp", "dht", "mq", "rain"):

        age = sensor_ages.get(section)

        is_fresh = (
            age is not None
            and age <= LINK_TIMEOUT_SECONDS
        )

        ai_data[section]["fresh"] = is_fresh

        if not is_fresh:

            for field in ai_data[section]:

                if field not in ("fresh", "ok"):

                    ai_data[section][field] = None

            if "ok" in ai_data[section]:

                ai_data[section]["ok"] = False

    ai_data["link_up"] = sensor_data.get(
        "link_up",
        False
    )

    return ai_data


# ============================================================
# AI SYSTEM PROMPT
# ============================================================

def build_ai_system_prompt():

    return """
You are Hannah, the personal environmental intelligence assistant
inside the ATMOSENSE dashboard, created by Sakshaat Koul and his team.

PERSONALITY:

You should feel like a naturally warm, thoughtful, friendly woman
having a real conversation with the user.

Sound:
- Warm, calm, relaxed and naturally expressive.
- Friendly and cheerful.
- Intelligent and confident, without sounding like a manual.
- Conversational rather than corporate.
- Entusiastic, not artificial but naturally excited about the user's questions.

LANGUAGE:
- Use everyday, natural English.
- Use contractions naturally: it's, that's, you're, don't, we'll.
- Vary sentence openings. Do not repeatedly say "Hey".
- Avoid robotic phrases such as "Certainly", "As an AI",
  "Based on the provided information", or "I would be happy to".
- Do not force jokes, filler words, or artificial excitement.
- Be casual and friendly with the user in a humanly tone,
  like a friend talking to another friend.

LIVE SENSOR DATA RULES:
1. The sensor snapshot in the CURRENT user message is the only
   authoritative source for current readings.
2. Previous readings in conversation history are historical.
   Never reuse them as current measurements.
3. Never assume a previous reading remains unchanged.
4. A null value means unavailable.
5. A sensor marked fresh=false is unavailable for current analysis.
6. Never invent sensor measurements.
7. Distinguish device connection from individual sensor freshness.
8. MQ135 values are estimates and depend on calibration.
   Do not describe them as certified air-quality measurements.
9. Rain sensor percentage represents local surface wetness,
   NOT the probability of future rainfall.
10. Do not confuse NH4 estimates with direct soil nutrient availability.
11. Never guarantee agricultural success based only on these readings.

RESPONSE STYLE:

For normal text requests:
- Use clean Markdown.
- Use headings or bullets only when they improve readability.
- Explain clearly and give useful detail.
- Do not force sensor readings into unrelated questions.

For voice requests, additional instructions will be supplied
in the current system message. Follow those instructions exactly.

Do not claim medical, agricultural, or environmental certification.
"""


# ============================================================
# BUILD CURRENT LIVE SENSOR CONTEXT
# ============================================================

def build_live_sensor_context(sensor_data):

    ai_sensor_data = build_ai_sensor_snapshot(sensor_data)

    sensor_json = json.dumps(
        ai_sensor_data,
        indent=2,
        ensure_ascii=False,
    )

    telemetry_age = sensor_data.get(
        "telemetry_age_seconds"
    )

    link_up = sensor_data.get(
        "link_up",
        False
    )

    connection_status = (
        "CONNECTED"
        if link_up
        else "DISCONNECTED OR STALE"
    )

    sensor_ages = sensor_data.get(
        "sensor_age_seconds",
        {}
    )

    sensor_status = {}

    for section, age in sensor_ages.items():

        if age is None:

            sensor_status[section] = "NO DATA RECEIVED"

        elif age > LINK_TIMEOUT_SECONDS:

            sensor_status[section] = (
                f"STALE - last updated {age} seconds ago"
            )

        else:

            sensor_status[section] = (
                f"FRESH - last updated {age} seconds ago"
            )

    return f"""
============================================================
FRESH ATMOSENSE SENSOR SNAPSHOT
============================================================

This snapshot was fetched specifically for the current request.

Snapshot generation time (UTC): {timestamp()}

Telemetry connection: {connection_status}

Age of latest received packet:
{telemetry_age if telemetry_age is not None else "No packet received"}

Individual sensor freshness:
{json.dumps(sensor_status, indent=2)}

Latest sensor data:
{sensor_json}

MANDATORY INSTRUCTIONS:
1. Use only this snapshot for current sensor measurements.
2. Previous conversation readings are historical.
3. A null value means the measurement is unavailable.
4. A sensor marked fresh=false must not be treated as current.
5. Never present a retained historical value as a live reading.
6. If telemetry is disconnected, clearly state this.
7. If a sensor has never transmitted data, report it as unavailable.
8. Do not estimate missing values from conversation history.

============================================================
CURRENT USER QUESTION
============================================================
"""


# ============================================================
# DASHBOARD ROUTE
# ============================================================

@app.route("/")
def dashboard():

    return render_template("index.html")


# ============================================================
# GET SENSOR DATA
# ============================================================

@app.route("/data", methods=["GET"])
def get_data():

    return jsonify(snapshot())


# ============================================================
# ATMOSENSE AI CHAT — GROQ
# ============================================================

@app.route("/api/chat", methods=["POST"])
def ai_chat():

    if groq_client is None:

        return jsonify({
            "error": (
                "Groq API key is not configured. "
                "Add GROQ_API_KEY to your .env file."
            )
        }), 503

    incoming = request.get_json(silent=True)

    if not isinstance(incoming, dict):

        return jsonify({
            "error": "Invalid request."
        }), 400

    question = incoming.get("message", "")

    if not isinstance(question, str):

        return jsonify({
            "error": "Message must be text."
        }), 400

    question = question.strip()

    if not question:

        return jsonify({
            "error": "Please enter a question."
        }), 400

    if len(question) > 1000:

        return jsonify({
            "error": (
                "Question is too long. "
                "Keep it under 1000 characters."
            )
        }), 400

    response_mode = incoming.get(
        "response_mode",
        "text"
    )

    if response_mode not in ("text", "voice"):

        response_mode = "text"

    is_voice_request = response_mode == "voice"

    # --------------------------------------------------------
    # STEP 1: FETCH FRESH SENSOR SNAPSHOT
    # --------------------------------------------------------

    sensor_data = snapshot()

    print("\n[AI LIVE DATA]")

    print(
        f"Temperature: {sensor_data['bmp'].get('tmp')} °C"
    )

    print(
        f"Humidity: {sensor_data['dht'].get('hum')}%"
    )

    print(
        f"Pressure: {sensor_data['bmp'].get('prs')} hPa"
    )

    print(
        f"Connection: {sensor_data.get('link_up')}"
    )

    print(
        f"Packet age: "
        f"{sensor_data.get('telemetry_age_seconds')} seconds"
    )

    print(
        f"Sensor ages: "
        f"{sensor_data.get('sensor_age_seconds')}"
    )

    print(f"Response mode: {response_mode}")

    # --------------------------------------------------------
    # STEP 2: PROCESS CONVERSATION HISTORY
    # --------------------------------------------------------

    incoming_history = incoming.get(
        "history",
        []
    )

    if not isinstance(incoming_history, list):

        incoming_history = []

    conversation_history = []

    for item in incoming_history[-8:]:

        if not isinstance(item, dict):
            continue

        role = item.get("role")
        content = item.get("content")

        if (
            role in ("user", "assistant")
            and isinstance(content, str)
            and content.strip()
        ):

            conversation_history.append({
                "role": role,
                "content": content.strip()[:1500],
            })

    # --------------------------------------------------------
    # STEP 3: BUILD FRESH LIVE CONTEXT
    # --------------------------------------------------------

    system_prompt = build_ai_system_prompt()

    live_context = build_live_sensor_context(
        sensor_data
    )

    current_user_message = (
        f"{live_context}\n\n"
        f"User's actual question:\n{question}"
    )

    messages = [
        {
            "role": "system",
            "content": system_prompt
        }
    ]

    messages.extend(conversation_history)

    messages.append({
        "role": "user",
        "content": current_user_message,
    })

    # --------------------------------------------------------
    # STEP 4: GENERATE RESPONSE
    # --------------------------------------------------------

    try:

        if is_voice_request:

            messages[0]["content"] += """

VOICE MODE — FOLLOW THESE RULES:

You are speaking directly to the user as Hannah.

Return a short, complete, natural spoken answer.

- Maximum 200 characters.
- Usually two or three sentences.
- Answer the actual question immediately.
- Sound warm, relaxed, genuinely conversational and casual.
- Be friendly and talk like a friend talking to another friend.
- Be Enthusiastic, not artificial but naturally excited about the user's questions.
- Be casual and approachable, not formal or corporate.
- Use natural sentence flow and punctuation.
- Dont use language as , 'Sure thing ', 'Absolutely', 'Certainly', 'As an AI', 'Based on the provided information', or 'I would be happy to'. Be natural and humanly in your tone.
- Use natural contractions.
- Preserve relevant sensor values and facts accurately.
- Say units naturally, for example "degrees Celsius",
  "hectopascals", and "percent".
- Do not use Markdown, headings, bullets, lists, or emojis.
- Do not include stage directions or voice instructions.
- Never invent unavailable readings.
- Finish the sentence naturally; never leave it incomplete.

The exact response you produce will be displayed in the chat
AND spoken by the voice engine.

Every word must be suitable for both reading and speaking.

Return ONLY Hannah's final spoken words.
"""

            max_tokens = 500
            temperature = 0.6

        else:

            max_tokens = 1200
            temperature = 0.4

        # ----------------------------------------------------
        # GROQ REQUEST PARAMETERS
        # ----------------------------------------------------

        completion_params = {
            "model": GROQ_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
            "timeout": 45,
        }

        # GPT-OSS reasoning configuration

        if GROQ_MODEL.startswith("openai/gpt-oss-"):

            completion_params["include_reasoning"] = False

            completion_params["reasoning_effort"] = "low"

        print("\n[GROQ] Sending request...")

        print(f"[GROQ] Model: {GROQ_MODEL}")

        print(f"[GROQ] Mode: {response_mode}")

        print(
            f"[GROQ] Maximum completion tokens: {max_tokens}"
        )

        # ----------------------------------------------------
        # CALL GROQ
        # ----------------------------------------------------

        completion = groq_client.chat.completions.create(
            **completion_params
        )

        # ----------------------------------------------------
        # EXTRACT RESPONSE
        # ----------------------------------------------------

        if not completion.choices:

            print("[GROQ ERROR] No choices returned.")

            return jsonify({
                "error": "The AI model returned no response."
            }), 502

        choice = completion.choices[0]

        message = choice.message

        answer = (
            message.content or ""
        ).strip()

        print(
            f"[GROQ] Finish reason: {choice.finish_reason}"
        )

        print(
            f"[GROQ] Content length: {len(answer)}"
        )

        # ----------------------------------------------------
        # HANDLE EMPTY MODEL RESPONSE
        # ----------------------------------------------------

        if not answer:

            print("\n[GROQ ERROR] Empty final response.")

            print(
                "[GROQ DEBUG]",
                message.model_dump(exclude_none=True),
            )

            return jsonify({
                "error": (
                    "The AI model returned no final answer. "
                    "Check the Flask terminal for diagnostic details."
                )
            }), 502

        # ----------------------------------------------------
        # BUILD RESPONSE
        # ----------------------------------------------------

        response_data = {
            "response_mode": response_mode,

            "link_up": sensor_data.get(
                "link_up",
                False
            ),

            "sensor_timestamp": sensor_data.get(
                "updated_at"
            ),

            "telemetry_age_seconds": sensor_data.get(
                "telemetry_age_seconds"
            ),
        }

        if is_voice_request:

            # Normalize exactly once.
            # Both fields receive the SAME final string.

            voice_script = make_speech_friendly(answer)

            voice_script = limit_voice_text(
                voice_script
            )

            if not voice_script:

                return jsonify({
                    "error": (
                        "The AI model generated an empty voice response."
                    )
                }), 502

            response_data["reply"] = voice_script

            response_data["speech_text"] = voice_script

        else:

            response_data["reply"] = answer

        print(f"[HANNAH] Mode: {response_mode}")

        print(
            f"[HANNAH] Response: {response_data['reply']}"
        )

        return jsonify(response_data)

    except Exception as error:

        print("\n======================================")
        print("[ATMOSENSE GROQ ERROR]")
        print("======================================")

        print(
            f"Error type: {type(error).__name__}"
        )

        print(
            f"Error message: {error}"
        )

        traceback.print_exc()

        return jsonify({
            "error": (
                "The AI service could not process your request. "
                "Please try again."
            )
        }), 502


# ============================================================
# WHISPER LARGE V3 — SPEECH TO TEXT
# ============================================================

@app.route("/api/transcribe", methods=["POST"])
def transcribe_audio():

    if groq_client is None:

        return jsonify({
            "error": "Groq API key is not configured."
        }), 503

    if "audio" not in request.files:

        return jsonify({
            "error": "No audio recording was received."
        }), 400

    audio_file = request.files["audio"]

    if not audio_file or not audio_file.filename:

        return jsonify({
            "error": "Invalid audio recording."
        }), 400

    audio_bytes = audio_file.read()

    if not audio_bytes:

        return jsonify({
            "error": "The recording is empty."
        }), 400

    if len(audio_bytes) > MAX_AUDIO_SIZE:

        return jsonify({
            "error": "Audio exceeds the 25 MB upload limit."
        }), 413

    filename = os.path.basename(
        audio_file.filename
    )

    if "." not in filename:

        filename = "recording.webm"

    try:

        print(
            f"[WHISPER] Processing recording: "
            f"{filename} ({len(audio_bytes)} bytes)"
        )

        transcription = groq_client.audio.transcriptions.create(
            file=(
                filename,
                audio_bytes,
                audio_file.mimetype or "audio/webm",
            ),

            model=WHISPER_MODEL,

            prompt=(
                "ATMOSENSE, ESP32, BMP280, DHT11, MQ135, "
                "atmospheric pressure, humidity, temperature, "
                "air quality, rain sensor, microclimate."
            ),

            response_format="json",

            temperature=0.0,

            timeout=60,
        )

        transcribed_text = transcription.text.strip()

        if not transcribed_text:

            return jsonify({
                "error": (
                    "No speech could be detected. Please try again."
                )
            }), 422

        print(
            f"[WHISPER] Transcription: {transcribed_text}"
        )

        return jsonify({
            "text": transcribed_text,
            "model": WHISPER_MODEL,
        })

    except Exception as error:

        print(
            f"[WHISPER ERROR] "
            f"{type(error).__name__}: {error}"
        )

        traceback.print_exc()

        return jsonify({
            "error": (
                "Speech recognition failed. "
                "Please try recording again."
            )
        }), 502


# ============================================================
# MICROSOFT EDGE TTS — TEXT TO SPEECH
# ============================================================

async def generate_edge_audio(text):
    """
    Generate Hannah's speech using Microsoft Edge TTS.

    Returns MP3 audio bytes.
    """

    communicate = edge_tts.Communicate(
        text=text,
        voice=EDGE_TTS_VOICE,
        rate=EDGE_TTS_RATE,
        volume=EDGE_TTS_VOLUME,
    )

    audio_data = bytearray()

    async for chunk in communicate.stream():

        if chunk["type"] == "audio":

            audio_data.extend(
                chunk["data"]
            )

    return bytes(audio_data)


@app.route("/api/speak", methods=["POST"])
def generate_speech():

    incoming = request.get_json(silent=True)

    if not isinstance(incoming, dict):

        return jsonify({
            "error": "Invalid speech request."
        }), 400

    text = incoming.get("text", "")

    if not isinstance(text, str):

        return jsonify({
            "error": "Speech text must be a string."
        }), 400

    # Do not rewrite or paraphrase this text.
    # The frontend sends the exact reply returned by /api/chat.

    text = text.strip()

    if not text:

        return jsonify({
            "error": (
                "No text was provided for speech generation."
            )
        }), 400

    if len(text) > 200:

        return jsonify({
            "error": (
                "Voice response is too long. "
                "Please request a shorter answer."
            )
        }), 400

    try:

        print("\n[EDGE TTS] Generating Hannah's voice...")

        print(f"[EDGE TTS] Voice: {EDGE_TTS_VOICE}")

        print(f"[EDGE TTS] Rate: {EDGE_TTS_RATE}")

        print(f"[EDGE TTS] Input text: {text}")

        # Run the asynchronous Edge TTS operation
        # inside this Flask request.

        audio_bytes = asyncio.run(
            generate_edge_audio(text)
        )

        if not audio_bytes:

            return jsonify({
                "error": (
                    "Speech generation returned empty audio."
                )
            }), 502

        print(
            f"[EDGE TTS] Audio generated successfully "
            f"({len(audio_bytes)} bytes)"
        )

        # Edge TTS returns MP3 audio.

        return Response(
            audio_bytes,

            mimetype="audio/mpeg",

            headers={
                "Content-Disposition": (
                    "inline; filename=hannah.mp3"
                ),

                "Cache-Control": "no-store",
            },
        )

    except Exception as error:

        print("\n======================================")
        print("[EDGE TTS ERROR]")
        print("======================================")

        print(
            f"Error type: {type(error).__name__}"
        )

        print(
            f"Error message: {error}"
        )

        traceback.print_exc()

        return jsonify({
            "error": (
                "Hannah's voice could not be generated. "
                "Check your internet connection and try again."
            )
        }), 502


# ============================================================
# RECEIVE ESP32 SENSOR DATA
# ============================================================

@app.route("/data", methods=["POST"])
def receive_data():

    global last_received, last_sequence

    global last_device_id, last_device_uptime

    global packet_count, missed_count

    incoming = request.get_json(silent=True)

    if not isinstance(incoming, dict):

        return jsonify({
            "status": "error",
            "message": "Expected a JSON object",
        }), 400

    packet = incoming.get(
        "data",
        incoming
    )

    if not isinstance(packet, dict):

        return jsonify({
            "status": "error",
            "message": "Invalid packet structure",
        }), 400

    fields = {

        "bmp": (
            "ok",
            "tmp",
            "prs"
        ),

        "dht": (
            "ok",
            "hum"
        ),

        "mq": (
            "s",
            "co2",
            "co",
            "nh4",
            "alc",
            "tol",
            "ace",
            "smk",
        ),

        "rain": (
            "ok",
            "st",
            "pct",
            "adc"
        ),
    }

    cleaned_sections = {}

    for section, allowed in fields.items():

        if (
            section in packet
            and not isinstance(packet[section], dict)
        ):

            return jsonify({
                "status": "error",
                "message": (
                    f"{section} must be a JSON object"
                ),
            }), 400

        if section in packet:

            cleaned_sections[section] = clean_section(
                packet[section],
                allowed,
            )

    sequence = packet.get("n")

    try:

        sequence = (
            int(sequence)
            if sequence is not None
            else None
        )

    except (ValueError, TypeError):

        sequence = None

    device_id = (
        str(packet["id"])[:80]
        if packet.get("id") is not None
        else None
    )

    device_uptime = numeric(
        packet.get("up")
    )

    received_at = time.monotonic()

    received_timestamp = timestamp()

    with lock:

        device_changed = (
            device_id is not None
            and last_device_id is not None
            and device_id != last_device_id
        )

        if device_changed:

            print(
                "[DATA] New ESP32 device detected. "
                "Resetting sensor state."
            )

            for section in (
                "bmp",
                "dht",
                "mq",
                "rain"
            ):

                for key in latest_data[section]:

                    latest_data[section][key] = (
                        False
                        if key == "ok"
                        else None
                    )

                section_last_received[section] = None

                section_updated_at[section] = None

            last_sequence = None

            last_device_uptime = None

        if device_id is not None:

            last_device_id = device_id

            latest_data["id"] = device_id

        if (
            sequence is not None
            and last_sequence is not None
        ):

            if sequence <= last_sequence:

                reboot_detected = (
                    device_uptime is not None
                    and last_device_uptime is not None
                    and device_uptime < last_device_uptime
                )

                if not reboot_detected:

                    return jsonify({
                        "status": "ignored",

                        "message": (
                            "Duplicate or out-of-order packet"
                        ),

                        "last_sequence": last_sequence,
                    }), 409

                print(
                    "[DATA] ESP32 reboot detected. "
                    "Sequence reset accepted."
                )

            elif sequence > last_sequence + 1:

                missed_count += (
                    sequence - last_sequence - 1
                )

        if sequence is not None:

            last_sequence = sequence

            latest_data["n"] = sequence

        if device_uptime is not None:

            last_device_uptime = device_uptime

            latest_data["up"] = device_uptime

        for section, cleaned in cleaned_sections.items():

            if cleaned:

                latest_data[section].update(cleaned)

                section_last_received[section] = received_at

                section_updated_at[section] = (
                    received_timestamp
                )

        diag = packet.get("diagnostics")

        if (
            isinstance(diag, dict)
            and "bad" in diag
        ):

            try:

                latest_data["diagnostics"]["bad"] = max(
                    0,
                    int(diag["bad"]),
                )

            except (ValueError, TypeError):

                pass

        packet_count += 1

        latest_data["diagnostics"]["ok"] = packet_count

        latest_data["diagnostics"]["missed"] = missed_count

        latest_data["updated_at"] = received_timestamp

        latest_data["link_up"] = True

        last_received = received_at

    print(
        f"[DATA] Packet received | n={sequence} | "
        f"device={device_id or 'unknown'}"
    )

    return jsonify({
        "status": "success",
        "data": snapshot(),
    })


# ============================================================
# APPLICATION STARTUP
# ============================================================

if __name__ == "__main__":

    print("\n======================================")
    print("       ATMOSENSE FLASK SERVER")
    print("======================================")

    print("\nMode: LIVE ESP32 TELEMETRY")

    print("Demo mode: DISABLED")

    print(f"AI model: {GROQ_MODEL}")

    print(f"Listening model: {WHISPER_MODEL}")

    print("Speech engine: Microsoft Edge TTS")

    print(f"Speech voice: {EDGE_TTS_VOICE}")

    print(f"Speech rate: {EDGE_TTS_RATE}")

    start_mdns_service()

    print("\nDashboard:")
    print("http://localhost:5000")

    print("\nSensor endpoint:")
    print("http://atmosense.local:5000/data")

    print("\nAI endpoint:")
    print("http://localhost:5000/api/chat")

    print("\nTranscription endpoint:")
    print("http://localhost:5000/api/transcribe")

    print("\nSpeech endpoint:")
    print("http://localhost:5000/api/speak")

    print("\nWaiting for ESP32 sensor packets...\n")

    app.run(
        host="0.0.0.0",
        port=FLASK_PORT,
        debug=False,
        threaded=True,
        use_reloader=False,
    )
