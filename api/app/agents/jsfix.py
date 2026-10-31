"""Deterministic fixes for design.js sections before they reach the browser.

Every section runs on its own (the engine wraps each in its own function), but a model sometimes declares a shared palette
in one section (`const stoneClad = {...}`) and uses it in later ones, which then fail with "stoneClad is not defined".
`share_declarations` copies each missing top-level declaration (and the ones it depends on) into the sections that use it.
"""
from __future__ import annotations

import re

DECL_RE = re.compile(r"(?m)^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=")
ANY_DECL_RE = re.compile(r"\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)")
FUNC_RE = re.compile(r"(?m)^\s*function\s+([A-Za-z_$][\w$]*)\s*\(")
BUILTINS = {"s", "THREE", "Math", "JSON", "Object", "Array", "Number", "String", "console", "undefined", "null", "true", "false"}


def _statement_end(code: str, start: int) -> int:
    """Index just past the statement that starts at `start`: the first `;` (or newline after a closed expression) at depth 0,
    outside strings and comments."""
    depth, i, n = 0, start, len(code)
    quote = None
    while i < n:
        ch = code[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif code.startswith("//", i):
            j = code.find("\n", i)
            i = n if j < 0 else j
            continue
        elif code.startswith("/*", i):
            j = code.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        elif ch in "'\"`":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0 and code[i + 1:i + 2] == "\n" and code.startswith("function", start + len(code[start:]) - len(code[start:].lstrip())):
                return i + 1
        elif ch == ";" and depth == 0:
            return i + 1
        elif ch == "\n" and depth == 0 and i > start and not code[start:i].rstrip().endswith(("=", ",", "+", "-", "*", "/", "?", ":", "(", "{", "[", "&&", "||")):
            nxt = code[i + 1:].lstrip()[:1]
            if nxt not in (".", "?", ":", "+", "-", "*", "/", ")", "]", "}", ","):
                return i
        i += 1
    return n


def _code_map(code: str) -> tuple[list[int], str]:
    """(the brace depth at each index, the code with strings and comments blanked), so `{ glass: "x" }` and "glass" aren't code."""
    depths, chars = [0] * len(code), list(code)
    depth, i, n = 0, 0, len(code)
    quote = None
    while i < n:
        ch = code[i]
        depths[i] = depth
        if quote:
            if ch == "\\" and i + 1 < n:
                chars[i] = chars[i + 1] = " "
                if i + 1 < n:
                    depths[i + 1] = depth
                i += 2
                continue
            if ch == quote:
                quote = None
            chars[i] = " " if ch != "\n" else ch
        elif code.startswith("//", i) or code.startswith("/*", i):
            end = code.find("\n", i) if code[i + 1] == "/" else code.find("*/", i + 2)
            end = n if end < 0 else (end if code[i + 1] == "/" else end + 2)
            for k in range(i, end):
                depths[k] = depth
                if chars[k] != "\n":
                    chars[k] = " "
            i = end
            continue
        elif ch in "'\"":
            quote = ch
            chars[i] = " "
        elif ch == "`":  # template literals stay: their ${...} is code
            pass
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    return depths, "".join(chars)


def declarations(code: str) -> dict[str, str]:
    """Top-level `const/let/var NAME = …;` and `function NAME(…) {…}` statements of a section, by name. A declaration inside a
    loop or a block is never one: it may lean on the loop's own variables."""
    out: dict[str, str] = {}
    depths, _ = _code_map(code)
    for rx in (DECL_RE, FUNC_RE):
        for m in rx.finditer(code):
            at = m.start() + len(m.group(0)) - len(m.group(0).lstrip())
            if depths[at]:
                continue
            end = _statement_end(code, at)
            out.setdefault(m.group(1), code[at:end].strip())
    return out


def _uses(code: str, name: str) -> bool:
    """Whether code really refers to `name`: strings, comments and object keys (`{ glass: "glass_clear" }`) don't count."""
    _, clean = _code_map(code)
    for m in re.finditer(rf"(?<![\w$.]){re.escape(name)}(?![\w$])", clean):
        before, after = clean[:m.start()].rstrip()[-1:], clean[m.end():].lstrip()[:1]
        if after == ":" and before in ("{", ",", ""):
            continue
        return True
    return False


def share_declarations(sections: list[dict]) -> list[str]:
    """Prepend missing declarations to the sections that use them. Returns 'section: names' lines for the log."""
    pool: dict[str, str] = {}
    for sec in sections:
        for name, stmt in declarations(sec["code"]).items():
            pool.setdefault(name, stmt)
    fixed = []
    for sec in sections:
        own = set(declarations(sec["code"])) | set(ANY_DECL_RE.findall(sec["code"]))  # a name it declares anywhere is its own
        need: list[str] = []

        def want(name: str, seen: set[str]) -> None:
            if name in own or name in seen or name in BUILTINS or name not in pool:
                return
            seen.add(name)
            for dep in pool:  # its own dependencies first
                if dep != name and _uses(pool[name], dep):
                    want(dep, seen)
            need.append(name)
        seen: set[str] = set()
        body = sec["code"]
        for name in pool:
            if name not in own and _uses(body, name):
                want(name, seen)
        if need:
            sec["code"] = "// shared declarations copied in (each section runs on its own)\n" + "\n".join(pool[n] for n in need) + "\n" + body
            fixed.append(f"{sec['name']}: {', '.join(need)}")
    return fixed
