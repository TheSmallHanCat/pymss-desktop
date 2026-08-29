from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from threading import Lock
from unittest import mock

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

import worker_infer
from worker_infer import (
    _claim_output_path,
    _studio_separator_type,
    apply_output_naming,
    collect_changed_files,
    collect_outputs,
    snapshot_output_files,
)


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

    def test_separator_writes_the_template_name_without_touching_the_default_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            renamed_result = root / "song_vocals.wav"
            renamed_result.write_bytes(b"keep")

            separator = object.__new__(_studio_separator_type())
            separator.output_format = "wav"
            separator._studio_naming = {
                "enabled": True,
                "template": "%index%_%filename%_%stem%",
                "stem_order": ["vocals"],
            }
            separator._studio_output_model = "model-a"
            separator._studio_output_lock = Lock()
            separator._studio_claimed_paths = set()
            separator._studio_last_outputs = []
            separator._studio_input_path = str(root / "song.mp3")
            separator._studio_input_index = 1
            separator._studio_now = worker_infer.datetime(2026, 8, 18, 2, 49, 0)
            separator._studio_stem_indices = {"vocals": 0}

            def save_audio(_audio, _sr, file_name, store_dir):
                Path(store_dir, f"{file_name}.wav").write_bytes(b"new")

            separator.save_audio = save_audio
            separator._save_output("vocals", object(), 44100, "song", str(root))

            self.assertEqual(renamed_result.read_bytes(), b"keep")
            target = root / "01_song_vocals.wav"
            self.assertEqual(target.read_bytes(), b"new")
            self.assertEqual(separator.studio_outputs(), [{"stem": "vocals", "path": str(target)}])

    def test_separator_adds_a_suffix_before_writing_over_a_template_collision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            existing = root / "01_song_vocals.wav"
            existing.write_bytes(b"keep")

            separator = object.__new__(_studio_separator_type())
            separator.output_format = "wav"
            separator._studio_naming = {
                "enabled": True,
                "template": "%index%_%filename%_%stem%",
                "stem_order": ["vocals"],
            }
            separator._studio_output_model = "model-a"
            separator._studio_output_lock = Lock()
            separator._studio_claimed_paths = set()
            separator._studio_last_outputs = []
            separator._studio_input_path = str(root / "song.mp3")
            separator._studio_input_index = 1
            separator._studio_now = worker_infer.datetime(2026, 8, 18, 2, 49, 0)
            separator._studio_stem_indices = {"vocals": 0}
            separator.save_audio = lambda _audio, _sr, file_name, store_dir: Path(store_dir, f"{file_name}.wav").write_bytes(b"new")

            separator._save_output("vocals", object(), 44100, "song", str(root))

            self.assertEqual(existing.read_bytes(), b"keep")
            self.assertEqual((root / "01_song_vocals_2.wav").read_bytes(), b"new")

    def test_claimed_path_skips_an_existing_output_without_racing_to_overwrite_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = root / "song_vocals.wav"
            original.write_bytes(b"keep")

            claimed = _claim_output_path(original)

            self.assertEqual(claimed.name, "song_vocals_2.wav")
            self.assertEqual(original.read_bytes(), b"keep")
            self.assertTrue(claimed.is_file())

    def test_separator_releases_its_placeholder_when_audio_encoding_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            separator = object.__new__(_studio_separator_type())
            separator.output_format = "wav"
            separator._studio_naming = {
                "enabled": True,
                "template": "%index%_%filename%_%stem%",
                "stem_order": ["vocals"],
            }
            separator._studio_output_model = "model-a"
            separator._studio_output_lock = Lock()
            separator._studio_claimed_paths = set()
            separator._studio_last_outputs = []
            separator._studio_input_path = str(root / "song.mp3")
            separator._studio_input_index = 1
            separator._studio_now = worker_infer.datetime(2026, 8, 18, 2, 49, 0)
            separator._studio_stem_indices = {"vocals": 0}

            def fail_save(*_args):
                raise RuntimeError("encoder failed")

            separator.save_audio = fail_save

            with self.assertRaisesRegex(RuntimeError, "encoder failed"):
                separator._save_output("vocals", object(), 44100, "song", str(root))

            self.assertFalse((root / "01_song_vocals.wav").exists())
            self.assertEqual(separator.studio_outputs(), [])

    def test_folder_processing_keeps_prior_outputs_when_a_later_input_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first.wav"
            second = root / "second.wav"
            first.write_bytes(b"input")
            second.write_bytes(b"input")

            with mock.patch.object(worker_infer, "ThreadPoolExecutor"), \
                 mock.patch("pymss.load_audio", side_effect=[("first", 44100), ("second", 44100)]):
                separator = object.__new__(_studio_separator_type())
                separator.config = mock.Mock(audio={"sample_rate": 44100})
                separator.logger = mock.Mock()
                separator._studio_last_outputs = []
                separator._studio_stem_indices = {"vocals": 0}
                separator._start_output_capture = mock.Mock()
                separator._stem_batches_to_save = mock.Mock(return_value=[["vocals"]])
                separator._submit_save_outputs = mock.Mock(return_value=[])
                separator._wait_save_futures = mock.Mock(return_value=True)

                def separate(mix, **_kwargs):
                    if mix == "second":
                        raise RuntimeError("second input failed")
                    separator._studio_last_outputs.append({"stem": "vocals", "path": str(root / "first_vocals.wav")})
                    return {"vocals": object()}

                separator.separate = separate
                success_files = separator.process_folder(str(root))

            self.assertEqual(success_files, ["first.wav"])
            self.assertEqual(separator.studio_outputs(), [{"stem": "vocals", "path": str(root / "first_vocals.wav")}])

    def test_folder_processing_removes_partial_outputs_when_a_stem_save_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "song.wav"
            source.write_bytes(b"input")
            first_output = root / "song_vocals.wav"
            first_output.write_bytes(b"incomplete")

            with mock.patch("pymss.load_audio", return_value=("song", 44100)):
                separator = object.__new__(_studio_separator_type())
                separator.config = mock.Mock(audio={"sample_rate": 44100})
                separator.logger = mock.Mock()
                separator._studio_last_outputs = []
                separator._studio_claimed_paths = set()
                separator._studio_stem_indices = {"vocals": 0}
                separator._start_output_capture = mock.Mock()
                separator._stem_batches_to_save = mock.Mock(return_value=[["vocals"], ["instrumental"]])
                separator._submit_save_outputs = mock.Mock(return_value=[])
                separator._wait_save_futures = mock.Mock(side_effect=[True, False])

                def separate(_mix, **_kwargs):
                    if not separator._studio_last_outputs:
                        separator._studio_last_outputs.append({"stem": "vocals", "path": str(first_output)})
                        separator._studio_claimed_paths.add(first_output)
                    return {"vocals": object()}

                separator.separate = separate

                success_files = separator.process_folder(str(source))

            self.assertEqual(success_files, [])
            self.assertFalse(first_output.exists())
            self.assertEqual(separator.studio_outputs(), [])
            self.assertNotIn(first_output, separator._studio_claimed_paths)


if __name__ == "__main__":
    unittest.main()
