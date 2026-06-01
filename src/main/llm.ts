// LLM 客户端:通过 llm-adapter 统一调用,屏蔽 OpenAI / Anthropic 差异。
import { callLlm, callLlmStream, callVision } from './llm-adapter'
import type { Chunk, Citation, OutlineNode } from '../shared/types'

interface ChatResult {
  answer: string
  citations: Citation[]
  thinking?: string
}

/**
 * 把用户的(通常是中文)提问转换成用于检索英文教材的英文关键词。
 * 仅用对话接口,不需要 embedding。失败时返回空串,调用方降级为只用原查询。
 */
export async function translateQuery(question: string): Promise<string> {
  const cjk = (question.match(/[一-龥]/g) ?? []).length
  if (cjk === 0) return ''
  try {
    const res = await callLlm({
      model: '', // adapter 内部从 profile 取
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是一位专业的学术检索助手。你的唯一任务是：把用户的中文问题翻译成用于在英文教材中检索的英文关键词。\n' +
            '【你不是在回答用户问题，不是在解释概念】\n' +
            '【要求】\n' +
            '- 只输出 3-8 个最相关的英文术语/短语\n' +
            '- 用空格分隔\n' +
            '- 不要解释、不要标点、不要编号\n' +
            '- 优先选择教材中可能出现的专业术语'
        },
        { role: 'user', content: question }
      ]
    })
    return res.content.trim().slice(0, 200)
  } catch {
    return ''
  }
}

export interface BookInfo {
  /** 规范化书名(可中英并存,如「线性代数 Linear Algebra(第4版)」) */
  title: string
  /** 学科分类,取自常见学科,必要时可自定;无法判断返回「未分类」 */
  subject: string
}

const COMMON_SUBJECTS = [
  '数学', '物理', '化学', '生物', '计算机科学', '电子与电气', '机械工程',
  '医学', '经济学', '金融', '管理学', '法律', '心理学', '哲学', '历史',
  '语言文学', '艺术', '地理与地球科学', '统计学'
]

function buildSubjectPrompt(existingSubjects: string[] | undefined): string {
  const existing = (existingSubjects ?? []).filter((s) => s && s !== '未分类')
  if (existing.length > 0) {
    const unique = Array.from(new Set(existing))
    return `从用户已有的学科分类中选最贴切的一个:${unique.join('、')};都不合适可自拟一个简洁学科名;无法判断填「未分类」。`
  }
  return `从以下常见学科中选最贴切的一个:${COMMON_SUBJECTS.join('、')};都不合适可自拟一个简洁学科名;无法判断填「未分类」。`
}

/**
 * 用对话模型同时产出:规范书名 + 学科分类。
 * 输入清理后的文件名 + 正文样本(开头若干页),只调一次 chat。失败返回 null,调用方降级。
 */
export async function refineBookInfo(rawTitle: string, sampleText: string, existingSubjects?: string[]): Promise<BookInfo | null> {
  try {
    const res = await callLlm({
      model: '',
      temperature: 0.2,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '你是一位教材书库整理专家。你的唯一任务是：根据「原始文件名」和「正文样本」，判断这本书的规范书名与学科分类。\n' +
            '【你不是在评价教材质量，不是在总结内容】\n' +
            '【输出】只输出 JSON:{"title":"...","subject":"..."}\n' +
            '- title: 规范、整洁的书名。知名教材给出通行中文名并保留英文原名（如「线性代数 Linear Algebra」），含版次的保留版次。去掉文件名里的下载站点、格式等噪声。\n' +
            `- subject: ${buildSubjectPrompt(existingSubjects)}`
        },
        { role: 'user', content: `原始文件名:${rawTitle}\n\n正文样本:\n${sampleText.slice(0, 1500)}` }
      ]
    })
    const parsed = JSON.parse(res.content || '{}') as Partial<BookInfo>
    const title = (parsed.title ?? '').trim()
    const subject = (parsed.subject ?? '').trim()
    if (!title && !subject) return null
    return { title: title || rawTitle, subject: subject || '未分类' }
  } catch {
    return null
  }
}

const SYSTEM_ASK = `你是一位严谨的双语学科专家。你的唯一任务是：针对用户的具体问题，基于提供的教材片段给出精准、深入的学术回答。

【你不是导师，不是在做系统教学，不是在提取知识点卡片】
- 不要按"核心概念→原理推导→公式汇总→例子→术语表"的教案结构组织回答。
- 直接回答问题，用自然流畅的叙述方式，按需使用 Markdown 标题、列表、表格等辅助表达。
- 如果问题简单，回答简洁；如果问题复杂，可以深入展开。

【内容要求】
1. 片段为界：严格依据提供的教材片段作答，不臆造。片段不足以完整回答时，先答出片段支持的部分，再明确指出"教材该部分未涵盖以下内容:…"。
2. 深度优先：不要只给结论。涉及概念时讲清定义和前提；涉及公式时写出 LaTeX 并解释符号含义；涉及推导时说明关键思路。
3. 语言：用简体中文讲解（帮助理解而非逐句翻译），逻辑连贯、层次分明。

【排版要求】
- 数学/物理公式用 LaTeX：行内 $...$，独立成行的 $$...$$。例如 $F=ma$、$$\\int_a^b f(x)\\,dx = F(b)-F(a)$$。
- 物理量给出单位，使用规范符号（如 $\\vec{F}$、$\\mathrm{m/s^2}$、$\\Delta E$、希腊字母 $\\alpha,\\theta$ 等），化学式可用下标 $H_2O$。
- 关键概念保留英文术语，以"中文(English)"形式标注，如:受力分析图(free-body diagram)。
- 引用教材信息时，在句末标注来源编号 [1][2]，编号对应片段序号。`

const SYSTEM_LEARN = `你是一位双语学科导师。你的唯一任务是：基于提供的教材片段，围绕用户指定的主题，给出系统化、深度化的学术讲解，帮助用户真正"学会"。

【你不是在做即时问答，不是在提取知识点 JSON，不是在生成大纲目录】
- 不要以"针对您的问题…"开头，这不是对话回答，是教案式讲解。
- 不要输出 JSON，不要输出结构化的知识点列表，不要输出术语表表格。

【内容要求】
1. 教案体：按知识点组织讲解，每个知识点内部包含"定义→原理/推导→公式→例子"的自然逻辑。但不要求强制覆盖所有方面——教材没有的内容直接跳过，不要硬编。
2. 片段为界：严格依据提供的教材片段，不引入片段外内容。信息不足时明确说明"教材此处未覆盖"。
3. 深入浅出：面向想真正学会的人，用类比和直观解释降低理解门槛，但学术准确性不能妥协。
4. 语言：用简体中文讲解，关键术语保留英文并以"中文(English)"标注。

【输出结构】
围绕用户请求的主题，按知识点分节讲解（用 ## 标题）。每个知识点内部自然展开，可包含：
- 定义与概念
- 原理与推导思路
- 重要公式（LaTeX，解释符号）
- 具体例子或应用场景
- 常见误区（如有，不要硬编）

【排版要求】
- 数学/物理公式用 LaTeX：行内 $...$，独立成行的 $$...$$。例如 $F=ma$、$$\\int_a^b f(x)\\,dx = F(b)-F(a)$$。
- 物理量给出单位，使用规范符号（如 $\\vec{F}$、$\\mathrm{m/s^2}$、$\\Delta E$、希腊字母 $\\alpha,\\theta$ 等），化学式可用下标 $H_2O$。
- 引用教材信息时标注 [1][2]。`

/** 基于检索到的片段做问答 */
export async function chat(
  question: string,
  contextChunks: Chunk[],
  mode: 'ask' | 'learn'
): Promise<ChatResult> {
  const contextText = contextChunks
    .map((c, i) => `【片段 ${i + 1}】(第 ${c.pageNo} 页${c.section ? ` · ${c.section}` : ''})\n${c.text}`)
    .join('\n\n')

  const system = mode === 'learn' ? SYSTEM_LEARN : SYSTEM_ASK
  const userMsg =
    contextChunks.length > 0
      ? `教材片段如下:\n\n${contextText}\n\n———\n用户的问题/学习请求:${question}`
      : `(未检索到相关教材片段)\n用户的问题:${question}`

  const res = await callLlm({
    model: '',
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg }
    ]
  })
  // 优先使用模型原生 reasoning(MiMo 等), fallback 到内容解析
  const nativeReasoning = res.reasoning
  const { thinking: parsedThinking, answer } = parseThinking(res.content || '(模型未返回内容)')
  const thinking = nativeReasoning || parsedThinking

  const citations = extractCitations(answer, contextChunks)
  return { answer, citations, thinking }
}

export interface ChatStreamChunk {
  type: 'thinking' | 'answer'
  content: string
}

/** 流式问答:全部内容作为 answer 流式推送。模型若原生输出 <think>,由调用方用 parseThinking 提取。 */
export async function* chatStream(
  question: string,
  contextChunks: Chunk[],
  mode: 'ask' | 'learn'
): AsyncIterable<ChatStreamChunk> {
  const contextText = contextChunks
    .map((c, i) => `【片段 ${i + 1}】(第 ${c.pageNo} 页${c.section ? ` · ${c.section}` : ''})\n${c.text}`)
    .join('\n\n')

  const system = mode === 'learn' ? SYSTEM_LEARN : SYSTEM_ASK
  const userMsg =
    contextChunks.length > 0
      ? `教材片段如下:\n\n${contextText}\n\n———\n用户的问题/学习请求:${question}`
      : `(未检索到相关教材片段)\n用户的问题:${question}`

  const stream = callLlmStream({
    model: '',
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg }
    ]
  })

  for await (const delta of stream) {
    if (delta.startsWith('\x01')) {
      yield { type: 'thinking', content: delta.slice(1) }
    } else {
      yield { type: 'answer', content: delta }
    }
  }
}

/** 从完整文本中分离 thinking 和 answer,支持多种格式 */
export function parseThinking(text: string): { thinking?: string; answer: string } {
  const trimmed = text.trim()
  if (!trimmed) return { answer: '(模型未返回内容)' }

  // 1. "---" 分隔符(最常用,最自然)
  const dashRe = /\n\s*---+\s*\n/
  const dashMatch = dashRe.exec(trimmed)
  if (dashMatch) {
    const thinking = trimmed.slice(0, dashMatch.index).trim()
    const answer = trimmed.slice(dashMatch.index + dashMatch[0].length).trim()
    return { thinking: thinking || undefined, answer: answer || '(模型未返回内容)' }
  }

  // 2. 中文标记格式
  const tStart = trimmed.indexOf('【思考开始】')
  const tEnd = trimmed.indexOf('【思考结束】')
  if (tStart !== -1 && tEnd !== -1 && tEnd > tStart) {
    const thinking = trimmed.slice(tStart + 6, tEnd).trim()
    let answer = trimmed.slice(tEnd + 6).trim()
    const aStart = answer.indexOf('【回答开始】')
    if (aStart !== -1) {
      const aEnd = answer.indexOf('【回答结束】')
      answer = aEnd !== -1 ? answer.slice(aStart + 6, aEnd).trim() : answer.slice(aStart + 6).trim()
    }
    return { thinking: thinking || undefined, answer: answer || '(模型未返回内容)' }
  }

  // 3. <think> 标签格式
  const thinkStart = trimmed.indexOf('<think>')
  const thinkEnd = trimmed.indexOf('</think>')
  if (thinkStart !== -1 && thinkEnd !== -1 && thinkEnd > thinkStart) {
    const thinking = trimmed.slice(thinkStart + 7, thinkEnd).trim()
    const answer = (trimmed.slice(0, thinkStart) + trimmed.slice(thinkEnd + 8)).trim()
    return { thinking: thinking || undefined, answer: answer || '(模型未返回内容)' }
  }

  // 4. Claude tool_call 格式
  const toolMatch = trimmed.match(/<tool_call>[\s\S]*?<\/tool_call>/)
  if (toolMatch) {
    const answer = trimmed.replace(toolMatch[0], '').trim()
    return { thinking: toolMatch[0], answer: answer || '(模型未返回内容)' }
  }

  // 5. 无分隔符,整段作为回答
  return { answer: trimmed }
}

export function extractCitations(answer: string, chunks: Chunk[]): Citation[] {
  const used = new Set<number>()
  const re = /\[(\d{1,2})\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(answer)) !== null) {
    const idx = parseInt(m[1], 10) - 1
    if (idx >= 0 && idx < chunks.length) used.add(idx)
  }
  return [...used].map((i) => {
    const c = chunks[i]
    return {
      chunkId: c.id,
      pageNo: c.pageNo,
      bbox: c.bbox,
      snippet: c.text.slice(0, 120)
    }
  })
}

/** 用云端视觉模型 OCR 一页(传入 PNG dataURL),返回纯文本(整页一段)。
 *  作为 hybrid 模式下本地 OCR 的兜底,识别复杂版面/公式/手写更准。 */
export async function visionOcr(pngDataUrl: string): Promise<string> {
  return callVision(
    pngDataUrl,
    '你是一位专业的教材文字转录专家。你的唯一任务是：把图片中的教材文字逐字转录为纯文本。\n' +
    '【你不是在解释内容，不是在回答问题，不是在总结】\n' +
    '【要求】\n' +
    '- 保持原始阅读顺序与分段\n' +
    '- 不要翻译、不要解释、不要添加任何额外说明\n' +
    '- 若某区域是插图无文字，直接忽略\n' +
    '- 公式尽量保留原始 LaTeX 或文本表示'
  )
}

/** 分析 PDF 当前页截图,用于阅读器里的"截图问 AI"。 */
export async function analyzePageImage(
  pngDataUrl: string,
  pageNo: number,
  prompt?: string
): Promise<string> {
  const userPrompt = prompt?.trim() || '请分析这页教材截图。'
  return callVision(
    pngDataUrl,
    `你是一位严谨的双语教材讲解助手。用户正在阅读 PDF 第 ${pageNo} 页，并把当前页面截图发给你。\n` +
      '请只依据截图可见内容回答，不要编造截图外的信息。\n' +
      '用简体中文讲解，关键英文术语保留为「中文(English)」形式。\n' +
      '如果截图中有公式、图表或题目，请解释其含义、关键步骤和容易误解的点。\n' +
      '数学/物理公式用 LaTeX：行内 $...$，独立公式 $$...$$。\n\n' +
      `用户请求:${userPrompt}`
  )
}

/** 详细结构分析的输出节点 */
export interface OutlineItem {
  title: string
  level: 1 | 2 | 3
  pageNo: number
  summary?: string
}

const SYSTEM_OUTLINE = `你是教材结构分析专家。你的唯一任务是：分析给定的教材页面正文，输出三级层级结构（章/节/知识点）。

【这不是问答，不是知识点讲解，不是教学，不是提取知识卡片】
- 不要解释概念，不要推导公式，不要评价内容质量。
- 只输出结构目录，不要输出任何自然语言解释。

【层级定义】
- level 1 = 章(Chapter)/大部分(Part)：全书主干
- level 2 = 节(Section)：章下的小节，对应教材里的 1.1、1.2 或明显的主题切换
- level 3 = 知识点：**这是重点**。把每一节里讲到的具体概念、定义、定理、公式、方法、模型、重要案例都单独列为一个 level 3 节点。宁可细、不要漏，一节通常拆出 3~8 个知识点。

【字段规则】
- 对每个 level 3 知识点，必须给出 summary：用一句简体中文（20~50 字）点明这个知识点是什么、关键结论或用途，关键术语保留英文并以"中文(English)"标注。章/节的 summary 可省略。
- 标题用简体中文，可保留必要的英文专有名词。

【页码规则·极其重要】
每段正文前都有一个形如「<<PDF_PAGE=N>>」的标记，N 是该段在 PDF 文件中的**物理页序号**（从1开始）。
- 你必须严格根据每个知识点**实际出现的那段正文**前面的 <<PDF_PAGE=N>> 来填写 pageNo。
- 例如：某知识点出现在标记 <<PDF_PAGE=7>> 之后的段落里，则 pageNo 必须填 7。
- 绝对不要使用正文文字里出现的页码（例如页眉页脚印刷的页码、"see page 42""第 130 页"这类），那些是印刷页码，与 PDF 物理页序号不一致。只认 <<PDF_PAGE=N>> 标记。
- 如果某知识点在多个连续页都有相关内容，取它**首次出现**的那一页。
- 所有返回的 pageNo 必须来自输入中实际存在的 <<PDF_PAGE=N>> 值，不要编造页码。
- 只依据给定正文，不要臆造教材里没有的内容；但要把正文里**确实出现**的知识点尽量挖全。

【输出格式】
JSON:{"outline":[{"title":"...","level":1|2|3,"pageNo":数字,"summary":"知识点要点(level3必填)"}]}`

/** 从一批页面正文中抽取详细的层级结构(章/节/知识点)。供 buildOutline 分批调用。 */
export async function extractOutline(
  samples: Array<{ pageNo: number; text: string }>
): Promise<OutlineItem[]> {
  const corpus = samples
    .map((s) => `<<PDF_PAGE=${s.pageNo}>>\n${s.text.slice(0, 600)}`)
    .join('\n\n')
  const validPages = samples.map((s) => s.pageNo).sort((a, b) => a - b)

  const res = await callLlm({
    model: '',
    temperature: 0.2,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_OUTLINE },
      { role: 'user', content: corpus }
    ]
  })
  const raw = res.content || '{}'
  try {
    const parsed = JSON.parse(raw) as {
      outline?: Array<{ title: string; level: number; pageNo: number; summary?: string }>
    }
    return (parsed.outline ?? [])
      .filter((o) => o.title && o.pageNo)
      .map((o) => ({
        title: String(o.title).trim(),
        level: (o.level === 2 ? 2 : o.level === 3 ? 3 : 1) as 1 | 2 | 3,
        pageNo: snapToValidPage(Number(o.pageNo), validPages),
        summary: o.summary ? String(o.summary).trim() : undefined
      }))
      .filter((o) => o.pageNo > 0)
  } catch {
    return []
  }
}

/** 把 AI 返回的页码校验到合法范围。
 *  - 如果在 validPages 内,直接返回。
 *  - 如果偏离超过阈值(3页),视为 AI 幻觉,返回 -1(后续过滤丢弃)。
 *  - 否则吸附到最接近的合法页。
 */
function snapToValidPage(pageNo: number, validPages: number[]): number {
  if (validPages.length === 0) return pageNo
  if (!Number.isFinite(pageNo)) return -1
  if (validPages.includes(pageNo)) return pageNo
  const minP = validPages[0]
  const maxP = validPages[validPages.length - 1]
  // 偏离 batch 范围太远 → 丢弃
  if (pageNo < minP - 3 || pageNo > maxP + 3) return -1
  let best = validPages[0]
  let bestDiff = Math.abs(pageNo - best)
  for (const p of validPages) {
    const d = Math.abs(pageNo - p)
    if (d < bestDiff) {
      best = p
      bestDiff = d
    }
  }
  return best
}

export interface KnowledgePoint {
  title: string
  content: string
  pageNo: number
  difficulty: 'basic' | 'intermediate' | 'advanced'
  category: string
}

const SYSTEM_KNOWLEDGE = `你是顶尖学术教材编写专家。你的唯一任务是：仔细阅读给定的教材片段，把其中每一个独立的知识点都编写成一篇完整的"微型教案"，让读者只看这个知识点就能彻底学会，不需要再翻回原书。

【这不是提取摘要，不是做笔记，不是概括大意】
- 不要写摘要式内容，不要省略步骤，不要概括。
- 每个知识点必须是一个完整的教学单元，定义、原理、公式、推导、例子缺一不可。
- 片段中有的内容必须全部写进去，绝对不能省略。片段中没有的标注"教材未提供"，不要编造。

【输出格式】
{"points":[
  {"title":"...","content":"...","pageNo":N,"difficulty":"basic|intermediate|advanced","category":"..."}
]}

字段说明：
- title: 中文标题，关键术语保留英文，如"梯度下降(Gradient Descent)"
- content: 完整的微型教案，Markdown 格式。必须按以下结构编写（用 ### 标题分隔）。**片段中有的必须写全，绝对不能跳过任何一个方面**：

  ### 定义 (Definition)
  先用中文给出精确定义，然后必须一字不差地附上片段中的英文原文原话（方便背诵记忆）。如果定义涉及前提条件，必须写明。

  ### 定理/定律 (Theorem/Law) [如有]
  如有定理，完整陈述并给出证明思路或推导过程的关键步骤。英文术语保留原话。

  ### 公式与符号 (Formula)
  所有公式用 LaTeX（行内$...$，独立$$...$$）。**每个公式下面必须逐个解释每个符号的物理/数学含义和单位**，不要假设读者知道。

  ### 推导过程 (Derivation)
  关键推导步骤，不要跳步。说明"为什么从这一步到下一步"、"这一步的依据是什么"。

  ### 例子 (Example)
  给出具体数值、具体场景的完整计算过程。不要泛泛而谈"例如..."，要写出具体数字、代入、计算、结果的完整流程。如有英文原文例子，保留原话。

  ### 常见误区 (Pitfall) [如有]
  如有教材中提到的常见错误或易混淆点，写明。

  ### 页码标注
  末尾标注 (p{N})

- pageNo: 该知识点所在片段的页码（取 <<PAGE=N>> 中的 N）
- difficulty: basic(基础概念)/intermediate(需要理解推导)/advanced(高阶应用)
- category: 所属章节主题

【数量要求】
该片段包含多少个知识点就写多少个，不要人为限制数量。**宁可细、不要漏**。该片段中提到的每一个概念、定理、公式、方法、性质、条件都必须单独列为一个知识点。如果该片段是纯目录、纯图表或内容极少（不足一句完整定义），直接返回空 points 数组。

【质量要求】
1. 完整性压倒一切：每个知识点必须达到"只看这个就能学会"的程度。不允许省略、不允许概括、不允许用"详见教材"搪塞。
2. 学术深度：大学教材水平，不科普化、不简化。
3. 严格依据片段：不编造片段外内容。片段未完整覆盖的内容标注"教材此处未给出完整内容"。
4. 英文原话：所有英文术语和定义必须用原文原话，禁止改写、禁止概括。
5. 推导不跳步：每一步都要写出来，不要让读者自己"显然可得"。
6. 例子要具体：必须有具体数值和完整计算过程。

【输出示例】
{"points":[{"title":"极限的 ε-δ 定义 (Limit)","content":"### 定义 (Definition)\\n\\n**中文定义**: 设函数 $f(x)$ 在点 $x_0$ 的某去心邻域内有定义。如果存在常数 $A$，使得对于任意给定的正数 $\\varepsilon$，总存在正数 $\\delta$，当 $0<|x-x_0|<\\delta$ 时，有 $|f(x)-A|<\\varepsilon$，则称 $A$ 为函数 $f(x)$ 当 $x \\to x_0$ 时的极限。\\n\\n**英文原文原话**: *We say that the limit of $f(x)$ as $x$ approaches $x_0$ is $A$, and write $\\lim_{x \\to x_0} f(x) = A$, if for every number $\\varepsilon > 0$ there is a number $\\delta > 0$ such that if $0 < |x - x_0| < \\delta$ then $|f(x) - A| < \\varepsilon$.*\\n\\n### 公式与符号 (Formula)\\n\\n$$\\lim_{x \\to x_0} f(x) = A$$\\n\\n| 符号 | 含义 | 单位 |\\n|------|------|------|\\n| $\\lim$ | 极限运算 | 无 |\\n| $x \\to x_0$ | $x$ 趋近于 $x_0$ | 无 |\\n| $\\varepsilon$ | 任意小的正数 | 无 |\\n| $\\delta$ | 依赖于 $\\varepsilon$ 的正数 | 无 |\\n\\n### 例子 (Example)\\n\\n证明 $\\lim_{x \\to 2} (3x+1) = 7$。\\n\\n对于任意 $\\varepsilon > 0$，我们需要找到 $\\delta > 0$ 使得当 $0 < |x-2| < \\delta$ 时，$|(3x+1)-7| < \\varepsilon$。\\n\\n计算：$|(3x+1)-7| = |3x-6| = 3|x-2|$。\\n\\n要使 $3|x-2| < \\varepsilon$，只需 $|x-2| < \\varepsilon/3$。\\n\\n因此取 $\\delta = \\varepsilon/3$，则当 $0 < |x-2| < \\delta$ 时：\\n\\n$$|(3x+1)-7| = 3|x-2| < 3 \\cdot \\frac{\\varepsilon}{3} = \\varepsilon$$\\n\\n证毕。(p{3})","pageNo":3,"difficulty":"basic","category":"极限与连续"}]}

只输出 JSON，不要任何额外文字。`

/** 从一批 chunks 中深度提取知识点。供 buildKnowledge 分批调用。 */
export async function extractKnowledgePoints(
  samples: Array<{ pageNo: number; text: string; chunkId: string }>
): Promise<KnowledgePoint[]> {
  const corpus = samples
    .map((s) => `<<PAGE=${s.pageNo} CHUNK=${s.chunkId}>>\n${s.text.slice(0, 1200)}`)
    .join('\n\n')

  const res = await callLlm({
    model: '',
    temperature: 0.2,
    maxTokens: 8192,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_KNOWLEDGE },
      { role: 'user', content: corpus }
    ]
  })
  const raw = res.content || '{}'
  try {
    const parsed = JSON.parse(raw) as {
      points?: Array<{
        title: string
        content: string
        pageNo: number
        difficulty: string
        category: string
      }>
    }
    return (parsed.points ?? [])
      .filter((p) => p.title && p.content)
      .map((p) => ({
        title: String(p.title).trim(),
        content: String(p.content).trim(),
        pageNo: Number(p.pageNo) || samples[0]?.pageNo || 1,
        difficulty: (['basic', 'intermediate', 'advanced'].includes(p.difficulty)
          ? p.difficulty
          : 'intermediate') as KnowledgePoint['difficulty'],
        category: String(p.category || '未分类').trim()
      }))
  } catch {
    return []
  }
}

/** 单 chunk 深度拆解：一个 chunk 独占一次 LLM 调用，保证每个知识点有充足的输出空间。
 *  适合 500 字符左右的小 chunk，每个 chunk 通常产出 1-5 个高质量知识点。
 *  @param model 可选的知识拆解专用模型（留空则使用对话模型）
 */
export async function extractKnowledgeFromChunk(
  chunk: { id: string; pageNo: number; text: string; section?: string },
  model = ''
): Promise<KnowledgePoint[]> {
  // 跳过明显无内容的 chunk
  const trimmed = chunk.text.trim()
  if (trimmed.length < 80) return []

  const corpus = `<<PAGE=${chunk.pageNo} CHUNK=${chunk.id}${chunk.section ? ` SECTION=${chunk.section}` : ''}>>\n${trimmed}`

  const res = await callLlm({
    model,
    temperature: 0.2,
    maxTokens: 12000,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_KNOWLEDGE },
      { role: 'user', content: corpus }
    ]
  })
  const raw = res.content || '{}'
  try {
    const parsed = JSON.parse(raw) as {
      points?: Array<{
        title: string
        content: string
        pageNo: number
        difficulty: string
        category: string
      }>
    }
    return (parsed.points ?? [])
      .filter((p) => p.title && p.content)
      .map((p) => ({
        title: String(p.title).trim(),
        content: String(p.content).trim(),
        pageNo: Number(p.pageNo) || chunk.pageNo,
        difficulty: (['basic', 'intermediate', 'advanced'].includes(p.difficulty)
          ? p.difficulty
          : 'intermediate') as KnowledgePoint['difficulty'],
        category: String(p.category || chunk.section || '未分类').trim()
      }))
  } catch {
    return []
  }
}

/** 合并相邻 chunk 为"超级 chunk"，目标 1500 字符左右。
 *  相邻 chunk 通常是连续的，合并后上下文更连贯，同时减少总请求数。 */
export function mergeAdjacentChunks(
  chunks: Array<{ id: string; pageNo: number; text: string; section?: string }>,
  targetLen = 1500
): Array<{ id: string; pageNo: number; text: string; section?: string; sourceChunkIds: string[] }> {
  if (chunks.length === 0) return []
  // 按页码排序，保证相邻性
  const sorted = [...chunks].sort((a, b) => a.pageNo - b.pageNo || a.id.localeCompare(b.id))
  const result: Array<{ id: string; pageNo: number; text: string; section?: string; sourceChunkIds: string[] }> = []
  let current: typeof result[0] | null = null

  for (const c of sorted) {
    if (!current) {
      current = {
        id: c.id,
        pageNo: c.pageNo,
        text: c.text,
        section: c.section,
        sourceChunkIds: [c.id]
      }
    } else if (current.text.length < targetLen && c.pageNo <= current.pageNo + 2) {
      // 相邻或同页，且当前未满，合并
      current.text += '\n\n' + c.text
      current.sourceChunkIds.push(c.id)
      if (c.section && !current.section) current.section = c.section
    } else {
      result.push(current)
      current = {
        id: c.id,
        pageNo: c.pageNo,
        text: c.text,
        section: c.section,
        sourceChunkIds: [c.id]
      }
    }
  }
  if (current) result.push(current)
  return result
}

export type { OutlineNode }
