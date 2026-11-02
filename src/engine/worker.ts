// 무거운 계산(추적·패스 보정)은 모두 이 Worker에서 처리해 UI가 멈추지 않게 한다.
import { refinePaths, type RefineInput } from './refine'
import { traceBitmap, type TraceInput } from './trace'

export type WorkerRequest =
  | { id: number; kind: 'trace'; input: TraceInput }
  | { id: number; kind: 'refine'; input: RefineInput }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  try {
    if (req.kind === 'trace') {
      const result = await traceBitmap(req.input)
      self.postMessage({ id: req.id, ok: true, result }, { transfer: [result.mask.buffer] })
    } else {
      const result = refinePaths(req.input)
      self.postMessage({ id: req.id, ok: true, result })
    }
  } catch (err) {
    self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
