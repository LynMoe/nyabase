import { useLayoutEffect, type ReactNode } from 'react';
import { create } from 'zustand';

/**
 * Tab titles, one rule for the whole app:
 * - list / section pages: `{页面名} · {品牌}`, e.g. `容器 · nyabase`;
 * - detail pages: `{资源名} · {栏目} · {品牌}` (the breadcrumb read backwards),
 *   e.g. `dev-box · 容器 · nyabase`; while the resource loads, `容器 · nyabase`;
 * - full-screen states: `登录 · nyabase`, `无法验证会话 · nyabase`, ...
 *
 * The brand is the configured `branding.title` the sidebar and login show
 * (default `nyabase`, also index.html's fallback). `PageHeader` sets the title
 * from its crumbs / title; screens without one call `useDocumentTitle`.
 * Nothing is restored on unmount: the next screen sets its own title, in a
 * layout effect so the old one is never painted with the new page.
 */
export const DEFAULT_BRAND_TITLE = 'nyabase';
const SEPARATOR = ' · ';
/** Breadcrumb label of a resource that has not loaded yet. */
const PLACEHOLDER = '…';

export type DocumentTitleParts = string | readonly (string | null | undefined)[];

/** Synced from the public settings (`usePublicSettings`); needs no QueryClient. */
const useDocumentBrand = create<{ title: string }>(() => ({ title: DEFAULT_BRAND_TITLE }));

export function setDocumentBrand(title: string | null | undefined): void {
  const next = title?.trim() || DEFAULT_BRAND_TITLE;
  if (useDocumentBrand.getState().title !== next) useDocumentBrand.setState({ title: next });
}

export function formatDocumentTitle(parts: DocumentTitleParts, brand: string): string {
  const list = typeof parts === 'string' ? [parts] : parts;
  const named = list
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part) && part !== PLACEHOLDER);
  return [...named, brand.trim() || DEFAULT_BRAND_TITLE].join(SEPARATOR);
}

/**
 * What a `PageHeader` puts in the tab: an explicit `documentTitle`, else the
 * crumbs read backwards (resource first), else a plain-string `title`. A
 * ReactNode title without crumbs is not derivable (null): such a page passes
 * `documentTitle`.
 */
export function pageHeaderTitleParts({
  documentTitle,
  crumbs,
  title,
}: {
  documentTitle?: DocumentTitleParts;
  crumbs?: readonly { label: string }[];
  title?: ReactNode;
}): DocumentTitleParts | null {
  if (documentTitle !== undefined) return documentTitle;
  if (crumbs && crumbs.length > 0) return crumbs.map((crumb) => crumb.label).reverse();
  if (typeof title === 'string') return title;
  return null;
}

/** Sets `document.title` to `parts · brand`; `null` leaves the title alone. */
export function useDocumentTitle(parts: DocumentTitleParts | null): void {
  const brand = useDocumentBrand((state) => state.title);
  const title = parts === null ? null : formatDocumentTitle(parts, brand);
  useLayoutEffect(() => {
    if (title !== null) document.title = title;
  }, [title]);
}

/** `useDocumentTitle` for class components and render-only branches. */
export function DocumentTitle({ title }: { title: DocumentTitleParts }): null {
  useDocumentTitle(title);
  return null;
}
