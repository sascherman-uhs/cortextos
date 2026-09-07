#!/usr/bin/env /opt/homebrew/bin/python3
"""
=== JARVIS MOD #106e — clause-grain derivation for the staging agreement ====

WHY
Round 4 left one coherent cluster of misses: contract questions asked in
everyday language ("does the client have to remove weapons", "what if a tenant
moves in", "can we use photos of a staged home"). Each is answered by ONE
numbered bullet inside a 92-section document, and mmrag's 1,500-character
windows chunk that document by length, not by meaning — so the embedding for
any given chunk is "the staging contract, generally", and the clause that
answers the question never surfaces on its own.

The agreement already carries perfect chunk boundaries: its own clause numbers.
This script emits one small markdown document per clause so each becomes its own
embedding.

REVERSIBLE AND NON-POLLUTING, by construction:
  - Output lives OUTSIDE the vault, under ~/.mmrag/derived/<slug>/, so the
    lexical leg (which walks the vault and the memory dirs) never sees it and
    cannot double-answer from it.
  - Every derived file is identifiable by that source-path prefix, so the whole
    addition can be listed or removed with one `mmrag delete` per source.
  - The ORIGINAL agreement's chunks in the index are untouched. Nothing is
    deleted or re-chunked.
  - A manifest maps every derived file back to the real agreement path and its
    clause number. The retrieval lane uses it to attribute an answer to the
    agreement — the derived path is never spoken and never surfaces as a source.

Usage:
  derive-contract-clauses.py --source <agreement.md> [--out <dir>] [--write]
Without --write it prints what it would emit and changes nothing.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

DEFAULT_SOURCE = (
    "/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS/"
    "vault/business/contracts/uhs-standard-home-staging-service-agreement.md"
)
DEFAULT_OUT = Path.home() / ".mmrag" / "derived" / "uhs-contract-clauses"

# "### 7.2 Post Installation Notice to Terminate" / "#### 7.2.1 …"
HEADING_CLAUSE = re.compile(r"^(#{2,6})\s+(\d+(?:\.\d+)*)\.?\s+(.+?)\s*$")
# "- **5.2.3 Working Utilities** — HVAC set to 74°F, electric, water functional."
BULLET_CLAUSE = re.compile(r"^\s*[-*]\s*\*\*(\d+(?:\.\d+)*)\.?\s+([^*]+?)\.?\*\*\s*(.*)$")
# "## 5. Client Responsibilities and Property Access" — the section a clause sits in
SECTION_HEADING = re.compile(r"^##\s+(\d+)\.?\s+(.+?)\s*$")

# A clause whose TITLE is its whole content is still a clause — "5.2.5 Weapons
# and Valuables Removed." has no body and is exactly the text that answers "does
# the client have to remove weapons before we stage".
MIN_CHARS = 18


def derive(source: Path):
    lines = source.read_text(encoding="utf-8").split("\n")
    doc_title = next((l.lstrip("# ").strip() for l in lines if l.startswith("# ")), source.stem)

    clauses = []
    current = None
    section_ctx = ""

    def close(end_line: int):
        nonlocal current
        if current and len((current["title"] + " " + "\n".join(current["body"])).strip()) >= MIN_CHARS:
            clauses.append(current)
        current = None

    for i, line in enumerate(lines):
        m_sec = SECTION_HEADING.match(line)
        if m_sec:
            close(i)
            section_ctx = f"{m_sec.group(1)}. {m_sec.group(2)}"

        m_head = HEADING_CLAUSE.match(line)
        m_bul = BULLET_CLAUSE.match(line)
        if m_head:
            close(i)
            current = {
                "number": m_head.group(2),
                "title": m_head.group(3).strip(),
                "section": section_ctx,
                "body": [],
            }
            continue
        if m_bul:
            close(i)
            current = {
                "number": m_bul.group(1),
                "title": m_bul.group(2).strip(),
                "section": section_ctx,
                "body": [m_bul.group(3).strip()] if m_bul.group(3).strip() else [],
            }
            continue
        if current is not None:
            current["body"].append(line)

    close(len(lines))
    return doc_title, clauses


def render(doc_title: str, source: Path, c: dict) -> str:
    body = "\n".join(c["body"]).strip()
    # The heading repeats the clause number AND its title so the embedding sees
    # both the label people cite and the words people actually say.
    return (
        "---\n"
        f'name: "{doc_title} — clause {c["number"]} {c["title"]}"\n'
        f'description: "Clause {c["number"]} ({c["title"]}) of the {doc_title}'
        f'{", section " + c["section"] if c["section"] else ""}."\n'
        "metadata:\n"
        "  type: contract_clause\n"
        f"  clause: \"{c['number']}\"\n"
        f"  source: \"{source}\"\n"
        "---\n\n"
        f"# {c['number']} {c['title']}\n\n"
        f"{body}\n"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    source = Path(args.source)
    out = Path(args.out)
    doc_title, clauses = derive(source)
    print(f"{len(clauses)} clauses derived from {source.name}")
    for c in clauses[:5]:
        print(f"  {c['number']:10} {c['title'][:60]}")
    if not args.write:
        print("(dry run — pass --write to emit)")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    manifest = {"source": str(source), "generated_from": doc_title, "files": {}}
    for c in clauses:
        fname = f"clause-{c['number']}.md"
        (out / fname).write_text(render(doc_title, source, c), encoding="utf-8")
        manifest["files"][str(out / fname)] = {"source": str(source), "clause": c["number"]}
    (out / "MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"wrote {len(clauses)} files + MANIFEST.json to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
