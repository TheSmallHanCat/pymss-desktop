import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import worker_models


class FakeUserModelEntry:
    """Duck-type of pymss's UserModelEntry.

    Deliberately a local stub rather than the real class: these tests must assert how this
    module treats a user entry, not whether pymss happens to be installed for the interpreter
    running the suite."""

    def __init__(self, name, model_path, config_path=None, **overrides):
        self.name = name
        self.model_path = str(model_path)
        self.config_path = str(config_path) if config_path else None
        self.source = "user"
        self.aliases = ()
        self.model_type = overrides.get("model_type", "bs_roformer")
        self.architecture = self.model_type
        self.supported = True
        self.unsupported_reason = ""
        # The fields that make a catalog-style path computation silently wrong.
        self.relpath = ""
        self.config_relpath = ""
        self.auxiliary_relpaths = ()
        self.size_bytes = overrides.get("size_bytes", 0)
        self.sha256 = ""
        self.primary_category = "user"
        self.primary_category_cn = "用户"
        self.secondary_category = "custom"
        self.secondary_category_cn = "自定义"
        self.target_stem = ""
        self.config_instruments = ""
        self.config_target_instrument = ""
        self.classification_confidence = "user"
        self.classification_basis = "user_registered"
        self.inference_params = {}

    @property
    def category_path(self):
        return "user/custom"


CATALOG_ENTRY = worker_models.ModelEntry.from_dict({
    "name": "catalog_model.ckpt",
    "relpath": "vocals/catalog_model.ckpt",
    "config_relpath": "vocals/catalog_model.yaml",
    "model_type": "bs_roformer",
    "size_bytes": 4096,
    "supported": True,
})


class UserModelPathTests(unittest.TestCase):
    """A user entry stores absolute paths and leaves relpath empty, so the catalog computation
    `model_root / relpath` collapses to the model directory itself — an existing path pointing
    at the wrong thing."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.model_dir = self.root / "models"
        self.model_dir.mkdir()
        self.weights = self.root / "elsewhere" / "my_model.ckpt"
        self.weights.parent.mkdir()
        self.weights.write_bytes(b"x" * 2048)
        self.config = self.root / "elsewhere" / "my_model.yaml"
        self.config.write_text("training:\n  instruments: [vocals, other]\n", encoding="utf-8")

    def test_paths_come_from_the_registration_not_the_model_directory(self):
        entry = FakeUserModelEntry("my_model", self.weights, self.config)
        self.assertEqual(worker_models.model_path_for(entry, str(self.model_dir)), self.weights)
        self.assertEqual(worker_models.config_path_for(entry, str(self.model_dir)), self.config)

    def test_the_model_directory_is_never_mistaken_for_a_model_file(self):
        # Regression guard for the actual defect: with relpath == "" the catalog computation
        # returns the model directory, which is_dir() and would confuse every caller.
        entry = FakeUserModelEntry("my_model", self.weights, self.config)
        resolved = worker_models.model_path_for(entry, str(self.model_dir))
        self.assertNotEqual(resolved, self.model_dir)
        self.assertTrue(resolved.is_file())

    def test_a_registration_without_a_config_reports_none(self):
        entry = FakeUserModelEntry("my_model", self.weights)
        self.assertIsNone(worker_models.config_path_for(entry, str(self.model_dir)))

    def test_catalog_entries_keep_resolving_against_the_model_directory(self):
        self.assertEqual(
            worker_models.model_path_for(CATALOG_ENTRY, str(self.model_dir)),
            self.model_dir / "vocals" / "catalog_model.ckpt",
        )
        self.assertEqual(
            worker_models.config_path_for(CATALOG_ENTRY, str(self.model_dir)),
            self.model_dir / "vocals" / "catalog_model.yaml",
        )

    def test_auxiliary_paths_of_a_user_entry_are_used_as_given(self):
        entry = FakeUserModelEntry("my_model", self.weights, self.config)
        extra = self.root / "elsewhere" / "extra.bin"
        entry.auxiliary_relpaths = (str(extra),)
        self.assertEqual(worker_models.auxiliary_paths_for(entry, str(self.model_dir)), [extra])

    def test_only_user_entries_are_treated_as_user_entries(self):
        self.assertTrue(worker_models.is_user_model_entry(FakeUserModelEntry("m", self.weights)))
        self.assertFalse(worker_models.is_user_model_entry(CATALOG_ENTRY))


class DeleteRefusesImportedModelsTests(unittest.TestCase):
    """Deleting an imported model would delete the user's own file, often outside the app.
    cmd_delete_model must refuse and point at the unregister path instead."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.weights = self.root / "keep_me.ckpt"
        self.weights.write_bytes(b"x" * 1024)
        self.stdout = io.StringIO()

    def _run(self, entry):
        registry = mock.Mock()
        registry.get_model_entry.return_value = entry
        with mock.patch.dict("sys.modules", {"pymss": mock.Mock(), "pymss.model_registry": registry}), \
             redirect_stdout(self.stdout):
            return worker_models.cmd_delete_model({"model": entry.name})

    def _events(self):
        return [json.loads(line) for line in self.stdout.getvalue().strip().splitlines() if line.strip()]

    def test_deleting_an_imported_model_fails_and_touches_nothing(self):
        code = self._run(FakeUserModelEntry("my_model", self.weights))
        self.assertEqual(code, 1)
        self.assertTrue(self.weights.is_file(), "the user's own weights must survive")
        event = self._events()[-1]
        self.assertEqual(event["type"], "model_delete_failed")
        self.assertIn("custom model", event["payload"]["message"])
        self.assertEqual(event["payload"]["deleted"], [])

    def test_a_missing_model_name_still_fails_cleanly(self):
        with redirect_stdout(self.stdout):
            self.assertEqual(worker_models.cmd_delete_model({}), 1)
        self.assertEqual(self._events()[-1]["type"], "model_delete_failed")


if __name__ == "__main__":
    unittest.main()
