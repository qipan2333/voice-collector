import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


MIME_EXTENSIONS = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/3gpp": ".3gp",
    "audio/amr": ".amr",
}


def extension_for_mime(mime: str | None) -> str:
    base = (mime or "audio/webm").split(";", 1)[0].strip().lower()
    return MIME_EXTENSIONS.get(base, ".audio")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_json(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def probe(path: Path) -> dict[str, Any]:
    payload = run_json([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    streams = [stream for stream in payload.get("streams", []) if stream.get("codec_type") == "audio"]
    if not streams:
        raise ValueError("文件中没有可解码的音频流")
    stream = streams[0]
    duration = float(payload.get("format", {}).get("duration") or stream.get("duration") or 0)
    return {
        "duration_seconds": duration,
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
        "channels": int(stream["channels"]) if stream.get("channels") else None,
        "codec_name": stream.get("codec_name"),
        "format_name": payload.get("format", {}).get("format_name"),
    }


def volume_metrics(path: Path) -> dict[str, float | None]:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        check=False, capture_output=True, text=True,
    )
    text = f"{result.stdout}\n{result.stderr}"
    mean = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", text)
    maximum = re.search(r"max_volume:\s*(-?[0-9.]+) dB", text)
    return {
        "mean_volume_db": float(mean.group(1)) if mean else None,
        "max_volume_db": float(maximum.group(1)) if maximum else None,
    }


def normalize(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source), "-ac", "1", "-ar", "48000", "-sample_fmt", "s16", str(target),
    ], check=True)


def move_original(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
