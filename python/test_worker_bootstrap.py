import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import worker_bootstrap

COMMON_PACKAGES = ("av", "librosa", "numpy", "pymss")

MANIFEST = {
    "manifestVersion": "test-1",
    "common": {name: name for name in COMMON_PACKAGES},
    "backends": {
        "cpu": {"platforms": ["win32", "linux", "darwin"]},
        "cuda": {"platforms": ["win32", "linux"]},
        "mlx": {"platforms": ["darwin"], "extras": ["mlx"]},
    },
}


def probe_result(torch_backend="cpu", mlx=None, missing=()):
    packages = {name: name not in missing for name in COMMON_PACKAGES}
    if mlx is not None:
        packages["mlx"] = mlx
    return {
        "pythonVersion": "3.12.0",
        "torchVersion": "2.7.1",
        "torchBackend": torch_backend,
        "acceleratorAvailable": torch_backend in {"cuda", "rocm"},
        "packages": packages,
    }


class BundledEnvironmentDetectionTests(unittest.TestCase):
    """_installed_envs()'s bootstrap-python fallback is the only thing that reports the
    environment shipped inside the macOS app bundle, which is torch(cpu) + MLX."""

    def _installed_envs(self, platform_name, probed):
        probe = mock.Mock(return_value=probed)
        with mock.patch.object(worker_bootstrap, "_read_installed_env_state", return_value=None), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", probe), \
             mock.patch.object(sys, "platform", platform_name):
            return worker_bootstrap._installed_envs(MANIFEST), probe

    def test_macos_bundle_with_mlx_is_reported_as_the_mlx_backend(self):
        items, probe = self._installed_envs("darwin", probe_result("cpu", mlx=True))
        self.assertEqual([item["backend"] for item in items], ["mlx"])
        entry = items[0]
        self.assertEqual(entry["source"], "bundled")
        # The torch build really is a CPU build; only the backend label becomes mlx.
        self.assertEqual(entry["torchBackend"], "cpu")
        # The mlx flag must survive into the payload — the UI reads it to decide whether
        # the accelerator is usable, since acceleratorAvailable is CUDA-only.
        self.assertIs(entry["packages"]["mlx"], True)
        self.assertEqual(probe.call_args.args[1:], (["mlx"],))

    def test_macos_without_mlx_still_reports_the_cpu_environment(self):
        items, _ = self._installed_envs("darwin", probe_result("cpu", mlx=False))
        self.assertEqual([item["backend"] for item in items], ["cpu"])

    def test_non_macos_platforms_do_not_probe_for_mlx(self):
        items, probe = self._installed_envs("win32", probe_result("cuda"))
        self.assertEqual([item["backend"] for item in items], ["cuda"])
        self.assertEqual(probe.call_args.args[1:], (None,))

    def test_incomplete_environment_is_not_reported(self):
        items, _ = self._installed_envs("darwin", probe_result("cpu", mlx=True, missing=("librosa",)))
        self.assertEqual(items, [])

    def test_missing_mlx_does_not_suppress_an_otherwise_complete_environment(self):
        # Regression guard: mlx is an optional extra, so a false mlx flag must not be folded
        # into the "are all packages present" check.
        items, _ = self._installed_envs("darwin", probe_result("cpu", mlx=False))
        self.assertEqual(len(items), 1)


class RuntimeReadinessTests(unittest.TestCase):
    """`ready` drives whether the app considers itself usable at all, so MLX being probed
    speculatively must never drag it down."""

    def _payload(self, platform_name, probed, backend=None):
        probe = mock.Mock(return_value=probed)
        state = {"pythonPath": sys.executable, "backend": backend}
        with mock.patch.object(worker_bootstrap, "_manifest", return_value=MANIFEST), \
             mock.patch.object(worker_bootstrap, "_read_runtime_state", return_value=state), \
             mock.patch.object(worker_bootstrap, "_installed_envs", return_value=[]), \
             mock.patch.object(worker_bootstrap, "_module_available", return_value=True), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", probe), \
             mock.patch.object(sys, "platform", platform_name):
            payload = worker_bootstrap._runtime_info_payload({"backend": backend} if backend else {})
        return payload, probe

    def test_macos_probes_mlx_even_when_no_backend_was_requested(self):
        # Without this the store cannot tell an MLX machine from a plain CPU one.
        payload, probe = self._payload("darwin", probe_result("cpu", mlx=True))
        self.assertIs(payload["packages"]["mlx"], True)
        self.assertIn("mlx", probe.call_args.args[1])
        self.assertTrue(payload["ready"])

    def test_other_platforms_do_not_probe_mlx_without_a_backend(self):
        _, probe = self._payload("win32", probe_result("cpu"))
        self.assertNotIn("mlx", probe.call_args.args[1])

    def test_absent_mlx_does_not_make_a_working_mac_look_unready(self):
        payload, _ = self._payload("darwin", probe_result("cpu", mlx=False))
        self.assertIs(payload["packages"]["mlx"], False)
        self.assertTrue(payload["ready"])

    def test_explicitly_requesting_mlx_requires_mlx(self):
        ready, _ = self._payload("darwin", probe_result("cpu", mlx=False), backend="mlx")
        self.assertFalse(ready["ready"])
        present, _ = self._payload("darwin", probe_result("cpu", mlx=True), backend="mlx")
        self.assertTrue(present["ready"])

    def test_broken_torch_is_never_ready(self):
        payload, _ = self._payload("darwin", probe_result("error:boom", mlx=True))
        self.assertFalse(payload["ready"])


class MultipleEnvironmentTests(unittest.TestCase):
    """Each backend gets its own venv directory, so several environments coexist and the
    active one is just a pointer. These tests use stub interpreters — nothing is downloaded."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.envs_dir = self.root / "runtime-envs"
        self.envs_dir.mkdir()
        self.active_file = self.envs_dir / "active-runtime.json"
        self.addCleanup(shutil.rmtree, self.root, True)

    def _make_env(self, backend, torch_version):
        env_dir = self.envs_dir / backend
        (env_dir / "Scripts").mkdir(parents=True)
        (env_dir / "Scripts" / "python.exe").write_text("stub", encoding="utf-8")
        (env_dir / "pymss-runtime-state.json").write_text(json.dumps({
            "backend": backend,
            "manifestVersion": "test-1",
            "torchVersion": torch_version,
            "torchBackend": backend,
            "acceleratorAvailable": backend != "cpu",
            "packages": {name: True for name in COMMON_PACKAGES},
        }), encoding="utf-8")

    @contextlib.contextmanager
    def _runtime(self, bootstrap_torch_backend="missing"):
        # The bootstrap-python fallback probes whatever interpreter runs the tests, so pin it:
        # on a dev machine with CUDA torch installed it would otherwise satisfy activation
        # requests for backends that have no managed environment at all.
        probed = probe_result(bootstrap_torch_backend)
        # Worker commands write JSON events to stdout; swallow them so test output stays readable.
        with mock.patch.object(worker_bootstrap, "RUNTIME_ENVS_DIR", self.envs_dir), \
             mock.patch.object(worker_bootstrap, "ACTIVE_RUNTIME_FILE", self.active_file), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", return_value=probed), \
             mock.patch.object(sys, "platform", "win32"), \
             contextlib.redirect_stdout(io.StringIO()):
            yield

    def _active(self):
        return json.loads(self.active_file.read_text(encoding="utf-8"))

    def test_environments_for_different_backends_coexist(self):
        self._make_env("cpu", "2.7.1")
        self._make_env("cuda", "2.7.1+cu128")
        with self._runtime():
            items = worker_bootstrap._installed_envs(MANIFEST)
        self.assertEqual(
            {item["backend"]: item["source"] for item in items},
            {"cpu": "managed", "cuda": "managed"},
        )
        # Each keeps its own torch build — installing one must not overwrite the other.
        versions = {item["backend"]: item["torchVersion"] for item in items}
        self.assertEqual(versions, {"cpu": "2.7.1", "cuda": "2.7.1+cu128"})

    def test_activation_repoints_at_the_selected_environment(self):
        self._make_env("cpu", "2.7.1")
        self._make_env("cuda", "2.7.1+cu128")
        with self._runtime():
            self.assertEqual(worker_bootstrap.cmd_activate_runtime({"backend": "cuda"}), 0)
            after_cuda = self._active()
            self.assertEqual(worker_bootstrap.cmd_activate_runtime({"backend": "cpu"}), 0)
            after_cpu = self._active()
        self.assertEqual(after_cuda["backend"], "cuda")
        self.assertTrue(after_cuda["pythonPath"].endswith("cuda\\Scripts\\python.exe"))
        self.assertEqual(after_cpu["backend"], "cpu")
        self.assertTrue(after_cpu["pythonPath"].endswith("cpu\\Scripts\\python.exe"))
        # Switching back and forth must not damage either environment.
        with self._runtime():
            self.assertEqual(len(worker_bootstrap._installed_envs(MANIFEST)), 2)

    def test_activating_a_missing_backend_is_rejected(self):
        self._make_env("cpu", "2.7.1")
        with self._runtime():
            self.assertNotEqual(worker_bootstrap.cmd_activate_runtime({"backend": "cuda"}), 0)
        self.assertFalse(self.active_file.exists())

    def test_bootstrap_interpreter_can_satisfy_a_backend_without_a_managed_env(self):
        # Documented fallback: an interpreter that already carries a matching torch build is
        # activatable even with no environment on disk (this is how older bundled builds work).
        with self._runtime(bootstrap_torch_backend="cuda"):
            self.assertEqual(worker_bootstrap.cmd_activate_runtime({"backend": "cuda"}), 0)
        self.assertEqual(self._active()["source"], "bundled")

    def test_deleting_the_active_environment_is_refused(self):
        self._make_env("cpu", "2.7.1")
        self._make_env("cuda", "2.7.1+cu128")
        with self._runtime():
            worker_bootstrap.cmd_activate_runtime({"backend": "cuda"})
            self.assertNotEqual(worker_bootstrap.cmd_delete_runtime({"backend": "cuda"}), 0)
        self.assertTrue((self.envs_dir / "cuda").is_dir())
        self.assertEqual(self._active()["backend"], "cuda")

    def test_deleting_an_idle_environment_leaves_the_active_one_alone(self):
        self._make_env("cpu", "2.7.1")
        self._make_env("cuda", "2.7.1+cu128")
        with self._runtime():
            worker_bootstrap.cmd_activate_runtime({"backend": "cuda"})
            self.assertEqual(worker_bootstrap.cmd_delete_runtime({"backend": "cpu"}), 0)
            remaining = worker_bootstrap._installed_envs(MANIFEST)
        self.assertEqual([item["backend"] for item in remaining], ["cuda"])
        self.assertFalse((self.envs_dir / "cpu").exists())
        self.assertEqual(self._active()["backend"], "cuda")


class PackageImportNameTests(unittest.TestCase):
    """Package availability is decided with importlib, so every manifest package needs an
    importable name. A dashed distribution name that nobody mapped can never be found, and the
    environment would read as permanently incomplete with no hint as to why."""

    def _manifest_packages(self):
        # The real manifest, not the test stub: this is a guard on the shipped dependency list.
        manifest = json.loads(worker_bootstrap.MANIFEST_PATH.read_text(encoding="utf-8"))
        extras = [name for spec in manifest["backends"].values() for name in spec.get("extras", [])]
        return [*manifest["common"], *extras]

    def test_every_manifest_package_resolves_to_an_importable_name(self):
        unimportable = [
            name for name in self._manifest_packages()
            if not worker_bootstrap.PACKAGE_IMPORT_NAMES.get(name, name).isidentifier()
        ]
        self.assertEqual(unimportable, [], f"add these to PACKAGE_IMPORT_NAMES: {unimportable}")

    def test_the_mapping_carries_no_entries_for_packages_that_are_gone(self):
        # A stale entry is harmless but hides that the dependency was dropped.
        packages = set(self._manifest_packages())
        stale = sorted(set(worker_bootstrap.PACKAGE_IMPORT_NAMES) - packages)
        self.assertEqual(stale, [], f"PACKAGE_IMPORT_NAMES maps packages no longer in the manifest: {stale}")

    def test_the_probe_script_shares_the_same_mapping(self):
        # Two detection paths exist (in-process and the probe subprocess). They must agree, or an
        # environment's package list changes depending on which one answered.
        captured = {}

        def fake_check_output(command, **kwargs):
            del kwargs
            captured["script"] = command[2]
            return "{}"

        with mock.patch.object(worker_bootstrap, "_manifest", return_value=MANIFEST), \
             mock.patch.object(worker_bootstrap.subprocess, "check_output", fake_check_output):
            worker_bootstrap._probe_python_runtime(Path("python"))
        self.assertIn(json.dumps(worker_bootstrap.PACKAGE_IMPORT_NAMES), captured["script"])


class EnvironmentStateTrustTests(unittest.TestCase):
    """An environment's recorded torch build must describe that environment. Installs used to
    record whatever the *active* runtime reported, so a CPU env installed while CUDA was active
    claimed "2.7.1+cu128" and an available accelerator — and the UI showed exactly that."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.envs_dir = self.root / "runtime-envs"
        self.envs_dir.mkdir()
        self.addCleanup(shutil.rmtree, self.root, True)

    def _write_state(self, backend, **overrides):
        env_dir = self.envs_dir / backend
        (env_dir / "Scripts").mkdir(parents=True)
        (env_dir / "Scripts" / "python.exe").write_text("stub", encoding="utf-8")
        state = {
            "backend": backend,
            "manifestVersion": "test-1",
            "torchVersion": "2.7.1",
            "torchBackend": backend,
            "acceleratorAvailable": False,
            "packages": {name: True for name in COMMON_PACKAGES},
            **overrides,
        }
        (env_dir / "pymss-runtime-state.json").write_text(json.dumps(state), encoding="utf-8")

    def _stored(self, backend):
        return json.loads((self.envs_dir / backend / "pymss-runtime-state.json").read_text(encoding="utf-8"))

    @contextlib.contextmanager
    def _runtime(self, probe):
        with mock.patch.object(worker_bootstrap, "RUNTIME_ENVS_DIR", self.envs_dir), \
             mock.patch.object(worker_bootstrap, "_manifest", return_value=MANIFEST), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", probe), \
             mock.patch.object(sys, "platform", "win32"):
            yield

    def test_a_foreign_torch_build_is_reprobed_and_the_file_corrected(self):
        self._write_state("cpu", torchVersion="2.7.1+cu128", torchBackend="cuda", acceleratorAvailable=True)
        probe = mock.Mock(return_value=probe_result("cpu"))
        with self._runtime(probe):
            state = worker_bootstrap._read_installed_env_state("cpu")
        self.assertEqual(state["torchBackend"], "cpu")
        self.assertIs(state["acceleratorAvailable"], False)
        # Probed the environment's own interpreter, not the active runtime's.
        self.assertTrue(str(probe.call_args.args[0]).endswith("cpu\\Scripts\\python.exe"))
        # Corrected on disk, so the cost is paid once.
        self.assertEqual(self._stored("cpu")["torchBackend"], "cpu")

    def test_a_corrected_state_is_not_reprobed(self):
        self._write_state("cpu", torchVersion="2.7.1+cu128", torchBackend="cuda", acceleratorAvailable=True)
        probe = mock.Mock(return_value=probe_result("cpu"))
        with self._runtime(probe):
            worker_bootstrap._read_installed_env_state("cpu")
            worker_bootstrap._read_installed_env_state("cpu")
        self.assertEqual(probe.call_count, 1)

    def test_a_consistent_state_is_never_reprobed(self):
        self._write_state("cuda", torchVersion="2.7.1+cu128", torchBackend="cuda", acceleratorAvailable=True)
        probe = mock.Mock(side_effect=AssertionError("must not probe"))
        with self._runtime(probe):
            state = worker_bootstrap._read_installed_env_state("cuda")
        self.assertEqual(state["torchVersion"], "2.7.1+cu128")

    def test_mlx_recording_a_cpu_torch_build_is_not_treated_as_corrupt(self):
        # MLX environments legitimately ship a CPU torch build alongside mlx.
        self._write_state("mlx", torchBackend="cpu")
        probe = mock.Mock(side_effect=AssertionError("must not probe"))
        with self._runtime(probe):
            self.assertEqual(worker_bootstrap._read_installed_env_state("mlx")["torchBackend"], "cpu")

    def test_an_unprobeable_environment_drops_the_claim_instead_of_repeating_it(self):
        self._write_state("cpu", torchVersion="2.7.1+cu128", torchBackend="cuda", acceleratorAvailable=True)
        probe = mock.Mock(side_effect=OSError("interpreter is gone"))
        with self._runtime(probe):
            state = worker_bootstrap._read_installed_env_state("cpu")
        self.assertIsNone(state["torchVersion"])
        self.assertIs(state["acceleratorAvailable"], False)
        # The file keeps its old contents so a transient failure is retried, not made permanent.
        self.assertEqual(self._stored("cpu")["torchBackend"], "cuda")

    def test_installed_environments_report_the_corrected_facts(self):
        self._write_state("cpu", torchVersion="2.7.1+cu128", torchBackend="cuda", acceleratorAvailable=True)
        with self._runtime(mock.Mock(return_value=probe_result("cpu"))), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_env_python_path", wraps=worker_bootstrap._env_python_path):
            items = [item for item in worker_bootstrap._installed_envs(MANIFEST) if item["source"] == "managed"]
        self.assertEqual([(i["backend"], i["torchVersion"], i["acceleratorAvailable"]) for i in items],
                         [("cpu", "2.7.1", False)])


class ActiveEnvironmentReportsLiveFactsTests(unittest.TestCase):
    """A shipped environment records its state on the build machine, which has no GPU, so a
    pre-installed CUDA environment claims acceleratorAvailable=false forever. The active
    environment is probed live on every runtime_info, so that answer must win."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.envs_dir = self.root / "runtime-envs"
        self.envs_dir.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.root, True)
        self.env_python = self.envs_dir / "cuda" / "Scripts" / "python.exe"
        self.env_python.parent.mkdir(parents=True)
        self.env_python.write_text("stub", encoding="utf-8")
        (self.envs_dir / "cuda" / "pymss-runtime-state.json").write_text(json.dumps({
            "backend": "cuda",
            "manifestVersion": "test-1",
            "torchVersion": "2.7.1+cu128",
            "torchBackend": "cuda",
            # What a GPU-less CI runner records.
            "acceleratorAvailable": False,
            "packages": {name: True for name in COMMON_PACKAGES},
            "source": "preinstalled",
        }), encoding="utf-8")

    def _payload(self, active_python):
        active = self.envs_dir / "active-runtime.json"
        active.write_text(json.dumps({"backend": "cuda", "pythonPath": str(active_python)}), encoding="utf-8")
        with mock.patch.object(worker_bootstrap, "RUNTIME_ENVS_DIR", self.envs_dir), \
             mock.patch.object(worker_bootstrap, "ACTIVE_RUNTIME_FILE", active), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_manifest", return_value=MANIFEST), \
             mock.patch.object(worker_bootstrap, "_module_available", return_value=True), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", return_value=probe_result("cuda")), \
             mock.patch.object(sys, "platform", "win32"):
            return worker_bootstrap._runtime_info_payload({})

    def test_the_active_environment_reports_the_probed_accelerator(self):
        entry = next(e for e in self._payload(self.env_python)["installedEnvironments"] if e["backend"] == "cuda")
        self.assertIs(entry["acceleratorAvailable"], True)
        self.assertEqual(entry["torchVersion"], "2.7.1")

    def test_an_idle_environment_keeps_its_recorded_state(self):
        # The active runtime is some other interpreter, so the cuda card must not borrow its facts.
        other = self.root / "other" / "python.exe"
        other.parent.mkdir(parents=True)
        other.write_text("stub", encoding="utf-8")
        entry = next(e for e in self._payload(other)["installedEnvironments"] if e["backend"] == "cuda")
        self.assertIs(entry["acceleratorAvailable"], False)
        self.assertEqual(entry["torchVersion"], "2.7.1+cu128")

    def test_paths_differing_only_in_separators_still_match(self):
        entry = next(e for e in self._payload(str(self.env_python).replace("\\", "/"))["installedEnvironments"]
                     if e["backend"] == "cuda")
        self.assertIs(entry["acceleratorAvailable"], True)

    def test_an_unprobeable_active_runtime_leaves_the_recording_alone(self):
        active = self.envs_dir / "active-runtime.json"
        active.write_text(json.dumps({"backend": "cuda", "pythonPath": str(self.env_python)}), encoding="utf-8")
        with mock.patch.object(worker_bootstrap, "RUNTIME_ENVS_DIR", self.envs_dir), \
             mock.patch.object(worker_bootstrap, "ACTIVE_RUNTIME_FILE", active), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_manifest", return_value=MANIFEST), \
             mock.patch.object(worker_bootstrap, "_module_available", return_value=True), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", side_effect=OSError("boom")), \
             mock.patch.object(sys, "platform", "win32"):
            payload = worker_bootstrap._runtime_info_payload({})
        entry = next(e for e in payload["installedEnvironments"] if e["backend"] == "cuda")
        self.assertEqual(entry["torchVersion"], "2.7.1+cu128")


class InstallRecordsTheNewEnvironmentTests(unittest.TestCase):
    """Regression guard for the root cause: the install used _runtime_info_payload(), which
    probes the *active* runtime — still the previous environment at that point."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.envs_dir = self.root / "runtime-envs"
        self.active_file = self.envs_dir / "active-runtime.json"
        self.addCleanup(shutil.rmtree, self.root, True)
        # A CUDA runtime is active while a CPU environment gets installed.
        self.active_python = self.root / "system" / "python.exe"
        self.active_python.parent.mkdir(parents=True)
        self.active_python.write_text("stub", encoding="utf-8")
        self.envs_dir.mkdir(parents=True)
        self.active_file.write_text(json.dumps({
            "backend": "cuda", "pythonPath": str(self.active_python), "source": "bundled",
        }), encoding="utf-8")
        # Pre-create the target venv so the install skips venv.EnvBuilder.
        (self.envs_dir / "cpu" / "Scripts").mkdir(parents=True)
        (self.envs_dir / "cpu" / "Scripts" / "python.exe").write_text("stub", encoding="utf-8")

    def _probe(self, python_path, extras=None):
        del extras
        if Path(python_path) == self.active_python:
            return {**probe_result("cuda"), "torchVersion": "2.7.1+cu128"}
        return {**probe_result("cpu"), "torchVersion": "2.7.1+cpu"}

    def test_the_recorded_state_describes_the_installed_environment(self):
        manifest = {
            **MANIFEST,
            "common": {**MANIFEST["common"], "pymss-core": "pymss-core==0.1.4"},
            "backends": {"cpu": {"platforms": ["win32"], "torch": {"requirement": "torch==2.7.1"}}},
        }
        pip = mock.Mock(return_value=mock.Mock(stdout=iter(()), wait=mock.Mock(return_value=0), returncode=0))
        with mock.patch.object(worker_bootstrap, "RUNTIME_ENVS_DIR", self.envs_dir), \
             mock.patch.object(worker_bootstrap, "ACTIVE_RUNTIME_FILE", self.active_file), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_manifest", return_value=manifest), \
             mock.patch.object(worker_bootstrap, "_probe_python_runtime", side_effect=self._probe), \
             mock.patch.object(worker_bootstrap.subprocess, "Popen", pip), \
             mock.patch.object(sys, "platform", "win32"), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(worker_bootstrap.cmd_install_runtime({"backend": "cpu", "mirror": "pypi"}), 0)
        state = json.loads((self.envs_dir / "cpu" / "pymss-runtime-state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["torchVersion"], "2.7.1+cpu")
        self.assertEqual(state["torchBackend"], "cpu")
        self.assertIs(state["acceleratorAvailable"], False)
        self.assertEqual(state["stateVersion"], worker_bootstrap.ENV_STATE_VERSION)


class GpuVendorDetectionTests(unittest.TestCase):
    """Vendor detection must not depend on torch: a CPU-only environment on an NVIDIA machine
    reports no CUDA, which is precisely when recommending CUDA matters."""

    def test_pci_ids_map_to_vendors_in_every_notation(self):
        self.assertEqual(worker_bootstrap._vendor_from_pci_id("0x10de"), "nvidia")
        self.assertEqual(worker_bootstrap._vendor_from_pci_id("10DE"), "nvidia")
        self.assertEqual(worker_bootstrap._vendor_from_pci_id("0x1002\n"), "amd")
        self.assertEqual(worker_bootstrap._vendor_from_pci_id("8086"), "intel")

    def test_unknown_or_malformed_ids_yield_no_vendor(self):
        for value in ("0xffff", "", "  ", "12", None):
            self.assertIsNone(worker_bootstrap._vendor_from_pci_id(value))

    def _fake_drm_root(self, cards):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        for card, vendor_id in cards:
            device = root / card / "device"
            device.mkdir(parents=True)
            (device / "vendor").write_text(vendor_id + "\n", encoding="utf-8")
        return root

    def test_linux_reads_vendors_from_sysfs_and_deduplicates(self):
        root = self._fake_drm_root([("card0", "0x1002"), ("card1", "0x10de"), ("card2", "0x10de")])
        self.assertEqual(worker_bootstrap._linux_gpu_vendors(root), ["amd", "nvidia"])

    def test_unreadable_sysfs_entries_are_skipped(self):
        root = self._fake_drm_root([("card0", "0x10de")])
        with mock.patch.object(Path, "read_text", side_effect=OSError("denied")):
            self.assertEqual(worker_bootstrap._linux_gpu_vendors(root), [])

    def test_a_missing_drm_tree_yields_no_vendors(self):
        self.assertEqual(worker_bootstrap._linux_gpu_vendors(Path(tempfile.mkdtemp()) / "absent"), [])

    def test_detection_never_raises(self):
        with mock.patch.object(worker_bootstrap, "_windows_gpu_vendors", side_effect=RuntimeError("boom")), \
             mock.patch.object(sys, "platform", "win32"):
            self.assertEqual(worker_bootstrap._detect_gpu_vendors(), [])

    def test_macos_reports_no_vendors(self):
        # The macOS backend follows from platform.machine(), not from a GPU vendor.
        with mock.patch.object(sys, "platform", "darwin"):
            self.assertEqual(worker_bootstrap._detect_gpu_vendors(), [])


class EnvironmentSizeTests(unittest.TestCase):
    """Disk usage per environment — the number users need before stacking up several
    multi-GB backends."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.envs_dir = self.root / "runtime-envs"
        self.envs_dir.mkdir()
        self.addCleanup(shutil.rmtree, self.root, True)

    def _make_env(self, backend, payload_bytes):
        env_dir = self.envs_dir / backend
        (env_dir / "Scripts").mkdir(parents=True)
        (env_dir / "Scripts" / "python.exe").write_bytes(b"")
        (env_dir / "Lib").mkdir()
        (env_dir / "Lib" / "torch.bin").write_bytes(b"x" * payload_bytes)

    @contextlib.contextmanager
    def _runtime(self):
        with mock.patch.object(worker_bootstrap, "RUNTIME_ENVS_DIR", self.envs_dir), \
             mock.patch.object(worker_bootstrap, "BUNDLED_RUNTIME_ENVS_DIR", None), \
             mock.patch.object(worker_bootstrap, "_manifest", return_value=MANIFEST), \
             mock.patch.object(sys, "platform", "win32"), \
             contextlib.redirect_stdout(self.stdout):
            yield

    stdout = None

    def _emitted(self):
        return json.loads(self.stdout.getvalue().strip().splitlines()[-1])

    def test_reports_a_size_per_installed_environment(self):
        self._make_env("cpu", 4096)
        self._make_env("cuda", 16384)
        self.stdout = io.StringIO()
        with self._runtime():
            self.assertEqual(worker_bootstrap.cmd_runtime_env_sizes({}), 0)
        payload = self._emitted()["payload"]
        self.assertEqual(payload["sizes"], {"cpu": 4096, "cuda": 16384})
        self.assertEqual(payload["totalBytes"], 20480)

    def test_an_interrupted_install_is_reported_as_leftover(self):
        # Install state is only written on success, so a cancelled install leaves a venv that
        # holds gigabytes while not counting as installed. Without this the space is stranded:
        # no card, no size, no way to delete it.
        self._make_env("cpu", 1024)
        (self.envs_dir / "cpu" / "pymss-runtime-state.json").write_text('{"backend": "cpu"}', encoding="utf-8")
        self._make_env("cuda", 8192)  # no state file — interrupted
        self.stdout = io.StringIO()
        with self._runtime():
            worker_bootstrap.cmd_runtime_env_sizes({})
        payload = self._emitted()["payload"]
        self.assertEqual(payload["incompleteBackends"], ["cuda"])
        # Its bytes are still reported, so the total stays honest about disk in use.
        self.assertEqual(payload["sizes"]["cuda"], 8192)

    def test_a_complete_environment_is_never_called_incomplete(self):
        self._make_env("cpu", 1024)
        (self.envs_dir / "cpu" / "pymss-runtime-state.json").write_text('{"backend": "cpu"}', encoding="utf-8")
        self.stdout = io.StringIO()
        with self._runtime():
            worker_bootstrap.cmd_runtime_env_sizes({})
        self.assertEqual(self._emitted()["payload"]["incompleteBackends"], [])

    def test_backends_without_an_environment_are_absent(self):
        self._make_env("cpu", 1024)
        self.stdout = io.StringIO()
        with self._runtime():
            worker_bootstrap.cmd_runtime_env_sizes({})
        # rocm is in the manifest but not installed — reporting 0 would read as "installed,
        # empty" in the UI, so it must be missing entirely.
        self.assertEqual(list(self._emitted()["payload"]["sizes"]), ["cpu"])

    def test_size_targets_skip_the_bootstrap_interpreter(self):
        # The app's own runtime is not a removable environment and must not be measured.
        self.stdout = io.StringIO()
        with self._runtime():
            targets = worker_bootstrap._env_size_targets(MANIFEST)
        self.assertEqual(targets, {})

    def test_unstattable_files_are_skipped_rather_than_raising(self):
        self._make_env("cpu", 2048)
        env_dir = self.envs_dir / "cpu"
        real_walk = os.walk

        def walk_with_ghost(path, **kwargs):
            for root, dirs, files in real_walk(path, **kwargs):
                # A file that disappears between listing and stat() — routine on a live venv.
                if root == str(env_dir / "Lib"):
                    files = [*files, "ghost.bin"]
                yield root, dirs, files

        with mock.patch.object(worker_bootstrap.os, "walk", walk_with_ghost):
            measured = worker_bootstrap._dir_size_bytes(env_dir)
        self.assertEqual(measured, 2048)

    def test_a_failing_measurement_does_not_fail_the_command(self):
        self._make_env("cpu", 2048)
        self.stdout = io.StringIO()
        with mock.patch.object(worker_bootstrap, "_dir_size_bytes", side_effect=OSError("denied")), \
             self._runtime():
            self.assertEqual(worker_bootstrap.cmd_runtime_env_sizes({}), 0)
        # Reported as unknown rather than as a broken command.
        self.assertEqual(self._emitted()["payload"]["sizes"], {})

    def test_undiscoverable_targets_do_not_fail_the_command(self):
        self.stdout = io.StringIO()
        with mock.patch.object(worker_bootstrap, "_env_size_targets", side_effect=OSError("denied")), \
             self._runtime():
            self.assertEqual(worker_bootstrap.cmd_runtime_env_sizes({}), 0)
        self.assertEqual(self._emitted()["payload"],
                         {"sizes": {}, "totalBytes": 0, "incompleteBackends": []})


if __name__ == "__main__":
    unittest.main()
