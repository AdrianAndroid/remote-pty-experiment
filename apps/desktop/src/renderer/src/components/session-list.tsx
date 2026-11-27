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
}

interface SessionListProps {
  sessions: SessionMeta[]
  activeId: string | null
  collapsed: boolean
  phase: ConnectionPhase
  agentOnline: boolean
  hostname: string
  onSelect: (id: string) => void
  onCreate: () => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
  onToggle: () => void
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
  onSelect,
  onCreate,
  onClose,
  onRename,
  onToggle
}: SessionListProps): React.JSX.Element {
  const online = phase === 'online' && agentOnline

  return (
    <aside className={collapsed ? 'sidebar sidebar--collapsed' : 'sidebar'}>
      <header className="sidebar__head">
        <div className="sidebar__brand" title={hostname || '未连接'}>
          <span className="sidebar__logo">▚</span>
          {!collapsed && (
            <div className="sidebar__names">
              <strong>rpty</strong>
              <span className={online ? 'dot dot--on' : 'dot dot--off'}>
                {online ? hostname || '已连接' : phase === 'connecting' ? '连接中…' : '未连接'}
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
              title={`${session.title} · ${STATE_LABEL[session.state]}${
                index < 9 ? ` · ⌘${index + 1}` : ''
              }`}
            >
              <span className={`led led--${session.state}`} />
              {!collapsed && <span className="tab__title">{session.title}</span>}
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

      {!collapsed && (
        <footer className="sidebar__foot">
          {sessions.length} / 20 个会话
        </footer>
      )}
    </aside>
  )
}
