from pathlib import Path
from typing import List, Dict

import numpy as np
import torch
import torch.nn.functional as F


def decode_gaussian_blurred_probs(probs, vmin, vmax, deviation, threshold):
    num_bins = probs.shape[-1]
    interval = (vmax - vmin) / (num_bins - 1)
    width = int(3 * deviation / interval)  # 3 * sigma
    idx = torch.arange(num_bins, device=probs.device)[None, None, :]  # [1, 1, N]
    idx_values = idx * interval + vmin
    center = torch.argmax(probs, dim=-1, keepdim=True)  # [B, T, 1]
    start = torch.clip(center - width, min=0)  # [B, T, 1]
    end = torch.clip(center + width + 1, max=num_bins)  # [B, T, 1]
    idx_masks = (idx >= start) & (idx < end)  # [B, T, N]
    weights = probs * idx_masks  # [B, T, N]
    product_sum = torch.sum(weights * idx_values, dim=2)  # [B, T]
    weight_sum = torch.sum(weights, dim=2)  # [B, T]
    values = product_sum / (weight_sum + (weight_sum == 0))  # avoid dividing by zero, [B, T]
    rest = probs.max(dim=-1)[0] < threshold  # [B, T]
    return values, rest


def decode_bounds_to_alignment(bounds):
    bounds_step = bounds.cumsum(dim=1).round().long()
    bounds_inc = torch.diff(
        bounds_step, dim=1, prepend=torch.full(
            (bounds.shape[0], 1), fill_value=-1,
            dtype=bounds_step.dtype, device=bounds_step.device
        )
    ) > 0
    frame2item = bounds_inc.long().cumsum(dim=1)
    return frame2item


def decode_note_sequence(frame2item, values, masks, threshold=0.5):
    """

    :param frame2item: [1, 1, 1, 1, 2, 2, 3, 3, 3]
    :param values:
    :param masks:
    :param threshold: minimum ratio of unmasked frames required to be regarded as an unmasked item
    :return: item_values, item_dur, item_masks
    """
    b = frame2item.shape[0]
    space = frame2item.max() + 1

    item_dur = frame2item.new_zeros(b, space).scatter_add(
        1, frame2item, torch.ones_like(frame2item)
    )[:, 1:]
    item_unmasked_dur = frame2item.new_zeros(b, space).scatter_add(
        1, frame2item, masks.long()
    )[:, 1:]
    item_masks = item_unmasked_dur / item_dur >= threshold

    values_quant = values.round().long().clamp(0, 127)
    histogram = frame2item.new_zeros(b, space * 128).scatter_add(
        1, frame2item * 128 + values_quant, torch.ones_like(frame2item) * masks
    ).unflatten(1, [space, 128])[:, 1:, :]
    item_values_center = histogram.argmax(dim=2).to(dtype=values.dtype)
    values_center = torch.gather(F.pad(item_values_center, [1, 0]), 1, frame2item)
    values_near_center = masks & (values >= values_center - 0.5) & (values <= values_center + 0.5)
    item_valid_dur = frame2item.new_zeros(b, space).scatter_add(
        1, frame2item, values_near_center.long()
    )[:, 1:]
    item_values = values.new_zeros(b, space).scatter_add(
        1, frame2item, values * values_near_center
    )[:, 1:] / (item_valid_dur + (item_valid_dur == 0))

    return item_values, item_dur, item_masks


def _encode_variable_length(value: int) -> bytes:
    value = max(0, int(value))
    encoded = [value & 0x7F]
    value >>= 7
    while value:
        encoded.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(encoded))


class StandardMidiFile:
    """Minimal type-0 Standard MIDI File used by SOME inference output."""

    def __init__(self, track: bytes, ticks_per_beat: int = 480):
        self.track = track
        self.ticks_per_beat = ticks_per_beat

    def save(self, path: str | Path) -> None:
        header = b'MThd' + (6).to_bytes(4, 'big') + (0).to_bytes(2, 'big')
        header += (1).to_bytes(2, 'big') + self.ticks_per_beat.to_bytes(2, 'big')
        track = self.track + b'\x00\xff\x2f\x00'
        Path(path).write_bytes(header + b'MTrk' + len(track).to_bytes(4, 'big') + track)


def build_midi_file(
    offsets: List[float],
    segments: List[Dict[str, np.ndarray]],
    tempo=120,
) -> StandardMidiFile:
    tempo_microseconds = max(1, round(60_000_000 / float(tempo)))
    track = bytearray(b'\x00\xff\x51\x03' + tempo_microseconds.to_bytes(3, 'big'))
    last_time = 0
    offsets = [round(o * tempo * 8) for o in offsets]
    for i, (offset, segment) in enumerate(zip(offsets, segments)):
        note_midi = np.round(segment['note_midi']).astype(np.int64).tolist()
        note_tick = np.diff(np.round(np.cumsum(segment['note_dur']) * tempo * 8).astype(np.int64), prepend=0).tolist()
        note_rest = segment['note_rest'].tolist()
        start = offset
        for j in range(len(note_midi)):
            end = start + note_tick[j]
            if i < len(offsets) - 1 and end > offsets[i + 1]:
                end = offsets[i + 1]
            if start < end and not note_rest[j]:
                note = max(0, min(127, int(note_midi[j])))
                track.extend(_encode_variable_length(start - last_time))
                track.extend((0x90, note, 64))
                track.extend(_encode_variable_length(end - start))
                track.extend((0x80, note, 64))
                last_time = end
            start = end
    return StandardMidiFile(bytes(track))
