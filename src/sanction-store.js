import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const EMPTY_SANCTIONS = {
  bans: [],
  autoBanSettings: [],
  violations: [],
};

export function createSanctionStore(filePath) {
  const { dbPath, legacyJsonPath } = resolveStorePaths(filePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  migrateLegacyJsonIfNeeded(db, legacyJsonPath);

  function listActiveBans(chatId, { now = new Date() } = {}) {
    const rows = db
      .prepare(
        `
        SELECT *
        FROM bans
        WHERE chat_id = @chatId
          AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > @now)
        ORDER BY
          CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
          expires_at ASC,
          user_id ASC
        `,
      )
      .all({
        chatId: normalizeChatId(chatId),
        now: now.toISOString(),
      });

    return rows.map(rowToBan);
  }

  function getActiveBan({ chatId, userId, now = new Date() }) {
    const parsedUserId = parseUserId(userId);
    if (!chatId || !parsedUserId) {
      return null;
    }

    const row = db
      .prepare(
        `
        SELECT *
        FROM bans
        WHERE chat_id = @chatId
          AND user_id = @userId
          AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > @now)
        ORDER BY
          CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END,
          expires_at ASC,
          id ASC
        LIMIT 1
        `,
      )
      .get({
        chatId: normalizeChatId(chatId),
        userId: parsedUserId,
        now: now.toISOString(),
      });

    return row ? rowToBan(row) : null;
  }

  function setBan({
    chatId,
    userId,
    durationMs,
    moderatorUserId,
    reason = '',
    now = new Date(),
  }) {
    const normalized = normalizeBanInput({
      chatId,
      userId,
      durationMs,
      moderatorUserId,
      reason,
      now,
    });
    if (!normalized) {
      return { changed: false, reason: 'invalid-ban-input' };
    }

    const existing = db
      .prepare(
        `
        SELECT *
        FROM bans
        WHERE chat_id = @chatId
          AND user_id = @userId
          AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > @now)
        ORDER BY id ASC
        LIMIT 1
        `,
      )
      .get({
        chatId: normalizeChatId(normalized.chatId),
        userId: normalized.userId,
        now: now.toISOString(),
      });

    if (existing) {
      db.prepare(
        `
        UPDATE bans
        SET created_at = @createdAt,
            expires_at = @expiresAt,
            moderator_user_id = @moderatorUserId,
            reason = @reason,
            lifted_at = NULL,
            lifted_by_user_id = NULL
        WHERE id = @id
        `,
      ).run({
        id: existing.id,
        createdAt: normalized.createdAt,
        expiresAt: normalized.expiresAt,
        moderatorUserId: normalized.moderatorUserId,
        reason: normalized.reason,
      });

      return {
        changed: true,
        action: 'updated',
        ban: rowToBan({ ...existing, ...banToRow(normalized), id: existing.id }),
      };
    }

    const info = db
      .prepare(
        `
        INSERT INTO bans (
          chat_id,
          user_id,
          moderator_user_id,
          reason,
          created_at,
          expires_at,
          lifted_at,
          lifted_by_user_id
        )
        VALUES (
          @chatId,
          @userId,
          @moderatorUserId,
          @reason,
          @createdAt,
          @expiresAt,
          @liftedAt,
          @liftedByUserId
        )
        `,
      )
      .run(banToRow(normalized));

    return {
      changed: true,
      action: 'created',
      ban: { ...normalized, id: Number(info.lastInsertRowid) },
    };
  }

  function liftBan({ chatId, userId, moderatorUserId, now = new Date() }) {
    const parsedUserId = parseUserId(userId);
    if (!chatId || !parsedUserId) {
      return { changed: false, reason: 'invalid-ban-input', userId };
    }

    const row = db
      .prepare(
        `
        SELECT *
        FROM bans
        WHERE chat_id = @chatId
          AND user_id = @userId
          AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > @now)
        ORDER BY id ASC
        LIMIT 1
        `,
      )
      .get({
        chatId: normalizeChatId(chatId),
        userId: parsedUserId,
        now: now.toISOString(),
      });

    if (!row) {
      return { changed: false, reason: 'not-found', userId: parsedUserId };
    }

    const liftedAt = now.toISOString();
    const liftedByUserId = parseUserId(moderatorUserId);
    db.prepare(
      `
      UPDATE bans
      SET lifted_at = @liftedAt,
          lifted_by_user_id = @liftedByUserId
      WHERE id = @id
      `,
    ).run({
      id: row.id,
      liftedAt,
      liftedByUserId,
    });

    return {
      changed: true,
      ban: rowToBan({
        ...row,
        lifted_at: liftedAt,
        lifted_by_user_id: liftedByUserId,
      }),
    };
  }

  function getAutoBanSettings(chatId, defaults = {}) {
    const row = db
      .prepare('SELECT * FROM auto_ban_settings WHERE chat_id = ?')
      .get(normalizeChatId(chatId));
    const stored = row ? rowToAutoBanSettings(row) : {};

    return normalizeAutoBanSettings({ ...defaults, ...stored, chatId });
  }

  function setAutoBanSettings({
    chatId,
    enabled,
    threshold,
    windowMinutes,
    durationMinutes,
    moderatorUserId,
    now = new Date(),
  }) {
    const normalized = normalizeAutoBanSettings({
      chatId,
      enabled,
      threshold,
      windowMinutes,
      durationMinutes,
      updatedByUserId: moderatorUserId,
      updatedAt: now.toISOString(),
    });
    if (!normalized) {
      return { changed: false, reason: 'invalid-auto-ban-settings' };
    }

    db.prepare(
      `
      INSERT INTO auto_ban_settings (
        chat_id,
        enabled,
        threshold,
        window_minutes,
        duration_minutes,
        updated_at,
        updated_by_user_id
      )
      VALUES (
        @chatId,
        @enabled,
        @threshold,
        @windowMinutes,
        @durationMinutes,
        @updatedAt,
        @updatedByUserId
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        enabled = excluded.enabled,
        threshold = excluded.threshold,
        window_minutes = excluded.window_minutes,
        duration_minutes = excluded.duration_minutes,
        updated_at = excluded.updated_at,
        updated_by_user_id = excluded.updated_by_user_id
      `,
    ).run(autoBanSettingsToRow(normalized));

    return { changed: true, settings: normalized };
  }

  function recordViolation({
    chatId,
    userId,
    windowMinutes,
    now = new Date(),
  }) {
    const parsedUserId = parseUserId(userId);
    const normalizedWindowMinutes = parsePositiveInteger(windowMinutes);
    if (!chatId || !parsedUserId || !normalizedWindowMinutes) {
      return { changed: false, reason: 'invalid-violation-input' };
    }

    const normalizedChatId = normalizeChatId(chatId);
    const cutoff = new Date(
      now.getTime() - normalizedWindowMinutes * 60 * 1000,
    ).toISOString();
    const createdAt = now.toISOString();

    const result = db.transaction(() => {
      db.prepare(
        `
        DELETE FROM violations
        WHERE chat_id = @chatId
          AND user_id = @userId
          AND created_at < @cutoff
        `,
      ).run({
        chatId: normalizedChatId,
        userId: parsedUserId,
        cutoff,
      });
      db.prepare(
        `
        INSERT INTO violations (chat_id, user_id, created_at)
        VALUES (@chatId, @userId, @createdAt)
        `,
      ).run({
        chatId: normalizedChatId,
        userId: parsedUserId,
        createdAt,
      });

      const timestamps = db
        .prepare(
          `
          SELECT created_at
          FROM violations
          WHERE chat_id = @chatId
            AND user_id = @userId
            AND created_at >= @cutoff
          ORDER BY created_at ASC
          `,
        )
        .all({
          chatId: normalizedChatId,
          userId: parsedUserId,
          cutoff,
        })
        .map((row) => row.created_at);

      return timestamps;
    })();

    return {
      changed: true,
      chatId,
      userId: parsedUserId,
      count: result.length,
      timestamps: result,
    };
  }

  function clearViolations({ chatId, userId }) {
    const parsedUserId = parseUserId(userId);
    if (!chatId || !parsedUserId) {
      return { changed: false, reason: 'invalid-violation-input' };
    }

    const info = db
      .prepare(
        `
        DELETE FROM violations
        WHERE chat_id = @chatId
          AND user_id = @userId
        `,
      )
      .run({
        chatId: normalizeChatId(chatId),
        userId: parsedUserId,
      });

    if (!info.changes) {
      return { changed: false, reason: 'not-found' };
    }

    return { changed: true };
  }

  return {
    filePath: dbPath,
    legacyJsonPath,
    listActiveBans,
    getActiveBan,
    setBan,
    liftBan,
    getAutoBanSettings,
    setAutoBanSettings,
    recordViolation,
    clearViolations,
    close: () => db.close(),
  };
}

function resolveStorePaths(filePath) {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);

  if (parsed.ext.toLowerCase() === '.json') {
    return {
      dbPath: path.join(parsed.dir, `${parsed.name}.sqlite`),
      legacyJsonPath: absolutePath,
    };
  }

  return {
    dbPath: absolutePath,
    legacyJsonPath: path.join(parsed.dir, `${parsed.name}.json`),
  };
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      moderator_user_id INTEGER,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      lifted_at TEXT,
      lifted_by_user_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_bans_active
      ON bans (chat_id, user_id, lifted_at, expires_at);

    CREATE TABLE IF NOT EXISTS auto_ban_settings (
      chat_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      window_minutes INTEGER NOT NULL,
      duration_minutes INTEGER NOT NULL,
      updated_at TEXT,
      updated_by_user_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_violations_lookup
      ON violations (chat_id, user_id, created_at);
  `);
}

function migrateLegacyJsonIfNeeded(db, legacyJsonPath) {
  if (!legacyJsonPath || !fs.existsSync(legacyJsonPath)) {
    return;
  }

  const hasData =
    db.prepare('SELECT COUNT(*) AS count FROM bans').get().count > 0 ||
    db.prepare('SELECT COUNT(*) AS count FROM auto_ban_settings').get().count >
      0 ||
    db.prepare('SELECT COUNT(*) AS count FROM violations').get().count > 0;
  if (hasData) {
    return;
  }

  const parsed = readLegacySanctions(legacyJsonPath);
  const bans = normalizeBans(parsed.bans);
  const autoBanSettings = normalizeAutoBanSettingsList(parsed.autoBanSettings);
  const violations = normalizeViolations(parsed.violations);

  db.transaction(() => {
    const insertBan = db.prepare(
      `
      INSERT INTO bans (
        chat_id,
        user_id,
        moderator_user_id,
        reason,
        created_at,
        expires_at,
        lifted_at,
        lifted_by_user_id
      )
      VALUES (
        @chatId,
        @userId,
        @moderatorUserId,
        @reason,
        @createdAt,
        @expiresAt,
        @liftedAt,
        @liftedByUserId
      )
      `,
    );
    for (const ban of bans) {
      insertBan.run(banToRow(ban));
    }

    const upsertSettings = db.prepare(
      `
      INSERT INTO auto_ban_settings (
        chat_id,
        enabled,
        threshold,
        window_minutes,
        duration_minutes,
        updated_at,
        updated_by_user_id
      )
      VALUES (
        @chatId,
        @enabled,
        @threshold,
        @windowMinutes,
        @durationMinutes,
        @updatedAt,
        @updatedByUserId
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        enabled = excluded.enabled,
        threshold = excluded.threshold,
        window_minutes = excluded.window_minutes,
        duration_minutes = excluded.duration_minutes,
        updated_at = excluded.updated_at,
        updated_by_user_id = excluded.updated_by_user_id
      `,
    );
    for (const settings of autoBanSettings) {
      upsertSettings.run(autoBanSettingsToRow(settings));
    }

    const insertViolation = db.prepare(
      `
      INSERT INTO violations (chat_id, user_id, created_at)
      VALUES (@chatId, @userId, @createdAt)
      `,
    );
    for (const violation of violations) {
      for (const timestamp of violation.timestamps) {
        insertViolation.run({
          chatId: normalizeChatId(violation.chatId),
          userId: violation.userId,
          createdAt: timestamp,
        });
      }
    }
  })();
}

function readLegacySanctions(legacyJsonPath) {
  try {
    const content = fs.readFileSync(legacyJsonPath, 'utf8');
    return JSON.parse(content || '{}');
  } catch {
    return EMPTY_SANCTIONS;
  }
}

function normalizeBanInput({
  chatId,
  userId,
  durationMs,
  moderatorUserId,
  reason,
  now,
}) {
  const parsedUserId = parseUserId(userId);
  const parsedModeratorUserId = parseUserId(moderatorUserId);
  if (!chatId || !parsedUserId) {
    return null;
  }

  const normalizedDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
  const expiresAt = normalizedDurationMs
    ? new Date(now.getTime() + normalizedDurationMs).toISOString()
    : null;

  return {
    chatId,
    userId: parsedUserId,
    moderatorUserId: parsedModeratorUserId,
    reason: normalizeText(reason),
    createdAt: now.toISOString(),
    expiresAt,
    liftedAt: null,
    liftedByUserId: null,
  };
}

function normalizeBans(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeBan(item))
    .filter(Boolean)
    .sort(compareBans);
}

function normalizeAutoBanSettingsList(value) {
  if (!Array.isArray(value)) return [];
  const settingsByChatId = new Map();
  for (const item of value) {
    const normalized = normalizeAutoBanSettings(item);
    if (normalized) {
      settingsByChatId.set(String(normalized.chatId), normalized);
    }
  }

  return [...settingsByChatId.values()].sort((left, right) =>
    String(left.chatId).localeCompare(String(right.chatId)),
  );
}

function normalizeAutoBanSettings(value = {}) {
  if (!value.chatId) {
    return null;
  }

  const threshold = parsePositiveInteger(value.threshold);
  const windowMinutes = parsePositiveInteger(value.windowMinutes);
  const durationMinutes = parsePositiveInteger(value.durationMinutes);
  if (!threshold || !windowMinutes || !durationMinutes) {
    return null;
  }

  return {
    chatId: value.chatId,
    enabled: Boolean(value.enabled),
    threshold,
    windowMinutes,
    durationMinutes,
    updatedAt: normalizeDate(value.updatedAt),
    updatedByUserId: parseUserId(value.updatedByUserId),
  };
}

function normalizeViolations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeViolation(item))
    .filter(Boolean)
    .sort(compareViolations);
}

function normalizeViolation(value = {}) {
  const userId = parseUserId(value.userId);
  if (!value.chatId || !userId) {
    return null;
  }

  const timestamps = Array.isArray(value.timestamps)
    ? value.timestamps.map((item) => normalizeDate(item)).filter(Boolean)
    : [];

  return {
    chatId: value.chatId,
    userId,
    timestamps,
    updatedAt: normalizeDate(value.updatedAt),
  };
}

function normalizeBan(value = {}) {
  const userId = parseUserId(value.userId ?? value.user_id);
  if (!value.chatId || !userId || !value.createdAt) {
    return null;
  }

  return {
    chatId: value.chatId,
    userId,
    moderatorUserId: parseUserId(value.moderatorUserId),
    reason: normalizeText(value.reason),
    createdAt: normalizeDate(value.createdAt) || new Date().toISOString(),
    expiresAt: normalizeDate(value.expiresAt),
    liftedAt: normalizeDate(value.liftedAt),
    liftedByUserId: parseUserId(value.liftedByUserId),
  };
}

function rowToBan(row) {
  return {
    id: row.id,
    chatId: parseChatId(row.chat_id),
    userId: row.user_id,
    moderatorUserId: row.moderator_user_id,
    reason: normalizeText(row.reason),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    liftedAt: row.lifted_at,
    liftedByUserId: row.lifted_by_user_id,
  };
}

function banToRow(ban) {
  return {
    chatId: normalizeChatId(ban.chatId),
    userId: ban.userId,
    moderatorUserId: ban.moderatorUserId,
    reason: ban.reason,
    createdAt: ban.createdAt,
    expiresAt: ban.expiresAt,
    liftedAt: ban.liftedAt,
    liftedByUserId: ban.liftedByUserId,
  };
}

function rowToAutoBanSettings(row) {
  return {
    chatId: parseChatId(row.chat_id),
    enabled: Boolean(row.enabled),
    threshold: row.threshold,
    windowMinutes: row.window_minutes,
    durationMinutes: row.duration_minutes,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  };
}

function autoBanSettingsToRow(settings) {
  return {
    chatId: normalizeChatId(settings.chatId),
    enabled: settings.enabled ? 1 : 0,
    threshold: settings.threshold,
    windowMinutes: settings.windowMinutes,
    durationMinutes: settings.durationMinutes,
    updatedAt: settings.updatedAt,
    updatedByUserId: settings.updatedByUserId,
  };
}

function compareBans(left, right) {
  const leftTime = left.expiresAt ? new Date(left.expiresAt).getTime() : Infinity;
  const rightTime = right.expiresAt
    ? new Date(right.expiresAt).getTime()
    : Infinity;
  return leftTime - rightTime || left.userId - right.userId;
}

function compareViolations(left, right) {
  return (
    String(left.chatId).localeCompare(String(right.chatId)) ||
    left.userId - right.userId
  );
}

function normalizeChatId(value) {
  return String(value ?? '').trim();
}

function parseChatId(value) {
  const normalized = normalizeChatId(value);
  if (/^-?\d+$/u.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  return normalized;
}

function parseUserId(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
