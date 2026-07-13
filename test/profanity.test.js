import { describe, expect, it } from 'vitest';

import { findProfanity, tokenizeForModeration } from '../src/profanity.js';

describe('findProfanity', () => {
  it('detects common Russian profanity roots', () => {
    expect(findProfanity('ну это пиздец').matched).toBe(true);
    expect(findProfanity('совсем охуел').matched).toBe(true);
    expect(findProfanity('блять, хватит').matched).toBe(true);
    expect(findProfanity('долбоебом быть необязательно').matched).toBe(true);
  });

  it('detects punctuation and lookalike obfuscation inside a word', () => {
    expect(findProfanity('п.и.з.дец').matched).toBe(true);
    expect(findProfanity('xуeво').matched).toBe(true);
    expect(findProfanity('d0лб0еб').matched).toBe(true);
    expect(findProfanity('долбо3б').matched).toBe(true);
    expect(findProfanity('d0лб03б').matched).toBe(true);
  });

  it('does not flag normal words with similar letters', () => {
    expect(findProfanity('сделал домашнюю учебу').matched).toBe(false);
    expect(findProfanity('купить свежего хлеба').matched).toBe(false);
    expect(findProfanity('есть рабочая потребность').matched).toBe(false);
  });

  it('supports custom comma-separated fragments from config', () => {
    expect(
      findProfanity('это запрещенное слово', {
        customWords: ['запрещенное'],
      }).matched,
    ).toBe(true);
  });

  it('supports exact allow words', () => {
    expect(
      findProfanity('сука', {
        allowWords: ['сука'],
      }).matched,
    ).toBe(false);

    expect(
      findProfanity('сука пиздец', {
        allowWords: ['сука'],
      }).matched,
    ).toBe(true);
  });
});

describe('tokenizeForModeration', () => {
  it('normalizes lowercase text and simple latin lookalikes', () => {
    expect(tokenizeForModeration('XУEВО!')).toEqual(['хуево']);
    expect(tokenizeForModeration('d0лб03б')).toEqual(['долбозб']);
  });
});
