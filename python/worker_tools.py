from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
import traceback
from pathlib import Path
from typing import Any

from worker_protocol import emit, emit_error


SUPPORTED_AUDIO_SUFFIXES = {
    ".wav",
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wma",
    ".aiff",
    ".aif",
}
OUTPUT_FORMATS = {"wav", "flac", "mp3", "ogg"}
SAMPLE_RATES = {32000, 44100, 48000}
MP3_BIT_RATES = {"192k", "256k", "320k"}
OGG_BIT_RATES = {"192k", "256k", "320k", "450k"}


def _require_file(value: Any, label: str) -> Path:
    path = Path(str(value or "").strip()).expanduser()
    if not str(path) or not path.is_file():
        raise ValueError(f"{label} does not exist or is not a file")
    return path.resolve()


def _require_directory(value: Any, label: str, *, create: bool = False) -> Path:
    raw_value = str(value or "").strip()
    if not raw_value:
        raise ValueError(f"{label} is required")
    path = Path(raw_value).expanduser()
    if create:
        path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory")
    return path.resolve()


def _ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise RuntimeError("FFmpeg was not found in the application tools or PATH")
    return path


def _available_path(path: Path) -> Path:
    if not path.exists():
        return path
    for index in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{index}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Unable to allocate an output filename for {path.name}")


def _subprocess_detail(error: subprocess.CalledProcessError) -> str:
    detail = (error.stderr or error.stdout or "").strip()
    return detail[-2000:] if detail else f"FFmpeg exited with status {error.returncode}"


def _run_ffmpeg(arguments: list[str]) -> None:
    subprocess.run(
        [_ffmpeg_path(), "-nostdin", "-hide_banner", "-loglevel", "error", *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


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


def _audio_files_in_folder(folder: Path) -> list[Path]:
    return sorted(
        (
            path.resolve()
            for path in folder.iterdir()
            if path.is_file() and path.suffix.lower() in SUPPORTED_AUDIO_SUFFIXES
        ),
        key=lambda path: path.name.casefold(),
    )


def _ffmpeg_concat_path(path: Path) -> str:
    # FFmpeg's concat demuxer accepts forward slashes on every supported desktop platform.
    return str(path).replace("\\", "/").replace("'", "'\\''")


def _merge_audio(payload: dict[str, Any]) -> dict[str, Any]:
    input_dir = _require_directory(payload.get("inputDir"), "Input directory")
    output_dir = _require_directory(payload.get("outputDir"), "Output directory", create=True)
    inputs = _audio_files_in_folder(input_dir)
    if not inputs:
        raise ValueError("The input directory does not contain supported audio files")
    if len(inputs) > 2000:
        raise ValueError("A maximum of 2000 files can be merged at once")

    output_name = f"merged_audio_{input_dir.name or 'output'}.wav"
    output_path = _available_path(output_dir / output_name)
    skipped: list[dict[str, str]] = []
    normalized: list[Path] = []
    with tempfile.TemporaryDirectory(prefix="pymss-merge-") as temp_value:
        temp_dir = Path(temp_value)
        for index, input_path in enumerate(inputs, start=1):
            emit("audio_tool_progress", {
                "operation": "merge",
                "completed": index - 1,
                "total": len(inputs),
                "current": input_path.name,
            })
            segment_path = temp_dir / f"segment_{index:06d}.wav"
            try:
                _run_ffmpeg([
                    "-i", str(input_path), "-vn", "-ar", "44100", "-ac", "2",
                    "-c:a", "pcm_s24le", "-y", str(segment_path),
                ])
                normalized.append(segment_path)
            except subprocess.CalledProcessError as error:
                skipped.append({"path": str(input_path), "message": _subprocess_detail(error)})

        if not normalized:
            detail = skipped[0]["message"] if skipped else "No readable audio files were found"
            raise RuntimeError(detail)
        concat_file = temp_dir / "segments.txt"
        concat_file.write_text(
            "".join(f"file '{_ffmpeg_concat_path(path)}'\n" for path in normalized),
            encoding="utf-8",
        )
        try:
            _run_ffmpeg([
                "-f", "concat", "-safe", "0", "-i", str(concat_file),
                "-c:a", "copy", "-y", str(output_path),
            ])
        except subprocess.CalledProcessError as error:
            raise RuntimeError(_subprocess_detail(error)) from error

    return {
        "operation": "merge",
        "outputDir": str(output_dir),
        "outputPath": str(output_path),
        "merged": len(normalized),
        "skipped": skipped,
    }


def _stereo_audio(path: Path, sample_rate: int = 44100) -> Any:
    import librosa  # type: ignore
    import numpy as np  # type: ignore

    audio, _ = librosa.load(str(path), sr=sample_rate, mono=False)
    audio = np.asarray(audio, dtype=np.float64)
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=0)
    elif audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    return audio[:2]


def _calculate_sdr_arrays(reference: Any, estimated: Any) -> tuple[list[float], float, list[float], float]:
    import numpy as np  # type: ignore

    reference = np.asarray(reference, dtype=np.float64)
    estimated = np.asarray(estimated, dtype=np.float64)
    if reference.ndim != 2 or estimated.ndim != 2:
        raise ValueError("SDR inputs must contain channel and sample dimensions")
    channels = min(reference.shape[0], estimated.shape[0])
    samples = min(reference.shape[1], estimated.shape[1])
    if channels <= 0 or samples <= 0:
        raise ValueError("SDR inputs do not contain audio samples")
    reference = reference[:channels, :samples]
    estimated = estimated[:channels, :samples]
    eps = 1e-7

    reference_energy = np.sum(reference * reference, axis=1)
    error_energy = np.sum((reference - estimated) ** 2, axis=1)
    sdr = 10.0 * np.log10((reference_energy + eps) / (error_energy + eps))

    scale = np.sum(estimated * reference, axis=1, keepdims=True) / (
        np.sum(reference * reference, axis=1, keepdims=True) + eps
    )
    target = scale * reference
    noise = estimated - target
    si_sdr = 10.0 * np.log10(
        (np.sum(target * target, axis=1) + eps) / (np.sum(noise * noise, axis=1) + eps)
    )
    sdr_values = [round(float(value), 4) for value in sdr]
    si_sdr_values = [round(float(value), 4) for value in si_sdr]
    return (
        sdr_values,
        round(float(np.mean(sdr)), 4),
        si_sdr_values,
        round(float(np.mean(si_sdr)), 4),
    )


def _calculate_sdr(payload: dict[str, Any]) -> dict[str, Any]:
    reference_path = _require_file(payload.get("referencePath"), "Reference audio")
    estimated_path = _require_file(payload.get("estimatedPath"), "Estimated audio")
    emit("audio_tool_progress", {
        "operation": "sdr",
        "completed": 0,
        "total": 2,
        "current": reference_path.name,
    })
    reference = _stereo_audio(reference_path)
    emit("audio_tool_progress", {
        "operation": "sdr",
        "completed": 1,
        "total": 2,
        "current": estimated_path.name,
    })
    estimated = _stereo_audio(estimated_path)
    sdr, average_sdr, si_sdr, average_si_sdr = _calculate_sdr_arrays(reference, estimated)
    return {
        "operation": "sdr",
        "referencePath": str(reference_path),
        "estimatedPath": str(estimated_path),
        "sampleRate": 44100,
        "sdr": sdr,
        "averageSdr": average_sdr,
        "siSdr": si_sdr,
        "averageSiSdr": average_si_sdr,
    }


def _vocal_to_midi(payload: dict[str, Any]) -> dict[str, Any]:
    input_path = _require_file(payload.get("inputPath"), "Input vocal audio")
    model_path = _require_file(payload.get("modelPath"), "SOME model weights")
    output_dir = _require_directory(payload.get("outputDir"), "Output directory", create=True)
    bpm = float(payload.get("bpm") or 120)
    if not math.isfinite(bpm) or bpm < 30 or bpm > 300:
        raise ValueError("BPM must be between 30 and 300")

    emit("audio_tool_progress", {
        "operation": "midi",
        "completed": 0,
        "total": 1,
        "current": input_path.name,
    })
    from some.infer import infer  # type: ignore

    config_path = Path(__file__).resolve().parent / "some" / "config.yaml"
    output_path = Path(infer(model_path, config_path, input_path, output_dir, bpm)).resolve()
    return {
        "operation": "midi",
        "outputDir": str(output_dir),
        "outputPath": str(output_path),
        "bpm": bpm,
    }


def cmd_audio_tools(payload: dict[str, Any]) -> int:
    operation = str(payload.get("operation") or "").strip().lower()
    handlers = {
        "convert": _convert_audio,
        "merge": _merge_audio,
        "sdr": _calculate_sdr,
        "midi": _vocal_to_midi,
    }
    handler = handlers.get(operation)
    if handler is None:
        return emit_error("AUDIO_TOOL_INVALID", "Unknown audio tool operation")
    try:
        result = handler(payload)
        emit("audio_tool_result", result)
        return 0
    except Exception as error:
        return emit_error(
            "AUDIO_TOOL_FAILED",
            str(error),
            traceback.format_exc(),
            extra={"operation": operation},
        )
