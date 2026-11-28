/**
 * 在线客户端列表：连上中继之后的第一屏。
 *
 * 这一屏列的不是「机器」，是**客户端** —— 每个客户端一个个体，一个固定名字
 * （`<主机短名>-<4 位码>`，不重装就不变）。列表由 relay 在内存里维护：
 * 谁连着 WSS 谁就在列表里，断开立刻消失，所以这一屏永远是"现在谁在线"。
 *
 * 自己那条标「我」、排第一、不可点 —— 自己的终端在本地就能开，不需要从自己这儿连回去。
 *
 * 点别人 = 输对方的通话密码：密码对了两个人立刻进同一个私密房间，
 * 不需要对方点「同意」。正在通话里的客户端留一条「通话中」标签、点不动，
 * 但不写跟谁在通话 —— 小黑屋不该在墙上挂牌子。
 */

import type { ClientInfo } from '../../../shared/ipc'

interface DevicesScreenProps {
  clients: ClientInfo[]
  /** 自己的客户端 id：用来在列表里认出「我」 */
  selfClientId?: string
  /** 中继本身是否还连着（重连中时列表还在，但点不进去） */
  online: boolean
  busy: boolean
  error: string
  /** 点一个客户端：弹出密码输入框 */
  onJoin: (item: ClientInfo) => void
  /** 打开「我的通话密码」设置 */
  onPasswordSettings: () => void
  /** 自己还在用默认密码 admin123 */
  passwordIsDefault?: boolean
  onExitRelay: () => void
  onReload: () => void
  /** 回到自己的终端（「我」那条不给点，但总得有条路回去） */
  onOpenMine?: () => void
}

export function DevicesScreen({
  clients,
  selfClientId = '',
  online,
  busy,
  error,
  onJoin,
  onPasswordSettings,
  passwordIsDefault = false,
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
          <button
            type="button"
            className={passwordIsDefault ? 'devices__ghost devices__ghost--warn' : 'devices__ghost'}
            onClick={onPasswordSettings}
            title={
              passwordIsDefault
                ? '你还在用默认密码 admin123 —— 知道地址的人试一次就能进你的桌面，点这里改掉'
                : '修改我的通话密码（别人连进来要输它）'
            }
          >
            我的密码{passwordIsDefault ? ' · 默认' : ''}
          </button>
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
          点一个客户端，输入它的通话密码，两个人就直接进入一对一的私密房间 ——
          不需要对方点同意。房间里的终端只有你们两个人看得见；离开只是离开房间，
          宿主上的进程不杀。
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
              // 在通话里的人点不动：不是灰掉"没上线"，是灰掉"正在私密会话"。
              const inCall = !!item.busy
              const joinable = !isSelf && !!item.host && online && !busy && !inCall
              return (
                <li key={item.client}>
                  <button
                    type="button"
                    className={
                      isSelf
                        ? 'devicecard devicecard--self'
                        : joinable
                          ? 'devicecard'
                          : 'devicecard devicecard--off'
                    }
                    disabled={!joinable}
                    onClick={() => onJoin(item)}
                    title={
                      isSelf
                        ? '这是你自己。回自己的终端请点右上角「我的终端」'
                        : inCall
                          ? '对方正在私密通话中，等他结束再来'
                          : !item.host
                            ? '这个客户端还没认领宿主（它那台机器上的 agent 没起来）'
                            : `输入 ${item.name} 的通话密码，直接一对一`
                    }
                  >
                    <span
                      className={item.host ? 'devicecard__dot' : 'devicecard__dot devicecard__dot--off'}
                    />
                    <span className="devicecard__main">
                      <span className="devicecard__name">
                        {item.name || item.client.slice(0, 8)}
                        {isSelf && <em className="devicecard__badge devicecard__badge--me">我</em>}
                        {inCall && (
                          <em className="devicecard__badge devicecard__badge--call">
                            {item.reconnecting ? '通话中 · 重连中' : '通话中'}
                          </em>
                        )}
                        {!isSelf && !inCall && item.password_default && (
                          <em className="devicecard__badge devicecard__badge--warn">默认密码</em>
                        )}
                      </span>
                      <span className="devicecard__meta">
                        {item.host ? `${item.sessions ?? 0} 个终端` : '宿主未上线'}
                        {item.host && item.host_name
                          ? ` · ${item.host_name.replace(/\.local$/, '')}`
                          : ''}
                      </span>
                    </span>
                    {!isSelf && (
                      <span className="devicecard__go">
                        {inCall ? '通话中' : joinable ? '输密码 →' : ''}
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
