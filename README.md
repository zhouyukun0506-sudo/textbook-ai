# TextbookAI · AI 双语教材学习工具

> 用中文学习英文原版教材。

TextbookAI 是一款**本地优先**的桌面应用，帮助你将英文 PDF（含扫描件）、Office 文档或 Markdown 教材转化为双语学习材料。AI 自动建立索引并与原文关联，你可以用中文提问或系统学习，回答可一键跳回原文对照。所有数据存储在本地，AI 调用你自己配置的云端模型。

<!-- TODO: 添加应用截图 -->
<!-- ![书架界面](docs/screenshots/library.png) -->
<!-- ![阅读器界面](docs/screenshots/reader.png) -->

---

## ✨ 核心功能

### 📚 本地书架
- 导入 **PDF（含扫描件）**、**Office 文档**（Word/Excel/PPT）与 **Markdown** 文件
- 按学科自动分组成「书架」，支持自由拖拽布局
- 导入即清理文件名：自动去掉 z-lib / PDFDrive / `[标签]` / 下划线等下载噪声
- 配置 API 后，AI 自动优化书名并判定学科；也支持批量「AI 整理书架」

### 🔍 本地检索（BM25）
- **无需向量接口**：只有对话接口的服务（MiMo、DeepSeek 等）也能使用
- 中文提问时，先用对话模型转成英文检索词，跨越「中文问、英文书」的语言鸿沟
- 离线可用，索引秒级构建

### 🗺️ AI 知识地图
- 通读全书，拆解为 **章 / 节 / 知识点** 三级结构
- 每个知识点附一句话中文要点（保留英文术语）
- 侧栏可折叠、点击跳页；支持一键重新生成

### 📖 三栏阅读器
- **左栏** — 目录 / 知识地图（可 AI 生成）
- **中栏** — 原文（PDF / Markdown / Office）
- **右栏** — 中文讲解，支持「提问」与「学习」双模式

### ✍️ 学术级双语解答
- **提问模式**：针对具体问题，中文作答 + 原文出处
- **学习模式**：像老师一样按知识点系统讲解（概览 → 核心概念 → 原理推导 → 公式符号 → 例子应用 → 易错点 → 术语表）
- 完整 **Markdown** 渲染 + **LaTeX** 数学/物理公式排版
- 关键英文术语保留为「中文(English)」形式，界面铜金色高亮
- 点击回答中的出处，左侧原文跳转并高亮

### 🔎 扫描件 OCR
- **混合模式（推荐）**：本地 Tesseract 识别为主，置信度低的页自动用云端视觉模型兜底
- **仅本地**：全程离线、免费，适合清晰扫描件
- **仅云端**：复杂版面/公式/手写更准，按页计费

### 📊 学习统计
- **研读周报**：环形进度条、累计阅读时长、环比、翻译批注数、AI 摘要数
- **阅读热力图**：8 周×7 天方块网格，颜色深浅映射每日阅读时长
- **连续阅读**：火焰图标 + 大号天数，自动计算连续阅读天数与历史最高
- **自由小组件**：可自由添加/删除/调节大小，flex wrap 布局

---

## 🛠 系统要求

| 平台 | 要求 |
|------|------|
| macOS | macOS 11+ (Big Sur 及以上)，支持 Intel 与 Apple Silicon |
| Windows | Windows 10+ |
| Node.js | 18+ |

---

## 🚀 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/zhouyukun0506-sudo/textbook-ai.git
cd textbook-ai
```

### 2. 安装依赖

```bash
npm install
```

### 3. 开发模式启动

```bash
npm run dev
```

### 4. 打包应用

```bash
# macOS
npm run pack:mac

# Windows
npm run pack:win
```

打包产物位于 `dist-release/` 目录下。

---

## 📖 使用指南

1. **配置 API**：启动后点右上角「设置」，填入接口地址、模型名、OCR 模式与 API Key。
   - 支持 OpenAI 兼容接口（只需 base URL + chat model）
   - 支持 Anthropic Claude 接口
   - vision model 仅云端 OCR 时使用

2. **导入教材**：点「导入教材」选择 PDF、Office 或 Markdown 文件。
   - 扫描件会自动进入 OCR，可在书卡看到逐页进度
   - Markdown 与 Office 文档秒级完成

3. **开始学习**：打开书后，左侧目录/知识地图、中间原文、右侧问答面板。
   - 右侧可选「提问」或「学习」模式

4. **引用回跳**：点击回答里的出处，左侧原文跳转并高亮（PDF 跳页高亮，Markdown 跳标题）。

---

## 🧱 项目结构

```
src/
  main/        # 主进程：窗口、IPC、PDF 解析、OCR 编排、索引、LLM、大纲、存储、配置
  preload/     # 安全桥接，暴露受限 API 给渲染进程
  renderer/    # React UI：书房、三栏阅读器、目录、对话面板、设置 + OCR 执行器
  shared/      # 主进程与渲染进程共享的类型与 IPC 通道

build/         # 应用图标资源
electron-builder.yml   # 打包配置
```

---

## 🎨 视觉风格

「优雅 · 文艺 · 专业」

- 暖纸底色、墨色文字、**黛蓝**主色、**铜金**点缀
- 衬线标题字体，书脊质感的书卡，细腻的纸纹与滚动条
- 设计令牌集中在 `src/renderer/src/styles.css` 顶部，易于调整

---

## 🔧 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式启动（热更新） |
| `npm run build` | 生产构建 |
| `npm run typecheck` | 全量类型检查（main + renderer） |
| `npm run typecheck:node` | 仅主进程类型检查 |
| `npm run typecheck:web` | 仅渲染进程类型检查 |
| `npm start` | 预览生产构建 |
| `npm run pack:mac` | 打包 macOS（dmg + zip） |
| `npm run pack:win` | 打包 Windows（nsis） |

---

## ⚡ 技术亮点

- **本地优先**：书、索引、对话全部存储在本地 `userData` 目录；API Key 经系统加密存储，不上传
- **零向量依赖**：纯本地 BM25 词法检索，不需要 embedding 接口
- **跨语言检索**：中文提问自动转英文关键词召回，解决中英文教材语言鸿沟
- **高清渲染**：PDF 按设备像素比（Retina）绘制，文字清晰不糊
- **性能优化**：15+ 处性能优化，包括 BM25 索引缓存、SSE buffer O(n²) 修复、渲染 RAF 批处理、动画 GPU 合成等
- **适配广泛**：支持 DeepSeek / MiMo 等模型的 `reasoning_content` 思考链提取与展示

---

## ❓ 常见问题

**Q: 为什么需要配置 API Key？**  
A: TextbookAI 本身不接入任何 AI 服务，你需要提供自己的 OpenAI 兼容或 Anthropic 接口地址与 Key。数据本地处理，仅调用模型时产生网络请求。

**Q: 扫描件 OCR 支持哪些语言？**  
A: 本地 Tesseract 默认支持英文；中文识别效果取决于扫描质量。混合模式下，识别不佳的页会自动走云端视觉模型。

**Q: 我可以离线使用吗？**  
A: 可以，但功能受限。本地书架、BM25 检索、阅读器完全离线可用；AI 问答、知识地图、OCR（混合/云端模式）需要联网。

**Q: macOS 打开时提示「无法验证开发者」？**  
A: 当前版本未做 Apple 代码签名。请前往 **系统设置 → 隐私与安全性** 点击「仍要打开」，或右键点击应用选择「打开」。

---

## 📝 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 🤝 贡献

欢迎 Issue 与 PR！

如果你发现 bug 或有新功能建议，请先在 [Issues](https://github.com/zhouyukun0506-sudo/textbook-ai/issues) 中搜索是否已有人提出。

---

## 📄 许可证

[MIT](LICENSE)

---

<p align="center">Made with ❤️ for learners.</p>
