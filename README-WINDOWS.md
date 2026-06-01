# TextbookAI · Windows 构建指南

本文档说明如何在 Windows 上构建 TextbookAI，以及与 macOS 版本的互通兼容方案。

## 跨平台互通设计

**源码层（完全共享）**
- `src/` 目录下的主进程、渲染进程、预加载脚本全部为纯 TypeScript/JavaScript，不依赖任何平台原生模块。
- macOS 与 Windows 共用同一套 `src/` 源码，mac 上新增的功能会自动同步到 Windows 端，无需额外移植。

**构建层（平台隔离）**
- `electron-builder.yml` 中同时配置了 `mac`、`win`、`linux` 三个平台的打包参数，彼此独立、互不干扰。
- macOS 构建产物输出到 `dist-release/mac-*`，Windows 产物输出到 `dist-release/win-*`，Linux 产物输出到 `dist-release/linux-*`，目录天然隔离，不会互相覆盖。

**数据层（各自独立，可手动迁移）**
- 应用数据（书库、索引、对话记录、配置）存储在系统用户数据目录：
  - **macOS**: `~/Library/Application Support/TextbookAI/`
  - **Windows**: `%APPDATA%/TextbookAI/`（通常为 `C:\Users\<用户名>\AppData\Roaming\TextbookAI`）
- 两平台数据格式完全一致（JSON + PDF/Markdown 副本），如需迁移，直接复制上述目录即可。

**图标与资源**
- `build/icon.png` — 通用图标（mac / linux 也会读取）
- `build/icon.ico` — Windows 安装包专用图标
- `resources/` — 运行时资源目录，两平台共用

## Windows 环境要求

- Node.js ≥ 18
- npm ≥ 9
- Windows 10/11（x64 / arm64）

## 安装依赖

```bash
npm install
```

## 开发调试

```bash
npm run dev
```

## 类型检查

```bash
npm run typecheck
```

## Windows 打包

### 一键打包全部架构（x64 + x86 + arm64）

```bash
npm run pack:win
```

产物示例：
```
dist-release/
  win-ia32/
    TextbookAI-0.10.2-win-ia32-setup.exe
  win-x64/
    TextbookAI-0.10.2-win-x64-setup.exe
  win-arm64/
    TextbookAI-0.10.2-win-arm64-setup.exe
```

### 单独打包指定架构

```bash
# 仅 x64（主流桌面处理器）
npm run pack:win:x64

# 仅 arm64（Surface Pro X / Copilot+ PC 等）
npm run pack:win:arm64
```

## macOS 打包（保持原样）

mac 开发者不受影响，继续沿用：

```bash
npm run pack:mac
```

产物示例：
```
dist-release/
  mac-arm64/
    TextbookAI-0.10.2-arm64.dmg
    TextbookAI-0.10.2-arm64.zip
```

## 注意事项

1. **NoSleepToggle** 是独立的 macOS Swift 工具，不属于 TextbookAI 主应用。Windows 端无需对应替代，主应用本身已跨平台。
2. 若从 mac 迁移数据到 Windows，只需将 macOS 的 `~/Library/Application Support/TextbookAI/` 完整复制到 Windows 的 `%APPDATA%/TextbookAI/` 即可。
3. 所有纯 JS 依赖（pdfjs-dist、tesseract.js、mammoth、xlsx 等）均自带跨平台支持，无需额外编译。
