from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from worker_infer import apply_output_naming, collect_changed_files, collect_outputs, snapshot_output_files


class OutputNamingTests(unittest.TestCase):
    def test_collect_outputs_excludes_unchanged_stale_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "song_instrument.wav"
            stale.write_bytes(b"stale")
            baseline = snapshot_output_files(str(root), "wav")

            vocals = root / "song_vocals.wav"
            instrumental = root / "song_Instrumental.wav"
            vocals.write_bytes(b"vocals")
            instrumental.write_bytes(b"instrumental")

            outputs = collect_outputs(str(root), ["song.wav"], "wav", baseline)

            self.assertEqual([Path(item["path"]).name for item in outputs], [
                "song_Instrumental.wav",
                "song_vocals.wav",
            ])

    def test_collect_changed_files_excludes_unchanged_stale_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "stale.wav"
            stale.write_bytes(b"stale")
            baseline = snapshot_output_files(str(root), "wav")
            fresh = root / "fresh.wav"
            fresh.write_bytes(b"fresh")

            self.assertEqual(collect_changed_files(str(root), baseline), [str(fresh)])

    def test_template_renames_outputs_in_configured_stem_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vocals = root / "song_vocals.wav"
            drums = root / "song_drums.wav"
            vocals.write_bytes(b"vocals")
            drums.write_bytes(b"drums")

            outputs = apply_output_naming(
                [
                    {"stem": "vocals", "path": str(vocals)},
                    {"stem": "drums", "path": str(drums)},
                ],
                {
                    "enabled": True,
                    "template": "%index%_%filename%_%stem%",
                    "stemOrder": ["drums", "vocals"],
                },
                input_path=str(root / "song.mp3"),
                input_index=1,
                model="model-a",
                output_format="wav",
            )

            self.assertEqual([Path(item["path"]).name for item in outputs], [
                "01_song_drums.wav",
                "02_song_vocals.wav",
            ])
            self.assertTrue((root / "01_song_drums.wav").is_file())
            self.assertTrue((root / "02_song_vocals.wav").is_file())
            self.assertFalse(drums.exists())
            self.assertFalse(vocals.exists())

    def test_collect_outputs_preserves_stem_underscores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "song_lead_vocals.wav"
            output.write_bytes(b"vocals")

            outputs = collect_outputs(str(root), ["song.wav"], "wav")

            self.assertEqual(outputs[0]["stem"], "lead_vocals")

    def test_input_number_and_invalid_filename_chars_are_supported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song_vocals.wav"
            source.write_bytes(b"vocals")

            outputs = apply_output_naming(
                [{"stem": "lead/vocal", "path": str(source)}],
                {
                    "enabled": True,
                    "template": "%input_number%_%filename%_%stem%_%model%",
                    "stemOrder": [],
                },
                input_path=str(root / "demo:mix.flac"),
                input_index=12,
                model="model:bad",
                output_format="wav",
            )

            self.assertEqual(Path(outputs[0]["path"]).name, "12_demo_mix_lead_vocal_model_bad.wav")
            self.assertTrue((root / "12_demo_mix_lead_vocal_model_bad.wav").is_file())

    def test_cross_platform_filename_rules_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song_vocals.wav"
            source.write_bytes(b"vocals")

            outputs = apply_output_naming(
                [{"stem": "CON", "path": str(source)}],
                {
                    "enabled": True,
                    "template": "bad:name<>|?* %stem% .",
                    "stemOrder": [],
                },
                input_path=str(root / "demo.wav"),
                output_format="wav",
            )

            self.assertEqual(Path(outputs[0]["path"]).name, "bad_name_CON.wav")
            self.assertTrue((root / "bad_name_CON.wav").is_file())

    def test_windows_reserved_filename_is_avoided(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song_vocals.wav"
            source.write_bytes(b"vocals")

            outputs = apply_output_naming(
                [{"stem": "vocals", "path": str(source)}],
                {"enabled": True, "template": "CON", "stemOrder": []},
                input_path=str(root / "demo.wav"),
                output_format="wav",
            )

            self.assertEqual(Path(outputs[0]["path"]).name, "CON_.wav")
            self.assertTrue((root / "CON_.wav").is_file())

    def test_windows_reserved_filename_with_extension_is_avoided(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song_vocals.wav"
            source.write_bytes(b"vocals")

            outputs = apply_output_naming(
                [{"stem": "vocals", "path": str(source)}],
                {"enabled": True, "template": "CON.txt", "stemOrder": []},
                input_path=str(root / "demo.wav"),
                output_format="wav",
            )

            self.assertEqual(Path(outputs[0]["path"]).name, "CON.txt_.wav")
            self.assertTrue((root / "CON.txt_.wav").is_file())

    def test_disabled_config_leaves_outputs_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song_vocals.wav"
            source.write_bytes(b"vocals")

            outputs = [{"stem": "vocals", "path": str(source)}]
            result = apply_output_naming(
                outputs,
                {"enabled": False, "template": "%index%_%stem%", "stemOrder": ["vocals"]},
                input_path=str(root / "song.wav"),
            )

            self.assertEqual(result, outputs)
            self.assertTrue(source.is_file())


if __name__ == "__main__":
    unittest.main()
