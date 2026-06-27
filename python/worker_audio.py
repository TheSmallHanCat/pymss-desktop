from __future__ import annotations

import hashlib
import json
import math
import traceback
from pathlib import Path
from typing import Any

from worker_protocol import emit, emit_error

def _audio_metadata(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    try:
        import av  # type: ignore
        with av.open(str(path)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise RuntimeError("No audio stream found")
            duration = 0.0
            if stream.duration is not None and stream.time_base is not None:
                duration = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                duration = float(container.duration / av.time_base)
            sample_rate = int(getattr(stream.codec_context, "sample_rate", 0) or 0)
            channels = int(getattr(stream.codec_context, "channels", 0) or 0)
            return {
                "path": str(path),
                "name": path.name,
                "duration": max(0.0, duration),
                "sampleRate": sample_rate,
                "channels": channels,
            }
    except Exception:
        try:
            import soundfile as sf  # type: ignore
            with sf.SoundFile(str(path)) as audio_file:
                frames = int(audio_file.frames)
                sample_rate = int(audio_file.samplerate)
                duration = frames / sample_rate if sample_rate else 0.0
                return {
                    "path": str(path),
                    "name": path.name,
                    "duration": max(0.0, duration),
                    "sampleRate": sample_rate,
                    "channels": int(audio_file.channels),
                }
        except Exception:
            raise


def _load_audio_mono(path: Path, sample_rate: int = 8000) -> tuple[Any, int]:
    import librosa  # type: ignore

    audio, sr = librosa.load(str(path), sr=sample_rate, mono=True)
    return audio, int(sr)


def _waveform_peaks_soundfile(path: Path, resolution: int) -> tuple[list[float], dict[str, Any]]:
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    with sf.SoundFile(str(path)) as audio_file:
        frames = int(audio_file.frames)
        sample_rate = int(audio_file.samplerate)
        channels = int(audio_file.channels)
        duration = frames / sample_rate if sample_rate else 0.0
        bucket = max(1, math.ceil(max(1, frames) / max(1, resolution)))
        peaks: list[float] = []
        while True:
            block = audio_file.read(bucket, dtype="float32", always_2d=True)
            if block.size == 0:
                break
            peak = float(np.max(np.abs(block))) if block.size else 0.0
            peaks.append(round(peak, 5))
    return peaks, {
        "path": str(path),
        "name": path.name,
        "duration": max(0.0, duration),
        "sampleRate": sample_rate,
        "channels": channels,
    }


def _resample_audio(audio: Any, source_rate: int, target_rate: int) -> Any:
    if source_rate == target_rate:
        return audio
    import librosa  # type: ignore

    return librosa.resample(audio, orig_sr=source_rate, target_sr=target_rate)


def _read_audio(path: Path, target_rate: int | None = None) -> tuple[Any, int]:
    import librosa  # type: ignore

    audio, sr = librosa.load(str(path), sr=target_rate, mono=False)
    import numpy as np  # type: ignore

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio.reshape(1, -1)
    return audio, int(sr)


def _equal_power_fade(length: int, fade_in: bool) -> Any:
    import numpy as np  # type: ignore

    if length <= 0:
        return np.ones((0,), dtype=np.float32)
    curve = np.linspace(0.0, 1.0, num=length, endpoint=True, dtype=np.float32)
    curve = np.sin(curve * math.pi / 2.0)
    return curve if fade_in else curve[::-1]


def _apply_stereo_pan(audio: Any, pan: float) -> Any:
    import numpy as np  # type: ignore

    normalized = max(-1.0, min(1.0, float(pan or 0.0)))
    if abs(normalized) <= 1e-6:
        return audio

    if audio.ndim == 1:
        audio = audio.reshape(1, -1)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)

    left_gain = 1.0 if normalized <= 0 else 1.0 - normalized
    right_gain = 1.0 if normalized >= 0 else 1.0 + normalized

    output = audio.copy()
    output[0] *= left_gain
    output[1] *= right_gain
    return output


def cmd_audio_metadata(payload: dict[str, Any]) -> int:
    path = payload.get("path")
    if not path:
        return emit_error("AUDIO_METADATA_FAILED", "Missing audio path")
    try:
        emit("audio_metadata", _audio_metadata(Path(path)))
        return 0
    except Exception as exc:
        return emit_error("AUDIO_METADATA_FAILED", str(exc), traceback.format_exc())


def cmd_waveform_peaks(payload: dict[str, Any]) -> int:
    path_value = payload.get("path")
    if not path_value:
        return emit_error("WAVEFORM_PEAKS_FAILED", "Missing audio path")
    path = Path(path_value)
    resolution = int(payload.get("resolution") or 1400)
    resolution = max(80, min(12000, resolution))
    cache_dir = Path(payload.get("cacheDir") or path.parent / ".pymss-peaks")
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = hashlib.sha1(str(path.resolve()).encode("utf-8", errors="replace")).hexdigest()[:16]
    cache_name = f"{path.stem}_{cache_key}_{resolution}.json"
    peaks_path = cache_dir / cache_name
    try:
        if peaks_path.is_file() and peaks_path.stat().st_mtime >= path.stat().st_mtime:
            data = json.loads(peaks_path.read_text(encoding="utf-8"))
            emit("waveform_peaks", data)
            return 0

        import numpy as np  # type: ignore

        try:
            peaks, metadata = _waveform_peaks_soundfile(path, resolution)
            sr = int(metadata.get("sampleRate") or 0)
        except Exception:
            audio, sr = _load_audio_mono(path)
            total = int(audio.shape[-1])

            def build_peaks(target_resolution: int) -> list[float]:
                if total <= 0 or target_resolution <= 0:
                    return []
                bucket = max(1, math.ceil(total / target_resolution))
                padded = int(math.ceil(total / bucket) * bucket)
                work = audio
                if padded > total:
                    work = np.pad(audio, (0, padded - total))
                shaped = work.reshape(-1, bucket)
                maxima = np.max(np.abs(shaped), axis=1)
                return [round(float(value), 5) for value in maxima]

            peaks = build_peaks(resolution)
            metadata = _audio_metadata(path)

        data = {
            "path": str(path),
            "peaksPath": str(peaks_path),
            "peaks": peaks,
            "resolution": resolution,
            "duration": metadata.get("duration", 0),
            "sampleRate": metadata.get("sampleRate") or sr,
            "channels": metadata.get("channels", 0),
        }
        peaks_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        emit("waveform_peaks", data)
        return 0
    except Exception as exc:
        return emit_error("WAVEFORM_PEAKS_FAILED", str(exc), traceback.format_exc())


def cmd_export_editor_mix(payload: dict[str, Any]) -> int:
    project = payload.get("project") or {}
    export_dir = Path(payload.get("exportDir") or ".")
    output_format = str(payload.get("format") or "wav").lower()
    audio_params = payload.get("audioParams") or {}
    if output_format not in {"wav", "flac", "mp3", "m4a"}:
        output_format = "wav"
    if not project.get("tracks"):
        return emit_error("EDITOR_EXPORT_FAILED", "Project has no tracks")
    try:
        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore

        export_dir.mkdir(parents=True, exist_ok=True)

        sources: dict[str, dict[str, Any]] = {}
        for collection_name in ("assets", "sources"):
            for item in project.get(collection_name, []) or []:
                source_id = item.get("id")
                if source_id:
                    sources[str(source_id)] = item

        tracks = project.get("tracks", []) or []
        active_tracks = [
            track for track in tracks
            if not track.get("muted") and (track.get("sourceId") or track.get("clips"))
        ]
        has_solo = any(bool(track.get("solo")) for track in active_tracks)
        rendered_clips: list[tuple[int, Any, int]] = []
        audio_cache: dict[str, tuple[Any, int]] = {}
        target_rate: int | None = None
        total_samples = 0

        def source_for_clip(track: dict[str, Any], clip: dict[str, Any]) -> dict[str, Any] | None:
            source_id = clip.get("assetId") or track.get("sourceId")
            if not source_id:
                return None
            return sources.get(str(source_id))

        def track_clips(track: dict[str, Any]) -> list[dict[str, Any]]:
            clips = track.get("clips")
            if isinstance(clips, list) and clips:
                return [clip for clip in clips if isinstance(clip, dict)]

            source_id = track.get("sourceId")
            source = sources.get(str(source_id)) if source_id else None
            source_duration = float(source.get("duration", 0) or 0) if source else 0.0
            return [{
                "id": f"clip_{track.get('id', 'track')}",
                "assetId": source_id,
                "start": 0,
                "offset": 0,
                "duration": source_duration,
                "volume": 1,
                "fadeIn": track.get("fadeIn", 0),
                "fadeOut": track.get("fadeOut", 0),
                "muted": False,
            }]

        def read_source_audio(source: dict[str, Any]) -> tuple[Any, int] | None:
            nonlocal target_rate
            source_id = str(source.get("id") or source.get("path") or "")
            if source_id in audio_cache:
                return audio_cache[source_id]

            path = Path(source.get("path") or "")
            if not path.is_file():
                return None

            audio, sr = _read_audio(path, target_rate)
            if target_rate is None:
                target_rate = sr
            elif sr != target_rate:
                channels = [_resample_audio(channel, sr, target_rate) for channel in audio]
                audio = np.stack(channels, axis=0).astype(np.float32)
                sr = target_rate
            audio_cache[source_id] = (audio, int(sr))
            return audio_cache[source_id]

        for track in active_tracks:
            if has_solo and not track.get("solo"):
                continue

            track_volume = float(track.get("volume", 1.0) or 0)
            track_pan = float(track.get("pan", 0.0) or 0.0)
            if track_volume <= 0:
                continue

            for clip in track_clips(track):
                if clip.get("muted"):
                    continue

                source = source_for_clip(track, clip)
                if not source:
                    continue

                loaded = read_source_audio(source)
                if loaded is None:
                    continue
                audio, sr = loaded

                start = max(0, int(float(clip.get("start", 0) or 0) * sr))
                offset = max(0, int(float(clip.get("offset", 0) or 0) * sr))
                if offset >= audio.shape[-1]:
                    continue

                clip_duration = float(clip.get("duration", 0) or 0)
                duration_samples = int(clip_duration * sr) if clip_duration > 0 else audio.shape[-1] - offset
                duration_samples = max(0, min(duration_samples, audio.shape[-1] - offset))
                if duration_samples <= 0:
                    continue

                segment = audio[:, offset:offset + duration_samples].copy()
                volume = track_volume * float(clip.get("volume", 1.0) or 0)
                if volume <= 0:
                    continue
                segment *= volume
                segment = _apply_stereo_pan(segment, track_pan)

                fade_in_value = clip.get("fadeIn", track.get("fadeIn", 0))
                fade_out_value = clip.get("fadeOut", track.get("fadeOut", 0))
                fade_in_samples = min(duration_samples, int(float(fade_in_value or 0) * sr))
                fade_out_samples = min(duration_samples, int(float(fade_out_value or 0) * sr))
                if fade_in_samples > 0:
                    segment[:, :fade_in_samples] *= _equal_power_fade(fade_in_samples, True)
                if fade_out_samples > 0:
                    segment[:, -fade_out_samples:] *= _equal_power_fade(fade_out_samples, False)

                rendered_clips.append((start, segment, sr))
                total_samples = max(total_samples, start + segment.shape[-1])

        if not rendered_clips or not target_rate or total_samples <= 0:
            return emit_error("EDITOR_EXPORT_FAILED", "No audible clips to export")

        channels = max(segment.shape[0] for _, segment, _ in rendered_clips)
        mix = np.zeros((channels, total_samples), dtype=np.float32)
        for start, segment, _ in rendered_clips:
            if segment.shape[0] == 1 and channels > 1:
                segment = np.repeat(segment, channels, axis=0)
            elif segment.shape[0] < channels:
                pad = np.zeros((channels - segment.shape[0], segment.shape[-1]), dtype=np.float32)
                segment = np.concatenate([segment, pad], axis=0)
            mix[:, start:start + segment.shape[-1]] += segment[:channels]

        master_volume = float(project.get("masterVolume", 1.0) or 0)
        if master_volume != 1.0:
            mix *= master_volume
        master_pan = float(project.get("masterPan", 0.0) or 0.0)
        mix = _apply_stereo_pan(mix, master_pan)

        peak = float(np.max(np.abs(mix))) if mix.size else 0.0
        if peak > 1.0:
            mix = mix / peak * 0.98

        project_name = str(project.get("name") or project.get("id") or "editor_mix")
        safe_name = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in project_name).strip("_") or "editor_mix"
        output_path = export_dir / f"{safe_name}_mix.{output_format}"
        subtype = None
        if output_format == "wav":
            requested = str(audio_params.get("wav_bit_depth") or audio_params.get("wavBitDepth") or "PCM_24").upper()
            subtype = requested if requested in {"PCM_16", "PCM_24", "FLOAT"} else "PCM_24"
        elif output_format == "flac":
            requested = str(audio_params.get("flac_bit_depth") or audio_params.get("flacBitDepth") or "PCM_24").upper()
            subtype = requested if requested in {"PCM_16", "PCM_24"} else "PCM_24"
        elif output_format in {"mp3", "m4a"}:
            output_path = output_path.with_suffix(".wav")
            output_format = "wav"
            requested = str(audio_params.get("wav_bit_depth") or audio_params.get("wavBitDepth") or "PCM_24").upper()
            subtype = requested if requested in {"PCM_16", "PCM_24", "FLOAT"} else "PCM_24"

        write_kwargs: dict[str, Any] = {}
        if subtype:
            write_kwargs["subtype"] = subtype
        sf.write(str(output_path), mix.T, target_rate, **write_kwargs)
        emit("editor_mix_exported", {
            "path": str(output_path),
            "duration": total_samples / target_rate,
            "sampleRate": target_rate,
            "channels": channels,
            "format": output_path.suffix.lstrip("."),
        })
        return 0
    except Exception as exc:
        return emit_error("EDITOR_EXPORT_FAILED", str(exc), traceback.format_exc())

