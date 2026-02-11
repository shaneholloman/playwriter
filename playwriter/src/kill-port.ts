/**
 * Cross-platform process termination for a TCP port.
 * Replaces external kill-port-process dependency for bunx/runtime stability.
 */

import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function parsePids(output: string): number[] {
  const pids = output
    .split(/\r?\n/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return Boolean(line)
    })
    .map((line) => {
      return Number(line)
    })
    .filter((pid) => {
      return Number.isInteger(pid) && pid > 0
    })

  return [...new Set(pids)]
}

function parseWindowsNetstatPids(output: string, port: number): number[] {
  const rows = output
    .split(/\r?\n/g)
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.startsWith('TCP')
    })

  const pids = rows
    .map((row) => {
      const columns = row.split(/\s+/g)
      const localAddress = columns[1] || ''
      const state = columns[3] || ''
      const pid = columns[4] || ''
      const endsWithPort = localAddress.endsWith(`:${port}`)
      if (!endsWithPort || state !== 'LISTENING') {
        return NaN
      }
      return Number(pid)
    })
    .filter((pid) => {
      return Number.isInteger(pid) && pid > 0
    })

  return [...new Set(pids)]
}

async function getPidsForPortWindows(port: number): Promise<number[]> {
  const powerShellScript = [
    "$ErrorActionPreference='SilentlyContinue'",
    `@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique) -join [Environment]::NewLine`,
  ].join('; ')

  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', powerShellScript])
    const pids = parsePids(stdout)
    if (pids.length > 0) {
      return pids
    }
  } catch {}

  try {
    const { stdout } = await execFileAsync('cmd', ['/d', '/s', '/c', 'netstat -ano -p tcp'])
    return parseWindowsNetstatPids(stdout, port)
  } catch {
    return []
  }
}

async function getPidsForPortUnix(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-t'])
    const pids = parsePids(stdout)
    if (pids.length > 0) {
      return pids
    }
  } catch {}

  try {
    const { stdout } = await execFileAsync('fuser', [`${port}/tcp`])
    return parsePids(stdout)
  } catch {
    return []
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminatePidWindows(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'])
  } catch {}
}

async function terminatePidUnix(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }

  await sleep(200)
  if (!isProcessAlive(pid)) {
    return
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/**
 * Kill any listening process bound to the provided TCP port.
 */
export async function killPortProcess({ port }: { port: number }): Promise<void> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`)
  }

  const pids = os.platform() === 'win32'
    ? await getPidsForPortWindows(port)
    : await getPidsForPortUnix(port)

  const currentPid = process.pid
  const targetPids = pids.filter((pid) => {
    return pid !== currentPid
  })

  await Promise.all(
    targetPids.map(async (pid) => {
      if (os.platform() === 'win32') {
        await terminatePidWindows(pid)
        return
      }
      await terminatePidUnix(pid)
    }),
  )
}
