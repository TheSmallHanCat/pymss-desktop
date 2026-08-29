from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout

if __package__:
    from . import _bootstrap as _worker_test_bootstrap
else:
    import _bootstrap as _worker_test_bootstrap

import worker_protocol


class WorkerProtocolTests(unittest.TestCase):
    def test_emit_keeps_json_on_protocol_stream_during_stdout_redirect(self) -> None:
        protocol_stdout = io.StringIO()
        incidental_stdout = io.StringIO()

        with (
            redirect_stdout(protocol_stdout),
            redirect_stderr(incidental_stdout),
        ):
            with worker_protocol.isolate_protocol_stdout():
                print("third-party diagnostic")
                worker_protocol.emit("audio_tool_progress", {"phase": "loading_model"})

        self.assertEqual(incidental_stdout.getvalue(), "third-party diagnostic\n")
        event = json.loads(protocol_stdout.getvalue())
        self.assertEqual(event["type"], "audio_tool_progress")
        self.assertEqual(event["payload"], {"phase": "loading_model"})


if __name__ == "__main__":
    unittest.main()
