/**
 * 应用外壳：决定显示连接页还是工作区，并持有会话列表。
 *
 * 会话列表放在这里而不是 TerminalPane 里，因为「切换标签」只是换一个
 * display 状态，xterm 实例不能重建 —— 重建会丢掉回滚缓冲和正在跑的程序。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfigInfo, MenuCommand, RelayStatus } from '../../shared/ipc'
import type { SessionState } from '../../shared/protocol'
import { SessionList, type SessionMeta } from './components/session-list'
import { TerminalPane } from './components/terminal-pane'
import { ConnectScreen } from './screens/connect'

const MAX_SESSIONS = 20

/** 粗估一个尺寸给新 PTY，随后 fit() 会校准并发 SESSION_RESIZE。 */
function estimateSize(): { cols: number; rows: number } {
  const host = document.querySelector('.pane--active .pane__host') as HTMLElement | null
  const width = host?.clientWidth ?? window.innerWidth - 232
  const height = host?.clientHeight ?? window.innerHeight - 40
  return {
    cols: Math.max(20, Math.floor(width / 8.4)),
    rows: Math.max(8, Math.floor(height / 17))
  }
}

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<RelayStatus>({ phase: 'idle', agentOnline: false })
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [config, setConfig] = useState<ConfigInfo>({ url: '', hasToken: false })
  const [busy, setBusy] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [error, setError] = useState('')

  const seqRef = useRef(0)
  const autoCreatedRef = useRef(false)
  const readOnlyRef = useRef(false)
  const activeIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionMeta[]>([])
  activeIdRef.current = activeId
  readOnlyRef.current = readOnly
  sessionsRef.current = sessions

  // ---------------------------------------------------------- 初始化

  useEffect(() => {
    void window.rpty.getConfigInfo().then(setConfig)
    void window.rpty.getStatus().then(setStatus)
    void window.rpty.getReadOnly().then(setReadOnly)
    // 主进程比窗口先连上 relay，adopt 事件在那之前就发完了；这里补拉一次当前会话。
    void window.rpty.snapshotSessions().then((list) => {
      if (!Array.isArray(list) || list.length === 0) return
      autoCreatedRef.current = true
      setSessions((prev) => {
        const known = new Set(prev.map((item) => item.id))
        const added = list
          .filter((item) => !known.has(item.leafId))
          .map((item) => {
            // 编号跟被控机走：两个窗口看到的是同一个「终端 N」。
            if (item.index > seqRef.current) seqRef.current = item.index
            return {
              id: item.leafId,
              title: `终端 ${item.index || ++seqRef.current}`,
              state: 'active' as const,
              owned: item.owned,
              cols: item.cols,
              rows: item.rows
            }
          })
        if (added.length === 0) return prev
        setActiveId((current) => current ?? added[0].id)
        return [...prev, ...added]
      })
    })
  }, [])

  // ---------------------------------------------------------- 事件订阅

  useEffect(() => {
    const offStatus = window.rpty.onStatus((next) => {
      setStatus(next)
      if (next.phase === 'online') setBusy(false)
    })

    const offState = window.rpty.onState(({ leafId, state }) => {
      setSessions((prev) =>
        prev.map((item) => (item.id === leafId ? { ...item, state } : item))
      )
    })

    const offExit = window.rpty.onExit(({ leafId }) => {
      setSessions((prev) =>
        prev.map((item) => (item.id === leafId ? { ...item, state: 'exited' } : item))
      )
    })

    // 被控端上已有会话（另一个客户端开的）：不新建，直接挂上去镜像同一块终端。
    const offAdopted = window.rpty.onAdopted(({ leafId, owned, index, cols, rows }) => {
      setSessions((prev) => {
        if (prev.some((item) => item.id === leafId)) return prev
        autoCreatedRef.current = true
        if (index > seqRef.current) seqRef.current = index
        const title = `终端 ${index || ++seqRef.current}`
        setActiveId((current) => current ?? leafId)
        return [...prev, { id: leafId, title, state: 'active', owned, cols, rows }]
      })
    })

    const offError = window.rpty.onError(({ code, message }) => {
      setError(message ? `${message}（${code}）` : code)
    })

    const offReadOnly = window.rpty.onReadOnly((value) => setReadOnly(value))

    return () => {
      offStatus()
      offState()
      offExit()
      offAdopted()
      offError()
      offReadOnly()
    }
  }, [])

  // ---------------------------------------------------------- 只读

  const toggleReadOnly = useCallback(async () => {
    // 用 ref 读当前值：菜单订阅只建一次，闭包里的 readOnly 会是首次渲染的旧值。
    const next = await window.rpty.setReadOnly(!readOnlyRef.current)
    setReadOnly(next)
  }, [])

  // ---------------------------------------------------------- 会话操作

  const createSession = useCallback(async () => {
    if (sessionsRef.current.length >= MAX_SESSIONS) {
      setError(`最多 ${MAX_SESSIONS} 个终端`)
      return
    }
    setError('')
    const { cols, rows } = estimateSize()
    const leafId = crypto.randomUUID()
    const title = `终端 ${++seqRef.current}`
    // 先乐观插标签再发请求：连点两下会立刻出现两个标签，
    // 各自走自己的 IPC，不会因为上一发还没回来就被吃掉。
    setSessions((prev) => [
      ...prev,
      { id: leafId, title, state: 'connecting', owned: true }
    ])
    setActiveId(leafId)
    const result = await window.rpty.create({ leafId, cols, rows })
    if (!result.ok) {
      setSessions((prev) => prev.filter((item) => item.id !== leafId))
      setError(result.error ?? '创建终端失败')
    }
  }, [])

  const closeSession = useCallback(
    async (leafId: string) => {
      await window.rpty.close(leafId)
      setSessions((prev) => {
        const next = prev.filter((item) => item.id !== leafId)
        if (activeIdRef.current === leafId) {
          setActiveId(next.length > 0 ? next[next.length - 1].id : null)
        }
        return next
      })
    },
    []
  )

  const renameSession = useCallback((leafId: string, title: string) => {
    setSessions((prev) => prev.map((item) => (item.id === leafId ? { ...item, title } : item)))
  }, [])

  const stepTab = useCallback(
    (delta: number) => {
      if (sessions.length === 0) return
      const current = sessions.findIndex((item) => item.id === activeIdRef.current)
      const base = current < 0 ? 0 : current
      const next = (base + delta + sessions.length) % sessions.length
      setActiveId(sessions[next].id)
    },
    [sessions]
  )

  const gotoTab = useCallback(
    (index: number) => {
      const target = sessions[index]
      if (target) setActiveId(target.id)
    },
    [sessions]
  )

  // 连上且被控端在线但没有终端时，自动开一个。
  // 但要先给「镜像别人已有会话」一点时间：relay 一接上就会回 SESSION_LIST，
  // 如果这里抢在前面 create，就会凭空多出一个自己的终端，同步就没了。
  useEffect(() => {
    if (autoCreatedRef.current) return
    if (status.phase !== 'online' || !status.agentOnline) return
    const timer = setTimeout(() => {
      if (autoCreatedRef.current) return
      if (sessionsRef.current.length > 0) return
      autoCreatedRef.current = true
      void createSession()
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.phase, status.agentOnline, sessions.length])

  // ---------------------------------------------------------- 菜单与快捷键

  useEffect(() => {
    const offMenu = window.rpty.onMenu((command: MenuCommand, arg?: number) => {
      switch (command) {
        case 'new-tab':
          void createSession()
          break
        case 'close-tab':
          if (activeIdRef.current) void closeSession(activeIdRef.current)
          break
        case 'next-tab':
          stepTab(1)
          break
        case 'prev-tab':
          stepTab(-1)
          break
        case 'goto-tab':
          if (typeof arg === 'number') gotoTab(arg)
          break
        case 'toggle-sidebar':
          setCollapsed((value) => !value)
          break
        case 'toggle-readonly':
          void toggleReadOnly()
          break
        default:
          break
      }
    })
    return offMenu
  }, [createSession, closeSession, stepTab, gotoTab, toggleReadOnly])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return
      const digit = Number.parseInt(event.key, 10)
      if (Number.isFinite(digit) && digit >= 1 && digit <= 9) {
        event.preventDefault()
        event.stopPropagation()
        gotoTab(digit - 1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [gotoTab])

  // ---------------------------------------------------------- 连接

  const handleConnect = useCallback(async (url: string, token: string) => {
    setBusy(true)
    setError('')
    try {
      const next = await window.rpty.connect({ url, token })
      setStatus(next)
      if (next.phase === 'error') setError(next.message ?? '连接失败')
      else void window.rpty.getConfigInfo().then(setConfig)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  // ---------------------------------------------------------- 渲染

  const online = status.phase === 'online'
  const showWorkspace = online || sessions.length > 0

  if (!showWorkspace) {
    return (
      <ConnectScreen
        initialUrl={config.url}
        hasToken={config.hasToken}
        busy={busy}
        error={error}
        onConnect={(url, token) => void handleConnect(url, token)}
      />
    )
  }

  const banner = !online
    ? status.phase === 'connecting' || status.phase === 'offline'
      ? '正在重连 relay…'
      : 'relay 已断开'
    : !status.agentOnline
      ? '被控端不在线'
      : ''

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        collapsed={collapsed}
        phase={status.phase}
        agentOnline={status.agentOnline}
        hostname={status.hostname ?? ''}
        readOnly={readOnly}
        onSelect={setActiveId}
        onCreate={() => void createSession()}
        onClose={(id) => void closeSession(id)}
        onRename={renameSession}
        onToggle={() => setCollapsed((value) => !value)}
        onToggleReadOnly={() => void toggleReadOnly()}
      />

      <main className="stage">
        {banner && <div className={`banner banner--${status.phase}`}>{banner}</div>}

        <div className={readOnly ? 'panes panes--readonly' : 'panes'}>
          {sessions.map((session) => (
            <TerminalPane
              key={session.id}
              leafId={session.id}
              active={session.id === activeId}
              readOnly={readOnly}
              sizeLock={
                !session.owned && session.cols && session.rows
                  ? { cols: session.cols, rows: session.rows }
                  : undefined
              }
            />
          ))}

          {sessions.length === 0 && (
            <div className="empty">
              <p className="empty__title">还没有终端</p>
              <p className="empty__hint">按 ⌘T 新建一个</p>
              <button type="button" className="btn btn--primary" onClick={() => void createSession()}>
                新建终端
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="toast" onClick={() => setError('')} role="presentation">
            {error}
          </div>
        )}
      </main>
    </div>
  )
}

export type { SessionState }
