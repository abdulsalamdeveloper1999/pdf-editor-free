import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countMatches, replaceMatches } from './text.js';

test('count', () => {
  assert.equal(countMatches('a-a-A', 'a', true), 2);
  assert.equal(countMatches('a-a-A', 'a', false), 3);
  assert.equal(countMatches('aaa', 'aa', true), 1); // non-overlapping
  assert.equal(countMatches('abc', '', true), 0);
});

test('replace', () => {
  assert.equal(replaceMatches('a-a-A', 'a', 'X', true), 'X-X-A');
  assert.equal(replaceMatches('a-a-A', 'a', 'X', false), 'X-X-X');
  assert.equal(replaceMatches('Cat', 'cat', 'dog', false), 'dog'); // keeps replacement casing
  assert.equal(replaceMatches('aa', 'a', 'aa', true), 'aaaa');     // no infinite loop
  assert.equal(replaceMatches('abc', '', 'X', true), 'abc');
  assert.equal(replaceMatches('hello', 'l', '', true), 'heo');
});
