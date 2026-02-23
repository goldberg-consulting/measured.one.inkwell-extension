// Content-addressed cache for code block outputs. Each block is hashed
// by its source (or referenced file), language, and key attributes.
// A cache hit requires both a matching hash and a prior zero exit code,
// so failed runs are always re-executed.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CodeBlock } from "./runner";

export interface BlockCacheEntry {
  hash: string;
  exitCode: number;
  timestamp: number;
}

export interface BlockCache {
  version: 1;
  blocks: Record<number, BlockCacheEntry>;
}

const CACHE_FILE = "cache.json";

export function loadCache(cacheDir: string): BlockCache {
  const file = path.join(cacheDir, CACHE_FILE);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === 1) return parsed;
  } catch {}
  return { version: 1, blocks: {} };
}

export function saveCache(cacheDir: string, cache: BlockCache): void {
  const file = path.join(cacheDir, CACHE_FILE);
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), "utf-8");
}

export function getBlockHash(block: CodeBlock, workDir: string): string {
  const h = crypto.createHash("sha256");

  if (block.file) {
    const resolved = path.resolve(workDir, block.file);
    try {
      h.update(fs.readFileSync(resolved));
    } catch {
      h.update(`missing:${block.file}`);
    }
  } else {
    h.update(block.source);
  }

  h.update(`\0lang=${block.lang}`);
  if (block.output) h.update(`\0output=${block.output}`);
  if (block.env) h.update(`\0env=${block.env}`);

  return h.digest("hex").substring(0, 16);
}

export function clearCache(cacheDir: string): void {
  const file = path.join(cacheDir, CACHE_FILE);
  try {
    fs.unlinkSync(file);
  } catch {}
}
