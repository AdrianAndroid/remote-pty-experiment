/**
 * 主进程 <-> 渲染进程的 IPC 契约。
 *
 * 与阶段 1 的单会话契约不同，这里所有方法都带 leafId —— 一个在渲染层
 * 生成的稳定 UUID，重排标签、断线重连都不会变。agent 那边认的是
 * sessionId，两者在主进程里做映射。
 */

import type { SessionState } from './protocol'

export const IpcChannel = {
  /** 渲染 -> 主：连接 relay */
  RelayConnect: 'relay:connect',
  /** 渲染 -> 主：断开 */
  RelayDisconnect: 'relay:disconnect',
  /** 渲染 -> 主：用已保存的地址与 token 重连（断开之后回来） */
  RelayReconnect: 'relay:reconnect',
  /** 渲染 -> 主：连接状态查询 */
  RelayStatus: 'relay:status',
  /** 渲染 -> 主：读取已保存的地址与「是否有 token」 */
  ConfigInfo: 'config:info',
  /** 渲染 -> 主：进入 / 离开自己的桌面（null = 回设备列表，不为任何会话开数据通道） */
  NodeActivate: 'node:activate',

  /** 渲染 -> 主：房间。输密码直接配对 / 主动离开 */
  RoomJoin: 'room:join',
  RoomLeave: 'room:leave',
  /** 渲染 -> 主：查 / 改自己的通话密码 */
  PasswordInfo: 'auth:password-info',
  PasswordSet: 'auth:set-password',

  /** 渲染 -> 主：开一个会话 */
  SessionCreate: 'session:create',
  SessionWrite: 'session:write',
  SessionResize: 'session:resize',
  SessionClose: 'session:close',
  SessionList: 'session:list',
  /** 渲染 -> 主：拉当前所有会话（窗口加载晚于 relay 连接时，adopt 事件已经过去了） */
  SessionSnapshot: 'session:snapshot',
  /** 渲染 -> 主：这个面板的 xterm 已经挂好了，可以开始灌字节 */
  SessionReady: 'session:ready',

  /** 只读模式：渲染 -> 主 查询/切换，主 -> 渲染 广播 */
  ReadOnlyGet: 'readonly:get',
  ReadOnlySet: 'readonly:set',
  ReadOnlyChanged: 'readonly:changed',

  /** 主 -> 渲染：推送 */
  /** 主 -> 渲染：发现被控端上已有会话（别的客户端开的），自动挂上去镜像 */
  SessionAdopted: 'session:adopted',
  /** 主 -> 渲染：会话归属变了（relay 认出了主人，或另一个窗口开了/关了它） */
  SessionOwned: 'session:owned',
  /** 主 -> 渲染：整个节点的终端都没了（宿主退出 / 离线超时），把标签一起摘掉 */
  SessionRemoved: 'session:removed',
  /** 主 -> 渲染：PTY 尺寸变了（创建端改了窗口），镜像端要跟着锁到新尺寸 */
  SessionResized: 'session:resized',
  SessionData: 'session:data',
  SessionStateChanged: 'session:state',
  SessionExit: 'session:exit',
  RelayStatusChanged: 'relay:status-changed',
  /** 主 -> 渲染：房间关了（对方离开 / 宽限超时） */
  RelayRoomClosed: 'relay:room-closed',
  RelayError: 'relay:error',
  /** 主 -> 渲染：菜单命令 */
  MenuCommand: 'menu:command',
  /** 主 -> 渲染：一句提示（应用内 Toast，不弹模态框） */
  AppNotice: 'app:notice'
} as const

export type MenuCommand =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'goto-tab'
  | 'toggle-sidebar'
  | 'toggle-readonly'
  | 'devices'
  | 'disconnect'
  | 'reconnect'

export interface ConfigInfo {
  url: string
  hasToken: boolean
}

export interface RelayConfig {
  url: string
  token: string
}

export type ConnectionPhase = 'idle' | 'connecting' | 'online' | 'offline' | 'error'

/** 一台可被开终端的机器（跑着宿主进程）。 */
export interface NodeInfo {
  /** 节点标识，创建会话时作为 target */
  node: string
  /** 展示名，通常是主机名 */
  name: string
  platform?: string
  online: boolean
  /** 这台机器上现有的会话数 */
  sessions: number
}

/** 在线客户端：用户看到的就是这个列表，断开 WSS 就从列表里消失。 */

export interface ClientInfo {
  /** 客户端 id：固定，不重装不变 */
  client: string
  /** 客户端名字：`<主机短名>-<4 位码>` */
  name: string
  /** 它认领的宿主 node id（本机 agent）；没认领就是空 */
  host: string
  /** 宿主显示名，认领不上时为空 */
  host_name?: string
  host_online?: boolean
  /** 宿主上现有会话数 */
  sessions?: number
  /** 正在私密通话中：列表上点不动，但不写对方是谁 */
  busy?: boolean
  /** 在通话中，但一方掉线正在等重连（宽限期） */
  reconnecting?: boolean
  /** 这个客户端已经上报过密码：false = 老客户端，点也进不去 */
  password?: boolean
  /** 它还在用默认密码 admin123：卡片上要标出来（不泄露密码本身） */
  password_default?: boolean
}

/** 一对一房间里的对方。只有「名字 + 宿主」，没有更多 —— 房间里的事不外泄。 */
export interface RoomPeer {
  client: string
  name: string
  /** 对方的宿主 node id：房间里新建终端可以落在它上面 */
  host?: string
}

/** 一对一私密房间。有它就是 S3，没有就是 S2。 */
export interface RoomView {
  id: string
  peer: RoomPeer
  /** open = 两个人都在；half = 对方掉线，宽限期内在等它回来 */
  phase: 'open' | 'half'
  /** half 时的剩余秒数（粗粒度，界面只用来显示「重连中」） */
  grace?: number
  /** 是不是我发起的邀请 */
  initiator: boolean
}

/** 自己的通话密码。明文只在客户端本地，界面要能看见/修改它。 */
export interface PasswordInfo {
  password: string
  /** 还是出厂默认的 admin123：要在界面上显性提示 */
  isDefault: boolean
}

/** 配对结果：密码错、对方忙、对方离线都在这里回给弹窗，不写全局错误条。 */
export interface JoinResult {
  ok: boolean
  code?: string
  message?: string
}

export interface RelayStatus {
  phase: ConnectionPhase
  agentOnline: boolean
  /** 被控端上报的主机名，连上后才有 */
  hostname?: string
  /** 当前在线的所有节点（多机场景） */
  nodes?: NodeInfo[]
  /** 这个客户端自己的名字：首次运行生成，不删数据目录就不变 */
  clientName?: string
  /** 自己的客户端 id：用来在客户端列表里认出「我」 */
  clientId?: string
  /** relay 内存里的在线客户端列表 */
  clients?: ClientInfo[]
  /** 当前所在的房间；null = 停在列表（S2） */
  room?: RoomView | null
  /** 自己还在用默认密码 admin123 */
  passwordIsDefault?: boolean
  message?: string
}

export interface SessionCreateOptions {
  leafId: string
  cols: number
  rows: number
  shell?: string
  /** 在哪个节点上开。省略时由 relay 决定（只有一个节点在线就用它） */
  target?: string
}

export interface SessionCreateResult {
  ok: boolean
  sessionId?: string
  pid?: number
  title?: string
  error?: string
}

export interface SessionDataPayload {
  leafId: string
  /** 终端原始字节。用 Uint8Array 而非 string，避免多字节字符被截断。 */
  data: Uint8Array
}

export interface SessionStatePayload {
  leafId: string
  state: SessionState
  message?: string
}

export interface SessionAdoptedPayload {
  leafId: string
  sessionId: string
  cols: number
  rows: number
  /** true = 这个 PTY 是本窗口建的；false = 别的窗口建的，这里只是镜像 */
  owned: boolean
  /** 全局序号（relay 分配），所有客户端靠它对齐 */
  index: number
  /** 这个会话属于哪个节点 */
  node?: string
  /** 这个会话属于哪个客户端（client id）：每个客户端各看各的桌面 */
  owner?: string
}

export interface SessionResizedPayload {
  leafId: string
  cols: number
  rows: number
}

export interface SessionExitPayload {
  leafId: string
  exitCode?: number
}

export interface RelayErrorPayload {
  code: string
  message: string
}

/** 通过 contextBridge 暴露到 window.rpty 的能力集合。 */
export interface RptyBridge {
  connect(config: RelayConfig): Promise<RelayStatus>
  disconnect(): Promise<void>
  /** 断开之后回来：用保存的地址与 token 重连，不需要重新输入 */
  reconnect(): Promise<RelayStatus>
  getStatus(): Promise<RelayStatus>
  getConfigInfo(): Promise<ConfigInfo>
  /** 进自己的桌面（node），或传 null 回到设备列表 */
  activateNode(node: string | null): Promise<void>

  /** 输密码直接配对：对了立刻建房，没有「对方同意」这一步 */
  joinRoom(clientId: string, password: string): Promise<JoinResult>
  /** 主动离开房间：两个人一起回列表 */
  leaveRoom(): Promise<void>
  /** 读 / 改自己的通话密码（别人连进来要过的门） */
  getPasswordInfo(): Promise<PasswordInfo>
  setPassword(password: string): Promise<JoinResult>

  create(options: SessionCreateOptions): Promise<SessionCreateResult>
  write(leafId: string, data: string): void
  resize(leafId: string, cols: number, rows: number): void
  close(leafId: string): Promise<void>
  list(): Promise<string[]>
  snapshotSessions(): Promise<SessionAdoptedPayload[]>
  ready(leafId: string): void

  /** 只读：连上了、画面在刷，但键盘/粘贴/尺寸都不发给被控端 */
  getReadOnly(): Promise<boolean>
  setReadOnly(readOnly: boolean): Promise<boolean>
  onReadOnly(handler: (readOnly: boolean) => void): () => void

  onData(handler: (payload: SessionDataPayload) => void): () => void
  onState(handler: (payload: SessionStatePayload) => void): () => void
  onExit(handler: (payload: SessionExitPayload) => void): () => void
  onAdopted(handler: (payload: SessionAdoptedPayload) => void): () => void
  onOwned(handler: (payload: { leafId: string; owned: boolean }) => void): () => void
  onRemoved(handler: (payload: { leafId: string }) => void): () => void
  onResized(handler: (payload: SessionResizedPayload) => void): () => void
  onStatus(handler: (payload: RelayStatus) => void): () => void
  /** 房间关了：回列表并说明是对方离开还是超时 */
  onRoomClosed(
    handler: (payload: { reason: string; peerName: string; byMe?: boolean }) => void
  ): () => void
  onError(handler: (payload: RelayErrorPayload) => void): () => void
  /** 主进程的一句提示：渲染层用 Toast 显示，不打断操作 */
  onNotice(handler: (text: string) => void): () => void
  onMenu(handler: (command: MenuCommand, arg?: number) => void): () => void
}
