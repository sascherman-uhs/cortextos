#!/usr/bin/env python3
"""
kb_checklist_compare.py — Nightly Ideal-KB coverage comparison.

Compares the live knowledge base against the north-star home-staging taxonomy
(dashboard/src/data/ideal-kb-taxonomy.json) and writes *detected* coverage
suggestions into the per-org checklist state file. These are suggestions only:
the dashboard surfaces them as an amber "Detected" state that a human confirms
(confirming writes a manual items[] entry). This script NEVER flips an item to
manually-complete — that is a human decision (see route.ts).

Why document-level matching (not raw chunk similarity): the entire KB is
home-staging content, so every taxonomy title scores 0.62-0.83 against *some*
chunk. Instead we build a centroid embedding per source DOCUMENT and match each
requirement to its best-matching document, which is far more discriminating —
a requirement only "detects" when an actual document is largely about it.

Usage:
    kb_checklist_compare.py --org uhs [--collection uhs] [--threshold 0.66] [--dry-run]

Exit 0 on success; prints a JSON summary to stdout.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

MMRAG_DIR = os.path.expanduser("~/.claude/skills/multimodal-rag/scripts")
sys.path.insert(0, MMRAG_DIR)

# Taxonomy lives with the dashboard (single source of truth for the checklist UI).
TAXONOMY_PATH = os.path.expanduser(
    "~/cortextos/dashboard/src/data/ideal-kb-taxonomy.json"
)

# Source files that are the checklist itself, not evidence of coverage
# (the taxonomy doc lists every requirement, so it would match all of them).
EXCLUDE_SUBSTRINGS = (
    "ideal-home-staging-knowledge-base",
    "ideal-home-staging-kb-taxonomy",
)


def ctx_root() -> str:
    return os.environ.get(
        "CTX_ROOT",
        os.path.join(os.path.expanduser("~/.cortextos"),
                     os.environ.get("CTX_INSTANCE_ID", "default")),
    )


def state_path(org: str) -> str:
    return os.path.join(ctx_root(), "orgs", org, "ideal-kb-checklist.json")


def normalize(vec):
    import numpy as np
    v = np.asarray(vec, dtype=float)
    n = float(np.linalg.norm(v)) or 1.0
    return v / n


def cosine_unit(a, b):
    # a, b already unit-normalized numpy vectors
    import numpy as np
    return float(np.dot(a, b))


def build_doc_centroids(collection):
    """Group every chunk embedding by source filename -> averaged, unit-normalized centroid."""
    import numpy as np
    got = collection.get(include=["embeddings", "metadatas"])
    embs = got.get("embeddings")
    metas = got.get("metadatas")
    if embs is None or len(embs) == 0:
        return {}
    metas = metas if metas is not None else [{}] * len(embs)
    groups = {}  # filename -> list of vectors
    for emb, meta in zip(embs, metas):
        fname = (meta or {}).get("filename") or (meta or {}).get("source") or "unknown"
        if any(s in fname for s in EXCLUDE_SUBSTRINGS):
            continue
        groups.setdefault(fname, []).append(np.asarray(emb, dtype=float))
    centroids = {}
    for fname, vecs in groups.items():
        centroids[fname] = normalize(np.mean(np.vstack(vecs), axis=0))
    return centroids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--org", required=True)
    ap.add_argument("--collection", default=None, help="defaults to --org value")
    ap.add_argument("--threshold", type=float, default=0.72)
    ap.add_argument("--taxonomy", default=TAXONOMY_PATH)
    ap.add_argument("--dry-run", action="store_true", help="print results, do not write state")
    args = ap.parse_args()

    collection_name = args.collection or args.org

    import mmrag
    cfg = mmrag.load_config()
    client = mmrag.get_genai_client(mmrag.get_api_key(cfg))
    collection = mmrag.get_chroma_collection(collection_name)

    tax = json.load(open(args.taxonomy))
    docs = [(d["id"], d["name"], d.get("purpose", ""))
            for c in tax["categories"] for d in c["docs"]]

    import numpy as np
    centroids = build_doc_centroids(collection)
    if not centroids:
        print(json.dumps({"ok": False, "error": "no source documents in collection",
                          "collection": collection_name}))
        return 0

    doc_names = list(centroids)
    C = np.vstack([centroids[f] for f in doc_names])                       # Ndocs x dim (unit)
    Q = np.vstack([normalize(mmrag.embed_query(client, cfg,
                   f"{name}. {purpose}".strip(". ")))
                   for _, name, purpose in docs])                          # Nitems x dim (unit)
    S = Q @ C.T                                                            # Nitems x Ndocs cosine

    item_best_doc = S.argmax(axis=1)   # for each requirement, its best document
    doc_best_item = S.argmax(axis=0)   # for each document, its best requirement
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Mutual-best match: a requirement is "detected" only when its best document
    # is also primarily about that requirement. Far more precise than raw
    # similarity (everything matches *something* in a staging-only KB), so a
    # false "detected" is unlikely to hide a real gap.
    detected = {}
    for i, (doc_id, _name, _purpose) in enumerate(docs):
        j = int(item_best_doc[i])
        score = float(S[i, j])
        if doc_best_item[j] == i and score >= args.threshold:
            detected[doc_id] = {
                "source": doc_names[j],
                "score": round(score, 4),
                "detectedAt": now,
            }

    summary = {
        "ok": True,
        "org": args.org,
        "collection": collection_name,
        "threshold": args.threshold,
        "sourceDocuments": len(centroids),
        "requirements": len(docs),
        "detectedCount": len(detected),
    }

    if args.dry_run:
        summary["detected"] = detected
        print(json.dumps(summary, indent=2))
        return 0

    # Merge: preserve manual items[], replace detected[] with this fresh pass.
    sp = state_path(args.org)
    os.makedirs(os.path.dirname(sp), exist_ok=True)
    state = {"items": {}, "detected": {}}
    if os.path.exists(sp):
        try:
            cur = json.load(open(sp))
            if isinstance(cur.get("items"), dict):
                state["items"] = cur["items"]
        except Exception:
            pass
    state["detected"] = detected
    tmp = sp + ".tmp"
    json.dump(state, open(tmp, "w"), indent=2)
    os.replace(tmp, sp)

    summary["stateFile"] = sp
    summary["newlyDetectedNotYetConfirmed"] = sum(
        1 for k in detected if not state["items"].get(k, {}).get("done")
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
