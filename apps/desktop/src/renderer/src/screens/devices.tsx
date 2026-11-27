/**
 * 设备列表：连上中继之后的第一屏。
 *
 * 这里只表示「哪些机器可以连」，一条终端数据通道都不开 —— 点中一台才算进入。
 * 所以这一页的观看开销为零，机器上下线会实时刷新。
 */

import type { NodeInfo } from '../../../shared/ipc'

interface DevicesScreenProps {
  nodes: NodeInfo[]
  /** 中继本身是否还连着（重连中时列表还在，但点不进去） */
  online: boolean
  busy: boolean
  error: string
  onPick: (node: string) => void
  onExitRelay: () => void
  onReload: () => void
}

function pretty(name: string): string {
  return name.replace(/\.local$/, '')
}

export function DevicesScreen({
  nodes,
  online,
  busy,
  error,
  onPick,
  onExitRelay,
  onReload
}: DevicesScreenProps): React.JSX.Element {
  const sorted = [...nodes].sort((a, b) => Number(b.online) - Number(a.online))
  // 同一台机器跑多个 agent 时显示名会一样，靠 id 尾段区分；名字唯一时不显示，保持干净
  const nameCount = new Map<string, number>()
  for (const node of sorted) nameCount.set(node.name, (nameCount.get(node.name) ?? 0) + 1)
  // 只认「-<4 位 hex>」这种自动生成的后缀；人工起的节点名（如主机名本身）不硬拆
  const tail = (id: string): string => /-([0-9a-f]{4})$/.exec(id)?.[1] ?? ''

  return (
    <div className="devices">
      <header className="devices__head">
        <div className="devices__brand">
          <span className="devices__logo">▚</span>
          <div>
            <strong>rpty</strong>
            <span className={online ? 'devices__state devices__state--on' : 'devices__state'}>
              {online ? '已连接中继' : '中继断开，正在重连…'}
            </span>
          </div>
        </div>
        <div className="devices__actions">
          <button type="button" className="devices__ghost" onClick={onReload} title="重新拉一次设备列表">
            刷新
          </button>
          <button type="button" className="devices__ghost" onClick={onExitRelay} title="断开中继（⌘⇧D）">
            退出中继
          </button>
        </div>
      </header>

      <div className="devices__body">
        <p className="devices__title">选择设备</p>
        <p className="devices__hint">
          点一台进入它的终端。离开时只是撤掉画面，那台机器上的终端会继续跑。
        </p>

        {error && <div className="devices__error">{error}</div>}

        {sorted.length === 0 ? (
          <div className="devices__empty">
            <p>还没有被控端在线</p>
            <p className="devices__empty-hint">
              在那台机器上跑起 <code>rpty_agent.py</code>，这里会自动出现。
            </p>
          </div>
        ) : (
          <ul className="devices__list">
            {sorted.map((node) => (
              <li key={node.node}>
                <button
                  type="button"
                  className={node.online ? 'devicecard' : 'devicecard devicecard--off'}
                  disabled={!node.online || !online || busy}
                  onClick={() => onPick(node.node)}
                  title={
                    node.online
                      ? `进入 ${pretty(node.name)}`
                      : `${pretty(node.name)} 当前离线，连不进去`
                  }
                >
                  <span className={node.online ? 'devicecard__dot' : 'devicecard__dot devicecard__dot--off'} />
                  <span className="devicecard__main">
                    <span className="devicecard__name">
                      {pretty(node.name)}
                      {(nameCount.get(node.name) ?? 0) > 1 && tail(node.node) && (
                        <em className="devicecard__badge devicecard__badge--id">{tail(node.node)}</em>
                      )}
                      {node.local && <em className="devicecard__badge">本机</em>}
                    </span>
                    <span className="devicecard__meta">
                      {node.online ? `${node.sessions} 个终端` : '离线'}
                      {pretty(node.node) !== pretty(node.name) &&
                        (nameCount.get(node.name) ?? 0) > 1 &&
                        ` · ${node.node}`}
                    </span>
                  </span>
                  <span className="devicecard__go">{node.online ? '进入 →' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
