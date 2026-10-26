import { z } from 'zod';

const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

// 12-factor config: everything comes from the environment and is validated once at boot.
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('twenty'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(60),
  // Comma-separated audiences accepted in Apple ID tokens: the iOS bundle ID, later the web Services ID.
  APPLE_CLIENT_IDS: csv.pipe(z.array(z.string()).min(1)),

  // Offline taps: accepted if the device time is within this window of server time (spec Q4).
  TAP_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  TAP_MAX_FUTURE_SKEW_SECONDS: z.coerce.number().nonnegative().default(120),

  AI_PROVIDER: z.enum(['qwen', 'fake']).default('qwen'),
  AI_DAILY_BREAKDOWN_LIMIT: z.coerce.number().int().nonnegative().default(5),
  QWEN_API_KEY: z.string().optional(),
  // Model Studio international (Singapore/HK) OpenAI-compatible endpoint.
  QWEN_BASE_URL: z.string().url().default('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  QWEN_MODEL: z.string().default('qwen-plus'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // Nightly pg_dump to Alibaba Cloud OSS. The backup job is only scheduled when these are set.
  OSS_REGION: z.string().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_ACCESS_KEY_ID: z.string().optional(),
  OSS_ACCESS_KEY_SECRET: z.string().optional(),
  OSS_BACKUP_PREFIX: z.string().default('backups/'),
  BACKUP_CRON: z.string().default('30 19 * * *'), // 03:30 Asia/Hong_Kong
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.AI_PROVIDER === 'qwen' && !config.QWEN_API_KEY) {
    throw new Error('Invalid configuration: QWEN_API_KEY is required when AI_PROVIDER=qwen');
  }
  return config;
}
