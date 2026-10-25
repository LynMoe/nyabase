import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source.test-helper.js';
import { DEFAULT_BRAND_TITLE } from '../hooks/use-document-title.js';

const root = join(__dirname, '..');

function read(rel: string): string {
  return readSource(root, rel);
}

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) return files(rel, pattern);
    return pattern.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });
}

/**
 * The props of one `<PageHeader ...>` element: from the tag to the `>` or
 * `/>` that closes it at brace depth 0 (JSX inside `{...}` props is skipped).
 */
function pageHeaderProps(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start + '<PageHeader'.length; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (depth === 0 && char === '>') return source.slice(start, index + 1);
  }
  throw new Error('unterminated <PageHeader');
}

/** The value of `title=` in a PageHeader's props (a string literal or a `{...}` expression). */
function titleValue(props: string): string {
  const at = props.search(/\stitle=/);
  if (at === -1) return '';
  const valueStart = props.indexOf('=', at) + 1;
  if (props[valueStart] === '"') return props.slice(valueStart, props.indexOf('"', valueStart + 1) + 1);
  let depth = 0;
  for (let index = valueStart; index < props.length; index += 1) {
    if (props[index] === '{') depth += 1;
    else if (props[index] === '}') {
      depth -= 1;
      if (depth === 0) return props.slice(valueStart, index + 1);
    }
  }
  return props.slice(valueStart);
}

/** A tab title PageHeader can derive: documentTitle, crumbs, or a title that is never JSX. */
function derivable(props: string): boolean {
  if (/\sdocumentTitle=/.test(props) || /\scrumbs=/.test(props)) return true;
  const title = titleValue(props);
  return title !== '' && !/<[A-Za-z]/.test(title);
}

describe('document titles', () => {
  it('PageHeader sets the tab title from its crumbs / title / documentTitle', () => {
    const header = read('components/layout/page-header.tsx');
    expect(header).toMatch(/useDocumentTitle\(pageHeaderTitleParts\(\{ documentTitle, crumbs, title \}\)\)/);
  });

  it('every page renders a PageHeader whose tab title is derivable', () => {
    const pages = files('pages', /\.tsx$/).filter((rel) => /^pages\/[^/]+\.tsx$/.test(rel));
    expect(pages.length).toBeGreaterThan(20);
    for (const rel of pages) {
      const source = read(rel);
      const starts = [...source.matchAll(/<PageHeader\b/g)].map((match) => match.index ?? 0);
      expect(starts.length, `${rel} renders no PageHeader (call useDocumentTitle instead)`).toBeGreaterThan(0);
      for (const start of starts) {
        const props = pageHeaderProps(source, start);
        expect(derivable(props), `${rel}: a JSX title without crumbs needs documentTitle\n${props}`).toBe(true);
      }
    }
  });

  it('every route renders a page, redirects, or titles its own screen', () => {
    const routes = files('routes', /\.tsx$/);
    for (const rel of routes) {
      const source = readFileSync(join(root, rel), 'utf8');
      const ok = /pages\/[\w-]+\.js'/.test(source)
        || (/redirect\(/.test(source) && !/component:/.test(source))
        || /useDocumentTitle\(|<DocumentTitle /.test(source);
      expect(ok, `${relative(root, join(root, rel))} sets no tab title`).toBe(true);
    }
  });

  it('full-screen states set their own titles', () => {
    expect(read('routes/login.tsx')).toMatch(/useDocumentTitle\('登录'\)/);
    expect(read('routes/__root.tsx')).toMatch(/<DocumentTitle title="正在验证会话" \/>/);
    expect(read('routes/__root.tsx')).toMatch(/notFoundComponent: NotFound/);
    expect(read('components/layout/session-check-screen.tsx')).toMatch(/useDocumentTitle\(title\)/);
    expect(read('components/require-access.tsx')).toMatch(/useDocumentTitle\('无权访问'\)/);
    expect(read('components/not-found.tsx')).toMatch(/useDocumentTitle\('页面不存在'\)/);
    expect(read('components/error-boundary.tsx')).toMatch(/<DocumentTitle title="页面出错了" \/>/);
  });

  it('ends titles with the configured brand, falling back to the default one', () => {
    expect(read('hooks/use-public-settings.ts')).toMatch(/setDocumentBrand\(settings\.branding\.title\)/);
    expect(read('hooks/use-public-settings.ts')).toMatch(/title: DEFAULT_BRAND_TITLE/);
    const html = readFileSync(join(root, '..', 'index.html'), 'utf8');
    expect(html).toContain(`<title>${DEFAULT_BRAND_TITLE}</title>`);
  });
});
