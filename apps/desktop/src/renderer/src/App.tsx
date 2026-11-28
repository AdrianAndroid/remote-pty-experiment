/**
 * 应用外壳：决定显示连接页还是工作区，并持有会话列表。
 *
 * 会话列表放在这里而不是 TerminalPane 里，因为「切换标签」只是换一个
 * display 状态，xterm 实例不能重建 —— 重建会丢掉回滚缓冲和正在跑的程序。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigInfo,
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

const TAB_STORE_KEY = 'rpty.tabs.v1'

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
  const [readOnly, setReadOnly] = useState(false)
  const [error, setError] = useState('')
  /** 手动断开过：连接页要显示「已断开 + 重新连接」，而不是首次配置的样子 */
  const [detached, setDetached] = useState(false)
  /** 是对方断开把我这边的链路也带走的（不是我自己点的） */
  const [peerClosed, setPeerClosed] = useState(false)
  /** 断开的那一端叫什么（relay 认识它的话） */
  const [peerName, setPeerName] = useState('')
  /** 当前进入的设备；null = 停在设备列表，不为任何会话开数据通道 */
  const [activeNode, setActiveNode] = useState<string | null>(null)
  /** 我进的是哪个客户端（同机多客户端时，宿主 node 可能一样，名字要按客户端算） */
  const [activeClientId, setActiveClientId] = useState<string | null>(null)
  /** 上面那个的 ref：进/离开要在 await 之前就落值 */
  const activeClientRef = useRef<string | null>(null)
  /** leaveDevice 的 ref：键盘菜单回调注册在它定义之前 */
  const leaveDeviceRef = useRef<() => Promise<void>>(async () => {})
  /** client id -> 名字快照：对方掉线后名字没了，提示里还得能叫出它 */
  const clientNamesRef = useRef<Record<string, string>>({})
  /** 多台机器在线时，新建终端要先问一句开在哪台 */

  /**
   * 「我」= 我的客户端。列表按客户端展示，所以自己那条直接按 client id 认，
   * 不再用主机名猜（主机名只在客户端内部"认领宿主"那一步用一次）。
   */
  const mySelf = (status.clients ?? []).find((item) => item.client === status.clientId)
  /** 我认领的宿主：自己机器上跑 PTY 的那个 agent。只有它上面的标签才落盘 */
  const ownHostNode = mySelf?.host ?? ''

  const statusRef = useRef(status)
  statusRef.current = status

  const seqRef = useRef(0)
  const readOnlyRef = useRef(false)
  const activeNodeRef = useRef<string | null>(null)
  /** 我认领的宿主 node id：只有它的标签才落盘 */
  const ownHostRef = useRef('')
  ownHostRef.current = ownHostNode
  /** 我自己的 client id：判断"这张桌面是不是我的"，决定标签要不要落盘 */
  const myClientIdRef = useRef('')
  myClientIdRef.current = status.clientId ?? ''
  /** 进设备时要从存储里选回来的那个 sessionId（只生效一次） */
  const pendingActiveRef = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const sessionsRef = useRef<SessionMeta[]>([])
  activeIdRef.current = activeId
  readOnlyRef.current = readOnly
  activeNodeRef.current = activeNode
  sessionsRef.current = sessions

  // ---------------------------------------------------------- 初始化

  /**
   * 把当前标签列写回本地存储。
   *
   * 只在确实有标签时写：离开设备 / 刚进设备还没拿到快照时都是空列，
   * 那种空白不能覆盖掉上次的记录。
   */
  const persistTabs = useCallback(() => {
    // 只维护自己桌面上的标签：进别人的客户端看到的是对方的终端，不落盘
    const key = activeClientRef.current
    if (!key || key !== myClientIdRef.current || sessionsRef.current.length === 0) return
    const items = sessionsRef.current
      .filter((item) => item.sessionId)
      .map((item, index) => ({
        sessionId: item.sessionId as string,
        title: item.title,
        order: item.order ?? index
      }))
    if (items.length === 0) return
    const store = readTabStore()
    store[key] = {
      active:
        sessionsRef.current.find((item) => item.id === activeIdRef.current)?.sessionId ?? null,
      items
    }
    writeTabStore(store)
  }, [])

  /** 把主进程的会话快照合进标签列（按 leafId 去重，可以反复调）。 */
  const applySnapshot = useCallback((list: SessionAdoptedPayload[]) => {
    if (!Array.isArray(list) || list.length === 0) return
    // 上次这个设备留下的标题 / 顺序 / 选中，按 sessionId 对回去
    const saved =
      activeClientRef.current && activeClientRef.current === myClientIdRef.current
        ? readTabStore()[activeClientRef.current]
        : undefined
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

  // 标签列、顺序、选中变了就落盘（persistTabs 自己会跳过空列）
  useEffect(() => {
    persistTabs()
  }, [sessions, activeId, persistTabs])

  useEffect(() => {
    void window.rpty.getConfigInfo().then(setConfig)
    void window.rpty.getStatus().then(setStatus)
    void window.rpty.getReadOnly().then(setReadOnly)
    // 主进程比窗口先连上 relay，adopt 事件在那之前就发完了；这里补拉一次当前会话。
    void window.rpty.snapshotSessions().then(applySnapshot)
  }, [applySnapshot])

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
    const offAdopted = window.rpty.onAdopted(
      ({ leafId, sessionId, owned, index, cols, rows, node, owner }) => {
        setSessions((prev) => {
          if (prev.some((item) => item.id === leafId)) return prev
          if (index > seqRef.current) seqRef.current = index
          // 同一个 PTY 上次摆在哪、叫什么，按 sessionId 找回来
          const saved = readTabStore()[owner || activeClientRef.current || '']?.items.find(
            (item) => item.sessionId === sessionId
          )
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

    // 归属可能后到：relay 认出这个终端是谁开的，或者另一个窗口刚把它关掉。
    const offOwned = window.rpty.onOwned(({ leafId, owned }) => {
      setSessions((prev) => prev.map((item) => (item.id === leafId ? { ...item, owned } : item)))
    })

    // 宿主整台机器没了：这一批标签整批消失，不是置灰。
    const offRemoved = window.rpty.onRemoved(({ leafId }) => {
      setSessions((prev) => {
        const next = prev.filter((item) => item.id !== leafId)
        if (activeIdRef.current === leafId) {
          setActiveId(next.length > 0 ? next[next.length - 1].id : null)
        }
        return next
      })
    })

    // 创建端改了窗口：PTY 行列变了，镜像端要换锁，否则换行位置对不上。
    const offResized = window.rpty.onResized(({ leafId, cols, rows }) => {
      setSessions((prev) =>
        prev.map((item) => (item.id === leafId ? { ...item, cols, rows } : item))
      )
    })

    const offError = window.rpty.onError(({ code, message }) => {
      setError(message ? `${message}（${code}）` : code)
    })

    const offReadOnly = window.rpty.onReadOnly((value) => setReadOnly(value))

    // 另一端主动断开：这条链路算一组，本端跟着断，且不自动重连。
    const offPeerClosed = window.rpty.onPeerClosed((payload) => {
      setPeerName(payload?.name ?? '')
      setSessions([])
      setActiveId(null)
      setStatus({ phase: 'idle', agentOnline: false })
      setActiveNode(null)
      setPeerClosed(true)
      setDetached(true)
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
      offPeerClosed()
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
        setPeerClosed(false)
        setActiveNode(null)
        void window.rpty.getConfigInfo().then(setConfig)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * 断开连接：只断这台客户端到 relay 的链路，宿主上的 PTY 一个都不动。
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
      setActiveNode(null)
      setPeerClosed(false)
      setDetached(true)
    }
  }, [])

  /** 重连：地址与 token 都在主进程里，这里不需要用户再输一次。 */
  const handleReconnect = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const next = await window.rpty.reconnect()
      setStatus(next)
      if (next.phase === 'error') setError(next.message ?? '重连失败')
      else {
        setDetached(false)
        setPeerClosed(false)
        setActiveNode(null)
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

  const createSession = useCallback(async (target?: string) => {
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
    setSessions((prev) => {
      const maxOrder = prev.reduce((max, item) => Math.max(max, item.order ?? -1), -1)
      return [
        ...prev,
        {
          id: leafId,
          title,
          state: 'connecting',
          owned: true,
          owner: activeClientRef.current ?? myClientIdRef.current,
          node: target,
          order: maxOrder + 1
        }
      ]
    })
    setActiveId(leafId)
    const result = await window.rpty.create({ leafId, cols, rows, target })
    if (!result.ok) {
      setSessions((prev) => prev.filter((item) => item.id !== leafId))
      setError(result.error ?? '创建终端失败')
      return
    }
    // 认领身份：有了 sessionId，这个标签重连之后才能带着标题和位置回来
    if (result.sessionId) {
      const sessionId = result.sessionId
      setSessions((prev) => {
        const maxOrder = prev.reduce((max, item) => Math.max(max, item.order ?? -1), -1)
        return prev.map((item) =>
          item.id === leafId
            ? { ...item, sessionId, order: item.order ?? maxOrder + 1 }
            : item
        )
      })
    }
  }, [])

  /**
   * 「新建终端」：只开在当前进入的这台设备上。
   *
   * 已经站在某台机器里，再问「开在哪台」没有意义 —— 选机器是上一屏的事。
   */
  const requestCreate = useCallback(() => {
    const node = activeNodeRef.current
    if (!node) return
    void createSession(node)
  }, [createSession])

  // 一张桌面一套终端：我站在谁的客户端里，就只看那个客户端的终端。
  // 老的、没带 owner 的行照旧显示，免得历史会话突然消失。
  const viewClientId = activeClientId ?? status.clientId ?? ''
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (item) => !item.owner || !viewClientId || item.owner === viewClientId
      ),
    [sessions, viewClientId]
  )

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

  // ---------------------------------------------------------- 菜单与快捷键

  useEffect(() => {
    const offMenu = window.rpty.onMenu((command: MenuCommand, arg?: number) => {
      switch (command) {
        case 'new-tab':
          requestCreate()
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
          if (activeNodeRef.current) void leaveDevice()
          break
        case 'disconnect':
          // 在别人客户端里按 ⌘⇧D = 离开（回列表）；停在列表上才是断中继。
          if (activeNodeRef.current) void leaveDeviceRef.current()
          else void handleDisconnect()
          break
        default:
          break
      }
    })
    return offMenu
  }, [
    requestCreate,
    createSession,
    closeSession,
    stepTab,
    gotoTab,
    toggleReadOnly,
    handleDisconnect
  ])

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

  // ---------------------------------------------------------- 设备

  /**
   * 进入一台设备：先让主进程只为这个节点的会话开数据通道，再拉一次快照铺标签。
   *
   * 顺序不能反 —— 反了的话 adopt 事件会先涌进来，刚铺好的标签又被清一次。
   */
  const enterDevice = useCallback(
    async (node: string, clientId: string | null) => {
      setError('')
      setActiveClientId(clientId)
      setSessions([])
      setActiveId(null)
      // 先落 ref 再 await：主进程会立刻按缓存 adopt 并推事件回来，
      // 那时 useState 还没生效，靠 ref 才知道这是哪台设备（否则标题/顺序对不上）。
      activeNodeRef.current = node
      activeClientRef.current = clientId
      pendingActiveRef.current = readTabStore()[clientId ?? node]?.active ?? null
      await window.rpty.activateNode(node, clientId)
      setActiveNode(node)
      const list = await window.rpty.snapshotSessions()
      applySnapshot(list)
    },
    [applySnapshot]
  )

  /** 离开设备：撤画面、不动 PTY。列表页继续抱着中继连接。 */
  const leaveDevice = useCallback(async () => {
    activeNodeRef.current = null
    activeClientRef.current = null
    await window.rpty.activateNode(null, null)
    setActiveNode(null)
    setActiveClientId(null)
    setSessions([])
    setActiveId(null)
    setError('')
  }, [])

  useEffect(() => {
    leaveDeviceRef.current = leaveDevice
  }, [leaveDevice])

  useEffect(() => {
    for (const item of status.clients ?? []) clientNamesRef.current[item.client] = item.name || ''
  }, [status.clients])

  /**
   * 有人配对我（进我的客户端）→ 我也自动进终端列表。
   *
   * 配对是双向的：对方那边已经站在我的终端前面了，我这边还停在列表上就没意义。
   * 只在"新出现一个配对"时进一次，之后自己按「离开」回来不会被再拽进去。
   *
   * 注意这里只处理「对方显式配对」，不含「自己上线」：启动一律停在设备列表，
   * 见 openspec/changes/start-at-device-list。
   */
  const autoEnterKeyRef = useRef('')
  useEffect(() => {
    if (status.phase !== 'online') return
    const incoming = (status.pairs ?? []).filter((pair) => pair.to === status.clientId)
    if (incoming.length === 0) {
      autoEnterKeyRef.current = ''
      return
    }
    if (activeNode || !ownHostNode) return
    const key = incoming
      .map((pair) => pair.from)
      .sort()
      .join(',')
    if (autoEnterKeyRef.current === key) return
    autoEnterKeyRef.current = key
    // 进自己的宿主，不带配对目标（main 那边也会跳过自配）
    void enterDevice(ownHostNode, status.clientId ?? null)
  }, [status.pairs, status.phase, status.clientId, activeNode, ownHostNode, enterDevice])

  /**
   * 我进的那个客户端没了（对方点「断开中继」或关了窗口）→ 自动回列表。
   *
   * 不能卡在一个已经不存在的客户端上：那样顶部只能拿节点名硬凑一个名字，
   * 看起来就像"我自己"。
   */
  useEffect(() => {
    if (!activeClientId || status.phase !== 'online') return
    const list = status.clients ?? []
    if (list.length === 0) return
    if (list.some((item) => item.client === activeClientId)) return
    const name = clientNamesRef.current[activeClientId] || ''
    // leaveDevice 自己会清 error，所以提示要等它清完再写
    void leaveDevice().then(() =>
      setError(name ? `「${name}」已断开中继 · 已回到在线列表` : '对方客户端已断开中继 · 已回到在线列表')
    )
  }, [status.clients, status.phase, activeClientId, leaveDevice])

  // ---------------------------------------------------------- 渲染

  const online = status.phase === 'online'

  // 中继连着、但还没选机器：停在设备列表。这一屏不为任何会话开数据通道。
  if (!detached && online && !activeNode) {
    return (
      <DevicesScreen
        clients={status.clients ?? []}
        selfClientId={status.clientId}
        pairs={status.pairs ?? []}
        online={online}
        busy={busy}
        error={error}
        onPick={(host, clientId) => void enterDevice(host, clientId)}
        onExitRelay={() => void handleDisconnect()}
        onReload={() => void window.rpty.getStatus().then(setStatus)}
        onOpenMine={
          ownHostNode
            ? () => {
                // 回自己的桌面：不带配对目标，main 侧也会跳过自配
                void enterDevice(ownHostNode, status.clientId ?? null)
              }
            : undefined
        }
      />
    )
  }

  const showWorkspace = activeNode !== null && (online || sessions.length > 0)
  // 侧栏显示的是「现在这台设备」，不是本机名
  const activeDevice = (status.nodes ?? []).find((item) => item.node === activeNode)
  // 工作区顶部写的是「我进的是哪个客户端」，不是主机名
  const activeClient =
    (status.clients ?? []).find((item) => item.client === activeClientId) ??
    (status.clients ?? []).find((item) => item.host === activeNode && item.client !== status.clientId)
  const deviceName = activeClient?.name ?? (activeDevice ? deviceLabel(activeDevice) : (activeNode ?? ''))
  // relay 那边确认了配对才显示「已配对」—— 自己点进列表不算数。
  // 两种情况都算：我进了别人（from 是我），或别人进了我（to 是我、我正站在自己宿主上）。
  const pairedWith =
    (status.pairs ?? []).find(
      (pair) => pair.from === status.clientId && pair.to === activeClientId
    )?.to_name ??
    (activeNode && activeNode === ownHostNode
      ? (status.pairs ?? []).find((pair) => pair.to === status.clientId)?.from_name
      : '') ??
    ''

  if (detached || !showWorkspace) {
    return (
      <ConnectScreen
        initialUrl={config.url}
        hasToken={config.hasToken}
        busy={busy}
        error={error}
        detached={detached}
        reason={peerClosed ? 'peer' : 'self'}
        peerName={peerName}
        onConnect={(url, token) => void handleConnect(url, token)}
        onReconnect={() => void handleReconnect()}
      />
    )
  }

  const visibleActiveId = visibleSessions.some((item) => item.id === activeId)
    ? activeId
    : (visibleSessions[0]?.id ?? null)

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
        sessions={visibleSessions}
        activeId={visibleActiveId}
        collapsed={collapsed}
        phase={status.phase}
        agentOnline={status.agentOnline}
        hostname={deviceName}
        readOnly={readOnly}
        onSelect={setActiveId}
        onCreate={requestCreate}
        onClose={(id) => void closeSession(id)}
        onRename={renameSession}
        onToggle={() => setCollapsed((value) => !value)}
        onToggleReadOnly={() => void toggleReadOnly()}
        onDisconnect={() => void leaveDevice()}
        onBack={() => void leaveDevice()}
        backLabel="客户端"
        pairedWith={pairedWith}
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
              <p className="empty__hint">按 ⌘T 新建一个</p>
              <button type="button" className="btn btn--primary" onClick={requestCreate}>
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
