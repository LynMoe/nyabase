import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './read-source.test-helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function read(rel: string): string {
  return readSource(root, rel);
}

describe('image catalog UI', () => {
  it('is list/add/repull/remove without free-form fields', () => {
    const page = read('pages/images-page.tsx');
    const catalog = read('components/images/image-catalog-dialog.tsx');
    const list = read('components/images/image-list.tsx');
    const detail = read('pages/image-detail-page.tsx');
    expect(page).toMatch(/ImageCatalogDialog/);
    expect(page).not.toMatch(/ImageFormDialog/);
    expect(catalog).toMatch(/'\/images\/catalog'/);
    expect(catalog).toMatch(/\{ alias \}/);
    expect(catalog).not.toMatch(/loginUser/);
    expect(list).toMatch(/拉取最新版本/);
    expect(list).toMatch(/移除/);
    expect(list).toMatch(/image\.alias/);
    expect(list).not.toMatch(/image\.name/);
    expect(detail).not.toMatch(/ImageFormDialog/);
    expect(detail).not.toMatch(/\b(?:loaded|image)\.name\b/);
    expect(detail).toMatch(/\b(?:loaded|image)\.alias/);
    expect(detail).toMatch(/拉取最新版本/);
    expect(detail).toMatch(/IntentResourceType\.ImageAssignment/);
    expect(detail).toMatch(/已开始移除镜像/);
    expect(detail).not.toMatch(/镜像删除意图已提交/);
  });

  it('lists image versions with their containers and deletes only unused ones', () => {
    const detail = read('pages/image-detail-page.tsx');
    const versions = read('pages/image-detail-page/image-versions-tab.tsx');
    expect(detail).toMatch(/ImageVersionsTab/);
    expect(versions).toMatch(/\/versions`/);
    expect(versions).toMatch(/api\.delete<[^>]*>\(`\/images\/\$\{image\.id\}\/versions\/\$\{fingerprint\}`\)/);
    expect(versions).toMatch(/version\.deletable \?/);
    expect(versions).toMatch(/ResourceRef kind="container"/);
  });

  it('renders intent history errors and does not share limit=20/50 query keys', () => {
    const intents = read('components/intents/resource-intent-failures.tsx');
    const keys = read('lib/query-keys.ts');
    expect(intents).toMatch(/query\.isError/);
    expect(intents).toMatch(/limit=20/);
    expect(intents).toMatch(/limit=50/);
    expect(intents).toMatch(/resourceIntentFailures\(listPath, 20\)/);
    expect(intents).toMatch(/resourceIntentFailures\(listPath, 50\)/);
    expect(intents).toMatch(/currentOutstandingIntents/);
    expect(intents).not.toMatch(/latestIntentsByResource/);
    expect(keys).toMatch(/resourceIntentFailures: \(listPath: string, limit: number\)/);
  });
});
