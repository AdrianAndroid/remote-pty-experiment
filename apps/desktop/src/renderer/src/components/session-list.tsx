/**
 * 左侧竖向标签列。
 *
 * v1 不做分屏、不做拖拽排序 —— 这一列就是「换台」用的，右侧同一时刻
 * 只有一个终端在画。
 */

import type { ConnectionPhase } from '../../../shared/ipc'
import type { SessionState } from '../../../shared/protocol'

export interface SessionMeta {
  id: string
  title: string
  state: SessionState
  /** true = 本窗口建的终端；false = 别的窗口建的，这里只是镜像 */
  owned: boolean
  /** PTY 语言尺寸，镜像端据此锁死 xterm，避免换行错位 */
  cols?: number
  rows?: number
  /** 这个终端跑在哪台机器上（多节点时才有意义，界面不显示） */
  node?: string
}

interface SessionListProps {
  sessions: SessionMeta[]
  activeId: string | null
  collapsed: boolean
  phase: ConnectionPhase
  agentOnline: boolean
  hostname: string
  readOnly: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  onToggle: () => void
  onToggleReadOnly: () => void
  /** 断开整台客户端到 relay 的链路（宿主上的 PTY 不动，可以再连回来） */
  onDisconnect: () => void
}

const STATE_LABEL: Record<SessionState, string> = {
  connecting: '连接中',
  active: '运行中',
  disconnected: '已断开',
  exited: '已退出',
  error: '出错'
}

export function SessionList({
  sessions,
  activeId,
  collapsed,
  phase,
  agentOnline,
  hostname,
  readOnly,
  onSelect,
  onCreate,
  onClose,
  onRename,
  onToggle,
  onToggleReadOnly,
  onDisconnect
}: SessionListProps): React.JSX.Element {
  const online = phase === 'online' && agentOnline

  return (
    <aside className={collapsed ? 'sidebar sidebar--collapsed' : 'sidebar'}>
      <header className="sidebar__head">
        <div
          className="sidebar__brand"
          title={
            hostname
              ? `所有终端的 shell 都跑在这台宿主机上：${hostname}`
              : '未连接'
          }
        >
          <span className="sidebar__logo">▚</span>
          {!collapsed && (
            <div className="sidebar__names">
              <strong>rpty</strong>
              <span className={online ? 'dot dot--on' : 'dot dot--off'}>
                {online ? (
                  <>
                    <span className="sidebar__role">宿主</span>
                    {(hostname || '已连接').replace(/\.local$/, '')}
                  </>
                ) : phase === 'connecting' ? (
                  '连接中…'
                ) : (
                  '未连接'
                )}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          className="iconbtn"
          onClick={onToggle}
          title={collapsed ? '展开标签列 ⌘B' : '收起标签列 ⌘B'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </header>

      {!collapsed && (
        <div className="sidebar__section">终端</div>
      )}

      <ul className="tablist">
        {sessions.map((session, index) => (
          <li key={session.id}>
            <button
              type="button"
              className={[
                'tab',
                session.id === activeId ? 'tab--active' : '',
                session.state === 'exited' ? 'tab--dead' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => {
                const next = window.prompt('重命名标签', session.title)
                if (next && next.trim()) onRename(session.id, next.trim())
              }}
              title={`${session.title} · ${session.owned ? '本窗口创建' : '镜像自另一个窗口'} · ${
                STATE_LABEL[session.state]
              }${index < 9 ? ` · ⌘${index + 1}` : ''}`}
            >
              <span className={`led led--${session.state}`} />
              {!collapsed && (
                <span className={session.owned ? 'tab__title' : 'tab__title tab__title--mirror'}>
                  {session.title}
                </span>
              )}
              {!collapsed && !session.owned && (
                <span
                  className="tab__badge"
                  title="这个终端是另一个窗口创建的，你在镜像查看同一个 shell"
                >
                  共享
                </span>
              )}
              {!collapsed && (
                <span
                  className="tab__close"
                  role="button"
                  tabIndex={-1}
                  title="关闭 ⌘W"
                  onClick={(event) => {
                    event.stopPropagation()
                    onClose(session.id)
                  }}
                  onKeyDown={() => undefined}
                >
                  ×
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className="newtab" onClick={onCreate} title="新建终端 ⌘T">
        <span className="newtab__plus">+</span>
        {!collapsed && <span>新建终端</span>}
        {!collapsed && <kbd>⌘T</kbd>}
      </button>

      <button
        type="button"
        className={readOnly ? 'modebtn modebtn--readonly' : 'modebtn'}
        onClick={onToggleReadOnly}
        title={
          readOnly
            ? '只读中：只能看，敲键盘不会发出去（⌘⇧L 切回可操作）'
            : '可操作：键盘会发到被控端（⌘⇧L 切成只读）'
        }
      >
        <span className="modebtn__dot" />
        {!collapsed && <span>{readOnly ? '只读' : '可操作'}</span>}
        {!collapsed && <kbd>⌘⇧L</kbd>}
      </button>

      <button
        type="button"
        className="modebtn modebtn--disconnect"
        onClick={onDisconnect}
        title="断开与 relay 的连接（⌘⇧D）· 宿主上的终端会继续跑，随时可以再连回来"
      >
        <span className="modebtn__dot" />
        {!collapsed && <span>断开连接</span>}
        {!collapsed && <kbd>⌘⇧D</kbd>}
      </button>

      {!collapsed && (
        <footer className="sidebar__foot">
          {readOnly && <span className="foot__ro">只读模式</span>}
          {sessions.length} / 20 个会话
        </footer>
      )}
    </aside>
  )
}
