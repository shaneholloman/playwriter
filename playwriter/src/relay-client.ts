/**
 * Shared utilities for connecting to the relay server.
 * Used by both MCP and CLI.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killPortProcess } from 'kill-port-process'
import { VERSION, sleep, LOG_FILE_PATH } from './utils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988

export async function getRelayServerVersion(port: number = RELAY_PORT): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as { version: string }
    return data.version
  } catch {
    return null
  }
}

async function killRelayServer(port: number): Promise<void> {
  try {
    await killPortProcess(port)
    await sleep(500)
  } catch {}
}

/**
 * Compare two semver versions. Returns:
 * - negative if v1 < v2
 * - 0 if v1 === v2
 * - positive if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  const len = Math.max(parts1.length, parts2.length)

  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 !== p2) {
      return p1 - p2
    }
  }
  return 0
}

export interface EnsureRelayServerOptions {
  logger?: { log: (...args: any[]) => void }
  /** If true, will kill and restart server on version mismatch. Default: true */
  restartOnVersionMismatch?: boolean
  /** Pass additional environment variables to the relay server process */
  env?: Record<string, string>
}

/**
 * Ensures the relay server is running. Starts it if not running.
 * Optionally restarts on version mismatch.
 */
export async function ensureRelayServer(options: EnsureRelayServerOptions = {}): Promise<void> {
  const { logger, restartOnVersionMismatch = true, env: additionalEnv } = options
  const serverVersion = await getRelayServerVersion(RELAY_PORT)

  if (serverVersion === VERSION) {
    return
  }

  // Don't restart if server version is higher than our version.
  // This prevents older clients from killing a newer server.
  if (serverVersion !== null && compareVersions(serverVersion, VERSION) > 0) {
    return
  }

  if (serverVersion !== null) {
    if (restartOnVersionMismatch) {
      logger?.log(`CDP relay server version mismatch (server: ${serverVersion}, client: ${VERSION}), restarting...`)
      await killRelayServer(RELAY_PORT)
    } else {
      // Server is running but different version, just use it
      return
    }
  } else {
    logger?.log('CDP relay server not running, starting it...')
  }

  const dev = process.env.PLAYWRITER_NODE_ENV === 'development'
  const scriptPath = dev
    ? path.resolve(__dirname, '../src/start-relay-server.ts')
    : path.resolve(__dirname, './start-relay-server.js')

  const serverProcess = spawn(dev ? 'tsx' : process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...additionalEnv },
  })

  serverProcess.unref()

  for (let i = 0; i < 10; i++) {
    await sleep(500)
    const newVersion = await getRelayServerVersion(RELAY_PORT)
    if (newVersion) {
      logger?.log('CDP relay server started successfully')
      return
    }
  }

  throw new Error(`Failed to start CDP relay server after 5 seconds. Check logs at: ${LOG_FILE_PATH}`)
}
