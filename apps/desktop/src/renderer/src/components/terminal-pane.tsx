/**
 * 单个终端面板。
 *
 * 关键点（都是踩过的坑）：
 *   - 必须先 terminal.open() 再挂 WebGL，否则 addon 拿不到尺寸
 *   - 隐藏时不能 fit()，量出来是 0，会把 cols 打成 2
 *   - 切回时「移除 display:none → 等一帧 → fit → 挂 WebGL」，顺序不能换
 *   - 隐藏时 detach WebGL，不然 20 个会话会各自持有 GPU 上下文，很快就崩
 */

import { useCallback, useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { installKeyPolicy } from '../lib/key-policy'
import { TERMINAL_OPTIONS } from '../lib/terminal-options'

interface TerminalPaneProps {
  leafId: string
  active: boolean
  /** 只读：画面照常刷新，但键盘输入被吃掉，不发给被控端 */
  readOnly?: boolean
}

export function TerminalPane({
  leafId,
  active,
  readOnly = false
}: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)

  const attachWebgl = useCallback(() => {
    const term = termRef.current
    if (!term || webglRef.current) return
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webglRef.current = null
        try {
          webgl.dispose()
        } catch {
          // ignore
        }
      })
      term.loadAddon(webgl)
      webglRef.current = webgl
    } catch {
      // 没有 GPU 就走 DOM 渲染，功能不受影响，只是慢一点。
    }
  }, [])

  const detachWebgl = useCallback(() => {
    const webgl = webglRef.current
    webglRef.current = null
    if (!webgl) return
    try {
      webgl.dispose()
    } catch {
      // ignore
    }
  }, [])

  // 创建实例，只在 leafId 变化时重建。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal(TERMINAL_OPTIONS)
    const fit = new FitAddon()
    term.loadAddon(fit)

    try {
      const unicode = new Unicode11Addon()
      term.loadAddon(unicode)
      term.unicode.activeVersion = '11'
    } catch {
      // 旧内核可能不支持，不影响主流程。
    }

    term.loadAddon(new WebLinksAddon())

    // open 必须早于 WebGL attach。
    term.open(host)

    termRef.current = term
    fitRef.current = fit

    installKeyPolicy(term)
    term.onData((data) => window.rpty.write(leafId, data))
    term.onResize(({ cols, rows }) => window.rpty.resize(leafId, cols, rows))

    try {
      fit.fit()
    } catch {
      // 容器刚挂载，量不到尺寸，等 ResizeObserver 兜底。
    }

    const offData = window.rpty.onData(({ leafId: incoming, data }) => {
      if (incoming === leafId) term.write(data)
    })

    // 订阅建好之后再通知主进程「可以灌了」，这样攒住的快照和增量才有人接。
    window.rpty.ready(leafId)

    const observer = new ResizeObserver(() => {
      if (!active) return
      try {
        fit.fit()
      } catch {
        // ignore
      }
    })
    observer.observe(host)

    return () => {
      offData()
      observer.disconnect()
      detachWebgl()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // active 是刻意的「不稳定依赖」：重建代价高，只用 leafId 决定生命周期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafId])

  // 只读开关：xterm 自己就能挡住键盘，主进程再挡一道，双保险。
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.disableStdin = readOnly
    if (readOnly) {
      // 收起焦点框，视觉上也别让人以为能敲。
      term.blur()
    } else if (active) {
      term.focus()
    }
  }, [readOnly, active])

  // 可见性切换：attach/detach WebGL + 延迟一帧 fit。
  useEffect(() => {
    if (!active) {
      detachWebgl()
      return
    }

    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      attachWebgl()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, attachWebgl, detachWebgl])

  return (
    <div
      className={
        active
          ? readOnly
            ? 'pane pane--active pane--readonly'
            : 'pane pane--active'
          : readOnly
            ? 'pane pane--readonly'
            : 'pane'
      }
      aria-hidden={!active}
    >
      <div ref={hostRef} className="pane__host" />
    </div>
  )
}
