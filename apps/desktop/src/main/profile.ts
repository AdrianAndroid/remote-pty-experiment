/**
 * 客户端 profile —— 「一个客户端」到底是谁。
 *
 * 以前这件事是隐式的：userData 目录（`RPTY_USERDATA` 或 appData/rpty-desktop）
 * 就是身份边界。于是同机双击两次 = 两个进程共用一个 client_id，互相覆盖
 * owned-sessions.json；要开第二个真客户端得靠环境变量，且不算主窗口。
 *
 * 现在把它显式化：
 *
 *   默认 profile  → userData 就是根目录（老用户零迁移）
 *   <name>        → userData = <根>/profiles/<name>
 *   RPTY_USERDATA → 名字叫 custom 的非默认 profile（开发后门，行为同以前）
 *
 * 这个文件刻意不 import electron，纯函数好测：root 由调用方（主进程）传进来。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_PROFILE = 'default'
/** `RPTY_USERDATA` 指过来的老路径，给它一个固定的名字。 */
export const CUSTOM_PROFILE = 'custom'

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/

export interface Profile {
  /** profile 名：默认 `default`，环境变量指定则为 custom */
  name: string
  /** 这个 profile 的 userData 目录 */
  dir: string
  /** 是不是默认 profile —— primary=1 与 client-name 生成规则都看它 */
  isDefault: boolean
}

export interface ProfileEnv {
  profile?: string
  userData?: string
}

/** 根目录：所有 profile 的家。默认 profile 直接用这个目录本身。 */
export function profilesRoot(appData: string): string {
  return join(appData, 'rpty-desktop')
}

/** 某个 profile 的 userData 目录。默认 profile 就是根目录本身。 */
export function profileDir(root: string, name: string): string {
  if (name === DEFAULT_PROFILE) return root
  return join(root, 'profiles', name)
}

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name) && name !== DEFAULT_PROFILE
}

/**
 * 决定这次启动是哪个 profile。
 *
 * 优先级：RPTY_PROFILE（显式）> RPTY_USERDATA（老后门）> 默认。
 * 名字非法就当没指定，回默认 —— 免得一个手滑的环境变量让用户「找不到自己的终端」。
 */
export function resolveProfile(root: string, env: ProfileEnv = {}): Profile {
  const wanted = (env.profile || '').trim()
  if (wanted) {
    if (wanted === DEFAULT_PROFILE) {
      return { name: DEFAULT_PROFILE, dir: root, isDefault: true }
    }
    if (isValidProfileName(wanted)) {
      return { name: wanted, dir: profileDir(root, wanted), isDefault: false }
    }
  }
  const legacy = (env.userData || '').trim()
  if (legacy) {
    return { name: CUSTOM_PROFILE, dir: legacy, isDefault: false }
  }
  return { name: DEFAULT_PROFILE, dir: root, isDefault: true }
}

/** 已经存在的 profile 名（默认 profile 不在列表里，它没有目录名）。 */
export function listProfiles(root: string): string[] {
  const base = join(root, 'profiles')
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 下一个能用的名字：client-2、client-3…
 *
 * 取「现有最大号 + 1」，不回收空号 —— 删掉 client-3 之后再建一个叫 client-3 的新客户端，
 * 容易让人以为还是原来那个（设备列表、会话归属都对不上）。
 */
export function nextProfileName(root: string): string {
  let max = 1 // 默认 profile 算第 1 个
  for (const name of listProfiles(root)) {
    const matched = /^client-(\d+)$/.exec(name)
    if (matched) max = Math.max(max, Number(matched[1]))
  }
  return `client-${max + 1}`
}

/**
 * 建一个 profile 目录，并把当前 profile 的配置复制过去。
 *
 * 复制配置是为了「新建即可用」：地址和 token 不用再填一遍。各 profile 之后各管各的，
 * 想连不同 relay 也行。
 */
export function seedProfile(root: string, name: string, fromDir: string): string {
  const dir = profileDir(root, name)
  mkdirSync(dir, { recursive: true })
  const config = join(fromDir, 'rpty-config.json')
  const target = join(dir, 'rpty-config.json')
  if (existsSync(config) && !existsSync(target)) {
    try {
      copyFileSync(config, target)
    } catch {
      // 复制失败不影响创建：新客户端只是要重新填一次地址。
    }
  }
  return dir
}

let current: Profile | null = null

/** 主进程在 app ready 之前调一次，之后全进程共用。 */
export function initProfile(root: string, env: ProfileEnv = {}): Profile {
  current = resolveProfile(root, env)
  return current
}

export function getProfile(): Profile {
  if (!current) {
    // 没初始化就调 —— 给个安全的默认，不抛异常（否则整个窗口白屏）。
    current = { name: DEFAULT_PROFILE, dir: '', isDefault: true }
  }
  return current
}
