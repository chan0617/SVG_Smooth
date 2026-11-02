import type { RefineInput, RefineResult } from './refine'
import type { TraceInput, TraceResult } from './trace'
import type { WorkerRequest } from './worker'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/**
 * Worker RPC. 같은 종류의 새 작업이 들어오면 이전 작업 결과는 버린다(슬라이더 연속 조작 대응).
 * 계산이 오래 걸리면 Worker를 재시작해 이전 작업을 실제로 중단한다.
 */
export class EngineClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()
  private latest: Record<string, number> = {}
  private busySince: number | null = null

  constructor() {
    this.worker = this.spawn()
  }

  private spawn() {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(e.data.id)
      if (!p) return
      this.pending.delete(e.data.id)
      if (this.pending.size === 0) this.busySince = null
      if (e.data.ok) p.resolve(e.data.result)
      else p.reject(new Error(e.data.error))
    }
    w.onerror = (e) => {
      const err = new Error(`처리 엔진 오류: ${e.message || '알 수 없는 오류'}`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.busySince = null
    }
    return w
  }

  private run<T>(req: Omit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<T | null> {
    // 이전 작업이 3초 넘게 붙잡고 있으면 Worker 교체(구 작업은 폐기)
    if (this.busySince && performance.now() - this.busySince > 3000) {
      this.worker.terminate()
      for (const p of this.pending.values()) p.resolve(null)
      this.pending.clear()
      this.worker = this.spawn()
    }
    const id = ++this.seq
    this.latest[req.kind] = id
    this.busySince ??= performance.now()
    return new Promise<T | null>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(this.latest[req.kind] === id ? (v as T) : null),
        reject: (e) => (this.latest[req.kind] === id ? reject(e) : resolve(null)),
      })
      this.worker.postMessage({ ...req, id }, transfer)
    })
  }

  /** 최신 요청이 아니면 null을 돌려준다. */
  trace(input: TraceInput) {
    return this.run<TraceResult>({ kind: 'trace', input })
  }

  refine(input: RefineInput) {
    return this.run<RefineResult>({ kind: 'refine', input })
  }
}
