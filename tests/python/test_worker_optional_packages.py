from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

import worker_optional_packages as optional_packages


class OptionalRuntimePackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.envs_dir = self.root / "runtime-envs"
        self.active_file = self.envs_dir / "active-runtime.json"
        self.envs_dir.mkdir(parents=True)
        self.active_file.write_text(json.dumps({"backend": "cuda"}), encoding="utf-8")
        self.environment = mock.patch.dict(os.environ, {
            "PYMSS_STUDIO_RUNTIME_ENVS_DIR": str(self.envs_dir),
            "PYMSS_STUDIO_ACTIVE_RUNTIME_FILE": str(self.active_file),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_release_manifest_does_not_bundle_funasr(self) -> None:
        manifest_path = Path(__file__).resolve().parents[2] / "python" / "runtime-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertNotIn("funasr", manifest["common"])

    def test_package_directory_is_scoped_to_active_backend_and_python(self) -> None:
        expected_identity = f"cuda-py{sys.version_info.major}{sys.version_info.minor}"
        self.assertEqual(optional_packages._runtime_identity(), expected_identity)
        self.assertEqual(
            optional_packages._package_dir("funasr"),
            self.envs_dir / "optional-packages" / expected_identity / "funasr",
        )

    def test_status_prefers_managed_sidecar_version(self) -> None:
        package_dir = optional_packages._package_dir("funasr")
        metadata_dir = package_dir / "funasr-1.3.26.dist-info"
        metadata_dir.mkdir(parents=True)
        (metadata_dir / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: funasr\nVersion: 1.3.26\n",
            encoding="utf-8",
        )
        with mock.patch.object(optional_packages, "_environment_version") as environment_version:
            status = optional_packages.optional_package_status("funasr")
        self.assertTrue(status["installed"])
        self.assertTrue(status["present"])
        self.assertEqual(status["version"], "1.3.26")
        self.assertEqual(status["source"], "managed")
        self.assertIsNone(status["issue"])
        environment_version.assert_not_called()

    def test_status_probe_does_not_import_an_installed_component(self) -> None:
        package_dir = optional_packages._package_dir("funasr")
        metadata_dir = package_dir / "funasr-1.3.26.dist-info"
        metadata_dir.mkdir(parents=True)
        (metadata_dir / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: funasr\nVersion: 1.3.26\n",
            encoding="utf-8",
        )
        with mock.patch.object(optional_packages, "_environment_version") as environment_version, \
             mock.patch.object(optional_packages.subprocess, "run") as run_process:
            status = optional_packages.optional_package_status("funasr")
        self.assertTrue(status["installed"])
        self.assertTrue(status["present"])
        self.assertIsNone(status["issue"])
        environment_version.assert_not_called()
        run_process.assert_not_called()

    def test_status_marks_an_incompatible_version_for_repair(self) -> None:
        with mock.patch.object(optional_packages, "_sidecar_version", return_value=None), \
             mock.patch.object(optional_packages, "_environment_version", return_value="1.2.0"):
            status = optional_packages.optional_package_status("funasr")
        self.assertFalse(status["installed"])
        self.assertTrue(status["present"])
        self.assertEqual(status["issue"], "version_mismatch")

    def test_activate_only_adds_existing_managed_package_directory(self) -> None:
        package_dir = optional_packages._package_dir("funasr")
        package_dir.mkdir(parents=True)
        isolated_path = list(sys.path)
        with mock.patch.object(sys, "path", isolated_path):
            optional_packages.activate_optional_packages()
            self.assertEqual(sys.path[0], str(package_dir))

    def test_uninstall_removes_managed_package_without_touching_runtime_pip(self) -> None:
        package_dir = optional_packages._package_dir("funasr")
        package_dir.mkdir(parents=True)
        with mock.patch.object(optional_packages, "_environment_version", return_value=None), \
             mock.patch.object(optional_packages, "_run_process") as run_process:
            optional_packages._uninstall_package("funasr")
        self.assertFalse(package_dir.exists())
        run_process.assert_not_called()

    def test_uninstall_uses_the_captured_active_runtime_interpreter(self) -> None:
        runtime = optional_packages._runtime_context()
        with mock.patch.object(optional_packages, "_environment_version", return_value="1.3.26"), \
             mock.patch.object(optional_packages, "_run_process") as run_process:
            optional_packages._uninstall_package("funasr", runtime=runtime)
        self.assertEqual(run_process.call_args.args[0][:4], [
            str(runtime.executable), "-m", "pip", "uninstall",
        ])

    def test_install_stages_and_activates_package_without_writing_to_runtime(self) -> None:
        commands = []

        def fake_process(command, name, action, environment=None, task_id=None):
            self.assertEqual(name, "funasr")
            self.assertEqual(action, "install")
            commands.append(command)
            if "--report" in command:
                report_path = Path(command[command.index("--report") + 1])
                report_path.write_text(json.dumps({
                    "install": [{"metadata": {"name": "funasr", "version": "1.3.26"}}],
                }), encoding="utf-8")
                return
            if "--target" not in command:
                return
            staging = Path(command[command.index("--target") + 1])
            metadata_dir = staging / "funasr-1.3.26.dist-info"
            metadata_dir.mkdir(parents=True)
            (metadata_dir / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: funasr\nVersion: 1.3.26\n",
                encoding="utf-8",
            )

        isolated_path = list(sys.path)
        runtime = optional_packages._runtime_context()
        self.active_file.write_text(json.dumps({"backend": "cpu"}), encoding="utf-8")
        with mock.patch.object(optional_packages, "_run_process", side_effect=fake_process), \
             mock.patch.object(optional_packages, "_emit_stage"), \
             mock.patch.object(optional_packages, "_environment_version", side_effect=lambda name, runtime=None: {
                 "torch": "2.7.1+cu128",
                 "torchaudio": "2.7.1+cu128",
             }.get(name)), \
             mock.patch.object(sys, "path", isolated_path):
            optional_packages._install_package(
                "funasr",
                optional_packages.OPTIONAL_PACKAGES["funasr"],
                "pypi",
                "en-US",
                runtime=runtime,
            )
            package_dir = optional_packages._package_dir("funasr", runtime)
            self.assertTrue(package_dir.is_dir())
            self.assertEqual(sys.path[0], str(package_dir))
            self.assertEqual(runtime.identity, f"cuda-py{sys.version_info.major}{sys.version_info.minor}")
            self.assertFalse(optional_packages._package_dir("funasr").exists())
            install_command = next(command for command in commands if "--target" in command)
            self.assertEqual(install_command[0], str(runtime.executable))
            self.assertIn("--no-deps", install_command)
            self.assertIn("funasr==1.3.26", install_command)
            verification_commands = [
                command for command in commands
                if "-c" in command and "import funasr, torchaudio" in " ".join(command)
            ]
            self.assertEqual(len(verification_commands), 1)

    def test_missing_torchaudio_uses_the_active_torch_build(self) -> None:
        with mock.patch.object(optional_packages, "_environment_version", side_effect=lambda name, runtime=None: {
            "torch": "2.7.1+cu128",
            "torchaudio": None,
        }.get(name)):
            requirement = optional_packages._torchaudio_requirement()
        self.assertEqual(
            requirement,
            ("torchaudio==2.7.1", "https://download.pytorch.org/whl/cu128"),
        )

    def test_mismatched_torchaudio_uses_the_active_torch_build(self) -> None:
        with mock.patch.object(optional_packages, "_environment_version", side_effect=lambda name, runtime=None: {
            "torch": "2.7.1+cu128",
            "torchaudio": "2.6.0+cu124",
        }.get(name)):
            requirement = optional_packages._torchaudio_requirement()
        self.assertEqual(
            requirement,
            ("torchaudio==2.7.1", "https://download.pytorch.org/whl/cu128"),
        )

    def test_matching_torchaudio_is_not_reinstalled(self) -> None:
        with mock.patch.object(optional_packages, "_environment_version", side_effect=lambda name, runtime=None: {
            "torch": "2.7.1+cu128",
            "torchaudio": "2.7.1+cu128",
        }.get(name)):
            self.assertIsNone(optional_packages._torchaudio_requirement())

    def test_torchaudio_is_staged_without_reinstalling_torch(self) -> None:
        staging = self.root / "staging"
        with mock.patch.object(
            optional_packages,
            "_torchaudio_requirement",
            return_value=("torchaudio==2.7.1", "https://download.pytorch.org/whl/cu128"),
        ), mock.patch.object(optional_packages, "_emit_stage"), \
             mock.patch.object(optional_packages, "_run_process") as run_process:
            optional_packages._install_torchaudio(staging, "funasr", "optional-task")
        command = run_process.call_args.args[0]
        self.assertIn("--no-deps", command)
        self.assertIn("--target", command)
        self.assertIn("torchaudio==2.7.1", command)
        self.assertFalse(any(value.startswith("torch==") for value in command))

    def test_verification_failure_does_not_reinstall_every_dependency_from_fallback(self) -> None:
        target_installs = 0

        def fake_process(command, name, action, environment=None, task_id=None):
            nonlocal target_installs
            if "--report" in command:
                report_path = Path(command[command.index("--report") + 1])
                report_path.write_text(json.dumps({
                    "install": [{"metadata": {"name": "funasr", "version": "1.3.26"}}],
                }), encoding="utf-8")
                return
            if "--target" in command:
                target_installs += 1
                return
            raise ModuleNotFoundError("missing verification dependency")

        with mock.patch.object(optional_packages, "_run_process", side_effect=fake_process), \
             mock.patch.object(optional_packages, "_emit_stage"), \
             mock.patch.object(optional_packages, "_environment_version", side_effect=lambda name, runtime=None: {
                 "torch": "2.7.1+cu128",
                 "torchaudio": "2.7.1+cu128",
             }.get(name)):
            with self.assertRaisesRegex(ModuleNotFoundError, "missing verification dependency"):
                optional_packages._install_package(
                    "funasr",
                    optional_packages.OPTIONAL_PACKAGES["funasr"],
                    "auto",
                    "zh-CN",
                )
        self.assertEqual(target_installs, 1)

    def test_resolution_includes_the_requested_package_when_metadata_hides_it(self) -> None:
        report = self.root / "report.json"

        def fake_process(command, *_args, **_kwargs):
            Path(command[command.index("--report") + 1]).write_text(
                json.dumps({"install": []}),
                encoding="utf-8",
            )

        with mock.patch.object(optional_packages, "_run_process", side_effect=fake_process):
            resolved = optional_packages._resolve_install_requirements(
                "funasr==1.3.26",
                "https://pypi.org/simple",
                report,
                "funasr",
            )
        self.assertEqual(resolved, ["funasr==1.3.26"])

    def test_unknown_package_is_rejected_before_running_pip(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported optional runtime package"):
            optional_packages._package_spec("unknown")


if __name__ == "__main__":
    unittest.main()
