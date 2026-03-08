"""Exports project scan results to JSON."""

import json
from dataclasses import asdict
from pathlib import Path

try:
    from app.models import Project
except ImportError:  # Supports running as: python app/main.py
    from models import Project


def export_to_json(project: Project, output_path: str) -> Path:
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(asdict(project), indent=2), encoding="utf-8")
    return output_file
