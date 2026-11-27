/**
 * 单个终端面板。
 *
 * 尺寸有两种模式，不能混：
 *   - 创建端（没有 sizeLock）：PTY 跟着自己的窗口走，fit() 量出多少就是多少。
 *   - 镜像端（有 sizeLock）：行列必须**严格等于** PTY 的行列，一律不 fit。
 *     一旦行列不同，claude / top / vim 这类用绝对光标定位的 TUI 会整体错位，
 *     屏幕上就是文字重叠、内容串行。容器装不下时用 CSS 等比缩放，
 *     缩放不改变 xterm 内部度量，所以行列还是对的，只是字小一点。
 *
 * 其它踩过的坑：
 *   - 必须先 terminal.open() 再挂 WebGL，否则 addon 拿不到尺寸
 *   - 隐藏时不能量尺寸，量出来是 0，会把 cols 打成 2
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
  /** 镜像端专用：把 xterm 锁到 PTY 的 cols/rows */
  sizeLock?: { cols: number; rows: number }
}

export function TerminalPane({
  leafId,
  active,
  readOnly = false,
  sizeLock
}: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
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

  const applyLayout = useCallback(() => {
    const term = termRef.current
    const wrap = wrapRef.current
    const host = hostRef.current
    if (!term || !wrap || !host) return

    if (!sizeLock) {
      // 创建端：窗口多大，PTY 就多大。
      const fit = fitRef.current
      if (!fit) return
      // 还没布局（隐藏的标签页 / 窗口刚起）：量出来是 0，fit 会给个荒唐的行列，
      // 一发出去 PTY 就被压成 10 列，画面全错。等真正可见那一次再量。
      if (host.offsetWidth < 40 || host.offsetHeight < 40) return
      wrap.style.transform = 'none'
      try {
        fit.fit()
      } catch {
        // 容器还没量到尺寸，等 ResizeObserver 再来一次。
      }
      return
    }

    // 镜像端：行列只认 PTY，不 fit。
    if (term.cols !== sizeLock.cols || term.rows !== sizeLock.rows) {
      term.resize(sizeLock.cols, sizeLock.rows)
    }

    const screen = wrap.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    const hr = host.getBoundingClientRect()
    const sw = screen.offsetWidth
    const sh = screen.offsetHeight
    if (!hr.width || !hr.height || !sw || !sh) return
    // 容器装不下（对方窗口更大）：整体等比缩小，别裁掉下半截。
    const scale = Math.min(1, hr.width / sw, hr.height / sh)
    wrap.style.transform = scale < 0.995 ? `scale(${scale.toFixed(4)})` : 'none'
  }, [sizeLock])

  // 创建实例，只在 leafId 变化时重建。
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

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
    term.open(wrap)

    termRef.current = term
    fitRef.current = fit

    installKeyPolicy(term)
    term.onData((data) => window.rpty.write(leafId, data))
    term.onResize(({ cols, rows }) => window.rpty.resize(leafId, cols, rows))

    // 首帧先按 PTY 尺寸铺好（镜像端），创建端交给 fit。
    applyLayout()

    const offData = window.rpty.onData(({ leafId: incoming, data }) => {
      if (incoming === leafId) term.write(data)
    })

    // 订阅建好之后再通知主进程「可以灌了」，这样攒住的快照和增量才有人接。
    window.rpty.ready(leafId)

    const host = hostRef.current
    // 窗口拖拽/最大化过程中会连续量到中间尺寸，等一帧再算，
    // 否则会按一个偏小的容器算出缩放比例，之后就卡在那儿不动了。
    let pending = 0
    const schedule = (): void => {
      if (!active) return
      if (pending) cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => {
        pending = 0
        applyLayout()
      })
    }
    const observer = new ResizeObserver(schedule)
    if (host) observer.observe(host)
    window.addEventListener('resize', schedule)

    return () => {
      offData()
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      if (pending) cancelAnimationFrame(pending)
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

  // PTY 尺寸变了（创建端改了窗口）：重新按新行列铺。
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => applyLayout())
    return () => cancelAnimationFrame(raf)
  }, [sizeLock?.cols, sizeLock?.rows, active, applyLayout])

  // 可见性切换：attach/detach WebGL + 延迟一帧排版。
  useEffect(() => {
    if (!active) {
      detachWebgl()
      return
    }

    const raf = requestAnimationFrame(() => {
      applyLayout()
      attachWebgl()
      if (!readOnly) termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, attachWebgl, detachWebgl, applyLayout, readOnly])

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
      <div ref={hostRef} className="pane__host">
        <div ref={wrapRef} className="pane__wrap" />
      </div>
    </div>
  )
}
