'use strict';
/* House rule from the main project: source files are pure ASCII (iPhone copy/paste corrupts UTF-8). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.git' ? [] : walk(p);
    return /\.(js|gs|html|css|json)$/.test(e.name) ? [p] : [];
  });
}

test('all source files are pure ASCII', () => {
  const root = path.join(__dirname, '..');
  const bad = [];
  for (const f of walk(root)) {
    const text = fs.readFileSync(f, 'utf8');
    const i = text.search(/[^\x00-\x7f]/);
    if (i >= 0) bad.push(path.relative(root, f) + ' line ' + (text.slice(0, i).split('\n').length));
  }
  assert.deepEqual(bad, []);
});
