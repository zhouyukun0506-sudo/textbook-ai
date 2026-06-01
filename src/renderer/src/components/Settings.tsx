import { useState, useMemo } from 'react'
import type { ApiConfig, ApiProfile, ApiProfileInput, OcrMode, Provider } from '@shared/types'

interface Props {
  initial: ApiConfig | null
  onClose: () => void
  onSaved: (cfg: ApiConfig) => void
}

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic Claude'
}

export default function Settings({ initial, onClose, onSaved }: Props): JSX.Element {
  const [profiles, setProfiles] = useState<ApiProfileInput[]>(
    initial?.profiles.map((p) => ({ ...p, apiKey: undefined })) ?? []
  )
  // 记录原始 hasKey 状态(用于占位提示)
  const [hasKeyMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    initial?.profiles.forEach((p) => { map[p.id] = p.hasKey })
    return map
  })
  const [activeId, setActiveId] = useState<string | null>(initial?.activeProfileId ?? null)
  const [knowledgeModel, setKnowledgeModel] = useState<string>(initial?.knowledgeModel ?? '')
  const [concurrency, setConcurrency] = useState<number>(initial?.knowledgeConcurrency ?? 3)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)

  const current = useMemo(() => {
    return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null
  }, [profiles, activeId])

  const updateCurrent = (patch: Partial<ApiProfileInput>): void => {
    if (!current) return
    setProfiles((prev) =>
      prev.map((p) => (p.id === current.id ? { ...p, ...patch } : p))
    )
    setTestMsg(null)
  }

  const addProfile = (): void => {
    const id = crypto.randomUUID()
    const newProfile: ApiProfileInput = {
      id,
      name: '新配置',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      chatModel: 'gpt-4o-mini',
      visionModel: 'gpt-4o-mini',
      ocrMode: 'hybrid'
    }
    setProfiles((prev) => [...prev, newProfile])
    setActiveId(id)
    setTestMsg(null)
  }

  const removeCurrent = (): void => {
    if (!current || profiles.length <= 1) return
    const next = profiles.filter((p) => p.id !== current.id)
    setProfiles(next)
    setActiveId(next[0]?.id ?? null)
    setTestMsg(null)
  }

  const save = async (): Promise<void> => {
    if (profiles.length === 0) {
      setErr('请至少添加一个 API 配置')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      // 空字符串 apiKey 视为"未修改"(保留旧 key),而不是"删除 key"
      const cleaned = profiles.map((p) => ({
        ...p,
        apiKey: p.apiKey && p.apiKey.length > 0 ? p.apiKey : undefined
      }))
      const cfg = await window.api.setApiConfig({
        profiles: cleaned,
        activeProfileId: activeId ?? undefined,
        knowledgeModel: knowledgeModel.trim(),
        knowledgeConcurrency: Number(concurrency)
      })
      onSaved(cfg)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!current) return
    setTesting(true)
    setTestMsg(null)
    try {
      const result = await window.api.testProfile(current)
      setTestMsg(result.ok ? '连接成功 ✓' : `连接失败: ${result.error}`)
    } catch (e) {
      setTestMsg(`测试异常: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        <p className="muted small">
          API Key 经系统加密后仅保存在本机,不会上传到任何服务器。
        </p>

        {/* Profile 列表 */}
        <div className="modal-section-title">配置档案</div>
        <div className="profile-list">
          {profiles.map((p) => (
            <button
              key={p.id}
              className={`profile-chip ${p.id === activeId ? 'active' : ''} ${hasKeyMap[p.id ?? ''] ? 'has-key' : ''}`}
              onClick={() => {
                if (p.id) {
                  setActiveId(p.id)
                  setTestMsg(null)
                }
              }}
            >
              <span className="profile-chip-name">{p.name}</span>
              <span className="profile-chip-provider">{PROVIDER_LABELS[p.provider]}</span>
            </button>
          ))}
          <button className="profile-chip add" onClick={addProfile} title="新增配置">
            ＋
          </button>
        </div>

        {/* 当前 profile 表单 */}
        {current && (
          <>
            <label>
              名称
              <input
                value={current.name}
                onChange={(e) => updateCurrent({ name: e.target.value })}
                placeholder="如 OpenAI / Claude"
              />
            </label>

            <label>
              Provider
              <select
                value={current.provider}
                onChange={(e) => updateCurrent({ provider: e.target.value as Provider })}
              >
                <option value="openai">{PROVIDER_LABELS.openai}</option>
                <option value="anthropic">{PROVIDER_LABELS.anthropic}</option>
              </select>
            </label>

            <label>
              接口地址 (Base URL)
              <input
                value={current.baseUrl}
                onChange={(e) => updateCurrent({ baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
              <span className="field-hint">
                {current.provider === 'anthropic'
                  ? 'Anthropic 通常填 https://api.anthropic.com/v1'
                  : '填 API 根地址,通常以 /v1 结尾。'}
              </span>
            </label>

            <label>
              对话模型
              <input
                value={current.chatModel}
                onChange={(e) => updateCurrent({ chatModel: e.target.value })}
                placeholder={current.provider === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o-mini'}
              />
            </label>

            <label>
              视觉模型 (OCR 云端兜底)
              <input
                value={current.visionModel}
                onChange={(e) => updateCurrent({ visionModel: e.target.value })}
                placeholder={current.provider === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o-mini'}
              />
            </label>

            <label>
              API Key
              <input
                type="password"
                value={current.apiKey ?? ''}
                onChange={(e) => updateCurrent({ apiKey: e.target.value })}
                placeholder={hasKeyMap[current.id ?? ''] && !current.apiKey ? '已配置(留空则不修改)' : 'sk-...'}
              />
            </label>

            <div className="profile-actions">
              <button className="ghost-btn small" disabled={testing} onClick={test}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              {profiles.length > 1 && (
                <button className="ghost-btn small danger" onClick={removeCurrent}>
                  删除
                </button>
              )}
            </div>
            {testMsg && (
              <p className={`small ${testMsg.includes('成功') ? 'success' : 'error'}`}>
                {testMsg}
              </p>
            )}
          </>
        )}

        <div className="modal-section-title">扫描件 OCR</div>
        <label>
          识别模式
          <select
            value={current?.ocrMode ?? 'hybrid'}
            onChange={(e) => updateCurrent({ ocrMode: e.target.value as OcrMode })}
          >
            <option value="hybrid">混合 — 本地优先,质量差的页用云端兜底(推荐)</option>
            <option value="local">仅本地 — 免费、离线,速度中等</option>
            <option value="cloud">仅云端 — 最准,复杂版面/公式更好,按页计费</option>
          </select>
        </label>

        <div className="modal-section-title">知识拆解</div>
        <label>
          知识拆解专用模型（留空则使用对话模型）
          <input
            value={knowledgeModel}
            onChange={(e) => setKnowledgeModel(e.target.value)}
            placeholder="如 deepseek-reasoner / claude-3-5-sonnet-20241022"
          />
          <span className="field-hint">
            可指定更强的模型专门用于知识点拆解。留空则使用上方「对话模型」。
          </span>
        </label>

        <label>
          并行批次数(并发越高越快,但 API 消耗越大)
          <div className="concurrency-row">
            {[1, 3, 5, 8, 10, 15].map((n) => (
              <button
                key={n}
                className={`concurrency-chip ${concurrency === n ? 'active' : ''}`}
                onClick={() => setConcurrency(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="field-hint">
            {concurrency === 1 ? '串行 — 最慢但最稳定' :
             concurrency <= 3 ? '保守 — 推荐日常用' :
             concurrency <= 5 ? '快速 — 适合大文件' :
             concurrency <= 10 ? '极速 — 并发拉满,API 消耗大' :
             '极限 — 可能触发 API 限流'}
          </span>
        </label>

        {err && <p className="error small">{err}</p>}

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
