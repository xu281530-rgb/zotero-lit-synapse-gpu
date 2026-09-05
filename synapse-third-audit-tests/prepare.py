#!/usr/bin/env python3
"""Verify the supplied XPI and unpack it for isolated Node.js tests."""
import argparse
import hashlib
from pathlib import Path
import stat
import zipfile

NEW_SHA256 = '628467d1f34d3d769885725563bc6709370f25e21546ccd207f01f6fc3ba579d'
OLD_SHA256 = '55beb39978f90f434885f9eb26eab5282fad2041bf433877fcc49fa8c10a970e'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('xpi', type=Path, help='Original, unmodified XPI archive')
    parser.add_argument('--old', action='store_true', help='Unpack the previous archive for control tests')
    args = parser.parse_args()
    if not args.xpi.is_file():
        parser.error('XPI file does not exist')
    expected = OLD_SHA256 if args.old else NEW_SHA256
    actual = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    if actual != expected:
        parser.error('SHA-256 mismatch. Expected ' + expected + ', received ' + actual)
    root = Path(__file__).resolve().parent
    destination = root / ('old' if args.old else 'new')
    if destination.exists():
        parser.error('Refusing to overwrite existing directory: ' + str(destination))
    with zipfile.ZipFile(args.xpi) as archive:
        members = archive.infolist()
        if sum(member.file_size for member in members) > 128 * 1024 * 1024:
            parser.error('Archive exceeds extraction limit')
        for member in members:
            target = (destination / member.filename).resolve()
            if not target.is_relative_to(destination.resolve()):
                parser.error('Unsafe archive path: ' + member.filename)
            if stat.S_ISLNK(member.external_attr >> 16):
                parser.error('Archive contains a symbolic link')
        bad = archive.testzip()
        if bad:
            parser.error('Archive CRC failed: ' + bad)
        archive.extractall(destination)
    print('Verified SHA-256: ' + actual)
    print('Extracted to: ' + str(destination))
    print('No Zotero installation or native program was executed.')

if __name__ == '__main__':
    main()
