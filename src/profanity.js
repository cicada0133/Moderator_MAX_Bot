import russianBadWords from 'russian-bad-words';

const LOOKALIKE_MAP = new Map(
  Object.entries({
    a: 'а',
    b: 'б',
    d: 'д',
    e: 'е',
    l: 'л',
    o: 'о',
    p: 'р',
    c: 'с',
    x: 'х',
    y: 'у',
    u: 'у',
    k: 'к',
    m: 'м',
    t: 'т',
    h: 'н',
    0: 'о',
    3: 'з',
    4: 'ч',
    6: 'б',
    '@': 'а',
    '$': 'с',
  }),
);

const DEFAULT_RULES = [
  { label: 'х-мат', pattern: /х(?:у|y)[йиеяюли]/u },
  { label: 'п-мат', pattern: /п[ие]зд/u },
  { label: 'е-мат', pattern: /(?:^|[^а-я])(?:е|ё)[бп](?:а|и|у|л|н|с|т|ы|о|е|ё|я)/u },
  { label: 'б-мат', pattern: /бл(?:я|е)(?:д|т|ц)/u },
  { label: 'м-мат', pattern: /м[ао]нд/u },
  { label: 'залупа', pattern: /залуп/u },
  { label: 'гандон', pattern: /гандон/u },
  { label: 'д-мат', pattern: /д[оа]лб[оа](?:е|з)б/u },
  { label: 'мудак', pattern: /муд[ао](?:к|ч)/u },
  { label: 'пидор', pattern: /п[ие]д(?:а|о)?р/u },
];

const DICTIONARY_WORDS = new Set(
  russianBadWords.flatWords
    .map(normalizeFragment)
    .filter((word) => word.length >= 2),
);

export function getBuiltInBadWords() {
  return [...DICTIONARY_WORDS].sort((left, right) =>
    left.localeCompare(right, 'ru'),
  );
}

export function getBuiltInBadWordsCount() {
  return DICTIONARY_WORDS.size;
}

export function findProfanity(text, { customWords = [], allowWords = [] } = {}) {
  if (!text || typeof text !== 'string') {
    return { matched: false };
  }

  const tokens = tokenizeForModeration(text);
  const customFragments = customWords.map(normalizeFragment).filter(Boolean);
  const allowSet = new Set(allowWords.map(normalizeFragment).filter(Boolean));

  for (const token of tokens) {
    if (allowSet.has(token)) {
      continue;
    }

    if (DICTIONARY_WORDS.has(token)) {
      return { matched: true, reason: 'dictionary', token };
    }

    for (const rule of DEFAULT_RULES) {
      if (rule.pattern.test(token)) {
        return { matched: true, reason: rule.label, token };
      }
    }

    for (const customWord of customFragments) {
      if (token.includes(customWord)) {
        return { matched: true, reason: 'custom-word', token };
      }
    }
  }

  return { matched: false };
}

export function tokenizeForModeration(text) {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .split(/\s+/u)
    .map(normalizeFragment)
    .filter(Boolean);
}

export function normalizeFragment(value) {
  return Array.from(value.replaceAll('ё', 'е'))
    .map((char) => LOOKALIKE_MAP.get(char) || char)
    .join('')
    .replace(/[^а-я]/gu, '');
}
