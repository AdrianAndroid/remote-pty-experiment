/**
 * 设备列表：连上中继之后的第一屏。
 *
 * 这里只表示「哪些机器可以连」，一条终端数据通道都不开 —— 点中一台才算进入。
 * 所以这一页的观看开销为零，机器上下线会实时刷新。
 */

import type { NodeInfo } from '../../../shared/ipc'
import { deviceLabel, deviceLabelParts } from '../lib/device-label'

interface DevicesScreenProps {
  nodes: NodeInfo[]
  /** 中继本身是否还连着（重连中时列表还在，但点不进去） */
  online: boolean
  busy: boolean
  error: string
  onPick: (node: string) => void
  onExitRelay: () => void
  onReload: () => void
  /** 我这个客户端的名字（不卸载重装就不变），放 title 里 */
  clientName?: string
  /** 顶栏「我 ·」后面显示的名字：就是设备列表里“我这台机器”那条的名字 */
  selfLabel?: string
  /** 我自己这条设备的 node id：标「我」，并且不给进（自己进自己没有意义） */
  selfNode?: string
}

export function DevicesScreen({
  nodes,
  online,
  busy,
  error,
  onPick,
  onExitRelay,
  onReload,
  clientName = '',
  selfLabel = '',
  selfNode = ''
}: DevicesScreenProps): React.JSX.Element {
  // 「我」永远排第一，其余按在线优先
  const sorted = [...nodes].sort((a, b) => {
    const selfDelta = Number(b.node === selfNode) - Number(a.node === selfNode)
    return selfDelta || Number(b.online) - Number(a.online)
  })

  return (
    <div className="devices">
      <header className="devices__head">
        <div className="devices__brand">
          <span className="devices__logo">▚</span>
          <div>
            <strong>rpty</strong>
            <span className={online ? 'devices__state devices__state--on' : 'devices__state'}>
              {online ? '已连接中继' : '中继断开，正在重连…'}
              {selfLabel && (
                <span className="devices__me" title={clientName ? `这台客户端：${clientName}` : undefined}>
                  我 · {selfLabel}
                </span>
              )}
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
            {sorted.map((node) => {
              // 我自己这台机器的 agent：标「我」，不给进 —— 自己不需要从自己这儿连回去
              const isSelf = !!selfNode && node.node === selfNode
              return (
              <li key={node.node}>
                <button
                  type="button"
                  className={
                    isSelf
                      ? 'devicecard devicecard--self'
                      : node.online
                        ? 'devicecard'
                        : 'devicecard devicecard--off'
                  }
                  disabled={isSelf || !node.online || !online || busy}
                  onClick={() => onPick(node.node)}
                  title={
                    isSelf
                      ? `${deviceLabel(node)} 就是这台电脑，不用从这里进`
                      : node.online
                        ? `进入 ${deviceLabel(node)}`
                        : `${deviceLabel(node)} 当前离线，连不进去`
                  }
                >
                  <span className={node.online ? 'devicecard__dot' : 'devicecard__dot devicecard__dot--off'} />
                  <span className="devicecard__main">
                    <span className="devicecard__name">
                      {deviceLabelParts(node).base}
                      <em className="devicecard__badge devicecard__badge--id">
                        {deviceLabelParts(node).code}
                      </em>
                      {isSelf && <em className="devicecard__badge devicecard__badge--me">我</em>}
                    </span>
                    <span className="devicecard__meta">
                      {node.online ? `${node.sessions} 个终端` : '离线'}
                    </span>
                  </span>
                  {!isSelf && <span className="devicecard__go">{node.online ? '进入 →' : ''}</span>}
                </button>
              </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
