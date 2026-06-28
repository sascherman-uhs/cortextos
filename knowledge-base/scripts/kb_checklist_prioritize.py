#!/usr/bin/env python3
"""
kb_checklist_prioritize.py — Score every Ideal-KB requirement by business impact.

Produces a *transparent, reproducible* priority for each of the 176 taxonomy
documents so the checklist can surface the highest-leverage gaps first. Impact
is judged for a luxury Las Vegas home-staging business against a fixed rubric
(below) by Gemini 2.5 Flash, then stored as a sidecar file the dashboard reads.

This is a heuristic, not ground truth — every score ships with a one-line
rationale so a human can sanity-check and override by eye.

Output: dashboard/src/data/ideal-kb-priorities.json
    { generated, model, rubric, scores: { <docId>: { impact:1-100, tier, why } } }

Usage:
    kb_checklist_prioritize.py [--taxonomy PATH] [--out PATH] [--dry-run]
"""

import argparse
import json
import os
import sys

MMRAG_DIR = os.path.expanduser("~/.claude/skills/multimodal-rag/scripts")
sys.path.insert(0, MMRAG_DIR)

TAXONOMY_PATH = os.path.expanduser("~/cortextos/dashboard/src/data/ideal-kb-taxonomy.json")
OUT_PATH = os.path.expanduser("~/cortextos/dashboard/src/data/ideal-kb-priorities.json")

RUBRIC = (
    "Impact = how much HAVING this document as a finished, reusable asset would "
    "improve business results for a luxury Las Vegas home-staging company. Weigh: "
    "(1) Revenue & conversion — does it directly help win/close more staging jobs or raise price? "
    "(2) Lead generation & brand — does it drive inbound leads, referrals, or reputation? "
    "(3) Operational leverage — is it used on most jobs, saving time or raising quality at scale? "
    "(4) Foundational dependency — does it standardize or unlock many other documents/workflows? "
    "Score 1-100. Tier: High = 70-100, Medium = 45-69, Low = 1-44. "
    "Compliance/admin docs that are necessary but do not move revenue should score Medium or Low."
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", default=TAXONOMY_PATH)
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    tax = json.load(open(args.taxonomy))
    items = [
        {"id": d["id"], "name": d["name"], "purpose": d.get("purpose", ""),
         "category": c["category"], "part": c["part"]}
        for c in tax["categories"] for d in c["docs"]
    ]

    import mmrag
    cfg = mmrag.load_config()
    client = mmrag.get_genai_client(mmrag.get_api_key(cfg))
    model = cfg.get("gemini_model", "gemini-2.5-flash")

    listing = "\n".join(
        f'{it["id"]} | {it["name"]} | {it["category"]} ({it["part"]}) | {it["purpose"]}'
        for it in items
    )
    prompt = (
        f"{RUBRIC}\n\n"
        "Below are documents an ideal home-staging knowledge base should hold, one per line as "
        "`id | name | category (part) | purpose`. Return ONLY a JSON array, one object per id, "
        'shaped {"id": "...", "impact": <int 1-100>, "tier": "High|Medium|Low", '
        '"why": "<max 12 words, concrete business reason>"}. Use the exact ids given. '
        "No prose, no code fences.\n\n"
        f"{listing}"
    )

    from google.genai import types
    resp = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.2,
            response_mime_type="application/json",
        ),
    )
    raw = resp.text.strip()
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1].lstrip("json").strip()
    arr = json.loads(raw)

    valid_ids = {it["id"] for it in items}
    scores = {}
    for o in arr:
        oid = o.get("id")
        if oid not in valid_ids:
            continue
        impact = max(1, min(100, int(o.get("impact", 50))))
        tier = o.get("tier") if o.get("tier") in ("High", "Medium", "Low") else (
            "High" if impact >= 70 else "Medium" if impact >= 45 else "Low")
        scores[oid] = {"impact": impact, "tier": tier, "why": str(o.get("why", ""))[:120]}

    missing = valid_ids - set(scores)
    for mid in missing:  # safe default so every doc has a score
        scores[mid] = {"impact": 50, "tier": "Medium", "why": "(unscored — default)"}

    # The model clusters most business docs as high-impact, which is uninformative
    # for a "do these first" queue. Re-derive a deterministic RANK from raw impact
    # (tie-break by id) and assign tiers by PERCENTILE so the split is usable:
    # top 30% = High, next 40% = Medium, bottom 30% = Low. Raw impact + rationale kept.
    ordered = sorted(scores.items(), key=lambda kv: (-kv[1]["impact"], kv[0]))
    n = len(ordered)
    for rank, (oid, sc) in enumerate(ordered, start=1):
        sc["rank"] = rank
        pct = rank / n
        sc["tier"] = "High" if pct <= 0.30 else "Medium" if pct <= 0.70 else "Low"

    out = {
        "generated": tax.get("generated", ""),
        "model": model,
        "rubric": RUBRIC,
        "scored": len(scores) - len(missing),
        "missingDefaulted": len(missing),
        "scores": scores,
    }

    summary = {"total": len(items), "scored": len(scores), "missingDefaulted": len(missing),
               "tiers": {t: sum(1 for v in scores.values() if v["tier"] == t)
                         for t in ("High", "Medium", "Low")}}

    if args.dry_run:
        print(json.dumps({**summary, "sample": dict(list(scores.items())[:5])}, indent=2))
        return 0

    tmp = args.out + ".tmp"
    json.dump(out, open(tmp, "w"), indent=2, ensure_ascii=False)
    os.replace(tmp, args.out)
    summary["out"] = args.out
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
