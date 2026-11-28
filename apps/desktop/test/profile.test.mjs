/**
 * profile 解析层的断言（纯函数，不依赖 electron）。
 *
 * 跑法：
 *   pnpm -C apps/desktop test
 * 也就是先把 src/main/profile.ts 单独编译成 ESM，再用 node 跑这个文件。
 * 这层会因为环境变量、目录布局而「悄悄认错人」，所以值得钉住。
 */

import assert from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE,
  initProfile,
  getProfile,
  isValidProfileName,
  listProfiles,
  nextProfileName,
  profileDir,
  resolveProfile,
  seedProfile
} from '../.tmp/profile-test/profile.mjs'

const root = mkdtempSync(join(tmpdir(), 'rpty-root-'))
writeFileSync(join(root, 'rpty-config.json'), JSON.stringify({ url: 'wss://x', token: 't' }))

// 默认 profile = 根目录本身（老用户零迁移）
assert.deepEqual(resolveProfile(root, {}), { name: DEFAULT_PROFILE, dir: root, isDefault: true })

// 显式 profile 落 profiles/<名字>
const named = resolveProfile(root, { profile: 'client-2' })
assert.equal(named.name, 'client-2')
assert.equal(named.dir, join(root, 'profiles', 'client-2'))
assert.equal(named.isDefault, false)

// RPTY_USERDATA 老后门 → custom，且不算默认（所以不发 primary）
const legacy = resolveProfile(root, { userData: '/tmp/whatever' })
assert.equal(legacy.name, 'custom')
assert.equal(legacy.dir, '/tmp/whatever')
assert.equal(legacy.isDefault, false)

// RPTY_PROFILE 优先于 RPTY_USERDATA
assert.equal(resolveProfile(root, { profile: 'client-3', userData: '/tmp/whatever' }).name, 'client-3')

// 名字不合法就当没指定：不能让一个手滑的环境变量让人「找不到自己的终端」
for (const bad of ['../etc', 'Client', 'a b', '', 'x'.repeat(40), 'default']) {
  assert.equal(resolveProfile(root, { profile: bad }).isDefault, true, `bad=${JSON.stringify(bad)}`)
}
assert.equal(isValidProfileName('client-2'), true)
assert.equal(isValidProfileName('default'), false)

// 起名：从 client-2 起，取最大号 +1，不回收空号
assert.equal(nextProfileName(root), 'client-2')
mkdirSync(profileDir(root, 'client-2'), { recursive: true })
assert.equal(nextProfileName(root), 'client-3')
mkdirSync(profileDir(root, 'client-5'), { recursive: true })
assert.equal(nextProfileName(root), 'client-6')
assert.deepEqual(listProfiles(root).sort(), ['client-2', 'client-5'])

// seed：建目录 + 复制配置（新客户端不用重新填地址）
const seeded = seedProfile(root, 'client-6', root)
assert.ok(existsSync(join(seeded, 'rpty-config.json')))
assert.equal(JSON.parse(readFileSync(join(seeded, 'rpty-config.json'), 'utf8')).token, 't')

// seed 不覆盖已有配置
writeFileSync(join(seeded, 'rpty-config.json'), JSON.stringify({ url: 'wss://mine', token: 'mine' }))
seedProfile(root, 'client-6', root)
assert.equal(JSON.parse(readFileSync(join(seeded, 'rpty-config.json'), 'utf8')).token, 'mine')

// init / get 全进程共用一份
initProfile(root, { profile: 'client-2' })
assert.equal(getProfile().name, 'client-2')
assert.equal(getProfile().dir, join(root, 'profiles', 'client-2'))

console.log('profile.test OK')
