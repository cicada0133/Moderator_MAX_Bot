import {
  getBuiltInBadWords,
  getBuiltInBadWordsCount,
} from '../src/profanity.js';

const words = getBuiltInBadWords();

console.log(`Built-in dictionary words: ${getBuiltInBadWordsCount()}`);
console.log(words.join('\n'));
