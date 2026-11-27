import { homedir } from 'node:os'
import * as pty from 'node-pty'

export interface PtySessionOptions {
  cols: number
  rows: number
  cwd?: string
}

export interface PtySessionHandlers {
  onData: (data: string) => void
  onExit: (payload: { exitCode: number; signal?: number }) => void
  onError: (message: string) => void
}

/** xterm 与 PTY 都受不了 0 列 0 行；这里统一兜底。 */
function clampDimension(value: number, max: number): number {
  if (!Number.isFinite(value)) return 2
  return Math.min(max, Math.max(2, Math.floor(value)))
}

function buildEnv(): Record<string, string> {
  const inherited = { ...process.env } as Record<string, string | undefined>
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === 'string') env[key] = value
  }
  // 只覆盖终端相关变量，LANG/LC_* 全部继承用户环境，避免中文乱码。
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'rpty'
  return env
}

export class PtySession {
  private proc: pty.IPty | null = null

  get pid(): number {
    return this.proc?.pid ?? -1
  }

  get running(): boolean {
    return this.proc !== null
  }

  start(options: PtySessionOptions, handlers: PtySessionHandlers): number {
    if (this.proc) return this.proc.pid

    const shell = process.env.SHELL || '/bin/zsh'
    try {
      this.proc = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: clampDimension(options.cols, 1000),
        rows: clampDimension(options.rows, 500),
        cwd: options.cwd ?? homedir(),
        env: buildEnv()
      })
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : String(error))
      return -1
    }

    this.proc.onData((data) => handlers.onData(data))
    this.proc.onExit(({ exitCode, signal }) => {
      this.proc = null
      handlers.onExit({ exitCode, signal })
    })

    return this.proc.pid
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.proc) return
    try {
      this.proc.resize(clampDimension(cols, 1000), clampDimension(rows, 500))
    } catch {
      // 子进程刚退出的瞬间 resize 会抛，忽略即可。
    }
  }

  dispose(): void {
    if (!this.proc) return
    const proc = this.proc
    this.proc = null
    try {
      proc.kill()
    } catch {
      // 已经退出。
    }
  }
}
