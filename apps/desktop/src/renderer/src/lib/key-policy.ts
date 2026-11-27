/**
 * 键位策略。
 *
 * 规则只有两条，但都是会让人立刻察觉的：
 *   1. Cmd+C 有选区 → 复制（不发 ^C）；无选区 → 交给终端发 \x03
 *   2. 其余带 Cmd 的组合一律放行给浏览器/菜单，让 xterm 的 paste 事件正常走
 *
 * attachCustomKeyEventHandler 的语义是「返回 false 表示 xterm 不再处理」，
 * 不是「阻止事件冒泡」，所以返回 false 之后浏览器默认行为照常发生。
 */

import type { Terminal } from '@xterm/xterm'

export function installKeyPolicy(term: Terminal): void {
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== 'keydown') return true

    const key = event.key.toLowerCase()
    const metaOnly = event.metaKey && !event.ctrlKey && !event.altKey

    if (!metaOnly) return true

    if (key === 'c') {
      const selection = term.getSelection()
      if (selection) {
        void writeClipboard(selection)
        return false
      }
      // 没有选区：不要吞掉，让 xterm 当 Ctrl+C 处理（发送 \x03）。
      return true
    }

    if (key === 'v') {
      // 放行，靠浏览器的 paste 事件进 xterm。
      return true
    }

    return true
  })
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // file:// 下 clipboard 可能不可用，退回到已经过时的 execCommand。
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
    } catch {
      // 都失败就算了，不打断用户。
    }
    document.body.removeChild(area)
  }
}
