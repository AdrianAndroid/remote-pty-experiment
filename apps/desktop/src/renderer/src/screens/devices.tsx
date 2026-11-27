/**
 * 在线客户端列表：连上中继之后的第一屏。
 *
 * 这一屏列的不是「机器」，是**客户端** —— 每个客户端一个个体，一个固定名字
 * （`<主机短名>-<4 位码>`，不重装就不变）。列表由 relay 在内存里维护：
 * 谁连着 WSS 谁就在列表里，断开立刻消失，所以这一屏永远是"现在谁在线"。
 *
 * 自己那条标「我」、排第一、不可点 —— 自己的终端在本地就能开，不需要从自己这儿连回去。
 * 进别人的客户端才是真正的连接：那条数据通道连到对方认领的宿主上。
 */

import type { ClientInfo, PairInfo } from '../../../shared/ipc'

interface DevicesScreenProps {
  clients: ClientInfo[]
  /** 自己的客户端 id：用来在列表里认出「我」 */
  selfClientId?: string
  /** relay 的实时配对表：谁正在进我的客户端、我进了谁 */
  pairs?: PairInfo[]
  /** 中继本身是否还连着（重连中时列表还在，但点不进去） */
  online: boolean
  busy: boolean
  error: string
  /** 传对方的宿主 node id 与它的客户端 id */
  onPick: (host: string, clientId: string) => void
  onExitRelay: () => void
  onReload: () => void
  /** 回到自己的终端（「我」那条不给点，但总得有条路回去） */
  onOpenMine?: () => void
}

export function DevicesScreen({
  clients,
  selfClientId = '',
  pairs = [],
  online,
  busy,
  error,
  onPick,
  onExitRelay,
  onReload,
  onOpenMine
}: DevicesScreenProps): React.JSX.Element {
  // 「我」永远排第一，其余按"有宿主可进"优先
  const sorted = [...clients].sort((a, b) => {
    const selfDelta = Number(b.client === selfClientId) - Number(a.client === selfClientId)
    if (selfDelta) return selfDelta
    return Number(Boolean(b.host)) - Number(Boolean(a.host))
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
            </span>
          </div>
        </div>
        <div className="devices__actions">
          {onOpenMine && (
            <button
              type="button"
              className="devices__ghost devices__ghost--mine"
              onClick={onOpenMine}
              title="打开我自己的终端（⌘T 新建也在这里）"
            >
              我的终端
            </button>
          )}
          <button type="button" className="devices__ghost" onClick={onReload} title="重新拉一次在线列表">
            刷新
          </button>
          <button type="button" className="devices__ghost" onClick={onExitRelay} title="断开中继（⌘⇧D）">
            断开中继
          </button>
        </div>
      </header>

      <div className="devices__body">
        <h1>在线客户端</h1>
        <p className="devices__hint">
          每个客户端一个个体。进别人的客户端才是真正的连接；离开只是撤掉画面，对方机器上的终端会继续跑。
        </p>

        {error && <p className="devices__error">{error}</p>}

        {sorted.length === 0 ? (
          <div className="devices__empty">
            <p>现在没有别的客户端在线</p>
            <p className="devices__empty-hint">
              在另一台机器上打开 rpty 客户端，它会自动出现在这里。
            </p>
          </div>
        ) : (
          <ul className="devices__list">
            {sorted.map((item) => {
              const isSelf = !!selfClientId && item.client === selfClientId
              const enterable = !isSelf && !!item.host && online && !busy
              const sessions = item.sessions ?? 0
              // 谁正进着我：配对是 relay 记的，不是我这边猜的
              const viewers = pairs.filter((pair) => pair.to === item.client)
              return (
                <li key={item.client}>
                  <button
                    type="button"
                    className={
                      isSelf
                        ? 'devicecard devicecard--self'
                        : enterable
                          ? 'devicecard'
                          : 'devicecard devicecard--off'
                    }
                    disabled={!enterable}
                    onClick={() => onPick(item.host, item.client)}
                    title={
                      isSelf
                        ? '这是你自己，不用从这里连回去'
                        : !item.host
                          ? '这个客户端还没认领宿主（它那台机器上的 agent 没起来）'
                          : `进入 ${item.name}`
                    }
                  >
                    <span
                      className={item.host ? 'devicecard__dot' : 'devicecard__dot devicecard__dot--off'}
                    />
                    <span className="devicecard__main">
                      <span className="devicecard__name">
                        {item.name || item.client.slice(0, 8)}
                        {isSelf && <em className="devicecard__badge devicecard__badge--me">我</em>}
                      </span>
                      <span className="devicecard__meta">
                        {item.host ? `${sessions} 个终端` : '宿主未上线'}
                        {item.host && item.host_name
                          ? ` · ${item.host_name.replace(/\.local$/, '')}`
                          : ''}
                        {viewers.length > 0 && (
                          <em className="devicecard__pair">
                            「{viewers.map((v) => v.from_name || v.from.slice(0, 8)).join(' / ')}
                            」正在查看
                          </em>
                        )}
                      </span>
                    </span>
                    {!isSelf && (
                      <span className="devicecard__go">
                        {pairs.some((pair) => pair.from === selfClientId && pair.to === item.client)
                          ? '配对中'
                          : enterable
                            ? '进入 →'
                            : ''}
                      </span>
                    )}
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
