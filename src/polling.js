import { loadConfig } from './config.js';
import { createAdminStore } from './admin-store.js';
import { createCustomDictionaryStore } from './custom-dictionary.js';
import { createMaxApi } from './max-api.js';
import { createModerator } from './moderation.js';

const config = loadConfig();
const adminStore = createAdminStore(config.customAdminsPath);
const dictionaryStore = createCustomDictionaryStore(config.customDictionaryPath);
const api = createMaxApi({
  token: config.token,
  baseUrl: config.apiBaseUrl,
});
const moderator = createModerator({
  api,
  dryRun: config.dryRun,
  notify: config.moderationNotify,
  warningText: config.moderationWarning,
  customBadWords: config.customBadWords,
  allowWords: config.allowWords,
  dictionaryStore,
  adminStore,
  adminUserIds: config.adminUserIds,
});

const UPDATE_TYPES = ['message_created', 'message_callback'];

let running = true;
process.on('SIGINT', () => {
  running = false;
  console.log('\nStopping polling after current request...');
});

await printBotInfo();
await startPolling();

async function printBotInfo() {
  const me = await api.getMe();
  const botName = me?.username || me?.name || me?.first_name || me?.user_id;
  console.log(`Connected to MAX as ${botName}`);
}

async function startPolling() {
  let marker = await primeMarker();
  console.log(
    `Moderation polling started. dryRun=${config.dryRun}; marker=${marker ?? 'none'}`,
  );

  while (running) {
    try {
      const response = await api.getUpdates({
        limit: config.pollingLimit,
        timeout: config.pollingTimeoutSec,
        marker,
        types: UPDATE_TYPES,
      });

      marker = response?.marker ?? marker;
      await processUpdates(response?.updates || []);
    } catch (error) {
      logError('Polling request failed', error);
      await delay(5000);
    }
  }
}

async function primeMarker() {
  const response = await api.getUpdates({
    limit: 1,
    timeout: 0,
    types: UPDATE_TYPES,
  });

  if (config.processInitialUpdates) {
    await processUpdates(response?.updates || []);
  }

  return response?.marker;
}

async function processUpdates(updates) {
  for (const update of updates) {
    try {
      const result = await moderator.handleUpdate(update);
      if (['deleted', 'would-delete'].includes(result.action)) {
        console.log(
          `${result.action}: message=${result.messageId}; chat=${result.chatId ?? 'unknown'}; user=${result.userId ?? 'unknown'}; name=${result.userName ?? 'unknown'}; token=${result.token ?? 'unknown'}; reason=${result.reason}; notice=${result.noticeSent}`,
        );
      } else if (result.action === 'command') {
        console.log(
          `command: ${result.command}; message=${result.messageId}; chat=${result.chatId ?? 'unknown'}; user=${result.userId ?? 'unknown'}; notice=${result.noticeSent}`,
        );
      }
    } catch (error) {
      logError('Failed to moderate update', error);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logError(message, error) {
  console.error(message);
  console.error(error?.data || error);
}
