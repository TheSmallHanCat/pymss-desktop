from __future__ import annotations

import json
import os
import platform
import sys
import traceback
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from worker_protocol import WORKER_VERSION, _as_bool, _as_float, _as_int, emit, emit_error, import_available


def package_version(distribution: str) -> str | None:
    try:
        from importlib.metadata import version
        return version(distribution)
    except Exception:
        return None


@dataclass(frozen=True)
class ModelEntry:
    name: str
    aliases: tuple[str, ...]
    model_type: str | None
    architecture: str
    supported: bool
    unsupported_reason: str
    relpath: str
    config_relpath: str
    auxiliary_relpaths: tuple[str, ...]
    size_bytes: int
    sha256: str
    primary_category: str
    primary_category_cn: str
    secondary_category: str
    secondary_category_cn: str
    target_stem: str
    config_instruments: str
    config_target_instrument: str
    classification_confidence: str
    classification_basis: str
    debug_source: str = ""

    @property
    def stem(self) -> str:
        return Path(self.name).stem

    @property
    def category_path(self) -> str:
        return "/".join(part for part in (self.primary_category, self.secondary_category) if part)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ModelEntry":
        return cls(
            name=data["name"],
            aliases=tuple(data.get("aliases", ())),
            model_type=data.get("model_type"),
            architecture=data.get("architecture", ""),
            supported=bool(data.get("supported", False)),
            unsupported_reason=data.get("unsupported_reason", ""),
            relpath=data["relpath"],
            config_relpath=data.get("config_relpath", ""),
            auxiliary_relpaths=tuple(data.get("auxiliary_relpaths", ())),
            size_bytes=int(data.get("size_bytes", 0)),
            sha256=data.get("sha256", ""),
            primary_category=data.get("primary_category", ""),
            primary_category_cn=data.get("primary_category_cn", ""),
            secondary_category=data.get("secondary_category", ""),
            secondary_category_cn=data.get("secondary_category_cn", ""),
            target_stem=data.get("target_stem", ""),
            config_instruments=data.get("config_instruments", ""),
            config_target_instrument=data.get("config_target_instrument", ""),
            classification_confidence=data.get("classification_confidence", ""),
            classification_basis=data.get("classification_basis", ""),
            debug_source=data.get("debug_source", ""),
        )


def _model_catalog_path() -> Path:
    try:
        import pymss  # type: ignore
        package_dir = Path(pymss.__file__).resolve().parent
        direct = package_dir / "resources" / "model_catalog.json"
        if direct.is_file():
            return direct
    except ImportError:
        # Online bootstrap installs pymss without heavy ML dependencies. Locate its
        # catalog through distribution metadata without executing pymss.__init__.
        try:
            from importlib.metadata import distribution

            package = distribution("pymss")
            for file in package.files or ():
                if str(file).replace("\\", "/") == "pymss/resources/model_catalog.json":
                    catalog = Path(package.locate_file(file)).resolve()
                    if catalog.is_file():
                        return catalog
        except Exception:
            pass
    raise FileNotFoundError("Unable to locate pymss/resources/model_catalog.json")


def _debug_dir() -> Path:
    return Path(
        os.environ.get("PYMSS_STUDIO_DEBUG_DIR")
        or Path.home() / ".cache" / "pymss-studio" / "debug"
    )


def _debug_catalog_path() -> Path:
    return _debug_dir() / "model-catalog.json"


def _json_stable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _entry_to_catalog_dict(entry: ModelEntry) -> dict[str, Any]:
    return {
        "name": entry.name,
        "aliases": list(entry.aliases),
        "model_type": entry.model_type,
        "architecture": entry.architecture,
        "supported": entry.supported,
        "unsupported_reason": entry.unsupported_reason,
        "relpath": entry.relpath,
        "config_relpath": entry.config_relpath,
        "auxiliary_relpaths": list(entry.auxiliary_relpaths),
        "size_bytes": entry.size_bytes,
        "sha256": entry.sha256,
        "primary_category": entry.primary_category,
        "primary_category_cn": entry.primary_category_cn,
        "secondary_category": entry.secondary_category,
        "secondary_category_cn": entry.secondary_category_cn,
        "target_stem": entry.target_stem,
        "config_instruments": entry.config_instruments,
        "config_target_instrument": entry.config_target_instrument,
        "classification_confidence": entry.classification_confidence,
        "classification_basis": entry.classification_basis,
    }


def _base_catalog_data() -> dict[str, Any]:
    with _model_catalog_path().open(encoding="utf-8") as handle:
        return json.load(handle)


def _debug_catalog_raw() -> dict[str, Any]:
    path = _debug_catalog_path()
    if not path.is_file():
        return {"schema_version": 1, "models": []}
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else {"schema_version": 1, "models": []}


def _inactive_debug_status() -> dict[str, Any]:
    return {
        "active": False,
        "catalogActive": False,
        "changedCount": 0,
        "addedCount": 0,
        "removedCount": 0,
        "changedModels": [],
        "addedModels": [],
        "removedModels": [],
        "debugDir": str(_debug_dir()),
        "debugCatalogPath": str(_debug_catalog_path()),
    }


def _debug_catalog_status(base_data: dict[str, Any] | None = None) -> dict[str, Any]:
    base_data = base_data or _base_catalog_data()
    base_by_name = {
        str(item.get("name") or ""): item
        for item in base_data.get("models", [])
        if isinstance(item, dict) and item.get("name")
    }
    path = _debug_catalog_path()
    override = _debug_catalog_raw() if path.is_file() else {"models": list(base_by_name.values())}
    override_models = [item for item in override.get("models", []) if isinstance(item, dict) and item.get("name")]
    override_names = {str(item["name"]) for item in override_models}
    removed = sorted(
        set(str(item) for item in override.get("removed", []) if str(item).strip())
        | {name for name in base_by_name if name not in override_names}
    )
    changed = [
        str(item["name"])
        for item in override_models
        if str(item["name"]) in base_by_name and _json_stable(item) != _json_stable(base_by_name[str(item["name"])])
    ]
    added = [str(item["name"]) for item in override_models if str(item["name"]) not in base_by_name]
    active = bool(changed or added or removed)
    return {
        "active": active,
        "catalogActive": bool(changed or added or removed),
        "changedCount": len(changed),
        "addedCount": len(added),
        "removedCount": len(removed),
        "changedModels": changed,
        "addedModels": added,
        "removedModels": removed,
        "debugDir": str(_debug_dir()),
        "debugCatalogPath": str(_debug_catalog_path()),
    }


def _default_model_dir() -> Path:
    env_value = os.environ.get("PYMSS_MODEL_DIR")
    if env_value:
        return Path(env_value)
    repo_models = _model_catalog_path().parent.parent.parent / "all_models"
    if repo_models.is_dir():
        return repo_models
    return Path.home() / ".cache" / "pymss" / "models"


def _load_yaml_config(config_path: Path) -> dict[str, Any]:
    with config_path.open(encoding="utf-8") as handle:
        data = yaml.load(handle, Loader=yaml.FullLoader)
    return data if isinstance(data, dict) else {}


@lru_cache(maxsize=1)
def load_model_catalog() -> dict[str, Any]:
    with _model_catalog_path().open(encoding="utf-8") as handle:
        data = json.load(handle)
    base_models = data.get("models", [])
    base_by_name = {str(item.get("name") or ""): item for item in base_models if item.get("name")}

    override_path = _debug_catalog_path()
    if override_path.is_file():
        with override_path.open(encoding="utf-8") as handle:
            override = json.load(handle)
        models: list[ModelEntry] = []
        removed = {str(name) for name in override.get("removed", []) if str(name).strip()}
        for item in override.get("models", []) if isinstance(override.get("models"), list) else []:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            name = str(item["name"])
            next_item = dict(item)
            if name not in base_by_name or _json_stable(item) != _json_stable(base_by_name[name]):
                next_item["debug_source"] = "debug"
            if name not in removed:
                models.append(ModelEntry.from_dict(next_item))
        return {**data, **override, "models": models, "debug_status": _debug_catalog_status(data)}

    models = [ModelEntry.from_dict(item) for item in base_models]
    return {**data, "models": models, "debug_status": _debug_catalog_status(data)}


@lru_cache(maxsize=1)
def _model_index() -> dict[str, ModelEntry]:
    index: dict[str, ModelEntry] = {}
    for entry in load_model_catalog()["models"]:
        names = {entry.name, entry.stem, *entry.aliases}
        for name in names:
            key = str(name).strip().lower()
            if key in index and index[key].name != entry.name:
                continue
            index[key] = entry
    return index


def list_catalog_models(category: str | None = None, supported: bool | None = None) -> list[ModelEntry]:
    models = load_model_catalog()["models"]
    if category:
        category = category.lower()
        models = [
            item
            for item in models
            if item.primary_category.lower() == category
            or item.secondary_category.lower() == category
            or item.category_path.lower() == category
        ]
    if supported is not None:
        models = [item for item in models if item.supported is bool(supported)]
    return models


def get_catalog_model_entry(model_name: str) -> ModelEntry:
    try:
        return _model_index()[str(model_name).strip().lower()]
    except KeyError as exc:
        raise KeyError(f"Unknown pymss model: {model_name}") from exc


def model_root(model_dir: str | None = None) -> Path:
    return Path(model_dir).expanduser() if model_dir else _default_model_dir()


def is_user_model_entry(entry: Any) -> bool:
    """Whether `entry` is a pymss UserModelEntry rather than a catalog ModelEntry.

    The two describe their files in incompatible ways: a catalog entry stores a `relpath`
    relative to the model directory, while a user entry stores absolute `model_path` /
    `config_path` and leaves `relpath` empty. Feeding a user entry through the catalog
    computation therefore yields the model directory itself — a path that silently exists
    and points at the wrong thing, rather than failing."""
    return str(getattr(entry, "source", "") or "") == "user"


def model_path_for(entry: Any, model_dir: str | None = None) -> Path:
    if is_user_model_entry(entry):
        return Path(str(entry.model_path))
    return model_root(model_dir) / entry.relpath


def config_path_for(entry: Any, model_dir: str | None = None) -> Path | None:
    if is_user_model_entry(entry):
        config_path = getattr(entry, "config_path", None)
        return Path(str(config_path)) if config_path else None
    return model_root(model_dir) / entry.config_relpath if entry.config_relpath else None


def base_config_path_for(entry: Any, model_dir: str | None = None) -> Path | None:
    if is_user_model_entry(entry):
        config_path = getattr(entry, "config_path", None)
        return Path(str(config_path)) if config_path else None
    return model_root(model_dir) / entry.config_relpath if entry.config_relpath else None


def effective_source_for(entry: Any) -> str:
    if is_user_model_entry(entry):
        return "user"
    if str(getattr(entry, "debug_source", "") or "") == "debug":
        return "debug"
    return "catalog"


def auxiliary_paths_for(entry: Any, model_dir: str | None = None) -> list[Path]:
    if is_user_model_entry(entry):
        # User registrations name their files outright, so anything here is already absolute.
        return [Path(str(relpath)) for relpath in getattr(entry, "auxiliary_relpaths", ()) or ()]
    root = model_root(model_dir)
    return [root / relpath for relpath in entry.auxiliary_relpaths]

def _derive_overlap_size_from_num_overlap(chunk_size: Any, num_overlap: Any) -> int | None:
    chunk_value = _as_int(chunk_size)
    overlap_count = _as_int(num_overlap)
    if chunk_value is None or overlap_count is None:
        return None
    if chunk_value <= 0 or overlap_count <= 0:
        return None
    if overlap_count == 1:
        return None
    step = int(chunk_value // overlap_count)
    overlap_size = int(chunk_value - step)
    if overlap_size < 0 or overlap_size >= chunk_value:
        return None
    return overlap_size


def resolve_default_inference_params(entry: Any, model_path: Path, config_path: Path | None) -> dict[str, Any]:
    model_type = str(getattr(entry, "model_type", "") or "").strip().lower()
    defaults: dict[str, Any] = {}

    if not config_path or not config_path.is_file():
        if model_type == "vr":
            return {
                "batch_size": 2,
                "window_size": 512,
                "aggression": 5,
                "enable_post_process": False,
                "post_process_threshold": 0.2,
                "high_end_process": False,
                "normalize": False,
            }
        return {
            "batch_size": 1,
            "overlap_size": 0,
            "chunk_size": 0,
            "normalize": False,
        }

    try:
        config = _load_yaml_config(config_path)
    except Exception:
        return defaults

    inference = config.get("inference") if isinstance(config, dict) else None
    audio = config.get("audio") if isinstance(config, dict) else None
    inference = inference if isinstance(inference, dict) else {}
    audio = audio if isinstance(audio, dict) else {}

    if model_type == "vr":
        batch_size = _as_int(inference.get("batch_size"))
        window_size = _as_int(inference.get("window_size"))
        aggression = _as_int(inference.get("aggression"))
        enable_post_process = _as_bool(inference.get("enable_post_process"))
        post_process_threshold = _as_float(inference.get("post_process_threshold"))
        high_end_process = _as_bool(inference.get("high_end_process"))

        if batch_size is not None:
            defaults["batch_size"] = batch_size
        if window_size is not None:
            defaults["window_size"] = window_size
        if aggression is not None:
            defaults["aggression"] = aggression
        if enable_post_process is not None:
            defaults["enable_post_process"] = enable_post_process
        if post_process_threshold is not None:
            defaults["post_process_threshold"] = post_process_threshold
        if high_end_process is not None:
            defaults["high_end_process"] = high_end_process
        return defaults

    batch_size = _as_int(inference.get("batch_size"))
    overlap_size = _as_int(inference.get("overlap_size"))
    num_overlap = _as_int(inference.get("num_overlap"))
    chunk_size = _as_int(audio.get("chunk_size"))
    if chunk_size is None:
        chunk_size = _as_int(inference.get("chunk_size"))
    normalize = _as_bool(inference.get("normalize"))

    if batch_size is not None:
        defaults["batch_size"] = batch_size
    if overlap_size is not None:
        defaults["overlap_size"] = overlap_size
    if model_type != "apollo" and num_overlap is not None:
        defaults["num_overlap"] = num_overlap
    if chunk_size is not None:
        defaults["chunk_size"] = chunk_size
    if normalize is not None:
        defaults["normalize"] = normalize
    return defaults


def resolve_config_stems(config_path: Path | None) -> tuple[str, str]:
    if not config_path or not config_path.is_file():
        return "", ""
    try:
        config = _load_yaml_config(config_path)
    except Exception:
        return "", ""
    training = config.get("training") if isinstance(config, dict) else None
    training = training if isinstance(training, dict) else {}
    instruments = training.get("instruments")
    target_instrument = training.get("target_instrument")
    if isinstance(instruments, (list, tuple)):
        config_instruments = "|".join(str(item).strip() for item in instruments if str(item).strip())
    else:
        config_instruments = str(instruments or "").strip()
    return config_instruments, str(target_instrument or "").strip()


def _user_model_import_mode(entry: Any) -> str | None:
    """How an imported model got here: 'copy' (the app holds the files) or 'reference'.

    Carried on the model itself so the UI can say exactly what removing it will do. Models
    registered outside the app (`pymss register`) have no record, and 'reference' is the safe
    reading — it is the one under which no files are deleted."""
    if not is_user_model_entry(entry):
        return None
    try:
        from worker_custom_models import sidecar_entry
        return str(sidecar_entry(str(entry.name)).get("importMode") or "reference")
    except Exception:
        return "reference"


def _entry_size_bytes(entry: Any, model_path: Path) -> int:
    """Size to report for a model.

    Catalog entries carry the published size, which is what lets the UI show a download size
    before anything exists locally. User registrations never record one, so measure the file
    they point at — otherwise every imported model would read as 0 bytes."""
    recorded = int(getattr(entry, "size_bytes", 0) or 0)
    if recorded or not is_user_model_entry(entry):
        return recorded
    try:
        return model_path.stat().st_size
    except OSError:
        return 0


def model_to_dict(entry: Any, model_dir: str | None = None, include_local_state: bool = True) -> dict[str, Any]:
    model_path = model_path_for(entry, model_dir)
    config_path = config_path_for(entry, model_dir)
    auxiliary_paths = auxiliary_paths_for(entry, model_dir)
    required_paths = [model_path]
    if config_path is not None:
        required_paths.append(config_path)
    required_paths.extend(auxiliary_paths)
    missing_paths = [str(path) for path in required_paths if not path.is_file()]
    downloaded = include_local_state and not missing_paths
    config_instruments = str(entry.config_instruments or "").strip()
    config_target_instrument = str(entry.config_target_instrument or "").strip()
    if config_path and config_path.is_file():
        resolved_instruments, resolved_target = resolve_config_stems(config_path)
        config_instruments = resolved_instruments or config_instruments
        config_target_instrument = resolved_target or config_target_instrument
    default_inference_params = resolve_default_inference_params(entry, model_path, config_path)
    default_inference_params_source = "config" if config_path and config_path.is_file() else "runtime_fallback"
    return {
        "name": entry.name,
        "aliases": list(entry.aliases),
        "modelType": entry.model_type,
        "architecture": entry.architecture,
        "supported": bool(entry.supported),
        "unsupportedReason": entry.unsupported_reason,
        "category": entry.category_path or entry.primary_category,
        "categoryCn": " / ".join(filter(None, [entry.primary_category_cn, entry.secondary_category_cn])),
        "primaryCategory": entry.primary_category,
        "primaryCategoryCn": entry.primary_category_cn,
        "secondaryCategory": entry.secondary_category,
        "secondaryCategoryCn": entry.secondary_category_cn,
        "targetStem": entry.target_stem,
        "configInstruments": config_instruments,
        "configTargetInstrument": config_target_instrument,
        "classificationConfidence": entry.classification_confidence,
        "classificationBasis": entry.classification_basis,
        "sizeBytes": _entry_size_bytes(entry, model_path),
        "sha256": getattr(entry, "sha256", "") or "",
        # 'user' models are local-only: they cannot be downloaded (pymss.download_model rejects
        # them outright), so the UI has to offer relink/remove instead of download/delete.
        "source": effective_source_for(entry),
        "baseConfigPath": str(base_config_path_for(entry, model_dir)) if base_config_path_for(entry, model_dir) else None,
        "importMode": _user_model_import_mode(entry),
        "downloaded": downloaded,
        "missingPaths": missing_paths if include_local_state else [],
        "modelPath": str(model_path),
        "configPath": str(config_path) if config_path else None,
        "auxiliaryPaths": [str(path) for path in auxiliary_paths],
        "defaultInferenceParams": default_inference_params,
        "defaultInferenceParamsSource": default_inference_params_source,
    }


def cmd_health() -> int:
    emit("health", {"ok": True, "workerVersion": WORKER_VERSION})
    return 0


def cmd_env_info() -> int:
    payload: dict[str, Any] = {
        "pythonVersion": sys.version.split()[0],
        "platform": platform.platform(),
        "workerVersion": WORKER_VERSION,
        "pymssAvailable": False,
        "pymssPath": None,
        "pymssVersion": package_version("pymss"),
        # Importing local models needs pymss's user-model registry, which only exists from
        # 2.0.15. Probed by import rather than by comparing version strings, so a repackaged or
        # patched build is judged on what it actually provides.
        "customModelsSupported": import_available("pymss.user_models"),
        "torchAvailable": False,
        "torchVersion": None,
        "torchBackend": "missing",
        "hipVersion": None,
        "cudaAvailable": False,
        "cudaDeviceCount": 0,
        "cudaDevices": [],
        "mpsAvailable": False,
        "mlxAvailable": import_available("mlx"),
        "avAvailable": import_available("av"),
        "librosaAvailable": import_available("librosa"),
    }

    try:
        import pymss  # type: ignore
        payload["pymssAvailable"] = True
        payload["pymssPath"] = str(Path(pymss.__file__).resolve()) if getattr(pymss, "__file__", None) else None
        payload["pymssVersion"] = payload.get("pymssVersion") or getattr(pymss, "__version__", None)
    except Exception as exc:
        payload["pymssError"] = str(exc)

    try:
        import torch  # type: ignore
        payload["torchAvailable"] = True
        payload["torchVersion"] = getattr(torch, "__version__", None)
        payload["hipVersion"] = getattr(torch.version, "hip", None)
        payload["torchBackend"] = "rocm" if payload["hipVersion"] else "cuda" if getattr(torch.version, "cuda", None) else "cpu"
        payload["cudaAvailable"] = bool(torch.cuda.is_available())
        payload["cudaDeviceCount"] = int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
        cuda_devices: list[dict[str, Any]] = []
        if torch.cuda.is_available():
            for index in range(int(torch.cuda.device_count())):
                item: dict[str, Any] = {"id": index, "name": torch.cuda.get_device_name(index)}
                try:
                    props = torch.cuda.get_device_properties(index)
                    item["totalMemoryBytes"] = int(getattr(props, "total_memory", 0) or 0)
                    item["major"] = int(getattr(props, "major", 0) or 0)
                    item["minor"] = int(getattr(props, "minor", 0) or 0)
                except Exception:
                    pass
                cuda_devices.append(item)
        payload["cudaDevices"] = cuda_devices
        mps = getattr(torch.backends, "mps", None)
        payload["mpsAvailable"] = bool(mps and mps.is_available())
    except Exception as exc:
        payload["torchError"] = str(exc)

    emit("env_info", payload)
    return 0


def list_registered_user_models(category: str | None = None) -> list[Any]:
    """Locally registered custom models, or an empty list when none can be read.

    Never raises: an unreadable registry must not take the whole model list down with it, since
    the catalog is what the app primarily needs. Filtering mirrors list_catalog_models() so a
    category selection applies to both halves of the list.

    `supported` is deliberately not filtered on — pymss registers every user model as supported
    (it has no catalog verdict to consult), so filtering would be a no-op that reads as a check."""
    try:
        from pymss.user_models import list_user_models  # type: ignore
        entries = list(list_user_models())
    except Exception:
        return []
    if category:
        wanted = category.lower()
        entries = [
            entry for entry in entries
            if str(getattr(entry, "primary_category", "")).lower() == wanted
            or str(getattr(entry, "secondary_category", "")).lower() == wanted
            or str(getattr(entry, "category_path", "")).lower() == wanted
        ]
    return entries


def _validate_catalog_payload(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("Catalog payload must be a JSON object")
    models = data.get("models", [])
    removed = data.get("removed", [])
    if not isinstance(models, list):
        raise ValueError("Catalog field 'models' must be an array")
    if not isinstance(removed, list):
        raise ValueError("Catalog field 'removed' must be an array")
    seen: set[str] = set()
    normalized_models: list[dict[str, Any]] = []

    def safe_relpath(model_name: str, field: str, value: Any, *, required: bool = False) -> str:
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise ValueError(f"{model_name}.{field} must be a string")
        relpath = value.strip().replace("\\", "/")
        if required and not relpath:
            raise ValueError(f"{model_name}.{field} is required")
        if relpath and (Path(relpath).is_absolute() or ".." in Path(relpath).parts):
            raise ValueError(f"{model_name}.{field} must be a safe relative path")
        return relpath

    for index, item in enumerate(models):
        if not isinstance(item, dict):
            raise ValueError(f"models[{index}] must be an object")
        name = str(item.get("name") or "").strip()
        if not name:
            raise ValueError(f"models[{index}].name is required")
        if name in seen:
            raise ValueError(f"Duplicated model name: {name}")
        seen.add(name)
        normalized_item = dict(item)
        normalized_item["name"] = name
        normalized_item["relpath"] = safe_relpath(name, "relpath", item.get("relpath"), required=True)
        normalized_item["config_relpath"] = safe_relpath(name, "config_relpath", item.get("config_relpath"))
        auxiliary_relpaths = item.get("auxiliary_relpaths", [])
        if not isinstance(auxiliary_relpaths, list):
            raise ValueError(f"{name}.auxiliary_relpaths must be an array")
        normalized_auxiliary_relpaths: list[str] = []
        for auxiliary_index, auxiliary_relpath in enumerate(auxiliary_relpaths):
            normalized_auxiliary_relpaths.append(
                safe_relpath(name, f"auxiliary_relpaths[{auxiliary_index}]", auxiliary_relpath, required=True)
            )
        normalized_item["auxiliary_relpaths"] = normalized_auxiliary_relpaths
        normalized_models.append(normalized_item)
    normalized = dict(data)
    normalized["schema_version"] = int(data.get("schema_version") or 1)
    normalized["models"] = normalized_models
    removed_models = [str(item).strip() for item in removed if str(item).strip()]
    if removed_models:
        normalized["removed"] = removed_models
    else:
        normalized.pop("removed", None)
    return normalized


def cmd_debug_catalog_info(payload: dict[str, Any] | None = None) -> int:
    try:
        base_data = _base_catalog_data()
        override = _debug_catalog_raw()
        emit("debug_catalog_info", {
            "baseCatalogPath": str(_model_catalog_path()),
            "debugCatalogPath": str(_debug_catalog_path()),
            "debugDir": str(_debug_dir()),
            "baseCatalog": base_data,
            "debugCatalog": override,
            "effectiveCatalog": {
                **base_data,
                "models": [_entry_to_catalog_dict(entry) for entry in load_model_catalog()["models"]],
            },
            "status": _debug_catalog_status(base_data),
        })
        return 0
    except Exception as exc:
        return emit_error("DEBUG_CATALOG_INFO_FAILED", str(exc), traceback.format_exc())


def cmd_debug_catalog_save(payload: dict[str, Any]) -> int:
    try:
        data = payload.get("catalog", payload)
        normalized = _validate_catalog_payload(data)
        path = _debug_catalog_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(normalized, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        load_model_catalog.cache_clear()
        _model_index.cache_clear()
        return cmd_debug_catalog_info({})
    except Exception as exc:
        return emit_error("DEBUG_CATALOG_SAVE_FAILED", str(exc), traceback.format_exc())


def cmd_debug_catalog_reset(payload: dict[str, Any] | None = None) -> int:
    try:
        path = _debug_catalog_path()
        if path.is_file():
            path.unlink()
        load_model_catalog.cache_clear()
        _model_index.cache_clear()
        return cmd_debug_catalog_info({})
    except Exception as exc:
        return emit_error("DEBUG_CATALOG_RESET_FAILED", str(exc), traceback.format_exc())


def _read_text(path: Path | None) -> str:
    if not path or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def cmd_debug_model_config(payload: dict[str, Any]) -> int:
    try:
        action = str(payload.get("action") or "read")
        model_name = str(payload.get("model") or "").strip()
        if not model_name:
            raise ValueError("Missing model name")
        entry = get_any_model_entry(model_name)
        model_dir = payload.get("modelDir") or None
        if is_user_model_entry(entry) and action != "read":
            raise ValueError("Imported user models are read-only in Debug")

        base_path = base_config_path_for(entry, model_dir)

        if action in {"save", "save_downloaded"}:
            content = str(payload.get("content") or "")
            yaml.load(content, Loader=yaml.FullLoader)
            if base_path is None:
                raise ValueError("This model does not have a config path")
            base_path.parent.mkdir(parents=True, exist_ok=True)
            base_path.write_text(content, encoding="utf-8", newline="\n")
        elif action == "reset":
            pass
        elif action != "read":
            raise ValueError(f"Unsupported debug model config action: {action}")

        load_model_catalog.cache_clear()
        _model_index.cache_clear()
        next_entry = get_any_model_entry(model_name)
        next_base_path = base_config_path_for(next_entry, model_dir)
        effective_path = config_path_for(next_entry, model_dir)
        emit("debug_model_config", {
            "model": str(getattr(next_entry, "name", model_name)),
            "source": effective_source_for(next_entry),
            "readOnly": is_user_model_entry(next_entry),
            "baseConfigPath": str(next_base_path) if next_base_path else None,
            "effectiveConfigPath": str(effective_path) if effective_path else None,
            "baseContent": _read_text(next_base_path),
            "effectiveContent": _read_text(effective_path),
            "downloadedConfigExists": bool(next_base_path and next_base_path.is_file()),
            "status": _debug_catalog_status(),
        })
        return 0
    except Exception as exc:
        return emit_error("DEBUG_MODEL_CONFIG_FAILED", str(exc), traceback.format_exc())


def cmd_list_models(payload: dict[str, Any]) -> int:
    category = payload.get("category") or None
    supported_only = bool(payload.get("supportedOnly", True))
    include_local_state = bool(payload.get("includeLocalState", True))
    include_custom = bool(payload.get("includeCustom", True))
    model_dir = payload.get("modelDir") or None

    try:
        catalog_state = load_model_catalog()
    except Exception:
        catalog_state = {}
    entries: list[Any] = list(list_catalog_models(category=category, supported=True if supported_only else None))
    if include_custom:
        # Appended after the catalog so the default ordering keeps imported models together at
        # the end; the UI sorts on top of this anyway.
        entries.extend(list_registered_user_models(category=category))
    models = [model_to_dict(entry, model_dir, include_local_state) for entry in entries]
    category_pairs = sorted({
        (m["category"], m.get("categoryCn") or m["category"])
        for m in models
        if m.get("category")
    }, key=lambda item: item[1] or item[0])
    debug_status = catalog_state.get("debug_status") if isinstance(catalog_state, dict) else None
    emit("models", {
        "models": models,
        "categories": [item[0] for item in category_pairs],
        "categoriesCn": [item[1] for item in category_pairs],
        "count": len(models),
        "modelDir": str(model_root(model_dir)),
        "debugStatus": debug_status if isinstance(debug_status, dict) else _inactive_debug_status(),
    })
    return 0


def get_any_model_entry(model_name: str) -> Any:
    """Resolve a name against imported models first, then the catalog.

    Same precedence as pymss's own get_model_entry(), which is what inference resolves through —
    so a name means the same thing everywhere in the app."""
    try:
        from pymss.user_models import get_user_model_entry  # type: ignore
        return get_user_model_entry(model_name)
    except Exception:
        pass
    return get_catalog_model_entry(model_name)


def cmd_model_info(payload: dict[str, Any]) -> int:
    model_name = payload.get("model")
    if not model_name:
        return emit_error("MODEL_NOT_FOUND", "Missing model name")
    try:
        entry = get_any_model_entry(model_name)
    except KeyError as exc:
        return emit_error("MODEL_NOT_FOUND", str(exc))

    model_dir = payload.get("modelDir") or None
    emit("model_info", model_to_dict(entry, model_dir, include_local_state=True))
    return 0


def cmd_delete_model(payload: dict[str, Any]) -> int:
    task_id = payload.get("taskId") or None
    model_name = payload.get("model")
    if not model_name:
        emit("model_delete_failed", {
            "model": "",
            "deleted": [],
            "errors": ["Missing model name"],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": "Missing model name",
        }, task_id=task_id)
        return 1

    model_dir = payload.get("modelDir") or None

    def fail(message: str) -> int:
        emit("model_delete_failed", {
            "model": model_name,
            "deleted": [],
            "errors": [message],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": message,
        }, task_id=task_id)
        return 1

    # Deliberately NOT importing pymss's path helpers: they are catalog-only and would shadow
    # the source-aware ones in this module. get_model_entry is imported for its user-model
    # lookup, which is what lets the guard below recognise an imported model.
    try:
        from pymss.model_registry import get_model_entry  # type: ignore
    except Exception as exc:
        return fail(str(exc))

    try:
        entry = get_model_entry(model_name)
    except KeyError as exc:
        return fail(str(exc))

    # An imported model's weights are the user's own file, often outside the app entirely.
    # Deleting it here would be an unrecoverable surprise, so removal goes through
    # unregister_custom_model, which unregisters by default and only touches files it copied.
    if is_user_model_entry(entry):
        return fail(
            f"{model_name} is an imported custom model; remove it from the custom model list instead"
        )

    model_path = model_path_for(entry, model_dir)
    config_path = config_path_for(entry, model_dir)
    auxiliary_paths = auxiliary_paths_for(entry, model_dir)

    def expand_cleanup_paths(path: Path) -> list[Path]:
        part_path = path.with_name(path.name + ".part")
        return [
            path,
            Path(str(path) + ".aria2"),
            part_path,
            Path(str(part_path) + ".aria2"),
        ]

    candidate_roots = [model_path, *([config_path] if config_path is not None else []), *auxiliary_paths]
    all_paths: list[Path] = []
    for path in candidate_roots:
        for candidate in expand_cleanup_paths(path):
            if candidate not in all_paths:
                all_paths.append(candidate)

    if task_id is None:
        deleted: list[str] = []
        errors: list[str] = []
        for path in all_paths:
            if not path.is_file():
                continue
            try:
                path.unlink()
                deleted.append(str(path))
            except Exception as exc:
                errors.append(f"{path}: {exc}")
        emit("model_deleted", {
            "model": entry.name,
            "deleted": deleted,
            "errors": errors,
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        })
        return 0

    existing_paths = [path for path in all_paths if path.is_file()]
    total_files = len(existing_paths)
    deleted: list[str] = []
    errors: list[str] = []

    emit("model_delete_started", {
        "model": entry.name,
        "totalFiles": total_files,
        "completedFiles": 0,
        "progress": 0,
        "message": "Deleting model files",
    }, task_id=task_id)

    try:
        for index, path in enumerate(existing_paths, start=1):
            try:
                path.unlink()
                deleted.append(str(path))
            except Exception as exc:
                detail = f"{path}: {exc}"
                errors.append(detail)
                emit("model_delete_failed", {
                    "model": entry.name,
                    "deleted": deleted,
                    "errors": errors,
                    "path": str(path),
                    "completedFiles": len(deleted),
                    "totalFiles": total_files,
                    "progress": int((len(deleted) / total_files) * 100) if total_files > 0 else 0,
                    "message": str(exc),
                    "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
                }, task_id=task_id)
                return 1

            emit("model_delete_progress", {
                "model": entry.name,
                "path": str(path),
                "completedFiles": index,
                "totalFiles": total_files,
                "progress": int((index / total_files) * 100) if total_files > 0 else 100,
                "message": "Deleting model files",
            }, task_id=task_id)

        emit("model_delete_done", {
            "model": entry.name,
            "deleted": deleted,
            "errors": errors,
            "completedFiles": total_files,
            "totalFiles": total_files,
            "progress": 100,
            "message": "Deleting model files",
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        }, task_id=task_id)
        return 0
    except Exception as exc:
        errors.append(str(exc))
        emit("model_delete_failed", {
            "model": entry.name,
            "deleted": deleted,
            "errors": errors,
            "completedFiles": len(deleted),
            "totalFiles": total_files,
            "progress": int((len(deleted) / total_files) * 100) if total_files > 0 else 0,
            "message": str(exc),
            "modelInfo": model_to_dict(entry, model_dir, include_local_state=True),
        }, task_id=task_id)
        return 1


def _path_size(path: Path) -> int:
    try:
        if path.is_file():
            return int(path.stat().st_size)
        if path.is_dir():
            return sum(int(f.stat().st_size) for f in path.rglob("*") if f.is_file())
    except Exception:
        return 0
    return 0


def _normalized_path_key(path: Path) -> str:
    return os.path.normcase(str(path.absolute()))


def _scan_root_file_sizes(root: Path) -> dict[str, tuple[Path, int]]:
    scanned: dict[str, tuple[Path, int]] = {}
    if not root.exists():
        return scanned
    for dirpath, _, filenames in os.walk(root):
        base = Path(dirpath)
        for filename in filenames:
            file_path = base / filename
            try:
                size = int(file_path.stat().st_size)
            except Exception:
                continue
            scanned[_normalized_path_key(file_path)] = (file_path, size)
    return scanned


def _required_model_paths(entry: Any, model_dir: str | None) -> list[Path]:
    from pymss.model_registry import auxiliary_paths_for, config_path_for, model_path_for  # type: ignore

    paths = [model_path_for(entry, model_dir)]
    config = config_path_for(entry, model_dir)
    if config is not None:
        paths.append(config)
    paths.extend(auxiliary_paths_for(entry, model_dir))
    return paths


def _storage_summary_payload(model_dir: str | None = None) -> dict[str, Any]:
    from pymss.model_registry import list_models, model_root  # type: ignore

    root = model_root(model_dir)
    scanned_files = _scan_root_file_sizes(root)
    known_file_keys: set[str] = set()
    models: list[dict[str, Any]] = []
    total_bytes = 0
    downloaded_count = 0

    for entry in list_models(supported=None):
        required_paths = _required_model_paths(entry, model_dir)
        files = []
        model_size = 0
        downloaded = True
        for path in required_paths:
            normalized_key = _normalized_path_key(path)
            known_file_keys.add(normalized_key)
            scanned = scanned_files.get(normalized_key)
            if scanned is not None:
                exists = True
                size = scanned[1]
            elif path.is_file():
                exists = True
                size = _path_size(path)
            else:
                exists = False
                size = 0
            if not exists:
                downloaded = False
            model_size += size
            files.append({"path": str(path), "sizeBytes": size, "exists": exists})
        if downloaded:
            downloaded_count += 1
        if model_size > 0:
            total_bytes += model_size
        models.append({
            "name": entry.name,
            "downloaded": downloaded,
            "sizeBytes": model_size,
            "expectedSizeBytes": entry.size_bytes,
            "files": files,
        })

    residual_files: list[dict[str, Any]] = []
    residual_bytes = 0
    for normalized_key, (file_path, size) in scanned_files.items():
        if normalized_key in known_file_keys:
            continue
        residual_files.append({"path": str(file_path), "sizeBytes": size})
        residual_bytes += size

    residual_files.sort(key=lambda item: item["sizeBytes"], reverse=True)
    models.sort(key=lambda item: item["sizeBytes"], reverse=True)
    return {
        "modelDir": str(root),
        "totalBytes": total_bytes,
        "downloadedCount": downloaded_count,
        "models": models,
        "residualFiles": residual_files,
        "residualBytes": residual_bytes,
    }


def cmd_model_storage_summary(payload: dict[str, Any]) -> int:
    model_dir = payload.get("modelDir") or None
    try:
        emit("model_storage_summary", _storage_summary_payload(model_dir))
        return 0
    except Exception as exc:
        return emit_error("MODEL_STORAGE_SUMMARY_FAILED", str(exc), traceback.format_exc())


def cmd_cleanup_model_residual_files(payload: dict[str, Any]) -> int:
    model_dir = payload.get("modelDir") or None
    task_id = payload.get("taskId") or None
    try:
        summary = _storage_summary_payload(model_dir)
        if task_id is None:
            deleted: list[str] = []
            errors: list[str] = []
            for item in summary.get("residualFiles", []):
                path = Path(item.get("path", ""))
                if not path.is_file():
                    continue
                try:
                    path.unlink()
                    deleted.append(str(path))
                except Exception as exc:
                    errors.append(f"{path}: {exc}")
            emit("model_residual_cleaned", {
                "deleted": deleted,
                "errors": errors,
                "modelStorageSummary": _storage_summary_payload(model_dir),
            })
            return 0
        residual_items = [item for item in summary.get("residualFiles", []) if Path(item.get("path", "")).is_file()]
        total_files = len(residual_items)
        deleted: list[str] = []
        errors: list[str] = []

        emit("model_residual_cleanup_started", {
            "totalFiles": total_files,
            "completedFiles": 0,
            "progress": 0,
            "message": "Cleaning residual files",
        }, task_id=task_id)

        for index, item in enumerate(residual_items, start=1):
            path = Path(item.get("path", ""))
            try:
                path.unlink()
                deleted.append(str(path))
            except Exception as exc:
                detail = f"{path}: {exc}"
                errors.append(detail)
                emit("model_residual_cleanup_failed", {
                    "deleted": deleted,
                    "errors": errors,
                    "path": str(path),
                    "completedFiles": len(deleted),
                    "totalFiles": total_files,
                    "progress": int((len(deleted) / total_files) * 100) if total_files > 0 else 0,
                    "message": str(exc),
                    "modelStorageSummary": _storage_summary_payload(model_dir),
                }, task_id=task_id)
                return 1
            emit("model_residual_cleanup_progress", {
                "path": str(path),
                "completedFiles": index,
                "totalFiles": total_files,
                "progress": int((index / total_files) * 100) if total_files > 0 else 100,
                "message": "Cleaning residual files",
            }, task_id=task_id)
        next_summary = _storage_summary_payload(model_dir)
        emit("model_residual_cleanup_done", {
            "deleted": deleted,
            "errors": errors,
            "completedFiles": total_files,
            "totalFiles": total_files,
            "progress": 100,
            "message": "Cleaning residual files",
            "modelStorageSummary": next_summary,
        }, task_id=task_id)
        return 0
    except Exception as exc:
        emit("model_residual_cleanup_failed", {
            "deleted": [],
            "errors": [str(exc)],
            "completedFiles": 0,
            "totalFiles": 0,
            "progress": 0,
            "message": str(exc),
        }, task_id=task_id)
        return 1
