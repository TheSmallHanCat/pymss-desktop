from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from worker_infer import JsonLogHandler, _prepare_separator, normalize_audio_params, resolve_pymss_output_dir
from worker_protocol import emit


EXECUTABLE_NODE_TYPES = {
    "input_audio",
    "separate",
    "load_audio_batch",
    "audio_ensemble",
    "audio_invert_phase",
    "audio_normalize",
}
UTILITY_NODE_TYPES = {
    "load_audio_batch",
    "audio_ensemble",
    "audio_invert_phase",
    "audio_normalize",
}


@dataclass
class AudioArtifact:
    audio: np.ndarray
    sample_rate: int


@dataclass
class SaveTarget:
    source_ref: str
    output_dir: str
    output_label: str


def is_graph_workflow_definition(definition: Any) -> bool:
    return (
        isinstance(definition, dict)
        and definition.get("kind") == "pymss-studio-graph"
        and int(definition.get("version") or 0) == 2
        and isinstance(definition.get("graph"), dict)
    )


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _safe_filename_part(value: str) -> str:
    import re

    safe = re.sub(r"[\\/:\0<>\"|?*]+", "_", str(value or "")).strip()
    return safe or "stem"


def _utility_title(node_type: str) -> str:
    return {
        "load_audio_batch": "batch_input",
        "audio_ensemble": "audio_ensemble",
        "audio_invert_phase": "invert_phase",
        "audio_normalize": "normalize",
    }.get(node_type, node_type or "utility")


def _read_graph(definition: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    graph = definition.get("graph") if isinstance(definition.get("graph"), dict) else {}
    raw_nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    raw_edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
    nodes = {
        str(node.get("id")): node
        for node in raw_nodes
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    }
    edges = [edge for edge in raw_edges if isinstance(edge, dict)]
    save_output_map: dict[str, str] = {}
    for save_node in (node for node in nodes.values() if str(node.get("type") or "") == "save_outputs"):
        save_outputs = save_node.get("data", {}).get("outputs", {}) if _is_record(save_node.get("data")) else {}
        if not isinstance(save_outputs, dict):
            continue
        save_output_map.update({
            str(key): str(value or "").strip()
            for key, value in save_outputs.items()
            if str(key or "").strip()
        })
    return nodes, edges, save_output_map


def _node_position(node: dict[str, Any]) -> tuple[float, float]:
    position = node.get("position")
    if not isinstance(position, dict):
        return 0.0, 0.0
    try:
        return float(position.get("x") or 0.0), float(position.get("y") or 0.0)
    except (TypeError, ValueError):
        return 0.0, 0.0


def _source_ref_for_edge(nodes: dict[str, dict[str, Any]], edge: dict[str, Any]) -> str:
    source = edge.get("source") if isinstance(edge.get("source"), dict) else {}
    node_id = str(source.get("nodeId") or "").strip()
    port_id = str(source.get("portId") or "").strip()
    node = nodes.get(node_id)
    if not node:
        return ""
    node_type = str(node.get("type") or "").strip()
    if node_type in {"input_audio", "load_audio_batch"}:
        return "input" if node_type == "input_audio" else f"utility:{node_id}"
    if node_type == "separate" and port_id.startswith("stem:"):
        return f"{node_id}.{port_id[5:]}"
    if node_type in UTILITY_NODE_TYPES and port_id == "audio":
        return f"utility:{node_id}"
    return ""


def _node_data(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    return data if isinstance(data, dict) else {}


def _separate_stems(node: dict[str, Any]) -> list[str]:
    stems = _node_data(node).get("stems")
    if not isinstance(stems, list):
        return []
    return [str(item or "").strip() for item in stems if str(item or "").strip()]


def _utility_input_count(node: dict[str, Any]) -> int:
    try:
        return max(2, min(10, int(_node_data(node).get("inputCount") or 2)))
    except (TypeError, ValueError):
        return 2


def _source_port_is_valid(node: dict[str, Any], port_id: str) -> bool:
    node_type = str(node.get("type") or "").strip()
    if node_type == "input_audio":
        return port_id == "audio"
    if node_type == "separate":
        if not port_id.startswith("stem:"):
            return False
        stem = port_id[5:].strip().lower()
        return bool(stem and stem in {item.lower() for item in _separate_stems(node)})
    if node_type in UTILITY_NODE_TYPES:
        return port_id == "audio"
    return False


def _target_port_is_valid(node: dict[str, Any], port_id: str) -> bool:
    node_type = str(node.get("type") or "").strip()
    if node_type == "separate":
        return port_id == "input"
    if node_type == "save_outputs":
        return port_id.startswith("save:")
    if node_type == "audio_ensemble":
        if not port_id.startswith("input:"):
            return False
        try:
            index = int(port_id.split(":", 1)[1])
        except (IndexError, ValueError):
            return False
        return 0 <= index < _utility_input_count(node)
    if node_type in {"audio_invert_phase", "audio_normalize"}:
        return port_id == "input"
    return False


def _required_input_ports(node: dict[str, Any]) -> list[str]:
    node_type = str(node.get("type") or "").strip()
    if node_type == "audio_ensemble":
        return [f"input:{index}" for index in range(_utility_input_count(node))]
    if node_type in {"audio_invert_phase", "audio_normalize"}:
        return ["input"]
    return []


def _validate_graph_definition(nodes: dict[str, dict[str, Any]], edges: list[dict[str, Any]]) -> None:
    if "input" not in nodes:
        raise ValueError("Workflow graph is missing the input node.")
    if not any(str(node.get("type") or "") == "save_outputs" for node in nodes.values()):
        raise ValueError("Workflow graph is missing the save outputs node.")

    incoming_ports: dict[tuple[str, str], int] = {}
    valid_save_targets = 0
    for edge in edges:
        source = edge.get("source") if isinstance(edge.get("source"), dict) else {}
        target = edge.get("target") if isinstance(edge.get("target"), dict) else {}
        source_id = str(source.get("nodeId") or "").strip()
        source_port = str(source.get("portId") or "").strip()
        target_id = str(target.get("nodeId") or "").strip()
        target_port = str(target.get("portId") or "").strip()
        source_node = nodes.get(source_id)
        target_node = nodes.get(target_id)
        if not source_node or not target_node:
            raise ValueError(f"Workflow graph contains a dangling connection: {source_id or '?'}:{source_port or '?'} -> {target_id or '?'}:{target_port or '?'}.")
        if not _source_port_is_valid(source_node, source_port):
            raise ValueError(f"Workflow graph connection uses an unavailable source port: {source_id}:{source_port}.")
        if not _target_port_is_valid(target_node, target_port):
            raise ValueError(f"Workflow graph connection uses an unavailable target port: {target_id}:{target_port}.")
        endpoint = (target_id, target_port)
        incoming_ports[endpoint] = incoming_ports.get(endpoint, 0) + 1
        if str(target_node.get("type") or "") == "save_outputs":
            valid_save_targets += 1

    duplicates = [f"{node_id}:{port_id}" for (node_id, port_id), count in incoming_ports.items() if count > 1]
    if duplicates:
        raise ValueError(f"Workflow graph contains duplicate connections to the same input: {', '.join(sorted(duplicates))}.")

    missing_inputs: list[str] = []
    for node_id, node in nodes.items():
        for port_id in _required_input_ports(node):
            if (node_id, port_id) not in incoming_ports:
                missing_inputs.append(f"{node_id}:{port_id}")
    if missing_inputs:
        raise ValueError(f"Workflow graph has unconnected utility inputs: {', '.join(sorted(missing_inputs))}.")

    if valid_save_targets <= 0:
        raise ValueError("Workflow graph has no saved outputs.")

    _build_execution_order(nodes, edges)


def _build_execution_order(nodes: dict[str, dict[str, Any]], edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    executable = {
        node_id: node
        for node_id, node in nodes.items()
        if str(node.get("type") or "").strip() in EXECUTABLE_NODE_TYPES and node_id != "input"
    }
    incoming: dict[str, set[str]] = {node_id: set() for node_id in executable}
    outgoing: dict[str, set[str]] = {node_id: set() for node_id in executable}

    for edge in edges:
        source = edge.get("source") if isinstance(edge.get("source"), dict) else {}
        target = edge.get("target") if isinstance(edge.get("target"), dict) else {}
        source_id = str(source.get("nodeId") or "").strip()
        target_id = str(target.get("nodeId") or "").strip()
        if target_id not in executable:
            continue
        if source_id in executable:
            incoming[target_id].add(source_id)
            outgoing[source_id].add(target_id)

    def _sort_key(item: tuple[str, dict[str, Any]]) -> tuple[float, float, str]:
        node_id, node = item
        x, y = _node_position(node)
        return x, y, node_id

    ready = sorted(
        [(node_id, node) for node_id, node in executable.items() if not incoming[node_id]],
        key=_sort_key,
    )
    ordered: list[dict[str, Any]] = []

    while ready:
        node_id, node = ready.pop(0)
        ordered.append(node)
        for target_id in sorted(outgoing[node_id]):
            incoming[target_id].discard(node_id)
            if not incoming[target_id]:
                ready.append((target_id, executable[target_id]))
                ready.sort(key=_sort_key)

    if len(ordered) != len(executable):
        unresolved = sorted(set(executable) - {str(node.get("id")) for node in ordered})
        raise ValueError(f"Workflow graph contains a cycle or unresolved dependency: {', '.join(unresolved)}")

    return ordered


def _input_ref_for_node(nodes: dict[str, dict[str, Any]], edges: list[dict[str, Any]], node_id: str, port_id: str = "input") -> str:
    for edge in edges:
        target = edge.get("target") if isinstance(edge.get("target"), dict) else {}
        if str(target.get("nodeId") or "").strip() != node_id:
            continue
        if str(target.get("portId") or "").strip() != port_id:
            continue
        return _source_ref_for_edge(nodes, edge)
    return ""


def _resolve_artifact(artifacts: dict[str, AudioArtifact], ref: str) -> AudioArtifact:
    source_ref = str(ref or "").strip()
    if not source_ref or source_ref == "input":
        if "input" not in artifacts:
            raise ValueError("Missing workflow input artifact: input")
        return artifacts["input"]
    artifact = artifacts.get(source_ref)
    if artifact is not None:
        return artifact
    if "." in source_ref:
        source_node_id, source_stem = source_ref.split(".", 1)
        for key, value in artifacts.items():
            if not key.startswith(f"{source_node_id}."):
                continue
            if key.split(".", 1)[1].lower() == source_stem.lower():
                return value
    raise ValueError(f"Missing workflow input artifact: {source_ref}")


def _to_channel_first(audio: Any) -> np.ndarray:
    array = np.asarray(audio, dtype=np.float32)
    if array.ndim == 1:
        return np.ascontiguousarray(array.reshape(1, -1))
    if array.ndim != 2:
        raise ValueError(f"Expected mono or stereo audio, got shape {array.shape}.")
    if array.shape[0] in (1, 2):
        return np.ascontiguousarray(array)
    if array.shape[1] in (1, 2):
        return np.ascontiguousarray(array.T)
    raise ValueError(f"Expected mono or stereo audio, got shape {array.shape}.")


def _normalize_artifact_audio(audio: Any) -> np.ndarray:
    array = np.asarray(audio, dtype=np.float32)
    if array.ndim == 1:
        return np.ascontiguousarray(array)
    if array.ndim != 2:
        raise ValueError(f"Expected mono or stereo audio, got shape {array.shape}.")
    if array.shape[0] in (1, 2):
        return np.ascontiguousarray(array)
    if array.shape[1] in (1, 2):
        return np.ascontiguousarray(array.T)
    raise ValueError(f"Expected mono or stereo audio, got shape {array.shape}.")


def _align_audio_inputs(inputs: list[AudioArtifact]) -> tuple[list[np.ndarray], int]:
    from pymss.workflow import _ensure_sample_rate

    if len(inputs) < 2:
        raise ValueError("At least two audio inputs are required for audio ensemble.")
    sample_rate = int(inputs[0].sample_rate)
    aligned: list[np.ndarray] = []
    for artifact in inputs:
        audio = _to_channel_first(_ensure_sample_rate(_normalize_artifact_audio(artifact.audio), artifact.sample_rate, sample_rate))
        aligned.append(audio)
    channels = min(audio.shape[0] for audio in aligned)
    length = min(audio.shape[-1] for audio in aligned)
    if channels <= 0 or length <= 0:
        raise ValueError("Audio ensemble inputs must have non-empty channels and samples.")
    return [np.ascontiguousarray(audio[:channels, :length]) for audio in aligned], sample_rate


def _execute_utility_node(
    *,
    node: dict[str, Any],
    node_type: str,
    node_data: dict[str, Any],
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    artifacts: dict[str, AudioArtifact],
) -> AudioArtifact:
    if node_type == "load_audio_batch":
        return _resolve_artifact(artifacts, "input")

    if node_type == "audio_invert_phase":
        source = _resolve_artifact(artifacts, _input_ref_for_node(nodes, edges, str(node.get("id")), "input"))
        return AudioArtifact(audio=np.ascontiguousarray(-_normalize_artifact_audio(source.audio)), sample_rate=source.sample_rate)

    if node_type == "audio_normalize":
        source = _resolve_artifact(artifacts, _input_ref_for_node(nodes, edges, str(node.get("id")), "input"))
        waveform = np.ascontiguousarray(_normalize_artifact_audio(source.audio).copy())
        peak = float(np.max(np.abs(waveform))) if waveform.size else 0.0
        if peak > 1.0:
            waveform *= np.float32(0.999 / peak)
        return AudioArtifact(audio=waveform, sample_rate=source.sample_rate)

    if node_type == "audio_ensemble":
        from pymss.ensemble import average_waveforms

        input_count = max(2, min(10, int(node_data.get("inputCount") or 2)))
        inputs = [
            _resolve_artifact(artifacts, _input_ref_for_node(nodes, edges, str(node.get("id")), f"input:{index}"))
            for index in range(input_count)
        ]
        aligned, sample_rate = _align_audio_inputs(inputs)
        raw_weights = node_data.get("weights") if isinstance(node_data.get("weights"), list) else []
        weights = []
        for index in range(input_count):
            try:
                weights.append(float(raw_weights[index]))
            except (IndexError, TypeError, ValueError):
                weights.append(1.0)
        result = average_waveforms(
            np.stack(aligned, axis=0).astype(np.float32, copy=False),
            weights=np.asarray(weights, dtype=np.float32),
            algorithm=str(node_data.get("ensembleType") or "avg_wave"),
        )
        return AudioArtifact(audio=np.ascontiguousarray(result.astype(np.float32, copy=False)), sample_rate=sample_rate)

    raise ValueError(f"Unsupported utility node type: {node_type}")


def _execute_separate_node(
    *,
    payload: dict[str, Any],
    workflow_defaults: dict[str, Any],
    task_id: str,
    node: dict[str, Any],
    node_data: dict[str, Any],
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    artifacts: dict[str, AudioArtifact],
    logger: Any,
) -> dict[str, AudioArtifact]:
    from pymss.workflow import _find_stem, _to_model_audio

    node_id = str(node.get("id") or "")
    model_name = str(node_data.get("model") or "").strip()
    if not model_name:
        raise ValueError(f"Workflow node {node_id} is missing model.")
    source = _resolve_artifact(artifacts, _input_ref_for_node(nodes, edges, node_id, "input") or "input")
    stems = [
        str(item).strip()
        for item in (node_data.get("stems") if isinstance(node_data.get("stems"), list) else [])
        if str(item).strip()
    ]
    if not stems:
        raise ValueError(f"Workflow node {node_id} has no stems configured.")

    inference_params = dict(workflow_defaults.get("inference_params") or {})
    overlap_size = node_data.get("overlapSize")
    if isinstance(overlap_size, (int, float)) and int(overlap_size) > 0:
        inference_params["overlap_size"] = int(overlap_size)

    progress_prefix = model_name

    def emit_node_progress(done: Any, total: Any, message: str | None = None) -> None:
        try:
            done_value = float(done)
            total_value = float(total)
        except (TypeError, ValueError):
            return
        emit(
            "task_progress",
            {
                "stage": "separating",
                "message": f"{progress_prefix}: {message or 'Separating'}",
                "done": done_value,
                "total": total_value,
            },
            task_id=task_id,
        )

    separator = _prepare_separator(
        payload={
            **payload,
            "model": model_name,
            "selectedStems": stems,
            "inferenceParams": inference_params,
            "output": payload.get("output") or "results",
        },
        task_id=task_id,
        progress_callback=emit_node_progress,
        logger=logger,
    )
    try:
        sample_rate = int(separator.config.audio.get("sample_rate", source.sample_rate))
        from pymss.workflow import _ensure_sample_rate

        model_audio = _to_model_audio(_ensure_sample_rate(_normalize_artifact_audio(source.audio), source.sample_rate, sample_rate))
        if getattr(separator, "model_type", None) == "vr":
            results = separator.separate(model_audio, pbar=False)
        else:
            results = separator.separate(model_audio, pbar=False, stems=stems)

        selected: dict[str, AudioArtifact] = {}
        for stem in stems:
            actual = _find_stem(results, stem)
            selected[f"{node_id}.{actual}"] = AudioArtifact(
                audio=np.ascontiguousarray(np.asarray(results[actual], dtype=np.float32)),
                sample_rate=sample_rate,
            )
        return selected
    finally:
        close = getattr(separator, "close", None)
        if callable(close):
            close()
        else:
            cleanup = getattr(separator, "del_cache", None)
            if callable(cleanup):
                cleanup()


def _save_targets_for_graph(
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    save_output_map: dict[str, str],
) -> list[SaveTarget]:
    targets: list[SaveTarget] = []
    save_node_ids = {
        node_id
        for node_id, node in nodes.items()
        if str(node.get("type") or "").strip() == "save_outputs"
    }
    for edge in edges:
        target = edge.get("target") if isinstance(edge.get("target"), dict) else {}
        if str(target.get("nodeId") or "").strip() not in save_node_ids:
            continue
        source_ref = _source_ref_for_edge(nodes, edge)
        if not source_ref:
            continue
        output_dir = save_output_map.get(source_ref) or source_ref.replace("utility:", "")
        if source_ref.startswith("utility:"):
            source_node_id = source_ref.split(":", 1)[1]
            source_node = nodes.get(source_node_id, {})
            fallback_label = _utility_title(str(source_node.get("type") or "utility"))
        else:
            fallback_label = source_ref.split(".", 1)[1] if "." in source_ref else source_ref
        folder_name = Path(str(output_dir).rstrip("\\/")).name if str(output_dir).strip() else ""
        output_label = _safe_filename_part(folder_name or fallback_label)
        targets.append(
            SaveTarget(
                source_ref=source_ref,
                output_dir=str(output_dir).strip() or fallback_label,
                output_label=output_label,
            )
        )
    return targets


def run_graph_workflow_task(
    *,
    payload: dict[str, Any],
    task_id: str,
    input_path: str,
    output_dir: str,
    output_layout: str,
) -> dict[str, Any]:
    from pymss import get_separation_logger, load_audio, save_audio
    from pymss.workflow import _to_save_audio

    definition = payload.get("workflow")
    if not is_graph_workflow_definition(definition):
        raise ValueError("Unsupported workflow definition for graph runtime.")

    workflow_defaults = definition.get("defaults") if isinstance(definition.get("defaults"), dict) else {}
    nodes, edges, save_output_map = _read_graph(definition)
    _validate_graph_definition(nodes, edges)
    execution_order = _build_execution_order(nodes, edges)
    save_targets = _save_targets_for_graph(nodes, edges, save_output_map)
    source_path = Path(input_path)
    if not source_path.exists():
        raise FileNotFoundError(f"Input not found: {input_path}")

    logger = None
    log_handler = None
    try:
        try:
            logger = get_separation_logger()
            log_handler = JsonLogHandler(task_id)
            logger.addHandler(log_handler)
        except Exception:
            logger = None

        mix, sample_rate = load_audio(str(source_path), sr=None, mono=False)
        task_output_dir = Path(resolve_pymss_output_dir(output_dir, [], input_path, output_layout == "folders"))
        task_output_dir.mkdir(parents=True, exist_ok=True)
        artifacts: dict[str, AudioArtifact] = {
            "input": AudioArtifact(audio=_normalize_artifact_audio(mix), sample_rate=int(sample_rate)),
        }
        outputs: list[dict[str, str]] = []

        for node in execution_order:
            node_id = str(node.get("id") or "").strip()
            node_type = str(node.get("type") or "").strip()
            node_data = node.get("data") if isinstance(node.get("data"), dict) else {}
            if node_type == "separate":
                artifacts.update(
                    _execute_separate_node(
                        payload=payload,
                        workflow_defaults=workflow_defaults,
                        task_id=task_id,
                        node=node,
                        node_data=node_data,
                        nodes=nodes,
                        edges=edges,
                        artifacts=artifacts,
                        logger=logger,
                    )
                )
                continue
            if node_type in UTILITY_NODE_TYPES:
                artifacts[f"utility:{node_id}"] = _execute_utility_node(
                    node=node,
                    node_type=node_type,
                    node_data=node_data,
                    nodes=nodes,
                    edges=edges,
                    artifacts=artifacts,
                )

        output_format = str(payload.get("outputFormat") or "wav").strip().lower() or "wav"
        audio_params = normalize_audio_params(payload.get("audioParams"))
        track_name = source_path.stem

        for target in save_targets:
            artifact = _resolve_artifact(artifacts, target.source_ref)
            folder = task_output_dir / target.output_dir
            folder.mkdir(parents=True, exist_ok=True)
            file_name = f"{_safe_filename_part(track_name)}_{target.output_label}.{output_format}"
            output_path = folder / file_name
            save_audio(str(output_path), _to_save_audio(artifact.audio), artifact.sample_rate, output_format, audio_params)
            outputs.append({
                "stem": target.output_label,
                "path": str(output_path),
            })

        return {
            "files": [item["path"] for item in outputs],
            "outputs": outputs,
            "outputDir": str(task_output_dir.resolve()),
            "outputFormat": output_format,
        }
    finally:
        if logger is not None and log_handler is not None:
            try:
                logger.removeHandler(log_handler)
            except Exception:
                pass
