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

    def test_catalog_config_ignores_legacy_debug_override(self):
        debug_dir = self.root / "debug"
        override = debug_dir / "model-configs" / "catalog_model.ckpt.yaml"
        override.parent.mkdir(parents=True)
        override.write_text("debug: true\n", encoding="utf-8")
        with mock.patch.dict("os.environ", {"PYMSS_STUDIO_DEBUG_DIR": str(debug_dir)}):
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


class UserModelSerializationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.weights = self.root / "my_model.ckpt"
        self.weights.write_bytes(b"x" * 3072)
        self.config = self.root / "my_model.yaml"
        self.config.write_text(
            "training:\n  instruments: [vocals, instrumental]\n  target_instrument: vocals\n",
            encoding="utf-8",
        )

    def test_an_imported_model_is_labelled_as_a_user_model(self):
        payload = worker_models.model_to_dict(FakeUserModelEntry("my_model", self.weights, self.config))
        self.assertEqual(payload["source"], "user")
        self.assertEqual(payload["modelPath"], str(self.weights))
        self.assertEqual(payload["configPath"], str(self.config))
        self.assertTrue(payload["downloaded"])
        self.assertEqual(payload["missingPaths"], [])

    def test_catalog_models_are_labelled_as_catalog(self):
        payload = worker_models.model_to_dict(CATALOG_ENTRY, str(self.root), include_local_state=False)
        self.assertEqual(payload["source"], "catalog")
        # Catalog models have no import mode; the UI uses its absence to keep its own actions apart.
        self.assertIsNone(payload["importMode"])

    def test_the_import_mode_travels_with_the_model(self):
        # This is what lets the removal dialog state whether files will actually be deleted,
        # instead of describing both cases and leaving the user to guess.
        with mock.patch.dict("sys.modules", {
            "worker_custom_models": mock.Mock(sidecar_entry=mock.Mock(return_value={"importMode": "copy"})),
        }):
            payload = worker_models.model_to_dict(FakeUserModelEntry("m", self.weights))
        self.assertEqual(payload["importMode"], "copy")

    def test_a_model_registered_outside_the_app_reads_as_a_reference(self):
        # `pymss register` leaves no side-car. Assuming 'copy' would let the UI promise a file
        # deletion that must never happen.
        with mock.patch.dict("sys.modules", {
            "worker_custom_models": mock.Mock(sidecar_entry=mock.Mock(return_value={})),
        }):
            payload = worker_models.model_to_dict(FakeUserModelEntry("m", self.weights))
        self.assertEqual(payload["importMode"], "reference")

    def test_an_unreadable_sidecar_falls_back_to_reference(self):
        with mock.patch.dict("sys.modules", {
            "worker_custom_models": mock.Mock(sidecar_entry=mock.Mock(side_effect=OSError("denied"))),
        }):
            payload = worker_models.model_to_dict(FakeUserModelEntry("m", self.weights))
        self.assertEqual(payload["importMode"], "reference")

    def test_a_size_is_measured_when_the_registration_records_none(self):
        # Registration never stores a size, so without measuring, every card would read 0 bytes.
        payload = worker_models.model_to_dict(FakeUserModelEntry("my_model", self.weights, self.config))
        self.assertEqual(payload["sizeBytes"], 3072)

    def test_a_recorded_size_is_preferred_over_measuring(self):
        entry = FakeUserModelEntry("my_model", self.weights, self.config, size_bytes=999)
        self.assertEqual(worker_models.model_to_dict(entry)["sizeBytes"], 999)

    def test_a_missing_weight_file_is_reported_rather_than_measured_as_zero(self):
        entry = FakeUserModelEntry("gone", self.root / "absent.ckpt")
        payload = worker_models.model_to_dict(entry)
        self.assertFalse(payload["downloaded"])
        self.assertEqual(payload["missingPaths"], [str(self.root / "absent.ckpt")])
        self.assertEqual(payload["sizeBytes"], 0)

    def test_stems_are_read_from_the_registered_config(self):
        # This is what lets the separation page offer stem selection for an imported model.
        payload = worker_models.model_to_dict(FakeUserModelEntry("my_model", self.weights, self.config))
        self.assertEqual(payload["configInstruments"], "vocals|instrumental")
        self.assertEqual(payload["configTargetInstrument"], "vocals")
        self.assertEqual(payload["targetStem"], "")


class DebugCatalogPayloadValidationTests(unittest.TestCase):
    def _payload(self, **overrides):
        model = {
            "name": "debug_model.ckpt",
            "relpath": "debug/debug_model.ckpt",
            "config_relpath": "debug/debug_model.yaml",
            "auxiliary_relpaths": ["debug/debug_model.json"],
        }
        model.update(overrides)
        return {"schema_version": 1, "models": [model]}

    def test_normalizes_valid_auxiliary_relpaths(self):
        result = worker_models._validate_catalog_payload(self._payload(auxiliary_relpaths=["debug\\extra.json"]))

        self.assertEqual(result["models"][0]["auxiliary_relpaths"], ["debug/extra.json"])

    def test_rejects_auxiliary_relpaths_when_not_an_array(self):
        with self.assertRaisesRegex(ValueError, "auxiliary_relpaths must be an array"):
            worker_models._validate_catalog_payload(self._payload(auxiliary_relpaths="debug/extra.json"))

    def test_rejects_unsafe_auxiliary_relpath(self):
        with self.assertRaisesRegex(ValueError, "safe relative path"):
            worker_models._validate_catalog_payload(self._payload(auxiliary_relpaths=["../outside.json"]))

    def test_rejects_missing_weight_relpath(self):
        with self.assertRaisesRegex(ValueError, "relpath is required"):
            worker_models._validate_catalog_payload(self._payload(relpath=""))


class ListMergesImportedModelsTests(unittest.TestCase):
    """Imported models must appear alongside catalog ones, or importing a model would leave it
    invisible everywhere except inference."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.weights = self.root / "my_model.ckpt"
        self.weights.write_bytes(b"x" * 512)
        self.stdout = io.StringIO()

    def _list(self, payload, user_entries, raises=None):
        user_models = mock.Mock()
        if raises is not None:
            user_models.list_user_models.side_effect = raises
        else:
            user_models.list_user_models.return_value = user_entries
        with mock.patch.dict("sys.modules", {"pymss": mock.Mock(), "pymss.user_models": user_models}), \
             mock.patch.object(worker_models, "list_catalog_models", return_value=[CATALOG_ENTRY]), \
             mock.patch.object(worker_models, "model_root", return_value=self.root), \
             redirect_stdout(self.stdout):
            code = worker_models.cmd_list_models(payload)
        events = [json.loads(line) for line in self.stdout.getvalue().strip().splitlines() if line.strip()]
        return code, events[-1]["payload"]

    def test_imported_models_are_listed_with_catalog_models(self):
        entry = FakeUserModelEntry("my_model", self.weights)
        code, payload = self._list({}, [entry])
        self.assertEqual(code, 0)
        by_source = {m["name"]: m["source"] for m in payload["models"]}
        self.assertEqual(by_source, {"catalog_model.ckpt": "catalog", "my_model": "user"})
        self.assertEqual(payload["count"], 2)

    def test_imported_models_can_be_excluded(self):
        entry = FakeUserModelEntry("my_model", self.weights)
        _, payload = self._list({"includeCustom": False}, [entry])
        self.assertEqual([m["name"] for m in payload["models"]], ["catalog_model.ckpt"])

    def test_an_unreadable_registry_does_not_break_the_model_list(self):
        # The catalog is what the app primarily needs; a broken registry must degrade, not fail.
        code, payload = self._list({}, [], raises=RuntimeError("corrupt registry"))
        self.assertEqual(code, 0)
        self.assertEqual([m["name"] for m in payload["models"]], ["catalog_model.ckpt"])

    def test_the_custom_category_is_offered_for_filtering(self):
        entry = FakeUserModelEntry("my_model", self.weights)
        _, payload = self._list({}, [entry])
        self.assertIn("user/custom", payload["categories"])

    def test_a_category_filter_applies_to_imported_models_too(self):
        entry = FakeUserModelEntry("my_model", self.weights)
        kept = worker_models.list_registered_user_models
        with mock.patch.dict("sys.modules", {
            "pymss": mock.Mock(),
            "pymss.user_models": mock.Mock(list_user_models=mock.Mock(return_value=[entry])),
        }):
            self.assertEqual(kept(category="user"), [entry])
            self.assertEqual(kept(category="user/custom"), [entry])
            self.assertEqual(kept(category="vocal"), [])


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
