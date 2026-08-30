from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from worker_protocol import emit
from .common import _available_path, _require_directory, _require_file, _run_ffmpeg, _subprocess_detail

OUTPUT_FORMATS = {"wav", "flac", "mp3", "ogg"}
SAMPLE_RATES = {32000, 44100, 48000}
MP3_BIT_RATES = {"192k", "256k", "320k"}
OGG_BIT_RATES = {"192k", "256k", "320k", "450k"}


def _build_conversion_command(
    input_path: Path,
    output_path: Path,
    output_format: str,
    sample_rate: int,
    channels: int,
    wav_bit_depth: str,
    flac_bit_depth: str,
    mp3_bit_rate: str,
    ogg_bit_rate: str,
) -> list[str]:
    command = ["-i", str(input_path), "-vn", "-ar", str(sample_rate), "-ac", str(channels)]
    if output_format == "wav":
        codec = {"PCM-16": "pcm_s16le", "PCM-24": "pcm_s24le", "PCM-32": "pcm_s32le"}[wav_bit_depth]
        command.extend(["-c:a", codec])
    elif output_format == "flac":
        sample_format = {"16-bit": "s16", "32-bit": "s32"}[flac_bit_depth]
        command.extend(["-sample_fmt", sample_format, "-compression_level", "5"])
    elif output_format == "mp3":
        command.extend(["-b:a", mp3_bit_rate])
    elif output_format == "ogg":
        command.extend(["-b:a", ogg_bit_rate])
    command.extend(["-y", str(output_path)])
    return command


def _conversion_suffix(
    output_format: str,
    sample_rate: int,
    wav_bit_depth: str,
    flac_bit_depth: str,
    mp3_bit_rate: str,
    ogg_bit_rate: str,
) -> str:
    details = {
        "wav": wav_bit_depth,
        "flac": flac_bit_depth,
        "mp3": mp3_bit_rate,
        "ogg": ogg_bit_rate,
    }
    return f"_{sample_rate}_{details[output_format]}"


def _convert_audio(payload: dict[str, Any]) -> dict[str, Any]:
    raw_inputs = payload.get("inputs")
    if not isinstance(raw_inputs, list) or not raw_inputs:
        raise ValueError("At least one input audio file is required")
    if len(raw_inputs) > 1000:
        raise ValueError("A maximum of 1000 files can be converted at once")

    inputs = [_require_file(value, "Input audio") for value in raw_inputs]
    output_dir = _require_directory(payload.get("outputDir"), "Output directory", create=True)
    output_format = str(payload.get("outputFormat") or "wav").strip().lower()
    sample_rate = int(payload.get("sampleRate") or 44100)
    channels = int(payload.get("channels") or 2)
    wav_bit_depth = str(payload.get("wavBitDepth") or "PCM-24").upper()
    flac_bit_depth = str(payload.get("flacBitDepth") or "16-bit")
    mp3_bit_rate = str(payload.get("mp3BitRate") or "320k").lower()
    ogg_bit_rate = str(payload.get("oggBitRate") or "320k").lower()

    if output_format not in OUTPUT_FORMATS:
        raise ValueError("Unsupported output format")
    if sample_rate not in SAMPLE_RATES:
        raise ValueError("Unsupported sample rate")
    if channels not in {1, 2}:
        raise ValueError("Channels must be mono or stereo")
    if wav_bit_depth not in {"PCM-16", "PCM-24", "PCM-32"}:
        raise ValueError("Unsupported WAV bit depth")
    if flac_bit_depth not in {"16-bit", "32-bit"}:
        raise ValueError("Unsupported FLAC bit depth")
    if mp3_bit_rate not in MP3_BIT_RATES:
        raise ValueError("Unsupported MP3 bitrate")
    if ogg_bit_rate not in OGG_BIT_RATES:
        raise ValueError("Unsupported OGG bitrate")

    suffix = _conversion_suffix(
        output_format,
        sample_rate,
        wav_bit_depth,
        flac_bit_depth,
        mp3_bit_rate,
        ogg_bit_rate,
    )
    output_paths: list[str] = []
    failures: list[dict[str, str]] = []
    for index, input_path in enumerate(inputs, start=1):
        emit("audio_tool_progress", {
            "operation": "convert",
            "phase": "converting",
            "completed": index - 1,
            "total": len(inputs),
            "current": input_path.name,
        })
        output_path = _available_path(output_dir / f"{input_path.stem}{suffix}.{output_format}")
        try:
            command = _build_conversion_command(
                input_path,
                output_path,
                output_format,
                sample_rate,
                channels,
                wav_bit_depth,
                flac_bit_depth,
                mp3_bit_rate,
                ogg_bit_rate,
            )
            _run_ffmpeg(command)
            output_paths.append(str(output_path))
        except subprocess.CalledProcessError as error:
            failures.append({"path": str(input_path), "message": _subprocess_detail(error)})
        except Exception as error:
            failures.append({"path": str(input_path), "message": str(error)})

    if not output_paths:
        detail = failures[0]["message"] if failures else "No files were converted"
        raise RuntimeError(detail)
    return {
        "operation": "convert",
        "outputDir": str(output_dir),
        "outputPaths": output_paths,
        "succeeded": len(output_paths),
        "failed": failures,
    }
