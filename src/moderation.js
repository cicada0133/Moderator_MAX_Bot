import { findProfanity, getBuiltInBadWordsCount } from './profanity.js';

export function createModerator({
  api,
  dryRun = false,
  notify = false,
  warningText,
  customBadWords = [],
  allowWords = [],
  dictionaryStore = null,
  adminStore = null,
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
    const sender = message?.sender;
    const userId = message?.sender?.user_id;
    const userName = getUserDisplayName(sender);
    const username = sender?.username ? `@${sender.username}` : '';

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
      adminStore,
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
        userName,
        username,
        token: result.token,
        reason: result.reason,
        action: 'would-delete',
      });

      return {
        action: 'would-delete',
        messageId,
        chatId,
        userId,
        userName,
        username,
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
      userName,
      username,
      token: result.token,
      reason: result.reason,
      action: 'deleted',
    });

    return {
      action: 'deleted',
      messageId,
      chatId,
      userId,
      userName,
      username,
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
  userName,
  username,
  token,
  reason,
  action,
}) {
  if (!notify || !warningText) {
    return false;
  }

  const text = renderTemplate(warningText, {
    token,
    reason,
    action,
    user: userName,
    username,
    userId,
  });
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
    .replaceAll('{action}', values.action || '')
    .replaceAll('{user}', values.user || 'Участник')
    .replaceAll('{username}', values.username || '')
    .replaceAll('{userId}', values.userId ? String(values.userId) : '');
}

function getUserDisplayName(sender) {
  if (sender?.name) return sender.name;
  if (sender?.username) return `@${sender.username}`;
  return 'Участник';
}

async function maybeHandleCommand({
  api,
  text,
  chatId,
  userId,
  dictionaryStore,
  adminStore,
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
        '/admins - показать администраторов бота',
        '/addadmin user_id - добавить администратора бота',
        '/removeadmin user_id - удалить runtime-администратора',
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
    '/admins',
    '/addadmin',
    '/removeadmin',
    '/deladmin',
  ]);
  if (!adminCommands.has(command)) {
    return { handled: false };
  }

  if (!isAdmin(userId, adminUserIds, adminStore)) {
    await sendReply({
      api,
      chatId,
      userId,
      text:
        'Команда доступна только администратору бота. Напишите /id и добавьте этот user_id в BOT_ADMIN_IDS.',
    });
    return { handled: true, command, noticeSent: true };
  }

  if (command === '/admins') {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatAdminsMessage(adminUserIds, adminStore),
    });
    return { handled: true, command, noticeSent: true };
  }

  if (['/addadmin', '/removeadmin', '/deladmin'].includes(command)) {
    if (!adminStore) {
      await sendReply({
        api,
        chatId,
        userId,
        text: 'Runtime-список администраторов не подключён.',
      });
      return { handled: true, command, noticeSent: true };
    }

    if (!argument) {
      await sendReply({
        api,
        chatId,
        userId,
        text: 'После команды нужно указать MAX user_id.',
      });
      return { handled: true, command, noticeSent: true };
    }

    const result = applyAdminCommand(adminStore, adminUserIds, command, argument);
    await sendReply({
      api,
      chatId,
      userId,
      text: formatAdminCommandResult(result),
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

function isAdmin(userId, adminUserIds, adminStore) {
  if (!userId) return false;
  const allAdminUserIds = getAllAdminUserIds(adminUserIds, adminStore);
  return allAdminUserIds.includes(Number(userId));
}

function getAllAdminUserIds(adminUserIds, adminStore) {
  const runtimeAdminUserIds = adminStore?.list().adminUserIds || [];
  return [...new Set([...adminUserIds, ...runtimeAdminUserIds])].sort(
    (left, right) => left - right,
  );
}

function applyAdminCommand(adminStore, baseAdminUserIds, command, argument) {
  if (command === '/addadmin') {
    return {
      type: 'addadmin',
      ...adminStore.addAdmin(argument),
    };
  }

  const parsedUserId = Number.parseInt(argument, 10);
  if (baseAdminUserIds.includes(parsedUserId)) {
    return {
      changed: false,
      reason: 'base-admin',
      type: 'removeadmin',
      userId: parsedUserId,
    };
  }

  return {
    type: 'removeadmin',
    ...adminStore.removeAdmin(argument),
  };
}

function formatAdminCommandResult(result) {
  if (result.reason === 'invalid-user-id') {
    return 'Не удалось разобрать user_id. Нужен числовой MAX user_id.';
  }

  if (!result.changed && result.reason === 'already-exists') {
    return `Администратор уже добавлен: ${result.userId}`;
  }

  if (!result.changed && result.reason === 'not-found') {
    return `Администратор не найден в runtime-списке: ${result.userId}`;
  }

  if (!result.changed && result.reason === 'base-admin') {
    return `Администратор ${result.userId} задан в BOT_ADMIN_IDS. Его нельзя удалить командой, только через .env.`;
  }

  if (result.type === 'addadmin') {
    return `Администратор добавлен: ${result.userId}`;
  }

  return `Администратор удалён из runtime-списка: ${result.userId}`;
}

function formatAdminsMessage(baseAdminUserIds, adminStore) {
  const runtimeAdminUserIds = adminStore?.list().adminUserIds || [];
  const allAdminUserIds = getAllAdminUserIds(baseAdminUserIds, adminStore);

  return [
    `Администраторы бота: ${formatIds(allAdminUserIds)}`,
    `Из .env: ${formatIds(baseAdminUserIds)}`,
    `Добавлены командами: ${formatIds(runtimeAdminUserIds)}`,
  ].join('\n');
}

function formatIds(ids) {
  if (!ids?.length) return 'пусто';
  return ids.join(', ');
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
