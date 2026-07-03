from __future__ import annotations

import argparse
import sys

from worker_audio import cmd_audio_metadata, cmd_export_editor_mix, cmd_waveform_peaks
from worker_download import cmd_download_model
from worker_infer import cmd_infer
from worker_models import (
    cmd_cleanup_model_residual_files,
    cmd_delete_model,
    cmd_env_info,
    cmd_health,
    cmd_list_models,
    cmd_model_info,
    cmd_model_storage_summary,
)
from worker_workflows import cmd_infer_workflow
from worker_protocol import emit_error, load_payload


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="pymss-studio-worker")
    parser.add_argument("command", nargs="?", default="health")
    parser.add_argument("--payload", help="JSON string or path to a JSON payload file")
    return parser.parse_args(argv[1:])


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        payload = load_payload(args.payload)
        if args.command == "health":
            return cmd_health()
        if args.command == "env_info":
            return cmd_env_info()
        if args.command == "list_models":
            return cmd_list_models(payload)
        if args.command == "model_info":
            return cmd_model_info(payload)
        if args.command == "delete_model":
            return cmd_delete_model(payload)
        if args.command == "model_storage_summary":
            return cmd_model_storage_summary(payload)
        if args.command == "cleanup_model_residual_files":
            return cmd_cleanup_model_residual_files(payload)
        if args.command == "download_model":
            return cmd_download_model(payload)
        if args.command == "audio_metadata":
            return cmd_audio_metadata(payload)
        if args.command == "waveform_peaks":
            return cmd_waveform_peaks(payload)
        if args.command == "export_editor_mix":
            return cmd_export_editor_mix(payload)
        if args.command == "infer":
            return cmd_infer(payload)
        if args.command == "infer_workflow":
            return cmd_infer_workflow(payload)
        return emit_error("UNKNOWN_COMMAND", f"Unknown command: {args.command}")
    except Exception as exc:
        import traceback
        return emit_error("UNKNOWN_ERROR", str(exc), traceback.format_exc())


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
