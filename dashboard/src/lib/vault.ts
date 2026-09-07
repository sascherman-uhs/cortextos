/**
 * Vault helpers for the dashboard /wiki page.
 *
 * Resolves the org's Obsidian vault path, parses frontmatter, scopes file
 * reads to PARA-tree paths only (read-only — no writes from the dashboard).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CTX_FRAMEWORK_ROOT } from './config';

// === JARVIS MOD #106 — allow-list → deny-list =================================
// This module used to carry a hand-maintained whitelist of 13 directory names
// (the 7 PARA dirs plus 5 UHS ones). The UHS vault has 26 top-level dirs and
// 418 markdown files; the whitelist matched 5 of them and 38 files. Everything
// the vault actually knows — insights/ (278 files), reference/, internal/,
// external/, team/, brand/, wiki/ — was invisible to /api/wiki/search and to
// anything else built on listAllNotes. A whitelist of names nobody updates is
// indistinguishable from a vault that is mostly empty.
//
// So: walk from the root and deny the junk instead. Only .md files are ever
// collected, so binaries exclude themselves; this list is for directories that
// hold attachments, caches, or vendored trees whose contents are noise.
export const VAULT_DENY_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  'node_modules',
  'attachments',
  'assets',
  'media',
  '_resources',
]);

/** Directory names that should never be walked or served (deny list + dotdirs). */
export function isDeniedDir(name: string): boolean {
  return name.startsWith('.') || VAULT_DENY_DIRS.has(name.toLowerCase());
}

/** Top-level vault directories, discovered rather than declared. */
export function listVaultTopDirs(vaultRoot: string): string[] {
  try {
    return fs
      .readdirSync(vaultRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isDeniedDir(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
// === END MOD #106 ===

const VAULT_FALLBACK = process.env.CTX_VAULT_PATH
  ?? path.join(os.homedir(), 'storage', 'Documents', 'Github', 'sondres-orchestrator', 'vault');

export function getVaultRoot(org: string): string | null {
  // 1. Try parsing orgs/<org>/knowledge.md for an "Obsidian vault" path entry
  const knowledgePath = path.join(CTX_FRAMEWORK_ROOT, 'orgs', org, 'knowledge.md');
  if (fs.existsSync(knowledgePath)) {
    try {
      const content = fs.readFileSync(knowledgePath, 'utf-8');
      // Match a code path like `/root/.../vault/` after "Obsidian vault" mentions
      const match = content.match(
        /Obsidian vault[^\n]*?`([^`]+vault\/?)`/i,
      );
      if (match) {
        const p = match[1].replace(/\/$/, '');
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Fallback to the known sondre-hq vault location
  if (fs.existsSync(VAULT_FALLBACK) && fs.statSync(VAULT_FALLBACK).isDirectory()) {
    return VAULT_FALLBACK;
  }

  return null;
}

export type Frontmatter = {
  type?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  status?: string;
  agent?: string;
  session?: string;
  relates_to?: string[];
  [key: string]: unknown;
};

export function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };

  const fm: Frontmatter = {};
  const block = m[1];

  for (const line of block.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value: unknown = kv[2].trim();
    const v = value as string;

    if (v === '') {
      value = '';
    } else if (v.startsWith('[') && v.endsWith(']')) {
      // Array — comma split inside the brackets, strip quotes
      value = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      // Strip surrounding quotes if present
      value = v.replace(/^["']|["']$/g, '');
    }

    fm[key] = value;
  }

  return { frontmatter: fm, body: m[2] };
}

export function firstMeaningfulLine(body: string, max = 160): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // skip headings
    if (line.startsWith('```')) continue;
    if (line === '---') continue;
    return line.length > max ? line.slice(0, max).trimEnd() + '…' : line;
  }
  return '';
}

/**
 * Resolves a relative vault path safely. Refuses traversal, hidden paths, and
 * anything under a denied directory.
 *
 * MOD #106: the old gate required the first segment to be a PARA dir name,
 * which made every note outside those 13 folders unopenable from the wiki UI
 * even when search found it. The security boundary that matters is "inside the
 * vault root, not hidden, not junk" — that is what is checked now.
 */
export function resolveVaultPath(
  vaultRoot: string,
  relPath: string,
): string | null {
  // Strip leading slashes; we want a relative path inside the vault
  const cleaned = relPath.replace(/^\/+/, '');
  // Reject any traversal attempts up front
  if (cleaned.includes('..')) return null;
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  // Every directory segment must be walkable; the leaf must not be hidden.
  if (segments.some((s) => isDeniedDir(s))) return null;

  const abs = path.resolve(vaultRoot, cleaned);
  // Defense in depth — confirm resolved path is inside the vault root
  if (!abs.startsWith(path.resolve(vaultRoot) + path.sep)) return null;
  return abs;
}

/**
 * Walk the whole vault and collect every .md file. Used by search.
 * MOD #106: walks from the root (minus the deny list) instead of 13 named dirs.
 * Root-level notes (README.md, agent-skill-requests.md) are included too.
 */
export function listAllNotes(vaultRoot: string): Array<{
  relPath: string;
  absPath: string;
  mtimeMs: number;
}> {
  const out: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];
  if (!fs.existsSync(vaultRoot)) return out;
  walk(vaultRoot, vaultRoot, out);
  return out;
}

function walk(
  abs: string,
  vaultRoot: string,
  out: Array<{ relPath: string; absPath: string; mtimeMs: number }>,
) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (isDeniedDir(entry.name)) continue;
      walk(child, vaultRoot, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(child);
      out.push({
        relPath: path.relative(vaultRoot, child),
        absPath: child,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
}

/**
 * Resolve a wikilink slug (e.g. "20260506-dev-foo" or "foo/bar") to a vault
 * file path. Searches all PARA dirs for the first matching basename (with or
 * without .md extension).
 */
export function resolveWikilink(
  vaultRoot: string,
  slug: string,
): string | null {
  const normalized = slug.replace(/\.md$/, '');
  for (const note of listAllNotes(vaultRoot)) {
    const base = path.basename(note.relPath, '.md');
    if (base === normalized) return note.relPath;
  }
  // Also try exact relative path match (e.g. "01-projects/coliseum")
  for (const note of listAllNotes(vaultRoot)) {
    if (note.relPath.replace(/\.md$/, '') === normalized) return note.relPath;
  }
  return null;
}
