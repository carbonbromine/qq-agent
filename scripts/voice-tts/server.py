
"""Loopback-only Qwen3-TTS CustomVoice server. Requires qwen-tts and soundfile."""
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

MODEL = os.getenv("QQ_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
DEVICE = os.getenv("QQ_TTS_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
PORT = int(os.getenv("QQ_TTS_PORT", "8765"))
SPEAKERS = {"Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"}
print("Loading Qwen3-TTS on", DEVICE, flush=True)
tts = Qwen3TTSModel.from_pretrained(
    MODEL, device_map=DEVICE,
    dtype=torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32
)
lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def reply_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply_json(200, {"ready": True, "model": MODEL, "device": DEVICE})
        self.reply_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/synthesize":
            return self.reply_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length", "0"))
            if not 0 < length <= 4096:
                return self.reply_json(413, {"error": "invalid payload size"})
            args = json.loads(self.rfile.read(length))
            text = args.get("text")
            speaker = args.get("speaker", "Vivian")
            if not isinstance(text, str) or not 1 <= len(text.strip()) <= 300 or speaker not in SPEAKERS:
                return self.reply_json(400, {"error": "invalid text/speaker"})
            with lock, torch.inference_mode():
                waves, sr = tts.generate_custom_voice(text=text.strip(), language="Chinese", speaker=speaker)
            buffer = io.BytesIO()
            sf.write(buffer, waves[0], sr, format="WAV", subtype="PCM_16")
            audio = buffer.getvalue()
            if len(audio) > 5*1024*1024:
                return self.reply_json(413, {"error": "audio too large"})
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except (ValueError, TypeError, json.JSONDecodeError):
            self.reply_json(400, {"error": "invalid JSON"})
        except Exception as exc:
            print("Inference failed:", type(exc).__name__, flush=True)
            self.reply_json(500, {"error": "synthesis failed"})

    def log_message(self, fmt, *args):
        print("[tts]", fmt % args, flush=True)

if __name__ == "__main__":
    if not 1 <= PORT <= 65535:
        raise SystemExit("invalid port")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
