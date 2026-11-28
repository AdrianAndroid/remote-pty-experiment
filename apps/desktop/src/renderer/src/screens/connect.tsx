/**
 * 连接页：第一次用、连不上，或者手动断开之后停在这里。
 *
 * token 由主进程保存，不回传渲染层，所以这里留空表示「沿用已保存的」。
 * 手动断开过（detached）时走简化视图：一个「连接」按钮，地址与 token 都沿用，
 * 不想改配置的人不用再看一遍表单。
 *
 * 断开 WSS 就是断开，回到这里重新「连接」—— 不是"重连"：连接是一次新的握手，
 * 跟刚才那条连接没有继承关系。
 */

import { useEffect, useState } from 'react'

interface ConnectScreenProps {
  initialUrl: string
  hasToken: boolean
  busy: boolean
  error: string
  /** 是「手动断开」回来的，不是首次配置 / 连不上 */
  detached?: boolean
  /** self = 自己点的；peer = 另一端点了，把这条链路一起带走 */
  reason?: 'self' | 'peer'
  /** 断开的是谁（relay 认识的客户端名） */
  peerName?: string
  onConnect: (url: string, token: string) => void
  onReconnect?: () => void
}

export function ConnectScreen({
  initialUrl,
  hasToken,
  busy,
  error,
  detached = false,
  reason = 'self',
  peerName = '',
  onConnect,
  onReconnect
}: ConnectScreenProps): React.JSX.Element {
  const [url, setUrl] = useState(initialUrl)
  const [token, setToken] = useState('')
  const [showForm, setShowForm] = useState(!detached)

  useEffect(() => {
    setUrl(initialUrl)
  }, [initialUrl])

  useEffect(() => {
    if (detached) setShowForm(false)
  }, [detached])

  const canSubmit = url.trim().length > 0 && (token.trim().length > 0 || hasToken) && !busy

  if (detached && !showForm) {
    return (
      <div className="connect">
        <div className="connect__card">
          <div className="connect__logo">▚ rpty</div>
          <p className="connect__standby">
            {reason === 'peer'
              ? peerName
                ? `「${peerName}」已断开连接`
                : '另一端已断开连接'
              : '已断开与 relay 的连接'}
          </p>
          <p className="connect__hint">
            {reason === 'peer'
              ? `${
                  peerName ? `客户端「${peerName}」` : '另一台客户端'
                }点了「断开连接」，这条链路的两端一起断。宿主机上的终端还在跑，重连后原样回来。`
              : '宿主机上的终端还在跑，重连后会原样回来 —— 断开只是这台机器不再收画面。'}
          </p>

          {error && <div className="connect__error">{error}</div>}

          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => onReconnect?.()}
          >
            {busy ? '连接中…' : '连接'}
          </button>

          <button type="button" className="connect__link" onClick={() => setShowForm(true)}>
            修改地址或 token
          </button>

          <p className="connect__foot">
            当前地址 <code>{url || '未保存'}</code>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="connect">
      <div className="connect__card">
        <div className="connect__logo">▚ rpty</div>
        <p className="connect__hint">连到你的 relay，打开远端那台 Mac 上的终端。</p>

        <label className="field">
          <span className="field__label">relay 地址</span>
          <input
            className="field__input"
            value={url}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="wss://relay.example.com"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) onConnect(url.trim(), token.trim())
            }}
          />
        </label>

        <label className="field">
          <span className="field__label">
            token
            {hasToken && <em className="field__saved">已保存，留空沿用</em>}
          </span>
          <input
            className="field__input"
            type="password"
            value={token}
            spellCheck={false}
            autoCapitalize="none"
            placeholder={hasToken ? '••••••••••••' : '粘贴 rpty token'}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) onConnect(url.trim(), token.trim())
            }}
          />
        </label>

        {error && <div className="connect__error">{error}</div>}

        <button
          type="button"
          className="btn btn--primary"
          disabled={!canSubmit}
          onClick={() => onConnect(url.trim(), token.trim())}
        >
          {busy ? '连接中…' : '连接'}
        </button>

        {detached && (
          <button type="button" className="connect__link" onClick={() => setShowForm(false)}>
            返回
          </button>
        )}

        <p className="connect__foot">
          被控端需要先跑起 <code>rpty_agent.py</code>
        </p>
      </div>
    </div>
  )
}
