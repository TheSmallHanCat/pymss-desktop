from __future__ import annotations

import unittest

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

from worker_workflows import _prepare_legacy_global_input, _workflow_output_stem


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
