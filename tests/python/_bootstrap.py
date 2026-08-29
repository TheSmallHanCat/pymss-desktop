"""Make the worker modules importable for package and direct-file test runs."""

import sys
from pathlib import Path


WORKER_DIR = Path(__file__).resolve().parents[2] / "python"
worker_path = str(WORKER_DIR)
if worker_path not in sys.path:
    sys.path.insert(0, worker_path)
