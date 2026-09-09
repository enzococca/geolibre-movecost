#!/usr/bin/env python3
"""
Find which symbols a wasm side module (an R package's .so) imports that the main
module (webR's R.wasm) does not export.

Emscripten turns each unresolved import into a stub that throws
"resolved is not a function" the moment R calls into it, which is exactly the
error `library(terra)` produces inside webR — so this is how we identify the
symbol responsible rather than guessing.

    python3 scripts/wasm-missing-symbols.py R.wasm terra.so [more.so ...]
"""
import sys
import struct


def read_uleb(data, i):
    result = shift = 0
    while True:
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, i
        shift += 7


def sections(data):
    assert data[:4] == b"\0asm", "not a wasm module"
    i = 8
    while i < len(data):
        section_id = data[i]
        i += 1
        size, i = read_uleb(data, i)
        yield section_id, data[i : i + size]
        i += size


def read_name(data, i):
    length, i = read_uleb(data, i)
    return data[i : i + length].decode("utf-8", "replace"), i + length


def exports(data):
    names = set()
    for section_id, body in sections(data):
        if section_id != 7:
            continue
        count, i = read_uleb(body, 0)
        for _ in range(count):
            name, i = read_name(body, i)
            names.add(name)
            i += 1                      # export kind
            _, i = read_uleb(body, i)   # index
    return names


def imports(data):
    found = []
    for section_id, body in sections(data):
        if section_id != 2:
            continue
        count, i = read_uleb(body, 0)
        for _ in range(count):
            module, i = read_name(body, i)
            field, i = read_name(body, i)
            kind = body[i]
            i += 1
            if kind == 0:               # function
                _, i = read_uleb(body, i)
            elif kind == 1:             # table
                i += 1
                limits = body[i]
                i += 1
                _, i = read_uleb(body, i)
                if limits & 1:
                    _, i = read_uleb(body, i)
            elif kind == 2:             # memory
                limits = body[i]
                i += 1
                _, i = read_uleb(body, i)
                if limits & 1:
                    _, i = read_uleb(body, i)
            elif kind == 3:             # global
                i += 2
            found.append((module, field, kind))
    return found


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    main_exports = exports(open(argv[1], "rb").read())
    print(f"{argv[1]}: {len(main_exports)} exports")

    for path in argv[2:]:
        data = open(path, "rb").read()
        wanted = imports(data)
        missing = [
            (m, f) for (m, f, kind) in wanted if kind == 0 and f not in main_exports
        ]
        print(f"\n{path}: {len(wanted)} imports, {len(missing)} unresolved")
        for module, field in missing[:80]:
            print(f"  MISSING  {module}.{field}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
