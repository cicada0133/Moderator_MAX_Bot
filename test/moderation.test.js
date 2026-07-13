import { describe, expect, it, vi } from 'vitest';

import { createModerator } from '../src/moderation.js';

describe('createModerator', () => {
  it('answers in direct messages during dry run without deleting', async () => {
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

    expect(result.action).toBe('would-delete');
    expect(result.noticeSent).toBe(true);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    expect(api.sendMessageToChat).not.toHaveBeenCalled();
    expect(api.sendMessageToUser).toHaveBeenCalledWith(
      123,
      'Нашёл "пиздец", правило "dictionary", действие "would-delete"',
      { notify: false },
    );
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
});
