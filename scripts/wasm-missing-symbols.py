#!/usr/bin/env python3
"""
Find which symbols a wasm side module (an R package's .so) imports that nothing
it is loaded alongside provides.

Emscripten turns each unresolved import into a stub that throws
"resolved is not a function" the moment R calls into it, which is exactly the
error `library(terra)` produces inside webR — so this is how to identify the
symbol responsible rather than guessing.

    python3 scripts/wasm-missing-symbols.py TARGET.so PROVIDER [PROVIDER ...]

The providers are every module loaded before the target: webR's `R.wasm` (fetch
it and gunzip — it is served gzipped) plus the `.so` of each package the target
links against. A package's C++ symbols come from *its dependencies'* side
modules, not from R.wasm, so leaving `Rcpp.so` out of the provider list reports
thousands of false positives.

    curl -sL https://webr.r-wasm.org/v0.6.0/R.wasm | gunzip > R.bin.wasm
    tar xzf terra_1.9-46.tgz && tar xzf Rcpp_1.1.2.tgz
    python3 scripts/wasm-missing-symbols.py terra/libs/terra.so R.bin.wasm Rcpp/libs/Rcpp.so
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
                i += 1                  # valtype
                i += 1                  # mutability
            elif kind == 4:             # tag — present because terra and other
                i += 1                  # C++ packages build with -fwasm-exceptions
                _, i = read_uleb(body, i)
            else:
                raise ValueError(
                    f"unknown import kind {kind} for {module}.{field}; "
                    "the parser needs updating"
                )
            found.append((module, field, kind))
    return found


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2

    target = argv[1]
    provided = set()
    for path in argv[2:]:
        names = exports(open(path, "rb").read())
        provided |= names
        print(f"provider {path}: {len(names)} exports")

    data = open(target, "rb").read()
    try:
        wanted = imports(data)
    except Exception as exc:  # noqa: BLE001 - a parse failure is a result too
        print(f"\n{target}: could not parse the import section — {exc}")
        return 1

    # Only function imports matter: an unresolved one becomes the stub that
    # throws "resolved is not a function" the moment R calls into it. GOT.mem /
    # GOT.func entries are address relocations the dynamic linker fills in, not
    # calls, so they are excluded.
    missing = [
        (m, f)
        for (m, f, kind) in wanted
        if kind == 0 and m == "env" and f not in provided
    ]
    functions = sum(1 for _, _, kind in wanted if kind == 0)
    print(
        f"\n{target}: {len(wanted)} imports ({functions} functions), "
        f"{len(missing)} unresolved"
    )
    for module, field in missing[:200]:
        print(f"  MISSING  {module}.{field}")
    if len(missing) > 200:
        print(f"  … and {len(missing) - 200} more")
    if not missing:
        print("  none — every function import is satisfied by the providers.")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
