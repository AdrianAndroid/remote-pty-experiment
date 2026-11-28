/**
 * 应用外壳：三个状态，一一对应地画出来。
 *
 *   S1 没上线（phase !== 'online' 或用户主动断开）   → 连接页 / 已断开页
 *   S2 上线了但没进房间（room === null）             → 在线客户端列表
 *   S3 一对一房间（room !== null）                   → 房间工作区
 *
 * 另有「我的终端」：不是第三个状态，它是 S2 上的一个入口 —— 进自己的宿主，
 * 看自己名下的私有终端，随时可以回列表。房间与此互斥。
 *
 * 会话列表放在这里而不是 TerminalPane 里，因为「切换标签」只是换一个
 * display 状态，xterm 实例不能重建 —— 重建会丢掉回滚缓冲和正在跑的程序。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigInfo,
  InviteView,
  MenuCommand,
  RelayStatus,
  SessionAdoptedPayload
} from '../../shared/ipc'
import type { SessionState } from '../../shared/protocol'
import { SessionList, type SessionMeta } from './components/session-list'
import { TerminalPane } from './components/terminal-pane'
import { ConnectScreen } from './screens/connect'
import { DevicesScreen } from './screens/devices'
import { deviceLabel } from './lib/device-label'

const MAX_SESSIONS = 20

/**
 * 标签元数据的本地存储。
 *
 * 键是 sessionId（relay 侧会话身份），不是 leafId —— leafId 每次进程启动都重新随机，
 * 拿它当身份的话重连之后标题、顺序、选中全部丢失。
 * 按 userData 隔离，所以「换一个客户端」天然是干净标签列。
 *
 * 只存「我的终端」这一屏：房间里的终端跟着房间一起销毁，存了下次也接不回来，
 * 反而会在列表上留下一串点不开的死标签。
 */
interface StoredTab {
  sessionId: string
  title: string
  order: number
}

interface StoredDevice {
  active: string | null
  items: StoredTab[]
}

type TabStore = Record<string, StoredDevice>

const TAB_STORE_KEY = 'rpty.tabs.v2'
const MINE_KEY = 'mine'

function readTabStore(): TabStore {
  try {
    const raw = localStorage.getItem(TAB_STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as TabStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeTabStore(store: TabStore): void {
  try {
    localStorage.setItem(TAB_STORE_KEY, JSON.stringify(store))
  } catch {
    // 存不下就算了，标签还能用，只是重连后回到默认标题
  }
}

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
  // 主进程的提示（例如「已新建客户端」）：应用内 Toast，几秒后自己消失。
  const [notice, setNotice] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [error, setError] = useState('')
  /** 手动断开过：连接页要显示「已断开 + 重新连接」，而不是首次配置的样子 */
  const [detached, setDetached] = useState(false)
  /** 进了自己的桌面：node id；null = 停在列表 */
  const [privateNode, setPrivateNode] = useState<string | null>(null)
  /** 我邀请出去、还没被答复的客户端 id：界面上显示「等待对方同意」 */
  const [pendingInvite, setPendingInvite] = useState('')
  /** 收到的邀请：弹窗里给用户决定 */
  const [invite, setInvite] = useState<InviteView | null>(null)

  const room = status.room ?? null
  const online = status.phase === 'online'

  const statusRef = useRef(status)
  statusRef.current = status
  const seqRef = useRef(0)
  const readOnlyRef = useRef(false)
  readOnlyRef.current = readOnly
  const privateNodeRef = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionMeta[]>([])
  const roomRef = useRef(status.room ?? null)
  roomRef.current = status.room ?? null
  activeIdRef.current = activeId
  sessionsRef.current = sessions
  /** 进自己桌面时要从存储里选回来的那个 sessionId（只生效一次） */
  const pendingActiveRef = useRef<string | null>(null)

  /** 「我」= 我的客户端。列表按客户端展示，所以自己那条直接按 client id 认。 */
  const mySelf = (status.clients ?? []).find((item) => item.client === status.clientId)
  /** 我认领的宿主：自己机器上跑 PTY 的那个 agent */
  const ownHostNode = mySelf?.host ?? ''
  const myClientId = status.clientId ?? ''
  const myClientIdRef = useRef('')
  myClientIdRef.current = myClientId

  // ---------------------------------------------------------- 标签持久化

  const persistTabs = useCallback(() => {
    // 只存「我的终端」：房间里的终端属于房间，房间一关 PTY 就没了。
    if (roomRef.current || privateNodeRef.current === null) return
    if (sessionsRef.current.length === 0) return
    const items = sessionsRef.current
      .filter((item) => item.sessionId)
      .map((item, index) => ({
        sessionId: item.sessionId as string,
        title: item.title,
        order: item.order ?? index
      }))
    if (items.length === 0) return
    const store = readTabStore()
    store[MINE_KEY] = {
      active:
        sessionsRef.current.find((item) => item.id === activeIdRef.current)?.sessionId ?? null,
      items
    }
    writeTabStore(store)
  }, [])

  /** 把主进程的会话快照合进标签列（按 leafId 去重，可以反复调）。 */
  const applySnapshot = useCallback((list: SessionAdoptedPayload[]) => {
    if (!Array.isArray(list) || list.length === 0) return
    // 只有「我的终端」有历史标题可对；房间里一律用 relay 的编号。
    const saved = roomRef.current ? undefined : readTabStore()[MINE_KEY]
    const savedById = new Map((saved?.items ?? []).map((item) => [item.sessionId, item]))
    setSessions((prev) => {
      const known = new Set(prev.map((item) => item.id))
      const added = list
        .filter((item) => !known.has(item.leafId))
        .map((item) => {
          // 编号跟被控机走：两个窗口看到的是同一个「终端 N」。
          if (item.index > seqRef.current) seqRef.current = item.index
          const old = savedById.get(item.sessionId)
          return {
            id: item.leafId,
            sessionId: item.sessionId,
            title: old?.title ?? `终端 ${item.index || ++seqRef.current}`,
            order: old?.order ?? item.index,
            state: 'active' as const,
            owned: item.owned,
            owner: item.owner,
            cols: item.cols,
            rows: item.rows,
            node: item.node
          }
        })
      if (added.length === 0) return prev
      const merged = [...prev, ...added].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      setActiveId((current) => {
        const want = pendingActiveRef.current ?? saved?.active
        const hit = want ? merged.find((item) => item.sessionId === want) : undefined
        if (hit) pendingActiveRef.current = null
        return hit?.id ?? current ?? merged[0].id
      })
      return merged
    })
  }, [])

  useEffect(() => {
    persistTabs()
  }, [sessions, activeId, persistTabs])

  useEffect(() => {
    void window.rpty.getConfigInfo().then(setConfig)
    void window.rpty.getStatus().then(setStatus)
    void window.rpty.getReadOnly().then(setReadOnly)
  }, [])

  // ---------------------------------------------------------- 事件订阅

  useEffect(() => {
    const offStatus = window.rpty.onStatus((next) => {
      setStatus(next)
      if (next.phase === 'online') setBusy(false)
      // 邀请状态以主进程为准：对方撤回、过期、房间已开，都在这里对齐。
      setInvite((current) => {
        const list = next.invites ?? []
        if (list.length === 0) return null
        if (current && list.some((item) => item.client === current.client)) return current
        return list[0]
      })
      if (next.room) setPendingInvite('')
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

    // 宿主上已有会话（房间里的另一台机器、或我上次留下的）：挂上去镜像同一块终端。
    const offAdopted = window.rpty.onAdopted(
      ({ leafId, sessionId, owned, index, cols, rows, node, owner }) => {
        setSessions((prev) => {
          if (prev.some((item) => item.id === leafId)) return prev
          if (index > seqRef.current) seqRef.current = index
          const saved = roomRef.current
            ? undefined
            : readTabStore()[MINE_KEY]?.items.find((item) => item.sessionId === sessionId)
          const title = saved?.title ?? `终端 ${index || ++seqRef.current}`
          const order = saved?.order ?? index
          const wantActive = pendingActiveRef.current === sessionId
          if (wantActive) pendingActiveRef.current = null
          setActiveId((current) => (wantActive ? leafId : (current ?? leafId)))
          return [
            ...prev,
            {
              id: leafId,
              sessionId,
              title,
              order,
              state: 'active' as const,
              owned,
              owner,
              cols,
              rows,
              node
            }
          ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        })
      }
    )

    const offOwned = window.rpty.onOwned(({ leafId, owned }) => {
      setSessions((prev) => prev.map((item) => (item.id === leafId ? { ...item, owned } : item)))
    })

    const offRemoved = window.rpty.onRemoved(({ leafId }) => {
      setSessions((prev) => {
        const next = prev.filter((item) => item.id !== leafId)
        if (activeIdRef.current === leafId) {
          setActiveId(next.length > 0 ? next[next.length - 1].id : null)
        }
        return next
      })
    })

    const offResized = window.rpty.onResized(({ leafId, cols, rows }) => {
      setSessions((prev) =>
        prev.map((item) => (item.id === leafId ? { ...item, cols, rows } : item))
      )
    })

    const offError = window.rpty.onError(({ code, message }) => {
      setError(message ? `${message}（${code}）` : code)
      // 邀请被拒 / 过期：把「等待对方同意」的提示收掉，别一直挂着。
      if (code === 'declined' || code === 'expired' || code === 'peer_busy') {
        setPendingInvite('')
      }
    })

    const offReadOnly = window.rpty.onReadOnly((value) => setReadOnly(value))

    // 房间关了：两个人一起回列表。这里只负责清屏和说明原因。
    const offRoomClosed = window.rpty.onRoomClosed(({ reason, peerName }) => {
      setSessions([])
      setActiveId(null)
      setPrivateNode(null)
      privateNodeRef.current = null
      setError(
        reason === 'peer_timeout'
          ? peerName
            ? `${peerName} 掉线超过 30 秒，通话已结束`
            : '对方掉线超过 30 秒，通话已结束'
          : peerName
            ? `${peerName} 离开了通话`
            : '通话已结束'
      )
    })

    const offInvited = window.rpty.onInvited((payload) => {
      setInvite(payload)
    })

    return () => {
      offStatus()
      offState()
      offExit()
      offAdopted()
      offOwned()
      offRemoved()
      offResized()
      offError()
      offReadOnly()
      offRoomClosed()
      offInvited()
    }
  }, [])

  // ---------------------------------------------------------- 连接

  const handleConnect = useCallback(async (url: string, token: string) => {
    setBusy(true)
    setError('')
    try {
      const next = await window.rpty.connect({ url, token })
      setStatus(next)
      if (next.phase === 'error') setError(next.message ?? '连接失败')
      else {
        setDetached(false)
        setPrivateNode(null)
        privateNodeRef.current = null
        setSessions([])
        setActiveId(null)
        setInvite(null)
        void window.rpty.getConfigInfo().then(setConfig)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * 断开中继：只断这台客户端到 relay 的链路，宿主上的 PTY 一个都不动。
   *
   * 标签必须清掉 —— 重连后会话会重新以 adopt 的方式回来，留着旧标签就会重复。
   */
  const handleDisconnect = useCallback(async () => {
    setError('')
    try {
      await window.rpty.disconnect()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessions([])
      setActiveId(null)
      setStatus({ phase: 'idle', agentOnline: false })
      setPrivateNode(null)
      privateNodeRef.current = null
      setInvite(null)
      setPendingInvite('')
      setDetached(true)
    }
  }, [])

  const handleReconnect = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const next = await window.rpty.reconnect()
      setStatus(next)
      if (next.phase === 'error') setError(next.message ?? '重连失败')
      else {
        setDetached(false)
        setSessions([])
        setActiveId(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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
    const roomNow = roomRef.current
    if (!roomNow && privateNodeRef.current === null) return
    setError('')
    const { cols, rows } = estimateSize()
    const leafId = crypto.randomUUID()
    const title = `终端 ${++seqRef.current}`
    // 先乐观插标签再发请求：连点两下会立刻出现两个标签，
    // 各自走自己的 IPC，不会因为上一发还没回来就被吃掉。
    setSessions((prev) => {
      const maxOrder = prev.reduce((max, item) => Math.max(max, item.order ?? -1), -1)
      return [
        ...prev,
        {
          id: leafId,
          title,
          state: 'connecting',
          owned: true,
          owner: roomNow ? '' : myClientIdRef.current,
          node: privateNodeRef.current ?? undefined,
          order: maxOrder + 1
        }
      ]
    })
    setActiveId(leafId)
    // 房间里不指定 target：主进程按「先自己宿主、再对方宿主」挑，用户不用选机器。
    const target = roomNow ? undefined : (privateNodeRef.current ?? undefined)
    const result = await window.rpty.create({ leafId, cols, rows, target })
    if (!result.ok) {
      setSessions((prev) => prev.filter((item) => item.id !== leafId))
      setError(result.error ?? '创建终端失败')
      return
    }
    if (result.sessionId) {
      const sessionId = result.sessionId
      setSessions((prev) =>
        prev.map((item) => (item.id === leafId ? { ...item, sessionId } : item))
      )
    }
  }, [])

  const closeSession = useCallback(async (leafId: string) => {
    await window.rpty.close(leafId)
    setSessions((prev) => {
      const next = prev.filter((item) => item.id !== leafId)
      if (activeIdRef.current === leafId) {
        setActiveId(next.length > 0 ? next[next.length - 1].id : null)
      }
      return next
    })
  }, [])

  const renameSession = useCallback((leafId: string, title: string) => {
    setSessions((prev) => prev.map((item) => (item.id === leafId ? { ...item, title } : item)))
  }, [])

  // 屏幕上的标签：房间看全部（relay 已经筛过），私有桌面只看我名下的。
  const visibleSessions = useMemo(() => {
    if (room) return sessions
    if (!myClientId) return sessions
    return sessions.filter((item) => !item.owner || item.owner === myClientId)
  }, [sessions, room, myClientId])

  const stepTab = useCallback(
    (delta: number) => {
      if (visibleSessions.length === 0) return
      const current = visibleSessions.findIndex((item) => item.id === activeIdRef.current)
      const base = current < 0 ? 0 : current
      const next = (base + delta + visibleSessions.length) % visibleSessions.length
      setActiveId(visibleSessions[next].id)
    },
    [visibleSessions]
  )

  const gotoTab = useCallback(
    (index: number) => {
      const target = visibleSessions[index]
      if (target) setActiveId(target.id)
    },
    [visibleSessions]
  )

  // 空桌面不自动建终端：进到一台没有终端的机器时显示空状态，等用户按 ⌘T。
  // 以前这里 0.7 秒后自动 createSession，副作用是一个刚建的新客户端会未经询问
  // 就在宿主上多 spawn 一个 shell —— 见 openspec/changes/start-at-device-list。

  // ---------------------------------------------------------- 我的终端 / 房间

  /** 进自己的桌面：只看自己宿主上的私有终端，随时回列表。 */
  const openMine = useCallback(async () => {
    if (!ownHostNode) {
      setError('本机宿主没上线：这台机器上的 agent 没在跑（或还没注册节点）。起来之后再点一次。')
      return
    }
    setError('')
    setSessions([])
    setActiveId(null)
    privateNodeRef.current = ownHostNode
    pendingActiveRef.current = readTabStore()[MINE_KEY]?.active ?? null
    await window.rpty.activateNode(ownHostNode)
    setPrivateNode(ownHostNode)
    const list = await window.rpty.snapshotSessions()
    applySnapshot(list)
  }, [ownHostNode, applySnapshot])

  /** 回列表：撤画面、不动 PTY。 */
  const closeWorkspace = useCallback(async () => {
    privateNodeRef.current = null
    await window.rpty.activateNode(null)
    setPrivateNode(null)
    setSessions([])
    setActiveId(null)
    setError('')
  }, [])

  /** 邀请某个客户端通话：双向同意才建房间，对方不同意就什么也不会发生。 */
  const inviteClient = useCallback(async (clientId: string) => {
    if (!clientId) return
    setError('')
    setPendingInvite(clientId)
    await window.rpty.invite(clientId)
  }, [])

  const acceptInvite = useCallback(async () => {
    setInvite(null)
    await window.rpty.acceptInvite()
  }, [])

  const declineInvite = useCallback(async () => {
    setInvite(null)
    await window.rpty.declineInvite()
  }, [])

  /** 主动离开房间：relay 会把另一端一起带回列表。 */
  const leaveRoom = useCallback(async () => {
    await window.rpty.leaveRoom()
    setSessions([])
    setActiveId(null)
    setPendingInvite('')
  }, [])

  /**
   * 房间开了：主进程已经把观看范围切到房间，这里只要把标签列铺出来。
   *
   * 顺序很重要 —— 先清空再拉快照，否则上一屏的私有标签会和房间里的混在一起。
   */
  const roomId = room?.id ?? ''
  useEffect(() => {
    if (!roomId) return
    setPrivateNode(null)
    privateNodeRef.current = null
    setSessions([])
    setActiveId(null)
    setInvite(null)
    setPendingInvite('')
    void window.rpty.snapshotSessions().then(applySnapshot)
  }, [roomId, applySnapshot])

  // 房间没了：清屏（原因提示由 onRoomClosed 负责）。
  const prevRoomIdRef = useRef('')
  useEffect(() => {
    if (prevRoomIdRef.current && !roomId) {
      setSessions([])
      setActiveId(null)
    }
    prevRoomIdRef.current = roomId
  }, [roomId])

  // ---------------------------------------------------------- 菜单与快捷键

  const workspaceOpen = !!(room || privateNode)
  const closeOrLeaveRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    closeOrLeaveRef.current = async () => {
      if (roomRef.current) await leaveRoom()
      else if (privateNodeRef.current) await closeWorkspace()
    }
  }, [leaveRoom, closeWorkspace])

  const requestCreateRef = useRef(createSession)
  requestCreateRef.current = createSession

  useEffect(() => {
    const offNotice = window.rpty.onNotice((text: string) => setNotice(text))
    return offNotice
  }, [])

  // Toast 自己退场：8 秒，够读完但不占地方；点一下也能关。
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const offMenu = window.rpty.onMenu((command: MenuCommand, arg?: number) => {
      switch (command) {
        case 'new-tab':
          void requestCreateRef.current()
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
        case 'devices':
          void closeOrLeaveRef.current()
          break
        case 'disconnect':
          // 在工作区里按 ⌘⇧D = 回列表；停在列表上才是断中继。
          if (workspaceOpen) void closeOrLeaveRef.current()
          else void handleDisconnect()
          break
        case 'reconnect':
          // 菜单「重新连接 relay ⌘R」：以前这里错发成 new-tab，按 ⌘R 会开一个终端。
          void handleReconnect()
          break
        default:
          break
      }
    })
    return offMenu
  }, [closeSession, stepTab, gotoTab, toggleReadOnly, handleDisconnect, workspaceOpen])

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

  // ---------------------------------------------------------- 渲染

  // S1：没有连上中继（或用户主动断开）。这一屏只做一件事：建立链路。
  if (detached || !online || status.phase === 'error') {
    return (
      <ConnectScreen
        initialUrl={config.url}
        hasToken={config.hasToken}
        busy={busy}
        error={error}
        detached={detached}
        reason="self"
        onConnect={(url, token) => void handleConnect(url, token)}
        onReconnect={() => void handleReconnect()}
      />
    )
  }

  // S2：上线了、还没进房间 —— 在线客户端列表。
  if (!room && !privateNode) {
    return (
      <>
        <DevicesScreen
          clients={status.clients ?? []}
          selfClientId={status.clientId}
          online={online}
          busy={busy}
          error={error}
          pendingInvite={pendingInvite}
          onInvite={(clientId) => void inviteClient(clientId)}
          onExitRelay={() => void handleDisconnect()}
          onReload={() => void window.rpty.getStatus().then(setStatus)}
          // 入口常驻：没宿主也要能点一次，点了会明确告诉你「本机 agent 没起来」，
          // 而不是把一个按钮藏起来让用户猜自己的终端去哪了。
          onOpenMine={() => void openMine()}
        />
        <InviteDialog
          invite={invite}
          onAccept={() => void acceptInvite()}
          onDecline={() => void declineInvite()}
        />
        <Toast text={notice} onClose={() => setNotice('')} />
      </>
    )
  }

  // S3：一对一房间；或「我的终端」（S2 的入口，视觉上同一套工作区）。
  const activeDevice = (status.nodes ?? []).find((item) => item.node === privateNode)
  // 对方名字可能晚到（它比我后重连，relay 手里还没有它的卡片）：先用在线列表补，
  // 再退到「对方」，别把一个裸 client id 摆到标题栏上。
  const peerLabel = room
    ? room.peer.name ||
      (status.clients ?? []).find((item) => item.client === room.peer.client)?.name ||
      '对方'
    : ''
  const title = room
    ? peerLabel
    : activeDevice
      ? deviceLabel(activeDevice)
      : (privateNode ?? '')
  const banner = !online
    ? status.phase === 'connecting' || status.phase === 'offline'
      ? '正在重连 relay…'
      : 'relay 已断开'
    : room?.phase === 'half'
      ? `对方掉线，正在等它回来（${room.grace ?? 30} 秒内）`
      : !room && !status.agentOnline
        ? '本机宿主不在线'
        : ''

  const visibleActiveId = visibleSessions.some((item) => item.id === activeId)
    ? activeId
    : (visibleSessions[0]?.id ?? null)

  return (
    <div className="app">
      <SessionList
        sessions={visibleSessions}
        activeId={visibleActiveId}
        collapsed={collapsed}
        phase={status.phase}
        agentOnline={room ? true : status.agentOnline}
        hostname={title}
        readOnly={readOnly}
        onSelect={setActiveId}
        onCreate={() => void createSession()}
        onClose={(id) => void closeSession(id)}
        onRename={renameSession}
        onToggle={() => setCollapsed((value) => !value)}
        onToggleReadOnly={() => void toggleReadOnly()}
        onDisconnect={() => void closeOrLeaveRef.current()}
        onBack={() => void closeOrLeaveRef.current()}
        backLabel={room ? '离开通话' : '设备列表'}
        room={!!room}
      />

      <main className="stage">
        {banner && <div className={`banner banner--${status.phase}`}>{banner}</div>}

        <div className={readOnly ? 'panes panes--readonly' : 'panes'}>
          {visibleSessions.map((session) => (
            <TerminalPane
              key={session.id}
              leafId={session.id}
              active={session.id === visibleActiveId}
              readOnly={readOnly}
              sizeLock={
                !session.owned && session.cols && session.rows
                  ? { cols: session.cols, rows: session.rows }
                  : undefined
              }
            />
          ))}

          {visibleSessions.length === 0 && (
            <div className="empty">
              <p className="empty__title">还没有终端</p>
              <p className="empty__hint">
                {room ? '按 ⌘T 在通话里开一个，两边都能看见' : '按 ⌘T 新建一个'}
              </p>
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

        <Toast text={notice} onClose={() => setNotice('')} />
      </main>

      <InviteDialog
        invite={invite}
        onAccept={() => void acceptInvite()}
        onDecline={() => void declineInvite()}
      />
    </div>
  )
}

/** 应用内提示条：主进程说一句就走，不弹模态框、不打断手上的操作。 */
function Toast({ text, onClose }: { text: string; onClose: () => void }): React.JSX.Element | null {
  if (!text) return null
  return (
    <div className="toast toast--info" onClick={onClose} role="presentation">
      {text}
    </div>
  )
}

/** 收到邀请时的弹窗。房间里不弹（已经在通话中）。 */
function InviteDialog({
  invite,
  onAccept,
  onDecline
}: {
  invite: InviteView | null
  onAccept: () => void
  onDecline: () => void
}): React.JSX.Element | null {
  if (!invite) return null
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="modal__box">
        <h2 className="modal__title">通话邀请</h2>
        <p className="modal__body">
          「{invite.name || invite.client.slice(0, 8)}」邀请你进入一对一私密通话。
        </p>
        <p className="modal__hint">
          同意后你们两个人的终端会合到同一个工作区，只有你们两个人看得见。
        </p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onDecline}>
            拒绝
          </button>
          <button type="button" className="btn btn--primary" onClick={onAccept}>
            同意
          </button>
        </div>
      </div>
    </div>
  )
}

export type { SessionState }
