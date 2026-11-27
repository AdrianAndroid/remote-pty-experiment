/**
 * 本地配置：relay 地址、token，以及只读模式开关。
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
  readOnly: boolean
}

function configPath(): string {
  return join(app.getPath('userData'), 'rpty-config.json')
}

function readRaw(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeRaw(data: Record<string, unknown>): void {
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  try {
    chmodSync(file, 0o600)
  } catch {
    // 某些文件系统不支持，忽略。
  }
}

export function loadConfig(): Partial<StoredConfig> {
  const parsed = readRaw()
  return {
    url: typeof parsed.url === 'string' ? parsed.url : undefined,
    token: typeof parsed.token === 'string' ? parsed.token : undefined,
    readOnly: typeof parsed.readOnly === 'boolean' ? parsed.readOnly : undefined
  }
}

export function saveConfig(config: StoredConfig): void {
  writeRaw({ ...config })
}

/** 只改只读开关，不碰 url/token —— 免得把用户填的地址覆盖掉。 */
export function saveReadOnly(readOnly: boolean): void {
  writeRaw({ ...readRaw(), readOnly })
}
