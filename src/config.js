import 'dotenv/config';

const DEFAULT_API_BASE_URL = 'https://platform-api2.max.ru';

export function loadConfig(env = process.env) {
  const token = readRequired(env, 'BOT_TOKEN');

  return {
    token,
    apiBaseUrl: env.MAX_API_BASE_URL || DEFAULT_API_BASE_URL,
    dryRun: parseBoolean(env.DRY_RUN, false),
    moderationNotify: parseBoolean(env.MODERATION_NOTIFY, false),
    moderationWarning:
      env.MODERATION_WARNING || 'Сообщение удалено: в чате запрещён мат.',
    customBadWords: parseList(env.CUSTOM_BAD_WORDS),
    allowWords: parseList(env.ALLOW_WORDS),
    adminUserIds: parseNumberList(env.BOT_ADMIN_IDS),
    customDictionaryPath:
      env.CUSTOM_DICTIONARY_PATH || 'data/custom-dictionary.json',
    customAdminsPath: env.CUSTOM_ADMINS_PATH || 'data/admins.json',
    customSanctionsPath: env.CUSTOM_SANCTIONS_PATH || 'data/sanctions.sqlite',
    adminLog: {
      enabled: parseBoolean(env.ADMIN_LOG_ENABLED, false),
      notify: parseBoolean(env.ADMIN_LOG_NOTIFY, false),
      textLimit: parsePositiveInteger(env.ADMIN_LOG_TEXT_LIMIT, 1200),
    },
    autoBanDefaults: {
      enabled: parseBoolean(env.AUTO_BAN_ENABLED, false),
      threshold: parsePositiveInteger(env.AUTO_BAN_THRESHOLD, 3),
      windowMinutes: parsePositiveInteger(env.AUTO_BAN_WINDOW_MINUTES, 10),
      durationMinutes: parsePositiveInteger(env.AUTO_BAN_DURATION_MINUTES, 30),
    },
    pollingTimeoutSec: parseInteger(env.POLLING_TIMEOUT_SEC, 60),
    pollingLimit: parseInteger(env.POLLING_LIMIT, 100),
    processInitialUpdates: parseBoolean(env.PROCESS_INITIAL_UPDATES, false),
    webhookPort: parseInteger(env.WEBHOOK_PORT, 3000),
    webhookPath: env.WEBHOOK_PATH || '/max/webhook',
    webhookPublicUrl: env.WEBHOOK_PUBLIC_URL || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
  };
}

function readRequired(env, key) {
  const value = env[key];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function parseInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function parsePositiveInteger(value, fallback) {
  const parsed = parseInteger(value, fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberList(value) {
  return parseList(value)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => !Number.isNaN(item));
}
