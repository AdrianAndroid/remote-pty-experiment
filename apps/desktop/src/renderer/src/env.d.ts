import type { RptyBridge } from '../../shared/ipc'

declare global {
  interface Window {
    rpty: RptyBridge
  }
}

export {}
