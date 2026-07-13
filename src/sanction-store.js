import fs from 'node:fs';
import path from 'node:path';

const EMPTY_SANCTIONS = {
  bans: [],
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

  function readSanctions() {
    ensureFile();
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content || '{}');

    return {
      bans: normalizeBans(parsed.bans),
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

function parseUserId(value) {
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

