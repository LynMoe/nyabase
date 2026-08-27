import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module.js';
import { NyabaseConfigService } from './config/nyabase-config.service.js';
import { SpaFallbackFilter } from './filters/spa-fallback.filter.js';
import { ZodExceptionFilter } from './filters/zod-exception.filter.js';
import { RuntimeRoleService } from './runtime/runtime-role.service.js';
import { RuntimeLifecycleService } from './health/runtime-lifecycle.service.js';
import { ConsoleBridgeGateway } from './runtime/console-bridge.gateway.js';
import { SshProxyGateway } from './ssh/ssh-proxy-gateway.js';
import { HttpProxyGateway } from './http-proxy/http-proxy-gateway.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });
  // Let Nest stop HTTP admission and invoke module destroy hooks on SIGTERM
  // and SIGINT, allowing runtime workers and metric flushing to drain.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const config = app.get(NyabaseConfigService);
  const runtimeRole = app.get(RuntimeRoleService);

  app.setGlobalPrefix('api');
  app.use((
    request: { path: string },
    response: {
      status: (code: number) => { json: (body: unknown) => unknown };
    },
    next: () => void,
  ) => {
    if (runtimeRole.allowsHttpPath(request.path)) {
      next();
      return;
    }
    response.status(404).json({
      statusCode: 404,
      message: 'Not Found',
    });
  });
  app.useGlobalFilters(new ZodExceptionFilter());
  // forbidNonWhitelisted: throw 400 on extra properties so clients learn
  // about typos / dropped fields instead of silently having them ignored.
  // Note: most request DTOs are validated via zod (see Body() handlers); the
  // ValidationPipe is the safety net for class-validator-decorated DTOs.
  app.useGlobalPipes(
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
  if (hasStaticFrontend && runtimeRole.servesApi()) {
    app.useStaticAssets(publicDir);
    // Intercept NestJS 404s so that SPA client-side routes (e.g. /dashboard) receive
    // index.html instead of a JSON 404. API paths still get the standard JSON response.
    app.useGlobalFilters(new SpaFallbackFilter(indexPath));
    logger.log(`Serving frontend static files from ${publicDir} with SPA fallback`);
  }

  const port = config.get<number>('server.port');
  const server = await app.listen(port);

  const httpServer = server as import('http').Server;
  app.get(ConsoleBridgeGateway).attachToHttpServer(httpServer);
  app.get(SshProxyGateway).attachToHttpServer(httpServer);
  app.get(HttpProxyGateway).attachToHttpServer(httpServer);
  const websocketPaths = new Set(['/ws/console', '/ws/ssh-proxy', '/ws/http-proxy']);
  httpServer.on('upgrade', (request, socket) => {
    const path = request.url?.split('?')[0] ?? '';
    if (!websocketPaths.has(path)) socket.destroy();
  });

  app.get(RuntimeLifecycleService).markReady();
  logger.log(`Backend role=${runtimeRole.role} listening on port ${port}`);
}

bootstrap().catch(console.error);
