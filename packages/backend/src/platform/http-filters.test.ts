import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, Get, Module, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMMUTABLE_ASSET_CACHE_CONTROL,
  isStaticFilePath,
  REVALIDATE_CACHE_CONTROL,
  RouteIdPipe,
  serveBundledFrontend,
} from './http-filters.js';
import { securityHeaders } from './http-security.js';

describe('RouteIdPipe', () => {
  const pipe = new RouteIdPipe();
  const id = '6172518f-5edb-402b-ac2a-c0a899f53b0e';

  it('passes UUID path params and anything that is not a path param', () => {
    expect(pipe.transform(id, { type: 'param', data: 'id' })).toBe(id);
    expect(pipe.transform('undefined', { type: 'query', data: 'scope' })).toBe('undefined');
    expect(pipe.transform({ name: 'x' }, { type: 'body' })).toEqual({ name: 'x' });
  });

  it('turns a malformed path id into a 404', () => {
    expect(() => pipe.transform('undefined', { type: 'param', data: 'containerId' }))
      .toThrow(NotFoundException);
  });
});

describe('isStaticFilePath', () => {
  it('treats /assets/* and paths ending in a file extension as files', () => {
    expect(isStaticFilePath('/assets/index-3f9a1c.js')).toBe(true);
    expect(isStaticFilePath('/assets/fonts/x')).toBe(true);
    expect(isStaticFilePath('/favicon.ico')).toBe(true);
    expect(isStaticFilePath('/vite.svg')).toBe(true);
  });

  it('leaves client-side routes to the SPA', () => {
    expect(isStaticFilePath('/')).toBe(false);
    expect(isStaticFilePath('/containers/6172518f-5edb-402b-ac2a-c0a899f53b0e/usage')).toBe(false);
    expect(isStaticFilePath('/assets')).toBe(false);
  });
});

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class FrontendProbeModule {}

describe('serveBundledFrontend', () => {
  let publicDir: string;
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    publicDir = await mkdtemp(join(tmpdir(), 'nyabase-frontend-'));
    await mkdir(join(publicDir, 'assets'));
    await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>nyabase</title>');
    await writeFile(join(publicDir, 'assets', 'index-3f9a1c.js'), 'export {};');
    app = await NestFactory.create<NestExpressApplication>(FrontendProbeModule, { logger: false });
    app.setGlobalPrefix('api');
    app.use(securityHeaders());
    serveBundledFrontend(app, publicDir);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await rm(publicDir, { recursive: true, force: true });
  });

  it('caches hashed assets for a year', async () => {
    const response = await fetch(`${baseUrl}/assets/index-3f9a1c.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('answers a missing asset with a real 404, not index.html', async () => {
    for (const path of ['/assets/gone-0b1d2e.js', '/assets/gone-0b1d2e.css', '/vite.svg']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).not.toMatch(/html/);
      expect(await response.text(), path).not.toContain('<title>nyabase</title>');
      expect(response.headers.get('content-security-policy'), path).toContain("default-src 'self'");
    }
  });

  it('serves index.html for client-side routes and the root, revalidated every time', async () => {
    for (const path of ['/', '/containers/6172518f-5edb-402b-ac2a-c0a899f53b0e/usage']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(/text\/html/);
      expect(response.headers.get('cache-control'), path).toBe(REVALIDATE_CACHE_CONTROL);
      expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
      expect(await response.text(), path).toContain('<title>nyabase</title>');
    }
  });

  it('keeps JSON 404s for the API and does not answer other methods with the SPA', async () => {
    const api = await fetch(`${baseUrl}/api/missing`);
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
    expect((await fetch(`${baseUrl}/api/ping`)).status).toBe(200);

    const post = await fetch(`${baseUrl}/containers`, { method: 'POST' });
    expect(post.status).toBe(404);
    expect(await post.text()).not.toContain('<title>nyabase</title>');
  });
});
