#!/usr/bin/env /opt/homebrew/bin/python3
"""
=== JARVIS MOD #106 — mmrag semantic-search sidecar =========================

WHY THIS EXISTS
The voice stack needs semantic recall over the UHS knowledge base inside a
spoken turn. Shelling out to `mmrag.py query` costs 4-6 seconds before it does
any work at all: chromadb + google.genai are heavy imports, the ChromaDB
persistent client re-opens a 93k-chunk index, and the process then dies and
throws all of it away. That is a per-question tax paid forever.

So the imports happen ONCE, at boot, in a long-lived process that keeps the
`uhs` collection handle warm and answers over loopback HTTP. Measured budget:
warm query 0.3-0.9s (one Gemini embedding call plus an in-memory HNSW search).

CONTRACT
  GET  /health              -> {"ok":true,"collection":"uhs","count":<n>,"warm":true}
  POST /query  {"query": "...", "n_results": 8, "threshold": 0.0}
       GET  /query?q=...&n=8
    -> {"ok":true, "query":..., "results":[{source, filename, snippet,
        similarity, chunk_index}], "elapsed_ms":<n>}

  Errors return HTTP 200 with {"ok":false,"error":...} ONLY for bad input;
  genuine failures return 5xx so the caller's fallback path is unambiguous.

LOOPBACK ONLY. Binds 127.0.0.1. No auth: anything that can reach the port can
already read the vault on this machine. Never bind 0.0.0.0.

HOME MUST BE PINNED. The Gemini key lives in ~/.mmrag/config.json and the
ChromaDB index in ~/.mmrag/chromadb. PM2's environment is scrubbed and does not
carry HOME, so the pm2 entry sets HOME=/Users/sascherman explicitly. Without it
this process starts, answers /health, and fails every query — the worst failure
shape there is. Hence the boot-time assertion below: it refuses to start rather
than pretend.

READ-ONLY. This process never ingests, never writes to the collection.
=== END header ===
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("MMRAG_SIDECAR_PORT", "8791"))
HOST = "127.0.0.1"
COLLECTION = os.environ.get("MMRAG_SIDECAR_COLLECTION", "uhs")
MMRAG_DIR = Path(os.environ.get("MMRAG_DIR", str(Path.home() / ".mmrag")))
CONFIG_FILE = MMRAG_DIR / "config.json"
CHROMADB_DIR = MMRAG_DIR / "chromadb"
SNIPPET_CHARS = 400
# MOD #106d — the caller needs the whole chunk to locate it in its file.
CHUNK_TEXT_CHARS = 1600
# A short, distinctive prefix used as the anchor for that lookup.
CHUNK_ANCHOR_CHARS = 120

EMBED_CACHE_MAX = 256

_lock = threading.Lock()
_state: dict = {"collection": None, "genai": None, "config": None}
_embed_cache: "dict[str, list]" = {}


def log(msg: str) -> None:
    print(f"[mmrag-sidecar] {msg}", flush=True)


def boot() -> None:
    """Import the heavy deps and open the collection ONCE."""
    if not CONFIG_FILE.exists():
        raise SystemExit(
            f"FATAL: {CONFIG_FILE} not found. HOME is {os.environ.get('HOME')!r} — "
            "if that is not /Users/sascherman the pm2 env is scrubbed; pin HOME."
        )
    with open(CONFIG_FILE) as f:
        config = json.load(f)
    api_key = os.environ.get("GEMINI_API_KEY") or config.get("gemini_api_key")
    if not api_key:
        raise SystemExit("FATAL: no gemini_api_key in config and no GEMINI_API_KEY in env.")

    t0 = time.time()
    import chromadb  # heavy — the entire point of this process
    from google import genai

    client = chromadb.PersistentClient(path=str(CHROMADB_DIR))
    collection = client.get_collection(name=COLLECTION)
    _state["collection"] = collection
    _state["genai"] = genai.Client(api_key=api_key)
    _state["config"] = config
    # === MOD #106g — pay the HNSW cold cost at BOOT, not on the first spoken
    # question. Measured after a restart: the first two searches took 2.5-2.7s
    # (index pages faulting in from disk) while every later one took 30-100ms.
    # Those first queries were landing on Scott — a block of consecutive
    # semantic-deadline misses right after any ingest/restart, which the
    # closing review caught as six timeouts in a row and one false decline.
    # A throwaway vector query touches the same pages a real one does.
    import random
    t_warm = time.time()
    dims = config.get("embedding_dimensions", 768)
    for _ in range(2):
        collection.query(
            query_embeddings=[[random.uniform(-0.05, 0.05) for _ in range(dims)]],
            n_results=600,
            include=["metadatas"],
        )
    log(f"HNSW warmed in {time.time() - t_warm:.1f}s (2 priming queries, k=600)")
    # === MOD #106g — the derived contract clauses are scored EXACTLY. =========
    # They are ~131 chunks in a 75k-chunk collection: at any affordable k they
    # lose the ANN lottery to transcripts (measured: the HVAC clause, which IS
    # the answer, never appeared in the top 600). Brute-force cosine over 131
    # held-in-memory vectors costs ~2ms and never misses. This is the narrow,
    # cheap version of the metadata-filtered retrieval the round-6 experiment
    # called for; the general form still wants an ingest-time metadata field.
    clause_dir = MMRAG_DIR / "derived" / "uhs-contract-clauses"
    clause_sources = sorted(str(f) for f in clause_dir.glob("*.md")) if clause_dir.exists() else []
    _state["clauses"] = []
    if clause_sources:
        got = collection.get(
            where={"source": {"$in": clause_sources}},
            include=["embeddings", "documents", "metadatas"],
        )
        embs = got.get("embeddings")
        has_embs = embs is not None and len(embs) > 0
        if has_embs:
            import math
            for vec, doc, meta in zip(embs, got.get("documents") or [], got.get("metadatas") or []):
                norm = math.sqrt(sum(v * v for v in vec)) or 1.0
                _state["clauses"].append(
                    {"vec": [v / norm for v in vec], "doc": doc or "", "meta": meta or {}}
                )
        log(f"clause corpus pinned: {len(_state['clauses'])} chunks scored exactly per query")
    log(
        f"warm in {time.time() - t0:.1f}s — collection {COLLECTION!r} "
        f"holds {collection.count()} chunks; listening on {HOST}:{PORT}"
    )


def embed_query(text: str) -> list:
    """Embed a query, with a small cache.

    MOD #106b: measured, the ChromaDB search is 50-100ms and the Gemini
    embedding call is 240ms typical / 2,300ms at the tail — the embedding IS
    the latency. A spoken conversation circles the same subject ("what's our
    paint policy" → "and for occupied homes?" → back again), so caching the
    exact query text is a real saving, not a benchmark trick. Bounded because
    an unbounded cache in a long-lived process is a slow leak.
    """
    from google.genai import types

    cached = _embed_cache.get(text)
    if cached is not None:
        return cached

    cfg = _state["config"]
    result = _state["genai"].models.embed_content(
        model=cfg.get("embedding_model", "gemini-embedding-2-preview"),
        contents=text,
        config=types.EmbedContentConfig(
            output_dimensionality=cfg.get("embedding_dimensions", 768),
            task_type="RETRIEVAL_QUERY",
        ),
    )
    vec = result.embeddings[0].values
    with _lock:
        if len(_embed_cache) >= EMBED_CACHE_MAX:
            _embed_cache.pop(next(iter(_embed_cache)))
        _embed_cache[text] = vec
    return vec


def run_query(question: str, n_results: int, threshold: float, prefixes=None) -> dict:
    t0 = time.time()
    collection = _state["collection"]
    embedding = embed_query(question)
    t_embed = time.time()
    # Over-fetch HARD. The caller post-filters by source path, and the `uhs`
    # collection is mostly NOT vault: measured 2026-08-09, a filtered "paint
    # policy" query kept 26 of 240 raw hits. At n_results*4 the filter routinely
    # returned nothing and the semantic leg looked dead when it was merely
    # drowned out by transcripts. 240 candidates cost ~270ms — cheap insurance.
    # MOD #106f — when the caller restricts to a source subset, over-fetch MUCH
    # harder. The vault and the derived clause docs are ~5k of 74.8k chunks, so
    # at k=600 a clause competes with the whole transcript corpus for a slot:
    # measured, "what if a tenant moves in while we are staged" returned exactly
    # ONE derived clause in the top 600, and it was the wrong one. Retrieval is
    # ~0.1s at k=600 and still cheap at k=4000; the embedding call dominates.
    # MOD #106f, REVERTED THE SAME DAY: raising this to 4,000 when the caller
    # filters DID surface the right clause (clause 7.5 went from absent to rank
    # one at 0.732) — and cost 1.2-1.7s per query, which pushed most queries
    # past the 1,200ms semantic deadline. They then scored with no semantic
    # support at all and DECLINED. Recall fell off a cliff to buy better
    # retrieval. The real fix is a metadata filter inside ChromaDB so the subset
    # is retrieved directly rather than fished out of a bigger k; that needs an
    # ingest-time metadata field and is not a same-day change.
    fetch_k = min(max(n_results * 15, 100), max(collection.count(), 1))
    with _lock:
        res = collection.query(
            query_embeddings=[embedding],
            n_results=fetch_k,
            include=["documents", "metadatas", "distances"],
        )
    t_search = time.time()
    # Exact clause scores merged in — immune to k-starvation above.
    clause_hits = []
    clauses = _state.get("clauses") or []
    if clauses:
        import math
        qnorm = math.sqrt(sum(v * v for v in embedding)) or 1.0
        qv = [v / qnorm for v in embedding]
        for c in clauses:
            sim = sum(a * b for a, b in zip(qv, c["vec"]))
            if sim >= max(threshold, 0.45):
                clause_hits.append((sim, c))

    out = []
    ids = res.get("ids") or [[]]
    for i, _doc_id in enumerate(ids[0]):
        distance = res["distances"][0][i] if res.get("distances") else 0.0
        similarity = 1.0 - distance
        if similarity < threshold:
            continue
        meta = res["metadatas"][0][i] if res.get("metadatas") else {}
        # MOD #106d — FILTER HERE, not in the caller. Returning the full text of
        # all ~600 candidates so the caller could keep ~40 of them meant ~1MB of
        # JSON per query and pushed p95 to 4.2s. The caller's roots come in with
        # the request; everything outside them is dropped before serialisation.
        src = meta.get("source", "")
        if prefixes and not any(src.startswith(pfx) for pfx in prefixes):
            continue
        doc = res["documents"][0][i] if res.get("documents") else ""
        text = (doc or "").strip()
        out.append(
            {
                "source": meta.get("source", ""),
                "filename": meta.get("filename", ""),
                "chunk_index": meta.get("chunk_index", 0),
                "total_chunks": meta.get("total_chunks", 0),
                "similarity": round(float(similarity), 4),
                "snippet": text[:SNIPPET_CHARS],
                # MOD #106d: the FULL chunk, so the caller can locate it inside
                # its file and hand the answer back as the section that contains
                # it. Chunks are ~1,500 characters by mmrag's own config; the
                # 400-character snippet was enough to quote but not enough to
                # find. Loopback only, so the payload cost is irrelevant.
                "text": text[:CHUNK_TEXT_CHARS],
                "head": text[:CHUNK_ANCHOR_CHARS],
            }
        )
    seen_chunks = {(o["source"], o["chunk_index"]) for o in out}
    for sim, c in sorted(clause_hits, reverse=True, key=lambda x: x[0]):
        meta = c["meta"]
        src = meta.get("source", "")
        if prefixes and not any(src.startswith(pfx) for pfx in prefixes):
            continue
        if (src, meta.get("chunk_index", 0)) in seen_chunks:
            continue
        text = (c["doc"] or "").strip()
        out.append(
            {
                "source": src,
                "filename": meta.get("filename", ""),
                "chunk_index": meta.get("chunk_index", 0),
                "total_chunks": meta.get("total_chunks", 0),
                "similarity": round(float(sim), 4),
                "snippet": text[:SNIPPET_CHARS],
                "text": text[:CHUNK_TEXT_CHARS],
                "head": text[:CHUNK_ANCHOR_CHARS],
            }
        )
    return {
        "ok": True,
        "embed_ms": int((t_embed - t0) * 1000),
        "search_ms": int((t_search - t_embed) * 1000),
        "query": question,
        "results": out,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter than the stdlib default
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            try:
                count = _state["collection"].count()
            except Exception as exc:  # noqa: BLE001
                return self._send(500, {"ok": False, "error": str(exc)})
            return self._send(
                200, {"ok": True, "collection": COLLECTION, "count": count, "warm": True}
            )
        if parsed.path == "/query":
            qs = parse_qs(parsed.query)
            question = (qs.get("q") or [""])[0]
            n = int((qs.get("n") or ["8"])[0])
            threshold = float((qs.get("threshold") or ["0"])[0])
            return self._handle_query(question, n, threshold, None)
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/query":
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            return self._send(200, {"ok": False, "error": "invalid JSON body"})
        prefixes = body.get("source_prefixes")
        return self._handle_query(
            str(body.get("query") or ""),
            int(body.get("n_results") or 8),
            float(body.get("threshold") or 0),
            [str(p) for p in prefixes] if isinstance(prefixes, list) else None,
        )

    def _handle_query(self, question: str, n_results: int, threshold: float, prefixes=None):
        if not question.strip():
            return self._send(200, {"ok": False, "error": "empty query"})
        try:
            return self._send(200, run_query(question.strip(), n_results, threshold, prefixes))
        except Exception as exc:  # noqa: BLE001
            log(f"query failed: {exc}")
            # 5xx, deliberately: the caller must be able to tell "the semantic
            # leg is down" from "the semantic leg found nothing".
            return self._send(503, {"ok": False, "error": str(exc)})


def main() -> None:
    boot()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
