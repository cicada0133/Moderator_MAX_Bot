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
}) {
  async function handleUpdate(update) {
    if (update?.update_type === 'message_callback') {
      return handleCallbackUpdate({
        api,
        update,
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

    if (senderIsAdmin) {
      rememberKnownUser(adminStore, getUserProfileFromSender(sender));
    }

    if (isDirectMessage && !senderIsAdmin) {
      const commandResult = await maybeHandleCommand({
        api,
        text,
        chatId,
        userId,
        dictionaryStore,
        adminStore,
        sanctionStore,
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
      text,
      chatId,
      userId,
      dictionaryStore,
      adminStore,
      sanctionStore,
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

async function handleCallbackUpdate({
  api,
  update,
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

  if (parsedPayload.kind === 'sanction') {
    return handleSanctionCallback({
      api,
      callbackId,
      parsedPayload,
      sanctionStore,
      adminStore,
      adminUserIds,
      userId,
    });
  }

  if (parsedPayload.action === 'list') {
    await answerCallback(
      api,
      callbackId,
      formatAdminsMessage(adminUserIds, adminStore, { links: true }),
      { updateMessage: true, format: 'markdown' },
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

  await answerCallback(
    api,
    callbackId,
    formatAdminCommandResult(result, adminStore, { links: true }),
    { updateMessage: true, format: 'markdown' },
  );

  return {
    action: 'command',
    command: `callback:${parsedPayload.action}`,
    userId,
    noticeSent: true,
  };
}

async function handleSanctionCallback({
  api,
  callbackId,
  parsedPayload,
  sanctionStore,
  adminStore,
  adminUserIds,
  userId,
}) {
  if (!sanctionStore) {
    await answerCallback(api, callbackId, 'Хранилище санкций не подключено.');
    return {
      action: 'command',
      command: `callback:sanction:${parsedPayload.action}`,
      userId,
      noticeSent: true,
    };
  }

  let text;
  if (parsedPayload.action === 'list') {
    text = formatBansMessage({
      chatId: parsedPayload.chatId,
      sanctionStore,
      adminStore,
      links: true,
    });
  } else if (parsedPayload.action === 'unban') {
    const result = sanctionStore.liftBan({
      chatId: parsedPayload.chatId,
      userId: parsedPayload.userId,
      moderatorUserId: userId,
    });
    text = formatUnbanResult(result, adminStore, { links: true });
  } else {
    if (isAdmin(parsedPayload.userId, adminUserIds, adminStore)) {
      const text = 'Администраторов бота нельзя отправить в soft-ban.';
      await answerCallback(api, callbackId, text, {
        updateMessage: true,
        format: 'markdown',
      });
      return {
        action: 'command',
        command: `callback:sanction:${parsedPayload.action}`,
        userId,
        noticeSent: true,
      };
    }

    const duration = BAN_DURATIONS[parsedPayload.duration];
    const result = sanctionStore.setBan({
      chatId: parsedPayload.chatId,
      userId: parsedPayload.userId,
      durationMs: duration?.durationMs,
      moderatorUserId: userId,
      reason: 'manual-button',
    });
    text = formatBanResult(result, adminStore, { links: true });
  }

  await answerCallback(api, callbackId, text, {
    updateMessage: true,
    format: 'markdown',
  });

  return {
    action: 'command',
    command: `callback:sanction:${parsedPayload.action}`,
    userId,
    noticeSent: true,
  };
}

async function answerCallback(
  api,
  callbackId,
  text,
  { updateMessage = false, format } = {},
) {
  await api.answerCallback(callbackId, {
    notification: stripMarkdownLinks(text),
    ...(updateMessage
      ? { message: { text, ...(format ? { format } : {}) } }
      : {}),
  });
}

function rememberKnownUser(adminStore, profile) {
  adminStore?.upsertKnownUser?.(profile);
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

async function maybeHandleCommand({
  api,
  text,
  chatId,
  userId,
  dictionaryStore,
  adminStore,
  sanctionStore,
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
    '/ban',
    '/unban',
    '/bans',
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
      text: formatHelpMessage(),
    });
    return { handled: true, command, noticeSent: true };
  }

  if (command === '/admins') {
    await sendReply({
      api,
      chatId,
      userId,
      text: formatAdminsMessage(adminUserIds, adminStore, { links: true }),
      extra: { format: 'markdown' },
    });
    return { handled: true, command, noticeSent: true };
  }

  if (['/ban', '/unban', '/bans'].includes(command)) {
    const result = await maybeHandleSanctionCommand({
      api,
      command,
      argument,
      chatId,
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

async function maybeHandleSanctionCommand({
  api,
  command,
  argument,
  chatId,
  userId,
  sanctionStore,
  adminStore,
  adminUserIds,
}) {
  if (!chatId) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Soft-ban работает по конкретному чату. Используйте команду в нужной группе.',
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
      extra: { format: 'markdown' },
    });
    return { noticeSent: true };
  }

  const [rawUserId, rawDuration, ...reasonParts] = argument.split(/\s+/u);
  if (!rawUserId) {
    await sendReply({
      api,
      chatId,
      userId,
      text:
        command === '/ban'
          ? 'Формат: /ban user_id 30m|1d|7d|forever'
          : 'Формат: /unban user_id',
    });
    return { noticeSent: true };
  }

  if (command === '/unban') {
    const result = sanctionStore.liftBan({
      chatId,
      userId: rawUserId,
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

  const duration = parseBanDuration(rawDuration);
  if (!duration) {
    await sendReply({
      api,
      chatId,
      userId,
      text: 'Срок бана не распознан. Доступно: 30m, 1d, 7d, forever.',
    });
    return { noticeSent: true };
  }

  if (isAdmin(rawUserId, adminUserIds, adminStore)) {
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
    userId: rawUserId,
    durationMs: duration.durationMs,
    moderatorUserId: userId,
    reason: reasonParts.join(' ') || 'manual-command',
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
    text: formatContactAdminMessage(contact, { links: true, chatId }),
    extra: {
      format: 'markdown',
      attachments: [buildContactActionKeyboard(contact.userId, chatId)],
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

  if (!chatId) {
    lines.push('Soft-ban работает по конкретному чату. Для бана отправьте контакт в нужной группе.');
  }

  return lines.join('\n');
}

function buildContactActionKeyboard(userId, chatId) {
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

  if (chatId) {
    buttons.push(
      [
        {
          type: 'callback',
          text: 'Бан 30 минут',
          payload: `sanction:ban:${chatId}:${userId}:30m`,
        },
      ],
      [
        {
          type: 'callback',
          text: 'Бан 1 день',
          payload: `sanction:ban:${chatId}:${userId}:1d`,
        },
      ],
      [
        {
          type: 'callback',
          text: 'Бан 7 дней',
          payload: `sanction:ban:${chatId}:${userId}:7d`,
        },
      ],
      [
        {
          type: 'callback',
          text: 'Бан навсегда',
          payload: `sanction:ban:${chatId}:${userId}:forever`,
        },
      ],
      [
        {
          type: 'callback',
          text: 'Снять бан',
          payload: `sanction:unban:${chatId}:${userId}`,
        },
      ],
      [
        {
          type: 'callback',
          text: 'Показать баны',
          payload: `sanction:list:${chatId}`,
        },
      ],
    );
  }

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

function formatHelpMessage() {
  return [
    'Команды модератора',
    '',
    'Быстро',
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
    'Soft-ban в текущем чате',
    '  /ban user_id 30m — бан на 30 минут',
    '  /ban user_id 1d — бан на 1 день',
    '  /ban user_id 7d — бан на 7 дней',
    '  /ban user_id forever — бан до снятия',
    '  /unban user_id — снять soft-ban',
    '  /bans — показать активные soft-ban',
    '',
    'Через контакт',
    '  Отправьте контакт пользователя в нужную группу.',
    '  Бот покажет user_id, админ-кнопки и кнопки soft-ban.',
    '',
    'В ЛС бот отвечает только администраторам. Для остальных доступна только /id.',
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

function formatUserMention(userId, name) {
  if (!name) return '';
  return `[${escapeMarkdownLinkText(name)}](max://user/${userId})`;
}

function getStoredProfileName(profile = {}) {
  if (profile.name) return profile.name;
  return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
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
  return BAN_DURATIONS[key] ? { key, ...BAN_DURATIONS[key] } : null;
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
