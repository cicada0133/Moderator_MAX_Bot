import { describe, expect, it, vi } from 'vitest';

import { createModerator } from '../src/moderation.js';

describe('createModerator', () => {
  it('ignores profanity in direct messages', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      dryRun: true,
      notify: true,
      warningText: 'Нашёл "{token}", правило "{reason}", действие "{action}"',
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-1', text: 'ну это пиздец' },
      },
    });

    expect(result).toEqual({
      action: 'ignored',
      reason: 'private-non-admin',
      messageId: 'mid-1',
      userId: 123,
    });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessageToChat).not.toHaveBeenCalled();
    expect(api.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('ignores bot messages to avoid replying to itself', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      dryRun: true,
      notify: true,
      warningText: 'Нашёл "{token}"',
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 999, is_bot: true },
        recipient: { chat_id: 456 },
        body: { mid: 'mid-2', text: 'пиздец' },
      },
    });

    expect(result).toEqual({ action: 'ignored', reason: 'bot-message' });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessageToChat).not.toHaveBeenCalled();
    expect(api.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('reports user id without admin access', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      dryRun: true,
      notify: true,
      warningText: 'Нашёл "{token}"',
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-3', text: '/id' },
      },
    });

    expect(result.action).toBe('command');
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      'Ваш MAX user_id: 123',
      { notify: false },
    );
  });

  it('silently ignores non-admin commands in direct messages except id', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminUserIds: [999],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-private-help', text: '/help' },
      },
    });

    expect(result).toEqual({
      action: 'command',
      command: '/help',
      messageId: 'mid-private-help',
      chatId: null,
      userId: 123,
      noticeSent: false,
    });
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessageToChat).not.toHaveBeenCalled();
    expect(api.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('ignores direct contacts from non-admin users', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminUserIds: [999],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: {
          mid: 'mid-private-contact',
          attachments: [
            {
              type: 'contact',
              payload: {
                max_info: {
                  user_id: 456,
                  name: 'Павел',
                },
              },
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      action: 'ignored',
      reason: 'private-non-admin',
      messageId: 'mid-private-contact',
      userId: 123,
    });
    expect(api.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('lets configured admins add custom bad words', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const dictionaryStore = {
      list: vi.fn(() => ({ badWords: [], allowWords: [] })),
      addBadWord: vi.fn(() => ({
        changed: true,
        word: 'спамслово',
        normalized: 'спамслово',
      })),
    };
    const moderator = createModerator({
      api,
      dictionaryStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-4', text: '/banword спамслово' },
      },
    });

    expect(result.action).toBe('command');
    expect(dictionaryStore.addBadWord).toHaveBeenCalledWith('спамслово');
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      'Добавлено в раздел "банлист": спамслово',
      { notify: false },
    );
  });

  it('lets configured admins add runtime admins', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
      addAdmin: vi.fn(() => ({
        changed: true,
        userId: 456,
      })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-admin-1', text: '/addadmin 456' },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.addAdmin).toHaveBeenCalledWith(456);
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      'Администратор добавлен: 456',
      { notify: false },
    );
  });

  it('does not duplicate base env admins when adding admins', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
      addAdmin: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123, 456],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-admin-base-add', text: '/addadmin 456' },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.addAdmin).not.toHaveBeenCalled();
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      'Администратор 456 уже задан в BOT_ADMIN_IDS. Дополнительно добавлять его не нужно.',
      { notify: false },
    );
  });

  it('lets runtime admins use admin commands without restart', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [456] })),
    };
    const dictionaryStore = {
      list: vi.fn(() => ({ badWords: [], allowWords: [] })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      dictionaryStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 456, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-admin-2', text: '/badwords' },
      },
    });

    expect(result.action).toBe('command');
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      456,
      expect.stringContaining('Пользовательский банлист: пусто'),
      { notify: false },
    );
  });

  it('shows known names and usernames in the admins list', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({
        adminUserIds: [456],
        knownUsers: {
          123: { userId: 123, name: 'Мария', username: 'maria' },
          456: { userId: 456, name: 'Павел Лебединский' },
        },
      })),
      upsertKnownUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 123,
          name: 'Мария',
          username: 'maria',
          is_bot: false,
        },
        recipient: { chat_id: null },
        body: { mid: 'mid-admin-list-known', text: '/admins' },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.upsertKnownUser).toHaveBeenCalledWith({
      userId: 123,
      name: 'Мария',
      firstName: '',
      lastName: '',
      username: 'maria',
    });
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      [
        'Администраторы бота:',
        '- Мария (@maria, 123)',
        '- Павел Лебединский (456)',
        '',
        'Из .env:',
        '- Мария (@maria, 123)',
        '',
        'Добавлены командами:',
        '- Павел Лебединский (456)',
      ].join('\n'),
      { notify: false },
    );
  });

  it('extracts MAX user id from contact cards and offers admin buttons', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
      upsertKnownUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: {
          mid: 'mid-contact-1',
          attachments: [
            {
              type: 'contact',
              payload: {
                max_info: {
                  user_id: 456,
                  name: 'Павел',
                },
              },
            },
          ],
        },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.upsertKnownUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 456,
        name: 'Павел',
      }),
    );
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('MAX user_id: 456'),
      {
        notify: false,
        attachments: [
          expect.objectContaining({
            type: 'inline_keyboard',
            payload: expect.objectContaining({
              buttons: expect.arrayContaining([
                [
                  expect.objectContaining({
                    type: 'callback',
                    payload: 'admin:add:456',
                  }),
                ],
              ]),
            }),
          }),
        ],
      },
    );
  });

  it('explains when a contact card has no MAX user id', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: {
          mid: 'mid-contact-2',
          attachments: [
            {
              type: 'contact',
              payload: {
                vcf_info: 'BEGIN:VCARD\nFN:Павел\nEND:VCARD',
              },
            },
          ],
        },
      },
    });

    expect(result.action).toBe('command');
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('MAX user_id в карточке не нашёл.'),
      { notify: false },
    );
  });

  it('lets admins add users from contact callback buttons', async () => {
    const api = {
      answerCallback: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
      addAdmin: vi.fn(() => ({
        changed: true,
        userId: 456,
      })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-1',
        payload: 'admin:add:456',
        user: { user_id: 123 },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.addAdmin).toHaveBeenCalledWith(456);
    expect(api.answerCallback).toHaveBeenCalledWith('callback-1', {
      notification: 'Администратор добавлен: 456',
      message: { text: 'Администратор добавлен: 456' },
    });
  });

  it('rejects contact callback buttons from non-admin users', async () => {
    const api = {
      answerCallback: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
      addAdmin: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-2',
        payload: 'admin:add:456',
        user: { user_id: 789 },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.addAdmin).not.toHaveBeenCalled();
    expect(api.answerCallback).toHaveBeenCalledWith('callback-2', {
      notification: 'Эта кнопка доступна только администратору бота.',
    });
  });

  it('does not remove base env admins through chat commands', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [456] })),
      removeAdmin: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 456, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-admin-3', text: '/removeadmin 123' },
      },
    });

    expect(result.action).toBe('command');
    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      456,
      'Администратор 123 задан в BOT_ADMIN_IDS. Его нельзя удалить командой, только через .env.',
      { notify: false },
    );
  });

  it('uses runtime dictionary words during moderation', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const dictionaryStore = {
      list: vi.fn(() => ({ badWords: ['спамслово'], allowWords: [] })),
    };
    const moderator = createModerator({
      api,
      dictionaryStore,
      dryRun: true,
      notify: true,
      warningText: 'Нашёл "{token}"',
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: 456 },
        body: { mid: 'mid-5', text: 'это спамслово' },
      },
    });

    expect(result.action).toBe('would-delete');
    expect(result.reason).toBe('custom-word');
    expect(api.sendMessageToChat).toHaveBeenCalledWith(
      456,
      'Нашёл "спамслово"',
      { notify: false },
    );
  });

  it('deletes profane chat messages and notifies the sender by display name', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      dryRun: false,
      notify: true,
      warningText:
        '{user}, ваше сообщение удалено: в чате запрещена ненормативная лексика.',
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 123,
          name: 'Мария',
          username: 'maria',
          is_bot: false,
        },
        recipient: { chat_id: 456 },
        body: { mid: 'mid-6', text: 'ну это пиздец' },
      },
    });

    expect(result.action).toBe('deleted');
    expect(result.userName).toBe('Мария');
    expect(api.deleteMessage).toHaveBeenCalledWith('mid-6');
    expect(api.sendMessageToChat).toHaveBeenCalledWith(
      456,
      'Мария, ваше сообщение удалено: в чате запрещена ненормативная лексика.',
      { notify: false },
    );
    expect(api.sendMessageToUser).not.toHaveBeenCalled();
  });
});
