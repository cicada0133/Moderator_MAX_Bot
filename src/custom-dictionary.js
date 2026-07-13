import fs from 'node:fs';
import path from 'node:path';

import { normalizeFragment } from './profanity.js';

const EMPTY_DICTIONARY = {
  badWords: [],
  allowWords: [],
};

export function createCustomDictionaryStore(filePath) {
  const absolutePath = path.resolve(filePath);

  function list() {
    return readDictionary();
  }

  function addBadWord(word) {
    return addWord('badWords', word);
  }

  function removeBadWord(word) {
    return removeWord('badWords', word);
  }

  function addAllowWord(word) {
    return addWord('allowWords', word);
  }

  function removeAllowWord(word) {
    return removeWord('allowWords', word);
  }

  function addWord(key, word) {
    const entry = normalizeEntry(word);
    const dictionary = readDictionary();
    const exists = dictionary[key].some(
      (item) => normalizeFragment(item) === entry.normalized,
    );

    if (!entry.normalized) {
      return { changed: false, reason: 'empty-word', ...entry };
    }

    if (exists) {
      return { changed: false, reason: 'already-exists', ...entry };
    }

    dictionary[key].push(entry.word);
    dictionary[key].sort((left, right) => left.localeCompare(right, 'ru'));
    writeDictionary(dictionary);
    return { changed: true, ...entry };
  }

  function removeWord(key, word) {
    const entry = normalizeEntry(word);
    const dictionary = readDictionary();
    const nextWords = dictionary[key].filter(
      (item) => normalizeFragment(item) !== entry.normalized,
    );

    if (nextWords.length === dictionary[key].length) {
      return { changed: false, reason: 'not-found', ...entry };
    }

    dictionary[key] = nextWords;
    writeDictionary(dictionary);
    return { changed: true, ...entry };
  }

  function readDictionary() {
    ensureFile();
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content || '{}');

    return {
      badWords: normalizeArray(parsed.badWords),
      allowWords: normalizeArray(parsed.allowWords),
    };
  }

  function writeDictionary(dictionary) {
    fs.writeFileSync(
      absolutePath,
      `${JSON.stringify(dictionary, null, 2)}\n`,
      'utf8',
    );
  }

  function ensureFile() {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (!fs.existsSync(absolutePath)) {
      writeDictionary(EMPTY_DICTIONARY);
    }
  }

  return {
    filePath: absolutePath,
    list,
    addBadWord,
    removeBadWord,
    addAllowWord,
    removeAllowWord,
  };
}

function normalizeEntry(word) {
  const value = String(word || '').trim().toLowerCase();
  return {
    word: value,
    normalized: normalizeFragment(value),
  };
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}
