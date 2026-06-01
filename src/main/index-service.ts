// 检索:纯本地 BM25 词法检索,不依赖任何 embedding 接口。
// 适配只有对话接口的服务(如 MiMo、DeepSeek)。提问阶段可选地用 chat 把
// 中文问题转成英文检索词(见 llm.translateQuery),以跨越"中文问、英文书"的语言鸿沟。
import { getChunks } from './store'
import type { Chunk } from '../shared/types'

/** 分词:英文小写、去标点、轻量去复数/词尾;中文按 bigram 切分以提升召回。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  // 英文/数字词
  const enWords = lower.match(/[a-z][a-z0-9]+/g) ?? []
  for (const w of enWords) {
    if (w.length <= 1) continue
    tokens.push(stem(w))
  }
  // 中文连续片段 → bigram(双字),单字也保留一份
  const zhRuns = text.match(/[一-龥]+/g) ?? []
  for (const run of zhRuns) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** 极轻量英文词干化:归一常见复数/进行时/过去式,降低形态差异带来的漏召回。
 *  注意:单复数要归一到同一形(force/forces 都→force),否则会漏召回。 */
function stem(w: string): string {
  // 复数:-ies→-y(studies→study);-ses/-xes/-zes/-ches/-shes→去 es(boxes→box);其余 -s→去 s(forces→force)
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    return w.slice(0, -1)
  }
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  return w
}

interface Bm25Doc {
  chunk: Chunk
  tf: Map<string, number>
  len: number
}

interface Bm25Index {
  docs: Bm25Doc[]
  df: Map<string, number>
  avgLen: number
  n: number
}

function buildIndex(chunks: Chunk[]): Bm25Index {
  const docs: Bm25Doc[] = []
  const df = new Map<string, number>()
  let totalLen = 0
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    docs.push({ chunk, tf, len: tokens.length })
    totalLen += tokens.length
  }
  return { docs, df, avgLen: docs.length ? totalLen / docs.length : 0, n: docs.length }
}

/** 标准 BM25 打分(k1=1.5, b=0.75) */
function bm25Score(queryTokens: string[], doc: Bm25Doc, idx: Bm25Index): number {
  const k1 = 1.5
  const b = 0.75
  let score = 0
  for (const t of queryTokens) {
    const f = doc.tf.get(t)
    if (!f) continue
    const dfT = idx.df.get(t) ?? 0
    // idf 加 0.5 平滑,clamp 到非负,避免高频词产生负分
    const idf = Math.max(0, Math.log((idx.n - dfT + 0.5) / (dfT + 0.5) + 1))
    const denom = f + k1 * (1 - b + (b * doc.len) / (idx.avgLen || 1))
    score += idf * ((f * (k1 + 1)) / denom)
  }
  return score
}

// ---- BM25 索引缓存:避免每次查询都重建 ----
const indexCache = new Map<string, { index: Bm25Index; fingerprint: string }>()

function fingerprint(chunks: Chunk[]): string {
  // 用 chunks 数量+首尾 id+文本总长作为指纹,chunk 变化时自动失效
  if (chunks.length === 0) return 'empty'
  let totalLen = 0
  for (const c of chunks) totalLen += c.text.length
  return `${chunks.length}:${chunks[0]?.id ?? ''}:${chunks[chunks.length - 1]?.id ?? ''}:${totalLen}`
}

export function clearBm25Cache(bookId?: string): void {
  if (bookId) indexCache.delete(bookId)
  else indexCache.clear()
}

/**
 * BM25 检索。queries 可传多个查询(如原始中文 + 翻译后的英文检索词),
 * 各自打分后按 chunk 取最大分,再排序返回 topK。
 */
export async function retrieve(bookId: string, queries: string | string[], topK = 6): Promise<Chunk[]> {
  const chunks = await getChunks(bookId)
  if (chunks.length === 0) return []

  const fp = fingerprint(chunks)
  const cached = indexCache.get(bookId)
  let idx: Bm25Index
  if (cached && cached.fingerprint === fp) {
    idx = cached.index
  } else {
    idx = buildIndex(chunks)
    indexCache.set(bookId, { index: idx, fingerprint: fp })
  }

  const queryList = (Array.isArray(queries) ? queries : [queries]).filter((q) => q && q.trim())
  const tokenSets = queryList.map((q) => tokenize(q)).filter((ts) => ts.length > 0)
  if (tokenSets.length === 0) return []

  const best = new Map<string, number>()
  for (const doc of idx.docs) {
    let s = 0
    for (const qt of tokenSets) s = Math.max(s, bm25Score(qt, doc, idx))
    if (s > 0) best.set(doc.chunk.id, s)
  }

  return idx.docs
    .filter((d) => best.has(d.chunk.id))
    .sort((a, b) => (best.get(b.chunk.id) ?? 0) - (best.get(a.chunk.id) ?? 0))
    .slice(0, topK)
    .map((d) => d.chunk)
}
