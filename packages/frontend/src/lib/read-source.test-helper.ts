import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** All non-test sources directly inside one folder, joined. */
export function readSourceDir(srcRoot: string, rel: string): string {
  return readdirSync(join(srcRoot, rel))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .sort()
    .map((name) => readFileSync(join(srcRoot, rel, name), 'utf8'))
    .join('\n');
}

/**
 * Source of a file for the "UI copy" surface tests. A page that was split
 * keeps its parts in a folder named like the page (`pages/foo-page.tsx` plus
 * `pages/foo-page/`); its source is both.
 */
export function readSource(srcRoot: string, rel: string): string {
  const own = readFileSync(join(srcRoot, rel), 'utf8');
  const partsRel = rel.replace(/\.tsx?$/, '');
  const parts = join(srcRoot, partsRel);
  return existsSync(parts) && statSync(parts).isDirectory()
    ? [own, readSourceDir(srcRoot, partsRel)].join('\n')
    : own;
}
