import fs from 'node:fs';
import path from 'node:path';

const EMPTY_SANCTIONS = {
  bans: [],
  autoBanSettings: [],
  violations: [],
};

export function createSanctionStore(filePath) {
  const absolutePath = path.resolve(filePath);

  function listActiveBans(chatId, { now = new Date() } = {}) {
    const sanctions = readSanctions();
    return sanctions.bans
      .filter((ban) => String(ban.chatId) === String(chatId))
      .filter((ban) => isActiveBan(ban, now))
      .sort(compareBans);
  }

  function getActiveBan({ chatId, userId, now = new Date() }) {
    const sanctions = readSanctions();
    return (
      sanctions.bans.find(
        (ban) =>
          String(ban.chatId) === String(chatId) &&
          ban.userId === parseUserId(userId) &&
          isActiveBan(ban, now),
      ) || null
    );
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

    const sanctions = readSanctions();
    const existing = sanctions.bans.find(
      (ban) =>
        String(ban.chatId) === String(normalized.chatId) &&
        ban.userId === normalized.userId &&
        isActiveBan(ban, now),
    );

    if (existing) {
      existing.createdAt = normalized.createdAt;
      existing.expiresAt = normalized.expiresAt;
      existing.moderatorUserId = normalized.moderatorUserId;
      existing.reason = normalized.reason;
      existing.liftedAt = null;
      existing.liftedByUserId = null;
      writeSanctions(sanctions);
      return { changed: true, action: 'updated', ban: existing };
    }

    sanctions.bans.push(normalized);
    writeSanctions(sanctions);
    return { changed: true, action: 'created', ban: normalized };
  }

  function liftBan({ chatId, userId, moderatorUserId, now = new Date() }) {
    const parsedUserId = parseUserId(userId);
    if (!chatId || !parsedUserId) {
      return { changed: false, reason: 'invalid-ban-input', userId };
    }

    const sanctions = readSanctions();
    const ban = sanctions.bans.find(
      (item) =>
        String(item.chatId) === String(chatId) &&
        item.userId === parsedUserId &&
        isActiveBan(item, now),
    );

    if (!ban) {
      return { changed: false, reason: 'not-found', userId: parsedUserId };
    }

    ban.liftedAt = now.toISOString();
    ban.liftedByUserId = parseUserId(moderatorUserId);
    writeSanctions(sanctions);
    return { changed: true, ban };
  }

  function getAutoBanSettings(chatId, defaults = {}) {
    const sanctions = readSanctions();
    const stored = sanctions.autoBanSettings.find(
      (item) => String(item.chatId) === String(chatId),
    );

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

    const sanctions = readSanctions();
    const existing = sanctions.autoBanSettings.find(
      (item) => String(item.chatId) === String(normalized.chatId),
    );
    if (existing) {
      Object.assign(existing, normalized);
    } else {
      sanctions.autoBanSettings.push(normalized);
    }

    writeSanctions(sanctions);
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

    const sanctions = readSanctions();
    const cutoffMs = now.getTime() - normalizedWindowMinutes * 60 * 1000;
    let record = sanctions.violations.find(
      (item) =>
        String(item.chatId) === String(chatId) && item.userId === parsedUserId,
    );
    if (!record) {
      record = {
        chatId,
        userId: parsedUserId,
        timestamps: [],
        updatedAt: now.toISOString(),
      };
      sanctions.violations.push(record);
    }

    record.timestamps = record.timestamps
      .map((value) => normalizeDate(value))
      .filter(Boolean)
      .filter((value) => new Date(value).getTime() >= cutoffMs);
    record.timestamps.push(now.toISOString());
    record.updatedAt = now.toISOString();

    writeSanctions(sanctions);
    return {
      changed: true,
      chatId,
      userId: parsedUserId,
      count: record.timestamps.length,
      timestamps: record.timestamps,
    };
  }

  function clearViolations({ chatId, userId }) {
    const parsedUserId = parseUserId(userId);
    if (!chatId || !parsedUserId) {
      return { changed: false, reason: 'invalid-violation-input' };
    }

    const sanctions = readSanctions();
    const before = sanctions.violations.length;
    sanctions.violations = sanctions.violations.filter(
      (item) =>
        !(
          String(item.chatId) === String(chatId) &&
          item.userId === parsedUserId
        ),
    );

    if (sanctions.violations.length === before) {
      return { changed: false, reason: 'not-found' };
    }

    writeSanctions(sanctions);
    return { changed: true };
  }

  function readSanctions() {
    ensureFile();
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content || '{}');

    return {
      bans: normalizeBans(parsed.bans),
      autoBanSettings: normalizeAutoBanSettingsList(parsed.autoBanSettings),
      violations: normalizeViolations(parsed.violations),
    };
  }

  function writeSanctions(sanctions) {
    fs.writeFileSync(
      absolutePath,
      `${JSON.stringify(sanctions, null, 2)}\n`,
      'utf8',
    );
  }

  function ensureFile() {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (!fs.existsSync(absolutePath)) {
      writeSanctions(EMPTY_SANCTIONS);
    }
  }

  return {
    filePath: absolutePath,
    listActiveBans,
    getActiveBan,
    setBan,
    liftBan,
    getAutoBanSettings,
    setAutoBanSettings,
    recordViolation,
    clearViolations,
  };
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
  return value
    .map((item) => normalizeAutoBanSettings(item))
    .filter(Boolean)
    .sort((left, right) => String(left.chatId).localeCompare(String(right.chatId)));
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

function isActiveBan(ban, now = new Date()) {
  if (!ban || ban.liftedAt) return false;
  if (!ban.expiresAt) return true;
  return new Date(ban.expiresAt).getTime() > now.getTime();
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
