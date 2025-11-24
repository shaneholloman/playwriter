import type { RelayConnection } from './relayConnection'

export type ConnectionState = 'disconnected' | 'reconnecting' | 'connected' | 'error'
export type TabState = 'connecting' | 'connected' | 'error'

export interface TabInfo {
  targetId: string
  state: TabState
  errorText?: string
}

export interface ExtensionState {
  connection: RelayConnection | undefined
  connectedTabs: Map<number, TabInfo>
  connectionState: ConnectionState
  currentTabId: number | undefined
  errorText: string | undefined
}
