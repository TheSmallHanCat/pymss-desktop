from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

import worker_tools
from some.utils.infer_utils import build_midi_file


class WorkerToolsTests(unittest.TestCase):
    def test_mp3_and_ogg_bitrate_capabilities_are_distinct(self) -> None:
        self.assertNotIn("450k", worker_tools.MP3_BIT_RATES)
        self.assertIn("450k", worker_tools.OGG_BIT_RATES)

    def test_conversion_command_uses_argument_list_and_requested_codec(self) -> None:
        command = worker_tools._build_conversion_command(
            Path("input with spaces.wav"),
            Path("output with spaces.wav"),
            "wav",
            48000,
            1,
            "PCM-24",
            "16-bit",
            "320k",
            "320k",
        )

        self.assertEqual(command[:2], ["-i", "input with spaces.wav"])
        self.assertIn("pcm_s24le", command)
        self.assertEqual(command[-1], "output with spaces.wav")

    def test_audio_files_in_folder_is_filtered_and_case_insensitive_sorted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            folder = Path(temp_value)
            (folder / "B.wav").write_bytes(b"")
            (folder / "a.FLAC").write_bytes(b"")
            (folder / "notes.txt").write_text("ignore", encoding="utf-8")

            result = worker_tools._audio_files_in_folder(folder)

        self.assertEqual([path.name for path in result], ["a.FLAC", "B.wav"])

    def test_calculate_sdr_arrays_returns_per_channel_and_average_values(self) -> None:
        reference = np.array([[1.0, -1.0, 0.5], [0.5, -0.5, 1.0]])
        estimated = reference * 0.9

        sdr, average_sdr, si_sdr, average_si_sdr = worker_tools._calculate_sdr_arrays(
            reference,
            estimated,
        )

        self.assertEqual(len(sdr), 2)
        self.assertEqual(len(si_sdr), 2)
        self.assertGreater(average_sdr, 10)
        self.assertGreater(average_si_sdr, average_sdr)

    def test_available_path_does_not_overwrite_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            output = Path(temp_value) / "result.wav"
            output.write_bytes(b"existing")

            candidate = worker_tools._available_path(output)

        self.assertEqual(candidate.name, "result_2.wav")

    def test_some_midi_writer_outputs_standard_midi_file(self) -> None:
        segment = {
            "note_midi": np.array([60.0]),
            "note_dur": np.array([0.5]),
            "note_rest": np.array([False]),
        }
        midi = build_midi_file([0.0], [segment], tempo=120)
        with tempfile.TemporaryDirectory() as temp_value:
            output = Path(temp_value) / "vocal.mid"
            midi.save(output)
            content = output.read_bytes()

        self.assertTrue(content.startswith(b"MThd"))
        self.assertIn(b"MTrk", content)
        self.assertTrue(content.endswith(b"\x00\xff\x2f\x00"))


if __name__ == "__main__":
    unittest.main()
