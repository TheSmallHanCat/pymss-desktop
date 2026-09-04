"""Compatibility fixes for the native :mod:`pymss.graph` runner.

The graph runner in pymss 2.1.3 can stamp returned arrays with the *source*
sample rate after model inference.  When a 48 kHz waveform is processed using
the model's 44.1 kHz configuration, the waveform and metadata consequently
disagree (and the mismatch compounds when a later workflow step consumes that
artifact).  The compatibility layer makes the model-boundary decision
explicit: inspect the incoming artifact rate, resample a private copy only
when it differs from the model rate, then carry that rate to the output.

This module keeps the correction at the graph artifact boundary.  It does not
rewrite files or change the standalone ``pymss`` separation path: while a
separation node is executing, the model sample rate is enforced before
``separator.separate`` and carried through the existing ``numpy_to_audio``
constructor so every output ``AudioArtifact`` has the rate of its waveform.

The patch is deliberately idempotent and limited to the known 2.1.3 executor
shape.  Once pymss.graph returns the output sample rate itself, this module
will leave that implementation untouched.
"""

from __future__ import annotations

from contextvars import ContextVar
from importlib import import_module
from typing import Any, Callable


_SEPARATION_NODE_TYPES = frozenset(
    {
        "mss_separate",
        "mss_separate_list",
        "vr_separate",
        "vr_separate_list",
        "custom_mss_separate",
        "custom_mss_separate_list",
    }
)

# The value is scoped to one executor call.  A ContextVar keeps nested worker
# calls isolated and avoids leaking a sample rate between concurrent tasks.
_OUTPUT_SAMPLE_RATE: ContextVar[int | None] = ContextVar(
    "pymss_studio_graph_output_sample_rate", default=None
)


def _configured_sample_rate(separator: Any, fallback: int) -> int:
    """Read the model's audio sample rate without assuming a config class."""

    config = getattr(separator, "config", None)
    audio = getattr(config, "audio", None) if config is not None else None
    value: Any = audio.get("sample_rate") if hasattr(audio, "get") else None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(fallback)
    return parsed if parsed > 0 else int(fallback)


def _is_known_graph_shape(nodes_module: Any) -> bool:
    """Return true for the pre-fix executor contract.

    pymss 2.1.3 exposes ``_run_separation`` as a dict-returning helper.  A
    future graph version may return ``(results, sample_rate)`` and stamp the
    artifacts itself; wrapping that implementation would be unnecessary.  The
    annotation check is intentionally conservative: if it is absent or has a
    different shape, no patch is installed.
    """

    runner = getattr(nodes_module, "_run_separation", None)
    if not callable(runner):
        return False
    annotation = getattr(runner, "__annotations__", {}).get("return")
    if annotation is None:
        # ``from __future__ import annotations`` is used by the released
        # graph module.  Without an annotation we cannot distinguish the old
        # dict-returning helper from a newer implementation, so stay strict.
        return False
    text = str(annotation).replace(" ", "").lower()
    return text.startswith("dict[") and "ndarray" in text


def _registry_for(graph_module: Any) -> Any:
    try:
        return import_module("pymss.plugins").get_registry()
    except (ImportError, AttributeError):
        core = import_module("pymss.graph.core")
        return getattr(core, "_PLUGIN_REGISTRY", None)


def install_sample_rate_contract(graph_module: Any) -> bool:
    """Install the output-rate propagation fix once.

    ``graph_module`` is accepted as an argument so the worker can import the
    package normally and tests can provide a lightweight graph double.  The
    return value indicates whether this invocation installed the patch.
    """

    nodes = import_module("pymss.graph.nodes")
    if getattr(nodes, "_pymss_studio_sample_rate_contract", False):
        return False
    if not _is_known_graph_shape(nodes):
        # Native pymss.graph already owns the corrected contract.
        return False

    original_numpy_to_audio = getattr(nodes, "numpy_to_audio", None)
    original_run_separation = getattr(nodes, "_run_separation", None)
    registry = _registry_for(graph_module)
    if not callable(original_numpy_to_audio) or not callable(original_run_separation) or registry is None:
        return False

    def patched_numpy_to_audio(
        value: Any,
        sample_rate: int,
        *,
        stem_name: str = "",
        source_path: str = "",
    ) -> Any:
        output_rate = _OUTPUT_SAMPLE_RATE.get()
        return original_numpy_to_audio(
            value,
            output_rate if output_rate is not None else sample_rate,
            stem_name=stem_name,
            source_path=source_path,
        )

    def patched_run_separation(
        ctx: Any,
        node: Any,
        audio: Any,
        *,
        build_separator: Callable[..., Any],
        stems: list[str],
    ) -> Any:
        # Resolve the same cached separator used by the original helper.  Make
        # the model-boundary decision here rather than relying on a caller to
        # label a 48 kHz waveform as 44.1 kHz.  A shallow copy keeps branches
        # that consume the original artifact at their own sample rate.
        separator = build_separator()
        source_rate = int(getattr(audio, "sample_rate", 0) or 0)
        target_rate = _configured_sample_rate(separator, source_rate)
        _OUTPUT_SAMPLE_RATE.set(target_rate if target_rate > 0 else None)
        model_audio = audio
        if target_rate > 0 and source_rate > 0 and source_rate != target_rate:
            resample = getattr(nodes, "_resample", None)
            if not callable(resample):
                try:
                    resample = import_module("pymss.plugins.builtins").resample
                except (ImportError, AttributeError) as exc:
                    raise RuntimeError(
                        "pymss.graph has no audio resampler for model sample-rate conversion"
                    ) from exc
            from copy import copy

            model_audio = copy(audio)
            model_audio.audio = resample(audio.audio, source_rate, target_rate)
            model_audio.sample_rate = target_rate
        # Reuse the inspected separator instance.  The native worker normally
        # supplies a cache-backed factory, but keeping one instance here also
        # avoids loading a model twice when a custom host provides an
        # uncached factory.
        def model_separator() -> Any:
            return separator

        return original_run_separation(
            ctx,
            node,
            model_audio,
            build_separator=model_separator,
            stems=stems,
        )

    nodes.numpy_to_audio = patched_numpy_to_audio
    nodes._run_separation = patched_run_separation

    # Reset the ContextVar after each separation executor.  The registry keeps
    # one NodeRegistration object for aliases, so wrapping each object once is
    # sufficient for both prefixed and unprefixed node names.
    wrapped_registrations: set[int] = set()
    for node_type in _SEPARATION_NODE_TYPES:
        registration = getattr(registry, "nodes", {}).get(node_type)
        if registration is None or id(registration) in wrapped_registrations:
            continue
        executor = getattr(registration, "func", None)
        if not callable(executor):
            continue

        def execute_with_sample_rate_context(
            ctx: Any,
            inputs: dict[str, Any],
            *,
            _executor: Callable[..., Any] = executor,
        ) -> Any:
            token = _OUTPUT_SAMPLE_RATE.set(None)
            try:
                return _executor(ctx, inputs)
            finally:
                _OUTPUT_SAMPLE_RATE.reset(token)

        setattr(execute_with_sample_rate_context, "_pymss_studio_sample_rate_wrapper", True)
        registration.func = execute_with_sample_rate_context
        wrapped_registrations.add(id(registration))

    if not wrapped_registrations:
        # Do not leave module helpers patched when the graph did not expose any
        # separation nodes (for example a minimal test/runtime installation).
        nodes.numpy_to_audio = original_numpy_to_audio
        nodes._run_separation = original_run_separation
        return False

    nodes._pymss_studio_sample_rate_contract = True
    return True


__all__ = ["install_sample_rate_contract"]
