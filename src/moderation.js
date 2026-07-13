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
    if (update?.update_type === 'message_callback') {
      return handleCallbackUpdate({
        api,
        update,
        adminStore,
        adminUserIds,
      });
    }

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
    const isDirectMessage = !chatId;
    const senderIsAdmin = isAdmin(userId, adminUserIds, adminStore);

    if (message?.sender?.is_bot) {
      return { action: 'ignored', reason: 'bot-message' };
    }

    if (isDirectMessage && !senderIsAdmin) {
      const commandResult = await maybeHandleCommand({
        api,
        text,
        chatId,
        userId,
        dictionaryStore,
        adminStore,
        adminUserIds,
        isDirectMessage,
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

      return {
        action: 'ignored',
        reason: 'private-non-admin',
        messageId,
        userId,
      };
    }

    const contactResult = await maybeHandleContactAdminCandidate({
      api,
      message,
      chatId,
      userId,
      adminStore,
      adminUserIds,
    });
    if (contactResult.handled) {
      return {
        action: 'command',
        command: contactResult.command,
        messageId,
        chatId,
        userId,
        noticeSent: contactResult.noticeSent,
      };
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
      isDirectMessage,
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

    if (isDirectMessage) {
      return {
        action: 'ignored',
        reason: 'private-message',
        messageId,
        userId,
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

async function handleCallbackUpdate({ api, update, adminStore, adminUserIds }) {
  const callback = update.callback;
  const callbackId = callback?.callback_id;
  const payload = callback?.payload;
  const parsedPayload = parseAdminCallbackPayload(payload);
  const userId = getCallbackUserId(update);

  if (!parsedPayload) {
    if (callbackId) {
      await answerCallback(
        api,
        callbackId,
        'Кнопка устарела или не распознана.',
      );
    }
    return { action: 'ignored', reason: 'unsupported-callback', userId };
  }

  if (!callbackId) {
    return { action: 'ignored', reason: 'missing-callback-id', userId };
  }

  if (!isAdmin(userId, adminUserIds, adminStore)) {
    await answerCallback(
      api,
      callbackId,
      'Эта кнопка доступна только администратору бота.',
    );
    return {
      action: 'command',
      command: `callback:${parsedPayload.action}`,
      userId,
      noticeSent: true,
    };
  }

  if (parsedPayload.action === 'list') {
    await answerCallback(
      api,
      callbackId,
      formatAdminsMessage(adminUserIds, adminStore),
      { updateMessage: true },
    );
    return {
      action: 'command',
      command: 'callback:admin-list',
      userId,
      noticeSent: true,
    };
  }

  if (!adminStore) {
    await answerCallback(
      api,
      callbackId,
      'Runtime-список администраторов не подключён.',
    );
    return {
      action: 'command',
      command: `callback:${parsedPayload.action}`,
      userId,
      noticeSent: true,
    };
  }

  const command =
    parsedPayload.action === 'add' ? '/addadmin' : '/removeadmin';
  const result = applyAdminCommand(
    adminStore,
    adminUserIds,
    command,
    String(parsedPayload.userId),
  );

  await answerCallback(api, callbackId, formatAdminCommandResult(result), {
    updateMessage: true,
  });

  return {
    action: 'command',
    command: `callback:${parsedPayload.action}`,
    userId,
    noticeSent: true,
  };
}

async function answerCallback(
  api,
  callbackId,
  text,
  { updateMessage = false } = {},
) {
  await api.answerCallback(callbackId, {
    notification: text,
    ...(updateMessage ? { message: { text } } : {}),
  });
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
  isDirectMessage = false,
}) {
  if (!text) {
    return { handled: false };
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  const [rawCommand, ...args] = trimmed.split(/\s+/u);
  const command = rawCommand.toLowerCase().split('@')[0];
  const argument = args.join(' ').trim();

  if (command === '/id') {
    await sendReply({
      api,
      chatId,
      userId,
      text: `Ваш MAX user_id: ${userId ?? 'не удалось определить'}`,
    });
    return { handled: true, command, noticeSent: true };
  }

  const adminCommands = new Set([
    '/help',
    '/commands',
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
    if (isDirectMessage) {
      return { handled: true, command, noticeSent: false };
    }

    await sendReply({
      api,
      chatId,
      userId,
      text:
        'Команда доступна только администратору бота. Напишите /id и добавьте этот user_id в BOT_ADMIN_IDS.',
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
        'Можно отправить контакт пользователя: бот покажет user_id и кнопки для админки.',
        'В ЛС бот отвечает только администраторам. Для остальных доступна только /id.',
      ].join('\n'),
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

async function maybeHandleContactAdminCandidate({
  api,
  message,
  chatId,
  userId,
  adminStore,
  adminUserIds,
}) {
  const contact = extractContactCandidate(message?.body?.attachments);
  if (!contact) {
    return { handled: false };
  }

  if (!isAdmin(userId, adminUserIds, adminStore)) {
    await sendReply({
      api,
      chatId,
      userId,
      text:
        'Контакты для управления администраторами может обрабатывать только администратор бота.',
    });
    return {
      handled: true,
      command: 'contact-admin-candidate',
      noticeSent: true,
    };
  }

  if (!adminStore) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Runtime-список администраторов не подключён.',
    });
    return {
      handled: true,
      command: 'contact-admin-candidate',
      noticeSent: true,
    };
  }

  if (!contact.userId) {
    await sendReply({
      api,
      chatId,
      userId,
      text: [
        `Контакт получил${contact.name ? `: ${contact.name}` : ''}.`,
        'MAX user_id в карточке не нашёл.',
        'Попросите пользователя написать боту /id или добавьте его командой /addadmin user_id.',
      ].join('\n'),
    });
    return {
      handled: true,
      command: 'contact-admin-candidate',
      noticeSent: true,
    };
  }

  await sendReply({
    api,
    chatId,
    userId,
    text: formatContactAdminMessage(contact),
    extra: {
      attachments: [buildAdminContactKeyboard(contact.userId)],
    },
  });

  return {
    handled: true,
    command: 'contact-admin-candidate',
    noticeSent: true,
  };
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
  const parsedUserId = parsePositiveInteger(argument);

  if (!parsedUserId) {
    return {
      changed: false,
      reason: 'invalid-user-id',
      type: command === '/addadmin' ? 'addadmin' : 'removeadmin',
      userId: argument,
    };
  }

  if (command === '/addadmin') {
    if (baseAdminUserIds.includes(parsedUserId)) {
      return {
        changed: false,
        reason: 'base-admin-exists',
        type: 'addadmin',
        userId: parsedUserId,
      };
    }

    return {
      type: 'addadmin',
      ...adminStore.addAdmin(parsedUserId),
    };
  }

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
    ...adminStore.removeAdmin(parsedUserId),
  };
}

function parseAdminCallbackPayload(payload) {
  if (payload === 'admin:list') {
    return { action: 'list' };
  }

  const match = String(payload || '').match(/^admin:(add|remove):(\d+)$/u);
  if (!match) {
    return null;
  }

  return {
    action: match[1],
    userId: Number.parseInt(match[2], 10),
  };
}

function getCallbackUserId(update) {
  return (
    update?.callback?.user?.user_id ??
    update?.callback?.sender?.user_id ??
    update?.callback?.user_id ??
    update?.user?.user_id ??
    null
  );
}

function extractContactCandidate(attachments) {
  const contactAttachment = attachments?.find((item) => item?.type === 'contact');
  if (!contactAttachment) {
    return null;
  }

  const payload = contactAttachment.payload || {};
  const maxInfo = payload.max_info || payload.maxInfo || {};

  return {
    userId: parsePositiveInteger(
      maxInfo.user_id ??
        maxInfo.userId ??
        maxInfo.id ??
        payload.user_id ??
        payload.userId ??
        payload.max_user_id ??
        payload.maxUserId ??
        contactAttachment.user_id ??
        contactAttachment.userId,
    ),
    name:
      maxInfo.name ||
      maxInfo.full_name ||
      [maxInfo.first_name, maxInfo.last_name].filter(Boolean).join(' ') ||
      payload.name ||
      extractVcfFullName(payload.vcf_info) ||
      '',
    hasHash: Boolean(payload.hash),
  };
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractVcfFullName(vcfInfo) {
  if (!vcfInfo) return '';
  const normalized = String(vcfInfo).replaceAll('\\r\\n', '\n');
  const match = normalized.match(/^FN(?:;[^:]*)?:(.+)$/im);
  return match?.[1]?.trim() || '';
}

function formatContactAdminMessage(contact) {
  return [
    `Получен контакт${contact.name ? `: ${contact.name}` : ''}.`,
    `MAX user_id: ${contact.userId}`,
    'Что сделать с этим пользователем?',
  ].join('\n');
}

function buildAdminContactKeyboard(userId) {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          {
            type: 'callback',
            text: 'Добавить админом',
            payload: `admin:add:${userId}`,
          },
        ],
        [
          {
            type: 'callback',
            text: 'Убрать админа',
            payload: `admin:remove:${userId}`,
          },
        ],
        [
          {
            type: 'callback',
            text: 'Показать админов',
            payload: 'admin:list',
          },
        ],
      ],
    },
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

  if (!result.changed && result.reason === 'base-admin-exists') {
    return `Администратор ${result.userId} уже задан в BOT_ADMIN_IDS. Дополнительно добавлять его не нужно.`;
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

async function sendReply({ api, chatId, userId, text, extra = {} }) {
  const options = { notify: false, ...extra };

  if (chatId) {
    await api.sendMessageToChat(chatId, text, options);
    return true;
  }

  if (userId) {
    await api.sendMessageToUser(userId, text, options);
    return true;
  }

  return false;
}
