// The terminal client's text measuring: wide (CJK) characters take two columns; wrapping keeps words whole.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fit, width, wrap } from '../src/tui.js';

test('tui text: width, fit and wrap', () => {
  assert.equal(width('hello'), 5);
  assert.equal(width('写一个文件'), 10);
  assert.equal(width('\x1b[1mbold\x1b[22m'), 4, 'colour codes take no room');
  assert.equal(fit('abcdefghij', 6), 'abcde…');
  assert.equal(width(fit('写一个很长的目标文件', 9)), 9);
  assert.deepEqual(wrap('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps']);
  assert.ok(wrap('写一个很长的目标文件写一个很长的目标文件', 10).every((l) => width(l) <= 10));
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b']);
  const cjk = wrap('使用 Python 标准库 unittest 覆盖至少整数加法并确保测试文件可直接运行', 20);
  assert.ok(cjk.slice(0, -1).every((l) => width(l) >= 18), `CJK lines are filled: ${JSON.stringify(cjk)}`);
});
