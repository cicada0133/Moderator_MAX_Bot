import { findProfanity, getBuiltInBadWordsCount } from './profanity.js';

export function createModerator({
  api,
  dryRun = false,
  notify = false,
  warningText,
  customBadWords = [],
  allowWords = [],
  dictionaryStore = null,
  adminUserIds = [],
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

    const commandResult = await maybeHandleCommand({
      api,
      text,
      chatId,
      userId,
      dictionaryStore,
      adminUserIds,
    });
    if (commandResult.handled) {
      return {
        action: 'command',
        command: commandResult.command,
        messageId,
        chatId,
        userId,
        noticeSent: commandResult.noticeSent,
      };
    }

    const runtimeDictionary = dictionaryStore?.list() || {
      badWords: [],
      allowWords: [],
    };
    const result = findProfanity(text, {
      customWords: [...customBadWords, ...runtimeDictionary.badWords],
      allowWords: [...allowWords, ...runtimeDictionary.allowWords],
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

async function maybeHandleCommand({
  api,
  text,
  chatId,
  userId,
  dictionaryStore,
  adminUserIds,
}) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  const [rawCommand, ...args] = trimmed.split(/\s+/u);
  const command = rawCommand.toLowerCase().split('@')[0];
  const argument = args.join(' ').trim();

  if (['/id', '/whoami'].includes(command)) {
    await sendReply({
      api,
      chatId,
      userId,
      text: `Ваш MAX user_id: ${userId ?? 'не удалось определить'}`,
    });
    return { handled: true, command, noticeSent: true };
  }

  if (['/help', '/commands'].includes(command)) {
    await sendReply({
      api,
      chatId,
      userId,
      text: [
        'Команды модератора:',
        '/id - показать ваш user_id',
        '/badwords - показать пользовательский словарь',
        '/banword слово - добавить слово или фрагмент в банлист',
        '/unbanword слово - удалить из банлиста',
        '/allowword слово - добавить исключение',
        '/unallowword слово - удалить исключение',
      ].join('\n'),
    });
    return { handled: true, command, noticeSent: true };
  }

  const adminCommands = new Set([
    '/badwords',
    '/banword',
    '/addbad',
    '/unbanword',
    '/removebad',
    '/allowword',
    '/unallowword',
  ]);
  if (!adminCommands.has(command)) {
    return { handled: false };
  }

  if (!isAdmin(userId, adminUserIds)) {
    await sendReply({
      api,
      chatId,
      userId,
      text:
        'Команда доступна только администратору бота. Напишите /id и добавьте этот user_id в BOT_ADMIN_IDS.',
    });
    return { handled: true, command, noticeSent: true };
  }

  if (!dictionaryStore) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Пользовательский словарь не подключён.',
    });
    return { handled: true, command, noticeSent: true };
  }

  if (command === '/badwords') {
    const dictionary = dictionaryStore.list();
    await sendReply({
      api,
      chatId,
      userId,
      text: formatDictionaryMessage(dictionary),
    });
    return { handled: true, command, noticeSent: true };
  }

  if (!argument) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'После команды нужно указать слово или фрагмент.',
    });
    return { handled: true, command, noticeSent: true };
  }

  const result = applyDictionaryCommand(dictionaryStore, command, argument);
  await sendReply({
    api,
    chatId,
    userId,
    text: formatDictionaryCommandResult(result),
  });
  return { handled: true, command, noticeSent: true };
}

function isAdmin(userId, adminUserIds) {
  return Boolean(userId && adminUserIds.includes(Number(userId)));
}

function applyDictionaryCommand(dictionaryStore, command, argument) {
  if (['/banword', '/addbad'].includes(command)) {
    return {
      type: 'banword',
      ...dictionaryStore.addBadWord(argument),
    };
  }

  if (['/unbanword', '/removebad'].includes(command)) {
    return {
      type: 'unbanword',
      ...dictionaryStore.removeBadWord(argument),
    };
  }

  if (command === '/allowword') {
    return {
      type: 'allowword',
      ...dictionaryStore.addAllowWord(argument),
    };
  }

  if (command === '/unallowword') {
    return {
      type: 'unallowword',
      ...dictionaryStore.removeAllowWord(argument),
    };
  }

  return { changed: false, reason: 'unknown-command', word: argument };
}

function formatDictionaryCommandResult(result) {
  if (result.reason === 'empty-word') {
    return 'Не удалось разобрать слово.';
  }

  const actionLabels = {
    banword: 'банлист',
    unbanword: 'банлист',
    allowword: 'исключения',
    unallowword: 'исключения',
  };
  const target = actionLabels[result.type] || 'словарь';

  if (!result.changed && result.reason === 'already-exists') {
    return `Уже есть в разделе "${target}": ${result.word}`;
  }

  if (!result.changed && result.reason === 'not-found') {
    return `Не найдено в разделе "${target}": ${result.word}`;
  }

  if (result.type?.startsWith('un')) {
    return `Удалено из раздела "${target}": ${result.word}`;
  }

  return `Добавлено в раздел "${target}": ${result.word}`;
}

function formatDictionaryMessage(dictionary) {
  return [
    `Встроенный словарь: ${getBuiltInBadWordsCount()} словоформ.`,
    `Пользовательский банлист: ${formatWords(dictionary.badWords)}`,
    `Исключения: ${formatWords(dictionary.allowWords)}`,
  ].join('\n');
}

function formatWords(words) {
  if (!words?.length) return 'пусто';
  return words.join(', ');
}

async function sendReply({ api, chatId, userId, text }) {
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
