import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trie } from '../src/core/trie.js';

test('matches a registered prefix for a deeper path', () => {
  const t = new Trie();
  t.insert('/users');
  const { matched, matchedPath } = t.matchPrefix('/users/123/profile');
  assert.equal(matched, true);
  assert.equal(matchedPath, '/users');
});

test('returns the longest matching prefix when nested prefixes exist', () => {
  const t = new Trie();
  t.insert('/a');
  t.insert('/a/b');
  assert.deepEqual(t.matchPrefix('/a/b/c'), { matched: true, matchedPath: '/a/b' });
  assert.deepEqual(t.matchPrefix('/a/x'), { matched: true, matchedPath: '/a' });
});

test('no match for an unregistered path', () => {
  const t = new Trie();
  t.insert('/users');
  assert.deepEqual(t.matchPrefix('/posts'), { matched: false, matchedPath: '' });
});

test('exact prefix match', () => {
  const t = new Trie();
  t.insert('/posts');
  assert.equal(t.matchPrefix('/posts').matchedPath, '/posts');
});
