import { loadConfig } from './config.js';
import { createMaxApi } from './max-api.js';

const config = loadConfig();
const api = createMaxApi({
  token: config.token,
  baseUrl: config.apiBaseUrl,
});

const me = await api.getMe();

console.log('MAX token is valid.');
console.log(
  JSON.stringify(
    {
      user_id: me?.user_id,
      username: me?.username,
      first_name: me?.first_name,
      name: me?.name,
      is_bot: me?.is_bot,
    },
    null,
    2,
  ),
);
