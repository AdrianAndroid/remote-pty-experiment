/**
 * 会话状态。只留这一种：真实信令走 `Record<string, unknown>` 逐条解，
 * 协议口径以 `docs/12-concept-model.md` 为准。
 *
 * 这里曾经放过整套 SESSION_* / HELLO / PONG 的 interface，但没有任何一处引用
 * （`relay-client.ts` 解析的是收到的 JSON），留着只会跟 relay 真实协议各说各话。
 */
export type SessionState = 'connecting' | 'active' | 'disconnected' | 'exited' | 'error'
