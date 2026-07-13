import { loadConfig } from './config.js';
import { createMaxApi } from './max-api.js';

const config = loadConfig();

if (!config.webhookPublicUrl || !config.webhookPublicUrl.startsWith('https://')) {
  throw new Error('WEBHOOK_PUBLIC_URL must be an HTTPS URL');
}

const api = createMaxApi({
  token: config.token,
  baseUrl: config.apiBaseUrl,
});

const result = await api.createSubscription({
  url: config.webhookPublicUrl,
  updateTypes: ['message_created'],
  secret: config.webhookSecret,
});

console.log('Webhook subscription result:');
console.log(JSON.stringify(result, null, 2));
