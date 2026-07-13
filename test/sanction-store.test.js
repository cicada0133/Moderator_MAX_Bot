import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSanctionStore } from '../src/sanction-store.js';

describe('createSanctionStore', () => {
  it('stores active soft bans per chat and user', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-sanctions-'));
    const store = createSanctionStore(path.join(directory, 'sanctions.json'));
    const now = new Date('2026-07-13T12:00:00.000Z');

    const result = store.setBan({
      chatId: 100,
      userId: 200,
      durationMs: 30 * 60 * 1000,
      moderatorUserId: 1,
      reason: 'test',
      now,
    });

    expect(result.changed).toBe(true);
    expect(store.getActiveBan({ chatId: 100, userId: 200, now })).toEqual(
      expect.objectContaining({
        chatId: 100,
        userId: 200,
        expiresAt: '2026-07-13T12:30:00.000Z',
      }),
    );
    expect(store.getActiveBan({ chatId: 101, userId: 200, now })).toBeNull();
    expect(
      store.getActiveBan({
        chatId: 100,
        userId: 200,
        now: new Date('2026-07-13T12:31:00.000Z'),
      }),
    ).toBeNull();
  });

  it('lifts active bans without losing history', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-sanctions-'));
    const store = createSanctionStore(path.join(directory, 'sanctions.json'));
    const now = new Date('2026-07-13T12:00:00.000Z');

    store.setBan({
      chatId: 100,
      userId: 200,
      durationMs: null,
      moderatorUserId: 1,
      now,
    });

    expect(
      store.liftBan({
        chatId: 100,
        userId: 200,
        moderatorUserId: 1,
        now: new Date('2026-07-13T12:05:00.000Z'),
      }),
    ).toEqual(
      expect.objectContaining({
        changed: true,
        ban: expect.objectContaining({
          liftedAt: '2026-07-13T12:05:00.000Z',
        }),
      }),
    );
    expect(store.listActiveBans(100, { now })).toEqual([]);
  });
});
