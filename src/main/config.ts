// API 配置与密钥管理。key 用 Electron safeStorage 加密后落盘,
// 明文 key 只在主进程内存中短暂出现,绝不通过 IPC 暴露给渲染进程。
import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ApiConfig, ApiProfile, ApiProfileInput, OcrMode, Provider } from '../shared/types'

interface StoredProfile {
  id: string
  name: string
  provider: Provider
  baseUrl: string
  chatModel: string
  visionModel: string
  ocrMode: OcrMode
  encryptedKey?: string
}

/** v2 多 profile 配置 */
interface StoredConfig {
  profiles: StoredProfile[]
  activeProfileId: string | null
  knowledgeModel: string
  knowledgeConcurrency: number
}

/** v1 旧版单配置(用于自动迁移) */
interface OldStoredConfig {
  baseUrl?: string
  chatModel?: string
  embeddingModel?: string
  visionModel?: string
  ocrMode?: OcrMode
  encryptedKey?: string
}

const DEFAULT_PROFILE: StoredProfile = {
  id: randomUUID(),
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  chatModel: 'gpt-4o-mini',
  visionModel: 'gpt-4o-mini',
  ocrMode: 'hybrid'
}

function configFile(): string {
  return join(app.getPath('userData'), 'config.json')
}

async function read(): Promise<StoredConfig> {
  try {
    const raw = await fs.readFile(configFile(), 'utf-8')
    const parsed = JSON.parse(raw) as StoredConfig | OldStoredConfig
    // 检测旧版单配置并迁移
    if (!('profiles' in parsed)) {
      const old = parsed as OldStoredConfig
      const migrated: StoredProfile = {
        ...DEFAULT_PROFILE,
        id: randomUUID(),
        baseUrl: old.baseUrl || DEFAULT_PROFILE.baseUrl,
        chatModel: old.chatModel || DEFAULT_PROFILE.chatModel,
        visionModel: old.visionModel || DEFAULT_PROFILE.visionModel,
        ocrMode: old.ocrMode || DEFAULT_PROFILE.ocrMode,
        encryptedKey: old.encryptedKey
      }
      return { profiles: [migrated], activeProfileId: migrated.id, knowledgeModel: '', knowledgeConcurrency: 3 }
    }
    const cfg = parsed as StoredConfig
    return {
      profiles: cfg.profiles.length > 0 ? cfg.profiles : [{ ...DEFAULT_PROFILE }],
      activeProfileId: cfg.activeProfileId ?? (cfg.profiles[0]?.id ?? null),
      knowledgeModel: cfg.knowledgeModel ?? '',
      knowledgeConcurrency: cfg.knowledgeConcurrency ?? 3
    }
  } catch {
    return { profiles: [{ ...DEFAULT_PROFILE }], activeProfileId: DEFAULT_PROFILE.id, knowledgeModel: '', knowledgeConcurrency: 3 }
  }
}

async function write(cfg: StoredConfig): Promise<void> {
  await fs.writeFile(configFile(), JSON.stringify(cfg), 'utf-8')
}

function encryptKey(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64')
  }
  return Buffer.from(key, 'utf-8').toString('base64')
}

function decryptKey(encrypted: string): string {
  const buf = Buffer.from(encrypted, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(buf)
  }
  return buf.toString('utf-8')
}

function toPublicProfile(p: StoredProfile): ApiProfile {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    baseUrl: p.baseUrl,
    chatModel: p.chatModel,
    visionModel: p.visionModel,
    ocrMode: p.ocrMode,
    hasKey: !!p.encryptedKey
  }
}

/** 暴露给 UI 的安全视图:不含明文 key */
export async function getPublicConfig(): Promise<ApiConfig> {
  const c = await read()
  return {
    profiles: c.profiles.map(toPublicProfile),
    activeProfileId: c.activeProfileId,
    knowledgeModel: c.knowledgeModel ?? '',
    knowledgeConcurrency: c.knowledgeConcurrency ?? 3
  }
}

/** 获取当前激活的 profile(含解密后的 key)。
 *  若 activeProfileId 无效,回退到第一个 profile。 */
export async function getActiveProfile(): Promise<(StoredProfile & { apiKey: string | null }) | null> {
  const c = await read()
  let p = c.profiles.find((x) => x.id === c.activeProfileId)
  if (!p) p = c.profiles[0]
  if (!p) return null
  return {
    ...p,
    apiKey: p.encryptedKey ? decryptKey(p.encryptedKey) : null
  }
}

/** 获取所有 profile(含解密后的 key),用于 LLM 适配层的自动回退 */
export async function getAllProfiles(): Promise<Array<StoredProfile & { apiKey: string | null }>> {
  const c = await read()
  return c.profiles.map((p) => ({
    ...p,
    apiKey: p.encryptedKey ? decryptKey(p.encryptedKey) : null
  }))
}

/** 保存全部 profile 配置。传入的 input 中 apiKey 为明文:
 *  - 若提供了非空 apiKey,则加密替换旧 key
 *  - 若未提供 apiKey(undefined),保留该 profile 的旧 key
 *  - 若提供空字符串,视为删除 key */
export async function setConfig(input: {
  profiles: ApiProfileInput[]
  activeProfileId?: string
  knowledgeModel?: string
  knowledgeConcurrency?: number
}): Promise<ApiConfig> {
  const current = await read()
  const currentMap = new Map(current.profiles.map((p) => [p.id, p]))

  // 防御:如果传入空 profiles 但当前有配置,保留当前 profiles 避免意外清空
  const profilesToSave = input.profiles.length > 0 ? input.profiles : current.profiles

  const nextProfiles: StoredProfile[] = profilesToSave.map((inp) => {
    const existing = inp.id ? currentMap.get(inp.id) : undefined
    const rawKey = 'apiKey' in inp ? (inp as ApiProfileInput).apiKey : undefined
    const encryptedKey =
      typeof rawKey === 'string'
        ? rawKey.length > 0
          ? encryptKey(rawKey)
          : undefined
        : existing?.encryptedKey

    return {
      id: inp.id || randomUUID(),
      name: inp.name || '未命名',
      provider: inp.provider || 'openai',
      baseUrl: inp.baseUrl || DEFAULT_PROFILE.baseUrl,
      chatModel: inp.chatModel || DEFAULT_PROFILE.chatModel,
      visionModel: inp.visionModel || DEFAULT_PROFILE.visionModel,
      ocrMode: inp.ocrMode || DEFAULT_PROFILE.ocrMode,
      encryptedKey
    }
  })

  const nextActive = input.activeProfileId ?? nextProfiles[0]?.id ?? null
  const knowledgeModel =
    typeof input.knowledgeModel === 'string' ? input.knowledgeModel : current.knowledgeModel ?? ''
  const concurrency =
    typeof input.knowledgeConcurrency === 'number' && Number.isFinite(input.knowledgeConcurrency)
      ? input.knowledgeConcurrency
      : current.knowledgeConcurrency ?? 3

  const next: StoredConfig = {
    profiles: nextProfiles,
    activeProfileId: nextActive,
    knowledgeModel,
    knowledgeConcurrency: concurrency
  }
  await write(next)
  return getPublicConfig()
}

/** 测试单个 profile 的连接性(发一个极简请求)。 */
export async function testProfile(
  inp: ApiProfileInput
): Promise<{ ok: boolean; error?: string }> {
  if (!inp.apiKey || inp.apiKey.length === 0) {
    return { ok: false, error: '未提供 API Key' }
  }
  const url = inp.baseUrl.replace(/\/$/, '') + '/models'
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (inp.provider === 'anthropic') {
      headers['x-api-key'] = inp.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${inp.apiKey}`
    }
    const res = await fetch(url, { headers })
    if (res.ok) return { ok: true }
    const body = await safeText(res)
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
