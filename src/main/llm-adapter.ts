// LLM 统一适配层:屏蔽 OpenAI / Anthropic 的格式差异,
// 提供统一的 callLlm 接口,支持多 profile 自动回退。

import { getAllProfiles, getActiveProfile } from './config'
import type { Provider } from '../shared/types'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** MiMo 等模型支持在 assistant 消息中携带 reasoning_content */
  reasoning_content?: string
}

export interface LlmRequest {
  model: string
  temperature: number
  messages: LlmMessage[]
  /** Anthropic 不支持 response_format, 此字段仅对 OpenAI 生效 */
  responseFormat?: { type: 'json_object' }
  /** 默认 4096,避免输出被截断 */
  maxTokens?: number
}

export interface LlmResponse {
  content: string
  /** 模型原生 reasoning 内容(如 MiMo 的 reasoning_content) */
  reasoning?: string
}

interface Profile {
  id: string
  name: string
  provider: Provider
  baseUrl: string
  chatModel: string
  visionModel: string
  apiKey: string | null
}

/** 获取可用 profile 列表(按 active → others 排序) */
async function getProfiles(): Promise<Profile[]> {
  const active = await getActiveProfile()
  const all = await getAllProfiles()
  const ordered: Profile[] = []
  if (active) ordered.push(active)
  for (const p of all) {
    if (p.id !== active?.id) ordered.push(p)
  }
  return ordered.filter((p) => p.apiKey)
}

/** OpenAI 适配器 */
async function openaiRequest(profile: Profile, req: LlmRequest): Promise<LlmResponse> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: req.model || profile.chatModel,
    temperature: req.temperature,
    max_tokens: req.maxTokens ?? 4096,
    messages: req.messages,
    thinking: { type: 'enabled' }
  }
  if (req.responseFormat) {
    body.response_format = req.responseFormat
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new Error(await describeError('OPENAI', res, url))
  }
  const json = (await res.json()) as { choices: Array<{ message: { content: string; reasoning_content?: string } }> }
  const msg = json.choices?.[0]?.message
  return { content: msg?.content ?? '', reasoning: msg?.reasoning_content }
}

/** Anthropic 适配器 */
async function anthropicRequest(profile: Profile, req: LlmRequest): Promise<LlmResponse> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/messages`
  // Anthropic: system 必须放在 top-level, 不能作为 message
  const systemMsg = req.messages.find((m) => m.role === 'system')?.content ?? ''
  const userMessages = req.messages.filter((m) => m.role !== 'system')
  const body = {
    model: req.model || profile.chatModel,
    temperature: req.temperature,
    max_tokens: 4096,
    system: systemMsg,
    messages: userMessages.map((m) => ({ role: m.role, content: m.content }))
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new Error(await describeError('ANTHROPIC', res, url))
  }
  const json = (await res.json()) as { content: Array<{ text: string }>; reasoning_content?: string }
  return { content: json.content?.[0]?.text ?? '', reasoning: json.reasoning_content }
}

/** 统一 LLM 调用入口:自动尝试 active profile,失败则回退到下一个 */
export async function callLlm(req: LlmRequest): Promise<LlmResponse> {
  const profiles = await getProfiles()
  if (profiles.length === 0) {
    throw new Error('NO_API_KEY: 没有可用的 API 配置，请先在「设置」中添加 profile 并填写 API Key。')
  }

  let lastErr: Error | null = null
  for (const p of profiles) {
    try {
      const res = p.provider === 'anthropic' ? await anthropicRequest(p, req) : await openaiRequest(p, req)
      return res
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastErr ?? new Error('所有 API 配置均调用失败')
}

/** 流式 LLM 调用:返回 AsyncIterable,每次 yield 一个增量文本片段。
 *  - OpenAI 兼容接口:使用 SSE 实时流式推送
 *  - Anthropic:先完整返回再模拟分段推送,保证兼容性
 */
export async function* callLlmStream(req: LlmRequest): AsyncIterable<string> {
  const profiles = await getProfiles()
  if (profiles.length === 0) {
    throw new Error('NO_API_KEY: 没有可用的 API 配置，请先在「设置」中添加 profile 并填写 API Key。')
  }

  let lastErr: Error | null = null
  for (const p of profiles) {
    try {
      if (p.provider === 'anthropic') {
        // Anthropic 暂用非流式 + 模拟分段,避免 SSE 格式差异
        const res = await anthropicRequest(p, req)
        yield* simulateStream(res.content)
        return
      }
      yield* openaiStream(p, req)
      return
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastErr ?? new Error('所有 API 配置均调用失败')
}

/** OpenAI 兼容 SSE 流式 */
async function* openaiStream(profile: Profile, req: LlmRequest): AsyncIterable<string> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: req.model || profile.chatModel,
    temperature: req.temperature,
    max_tokens: req.maxTokens ?? 4096,
    messages: req.messages,
    stream: true,
    thinking: { type: 'enabled' }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    throw new Error(await describeError('OPENAI', res, url))
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const bufferParts: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bufferParts.push(decoder.decode(value, { stream: true }))
    let buffer = bufferParts.join('')
    const lines = buffer.split('\n')
    const last = lines.pop() ?? ''
    bufferParts.length = 0
    if (last) bufferParts.push(last)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> }
        const delta = json.choices?.[0]?.delta
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield '\x01' + delta.reasoning_content
        }
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          yield delta.content
        }
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

/** 模拟流式:把完整文本按小批量逐段 yield,用于 Anthropic 或不支持 SSE 的接口 */
async function* simulateStream(fullText: string): AsyncIterable<string> {
  // 按 8-16 个字符一批,20-40ms 间隔,模拟打字效果
  // chunk 加大以减少 IPC 消息量,视觉上仍然流畅
  let pos = 0
  const len = fullText.length
  while (pos < len) {
    const batchSize = 8 + Math.floor(Math.random() * 9) // 8-16 字符
    yield fullText.slice(pos, pos + batchSize)
    pos += batchSize
    await delay(20 + Math.floor(Math.random() * 20))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Anthropic 视觉 OCR 适配 */
export async function callVision(
  pngDataUrl: string,
  promptText: string
): Promise<string> {
  const profiles = await getProfiles()
  if (profiles.length === 0) throw new Error('NO_API_KEY')

  let lastErr: Error | null = null
  for (const p of profiles) {
    try {
      if (p.provider === 'anthropic') {
        return await anthropicVision(p, pngDataUrl, promptText)
      }
      return await openaiVision(p, pngDataUrl, promptText)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastErr ?? new Error('所有 API 配置均调用失败')
}

async function openaiVision(profile: Profile, pngDataUrl: string, promptText: string): Promise<string> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`
    },
    body: JSON.stringify({
      model: profile.visionModel,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: pngDataUrl } }
          ]
        }
      ]
    })
  })
  if (!res.ok) throw new Error(await describeError('VISION', res, url))
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  return json.choices?.[0]?.message?.content ?? ''
}

async function anthropicVision(profile: Profile, pngDataUrl: string, promptText: string): Promise<string> {
  const url = `${profile.baseUrl.replace(/\/$/, '')}/messages`
  // 去掉 data:image/png;base64, 前缀
  const base64 = pngDataUrl.replace(/^data:image\/\w+;base64,/, '')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': profile.apiKey!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: profile.visionModel,
      temperature: 0,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text', text: promptText }
          ]
        }
      ]
    })
  })
  if (!res.ok) throw new Error(await describeError('VISION', res, url))
  const json = (await res.json()) as { content: Array<{ text: string }> }
  return json.content?.[0]?.text ?? ''
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}

async function describeError(prefix: string, res: Response, url: string): Promise<string> {
  const body = await safeText(res)
  const looksLikeHtml = /^\s*<(!doctype|html|head)/i.test(body)
  const hints: string[] = []
  if (looksLikeHtml || res.status === 404) {
    hints.push(`接口地址可能不对。当前请求的是:${url}。请确认 Base URL 正确且以 /v1 结尾。`)
  }
  if (res.status === 401 || res.status === 403) {
    hints.push('鉴权失败:请检查 API Key 是否正确。')
  }
  if (res.status === 429) {
    hints.push('请求过于频繁或额度不足(429)。')
  }
  if (res.status >= 500) {
    hints.push('服务端错误(5xx)，可能是上游服务暂时不可用。')
  }
  const hint = hints.length ? ` ${hints.join(' ')}` : ''
  return `${prefix}_FAILED:${res.status}:${hint || body}`
}
