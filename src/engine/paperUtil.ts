import paper from 'paper/dist/paper-core'

let ready = false

/** Paper.js 프로젝트를 한 번만 만든다(Worker에는 캔버스가 없으므로 크기만 지정). */
export function ensurePaper() {
  if (!ready) {
    paper.setup(new paper.Size(1, 1))
    ready = true
  }
  // 이전 작업에서 남은 아이템 정리
  paper.project.activeLayer.removeChildren()
}

export function subpathsOf(item: paper.PathItem): paper.Path[] {
  if (item instanceof paper.CompoundPath) return item.children as paper.Path[]
  return [item as paper.Path]
}

export function countNodes(item: paper.PathItem): number {
  return subpathsOf(item).reduce((n, p) => n + p.segments.length, 0)
}

/** Paper.js의 getPathData(matrix, precision)는 타입 정의에 없어서 래핑한다. */
export function pathDataOf(item: paper.PathItem, decimals: number): string {
  return (item as unknown as { getPathData(m: null, p: number): string }).getPathData(null, decimals)
}
