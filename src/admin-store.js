import fs from 'node:fs';
import path from 'node:path';

const EMPTY_ADMINS = {
  adminUserIds: [],
};

export function createAdminStore(filePath) {
  const absolutePath = path.resolve(filePath);

  function list() {
    return readAdmins();
  }

  function addAdmin(userId) {
    const parsedUserId = parseUserId(userId);
    if (!parsedUserId) {
      return { changed: false, reason: 'invalid-user-id', userId };
    }

    const admins = readAdmins();
    if (admins.adminUserIds.includes(parsedUserId)) {
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

  function readAdmins() {
    ensureFile();
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content || '{}');

    return {
      adminUserIds: normalizeUserIds(parsed.adminUserIds),
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
