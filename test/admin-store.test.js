import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdminStore } from '../src/admin-store.js';

describe('createAdminStore', () => {
  it('stores admins and known user profiles', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-admin-store-'));
    const store = createAdminStore(path.join(directory, 'admins.json'));

    expect(store.addAdmin(456, { name: 'Павел', username: '@pavel' })).toEqual({
      changed: true,
      userId: 456,
    });
    expect(store.upsertKnownUser({ userId: 123, name: 'Мария' })).toEqual({
      changed: true,
      userId: 123,
    });

    expect(store.list()).toEqual({
      adminUserIds: [456],
      knownUsers: {
        123: { userId: 123, name: 'Мария' },
        456: { userId: 456, name: 'Павел', username: 'pavel' },
      },
    });
  });

  it('removes runtime admins that are already configured in env', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-admin-store-'));
    const store = createAdminStore(path.join(directory, 'admins.json'));

    store.addAdmin(123, { name: 'Мария' });
    store.addAdmin(456, { name: 'Павел' });

    expect(store.pruneBaseAdmins([456, 789])).toEqual({
      changed: true,
      removedUserIds: [456],
      admins: {
        adminUserIds: [123],
        knownUsers: {
          123: { userId: 123, name: 'Мария' },
          456: { userId: 456, name: 'Павел' },
        },
      },
    });
    expect(store.list()).toEqual({
      adminUserIds: [123],
      knownUsers: {
        123: { userId: 123, name: 'Мария' },
        456: { userId: 456, name: 'Павел' },
      },
    });
  });
});
