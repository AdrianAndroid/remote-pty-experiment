/**
 * 本客户端的通话密码 —— 别人点「进入」时要输的那一个。
 *
 * 存哪儿：`<userData>/client-password`（0600）。跟 profile 绑定，所以同一台机器
 * 开两个客户端天然是两个密码，互不影响。
 *
 * 为什么不存哈希：客户端自己得把它发给 relay 才能让人进来（relay 只存哈希校验），
 * 本地存哈希就再也拿不回明文了。relay 那边不留明文，泄露面就只有本机这块盘。
 *
 * 缺省值 `admin123` 是用户明确要的"开箱能连"：代价是知道地址的人都能试，
 * 所以界面上必须显性提示「你还在用默认密码」。
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const DEFAULT_PASSWORD = 'admin123'
export const PASSWORD_MIN = 6

function passwordFile(): string {
  return join(app.getPath('userData'), 'client-password')
}

/** 读自己的密码：没设过就是默认值（不落盘，等用户真的改了再写）。 */
export function loadPassword(): string {
  try {
    const file = passwordFile()
    if (!existsSync(file)) return DEFAULT_PASSWORD
    const text = readFileSync(file, 'utf8').trim()
    return text || DEFAULT_PASSWORD
  } catch {
    return DEFAULT_PASSWORD
  }
}

/** 写密码。校验长度，0600，返回一句能直接显示给用户的话。 */
export function savePassword(value: string): { ok: boolean; error?: string } {
  const password = value.trim()
  if (password.length < PASSWORD_MIN) {
    return { ok: false, error: `密码至少 ${PASSWORD_MIN} 位` }
  }
  try {
    const file = passwordFile()
    writeFileSync(file, password, { mode: 0o600 })
    // 文件已存在时 writeFileSync 的 mode 不生效，显式再收紧一次。
    chmodSync(file, 0o600)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
