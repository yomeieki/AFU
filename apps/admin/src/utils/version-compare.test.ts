import assert from 'node:assert/strict'
import test from 'node:test'
import { isNewerVersion } from './version-compare.ts'

test('isNewerVersion：两边都有真实版本且不等才算新', () => {
  assert.equal(isNewerVersion('abc1234', 'def5678'), true)
  assert.equal(isNewerVersion('abc1234', 'abc1234'), false)
})
test('isNewerVersion：dev / 空 / undefined 一律不算', () => {
  assert.equal(isNewerVersion('dev', 'abc1234'), false)
  assert.equal(isNewerVersion('abc1234', 'dev'), false)
  assert.equal(isNewerVersion('abc1234', ''), false)
  assert.equal(isNewerVersion('abc1234', undefined), false)
  assert.equal(isNewerVersion('abc1234', null), false)
  assert.equal(isNewerVersion('', 'abc1234'), false)
})
