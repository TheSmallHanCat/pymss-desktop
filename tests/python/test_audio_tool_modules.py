from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

from audio_tools import asr, inspect, registry, slicer


class AudioToolModuleTests(unittest.TestCase):
    def test_registry_exposes_each_audio_tool_module(self) -> None:
        for operation in ("convert", "merge", "sdr", "midi", "inspect", "slicer", "asr"):
            self.assertTrue(callable(registry.get_audio_tool_handler(operation)))
        self.assertIsNone(registry.get_audio_tool_handler("unknown"))

    def test_inspect_normalizes_ffprobe_audio_streams(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            path = Path(temp_value) / "sample.wav"
            path.write_bytes(b"data")
            payload = {
                "format": {"format_name": "wav", "duration": "1.25", "bit_rate": "1536000", "tags": {"title": "Sample"}},
                "streams": [{"index": 0, "codec_type": "audio", "codec_name": "pcm_s24le", "sample_rate": "48000", "channels": 2, "channel_layout": "stereo"}],
                "chapters": [],
            }
            completed = mock.Mock(stdout=json.dumps(payload))
            with (
                mock.patch.object(inspect, "ffprobe_path", return_value="ffprobe"),
                mock.patch.object(inspect, "run_process", return_value=completed),
                mock.patch.object(inspect, "emit"),
            ):
                result = inspect._inspect_audio({"inputPath": str(path)})
        self.assertEqual(result["format"]["duration"], 1.25)
        self.assertEqual(result["audioStreams"][0]["sampleRate"], 48000)
        self.assertEqual(result["format"]["tags"]["title"], "Sample")

    def test_slicer_writes_non_overwriting_segment_results(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "source.wav"
            source.touch()
            output = root / "output"
            output.mkdir()
            with (
                mock.patch.object(slicer, "_slice_intervals", return_value=[(0.5, 1.5), (2.0, 3.0)]),
                mock.patch.object(slicer, "_render_segment") as render,
                mock.patch.object(slicer, "emit"),
            ):
                result = slicer._slice_audio({"inputs": [str(source)], "outputDir": str(output)})
        self.assertEqual(render.call_count, 2)
        self.assertEqual(result["succeeded"], 2)
        self.assertAlmostEqual(result["keptDuration"], 2.0)
        self.assertIn("00000500-00001500", Path(result["segments"][0]["outputPath"]).name)

    def test_slicer_releases_each_analysis_file_before_processing_the_next_input(self) -> None:
        analysis_paths: list[Path] = []

        def analyze(_: Path, raw_path: Path, **__: object) -> list[tuple[float, float]]:
            if analysis_paths:
                self.assertFalse(analysis_paths[-1].exists())
            raw_path.write_bytes(b"decoded-pcm")
            analysis_paths.append(raw_path)
            return [(0.0, 1.0)]

        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            sources = [root / "first.wav", root / "second.wav"]
            for source in sources:
                source.touch()
            output = root / "output"
            output.mkdir()
            with (
                mock.patch.object(slicer, "_slice_intervals", side_effect=analyze),
                mock.patch.object(slicer, "_render_segment"),
                mock.patch.object(slicer, "emit"),
            ):
                result = slicer._slice_audio({
                    "inputs": [str(source) for source in sources],
                    "outputDir": str(output),
                })

        self.assertEqual(result["sourceCount"], 2)
        self.assertEqual(len(analysis_paths), 2)

    def test_asr_writes_text_json_and_srt(self) -> None:
        class FakeModel:
            def __init__(self, **_: object) -> None:
                pass
            def generate(self, **_: object):
                return [{"text": "测试文本", "sentence_info": [{"start": 0, "end": 1250, "text": "测试文本"}]}]

        module = types.ModuleType("funasr")
        module.AutoModel = FakeModel  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            output = root / "output"
            with mock.patch.dict(sys.modules, {"funasr": module}), mock.patch.object(asr, "emit"):
                result = asr._transcribe_audio({
                    "inputPath": str(source), "outputDir": str(output),
                    "outputFormats": ["txt", "json", "srt"], "allowDownload": True,
                })
            paths = [Path(value) for value in result["outputPaths"]]
            self.assertEqual({path.suffix for path in paths}, {".txt", ".json", ".srt"})
            self.assertTrue(all(path.exists() for path in paths))
            self.assertIn("00:00:01,250", next(path for path in paths if path.suffix == ".srt").read_text(encoding="utf-8"))

    def test_asr_allows_local_main_model_with_official_auxiliary_models(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            model = Path(temp_value) / "asr-model"
            model.mkdir()
            resolved = asr._resolve_models({"modelPath": str(model), "allowDownload": True})

        self.assertEqual(resolved[0], str(model.resolve()))
        self.assertEqual(resolved[1:], (asr.DEFAULT_VAD_MODEL, asr.DEFAULT_PUNC_MODEL))

    def test_asr_requires_every_local_model_when_download_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            model = Path(temp_value) / "asr-model"
            model.mkdir()
            with self.assertRaisesRegex(ValueError, "select ASR, VAD, and punctuation"):
                asr._resolve_models({"modelPath": str(model), "allowDownload": False})

    def test_asr_cache_uses_the_configured_model_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            configured_root = Path(temp_value) / "configured-models"
            default_root = Path(temp_value) / "default-models"
            with mock.patch.dict("os.environ", {
                "PYMSS_MODEL_DIR": str(default_root),
                "MODELSCOPE_CACHE": str(Path(temp_value) / "global-cache"),
            }):
                cache_dir = asr._configure_model_cache({"modelDir": str(configured_root)})

                self.assertEqual(cache_dir, configured_root / "_tool_models" / "asr")
                self.assertEqual(os.environ["MODELSCOPE_CACHE"], str(cache_dir))

    def test_asr_cache_falls_back_to_the_worker_default_model_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            default_root = Path(temp_value) / "default-models"
            with mock.patch.dict("os.environ", {"PYMSS_MODEL_DIR": str(default_root)}, clear=True):
                cache_dir = asr._configure_model_cache({})

                self.assertEqual(cache_dir, default_root / "_tool_models" / "asr")
                self.assertEqual(os.environ["MODELSCOPE_CACHE"], str(cache_dir))

    def test_asr_resolves_multilingual_profile_and_validates_language(self) -> None:
        configuration = asr._resolve_model_configuration({
            "modelPreset": "fun-asr-mlt-nano",
            "language": "pt",
        })

        self.assertEqual(configuration["model"], "FunAudioLLM/Fun-ASR-MLT-Nano-2512")
        self.assertEqual(configuration["language"], "pt")
        self.assertIsNone(configuration["punc_model"])
        self.assertTrue(configuration["trust_remote_code"])
        with self.assertRaisesRegex(ValueError, "not supported"):
            asr._resolve_model_configuration({"modelPreset": "paraformer-en", "language": "zh"})

    def test_asr_nano_uses_language_name_and_hotword_list(self) -> None:
        configuration = asr._resolve_model_configuration({
            "modelPreset": "fun-asr-nano",
            "language": "zh",
        })
        options = asr._generate_options(configuration, Path("speech.wav"), "张三，产品名")

        self.assertEqual(options["language"], "中文")
        self.assertEqual(options["hotwords"], ["张三", "产品名"])
        self.assertEqual(options["batch_size"], 1)
        self.assertNotIn("sentence_timestamp", options)

    def test_asr_nano_configures_model_and_returns_profile_metadata(self) -> None:
        model_options: dict[str, object] = {}
        generate_options: dict[str, object] = {}

        class FakeModel:
            def __init__(self, **kwargs: object) -> None:
                model_options.update(kwargs)

            def generate(self, **kwargs: object):
                generate_options.update(kwargs)
                return [{"text": "识别结果", "language": "中文"}]

        module = types.ModuleType("funasr")
        module.AutoModel = FakeModel  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            with (
                mock.patch.dict(sys.modules, {"funasr": module}),
                mock.patch.object(asr, "_select_device", return_value="cpu"),
                mock.patch.object(asr, "emit"),
            ):
                result = asr._transcribe_audio({
                    "inputPath": str(source),
                    "outputDir": str(root / "output"),
                    "outputFormats": ["txt"],
                    "modelPreset": "fun-asr-nano",
                    "language": "zh",
                    "hotword": "张三，项目名",
                })

        self.assertEqual(model_options["model"], "FunAudioLLM/Fun-ASR-Nano-2512")
        self.assertEqual(model_options["vad_model"], asr.DEFAULT_VAD_MODEL)
        self.assertNotIn("punc_model", model_options)
        self.assertTrue(model_options["trust_remote_code"])
        self.assertEqual(generate_options["language"], "中文")
        self.assertEqual(generate_options["hotwords"], ["张三", "项目名"])
        self.assertEqual(result["modelPreset"], "fun-asr-nano")
        self.assertEqual(result["detectedLanguage"], "zh")

    def test_asr_sensevoice_normalizes_rich_sentence_text(self) -> None:
        postprocess = types.ModuleType("funasr.utils.postprocess_utils")
        postprocess.rich_transcription_postprocess = lambda value: value.replace("<|zh|>", "")  # type: ignore[attr-defined]
        utils = types.ModuleType("funasr.utils")
        with mock.patch.dict(sys.modules, {
            "funasr.utils": utils,
            "funasr.utils.postprocess_utils": postprocess,
        }):
            entries = asr._sentence_entries([{
                "sentence_info": [{"start": 0, "end": 900, "sentence": "<|zh|>测试"}],
            }], "测试", "rich")

        self.assertEqual(entries, [{"start": 0.0, "end": 0.9, "text": "测试"}])

    def test_asr_model_download_output_emits_deduplicated_progress(self) -> None:
        stderr = io.StringIO()
        output = asr._ModelLoadOutput(stderr)
        first = "\rmodel.pt: 20%|####      | 197M/990M [00:07<00:27, 28.8MB/s]"
        repeated = "\rmodel.pt: 20%|####      | 200M/990M [00:07<00:27, 28.9MB/s]"
        second = "\rmodel.pt: 21%|####      | 203M/990M [00:08<00:27, 28.6MB/s]"

        with mock.patch.object(asr, "emit") as worker_emit:
            output.write(first)
            output.write(repeated)
            output.write(second)
            output.write("model cache warning\n")

        self.assertEqual(worker_emit.call_count, 2)
        worker_emit.assert_any_call("audio_tool_progress", {
            "operation": "asr",
            "phase": "loading_asr_model",
            "completed": 20,
            "total": 100,
            "current": "model.pt",
            "detail": "197M / 990M · 28.8MB/s · ETA 00:27",
        })
        self.assertEqual(stderr.getvalue(), "model cache warning\n")

    def test_asr_rejects_incomplete_download_before_generating_outputs(self) -> None:
        model_id = "iic--punc_ct-transformer_cn-en-common-vocab471067-large"

        class FakeModel:
            def __init__(self, **_: object) -> None:
                print(
                    "Downloading 10 files from "
                    "iic/punc_ct-transformer_cn-en-common-vocab471067-large@master",
                    file=sys.stderr,
                )
                print(
                    "Download failed for model.pt: [Errno 28] No space left on device",
                    file=sys.stderr,
                )

            def generate(self, **_: object):
                raise AssertionError("inference must not start with an incomplete model")

        module = types.ModuleType("funasr")
        module.AutoModel = FakeModel  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            model_root = root / "models"
            with (
                mock.patch.dict(sys.modules, {"funasr": module}),
                mock.patch.object(asr, "_select_device", return_value="cpu"),
                mock.patch.object(asr, "emit"),
                redirect_stderr(io.StringIO()),
                self.assertRaises(asr.AudioToolError) as raised,
            ):
                asr._transcribe_audio({
                    "inputPath": str(source),
                    "outputDir": str(root / "output"),
                    "outputFormats": ["txt"],
                    "modelDir": str(model_root),
                    "modelPreset": "paraformer-zh",
                })

            recovery = raised.exception.extra["recovery"]
            self.assertEqual(raised.exception.code, "ASR_MODEL_INCOMPLETE")
            self.assertTrue(raised.exception.recoverable)
            self.assertEqual(recovery["modelIds"], [model_id])
            self.assertEqual(recovery["modelDir"], str(model_root))
            self.assertEqual(recovery["reason"], "disk_full")
            self.assertEqual(list((root / "output").glob("*")), [])

    def test_asr_detects_an_existing_incomplete_selected_model_before_loading(self) -> None:
        class FakeModel:
            def __init__(self, **_: object) -> None:
                raise AssertionError("model loading must not start with an incomplete cache")

        module = types.ModuleType("funasr")
        module.AutoModel = FakeModel  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            model_root = root / "models"
            model_id = "iic--punc_ct-transformer_cn-en-common-vocab471067-large"
            incomplete = (
                model_root / "_tool_models" / "asr" / "models" / model_id
                / "snapshots" / "master" / "model.pt.incomplete"
            )
            incomplete.parent.mkdir(parents=True)
            incomplete.touch()
            with (
                mock.patch.dict(sys.modules, {"funasr": module}),
                mock.patch.object(asr, "_select_device", return_value="cpu"),
                mock.patch.object(asr, "emit"),
                self.assertRaises(asr.AudioToolError) as raised,
            ):
                asr._transcribe_audio({
                    "inputPath": str(source),
                    "outputDir": str(root / "output"),
                    "outputFormats": ["txt"],
                    "modelDir": str(model_root),
                    "modelPreset": "paraformer-zh",
                })

        recovery = raised.exception.extra["recovery"]
        self.assertEqual(recovery["modelIds"], [model_id])
        self.assertEqual(recovery["reason"], "incomplete_download")

    def test_asr_detects_a_cache_with_missing_declared_files_before_loading(self) -> None:
        class FakeModel:
            def __init__(self, **_: object) -> None:
                raise AssertionError("model loading must not start with an incomplete cache")

        module = types.ModuleType("funasr")
        module.AutoModel = FakeModel  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            model_root = root / "models"
            model_id = "iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
            snapshot = model_root / "_tool_models" / "asr" / "models" / model_id / "snapshots" / "master"
            snapshot.mkdir(parents=True)
            (snapshot / "model.pt").write_bytes(b"weight" * 512)
            (snapshot / "config.yaml").write_bytes(b"config")
            (snapshot / "configuration.json").write_text(json.dumps({
                "file_path_metas": {
                    "init_param": "model.pt",
                    "config": "config.yaml",
                    "tokenizer_conf": {"token_list": "tokens.json"},
                },
            }), encoding="utf-8")
            with (
                mock.patch.dict(sys.modules, {"funasr": module}),
                mock.patch.object(asr, "_select_device", return_value="cpu"),
                mock.patch.object(asr, "emit"),
                self.assertRaises(asr.AudioToolError) as raised,
            ):
                asr._transcribe_audio({
                    "inputPath": str(source),
                    "outputDir": str(root / "output"),
                    "outputFormats": ["txt"],
                    "modelDir": str(model_root),
                    "modelPreset": "paraformer-zh",
                })

        self.assertEqual(raised.exception.extra["recovery"]["modelIds"], [model_id])

    def test_asr_rejects_srt_only_for_a_preset_without_timestamps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            with self.assertRaisesRegex(ValueError, "does not provide timestamps"):
                asr._transcribe_audio({
                    "inputPath": str(source),
                    "outputDir": str(root / "output"),
                    "outputFormats": ["srt"],
                    "modelPreset": "fun-asr-nano",
                })
            self.assertEqual(list((root / "output").glob("*")), [])

    def test_asr_does_not_report_success_when_srt_is_the_only_unwritable_output(self) -> None:
        class FakeModel:
            def __init__(self, **_: object) -> None:
                pass

            def generate(self, **_: object):
                return [{"text": "测试文本"}]

        module = types.ModuleType("funasr")
        module.AutoModel = FakeModel  # type: ignore[attr-defined]
        with tempfile.TemporaryDirectory() as temp_value:
            root = Path(temp_value)
            source = root / "speech.wav"
            source.touch()
            with (
                mock.patch.dict(sys.modules, {"funasr": module}),
                mock.patch.object(asr, "_select_device", return_value="cpu"),
                mock.patch.object(asr, "emit"),
                self.assertRaisesRegex(RuntimeError, "without a writable output"),
            ):
                asr._transcribe_audio({
                    "inputPath": str(source),
                    "outputDir": str(root / "output"),
                    "outputFormats": ["srt"],
                    "modelPreset": "paraformer-zh",
                })
            self.assertEqual(list((root / "output").glob("*")), [])


if __name__ == "__main__":
    unittest.main()
