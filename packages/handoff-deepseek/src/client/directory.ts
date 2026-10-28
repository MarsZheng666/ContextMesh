import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
export type DirectoryListing = Awaited<ReturnType<UiWorkspace['listDirectory']>>
export type ListDirectory = UiWorkspace['listDirectory']
export interface DirectoryState {
  listing?: DirectoryListing
  loading: boolean
  failed: boolean
}
/** Browses the DSH host, cancelling superseded reads and ignoring late responses. */
export class DirectoryBrowserModel {
  private state: DirectoryState = { loading: true, failed: false }
  private listeners = new Set<() => void>()
  private controller?: AbortController
  private generation = 0
  private closed = false
  constructor(private readonly list: ListDirectory) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(state: DirectoryState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  start(path?: string) {
    this.closed = false
    return this.navigate(path)
  }
  async navigate(path?: string) {
    if (this.closed) return
    this.controller?.abort()
    const controller = new AbortController(),
      generation = ++this.generation
    this.controller = controller
    this.set({ ...this.state, loading: true, failed: false })
    try {
      const listing = await this.list(path, controller.signal)
      if (
        this.closed ||
        controller.signal.aborted ||
        generation !== this.generation
      )
        return
      this.set({ listing, loading: false, failed: false })
    } catch {
      if (
        this.closed ||
        controller.signal.aborted ||
        generation !== this.generation
      )
        return
      this.set({ ...this.state, loading: false, failed: true })
    }
  }
  close() {
    this.closed = true
    this.controller?.abort()
    this.listeners.clear()
  }
}
