/**
 * 设备在界面上的显示名。
 *
 * 卡片上原来直接写 agent 上报的 `name`，也就是主机名 —— 同一台机器跑两个 agent
 * 时就是两行一模一样的 `zhaojiandeMac-mini`，根本分不清。这里统一成
 * 「主机短名 + 4 位码」，和客户端名字同一个格式：
 *
 * - 码优先用节点 id 自带的 `<host>-<hex4>` 尾段（agent 自己起的那个，稳定）；
 * - 节点 id 是人工起的（如 `default`）就按 id 算一个稳定的 4 位码，重启/重连不变。
 *
 * 结果：同一个节点每次显示都一样，不同节点不会撞成一行。
 */

/** 去掉 macOS 的 `.local` 尾巴 */
export function prettyName(name: string): string {
  return name.replace(/\.local$/, '')
}

/** 节点 id 里自带的 4 位 hex 尾段；没有就是空 */
function tailCode(id: string): string {
  return /-([0-9a-f]{4})$/.exec(id)?.[1] ?? ''
}

/** 稳定 4 位 hex（FNV-1a）：同一个节点 id 每次都算出同一个码 */
function hashCode(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 4)
}

export interface DeviceLabel {
  /** 主机短名 */
  base: string
  /** 4 位码 */
  code: string
}

export function deviceLabelParts(node: { node: string; name: string }): DeviceLabel {
  const code = tailCode(node.node) || hashCode(node.node)
  const base = prettyName(node.name)
  return { base: base.endsWith(`-${code}`) ? base.slice(0, -(code.length + 1)) : base, code }
}

export function deviceLabel(node: { node: string; name: string }): string {
  const { base, code } = deviceLabelParts(node)
  return `${base}-${code}`
}
