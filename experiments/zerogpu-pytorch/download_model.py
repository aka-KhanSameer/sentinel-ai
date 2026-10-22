"""Download the exact public ProtectAI model snapshot used by Sentinel's ONNX model."""

import hashlib
import json
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

MODEL_ID = "protectai/deberta-v3-base-prompt-injection-v2"
REVISION = "90c9989b1a342275dd0d1a95aad283c04e075671"
MODEL_SHA256 = "6521cb8d0ac08148c81464899c424e6148fcc62befa371089fa4061d8b6e0424"
ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / "model"


def main() -> None:
    info = HfApi().model_info(MODEL_ID, revision=REVISION, files_metadata=True)
    if info.sha != REVISION:
        raise RuntimeError(f"Resolved revision mismatch: expected {REVISION}, got {info.sha}")
    snapshot_download(
        repo_id=MODEL_ID,
        revision=REVISION,
        local_dir=str(MODEL_DIR),
        allow_patterns=[
            "LICENSE", "config.json", "model.safetensors", "tokenizer.json",
            "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "spm.model",
        ],
    )
    checkpoint = MODEL_DIR / "model.safetensors"
    digest = hashlib.sha256()
    with checkpoint.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    actual = digest.hexdigest()
    if actual != MODEL_SHA256:
        raise RuntimeError(f"Safetensors SHA-256 mismatch: expected {MODEL_SHA256}, got {actual}")
    license_text = (MODEL_DIR / "LICENSE").read_text(encoding="utf-8")
    if "Apache License" not in license_text or "Version 2.0" not in license_text:
        raise RuntimeError("Downloaded model license is not verified as Apache-2.0")
    manifest = {
        "model_id": MODEL_ID,
        "revision": info.sha,
        "license": "Apache-2.0",
        "checkpoint": "model.safetensors",
        "checkpoint_bytes": checkpoint.stat().st_size,
        "checkpoint_sha256": actual,
    }
    (ROOT / "model-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
