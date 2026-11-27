/**
 * 终端外观参数。
 *
 * 这一组数值是从 orca 的实际配置里挑出来的 —— 它们决定了「手感」：
 * 行距、光标形状、回滚深度、滚轮阻尼、Option 键行为。改动前先想清楚
 * 是不是真要动，这些值是被调过的。
 */

import type { ITerminalOptions } from '@xterm/xterm'

export const TERMINAL_OPTIONS: ITerminalOptions = {
  allowProposedApi: true,

  cursorBlink: true,
  cursorStyle: 'block',

  fontSize: 13.5,
  fontWeight: '300',
  fontWeightBold: '500',
  lineHeight: 1.25,
  letterSpacing: 0,

  scrollback: 5000,
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  smoothScrollDuration: 0,

  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  altClickMovesCursor: false,

  drawBoldTextInBrightColors: true,
  allowTransparency: false,
  convertEol: false,

  fontFamily: [
    'SF Mono',
    'Menlo',
    'Monaco',
    'Cascadia Mono',
    'Consolas',
    'DejaVu Sans Mono',
    'MesloLGS Nerd Font',
    'JetBrainsMono Nerd Font',
    'Hack Nerd Font',
    'monospace'
  ].join(', '),

  theme: {
    background: '#0f1017',
    foreground: '#c9cedb',
    cursor: '#7fb2ff',
    cursorAccent: '#0f1017',
    selectionBackground: '#2c3550',
    selectionForeground: '#ffffff',
    black: '#1b1d26',
    red: '#f2777a',
    green: '#99cc99',
    yellow: '#ffcc66',
    blue: '#6699cc',
    magenta: '#cc99cc',
    cyan: '#66cccc',
    white: '#d3d6e0',
    brightBlack: '#4a4f5e',
    brightRed: '#ff8b8b',
    brightGreen: '#b3e6b3',
    brightYellow: '#ffe08a',
    brightBlue: '#8ab4f8',
    brightMagenta: '#e0aee0',
    brightCyan: '#8ae0e0',
    brightWhite: '#f0f2f7'
  }
}
