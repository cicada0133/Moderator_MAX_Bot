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

  it('shows grouped help for admins', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-help', text: '/help' },
      },
    });

    expect(result.action).toBe('command');
    const helpText = api.sendMessageToUser.mock.calls[0][1];
    expect(helpText).not.toContain('Быстро');
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Баны\n  /banhelp'),
      { notify: false },
    );
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Администраторы бота\n  /admins'),
      { notify: false },
    );
  });

  it('shows separate soft-ban help for admins', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: null },
        body: { mid: 'mid-banhelp', text: '/banhelp' },
      },
    });

    expect(result.action).toBe('command');
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Ответьте командой на сообщение того пользователя'),
      { notify: false },
    );
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Без суффикса число считается минутами, с d — днями.'),
      { notify: false },
    );
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('В ЛС бан не включается'),
      { notify: false },
    );
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      expect.stringContaining('Жёсткий бан администратор делает вручную'),
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
      { notify: false, format: 'markdown' },
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
      { notify: false, format: 'markdown' },
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
        '- [Мария](max://user/123) (@maria, 123)',
        '- [Павел Лебединский](max://user/456) (456)',
        '',
        'Из .env:',
        '- [Мария](max://user/123) (@maria, 123)',
        '',
        'Добавлены командами:',
        '- [Павел Лебединский](max://user/456) (456)',
      ].join('\n'),
      { notify: false, format: 'markdown' },
    );
  });

  it('lets admins create soft bans for the current chat', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({
        adminUserIds: [],
        knownUsers: {
          456: { userId: 456, name: 'Павел' },
        },
      })),
      upsertKnownUser: vi.fn(),
    };
    const sanctionStore = {
      setBan: vi.fn(() => ({
        changed: true,
        action: 'created',
        ban: {
          chatId: 777,
          userId: 456,
          expiresAt: '2026-07-13T12:30:00.000Z',
        },
      })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      sanctionStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: 777 },
        body: { mid: 'mid-ban-command', text: '/ban 456 30m' },
      },
    });

    expect(result.action).toBe('command');
    expect(sanctionStore.setBan).toHaveBeenCalledWith({
      chatId: 777,
      userId: '456',
      durationMs: 30 * 60 * 1000,
      moderatorUserId: 123,
      reason: 'manual-command',
    });
    expect(api.sendMessageToChat).toHaveBeenCalledWith(
      777,
      expect.stringContaining('Soft-ban включён'),
      { notify: false, format: 'markdown' },
    );
  });

  it('lets admins soft-ban linked message authors with minute shorthand', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({
        adminUserIds: [],
        knownUsers: {
          456: { userId: 456, name: 'Павел' },
        },
      })),
      upsertKnownUser: vi.fn(),
    };
    const sanctionStore = {
      setBan: vi.fn(() => ({
        changed: true,
        action: 'created',
        ban: {
          chatId: 777,
          userId: 456,
          expiresAt: '2026-07-13T12:30:00.000Z',
        },
      })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      sanctionStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: 777 },
        body: { mid: 'mid-linked-ban-command', text: '/ban 30' },
        link: {
          sender: {
            user_id: 456,
            name: 'Павел',
          },
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
    expect(sanctionStore.setBan).toHaveBeenCalledWith({
      chatId: 777,
      userId: 456,
      durationMs: 30 * 60 * 1000,
      moderatorUserId: 123,
      reason: 'linked-message-command',
    });
  });

  it('does not let admins soft-ban bot admins through commands', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const sanctionStore = {
      setBan: vi.fn(),
    };
    const moderator = createModerator({
      api,
      sanctionStore,
      adminUserIds: [123, 456],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 123, is_bot: false },
        recipient: { chat_id: 777 },
        body: { mid: 'mid-ban-admin-command', text: '/ban 456 30m' },
      },
    });

    expect(result.action).toBe('command');
    expect(sanctionStore.setBan).not.toHaveBeenCalled();
    expect(api.sendMessageToChat).toHaveBeenCalledWith(
      777,
      'Администраторов бота нельзя отправить в soft-ban.',
      { notify: false },
    );
  });

  it('deletes messages from soft-banned users only in the banned chat', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const sanctionStore = {
      getActiveBan: vi.fn(({ chatId }) =>
        chatId === 777 ? { chatId: 777, userId: 456, expiresAt: null } : null,
      ),
    };
    const moderator = createModerator({
      api,
      sanctionStore,
      adminUserIds: [123],
    });

    const bannedResult = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 456, is_bot: false },
        recipient: { chat_id: 777 },
        body: { mid: 'mid-soft-ban-1', text: 'обычный текст' },
      },
    });
    const otherChatResult = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: { user_id: 456, is_bot: false },
        recipient: { chat_id: 888 },
        body: { mid: 'mid-soft-ban-2', text: 'обычный текст' },
      },
    });

    expect(bannedResult.action).toBe('soft-ban-delete');
    expect(api.deleteMessage).toHaveBeenCalledWith('mid-soft-ban-1');
    expect(otherChatResult.action).toBe('allowed');
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('does not apply soft-ban to admins but still moderates their profanity', async () => {
    const api = {
      deleteMessage: vi.fn(),
      sendMessageToChat: vi.fn(),
      sendMessageToUser: vi.fn(),
    };
    const sanctionStore = {
      getActiveBan: vi.fn(() => ({
        chatId: 777,
        userId: 456,
        expiresAt: null,
      })),
    };
    const moderator = createModerator({
      api,
      sanctionStore,
      adminUserIds: [456],
      dryRun: false,
      notify: true,
      warningText:
        '{user}, ваше сообщение удалено: в чате запрещена ненормативная лексика.',
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 456,
          name: 'Мария',
          is_bot: false,
        },
        recipient: { chat_id: 777 },
        body: { mid: 'mid-admin-profanity', text: 'ну это пиздец' },
      },
    });

    expect(result.action).toBe('deleted');
    expect(result.reason).toBe('dictionary');
    expect(sanctionStore.getActiveBan).not.toHaveBeenCalled();
    expect(api.deleteMessage).toHaveBeenCalledWith('mid-admin-profanity');
    expect(api.sendMessageToChat).toHaveBeenCalledWith(
      777,
      'Мария, ваше сообщение удалено: в чате запрещена ненормативная лексика.',
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
        recipient: { chat_id: 777 },
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
    expect(api.sendMessageToChat).toHaveBeenCalledWith(
      777,
      expect.stringContaining('MAX user_id: 456'),
      expect.objectContaining({
        notify: false,
        format: 'markdown',
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
                [
                  expect.objectContaining({
                    type: 'callback',
                    payload: 'sanction:menu:777:456',
                  }),
                ],
              ]),
            }),
          }),
        ],
      }),
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
      message: { text: 'Администратор добавлен: 456', format: 'markdown' },
    });
  });

  it('opens a separate soft-ban menu from contact callback buttons', async () => {
    const api = {
      answerCallback: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({
        adminUserIds: [],
        knownUsers: {
          456: { userId: 456, name: 'Павел' },
        },
      })),
    };
    const sanctionStore = {
      setBan: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      sanctionStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-soft-ban-menu',
        payload: 'sanction:menu:777:456',
        user: { user_id: 123 },
      },
    });

    expect(result.action).toBe('command');
    expect(api.answerCallback).toHaveBeenCalledWith(
      'callback-soft-ban-menu',
      expect.objectContaining({
        notification: expect.stringContaining('Меню банов: Павел'),
        message: expect.objectContaining({
          format: 'markdown',
          text: expect.stringContaining('Меню банов: [Павел]'),
          attachments: [
            expect.objectContaining({
              type: 'inline_keyboard',
              payload: expect.objectContaining({
                buttons: expect.arrayContaining([
                  [
                    expect.objectContaining({
                      payload: 'sanction:ban:777:456:30m',
                    }),
                  ],
                  [
                    expect.objectContaining({
                      payload: 'sanction:unban:777:456',
                    }),
                  ],
                ]),
              }),
            }),
          ],
        }),
      }),
    );
  });

  it('lets admins create soft bans from contact callback buttons', async () => {
    const api = {
      answerCallback: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({
        adminUserIds: [],
        knownUsers: {
          456: { userId: 456, name: 'Павел' },
        },
      })),
    };
    const sanctionStore = {
      setBan: vi.fn(() => ({
        changed: true,
        action: 'created',
        ban: {
          chatId: '777',
          userId: 456,
          expiresAt: '2026-07-13T12:30:00.000Z',
        },
      })),
    };
    const moderator = createModerator({
      api,
      adminStore,
      sanctionStore,
      adminUserIds: [123],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-soft-ban',
        payload: 'sanction:ban:777:456:30m',
        user: { user_id: 123 },
      },
    });

    expect(result.action).toBe('command');
    expect(sanctionStore.setBan).toHaveBeenCalledWith({
      chatId: '777',
      userId: 456,
      durationMs: 30 * 60 * 1000,
      moderatorUserId: 123,
      reason: 'manual-button',
    });
    expect(api.answerCallback).toHaveBeenCalledWith(
      'callback-soft-ban',
      expect.objectContaining({
        notification: expect.stringContaining('Soft-ban включён'),
        message: expect.objectContaining({
          format: 'markdown',
          text: expect.stringContaining('Soft-ban включён'),
        }),
      }),
    );
  });

  it('does not let admins soft-ban bot admins from callback buttons', async () => {
    const api = {
      answerCallback: vi.fn(),
    };
    const adminStore = {
      list: vi.fn(() => ({ adminUserIds: [] })),
    };
    const sanctionStore = {
      setBan: vi.fn(),
    };
    const moderator = createModerator({
      api,
      adminStore,
      sanctionStore,
      adminUserIds: [123, 456],
    });

    const result = await moderator.handleUpdate({
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-soft-ban-admin',
        payload: 'sanction:ban:777:456:30m',
        user: { user_id: 123 },
      },
    });

    expect(result.action).toBe('command');
    expect(sanctionStore.setBan).not.toHaveBeenCalled();
    expect(api.answerCallback).toHaveBeenCalledWith(
      'callback-soft-ban-admin',
      expect.objectContaining({
        notification: 'Администраторов бота нельзя отправить в soft-ban.',
      }),
    );
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
      { notify: false, format: 'markdown' },
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
