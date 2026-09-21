import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('image catalog UI', () => {
  it('is list/add/repull/remove without free-form fields', () => {
    const page = read('pages/images-page.tsx');
    const catalog = read('components/images/image-catalog-dialog.tsx');
    const list = read('components/images/image-list.tsx');
    const detail = read('pages/image-detail-page.tsx');
    expect(page).toMatch(/ImageCatalogDialog/);
    expect(page).not.toMatch(/ImageFormDialog/);
    expect(catalog).toMatch(/\/admin\/images\/catalog/);
    expect(catalog).toMatch(/\{ alias \}/);
    expect(catalog).not.toMatch(/loginUser/);
    expect(list).toMatch(/重新拉取/);
    expect(list).toMatch(/移除/);
    expect(detail).not.toMatch(/ImageFormDialog/);
    expect(detail).toMatch(/重新拉取/);
    expect(detail).toMatch(/\/admin\/images\/\$\{loaded\.id\}\/intents/);
    expect(detail).toMatch(/镜像移除意图已提交/);
    expect(detail).not.toMatch(/镜像删除意图已提交/);
  });

  it('renders intent history errors and does not share limit=20/50 query keys', () => {
    const intents = read('components/intents/resource-intent-failures.tsx');
    const keys = read('lib/query-keys.ts');
    expect(intents).toMatch(/query\.isError/);
    expect(intents).toMatch(/limit=20/);
    expect(intents).toMatch(/limit=50/);
    expect(intents).toMatch(/resourceIntentFailures\(admin \? 'admin' : 'user', listPath, 20\)/);
    expect(intents).toMatch(/resourceIntentFailures\(admin \? 'admin' : 'user', listPath, 50\)/);
    expect(intents).toMatch(/currentOutstandingIntents/);
    expect(intents).not.toMatch(/latestIntentsByResource/);
    expect(keys).toMatch(/resourceIntentFailures: \(plane: Plane, listPath: string, limit: number\)/);
  });
});
