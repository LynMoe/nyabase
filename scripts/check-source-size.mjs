#!/usr/bin/env node
// Size budget for hand-written backend/frontend sources: <= 800 lines per file,
// <= 150 lines per function/method. An exception needs a one-line
// `// size-exception: <reason>` comment: anywhere in the file for the file
// limit, or directly above the function for the function limit.
// Fragmentation budget (non-test files): <= 16 per backend module directory
// (recursive; platform/ is the shared toolkit and exempt), <= 4 per frontend
// page or component sub-folder. Split by responsibility, not by line count.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/backend/package.json'));
const ts = require('typescript');
const FILE_LIMIT = 800;
const FUNCTION_LIMIT = 150;
const GENERATED = ['api-types.ts', 'routeTree.gen.ts'];
const BACKEND_MODULE_FILE_LIMIT = 16;
const BACKEND_MODULE_EXEMPT = new Set(['platform']);
const FRONTEND_FOLDER_FILE_LIMIT = 4;

const tracked = execFileSync('git', ['ls-files', 'packages/*.ts', 'packages/*.tsx'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => /^packages\/(backend|frontend|common|agent)\/src\//.test(f))
  .filter((f) => !GENERATED.some((g) => f.endsWith(g)))
  .filter((f) => !/\.(test|spec|test-helper|pg-test-helper)\.tsx?$/.test(f) && !f.endsWith('.d.ts'));

const problems = [];
const counts = new Map();
const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
for (const rel of tracked) {
  const backend = /^packages\/backend\/src\/([^/]+)\//.exec(rel);
  if (backend && !BACKEND_MODULE_EXEMPT.has(backend[1])) bump(`packages/backend/src/${backend[1]}/`);
  const frontend = /^(packages\/frontend\/src\/(?:pages\/[^/]+|components\/[^/]+\/[^/]+)\/)[^/]+$/.exec(rel);
  if (frontend) bump(frontend[1]);
}
for (const [dir, count] of counts) {
  const limit = dir.startsWith('packages/backend/') ? BACKEND_MODULE_FILE_LIMIT : FRONTEND_FOLDER_FILE_LIMIT;
  if (count > limit) problems.push(`${dir}: ${count} non-test files (limit ${limit})`);
}
for (const rel of tracked) {
  const text = readFileSync(join(root, rel), 'utf8');
  const lines = text.split('\n');
  const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  if (lineCount > FILE_LIMIT && !/\/\/ size-exception:/.test(text)) {
    problems.push(`${rel}: ${lineCount} lines (limit ${FILE_LIMIT})`);
  }
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    const isFn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessor(node) || ts.isSetAccessor(node);
    if (isFn && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart()).line;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      const length = end - start + 1;
      if (length > FUNCTION_LIMIT) {
        let anchor = start;
        let owner = node;
        while (owner.parent && !ts.isSourceFile(owner.parent) && !ts.isBlock(owner.parent)
          && sf.getLineAndCharacterOfPosition(owner.parent.getStart()).line === start) owner = owner.parent;
        anchor = sf.getLineAndCharacterOfPosition(owner.getStart()).line;
        const above = lines.slice(Math.max(0, anchor - 3), anchor).join('\n');
        if (!/\/\/ size-exception:/.test(above)) {
          problems.push(`${rel}:${start + 1}: function is ${length} lines (limit ${FUNCTION_LIMIT})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (problems.length > 0) {
  console.error('Source size budget exceeded (add "// size-exception: <reason>" only with a real reason):');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`source size ok (${tracked.length} files)`);
