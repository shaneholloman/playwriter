/**
 * Recording relay functionality for the CDP relay server.
 * Handles recording state, chunk accumulation, and file writing.
 */

import fs from 'node:fs'
import path from 'node:path'
import pc from 'picocolors'
import type {
  StartRecordingParams,
  StopRecordingParams,
  IsRecordingParams,
  CancelRecordingParams,
  StartRecordingResult,
  StopRecordingResult,
  IsRecordingResult,
  CancelRecordingResult,
  RecordingDataMessage,
  RecordingCancelledMessage,
} from './protocol.js'

// Recording state - tracks active recordings and their accumulated chunks
export interface ActiveRecording {
  tabId: number
  sessionId?: string  // The sessionId used to start this recording, for lookup when stopping
  outputPath: string
  chunks: Buffer[]
  startedAt: number
  resolveStop?: (result: StopRecordingResult) => void
}

interface RecordingRelayDeps {
  sendToExtension: (params: { method: string; params?: unknown; timeout?: number }) => Promise<unknown>
  isExtensionConnected: () => boolean
  logger?: {
    log(...args: unknown[]): void
    error(...args: unknown[]): void
  }
}

export class RecordingRelay {
  private activeRecordings = new Map<number, ActiveRecording>()
  // Track which tabId just sent recordingData metadata - used to route the next binary chunk
  private lastRecordingMetadataTabId: number | null = null
  private deps: RecordingRelayDeps

  constructor(deps: RecordingRelayDeps) {
    this.deps = deps
  }

  /**
   * Handle incoming binary data (recording chunks) from the extension.
   * Returns true if the data was handled as a recording chunk.
   */
  handleBinaryData(buffer: Buffer): boolean {
    const tabId = this.lastRecordingMetadataTabId
    this.lastRecordingMetadataTabId = null

    if (tabId !== null) {
      const recording = this.activeRecordings.get(tabId)
      if (recording) {
        recording.chunks.push(buffer)
        this.deps.logger?.log(pc.blue(`Received recording chunk for tab ${tabId}: ${buffer.length} bytes (total chunks: ${recording.chunks.length})`))
        return true
      } else {
        this.deps.logger?.log(pc.yellow(`Received recording chunk for unknown tab ${tabId}, ignoring`))
      }
    } else {
      this.deps.logger?.log(pc.yellow('Received recording chunk without preceding metadata, ignoring'))
    }
    return false
  }

  /**
   * Handle recordingData message from extension.
   * This is sent before binary chunks to identify which recording they belong to.
   */
  handleRecordingData(message: RecordingDataMessage): void {
    const { tabId, final } = message.params
    const recording = this.activeRecordings.get(tabId)

    // Track which tab sent this metadata for routing the next binary chunk
    if (!final) {
      this.lastRecordingMetadataTabId = tabId
    }

    if (recording && final) {
      // This is the final marker - write all chunks to file
      try {
        const totalSize = recording.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const combined = Buffer.concat(recording.chunks)
        fs.writeFileSync(recording.outputPath, combined)

        const duration = Date.now() - recording.startedAt
        this.deps.logger?.log(pc.green(`Recording saved: ${recording.outputPath} (${totalSize} bytes, ${duration}ms)`))

        // Resolve the stop promise
        if (recording.resolveStop) {
          recording.resolveStop({
            success: true,
            tabId,
            duration,
            path: recording.outputPath,
            size: totalSize,
          })
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.deps.logger?.error('Failed to write recording:', error)
        if (recording.resolveStop) {
          recording.resolveStop({ success: false, error: errorMessage })
        }
      }

      this.activeRecordings.delete(tabId)
    }
    // Non-final recordingData is just a marker that binary follows - handled in handleBinaryData
  }

  /**
   * Handle recordingCancelled message from extension.
   */
  handleRecordingCancelled(message: RecordingCancelledMessage): void {
    const { tabId } = message.params
    const recording = this.activeRecordings.get(tabId)
    if (recording) {
      this.deps.logger?.log(pc.yellow(`Recording cancelled for tab ${tabId}`))
      if (recording.resolveStop) {
        recording.resolveStop({ success: false, error: 'Recording was cancelled' })
      }
      this.activeRecordings.delete(tabId)
    }
  }

  /**
   * Start recording a tab.
   */
  async startRecording(params: StartRecordingParams & { outputPath: string }): Promise<StartRecordingResult> {
    const { outputPath, ...recordingParams } = params

    if (!outputPath) {
      return { success: false, error: 'outputPath is required' }
    }

    if (!this.deps.isExtensionConnected()) {
      return { success: false, error: 'Extension not connected' }
    }

    // Ensure output directory exists
    const dir = path.dirname(outputPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    try {
      const result = await this.deps.sendToExtension({
        method: 'startRecording',
        params: recordingParams,
        timeout: 10000,
      }) as StartRecordingResult

      if (!result) {
        return { success: false, error: 'Extension returned empty result' }
      }

      if (result.success) {
        // Track this recording - store sessionId for lookup when stopping
        this.activeRecordings.set(result.tabId, {
          tabId: result.tabId,
          sessionId: recordingParams.sessionId,
          outputPath,
          chunks: [],
          startedAt: result.startedAt,
        })
        this.deps.logger?.log(pc.green(`Recording started for tab ${result.tabId} (sessionId: ${recordingParams.sessionId || 'none'}), output: ${outputPath}`))
      }

      return result
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.deps.logger?.error('Start recording error:', error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Stop recording and save to file.
   */
  async stopRecording(params: StopRecordingParams): Promise<StopRecordingResult> {
    if (!this.deps.isExtensionConnected()) {
      return { success: false, error: 'Extension not connected' }
    }

    // Find the active recording by sessionId for concurrent recording support
    // If no sessionId provided, fall back to the first recording (backward compatibility)
    const findRecording = (): ActiveRecording | undefined => {
      if (params.sessionId) {
        for (const recording of this.activeRecordings.values()) {
          if (recording.sessionId === params.sessionId) {
            return recording
          }
        }
        // SessionId provided but no matching recording found
        return undefined
      }
      // No sessionId - return first recording (backward compat for single-recording case)
      return this.activeRecordings.values().next().value
    }

    const recording = findRecording()

    if (!recording) {
      const errorMsg = params.sessionId
        ? `No active recording found for sessionId: ${params.sessionId}`
        : 'No active recording found'
      return { success: false, error: errorMsg }
    }

    // Set up promise to wait for final chunk
    let timeoutId: ReturnType<typeof setTimeout>
    const finalPromise = new Promise<StopRecordingResult>((resolve) => {
      const wrappedResolve = (result: StopRecordingResult) => {
        clearTimeout(timeoutId)
        resolve(result)
      }
      recording.resolveStop = wrappedResolve
      // Timeout after 30 seconds
      timeoutId = setTimeout(() => {
        if (recording.resolveStop) {
          recording.resolveStop = undefined
          resolve({ success: false, error: 'Timeout waiting for recording data' })
        }
      }, 30000)
    })

    try {
      // Tell extension to stop recording
      const result = await this.deps.sendToExtension({
        method: 'stopRecording',
        params,
        timeout: 10000,
      }) as StopRecordingResult

      if (!result.success) {
        recording.resolveStop = undefined
        this.activeRecordings.delete(recording.tabId)
        return result
      }

      // Wait for final chunk to arrive
      return await finalPromise
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.deps.logger?.error('Stop recording error:', error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Check if recording is active.
   */
  async isRecording(params: IsRecordingParams): Promise<IsRecordingResult> {
    if (!this.deps.isExtensionConnected()) {
      return { isRecording: false }
    }

    try {
      return await this.deps.sendToExtension({
        method: 'isRecording',
        params,
        timeout: 5000,
      }) as IsRecordingResult
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.deps.logger?.error('Recording status error:', error)
      return { isRecording: false }
    }
  }

  /**
   * Cancel recording without saving.
   */
  async cancelRecording(params: CancelRecordingParams): Promise<CancelRecordingResult> {
    if (!this.deps.isExtensionConnected()) {
      return { success: false, error: 'Extension not connected' }
    }

    try {
      // Note: Recording cleanup is handled by the 'recordingCancelled' event handler
      // which is triggered by the extension after cancellation.
      return await this.deps.sendToExtension({
        method: 'cancelRecording',
        params,
        timeout: 5000,
      }) as CancelRecordingResult
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.deps.logger?.error('Cancel recording error:', error)
      return { success: false, error: errorMessage }
    }
  }
}
