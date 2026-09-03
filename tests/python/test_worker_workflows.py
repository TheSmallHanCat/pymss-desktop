from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

from worker_workflows import (
    _prepare_legacy_global_input,
    _prepare_simple_runtime_definition,
    _finalize_simple_output_paths,
    _render_simple_filename,
    _simple_output_names,
    _workflow_output_stem,
)


class LegacyWorkflowInputTests(unittest.TestCase):
    def test_legacy_placeholder_is_bound_to_global_input_without_mutating_definition(self) -> None:
        definition = {
            "nodes": [
                {"id": 1, "type": "pymss_load_audio", "widgets_values": ["input.wav", ""]},
                {"id": 2, "type": "pymss_load_audio", "widgets_values": ["", None]},
            ],
        }
        payload = {"workflow": definition}

        transient, inputs = _prepare_legacy_global_input(payload, "D:/Audio/song.wav", None)

        self.assertEqual(inputs, {"input.wav": "D:/Audio/song.wav"})
        self.assertEqual(definition["nodes"][1]["widgets_values"], ["", None])
        self.assertEqual(transient["workflow"]["nodes"][0]["widgets_values"], ["D:/Audio/song.wav", ""])
        self.assertEqual(transient["workflow"]["nodes"][1]["widgets_values"], ["D:/Audio/song.wav", None])

    def test_embedded_audio_paths_are_overridden_by_the_global_input(self) -> None:
        payload = {
            "workflow": {
                "nodes": [{"id": 1, "type": "pymss_load_audio", "widgets_values": ["D:/old/song.wav", None]}],
            },
        }

        transient, inputs = _prepare_legacy_global_input(payload, "D:/Audio/new.wav", None)

        self.assertEqual(inputs, {"D:/old/song.wav": "D:/Audio/new.wav"})
        self.assertEqual(
            transient["workflow"]["nodes"][0]["widgets_values"],
            ["D:/Audio/new.wav", None],
        )

    def test_named_slots_are_bound_to_the_global_file_after_ui_rollback(self) -> None:
        payload = {
            "workflow": {
                "nodes": [{"id": 1, "type": "pymss_load_audio", "widgets_values": ["input.wav", "lead"]}],
            },
        }

        _transient, inputs = _prepare_legacy_global_input(payload, "D:/Audio/song.wav", {"lead": "old.wav"})

        self.assertEqual(inputs, {"lead": "D:/Audio/song.wav"})

    def test_legacy_batch_nodes_get_a_transient_global_input_slot(self) -> None:
        payload = {
            "workflow": {
                "nodes": [{"id": 1, "type": "pymss_load_audio_batch", "widgets_values": ["old-folder", False, True]}],
            },
        }

        transient, inputs = _prepare_legacy_global_input(payload, "D:/Audio/song.wav", None)

        self.assertEqual(inputs, {"__pymss_studio_global_input__": "D:/Audio/song.wav"})
        self.assertEqual(
            transient["workflow"]["nodes"][0]["widgets_values"],
            ["old-folder", False, True, "__pymss_studio_global_input__"],
        )

    def test_yaml_workflows_keep_the_original_payload_and_inputs(self) -> None:
        payload = {"workflow": {"steps": [{"id": "one", "input": "input"}]}}

        transient, inputs = _prepare_legacy_global_input(payload, "D:/Audio/song.wav", None)

        self.assertIs(transient, payload)
        self.assertEqual(inputs, {})


class WorkflowOutputMetadataTests(unittest.TestCase):
    def test_simple_filename_metadata_is_detected_and_runtime_copy_is_flat(self) -> None:
        definition = {
            "version": 1,
            "defaults": {"output_format": "flac"},
            "steps": [{
                "id": "split",
                "save": {"vocals": "vocals"},
                "output_names": {"vocals": "lead"},
            }],
        }
        self.assertTrue(_simple_output_names(definition))
        runtime = _prepare_simple_runtime_definition(definition)
        self.assertEqual(runtime["steps"][0]["save"], {"vocals": "Default"})
        self.assertEqual(runtime["steps"][0]["output_format"], "flac")
        self.assertEqual(definition["steps"][0]["save"]["vocals"], "vocals")

    def test_empty_filename_metadata_does_not_change_directory_outputs(self) -> None:
        definition = {
            "version": 1,
            "steps": [{"id": "split", "save": {"vocals": "vocals"}, "output_names": {}}],
        }
        self.assertFalse(_simple_output_names(definition))
        self.assertIs(_prepare_simple_runtime_definition(definition), definition)

    def test_editor_layout_metadata_is_removed_from_runtime_definition(self) -> None:
        definition = {
            "version": 1,
            "studio": {"editor": "simple", "viewport": {"x": 0, "y": 0, "zoom": 1}},
            "steps": [{"id": "split", "save": {"vocals": "vocals"}}],
        }
        runtime = _prepare_simple_runtime_definition(definition)
        self.assertNotIn("studio", runtime)
        self.assertIn("studio", definition)
        self.assertIsNot(runtime, definition)

    def test_intermediate_outputs_follow_explicit_save_links(self) -> None:
        definition = {
            "version": 1,
            "save_intermediate": False,
            "steps": [
                {"id": "first", "input": "input", "save": {"vocals": "Default", "music": "Default"}},
                {"id": "second", "input": "first.vocals", "save": {"clean": "Default"}},
            ],
        }
        runtime = _prepare_simple_runtime_definition(definition)
        self.assertEqual(runtime["steps"][0]["save"], {"vocals": "Default", "music": "Default"})
        self.assertNotIn("save_intermediate", runtime)
        self.assertEqual(definition["steps"][0]["save"]["vocals"], "Default")

    def test_simple_filename_template_renders_tokens_and_extension(self) -> None:
        self.assertEqual(
            _render_simple_filename(
                "%filename%_%stem%_%model%.wav",
                input_path="D:/Audio/song.mp3",
                stem="vocals",
                model="model.pth",
                step_id="split",
                index=1,
                output_format="flac",
            ),
            "song_vocals_model.flac",
        )
        self.assertEqual(
            _render_simple_filename(
                "%filename%_%stem%_%model%",
                input_path="D:/Audio/小蓝背心 - 灯火通明.mp3",
                stem="Instrumental",
                model="melband_roformer_instvox_duality_v2.ckpt",
                step_id="step1",
                index=1,
                output_format="wav",
            ),
            "小蓝背心 - 灯火通明_Instrumental_melband_roformer_instvox_duality_v2.wav",
        )

    def test_simple_output_paths_restore_unicode_names_after_graph_sanitizing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            generated = output_dir / "pymss_studio_0001.wav"
            generated.write_bytes(b"audio")
            finalized = _finalize_simple_output_paths(
                [str(generated)],
                [{"stem": "Instrumental", "filename": "小蓝背心 - 灯火通明_Instrumental_model.wav"}],
                output_dir,
            )
            self.assertEqual(finalized, [str(output_dir / "小蓝背心 - 灯火通明_Instrumental_model.wav")])
            self.assertTrue(Path(finalized[0]).is_file())
            self.assertFalse(generated.exists())

    def test_output_stem_matches_single_separation_for_prefixed_filename(self) -> None:
        self.assertEqual(
            _workflow_output_stem("D:/results/song/song_vocals.wav", "D:/Audio/song.wav"),
            "vocals",
        )

    def test_output_stem_keeps_unprefixed_filename(self) -> None:
        self.assertEqual(
            _workflow_output_stem("D:/results/vocals.wav", "D:/Audio/song.wav"),
            "vocals",
        )

    def test_output_stem_handles_windows_separators(self) -> None:
        self.assertEqual(
            _workflow_output_stem(r"D:\\results\\song\\song_vocals.wav", r"D:\\Audio\\song.wav"),
            "vocals",
        )

    def test_output_stem_supports_graphs_without_primary_input(self) -> None:
        self.assertEqual(_workflow_output_stem("D:/results/custom_mix.wav"), "custom_mix")


if __name__ == "__main__":
    unittest.main()
