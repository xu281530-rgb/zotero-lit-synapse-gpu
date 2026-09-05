#!/usr/bin/env python3
"""Extract the exact audited XPI for isolated reproduction tests."""
from pathlib import Path
import argparse
import hashlib
import zipfile

EXPECTED_SHA256 = "55beb39978f90f434885f9eb26eab5282fad2041bf433877fcc49fa8c10a970e"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xpi", type=Path, help="Path to the original uploaded XPI")
    args = parser.parse_args()
    if not args.xpi.is_file():
        parser.error("XPI file does not exist")
    digest = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        parser.error("This is not the audited XPI. SHA-256 mismatch: " + digest)
    dest = Path(__file__).resolve().parent / "source"
    if dest.exists():
        parser.error("The source directory already exists. Use a fresh test directory.")
    with zipfile.ZipFile(args.xpi) as archive:
        for item in archive.infolist():
            name = item.filename.replace("\\", "/")
            candidate = dest.joinpath(name).resolve()
            if not candidate.is_relative_to(dest.resolve()):
                parser.error("Unsafe archive path: " + item.filename)
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                parser.error("Symlink archive entries are not supported")
        archive.extractall(dest)
    print("Source extracted; no plugin installed and no native executable run.")
    print("Next: node tests/audit.js")

if __name__ == "__main__":
    main()
