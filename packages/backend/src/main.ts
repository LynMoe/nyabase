import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module.js';
import { AgentGateway } from './gateway/agent-gateway.js';
import { ConsoleGateway } from './gateway/console-gateway.js';
import { SshProxyGateway } from './ssh/ssh-proxy-gateway.js';
import { HttpProxyGateway } from './http-proxy/http-proxy-gateway.js';
import { NyabaseConfigService } from './config/nyabase-config.service.js';
import { SpaFallbackFilter } from './filters/spa-fallback.filter.js';
import { ZodExceptionFilter } from './filters/zod-exception.filter.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });
  const config = app.get(NyabaseConfigService);

  app.setGlobalPrefix('api');
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
  if (hasStaticFrontend) {
    app.useStaticAssets(publicDir);
    // Intercept NestJS 404s so that SPA client-side routes (e.g. /dashboard) receive
    // index.html instead of a JSON 404. API paths still get the standard JSON response.
    app.useGlobalFilters(new SpaFallbackFilter(indexPath));
    logger.log(`Serving frontend static files from ${publicDir} with SPA fallback`);
  }

  const port = config.get<number>('server.port');
  const server = await app.listen(port);

  const httpServer = server as import('http').Server;
  app.get(AgentGateway).attachToHttpServer(httpServer);
  app.get(ConsoleGateway).attachToHttpServer(httpServer);
  app.get(SshProxyGateway).attachToHttpServer(httpServer);
  app.get(HttpProxyGateway).attachToHttpServer(httpServer);

  logger.log(`Backend listening on port ${port}`);
}

bootstrap().catch(console.error);
