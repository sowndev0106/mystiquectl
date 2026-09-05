#!/usr/bin/env python3
"""Minimal read/repack support for Electron .asar archives.

Format (Chromium Pickle):
    uint32  4                  outer pickle payload size
    uint32  headerSize         = 4 + inner payload size
    uint32  innerPayloadSize   = 4 + len(json) padded to 4
    uint32  len(json)
    bytes   json
    bytes   padding to 4
    <file data, offsets relative to 8 + headerSize>

Entries: directories have "files"; regular files have "size", "offset" (a
decimal *string*) and usually "integrity"; files kept outside the archive have
"unpacked": true and no offset.
"""

import contextlib
import hashlib
import json
import os
import struct

BLOCK_SIZE = 4 * 1024 * 1024


def read(path):
    """Return (open file object, data base offset, header dict)."""
    fh = open(path, "rb")
    _, header_size, _, json_len = struct.unpack("<4I", fh.read(16))
    header = json.loads(fh.read(json_len).decode("utf-8"))
    return fh, 8 + header_size, header


def walk(node, prefix=""):
    """Yield (path, meta) for every non-directory entry."""
    for name, meta in node.get("files", {}).items():
        cur = prefix + "/" + name
        if "files" in meta:
            yield from walk(meta, cur)
        else:
            yield cur, meta


def read_file(fh, base, meta):
    size = int(meta["size"])
    fh.seek(base + int(meta["offset"]))
    data = fh.read(size)
    # file.read(n) on a truncated source just returns fewer bytes -- no
    # exception -- so a corrupt or short archive would otherwise repack
    # silently, with the header still declaring the original (larger) size
    # for every entry past the truncation point.
    if len(data) != size:
        raise ValueError(
            f"short read: wanted {size} bytes at offset {meta['offset']}, got {len(data)} "
            f"-- the source archive is truncated or corrupt")
    return data


def integrity(data):
    blocks = [
        hashlib.sha256(data[i:i + BLOCK_SIZE]).hexdigest()
        for i in range(0, len(data), BLOCK_SIZE)
    ] or [hashlib.sha256(b"").hexdigest()]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK_SIZE,
        "blocks": blocks,
    }


def _ensure_entry(header, path):
    """Create/return the metadata dict for path, making directories as needed."""
    parts = path.strip("/").split("/")
    node = header
    for part in parts[:-1]:
        node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        node.setdefault("files", {})
    return node.setdefault("files", {}).setdefault(parts[-1], {})


def repack(src, dst, replace=None, add=None, progress=None):
    """Write a new archive at dst, applying {path: bytes} replacements/additions.

    Paths are archive-absolute and slash-separated, e.g.
    "/node_modules/usb/dist/index.js".
    """
    replace = dict(replace or {})
    add = dict(add or {})
    fh, base, header = read(src)

    for path, data in add.items():
        meta = _ensure_entry(header, path)
        meta.clear()
        meta.update({"size": len(data), "offset": "0"})
        replace[path] = data

    entries = list(walk(header))
    total = len(entries)
    tmp = dst + ".body"
    offset = 0

    # Both fh (opened by read() above) and tmp (a few hundred MB, the whole
    # unpacked archive body) used to be cleaned up only on the straight-line
    # success path: fh.close() sat after pass 1 with no try/finally, and
    # os.remove(tmp) sat after pass 2 with no try/finally either -- so an
    # exception during pass 1 skipped BOTH cleanups (fh stays open until the
    # process exits, tmp is never created... but one raised partway through
    # WRITING tmp leaves however much of the ~300 MB body it had already
    # streamed). Ctrl-C, ENOSPC, or any other exception now still leaves tmp
    # behind exactly once (this one outer finally), never fh: on a repeated
    # failed retry, each attempt used to rewrite the body without ever
    # removing the last attempt's, compounding the disk usage that likely
    # caused the failure in the first place.
    try:
        try:
            # Pass 1: stream the body to a side file, assigning fresh
            # offsets. Keeping the body separate means the header (whose
            # length depends on the offsets we are still computing) can be
            # written afterwards without buffering 300+ MB in memory.
            with open(tmp, "wb") as bodyf:
                for i, (path, meta) in enumerate(entries):
                    if meta.get("unpacked") or "link" in meta:
                        continue
                    data = replace.get(path)
                    if data is None:
                        data = read_file(fh, base, meta)
                    else:
                        meta["size"] = len(data)
                        if "integrity" in meta or path in add:
                            meta["integrity"] = integrity(data)
                    meta["offset"] = str(offset)
                    bodyf.write(data)
                    offset += len(data)
                    if progress and i % 2000 == 0:
                        progress(i, total)
        finally:
            fh.close()

        # Pass 2: header, then body.
        blob = json.dumps(header, separators=(",", ":")).encode("utf-8")
        pad = (4 - (4 + len(blob)) % 4) % 4
        inner = 4 + len(blob) + pad
        with open(dst, "wb") as out:
            out.write(struct.pack("<4I", 4, 4 + inner, inner, len(blob)))
            out.write(blob)
            out.write(b"\0" * pad)
            with open(tmp, "rb") as bodyf:
                while True:
                    chunk = bodyf.read(8 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)
    return total
