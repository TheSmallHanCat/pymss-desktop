from __future__ import annotations

import argparse
import sys

from worker_protocol import debug_log, emit_error, load_payload
from worker_proxy import ProxyConfigError, configure_process_proxy, load_proxy_config, parse_proxy_config


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="pymss-studio-worker")
    parser.add_argument("command", nargs="?", default="health")
    parser.add_argument("--payload", help="JSON string or path to a JSON payload file")
    return parser.parse_args(argv[1:])


def run_command(command: str, payload: dict) -> int:
    if command == "runtime_info":
        from worker_bootstrap import cmd_runtime_info
        return cmd_runtime_info(payload)
    if command == "install_runtime":
        configure_process_proxy(load_proxy_config())
        from worker_bootstrap import cmd_install_runtime
        return cmd_install_runtime(payload)
    if command == "runtime_core_versions":
        configure_process_proxy(load_proxy_config())
        from worker_bootstrap import cmd_runtime_core_versions
        return cmd_runtime_core_versions(payload)
    if command == "update_runtime_core":
        configure_process_proxy(load_proxy_config())
        from worker_bootstrap import cmd_update_runtime_core
        return cmd_update_runtime_core(payload)
    if command == "activate_runtime":
        from worker_bootstrap import cmd_activate_runtime
        return cmd_activate_runtime(payload)
    if command == "runtime_env_sizes":
        from worker_bootstrap import cmd_runtime_env_sizes
        return cmd_runtime_env_sizes(payload)
    if command == "delete_runtime":
        from worker_bootstrap import cmd_delete_runtime
        return cmd_delete_runtime(payload)
    if command == "test_connection":
        configure_process_proxy(parse_proxy_config({
            "mode": payload.get("mode"),
            "url": payload.get("url"),
            "bypass": payload.get("bypass"),
        }))
    else:
        # Only non-runtime commands reach this: the runtime ones above have already
        # returned, having set up their own proxy when they need the network.
        configure_process_proxy(load_proxy_config())
    if command == "health":
        from worker_models import cmd_health
        return cmd_health()
    if command == "env_info":
        from worker_models import cmd_env_info
        return cmd_env_info()
    if command == "list_models":
        from worker_models import cmd_list_models
        return cmd_list_models(payload)
    if command == "debug_catalog_info":
        from worker_models import cmd_debug_catalog_info
        return cmd_debug_catalog_info(payload)
    if command == "debug_catalog_save":
        from worker_models import cmd_debug_catalog_save
        return cmd_debug_catalog_save(payload)
    if command == "debug_catalog_reset":
        from worker_models import cmd_debug_catalog_reset
        return cmd_debug_catalog_reset(payload)
    if command == "debug_model_config":
        from worker_models import cmd_debug_model_config
        return cmd_debug_model_config(payload)
    if command == "model_info":
        from worker_models import cmd_model_info
        return cmd_model_info(payload)
    if command == "delete_model":
        from worker_models import cmd_delete_model
        return cmd_delete_model(payload)
    if command == "inspect_custom_model":
        from worker_custom_models import cmd_inspect_custom_model
        return cmd_inspect_custom_model(payload)
    if command == "import_custom_model":
        from worker_custom_models import cmd_import_custom_model
        return cmd_import_custom_model(payload)
    if command == "unregister_custom_model":
        from worker_custom_models import cmd_unregister_custom_model
        return cmd_unregister_custom_model(payload)
    if command == "relink_custom_model":
        from worker_custom_models import cmd_relink_custom_model
        return cmd_relink_custom_model(payload)
    if command == "remap_custom_model_paths":
        from worker_custom_models import cmd_remap_custom_model_paths
        return cmd_remap_custom_model_paths(payload)
    if command == "model_storage_summary":
        from worker_models import cmd_model_storage_summary
        return cmd_model_storage_summary(payload)
    if command == "cleanup_model_residual_files":
        from worker_models import cmd_cleanup_model_residual_files
        return cmd_cleanup_model_residual_files(payload)
    if command == "download_model":
        from worker_download import cmd_download_model
        return cmd_download_model(payload)
    if command == "test_connection":
        from worker_download import cmd_test_connection
        return cmd_test_connection(payload)
    if command == "audio_metadata":
        from worker_audio import cmd_audio_metadata
        return cmd_audio_metadata(payload)
    if command == "waveform_peaks":
        from worker_audio import cmd_waveform_peaks
        return cmd_waveform_peaks(payload)
    if command == "export_editor_mix":
        from worker_audio import cmd_export_editor_mix
        return cmd_export_editor_mix(payload)
    if command == "audio_tools":
        from worker_tools import cmd_audio_tools
        return cmd_audio_tools(payload)
    if command == "infer":
        from worker_infer import cmd_infer
        return cmd_infer(payload)
    if command == "infer_workflow":
        from worker_workflows import cmd_infer_workflow
        return cmd_infer_workflow(payload)
    return emit_error("UNKNOWN_COMMAND", f"Unknown command: {command}")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    debug_log("worker.start", command=args.command)
    try:
        payload = load_payload(args.payload)
        debug_log("worker.payload", command=args.command, hasPayload=bool(args.payload))
        code = run_command(args.command, payload)
        debug_log("worker.exit", command=args.command, code=code)
        return code
    except ProxyConfigError as exc:
        debug_log("worker.exception", command=args.command, error=str(exc))
        return emit_error(exc.code, str(exc))
    except Exception as exc:
        import traceback
        debug_log("worker.exception", command=args.command, error=str(exc), detail=traceback.format_exc())
        return emit_error("UNKNOWN_ERROR", str(exc), traceback.format_exc())


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
