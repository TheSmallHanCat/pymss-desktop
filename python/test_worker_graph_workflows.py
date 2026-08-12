"""Safety net for the graph workflow engine.

Covers the pure parts — validation and execution ordering — without touching torch, audio, or
pymss. Those are what a later refactor is most likely to disturb, and they decide whether a
workflow runs at all.
"""

import json
import re
import unittest
from pathlib import Path

import worker_graph_workflows as gw

CORPUS_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "workflow-validation.json"

# Maps a runtime rejection message onto the shared rule vocabulary. Kept in the test rather than
# in the engine so the production error text stays untouched; if a message is reworded, this
# table is what fails and points at the corpus that needs updating.
_MESSAGE_RULES: tuple[tuple[str, str], ...] = (
    (r"missing the input node", "missing_core_node"),
    (r"missing the save outputs node", "missing_core_node"),
    (r"dangling connection", "dangling_connection"),
    (r"source port", "invalid_port"),
    (r"target port", "invalid_port"),
    (r"duplicate connections", "duplicate_input"),
    (r"unconnected utility inputs", "utility_input_missing"),
    (r"no saved outputs", "no_save_outputs"),
    (r"cycle", "cycle"),
)


def rule_code_for(message: str) -> str:
    for pattern, code in _MESSAGE_RULES:
        if re.search(pattern, message):
            return code
    raise AssertionError(f"unmapped runtime rejection: {message!r}")


def node(node_id, node_type, x=0.0, y=0.0, **data):
    return {"id": node_id, "type": node_type, "position": {"x": x, "y": y}, "data": data}


def edge(source_id, source_port, target_id, target_port, edge_id=None):
    return {
        "id": edge_id or f"{source_id}:{source_port}->{target_id}:{target_port}",
        "source": {"nodeId": source_id, "portId": source_port},
        "target": {"nodeId": target_id, "portId": target_port},
    }


def chain(step_count, stems=("vocals", "instrument")):
    """A linear input -> step_1 -> ... -> save graph, matching what the editor emits."""
    nodes = {
        "input": node("input", "input_audio"),
        "save": node("save", "save_outputs", x=1000.0, outputs={}),
    }
    edges = []
    previous, previous_port = "input", "audio"
    for index in range(step_count):
        step_id = f"step_{index + 1}"
        nodes[step_id] = node(step_id, "separate", x=200.0 + index * 200, model=f"m{index}.ckpt", stems=list(stems))
        edges.append(edge(previous, previous_port, step_id, "input"))
        previous, previous_port = step_id, f"stem:{stems[0]}"
    edges.append(edge(previous, previous_port, "save", f"save:{previous}.{stems[0]}"))
    return nodes, edges


class GraphDetectionTests(unittest.TestCase):
    def test_a_graph_definition_is_recognised(self):
        self.assertTrue(gw.is_graph_workflow_definition(
            {"kind": "pymss-studio-graph", "version": 2, "graph": {"nodes": [], "edges": []}}
        ))

    def test_legacy_and_malformed_definitions_are_not(self):
        # The dispatcher in worker_workflows.py routes on this, so a false positive would send a
        # legacy workflow into the graph engine.
        for value in (None, {}, [], "text", {"version": 1, "steps": []}, {"kind": "pymss-studio-graph"}):
            self.assertFalse(gw.is_graph_workflow_definition(value), value)

    def test_the_version_is_part_of_the_check(self):
        # Asymmetry with the frontend, pinned so it is visible: isWorkflowGraphDefinition() in
        # workflowGraph.ts accepts on kind + graph alone, while this side also demands version 2.
        # Saved definitions always carry version 2, so the two agree in practice — but a
        # hand-edited file would be a graph to the editor and legacy to the runtime.
        self.assertFalse(gw.is_graph_workflow_definition(
            {"kind": "pymss-studio-graph", "graph": {"nodes": [], "edges": []}}
        ))


class ValidationTests(unittest.TestCase):
    """The runtime refuses to start on these, so each message is what the user ends up seeing."""

    def test_a_complete_graph_validates(self):
        nodes, edges = chain(2)
        gw._validate_graph_definition(nodes, edges)  # must not raise

    def test_a_graph_without_an_input_node_is_rejected(self):
        nodes, edges = chain(1)
        nodes.pop("input")
        with self.assertRaisesRegex(ValueError, "input node"):
            gw._validate_graph_definition(nodes, edges)

    def test_a_graph_without_a_save_node_is_rejected(self):
        nodes, edges = chain(1)
        nodes.pop("save")
        with self.assertRaisesRegex(ValueError, "save outputs node"):
            gw._validate_graph_definition(nodes, edges)

    def test_a_dangling_connection_is_rejected(self):
        nodes, edges = chain(1)
        edges.append(edge("ghost", "audio", "save", "save:ghost"))
        with self.assertRaisesRegex(ValueError, "dangling connection"):
            gw._validate_graph_definition(nodes, edges)

    def test_an_unavailable_source_port_is_rejected(self):
        # A stem the model does not produce cannot be wired anywhere.
        nodes, edges = chain(1)
        edges.append(edge("step_1", "stem:drums", "save", "save:step_1.drums"))
        with self.assertRaisesRegex(ValueError, "source port"):
            gw._validate_graph_definition(nodes, edges)

    def test_an_unavailable_target_port_is_rejected(self):
        nodes, edges = chain(1)
        edges.append(edge("input", "audio", "step_1", "nonexistent"))
        with self.assertRaisesRegex(ValueError, "target port"):
            gw._validate_graph_definition(nodes, edges)

    def test_two_connections_into_one_input_are_rejected(self):
        # Ambiguous input: the engine has no rule for choosing between them.
        nodes, edges = chain(2)
        edges.append(edge("input", "audio", "step_2", "input"))
        with self.assertRaises(ValueError):
            gw._validate_graph_definition(nodes, edges)


class ExecutionOrderTests(unittest.TestCase):
    def test_a_chain_runs_in_dependency_order(self):
        nodes, edges = chain(3)
        order = [item["id"] for item in gw._build_execution_order(nodes, edges)]
        self.assertEqual(order, ["step_1", "step_2", "step_3"])

    def test_the_input_node_is_not_executed(self):
        # It contributes the source audio; there is nothing to run for it.
        nodes, edges = chain(2)
        order = [item["id"] for item in gw._build_execution_order(nodes, edges)]
        self.assertNotIn("input", order)
        self.assertNotIn("save", order)

    def test_independent_branches_are_ordered_left_to_right(self):
        # Position decides the order of otherwise-equal nodes, so the run follows the layout the
        # user sees rather than dictionary order.
        nodes = {
            "input": node("input", "input_audio"),
            "save": node("save", "save_outputs", x=900.0, outputs={}),
            "right": node("right", "separate", x=600.0, model="b.ckpt", stems=["vocals"]),
            "left": node("left", "separate", x=200.0, model="a.ckpt", stems=["vocals"]),
        }
        edges = [
            edge("input", "audio", "left", "input"),
            edge("input", "audio", "right", "input"),
            edge("left", "stem:vocals", "save", "save:left.vocals"),
            edge("right", "stem:vocals", "save", "save:right.vocals"),
        ]
        order = [item["id"] for item in gw._build_execution_order(nodes, edges)]
        self.assertEqual(order, ["left", "right"])

    def test_a_cycle_is_rejected_rather_than_looping_forever(self):
        nodes, edges = chain(2)
        edges.append(edge("step_2", "stem:vocals", "step_1", "input"))
        with self.assertRaisesRegex(ValueError, "cycle"):
            gw._build_execution_order(nodes, edges)

    def test_a_diamond_places_the_join_after_both_branches(self):
        nodes = {
            "input": node("input", "input_audio"),
            "save": node("save", "save_outputs", x=1200.0, outputs={}),
            "a": node("a", "separate", x=200.0, model="a.ckpt", stems=["vocals"]),
            "b": node("b", "separate", x=400.0, model="b.ckpt", stems=["vocals"]),
            "join": node("join", "audio_ensemble", x=800.0, inputs=["", ""], inputCount=2),
        }
        edges = [
            edge("input", "audio", "a", "input"),
            edge("input", "audio", "b", "input"),
            edge("a", "stem:vocals", "join", "input:0"),
            edge("b", "stem:vocals", "join", "input:1"),
            edge("join", "audio", "save", "save:utility:join"),
        ]
        order = [item["id"] for item in gw._build_execution_order(nodes, edges)]
        self.assertEqual(order[-1], "join")
        self.assertLess(order.index("a"), order.index("join"))
        self.assertLess(order.index("b"), order.index("join"))

    def test_a_node_with_no_path_to_save_still_runs(self):
        # Current behaviour: ordering is driven by dependencies, not by reachability of save.
        # Pinned so a later change to prune dead branches is a visible decision.
        nodes, edges = chain(1)
        nodes["orphan"] = node("orphan", "separate", x=500.0, model="c.ckpt", stems=["vocals"])
        edges.append(edge("input", "audio", "orphan", "input"))
        order = [item["id"] for item in gw._build_execution_order(nodes, edges)]
        self.assertIn("orphan", order)


class SaveTargetTests(unittest.TestCase):
    def test_custom_file_label_tokens_are_rendered_as_a_full_file_name(self):
        label = gw._render_file_label(
            "%filename%_%stem%_%model%.wav",
            input_path="C:/music/demo song.mp3",
            stem_label="instrument",
            model_label="bs_model",
        )

        self.assertEqual(label, "demo song_instrument_bs_model.wav")
        self.assertEqual(gw._output_file_name(label, "wav"), "demo song_instrument_bs_model.wav")
        self.assertEqual(gw._output_file_name(label, "flac"), "demo song_instrument_bs_model.flac")

    def test_duplicate_rendered_file_names_keep_their_label_with_numeric_suffix(self):
        label = gw._render_file_label(
            "%filename%_%stem%_%model%",
            input_path="C:/music/song.wav",
            stem_label="vocals",
            model_label="same_model",
        )
        seen = set()

        first = gw._unique_file_name(gw._output_file_name(label, "wav"), seen)
        seen.add(first.lower())
        second = gw._unique_file_name(gw._output_file_name(label, "wav"), seen)

        self.assertEqual(first, "song_vocals_same_model.wav")
        self.assertEqual(second, "song_vocals_same_model_2.wav")

    def test_duplicate_save_labels_are_kept_with_source_ref_fallback(self):
        nodes = {
            "input": node("input", "input_audio"),
            "save": node("save", "save_outputs", outputs={
                "step_1.vocals": "vocals",
                "step_1.instrument": "instrument",
                "step_2.instrument": "instrument",
            }),
            "step_1": node("step_1", "separate", model="a.ckpt", stems=["vocals", "instrument"]),
            "step_2": node("step_2", "separate", model="b.ckpt", stems=["vocals", "instrument"]),
        }
        edges = [
            edge("input", "audio", "step_1", "input"),
            edge("step_1", "stem:vocals", "step_2", "input"),
            edge("step_1", "stem:vocals", "save", "save:step_1.vocals"),
            edge("step_1", "stem:instrument", "save", "save:step_1.instrument"),
            edge("step_2", "stem:instrument", "save", "save:step_2.instrument"),
        ]

        targets = gw._save_targets_for_graph(nodes, edges)

        self.assertEqual([target.source_ref for target in targets], [
            "step_1.vocals",
            "step_1.instrument",
            "step_2.instrument",
        ])
        self.assertEqual([target.stem_label for target in targets], [
            "vocals",
            "instrument",
            "instrument",
        ])
        self.assertEqual([target.filename_label for target in targets], [
            "",
            "",
            "",
        ])
        self.assertEqual([target.model_label for target in targets], ["a", "a", "b"])

    def test_save_node_output_name_overrides_utility_label(self):
        nodes = {
            "input": node("input", "input_audio"),
            "save": node("save", "save_outputs", outputs={"utility:join": "merged_vocals"}),
            "a": node("a", "separate", model="a.ckpt", stems=["vocals"]),
            "b": node("b", "separate", model="b.ckpt", stems=["vocals"]),
            "join": node("join", "audio_ensemble", inputs=["", ""], inputCount=2),
        }
        edges = [
            edge("input", "audio", "a", "input"),
            edge("input", "audio", "b", "input"),
            edge("a", "stem:vocals", "join", "input:0"),
            edge("b", "stem:vocals", "join", "input:1"),
            edge("join", "audio", "save", "save:utility:join"),
        ]

        targets = gw._save_targets_for_graph(nodes, edges)

        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0].source_ref, "utility:join")
        self.assertEqual(targets[0].stem_label, "audio_ensemble")
        self.assertEqual(targets[0].filename_label, "merged_vocals")


class PortRuleTests(unittest.TestCase):
    """Port availability is what both the editor and the runtime validate against."""

    def test_a_separate_node_exposes_exactly_its_stems(self):
        step = node("step_1", "separate", model="m.ckpt", stems=["vocals", "instrument"])
        self.assertTrue(gw._source_port_is_valid(step, "stem:vocals"))
        self.assertTrue(gw._source_port_is_valid(step, "stem:instrument"))
        self.assertFalse(gw._source_port_is_valid(step, "stem:drums"))

    def test_the_input_node_exposes_one_audio_port(self):
        self.assertTrue(gw._source_port_is_valid(node("input", "input_audio"), "audio"))
        self.assertFalse(gw._source_port_is_valid(node("input", "input_audio"), "stem:vocals"))

    def test_an_ensemble_accepts_as_many_inputs_as_configured(self):
        ensemble = node("join", "audio_ensemble", inputs=["", "", ""], inputCount=3)
        self.assertEqual(gw._utility_input_count(ensemble), 3)
        self.assertTrue(gw._target_port_is_valid(ensemble, "input:2"))
        self.assertFalse(gw._target_port_is_valid(ensemble, "input:3"))


class InferenceParamTests(unittest.TestCase):
    def test_node_inference_params_keep_num_overlap(self):
        params = gw._inference_params_from_node_data({
            "batch_size": 2,
            "overlap_size": "Default",
            "num_overlap": 8,
            "chunk_size": 352800,
        })

        self.assertEqual(params, {"batch_size": 2, "num_overlap": 8, "chunk_size": 352800})


class DispatchTests(unittest.TestCase):
    """Which engine a workflow runs on.

    worker_workflows.py picks between the in-process graph engine and the legacy `pymss` CLI on
    this predicate alone, so a false negative would silently send a graph definition to a CLI that
    cannot read it."""

    def test_what_the_app_sends_always_routes_to_the_graph_engine(self):
        # The desktop app normalises every definition through readWorkflowGraphDefinition() before
        # it reaches the worker — including on re-run of a task restored from history — so the
        # payload always carries kind and version 2.
        corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        for case in corpus["cases"]:
            with self.subTest(case=case["name"]):
                self.assertTrue(gw.is_graph_workflow_definition(case["definition"]))

    def test_a_pre_graph_definition_routes_to_the_cli(self):
        # The only remaining way to reach the CLI fallback: invoking this worker directly with an
        # old workflow file. Pinned so removing that path is a deliberate decision.
        self.assertFalse(gw.is_graph_workflow_definition({
            "version": 1,
            "steps": [{"id": "step_1", "model": "a.ckpt", "input": "input", "stems": ["vocals"]}],
            "save": [],
        }))


class SharedValidationCorpusTests(unittest.TestCase):
    """The editor and the runtime must reach the same verdict for the same graph.

    Both sides read tests/fixtures/workflow-validation.json; the TypeScript half lives in
    tests/workflowValidation.test.mjs. Without this, a rule can be relaxed on one side and the
    user gets a workflow that passes in the editor and fails at run time."""

    @classmethod
    def setUpClass(cls):
        cls.corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))

    def _verdict(self, definition):
        nodes = {str(node.get("id")): node for node in definition["graph"]["nodes"]}
        edges = definition["graph"]["edges"]
        try:
            gw._validate_graph_definition(nodes, edges)
        except ValueError as exc:
            return rule_code_for(str(exc))
        return None

    def test_the_corpus_is_readable(self):
        # A silently missing fixture would make every case below pass vacuously.
        self.assertGreaterEqual(len(self.corpus["cases"]), 8)

    def test_every_case_matches_the_shared_expectation(self):
        for case in self.corpus["cases"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(self._verdict(case["definition"]), case["expect"]["python"])

    def test_both_sides_agree_wherever_the_corpus_says_they_should(self):
        # The corpus is allowed to record a deliberate asymmetry; this asserts there are none
        # beyond the two documented in its header.
        for case in self.corpus["cases"]:
            expected_ts = case["expect"]["ts"]
            expected_python = case["expect"]["python"]
            with self.subTest(case=case["name"]):
                if expected_ts in {"batch_input_multiple", "batch_input_missing_folder"}:
                    self.assertIsNone(expected_python, "batch input is validated in the frontend only")
                elif expected_python == "missing_core_node":
                    self.assertIsNone(expected_ts, "the editor restores core nodes on read")
                else:
                    self.assertEqual(expected_ts, expected_python)


if __name__ == "__main__":
    unittest.main()
