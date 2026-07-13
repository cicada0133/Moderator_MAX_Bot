import { findProfanity } from './profanity.js';

export function createModerator({
  api,
  dryRun = false,
  notify = false,
  warningText,
  customBadWords = [],
  allowWords = [],
}) {
  async function handleUpdate(update) {
    if (update?.update_type !== 'message_created') {
      return { action: 'ignored', reason: 'unsupported-update' };
    }

    const message = update.message;
    const text = message?.body?.text;
    const messageId = message?.body?.mid;
    const chatId = message?.recipient?.chat_id;
    const userId = message?.sender?.user_id;

    if (message?.sender?.is_bot) {
      return { action: 'ignored', reason: 'bot-message' };
    }

    if (!text || !messageId) {
      return { action: 'ignored', reason: 'empty-text-or-message-id' };
    }

    const result = findProfanity(text, {
      customWords: customBadWords,
      allowWords,
    });
    if (!result.matched) {
      return { action: 'allowed', messageId, chatId, userId };
    }

    if (dryRun) {
      const noticeSent = await sendModerationNotice({
        api,
        notify,
        warningText,
        chatId,
        userId,
        token: result.token,
        reason: result.reason,
        action: 'would-delete',
      });

      return {
        action: 'would-delete',
        messageId,
        chatId,
        userId,
        reason: result.reason,
        token: result.token,
        noticeSent,
      };
    }

    await api.deleteMessage(messageId);

    const noticeSent = await sendModerationNotice({
      api,
      notify,
      warningText,
      chatId,
      userId,
      token: result.token,
      reason: result.reason,
      action: 'deleted',
    });

    return {
      action: 'deleted',
      messageId,
      chatId,
      userId,
      reason: result.reason,
      token: result.token,
      noticeSent,
    };
  }

  return { handleUpdate };
}

async function sendModerationNotice({
  api,
  notify,
  warningText,
  chatId,
  userId,
  token,
  reason,
  action,
}) {
  if (!notify || !warningText) {
    return false;
  }

  const text = renderTemplate(warningText, { token, reason, action });
  if (chatId) {
    await api.sendMessageToChat(chatId, text, { notify: false });
    return true;
  }

  if (userId) {
    await api.sendMessageToUser(userId, text, { notify: false });
    return true;
  }

  return false;
}

function renderTemplate(template, values) {
  return template
    .replaceAll('{token}', values.token || '')
    .replaceAll('{reason}', values.reason || '')
    .replaceAll('{action}', values.action || '');
}
