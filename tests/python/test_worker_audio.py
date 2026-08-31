from __future__ import annotations

import unittest
import tempfile
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

from worker_audio import _apply_track_effects, cmd_export_editor_mix


class EditorEffectTests(unittest.TestCase):
    def test_disabled_effects_leave_audio_unchanged(self) -> None:
        audio = np.array([[0.1, -0.2, 0.3]], dtype=np.float32)
        rendered = _apply_track_effects(audio, {}, 1000)
        np.testing.assert_array_equal(rendered, audio)

    def test_echo_preserves_channels_and_adds_a_tail(self) -> None:
        audio = np.zeros((2, 10), dtype=np.float32)
        audio[:, 0] = 1.0
        rendered = _apply_track_effects(audio, {"delay": 1, "delayTime": 0.1}, 1000)
        self.assertEqual(rendered.shape, (2, 510))
        self.assertGreater(float(np.abs(rendered[:, 100:]).max()), 0.0)

    def test_compressor_reduces_large_peaks(self) -> None:
        audio = np.ones((1, 32), dtype=np.float32)
        rendered = _apply_track_effects(audio, {"compressor": 1}, 1000)
        self.assertLess(float(np.max(np.abs(rendered))), 1.0)

    def test_editor_export_passes_track_effects_to_the_rendered_mix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "source.wav"
            samples = np.zeros(200, dtype=np.float32)
            samples[0] = 1.0
            sf.write(source, samples, 1000)
            payload = {
                "project": {
                    "id": "project",
                    "name": "effects",
                    "masterVolume": 1,
                    "masterPan": 0,
                    "assets": [{
                        "id": "source",
                        "path": str(source),
                        "duration": 0.2,
                        "sampleRate": 1000,
                        "channels": 1,
                    }],
                    "tracks": [{
                        "id": "track",
                        "sourceId": "source",
                        "volume": 1,
                        "pan": 0,
                        "muted": False,
                        "solo": False,
                        "effects": {"reverb": 0, "delay": 1, "delayTime": 0.1},
                        "clips": [{
                            "assetId": "source",
                            "start": 0,
                            "offset": 0,
                            "duration": 0.2,
                            "volume": 1,
                            "fadeIn": 0,
                            "fadeOut": 0,
                            "muted": False,
                        }],
                    }],
                },
                "exportDir": str(root / "output"),
                "format": "wav",
            }
            with mock.patch("worker_audio.emit"):
                self.assertEqual(cmd_export_editor_mix(payload), 0)
            rendered, sample_rate = sf.read(str(root / "output" / "effects_mix.wav"))

        self.assertEqual(sample_rate, 1000)
        self.assertGreater(len(rendered), len(samples))


if __name__ == "__main__":
    unittest.main()
