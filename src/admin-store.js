import fs from 'node:fs';
import path from 'node:path';

const EMPTY_ADMINS = {
  adminUserIds: [],
  knownUsers: {},
};

export function createAdminStore(filePath) {
  const absolutePath = path.resolve(filePath);

  function list() {
    return readAdmins();
  }

  function addAdmin(userId, profile = {}) {
    const parsedUserId = parseUserId(userId);
    if (!parsedUserId) {
      return { changed: false, reason: 'invalid-user-id', userId };
    }

    const admins = readAdmins();
    admins.knownUsers = mergeKnownUser(admins.knownUsers, {
      ...profile,
      userId: parsedUserId,
    });

    if (admins.adminUserIds.includes(parsedUserId)) {
      writeAdmins(admins);
      return { changed: false, reason: 'already-exists', userId: parsedUserId };
    }

    admins.adminUserIds.push(parsedUserId);
    admins.adminUserIds.sort((left, right) => left - right);
    writeAdmins(admins);
    return { changed: true, userId: parsedUserId };
  }

  function removeAdmin(userId) {
    const parsedUserId = parseUserId(userId);
    if (!parsedUserId) {
      return { changed: false, reason: 'invalid-user-id', userId };
    }

    const admins = readAdmins();
    const nextAdminUserIds = admins.adminUserIds.filter(
      (item) => item !== parsedUserId,
    );

    if (nextAdminUserIds.length === admins.adminUserIds.length) {
      return { changed: false, reason: 'not-found', userId: parsedUserId };
    }

    admins.adminUserIds = nextAdminUserIds;
    writeAdmins(admins);
    return { changed: true, userId: parsedUserId };
  }

  function upsertKnownUser(profile = {}) {
    const normalized = normalizeKnownUser(profile);
    if (!normalized) {
      return {
        changed: false,
        reason: 'invalid-user-id',
        userId: profile.userId,
      };
    }

    const admins = readAdmins();
    const key = String(normalized.userId);
    const previous = admins.knownUsers[key] || null;
    admins.knownUsers = mergeKnownUser(admins.knownUsers, normalized);
    const changed =
      JSON.stringify(previous) !== JSON.stringify(admins.knownUsers[key]);

    if (changed) {
      writeAdmins(admins);
    }

    return { changed, userId: normalized.userId };
  }

  function readAdmins() {
    ensureFile();
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content || '{}');

    return {
      adminUserIds: normalizeUserIds(parsed.adminUserIds),
      knownUsers: normalizeKnownUsers(parsed.knownUsers),
    };
  }

  function writeAdmins(admins) {
    fs.writeFileSync(
      absolutePath,
      `${JSON.stringify(admins, null, 2)}\n`,
      'utf8',
    );
  }

  function ensureFile() {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (!fs.existsSync(absolutePath)) {
      writeAdmins(EMPTY_ADMINS);
    }
  }

  return {
    filePath: absolutePath,
    list,
    addAdmin,
    removeAdmin,
    upsertKnownUser,
  };
}

function parseUserId(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeUserIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(parseUserId).filter(Boolean))].sort(
    (left, right) => left - right,
  );
}

function normalizeKnownUsers(value) {
  if (Array.isArray(value)) {
    return value.reduce(mergeKnownUser, {});
  }

  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.values(value).reduce(mergeKnownUser, {});
}

function mergeKnownUser(knownUsers, profile) {
  const normalized = normalizeKnownUser(profile);
  if (!normalized) {
    return knownUsers;
  }

  const key = String(normalized.userId);
  knownUsers[key] = {
    ...(knownUsers[key] || {}),
    ...normalized,
  };
  return knownUsers;
}

function normalizeKnownUser(profile = {}) {
  const userId = parseUserId(profile.userId ?? profile.user_id);
  if (!userId) {
    return null;
  }

  const name = normalizeText(profile.name);
  const firstName = normalizeText(profile.firstName ?? profile.first_name);
  const lastName = normalizeText(profile.lastName ?? profile.last_name);
  const username = normalizeUsername(profile.username);

  return {
    userId,
    ...(name ? { name } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(username ? { username } : {}),
  };
}

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function normalizeUsername(value) {
  return normalizeText(value).replace(/^@/u, '');
}
