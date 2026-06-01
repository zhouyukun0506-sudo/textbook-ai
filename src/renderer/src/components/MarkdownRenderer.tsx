import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import MermaidBlock from './MermaidBlock'
import { useMemo } from 'react'

interface Props {
  children: string
  /** 是否把内联的 graph/timeline/pie 等语法自动包成 code block */
  inlineMermaid?: boolean
  /** 额外覆盖的 markdown 组件 */
  components?: Components
}

/** 检测并提取 Mermaid 图表类型 */
const MERMAID_KEYWORDS = [
  'graph',
  'flowchart',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'requirementDiagram',
  'gitgraph',
  'mindmap',
  'timeline',
  'quadrantChart',
  'sankey-beta',
  'xychart-beta'
]

const MERMAID_START_RE = new RegExp(
  `^\\s*(?:${MERMAID_KEYWORDS.join('|')})\\b`,
  'im'
)

/** 把文本中裸露的 mermaid 语法包装成 \`\`\`mermaid 代码块。
 * 规则:遇到 graph/flowchart/sequenceDiagram 等关键字开头的一行,
 * 直到下一个空行或文档结束,视为图表内容。 */
function wrapInlineMermaid(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  let inCodeBlock = false
  while (i < lines.length) {
    const line = lines[i]
    // 检测代码块边界 ```
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      out.push(line)
      i++
      continue
    }
    // 在已有代码块内,直接复制,不做 mermaid 检测
    if (inCodeBlock) {
      out.push(line)
      i++
      continue
    }
    // 不在代码块内,检测裸露的 mermaid 语法
    if (MERMAID_START_RE.test(line)) {
      const blockLines: string[] = [line]
      i++
      while (i < lines.length && lines[i].trim() !== '') {
        blockLines.push(lines[i])
        i++
      }
      out.push('```mermaid')
      out.push(...blockLines)
      out.push('```')
      while (i < lines.length && lines[i].trim() === '') i++
    } else {
      out.push(line)
      i++
    }
  }
  return out.join('\n')
}

/** 把模型输出的 LaTeX 原生语法 \( \) 和 \[ \] 转换为 remark-math 能识别的 $ 和 $$。
 *  很多模型（尤其是非 OpenAI）会输出 \[...\] 而不是 $$...$$。 */
function normalizeLatex(text: string): string {
  // 块级公式: \[ ... \] → $$ ... $$
  // 使用非贪婪匹配，支持跨行
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `$$${math.trim()}$$`)
  // 行内公式: \( ... \) → $ ... $
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${math.trim()}$`)
  return text
}

const markdownComponents: Components = {
  code(props) {
    const { children, className } = props as { children?: string; className?: string }
    const match = /language-(\w+)/.exec(className || '')
    const lang = match?.[1] ?? ''
    if (lang === 'mermaid' && typeof children === 'string') {
      return <MermaidBlock code={children} />
    }
    // 非 mermaid 代码块:只返回 <code>, 外层 <pre> 由 react-markdown 默认渲染
    return <code className={className}>{children}</code>
  }
}

export default function MarkdownRenderer({ children, inlineMermaid = true, components: extraComponents }: Props): JSX.Element {
  const processed = useMemo(() => {
    return normalizeLatex(inlineMermaid ? wrapInlineMermaid(children) : children)
  }, [children, inlineMermaid])

  const mergedComponents = useMemo<Components>(() => {
    const merged: Components = { ...markdownComponents, ...extraComponents }
    if (extraComponents?.code && merged.code) {
      const mermaidCode = merged.code as (props: { className?: string; children?: string }) => JSX.Element
      const externalCode = extraComponents.code as (props: { className?: string; children?: string }) => JSX.Element
      merged.code = ((props: { className?: string; children?: string }) => {
        const match = /language-(\w+)/.exec(props.className || '')
        if (match?.[1] === 'mermaid') return mermaidCode(props)
        return externalCode(props)
      }) as unknown as Components['code']
    }
    return merged
  }, [extraComponents])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      components={mergedComponents}
    >
      {processed}
    </ReactMarkdown>
  )
}
