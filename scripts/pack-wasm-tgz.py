#!/usr/bin/env python3
"""Pack an installed R package the way webR likes to receive one.

    python3 scripts/pack-wasm-tgz.py <library-dir> <package> <output.tgz>

webR can either extract a package archive or *mount* it, and mounting is much
the cheaper: the files stay in the archive and are served from a WORKERFS node
instead of being unpacked into the emulated filesystem. It mounts when the tar
carries a `.vfs-index.json` member listing every file's byte range — the
convention rwasm's own builds use, and what `Can't mount archive, no VFS
metadata found. Falling back to traditional .tgz extraction.` means when it is
absent.

The paths in that index are relative to the package root (`/DESCRIPTION`, not
`/movecost/DESCRIPTION`), because webR mounts the archive at the package's own
directory inside the library.
"""

import gzip
import io
import json
import sys
import tarfile
from pathlib import Path


def pack(library: Path, package: str, out: Path) -> None:
    root = library / package
    if not root.is_dir():
        raise SystemExit(f"no installed package at {root}")

    files = sorted(p for p in root.rglob("*") if p.is_file() or p.is_dir())
    long_names = [p for p in files if len(f"{package}/{p.relative_to(root)}") > 100]
    if long_names:
        # A GNU long-name header has type 'L', and webR's scanner skips any
        # uppercase type byte without stepping over its data — so the index
        # would be missed. Nothing in these packages comes close, but say so
        # rather than shipping an archive that silently falls back.
        raise SystemExit(f"{len(long_names)} path(s) over 100 characters; the index would not be found")

    buffer = io.BytesIO()
    index = []
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.GNU_FORMAT) as tar:
        for path in files:
            rel = path.relative_to(root)
            info = tar.gettarinfo(str(path), arcname=f"{package}/{rel}")
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            if path.is_dir():
                tar.addfile(info)
                continue
            # `offset_data` is filled in when *reading* an archive, never when
            # writing one, so it has to be worked out here: the write position
            # is where this member's header goes, and its data follows one
            # 512-byte block later (guaranteed by the length check above).
            start = tar.offset + tarfile.BLOCKSIZE
            with path.open("rb") as handle:
                tar.addfile(info, handle)
            index.append({"filename": f"/{rel}", "start": start, "end": start + info.size})

        payload = json.dumps({"files": index}).encode()
        entry = tarfile.TarInfo(".vfs-index.json")
        entry.size = len(payload)
        entry.mtime = 0
        tar.addfile(entry, io.BytesIO(payload))

    raw = buffer.getvalue()
    verify(raw, index, package)

    out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out, "wb", compresslevel=9) as gz:
        gz.write(raw)
    print(f"{out} — {len(index)} files, {len(raw) / 1e6:.1f} MB uncompressed, "
          f"{out.stat().st_size / 1e6:.1f} MB packed")


def verify(raw: bytes, index: list, package: str) -> None:
    """Read the archive back and check every range against the tar itself.

    An index whose offsets are wrong produces an archive that mounts happily
    and then hands R the bytes of some other file — `readRDS(file): unknown
    input format`, from a package that looks perfectly well formed. Cheap to
    check, miserable to debug.
    """
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        members = {m.name: m for m in tar.getmembers()}
    for entry in index:
        member = members.get(f"{package}{entry['filename']}")
        if member is None:
            raise SystemExit(f"index names {entry['filename']}, which is not in the archive")
        if member.offset_data != entry["start"] or member.size != entry["end"] - entry["start"]:
            raise SystemExit(
                f"{entry['filename']}: index says {entry['start']}-{entry['end']}, "
                f"archive has {member.offset_data}-{member.offset_data + member.size}"
            )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    pack(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
