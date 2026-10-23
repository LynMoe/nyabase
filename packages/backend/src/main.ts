import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, type LogLevel } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AGENT_CONTROL_PATH, AGENT_STREAM_PATH } from '@nyabase/common';
import { AppModule } from './app.module.js';
import { NyabaseConfigService } from './platform/config/nyabase-config.service.js';
import {
  PgTransactionConflictFilter,
  RouteIdPipe,
  serveBundledFrontend,
  ZodExceptionFilter,
} from './platform/http-filters.js';
import { securityHeaders, trustProxySetting, warnOnUntrustedForwarding } from './platform/http-security.js';
import { RuntimeLifecycleService } from './health/runtime-lifecycle.service.js';
import { ConsoleBridgeGateway } from './containers/console-bridge.gateway.js';
import { SshProxyGateway } from './ssh/ssh-proxy-gateway.js';
import { HttpProxyGateway } from './http-proxy/http-proxy-gateway.js';
import type { TrustProxy } from './incus/agent-credentials.js';
import { AgentGateway } from './incus/agent-gateway.js';

const LOG_LEVELS_BY_VERBOSITY: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

function logLevelsUpTo(level: LogLevel): LogLevel[] {
  return LOG_LEVELS_BY_VERBOSITY.slice(0, LOG_LEVELS_BY_VERBOSITY.indexOf(level) + 1);
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Buffer bootstrap logs until the configured level is known.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  // Let Nest stop HTTP admission and invoke module destroy hooks on SIGTERM
  // and SIGINT, allowing runtime workers and metric flushing to drain.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const config = app.get(NyabaseConfigService);
  app.useLogger(logLevelsUpTo(config.get<LogLevel>('server.logLevel')));

  app.setGlobalPrefix('api');
  const trustedProxies = trustProxySetting(config.get<string>('server.trustedProxies'));
  app.set('trust proxy', trustedProxies);
  app.use(warnOnUntrustedForwarding(trustedProxies, (message) => logger.warn(message)));
  app.use(securityHeaders());
  app.useGlobalFilters(new ZodExceptionFilter(), new PgTransactionConflictFilter(app.getHttpAdapter()));
  // forbidNonWhitelisted: throw 400 on extra properties so clients learn
  // about typos / dropped fields instead of silently having them ignored.
  // Note: most request DTOs are validated via zod (see Body() handlers); the
  // ValidationPipe is the safety net for class-validator-decorated DTOs.
  app.useGlobalPipes(
    new RouteIdPipe(),
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const corsOrigin = config.get<string>('server.corsOrigin');
  if (!corsOrigin && config.get<string>('runtime.nodeEnv') === 'production') {
    logger.warn('CORS_ORIGIN is not set in production. All cross-origin requests will be rejected.');
  }

  app.enableCors(
    corsOrigin
      ? { origin: corsOrigin, credentials: true }
      : { origin: false }, // disable CORS when no origin is configured
  );

  // Serve bundled frontend static files when present (production Docker deployment)
  const publicDir = join(process.cwd(), 'public');
  const indexPath = join(publicDir, 'index.html');
  const hasStaticFrontend = existsSync(indexPath);
  if (hasStaticFrontend) {
    // Hashed /assets/* are cached for a year, index.html is revalidated, and
    // NestJS 404s on client-side routes (e.g. /dashboard) receive index.html.
    // API paths still get the standard JSON response.
    serveBundledFrontend(app, publicDir);
    logger.log(`Serving frontend static files from ${publicDir} with SPA fallback`);
  }

  const port = config.get<number>('server.port');
  const listenAddress = config.get<string>('server.listenAddress').trim();
  const server = listenAddress
    ? await app.listen(port, listenAddress)
    : await app.listen(port);

  const httpServer = server as import('http').Server;
  app.get(ConsoleBridgeGateway).attachToHttpServer(httpServer);
  app.get(SshProxyGateway).attachToHttpServer(httpServer);
  app.get(HttpProxyGateway).attachToHttpServer(httpServer);
  app.get(AgentGateway).attachToHttpServer(httpServer, {
    trustProxy: app.getHttpAdapter().getInstance().get('trust proxy fn') as TrustProxy,
  });
  const websocketPaths = new Set([
    '/ws/console',
    '/ws/ssh-proxy',
    '/ws/http-proxy',
    AGENT_CONTROL_PATH,
    AGENT_STREAM_PATH,
  ]);
  httpServer.on('upgrade', (request, socket) => {
    const path = request.url?.split('?')[0] ?? '';
    if (!websocketPaths.has(path)) socket.destroy();
  });

  app.get(RuntimeLifecycleService).markReady();
  logger.log(`Backend listening on ${listenAddress || '*'}:${port}`);
}

bootstrap().catch((error: unknown) => {
  // Open pools and sockets would otherwise keep a half-started process alive.
  console.error(error);
  process.exit(1);
});
