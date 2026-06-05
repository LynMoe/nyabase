import { describe, expect, it } from 'vitest';

interface DirEntry {
  name: string;
  isDirectory(): boolean;
}

declare const process: {
  cwd(): string;
};

declare const require: {
  (id: 'fs'): {
    readdirSync(path: string, options: { withFileTypes: true }): DirEntry[];
  };
};

const { readdirSync } = require('fs');

function commonSrcPath(): string {
  const cwd = process.cwd();
  const commonRoot = cwd.endsWith('/packages/common') ? cwd : `${cwd}/packages/common`;
  return `${commonRoot}/src`;
}

function collectFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = entries.map((entry: DirEntry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return collectFiles(path);
    return [path];
  });
  return files.flat();
}

describe('common source tree', () => {
  it('does not contain generated JavaScript or declaration artifacts under src', () => {
    const srcDir = commonSrcPath();
    const files = collectFiles(srcDir);
    const generatedArtifacts = files
      .filter((file) => /(?:\.js(?:\.map)?|\.d\.ts(?:\.map)?)$/.test(file))
      .map((file) => file.slice(srcDir.length))
      .sort();

    expect(generatedArtifacts).toEqual([]);
  });
});
