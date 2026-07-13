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

    if (!text || !messageId) {
      return { action: 'ignored', reason: 'empty-text-or-message-id' };
    }

    const result = findProfanity(text, {
      customWords: customBadWords,
      allowWords,
    });
    if (!result.matched) {
      return { action: 'allowed', messageId, chatId };
    }

    if (dryRun) {
      return {
        action: 'would-delete',
        messageId,
        chatId,
        reason: result.reason,
      };
    }

    await api.deleteMessage(messageId);

    if (notify && chatId && warningText) {
      await api.sendMessageToChat(chatId, warningText, { notify: false });
    }

    return {
      action: 'deleted',
      messageId,
      chatId,
      reason: result.reason,
    };
  }

  return { handleUpdate };
}
