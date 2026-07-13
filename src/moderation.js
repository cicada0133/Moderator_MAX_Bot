import { findProfanity, getBuiltInBadWordsCount } from './profanity.js';

const BAN_DURATIONS = {
  '30m': { label: '30 минут', durationMs: 30 * 60 * 1000 },
  '1d': { label: '1 день', durationMs: 24 * 60 * 60 * 1000 },
  '7d': { label: '7 дней', durationMs: 7 * 24 * 60 * 60 * 1000 },
  forever: { label: 'навсегда', durationMs: null },
};

export function createModerator({
  api,
  dryRun = false,
  notify = false,
  warningText,
  customBadWords = [],
  allowWords = [],
  dictionaryStore = null,
  adminStore = null,
  sanctionStore = null,
  adminUserIds = [],
  autoBanDefaults = {
    enabled: false,
    threshold: 3,
    windowMinutes: 10,
    durationMinutes: 30,
  },
}) {
  async function handleUpdate(update) {
    if (update?.update_type === 'message_callback') {
      return handleCallbackUpdate({
        api,
        update,
        dictionaryStore,
        adminStore,
        sanctionStore,
        adminUserIds,
      });
    }

    if (update?.update_type !== 'message_created') {
      return { action: 'ignored', reason: 'unsupported-update' };
    }

    const message = update.message;
    const text = message?.body?.text;
    const messageId = message?.body?.mid;
    const recipient = message?.recipient || {};
    const chatId = recipient.chat_id;
    const sender = message?.sender;
    const userId = message?.sender?.user_id;
    const userName = getUserDisplayName(sender);
    const username = sender?.username ? `@${sender.username}` : '';
    const isGroupChat = isGroupChatRecipient(recipient);
    const isDirectMessage = !isGroupChat;
    const senderIsAdmin = isAdmin(userId, adminUserIds, adminStore);

    if (message?.sender?.is_bot) {
      return { action: 'ignored', reason: 'bot-message' };
    }

    if (senderIsAdmin) {
      rememberKnownUser(adminStore, getUserProfileFromSender(sender));
    }

    if (isDirectMessage && !senderIsAdmin) {
      const commandResult = await maybeHandleCommand({
        api,
        message,
        text,
        chatId,
        userId,
        dictionaryStore,
        adminStore,
        sanctionStore,
        adminUserIds,
        autoBanDefaults,
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

    if (!isDirectMessage && !senderIsAdmin && messageId && sanctionStore) {
      const activeBan = sanctionStore.getActiveBan({ chatId, userId });
      if (activeBan) {
        if (dryRun) {
          return {
            action: 'would-delete',
            messageId,
            chatId,
            userId,
            userName,
            username,
            reason: 'soft-ban',
            token: '',
            noticeSent: false,
          };
        }

        await api.deleteMessage(messageId);
        return {
          action: 'soft-ban-delete',
          messageId,
          chatId,
          userId,
          userName,
          username,
          reason: 'soft-ban',
          ban: activeBan,
          noticeSent: false,
        };
      }
    }

    const contactResult = await maybeHandleContactAdminCandidate({
      api,
      message,
      chatId,
      sanctionChatId: isGroupChat ? chatId : null,
      userId,
      adminStore,
      sanctionStore,
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
      message,
      text,
      chatId,
      isGroupChat,
      userId,
      dictionaryStore,
      adminStore,
      sanctionStore,
      adminUserIds,
      autoBanDefaults,
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
    const autoBanResult = await maybeApplyAutoBan({
      api,
      notify,
      chatId,
      userId,
      userName,
      adminStore,
      sanctionStore,
      adminUserIds,
      autoBanDefaults,
      senderIsAdmin,
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
      autoBan: autoBanResult.ban,
      autoBanNoticeSent: autoBanResult.noticeSent,
    };
  }

  return { handleUpdate };
}

async function handleCallbackUpdate({
  api,
  update,
  dictionaryStore,
  adminStore,
  sanctionStore,
  adminUserIds,
}) {
  const callback = update.callback;
  const callbackId = callback?.callback_id;
  const payload = callback?.payload;
  const parsedPayload = parseCallbackPayload(payload);
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
      command: `callback:${parsedPayload.kind}:${parsedPayload.action}`,
      userId,
      noticeSent: true,
    };
  }

  if (parsedPayload.kind === 'panel') {
    return handlePanelCallback({
      api,
      callbackId,
      parsedPayload,
      dictionaryStore,
      adminStore,
      sanctionStore,
      adminUserIds,
      userId,
    });
  }

  if (parsedPayload.kind === 'sanction') {
    if (parsedPayload.action === 'unban') {
      return handleSanctionUnbanCallback({
        api,
        callbackId,
        parsedPayload,
        sanctionStore,
        adminStore,
        userId,
      });
    }

    await answerCallback(
      api,
      callbackId,
      formatSanctionCallbackDisabledMessage(),
      withKeyboard(
        { updateMessage: true },
        null,
        { clearWhenMissing: true },
      ),
    );
    return {
      action: 'command',
      command: `callback:sanction:${parsedPayload.action}`,
      userId,
      noticeSent: true,
    };
  }

  if (parsedPayload.action === 'list') {
    await answerCallback(
      api,
      callbackId,
      formatAdminsMessage(adminUserIds, adminStore, { links: true }),
      withKeyboard(
        { updateMessage: true, format: 'markdown' },
        buildAdminsActionKeyboard(adminUserIds, adminStore),
        { clearWhenMissing: true },
      ),
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
  const resultText = formatAdminCommandResult(result, adminStore, {
    links: true,
  });

  await answerCallback(
    api,
    callbackId,
    [
      resultText,
      '',
      formatAdminsMessage(adminUserIds, adminStore, { links: true }),
    ].join('\n'),
    {
      updateMessage: true,
      format: 'markdown',
      notification: resultText,
      ...withKeyboard(
        {},
        buildAdminsActionKeyboard(adminUserIds, adminStore),
        { clearWhenMissing: true },
      ),
    },
  );

  return {
    action: 'command',
    command: `callback:${parsedPayload.action}`,
    userId,
    noticeSent: true,
  };
}

async function handlePanelCallback({
  api,
  callbackId,
  parsedPayload,
  dictionaryStore,
  adminStore,
  sanctionStore,
  adminUserIds,
  userId,
}) {
  const action = parsedPayload.action;
  let text = formatAdminPanelMessage();
  let format;
  let keyboard = buildAdminPanelKeyboard();

  if (action === 'help') {
    text = formatHelpMessage();
  } else if (action === 'banhelp') {
    text = formatBanHelpMessage();
  } else if (action === 'badwords') {
    text = dictionaryStore
      ? formatDictionaryMessage(dictionaryStore.list())
      : 'Пользовательский словарь не подключён.';
  } else if (action === 'admins') {
    text = formatAdminsMessage(adminUserIds, adminStore, { links: true });
    format = 'markdown';
    keyboard = buildAdminsActionKeyboard(adminUserIds, adminStore, {
      includeBack: true,
    });
  } else if (action === 'bans') {
    text =
      'Список активных soft-ban привязан к группе. Откройте нужную группу и отправьте /bans.';
  } else if (action === 'id') {
    text = `Ваш MAX user_id: ${userId ?? 'не удалось определить'}`;
  }

  await answerCallback(api, callbackId, text, {
    updateMessage: true,
    format,
    ...withKeyboard({}, keyboard),
  });

  return {
    action: 'command',
    command: `callback:panel:${action}`,
    userId,
    noticeSent: true,
  };
}

async function handleSanctionUnbanCallback({
  api,
  callbackId,
  parsedPayload,
  sanctionStore,
  adminStore,
  userId,
}) {
  if (!sanctionStore) {
    await answerCallback(api, callbackId, 'Хранилище санкций не подключено.');
    return {
      action: 'command',
      command: 'callback:sanction:unban',
      userId,
      noticeSent: true,
    };
  }

  const result = sanctionStore.liftBan({
    chatId: parsedPayload.chatId,
    userId: parsedPayload.userId,
    moderatorUserId: userId,
  });
  const resultText = formatUnbanResult(result, adminStore, { links: true });
  const bansText = formatBansMessage({
    chatId: parsedPayload.chatId,
    sanctionStore,
    adminStore,
    links: true,
  });

  await answerCallback(api, callbackId, [resultText, '', bansText].join('\n'), {
    updateMessage: true,
    format: 'markdown',
    notification: resultText,
    ...withKeyboard(
      {},
      buildBansActionKeyboard({
        chatId: parsedPayload.chatId,
        sanctionStore,
        adminStore,
      }),
      { clearWhenMissing: true },
    ),
  });

  return {
    action: 'command',
    command: 'callback:sanction:unban',
    userId,
    noticeSent: true,
  };
}

async function answerCallback(
  api,
  callbackId,
  text,
  { updateMessage = false, format, attachments, notification } = {},
) {
  await api.answerCallback(callbackId, {
    notification: stripMarkdownLinks(notification || text),
    ...(updateMessage
      ? {
          message: {
            text,
            ...(format ? { format } : {}),
            ...(attachments ? { attachments } : {}),
          },
        }
      : {}),
  });
}

function withKeyboard(options = {}, keyboard, { clearWhenMissing = false } = {}) {
  if (keyboard) {
    return { ...options, attachments: [keyboard] };
  }

  return clearWhenMissing ? { ...options, attachments: [] } : options;
}

function rememberKnownUser(adminStore, profile) {
  adminStore?.upsertKnownUser?.(profile);
}

async function maybeApplyAutoBan({
  api,
  notify,
  chatId,
  userId,
  userName,
  adminStore,
  sanctionStore,
  adminUserIds,
  autoBanDefaults,
  senderIsAdmin,
}) {
  if (
    senderIsAdmin ||
    !chatId ||
    !userId ||
    !sanctionStore?.getAutoBanSettings ||
    !sanctionStore?.recordViolation ||
    !sanctionStore?.setBan
  ) {
    return { applied: false, ban: null, noticeSent: false };
  }

  if (isAdmin(userId, adminUserIds, adminStore)) {
    return { applied: false, ban: null, noticeSent: false };
  }

  const settings = sanctionStore.getAutoBanSettings(chatId, autoBanDefaults);
  if (!settings?.enabled) {
    return { applied: false, ban: null, noticeSent: false };
  }

  const violation = sanctionStore.recordViolation({
    chatId,
    userId,
    windowMinutes: settings.windowMinutes,
  });
  if (!violation.changed || violation.count < settings.threshold) {
    return {
      applied: false,
      ban: null,
      noticeSent: false,
      count: violation.count || 0,
      threshold: settings.threshold,
    };
  }

  const result = sanctionStore.setBan({
    chatId,
    userId,
    durationMs: settings.durationMinutes * 60 * 1000,
    moderatorUserId: null,
    reason: `auto-ban: ${settings.threshold} violations in ${settings.windowMinutes} minutes`,
  });

  if (!result.changed) {
    return {
      applied: false,
      ban: null,
      noticeSent: false,
      count: violation.count,
      threshold: settings.threshold,
    };
  }

  sanctionStore.clearViolations?.({ chatId, userId });
  const noticeSent = await sendAutoBanNotice({
    api,
    notify,
    chatId,
    userId,
    userName,
    settings,
    violationCount: violation.count,
  });

  return {
    applied: true,
    ban: result.ban,
    noticeSent,
    count: violation.count,
    threshold: settings.threshold,
  };
}

async function sendAutoBanNotice({
  api,
  notify,
  chatId,
  userId,
  userName,
  settings,
  violationCount,
}) {
  if (!notify || !chatId) {
    return false;
  }

  const label = userName || `user_id ${userId}`;
  await api.sendMessageToChat(
    chatId,
    [
      `${label}, вы нарушили правила чата ${formatTimesLabel(violationCount || settings.threshold)} за ${formatMinutesLabel(settings.windowMinutes)}.`,
      `На вас наложено ограничение на ${formatMinutesLabel(settings.durationMinutes)}.`,
      'Пока ограничение активно, бот будет удалять ваши сообщения в этом чате.',
    ].join('\n'),
    { notify: false },
  );
  return true;
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
  const fullName = [sender?.first_name, sender?.last_name]
    .filter(Boolean)
    .join(' ');
  if (fullName) return fullName;
  if (sender?.username) return `@${sender.username}`;
  return 'Участник';
}

function getUserProfileFromSender(sender = {}) {
  return {
    userId: sender.user_id ?? sender.userId,
    name: sender.name || '',
    firstName: sender.first_name || sender.firstName || '',
    lastName: sender.last_name || sender.lastName || '',
    username: sender.username || '',
  };
}

function isGroupChatRecipient(recipient = {}) {
  const chatType = normalizeRecipientChatType(recipient);
  if (['dialog', 'private', 'direct', 'user'].includes(chatType)) {
    return false;
  }

  if (['chat', 'group', 'supergroup', 'channel'].includes(chatType)) {
    return true;
  }

  if (recipient.user_id || recipient.userId) {
    return false;
  }

  return Boolean(recipient.chat_id ?? recipient.chatId);
}

function normalizeRecipientChatType(recipient = {}) {
  return String(
    recipient.chat_type ??
      recipient.chatType ??
      recipient.type ??
      recipient.chat?.type ??
      '',
  )
    .trim()
    .toLowerCase();
}

async function maybeHandleCommand({
  api,
  message,
  text,
  chatId,
  isGroupChat = false,
  userId,
  dictionaryStore,
  adminStore,
  sanctionStore,
  adminUserIds,
  autoBanDefaults,
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
    '/start',
    '/menu',
    '/help',
    '/commands',
    '/banhelp',
    '/banmenu',
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
    '/ban',
    '/unban',
    '/bans',
    '/autoban',
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

  if (['/start', '/menu'].includes(command)) {
    await sendReply({
      api,
      chatId,
      userId,
      text: isDirectMessage
        ? formatAdminPanelMessage()
        : 'Панель управления открывается в ЛС с ботом. Напишите боту /start.',
      extra: isDirectMessage
        ? { attachments: [buildAdminPanelKeyboard()] }
        : {},
    });
    return { handled: true, command, noticeSent: true };
  }

  if (['/help', '/commands'].includes(command)) {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatHelpMessage(),
    });
    return { handled: true, command, noticeSent: true };
  }

  if (['/banhelp', '/banmenu'].includes(command)) {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatBanHelpMessage(),
    });
    return { handled: true, command, noticeSent: true };
  }

  if (command === '/admins') {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatAdminsMessage(adminUserIds, adminStore, { links: true }),
      extra: {
        format: 'markdown',
        ...withKeyboard(
          {},
          buildAdminsActionKeyboard(adminUserIds, adminStore),
        ),
      },
    });
    return { handled: true, command, noticeSent: true };
  }

  if (command === '/autoban') {
    const result = await maybeHandleAutoBanCommand({
      api,
      argument,
      chatId,
      isGroupChat,
      userId,
      sanctionStore,
      autoBanDefaults,
    });
    return { handled: true, command, noticeSent: result.noticeSent };
  }

  if (['/ban', '/unban', '/bans'].includes(command)) {
    const result = await maybeHandleSanctionCommand({
      api,
      command,
      argument,
      message,
      chatId,
      isGroupChat,
      userId,
      sanctionStore,
      adminStore,
      adminUserIds,
    });
    return { handled: true, command, noticeSent: result.noticeSent };
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
      text: formatAdminCommandResult(result, adminStore, { links: true }),
      extra: { format: 'markdown' },
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

async function maybeHandleAutoBanCommand({
  api,
  argument,
  chatId,
  isGroupChat,
  userId,
  sanctionStore,
  autoBanDefaults,
}) {
  if (!isGroupChat || !chatId) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Авто-ban настраивается только в группе, потому что правило привязано к конкретному чату.',
    });
    return { noticeSent: true };
  }

  if (!sanctionStore?.getAutoBanSettings || !sanctionStore?.setAutoBanSettings) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Хранилище санкций не подключено.',
    });
    return { noticeSent: true };
  }

  const currentSettings = sanctionStore.getAutoBanSettings(
    chatId,
    autoBanDefaults,
  );
  const parsed = parseAutoBanCommand(argument, currentSettings);
  if (!parsed.ok) {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatAutoBanHelpMessage(currentSettings),
    });
    return { noticeSent: true };
  }

  if (parsed.action === 'status') {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatAutoBanSettingsMessage(currentSettings),
    });
    return { noticeSent: true };
  }

  const result = sanctionStore.setAutoBanSettings({
    chatId,
    moderatorUserId: userId,
    ...parsed.settings,
  });

  await sendReply({
    api,
    chatId,
    userId,
    text: result.changed
      ? formatAutoBanSettingsMessage(result.settings, {
          prefix: 'Настройки авто-bana обновлены.',
        })
      : 'Не удалось сохранить настройки авто-bana. Проверьте числа в команде.',
  });
  return { noticeSent: true };
}

async function maybeHandleSanctionCommand({
  api,
  command,
  argument,
  message,
  chatId,
  isGroupChat,
  userId,
  sanctionStore,
  adminStore,
  adminUserIds,
}) {
  if (!isGroupChat || !chatId) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Soft-ban работает только в группе. В ЛС с ботом ban не включается.',
    });
    return { noticeSent: true };
  }

  if (!sanctionStore) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Хранилище санкций не подключено.',
    });
    return { noticeSent: true };
  }

  if (command === '/bans') {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatBansMessage({
        chatId,
        sanctionStore,
        adminStore,
        links: true,
      }),
      extra: {
        format: 'markdown',
        ...withKeyboard(
          {},
          buildBansActionKeyboard({ chatId, sanctionStore, adminStore }),
        ),
      },
    });
    return { noticeSent: true };
  }

  const linkedUser = extractLinkedMessageUser(message);
  if (linkedUser?.userId) {
    rememberKnownUser(adminStore, linkedUser);
  }
  const parts = argument ? argument.split(/\s+/u) : [];
  const parsedArgs = parseSanctionCommandArgs({
    command,
    parts,
    linkedUser,
  });

  if (!parsedArgs.userId) {
    await sendReply({
      api,
      chatId,
      userId,
      text:
        command === '/ban'
          ? 'Формат: /ban user_id 30m|1d|7d|forever или ответом на сообщение: /ban 30'
          : 'Формат: /unban user_id или ответом на сообщение: /unban',
    });
    return { noticeSent: true };
  }

  if (command === '/unban') {
    const result = sanctionStore.liftBan({
      chatId,
      userId: parsedArgs.userId,
      moderatorUserId: userId,
    });
    await sendReply({
      api,
      chatId,
      userId,
      text: formatUnbanResult(result, adminStore, { links: true }),
      extra: { format: 'markdown' },
    });
    return { noticeSent: true };
  }

  const duration = parseBanDuration(parsedArgs.duration);
  if (!duration) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Срок бана не распознан. Доступно: число минут, 30m, 1d, 7d, forever.',
    });
    return { noticeSent: true };
  }

  if (isAdmin(parsedArgs.userId, adminUserIds, adminStore)) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Администраторов бота нельзя отправить в soft-ban.',
    });
    return { noticeSent: true };
  }

  const result = sanctionStore.setBan({
    chatId,
    userId: parsedArgs.userId,
    durationMs: duration.durationMs,
    moderatorUserId: userId,
    reason: parsedArgs.reason || parsedArgs.reasonFallback,
  });
  await sendReply({
    api,
    chatId,
    userId,
    text: formatBanResult(result, adminStore, { links: true }),
    extra: { format: 'markdown' },
  });
  return { noticeSent: true };
}

async function maybeHandleContactAdminCandidate({
  api,
  message,
  chatId,
  sanctionChatId,
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

  rememberKnownUser(adminStore, contact);

  await sendReply({
    api,
    chatId,
    userId,
    text: formatContactAdminMessage(contact, {
      links: true,
      chatId: sanctionChatId,
    }),
    extra: {
      format: 'markdown',
      attachments: [buildContactActionKeyboard(contact.userId, sanctionChatId)],
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

function parseCallbackPayload(payload) {
  const panelMatch = String(payload || '').match(
    /^panel:(menu|help|banhelp|badwords|admins|bans|id)$/u,
  );
  if (panelMatch) {
    return {
      kind: 'panel',
      action: panelMatch[1],
    };
  }

  if (payload === 'admin:list') {
    return { kind: 'admin', action: 'list' };
  }

  const adminMatch = String(payload || '').match(/^admin:(add|remove):(\d+)$/u);
  if (adminMatch) {
    return {
      kind: 'admin',
      action: adminMatch[1],
      userId: Number.parseInt(adminMatch[2], 10),
    };
  }

  const sanctionMenuMatch = String(payload || '').match(
    /^sanction:menu:([^:]+):(\d+)$/u,
  );
  if (sanctionMenuMatch) {
    return {
      kind: 'sanction',
      action: 'menu',
      chatId: sanctionMenuMatch[1],
      userId: Number.parseInt(sanctionMenuMatch[2], 10),
    };
  }

  const sanctionListMatch = String(payload || '').match(/^sanction:list:([^:]+)$/u);
  if (sanctionListMatch) {
    return {
      kind: 'sanction',
      action: 'list',
      chatId: sanctionListMatch[1],
    };
  }

  const sanctionUnbanMatch = String(payload || '').match(
    /^sanction:unban:([^:]+):(\d+)$/u,
  );
  if (sanctionUnbanMatch) {
    return {
      kind: 'sanction',
      action: 'unban',
      chatId: sanctionUnbanMatch[1],
      userId: Number.parseInt(sanctionUnbanMatch[2], 10),
    };
  }

  const sanctionBanMatch = String(payload || '').match(
    /^sanction:ban:([^:]+):(\d+):(30m|1d|7d|forever)$/u,
  );
  if (sanctionBanMatch) {
    return {
      kind: 'sanction',
      action: 'ban',
      chatId: sanctionBanMatch[1],
      userId: Number.parseInt(sanctionBanMatch[2], 10),
      duration: sanctionBanMatch[3],
    };
  }

  return null;
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
    firstName:
      maxInfo.first_name || maxInfo.firstName || payload.first_name || '',
    lastName: maxInfo.last_name || maxInfo.lastName || payload.last_name || '',
    username: maxInfo.username || payload.username || '',
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

function formatContactAdminMessage(contact, { links = false, chatId } = {}) {
  const contactLabel = formatKnownUser(contact.userId, {
    [String(contact.userId)]: contact,
  }, { links });

  const lines = [
    `Получен контакт: ${contactLabel}.`,
    `MAX user_id: ${contact.userId}`,
    'Что сделать с этим пользователем?',
  ];

  if (chatId) {
    lines.push('Для soft-ban используйте команды в группе: /ban, /unban, /bans.');
  } else {
    lines.push('Soft-ban через контактные кнопки отключён. Используйте команды в нужной группе.');
  }

  return lines.join('\n');
}

function buildContactActionKeyboard(userId) {
  const buttons = [
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
  ];

  buttons.push([
    {
      type: 'callback',
      text: 'Показать админов',
      payload: 'admin:list',
    },
  ]);

  return {
    type: 'inline_keyboard',
    payload: {
      buttons,
    },
  };
}

function buildAdminPanelKeyboard() {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          {
            type: 'callback',
            text: 'Помощь',
            payload: 'panel:help',
          },
          {
            type: 'callback',
            text: 'Soft-ban',
            payload: 'panel:banhelp',
          },
        ],
        [
          {
            type: 'callback',
            text: 'Словарь',
            payload: 'panel:badwords',
          },
          {
            type: 'callback',
            text: 'Админы',
            payload: 'panel:admins',
          },
        ],
        [
          {
            type: 'callback',
            text: 'Баны',
            payload: 'panel:bans',
          },
          {
            type: 'callback',
            text: 'Мой id',
            payload: 'panel:id',
          },
        ],
      ],
    },
  };
}

function buildAdminsActionKeyboard(baseAdminUserIds, adminStore, { includeBack = false } = {}) {
  const storedAdmins = adminStore?.list() || {};
  const runtimeAdminUserIds = (storedAdmins.adminUserIds || [])
    .map((id) => Number(id))
    .filter((id) => !baseAdminUserIds.includes(id));
  const buttons = runtimeAdminUserIds.map((id) => [
    {
      type: 'callback',
      text: `Убрать ${formatButtonUserLabel(id, adminStore)}`,
      payload: `admin:remove:${id}`,
    },
  ]);

  if (includeBack) {
    buttons.push([
      {
        type: 'callback',
        text: 'В меню',
        payload: 'panel:menu',
      },
    ]);
  }

  if (!buttons.length) {
    return null;
  }

  return {
    type: 'inline_keyboard',
    payload: { buttons },
  };
}

function buildBansActionKeyboard({ chatId, sanctionStore, adminStore }) {
  const activeBans = sanctionStore?.listActiveBans?.(chatId) || [];
  if (!activeBans.length) {
    return null;
  }

  return {
    type: 'inline_keyboard',
    payload: {
      buttons: activeBans.map((ban) => [
        {
          type: 'callback',
          text: `Снять ban ${formatButtonUserLabel(ban.userId, adminStore)}`,
          payload: `sanction:unban:${chatId}:${ban.userId}`,
        },
      ]),
    },
  };
}

function formatAdminCommandResult(result, adminStore, { links = false } = {}) {
  const userLabel = formatKnownUserId(result.userId, adminStore, { links });

  if (result.reason === 'invalid-user-id') {
    return 'Не удалось разобрать user_id. Нужен числовой MAX user_id.';
  }

  if (!result.changed && result.reason === 'already-exists') {
    return `Администратор уже добавлен: ${userLabel}`;
  }

  if (!result.changed && result.reason === 'not-found') {
    return `Администратор не найден в runtime-списке: ${userLabel}`;
  }

  if (!result.changed && result.reason === 'base-admin') {
    return `Администратор ${userLabel} задан в BOT_ADMIN_IDS. Его нельзя удалить командой, только через .env.`;
  }

  if (!result.changed && result.reason === 'base-admin-exists') {
    return `Администратор ${userLabel} уже задан в BOT_ADMIN_IDS. Дополнительно добавлять его не нужно.`;
  }

  if (result.type === 'addadmin') {
    return `Администратор добавлен: ${userLabel}`;
  }

  return `Администратор удалён из runtime-списка: ${userLabel}`;
}

function parseAutoBanCommand(argument, currentSettings) {
  const parts = String(argument || '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  if (!parts.length || ['status', 'статус'].includes(parts[0].toLowerCase())) {
    return { ok: true, action: 'status' };
  }

  const first = parts[0].toLowerCase();
  if (['off', 'disable', 'disabled', 'выкл', 'выключить'].includes(first)) {
    return {
      ok: true,
      action: 'set',
      settings: { ...currentSettings, enabled: false },
    };
  }

  if (['on', 'enable', 'enabled', 'вкл', 'включить'].includes(first)) {
    if (parts.length === 1) {
      return {
        ok: true,
        action: 'set',
        settings: { ...currentSettings, enabled: true },
      };
    }

    const numbers = parseAutoBanNumbers(parts.slice(1));
    return numbers
      ? {
          ok: true,
          action: 'set',
          settings: { ...numbers, enabled: true },
        }
      : { ok: false };
  }

  const numbers = parseAutoBanNumbers(parts);
  return numbers
    ? {
        ok: true,
        action: 'set',
        settings: { ...numbers, enabled: true },
      }
    : { ok: false };
}

function parseAutoBanNumbers(parts) {
  if (parts.length !== 3) {
    return null;
  }

  const [threshold, windowMinutes, durationMinutes] = parts.map((item) =>
    Number.parseInt(item, 10),
  );
  if (
    ![threshold, windowMinutes, durationMinutes].every(
      (item) => Number.isSafeInteger(item) && item > 0,
    )
  ) {
    return null;
  }

  return { threshold, windowMinutes, durationMinutes };
}

function formatAutoBanHelpMessage(currentSettings) {
  return [
    'Формат авто-bana:',
    '  /autoban — показать текущие настройки',
    '  /autoban on — включить с текущими настройками',
    '  /autoban off — выключить',
    '  /autoban 3 10 30 — 3 нарушения за 10 минут, ban на 30 минут',
    '',
    'Текущие настройки:',
    formatAutoBanRuleLine(currentSettings),
  ].join('\n');
}

function formatAutoBanSettingsMessage(settings, { prefix = '' } = {}) {
  return [
    prefix,
    `Авто-ban: ${settings?.enabled ? 'включён' : 'выключен'}`,
    formatAutoBanRuleLine(settings),
    '',
    'Изменить: /autoban 3 10 30',
    'Выключить: /autoban off',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatAutoBanRuleLine(settings = {}) {
  return `Правило: ${settings.threshold} нарушений за ${formatMinutesLabel(settings.windowMinutes)} -> soft-ban на ${formatMinutesLabel(settings.durationMinutes)}.`;
}

function formatHelpMessage() {
  return [
    'Команды модератора',
    '',
    '  /id — показать ваш user_id',
    '  /help — показать это меню',
    '',
    'Словарь',
    '  /badwords — показать пользовательский словарь',
    '  /banword слово — добавить слово или фрагмент в банлист',
    '  /unbanword слово — удалить из банлиста',
    '  /allowword слово — добавить исключение',
    '  /unallowword слово — удалить исключение',
    '',
    'Администраторы бота',
    '  /admins — показать администраторов',
    '  /addadmin user_id — добавить администратора',
    '  /removeadmin user_id — удалить runtime-администратора',
    '',
    'Баны',
    '  /banhelp — отдельное меню soft-ban',
    '  /autoban — настройки авто-bana в текущей группе',
    '',
    'Через контакт',
    '  Отправьте контакт пользователя в нужную группу.',
    '  Бот покажет user_id и админ-кнопки.',
    '  Бан ставится только командами.',
    '',
    'В ЛС бот отвечает только администраторам. Для остальных доступна только /id.',
  ].join('\n');
}

function formatAdminPanelMessage() {
  return [
    'Панель администратора',
    '',
    'Кнопки здесь дублируют безопасные команды.',
    'Soft-ban управляется в группе: /ban, /unban, /bans, /autoban.',
  ].join('\n');
}

function formatBanHelpMessage() {
  return [
    'Меню soft-ban',
    '',
    'По user_id',
    '  /ban user_id 30 — бан на 30 минут',
    '  /ban user_id 7d — бан на 7 дней',
    '  /ban user_id forever — бан до снятия',
    '  /unban user_id — снять бан',
    '  /bans — показать активные баны',
    '',
    'Авто-ban',
    '  /autoban — показать текущие настройки',
    '  /autoban on — включить',
    '  /autoban off — выключить',
    '  /autoban 3 10 30 — 3 нарушения за 10 минут, ban на 30 минут',
    '',
    'По сообщению пользователя',
    '  Ответьте командой на сообщение того пользователя, которого надо забанить.',
    '  /ban 30 — бан на 30 минут',
    '  /ban 7d — бан на 7 дней',
    '  Без суффикса число считается минутами, с d — днями.',
    '',
    'Через контакт',
    '  Отправьте контакт в нужную группу.',
    '  Так можно быстро увидеть user_id.',
    '  Бан-кнопок нет: используйте команды вручную.',
    '',
    'Важно',
    '  Soft-ban — это автоудаление новых сообщений пользователя.',
    '  Он не исключает пользователя и не запрещает писать средствами MAX.',
    '  Жёсткий бан администратор делает вручную: блокирует или исключает из группы.',
    '  Soft-ban действует только в текущем чате.',
    '  В ЛС бан не включается: там нет group chat_id.',
    '  Администраторов бота нельзя отправить в soft-ban.',
  ].join('\n');
}

function formatSanctionCallbackDisabledMessage() {
  return [
    'Бан-кнопки отключены.',
    'Используйте команды вручную в нужной группе:',
    '/ban user_id 30',
    '/unban user_id',
    '/bans',
  ].join('\n');
}

function formatAdminsMessage(baseAdminUserIds, adminStore, { links = false } = {}) {
  const pruneResult = adminStore?.pruneBaseAdmins?.(baseAdminUserIds);
  const storedAdmins = pruneResult?.admins || adminStore?.list() || {};
  const runtimeAdminUserIds = storedAdmins.adminUserIds || [];
  const allAdminUserIds = [
    ...new Set([...baseAdminUserIds, ...runtimeAdminUserIds]),
  ].sort((left, right) => left - right);

  return [
    `Администраторы бота:\n${formatAdminList(allAdminUserIds, storedAdmins.knownUsers, { links })}`,
    `Из .env:\n${formatAdminList(baseAdminUserIds, storedAdmins.knownUsers, { links })}`,
    `Добавлены командами:\n${formatAdminList(runtimeAdminUserIds, storedAdmins.knownUsers, { links })}`,
  ].join('\n\n');
}

function formatBanResult(result, adminStore, { links = false } = {}) {
  if (!result.changed) {
    return 'Не удалось включить soft-ban. Проверьте user_id и чат.';
  }

  const userLabel = formatKnownUserId(result.ban.userId, adminStore, { links });
  const until = formatBanUntil(result.ban);
  const verb = result.action === 'updated' ? 'обновлён' : 'включён';
  return [
    `Soft-ban ${verb}: ${userLabel}`,
    `Срок: ${until}`,
    'Пока ban активен, бот будет удалять сообщения пользователя в этом чате.',
  ].join('\n');
}

function formatUnbanResult(result, adminStore, { links = false } = {}) {
  const userLabel = formatKnownUserId(result.userId ?? result.ban?.userId, adminStore, {
    links,
  });

  if (!result.changed && result.reason === 'not-found') {
    return `Активный soft-ban не найден: ${userLabel}`;
  }

  if (!result.changed) {
    return 'Не удалось снять soft-ban. Проверьте user_id и чат.';
  }

  return `Soft-ban снят: ${userLabel}`;
}

function formatBansMessage({ chatId, sanctionStore, adminStore, links = false }) {
  const activeBans = sanctionStore.listActiveBans(chatId);
  if (!activeBans.length) {
    return 'Активных soft-ban в этом чате нет.';
  }

  return [
    'Активные soft-ban в этом чате:',
    ...activeBans.map((ban) => {
      const userLabel = formatKnownUserId(ban.userId, adminStore, { links });
      return `- ${userLabel} — ${formatBanUntil(ban)}`;
    }),
  ].join('\n');
}

function formatBanUntil(ban) {
  if (!ban?.expiresAt) return 'навсегда, до снятия бана';
  return `до ${formatDateTime(ban.expiresAt)}`;
}

function formatAdminList(ids, knownUsers = {}, { links = false } = {}) {
  if (!ids?.length) return 'пусто';
  return ids
    .map((id) => `- ${formatKnownUser(id, knownUsers, { links })}`)
    .join('\n');
}

function formatKnownUserId(userId, adminStore, { links = false } = {}) {
  return formatKnownUser(userId, adminStore?.list()?.knownUsers || {}, {
    links,
  });
}

function formatKnownUser(userId, knownUsers = {}, { links = false } = {}) {
  const profile = knownUsers[String(userId)] || {};
  const name = getStoredProfileName(profile);
  const username = profile.username ? `@${profile.username}` : '';
  const displayName = links ? formatUserMention(userId, name) : name;

  if (displayName && username) {
    return `${displayName} (${username}, ${userId})`;
  }

  if (username) {
    return `${username} (${userId})`;
  }

  if (displayName) {
    return `${displayName} (${userId})`;
  }

  return String(userId);
}

function formatButtonUserLabel(userId, adminStore) {
  const label = stripMarkdownLinks(formatKnownUserId(userId, adminStore));
  return label.length > 48 ? `${label.slice(0, 45)}...` : label;
}

function formatUserMention(userId, name) {
  if (!name) return '';
  return `[${escapeMarkdownLinkText(name)}](max://user/${userId})`;
}

function getStoredProfileName(profile = {}) {
  if (profile.name) return profile.name;
  return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
}

function parseSanctionCommandArgs({ command, parts, linkedUser }) {
  const linkedUserId = linkedUser?.userId;
  const canUseLinkedUser =
    linkedUserId && (parts.length === 0 || shouldUseLinkedTarget(parts));

  if (command === '/unban') {
    return {
      userId: canUseLinkedUser ? linkedUserId : parts[0],
      reason: '',
      reasonFallback: 'manual-command',
    };
  }

  if (canUseLinkedUser) {
    return {
      userId: linkedUserId,
      duration: parts[0],
      reason: parts.slice(1).join(' '),
      reasonFallback: 'linked-message-command',
    };
  }

  return {
    userId: parts[0],
    duration: parts[1],
    reason: parts.slice(2).join(' '),
    reasonFallback: 'manual-command',
  };
}

function shouldUseLinkedTarget(parts) {
  if (!parts.length) return true;
  if (parts.length === 1) return true;

  const [first, second] = parts;
  if (parseBanDuration(second)) {
    return false;
  }

  return Boolean(parseBanDuration(first));
}

function extractLinkedMessageUser(message = {}) {
  const linked = findLinkedMessage(message);
  const sender =
    linked?.sender ||
    linked?.message?.sender ||
    linked?.original_sender ||
    linked?.originalSender ||
    linked?.from ||
    linked?.author ||
    linked?.user;

  if (!sender) {
    return null;
  }

  const profile = getUserProfileFromSender(sender);
  return parsePositiveInteger(profile.userId) ? profile : null;
}

function findLinkedMessage(message = {}) {
  return (
    message.link ||
    message.linked_message ||
    message.linkedMessage ||
    message.body?.link ||
    message.body?.linked_message ||
    message.body?.linkedMessage ||
    null
  );
}

function parseBanDuration(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const aliases = {
    '30m': '30m',
    '30м': '30m',
    '30min': '30m',
    '30мин': '30m',
    '1d': '1d',
    '1д': '1d',
    день: '1d',
    '7d': '7d',
    '7д': '7d',
    неделя: '7d',
    forever: 'forever',
    навсегда: 'forever',
    permanent: 'forever',
    perm: 'forever',
  };
  const key = aliases[normalized] || normalized;
  if (BAN_DURATIONS[key]) {
    return { key, ...BAN_DURATIONS[key] };
  }

  const minutesMatch = key.match(/^(\d+)(?:m|м|min|мин)?$/u);
  if (minutesMatch) {
    const minutes = Number.parseInt(minutesMatch[1], 10);
    return createRelativeBanDuration({
      key: `${minutes}m`,
      label: formatMinutesLabel(minutes),
      amount: minutes,
      unitMs: 60 * 1000,
    });
  }

  const daysMatch = key.match(/^(\d+)(?:d|д)$/u);
  if (daysMatch) {
    const days = Number.parseInt(daysMatch[1], 10);
    return createRelativeBanDuration({
      key: `${days}d`,
      label: `${days} дн.`,
      amount: days,
      unitMs: 24 * 60 * 60 * 1000,
    });
  }

  return null;
}

function createRelativeBanDuration({ key, label, amount, unitMs }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  return {
    key,
    label,
    durationMs: amount * unitMs,
  };
}

function formatMinutesLabel(minutes) {
  const lastDigit = minutes % 10;
  const lastTwoDigits = minutes % 100;
  if (lastDigit === 1 && lastTwoDigits !== 11) return `${minutes} минута`;
  if ([2, 3, 4].includes(lastDigit) && ![12, 13, 14].includes(lastTwoDigits)) {
    return `${minutes} минуты`;
  }
  return `${minutes} минут`;
}

function formatTimesLabel(count) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  if (lastDigit === 1 && lastTwoDigits !== 11) return `${count} раз`;
  if ([2, 3, 4].includes(lastDigit) && ![12, 13, 14].includes(lastTwoDigits)) {
    return `${count} раза`;
  }
  return `${count} раз`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function escapeMarkdownLinkText(value) {
  return String(value).replace(/[\\[\]()]/gu, '\\$&');
}

function stripMarkdownLinks(value) {
  return String(value).replace(/\[([^\]]+)\]\(max:\/\/user\/\d+\)/gu, '$1');
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
