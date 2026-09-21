import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';

export type CatalogEntry = {
  alias: string;
  aliases: string[];
  fingerprint: string;
  os: string;
  release: string;
  variant: string;
  version: string;
  sizeBytes: number | null;
  description: string;
};

type SimplestreamsItem = {
  ftype?: string;
  sha256?: string;
  size?: number;
  path?: string;
  combined_sha256?: string;
  combined_squashfs_sha256?: string;
};

type SimplestreamsProduct = {
  aliases?: string;
  arch?: string;
  os?: string;
  release?: string;
  variant?: string;
  versions?: Record<string, { items?: Record<string, SimplestreamsItem> }>;
};

type SimplestreamsImages = {
  products?: Record<string, SimplestreamsProduct>;
};

export function isIncusSimplestreamsVersion(name: string): boolean {
  if (name.length < 8) return false;
  const day = name.slice(0, 8);
  if (!/^\d{8}$/.test(day)) return false;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(4, 6));
  const date = Number(day.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === date;
}

export function pickSimplestreamsVersion(versionIds: readonly string[]): string | undefined {
  if (versionIds.length === 0) return undefined;
  const visible = versionIds.filter((name) => isIncusSimplestreamsVersion(name));
  const pool = visible.length > 0 ? visible : [...versionIds];
  return pool.slice().sort((left, right) => {
    const leftDay = isIncusSimplestreamsVersion(left) ? left.slice(0, 8) : '';
    const rightDay = isIncusSimplestreamsVersion(right) ? right.slice(0, 8) : '';
    if (leftDay !== rightDay) return leftDay.localeCompare(rightDay);
    return left.localeCompare(right, undefined, { numeric: true });
  }).at(-1);
}

function catalogFingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const fingerprint = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : undefined;
}

export function parseSimplestreamsProducts(body: unknown): CatalogEntry[] {
  const products = (body as SimplestreamsImages | null)?.products;
  if (!products || typeof products !== 'object' || Array.isArray(products)) {
    throw new BadGatewayException({
      code: 'IMAGE_CATALOG_INVALID',
      message: 'The image source did not return a simplestreams product catalog',
    });
  }
  const entries: CatalogEntry[] = [];
  for (const product of Object.values(products)) {
    const aliases = String(product.aliases ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const versions = product.versions ?? {};
    const version = pickSimplestreamsVersion(Object.keys(versions));
    if (!version) continue;
    const items = versions[version]?.items ?? {};
    const meta = items['incus.tar.xz'] ?? items['lxd.tar.xz'];
    const squash = Object.values(items).find((item) => item.ftype === 'squashfs')
      ?? items['root.squashfs'];
    const fingerprint = catalogFingerprint(meta?.combined_squashfs_sha256)
      ?? catalogFingerprint(squash?.sha256);
    if (!fingerprint) continue;
    const alias = aliases[0];
    if (!alias) continue;
    const os = String(product.os ?? 'linux');
    const release = String(product.release ?? '');
    const variant = String(product.variant ?? 'default');
    entries.push({
      alias,
      aliases,
      fingerprint,
      os,
      release,
      variant,
      version,
      sizeBytes: typeof squash?.size === 'number' ? squash.size : null,
      description: [os, release, variant !== 'default' ? variant : '', `v${version}`]
        .filter(Boolean)
        .join(' '),
    });
  }
  return entries.sort((left, right) => left.alias.localeCompare(right.alias));
}

export function displayNameForCatalog(entry: CatalogEntry): string {
  const os = entry.os.trim() || 'Image';
  const titled = os.charAt(0).toUpperCase() + os.slice(1);
  return entry.release ? `${titled} ${entry.release}` : titled;
}

@Injectable()
export class ImageCatalogService {
  constructor(private readonly config: NyabaseConfigService) {}

  sourceServer(): string {
    return this.config.get<string>('incus.imageSourceServer')
      || this.config.get<string>('incus.preflightSourceServer');
  }

  async list(): Promise<CatalogEntry[]> {
    const base = this.sourceServer().replace(/\/+$/, '');
    const response = await fetch(`${base}/streams/v1/images.json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'nyabase-image-catalog/1.0' },
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new BadGatewayException({
        code: 'IMAGE_CATALOG_UNREACHABLE',
        message: error instanceof Error ? error.message : 'Failed to reach the image source',
      });
    });
    if (!response.ok) {
      throw new BadGatewayException({
        code: 'IMAGE_CATALOG_UNREACHABLE',
        message: `Image source returned HTTP ${response.status}`,
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BadGatewayException({
        code: 'IMAGE_CATALOG_INVALID',
        message: 'The image source did not return a simplestreams product catalog',
      });
    }
    return parseSimplestreamsProducts(body);
  }

  async requireAlias(alias: string): Promise<CatalogEntry> {
    const entry = (await this.list()).find((item) => item.aliases.includes(alias) || item.alias === alias);
    if (!entry) {
      throw new NotFoundException({
        code: 'IMAGE_CATALOG_ALIAS_UNKNOWN',
        message: `Alias ${alias} is not published on the image source`,
      });
    }
    return entry;
  }
}
