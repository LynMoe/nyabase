import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module.js';
import { AgentGateway } from './gateway/agent-gateway.js';
import { ConsoleGateway } from './gateway/console-gateway.js';
import { SpaFallbackFilter } from './filters/spa-fallback.filter.js';
import { ZodExceptionFilter } from './filters/zod-exception.filter.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Fail fast in production if the default JWT secret is still in use
  if (
    process.env.NODE_ENV === 'production' &&
    (process.env.JWT_SECRET === 'change-me-in-production' || !process.env.JWT_SECRET)
  ) {
    logger.error('JWT_SECRET must be set to a strong secret in production. Aborting.');
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

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

  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin && process.env.NODE_ENV === 'production') {
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

  const port = parseInt(process.env.PORT ?? '3001', 10);
  const server = await app.listen(port);

  const httpServer = server as import('http').Server;
  app.get(AgentGateway).attachToHttpServer(httpServer);
  app.get(ConsoleGateway).attachToHttpServer(httpServer);

  logger.log(`Backend listening on port ${port}`);
}

bootstrap().catch(console.error);
