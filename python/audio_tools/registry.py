from __future__ import annotations

from typing import Any, Callable

from .asr import _transcribe_audio
from .convert import _convert_audio
from .inspect import _inspect_audio
from .merge import _merge_audio
from .midi import _vocal_to_midi
from .sdr import _calculate_sdr
from .slicer import _slice_audio

AudioToolHandler = Callable[[dict[str, Any]], dict[str, Any]]

_HANDLERS: dict[str, AudioToolHandler] = {
    "convert": _convert_audio,
    "merge": _merge_audio,
    "sdr": _calculate_sdr,
    "midi": _vocal_to_midi,
    "inspect": _inspect_audio,
    "slicer": _slice_audio,
    "asr": _transcribe_audio,
}


def get_audio_tool_handler(operation: str) -> AudioToolHandler | None:
    return _HANDLERS.get(operation)
