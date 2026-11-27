/**
 * 连接页：第一次用，或者 relay 连不上时停在这里。
 *
 * token 由主进程保存，不回传渲染层，所以这里留空表示「沿用已保存的」。
 */

import { useState } from 'react'

interface ConnectScreenProps {
  initialUrl: string
  hasToken: boolean
  busy: boolean
  error: string
  onConnect: (url: string, token: string) => void
}

export function ConnectScreen({
  initialUrl,
  hasToken,
  busy,
  error,
  onConnect
}: ConnectScreenProps): React.JSX.Element {
  const [url, setUrl] = useState(initialUrl)
  const [token, setToken] = useState('')

  const canSubmit = url.trim().length > 0 && (token.trim().length > 0 || hasToken) && !busy

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
            placeholder="wss://rpty.zhaojian.xin"
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

        <p className="connect__foot">
          被控端需要先跑起 <code>rpty_agent.py</code>
        </p>
      </div>
    </div>
  )
}
