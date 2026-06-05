import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  JWT_SECRET: z.string().min(1).default('change-me-in-production'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(7),
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DB_PATH: z.string().default('./nyabase.db'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().default('nyabase'),
  DB_USER: z.string().default('nyabase'),
  DB_PASSWORD: z.string().default(''),
  DB_SYNC: z.string().optional(),
  NODE_ENV: z.string().optional(),
  VICTORIA_METRICS_URL: z.string().default('http://victoriametrics:8428'),
});

export type AppEnv = z.infer<typeof envSchema>;

export default registerAs('app', () => {
  const env = envSchema.parse(process.env);
  return {
    port: env.PORT,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    refreshTokenExpiresIn: env.REFRESH_TOKEN_EXPIRES_DAYS,
    dbDriver: env.DB_DRIVER,
    dbPath: env.DB_PATH,
    dbHost: env.DB_HOST,
    dbPort: env.DB_PORT,
    dbName: env.DB_NAME,
    dbUser: env.DB_USER,
    dbPassword: env.DB_PASSWORD,
    victoriaMetricsUrl: env.VICTORIA_METRICS_URL,
  };
});
