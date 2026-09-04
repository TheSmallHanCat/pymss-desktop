from __future__ import annotations

from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch

import numpy as np

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

from pymss_graph_compat import install_sample_rate_contract


class _Registration:
    def __init__(self, func):
        self.func = func


class _Registry:
    def __init__(self, registration):
        self.nodes = {"mss_separate": registration}


class _AudioArtifact:
    def __init__(self, sample_rate):
        self.sample_rate = sample_rate


class GraphSampleRateCompatibilityTests(unittest.TestCase):
    def _modules(self, *, fixed_annotation: str | None = None):
        nodes = ModuleType("pymss.graph.nodes")
        graph = ModuleType("pymss.graph")
        plugins = ModuleType("pymss.plugins")
        observed_rates: list[int] = []
        resampled: list[tuple[int, int]] = []

        def numpy_to_audio(value, sample_rate, *, stem_name="", source_path=""):
            return _AudioArtifact(sample_rate)

        def build_separator():
            return SimpleNamespace(config=SimpleNamespace(audio={"sample_rate": 44100}))

        def run_separation(ctx, node, audio, *, build_separator, stems):
            # Mirrors pymss.graph 2.1.3: model input is already represented by
            # a model-rate array, but the helper returns arrays without rate.
            observed_rates.append(audio.sample_rate)
            build_separator()
            return {"vocals": np.zeros((1, 4), dtype=np.float32)}

        run_separation.__annotations__["return"] = fixed_annotation or "dict[str, np.ndarray]"
        nodes.numpy_to_audio = numpy_to_audio
        nodes._run_separation = run_separation
        def resample(value, source_rate, target_rate):
            resampled.append((source_rate, target_rate))
            return np.asarray(value).copy()

        nodes._resample = resample

        def execute(ctx, inputs):
            audio = inputs["audio"]
            values = nodes._run_separation(
                ctx,
                None,
                audio,
                build_separator=build_separator,
                stems=["vocals"],
            )
            return [nodes.numpy_to_audio(value, audio.sample_rate, stem_name="vocals") for value in values.values()]

        registration = _Registration(execute)
        registry = _Registry(registration)
        plugins.get_registry = lambda: registry
        return nodes, graph, plugins, registry, observed_rates, resampled

    def test_output_artifact_uses_model_sample_rate(self):
        nodes, graph, plugins, registry, observed_rates, resampled = self._modules()
        with patch.dict(
            sys.modules,
            {
                "pymss.graph": graph,
                "pymss.graph.nodes": nodes,
                "pymss.plugins": plugins,
            },
        ):
            self.assertTrue(install_sample_rate_contract(graph))
            source = SimpleNamespace(sample_rate=48000, audio=np.zeros((1, 4), dtype=np.float32))
            output = registry.nodes["mss_separate"].func(
                SimpleNamespace(),
                {"audio": source},
            )
            self.assertEqual(output[0].sample_rate, 44100)
            self.assertEqual(observed_rates, [44100])
            self.assertEqual(resampled, [(48000, 44100)])
            self.assertEqual(source.sample_rate, 48000)
            second = registry.nodes["mss_separate"].func(
                SimpleNamespace(), {"audio": output[0]}
            )
            self.assertEqual(second[0].sample_rate, 44100)
            self.assertEqual(observed_rates, [44100, 44100])
            self.assertFalse(install_sample_rate_contract(graph))

    def test_matching_rate_skips_resampling(self):
        nodes, graph, plugins, registry, _observed_rates, resampled = self._modules()
        with patch.dict(
            sys.modules,
            {
                "pymss.graph": graph,
                "pymss.graph.nodes": nodes,
                "pymss.plugins": plugins,
            },
        ):
            self.assertTrue(install_sample_rate_contract(graph))
            source = SimpleNamespace(sample_rate=44100, audio=np.zeros((1, 4), dtype=np.float32))
            output = registry.nodes["mss_separate"].func(
                SimpleNamespace(),
                {"audio": source},
            )
            self.assertEqual(output[0].sample_rate, 44100)
            self.assertEqual(resampled, [])

    def test_new_tuple_return_contract_is_left_untouched(self):
        nodes, graph, plugins, _registry, _observed_rates, _resampled = self._modules(
            fixed_annotation="tuple[dict[str, np.ndarray], int]"
        )
        with patch.dict(
            sys.modules,
            {
                "pymss.graph": graph,
                "pymss.graph.nodes": nodes,
                "pymss.plugins": plugins,
            },
        ):
            self.assertFalse(install_sample_rate_contract(graph))
            self.assertFalse(getattr(nodes, "_pymss_studio_sample_rate_contract", False))


if __name__ == "__main__":
    unittest.main()
