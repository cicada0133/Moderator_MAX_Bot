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

  it('stores auto-ban settings and prunes old violation hits', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-sanctions-'));
    const store = createSanctionStore(path.join(directory, 'sanctions.json'));
    const now = new Date('2026-07-13T12:00:00.000Z');

    const settings = store.setAutoBanSettings({
      chatId: 100,
      enabled: true,
      threshold: 2,
      windowMinutes: 10,
      durationMinutes: 30,
      moderatorUserId: 1,
      now,
    });

    expect(settings).toEqual(
      expect.objectContaining({
        changed: true,
        settings: expect.objectContaining({
          chatId: 100,
          enabled: true,
          threshold: 2,
          windowMinutes: 10,
          durationMinutes: 30,
        }),
      }),
    );
    expect(store.getAutoBanSettings(100, { enabled: false })).toEqual(
      expect.objectContaining({ enabled: true, threshold: 2 }),
    );

    store.recordViolation({
      chatId: 100,
      userId: 200,
      windowMinutes: 10,
      now: new Date('2026-07-13T11:45:00.000Z'),
    });
    const freshHit = store.recordViolation({
      chatId: 100,
      userId: 200,
      windowMinutes: 10,
      now,
    });

    expect(freshHit.count).toBe(1);
    expect(freshHit.timestamps).toEqual(['2026-07-13T12:00:00.000Z']);
  });

  it('keeps one auto-ban setting per chat when normalizing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-sanctions-'));
    const filePath = path.join(directory, 'sanctions.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          bans: [],
          autoBanSettings: [
            {
              chatId: 100,
              enabled: true,
              threshold: 2,
              windowMinutes: 5,
              durationMinutes: 10,
            },
            {
              chatId: 100,
              enabled: true,
              threshold: 3,
              windowMinutes: 10,
              durationMinutes: 30,
            },
          ],
          violations: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const store = createSanctionStore(filePath);

    expect(store.getAutoBanSettings(100, { enabled: false })).toEqual(
      expect.objectContaining({
        enabled: true,
        threshold: 3,
        windowMinutes: 10,
        durationMinutes: 30,
      }),
    );
  });
});
