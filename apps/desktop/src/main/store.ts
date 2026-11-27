/**
 * 本地配置：relay 地址与 token。
 *
 * 存在 Electron 的 userData 目录，权限 600。v1 是明文 —— 这台机器本身就是
 * 可信的，token 换来的是「能不能连我的 agent」，不是敏感数据。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

export interface StoredConfig {
  url: string
  token: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'rpty-config.json')
}

export function loadConfig(): Partial<StoredConfig> {
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredConfig>
    return {
      url: typeof parsed.url === 'string' ? parsed.url : undefined,
      token: typeof parsed.token === 'string' ? parsed.token : undefined
    }
  } catch {
    return {}
  }
}

export function saveConfig(config: StoredConfig): void {
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  try {
    chmodSync(file, 0o600)
  } catch {
    // 某些文件系统不支持，忽略。
  }
}
