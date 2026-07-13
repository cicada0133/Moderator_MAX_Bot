import express from 'express';

import { loadConfig } from './config.js';
import { createMaxApi } from './max-api.js';
import { createModerator } from './moderation.js';

const config = loadConfig();
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
});

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_request, response) => {
  response.json({ ok: true });
});

app.post(config.webhookPath, (request, response) => {
  if (config.webhookSecret) {
    const receivedSecret = request.header('X-Max-Bot-Api-Secret');
    if (receivedSecret !== config.webhookSecret) {
      response.status(401).json({ ok: false });
      return;
    }
  }

  const updates = normalizeWebhookPayload(request.body);
  response.status(200).json({ ok: true });

  void processWebhookUpdates(updates);
});

app.listen(config.webhookPort, async () => {
  const me = await api.getMe();
  const botName = me?.username || me?.name || me?.first_name || me?.user_id;
  console.log(`Connected to MAX as ${botName}`);
  console.log(
    `Webhook server listens on port ${config.webhookPort}, path ${config.webhookPath}, dryRun=${config.dryRun}`,
  );
});

async function processWebhookUpdates(updates) {
  for (const update of updates) {
    try {
      const result = await moderator.handleUpdate(update);
      if (['deleted', 'would-delete'].includes(result.action)) {
        console.log(
          `${result.action}: message=${result.messageId}; chat=${result.chatId ?? 'unknown'}; reason=${result.reason}`,
        );
      }
    } catch (error) {
      console.error('Failed to moderate webhook update');
      console.error(error?.data || error);
    }
  }
}

function normalizeWebhookPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.updates)) return payload.updates;
  return payload ? [payload] : [];
}
