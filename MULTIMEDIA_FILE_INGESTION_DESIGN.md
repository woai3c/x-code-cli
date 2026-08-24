# 多媒体与本地文件摄取重构设计方案

> 状态：已完成首轮评审并按结论修订；首版实现已落地，本文同时作为实现说明与验收基线
>
> 范围：用户通过 `@path`、裸绝对路径或 `readFile` 读取的本地文本、PDF、Office、图片、音频、Notebook 和未知二进制文件。
>
> 核心目标：所有文档和音频先在本地做确定性预处理，只把文本和模型真正支持的图片发送给大模型；不再依赖 Provider 的原生 PDF、音频或通用文件上传能力。

## 1. 摘要

改造前的 X-Code CLI 已经具备文本、PDF 文本提取、Office 文档解析、图片压缩、图片 OCR、PDF OCR、音频本地转写和 Notebook 渲染能力，但这些能力分布在 `file-ingest.ts`、`read-file.ts`、`provider-compat.ts` 和静态 Provider 能力表中，存在以下关键问题：

1. `@PDF` 和 `readFile(PDF)` 使用两套不同逻辑；前者优先提取文本，后者直接返回原始 PDF `file-data`。
2. PDF 使用“整份文档提取文本超过 200 字符”的全局判断，无法正确处理混合型 PDF。
3. 扫描 PDF 在部分 Provider 下仍会发送原始 PDF，而不是本地渲染成页面图片。
4. 音频虽然产品目标是统一本地转写，但 `@audio` 仍可能因静态 `audio: true` 跳过本地 Whisper。
5. 已知但不支持的二进制文件可能被当作 UTF-8 文本发送。
6. 可解码但模型不接受的图片格式会被拒绝，而不是转成 PNG/JPEG。
7. 大型 PDF 缺少按页、渐进式读取机制，容易产生高延迟、大请求和持久化上下文膨胀。
8. 历史 Session 中已经存在的 PDF/音频 FilePart 仍可能在恢复后重复触发 Provider 错误。

本方案将文件处理收敛为以下产品规则：

```text
文本 / 代码       → 本地读取为带行号文本
Office             → 本地提取结构化文本
Notebook           → 本地渲染可读单元格文本
音频               → 始终本地转写，只发送时间戳文本
文本型 PDF         → 本地逐页提取文本
扫描 / 混合 PDF    → 文本页发送文本；视觉页发送页面图片，非视觉模型则本地 OCR
大型 PDF           → 轻量引用 + readFile(pages) 按需读取
图片               → 本地验证、规范化、压缩；只发送 PNG/JPEG/GIF/WebP
未知二进制         → 明确拒绝，不发送乱码
```

只有图片继续作为原生多模态内容发送。PDF 原始字节、音频原始字节和 Office 原始字节均不发送给模型。

## 2. 已确认的产品决策

以下决策在实施阶段视为已定，不再按 Provider 分叉：

| 主题       | 决策                                                                |
| ---------- | ------------------------------------------------------------------- |
| 音频       | 始终使用本地模型转写，任何 Provider 都只收到文本                    |
| PDF        | 不发送原始 PDF FilePart，不使用 Provider 原生 PDF 能力              |
| 文本型 PDF | 本地逐页提取文本                                                    |
| 扫描型 PDF | 本地栅格化为页面图片；视觉模型接收图片，非视觉模型接收本地 OCR 文本 |
| 混合型 PDF | 逐页分类并保持原始页序，不能使用整份文档级二分判断                  |
| 大型 PDF   | 不自动内联所有页面，使用轻量引用和 `readFile.pages` 渐进式读取      |
| 图片       | 当前模型支持视觉时发送标准图片 part；否则使用本地 OCR 或明确提示    |
| Office     | 保持本地提取文本，不增加 Provider 原生 Office 上传                  |
| 未知二进制 | fail closed，返回清晰错误，不尝试 UTF-8 解码                        |
| 云文件上传 | 不实现 `/files`、file ID 或 Provider 专用托管文件流程               |
| 跨平台     | 不依赖系统安装 `pdftoppm`、`pdfinfo`、ImageMagick 或其他外部命令    |

如果实施中必须改变上述决策，应先更新本文档并单独评审。

## 3. 术语和边界

### 3.1 文件摄取入口

本方案覆盖两个入口：

1. 用户消息附件入口：
   - `@relative/path`
   - 裸绝对路径
   - 后续可能增加的附件选择器、拖放和剪贴板
2. 模型工具入口：
   - `readFile({ filePath, offset, limit, pages })`

两个入口必须共享分类器和 PDF/图片/音频处理核心，区别只应存在于最终 AI SDK 内容格式的适配层。

### 3.2 文本页、视觉页、双通道页和混合 PDF

- 文本页：PDF 内有足够、可用、可打印的文本，且页面不需要额外视觉信息，适合直接作为文本发送。
- 视觉页：文本为空、极少或明显损坏，通常是扫描件、幻灯片或图片页。
- 双通道页：既有可直接提取的可靠文本，又可能包含图表、布局、签章或其他不可由文本层完整表达的信息。
- 混合 PDF：同一文件同时包含文本页和视觉页。

页分析不能只使用互斥的 `text | visual` 二分结果。首版应至少独立记录 `hasUsableText` 和 `needsVisual`，并可派生为 `text | visual | both`。这样既不会丢弃短页面中可精确提取的文本，也不会因为某页文字较多就漏掉图表或签章。视觉需求判断首版可以保守，并允许模型通过 `readFile.pdfMode = "visual"` 显式覆盖。

### 3.3 “本地处理”的隐私含义

“本地处理”不等于“内容完全不离开本机”：

- 音频原始字节不上传，但转写文本会发送给模型。
- PDF 原始字节不上传，但提取文本或栅格化后的页面图片会发送给模型。
- Office 原始字节不上传，但提取文本会发送给模型。
- 普通图片只发送给当前请求所使用的视觉 Provider；不得在没有明确产品开关和提示的情况下自动转发给另一个已配置 Provider。文本模型默认使用本地 OCR，或提示用户切换视觉模型。

README 和 UI 提示必须准确描述这一边界。

## 4. 改造前实现基线

本节记录评审时的旧实现，用于解释问题来源；目标实现与实际模块见第 8 节及后续设计。

### 4.1 用户附件入口

`packages/core/src/agent/file-ingest.ts` 当前负责：

```text
text / unknown → UTF-8 文本
Office         → 本地解析文本
PDF            → 全局文本提取；少于 200 字符时原生 PDF 或 OCR
image          → 图片压缩、原生图片或 OCR/视觉回退
audio          → 原生音频 FilePart 或本地 Whisper
```

主要限制：

- 单个内联文本输出：256 KB
- PDF 源文件：20 MB
- 图片源文件：25 MB
- PDF 文本提取：前 200 页
- PDF OCR：前 20 页
- 图片最长边：2000 px
- 图片原始字节预算：3.75 MB

### 4.2 readFile 工具入口

`packages/core/src/tools/read-file.ts` 当前负责：

- 文本：按行读取，默认最多 2000 行和 256 KB。
- Notebook：本地渲染单元格。
- 音频：始终本地转写。
- 图片：压缩后返回 `image-data`。
- Office：本地提取文本。
- PDF：5 MB 以下直接返回原始 `file-data`。
- text / unknown：按文本读取。

这意味着同一 PDF 会因入口不同而产生不同结果：

```text
用户 @report.pdf    → 提取文本 / OCR / 可能的 PDF FilePart
模型 readFile(pdf)  → 原始 PDF FilePart
```

### 4.3 Provider 能力表

`packages/core/src/providers/capabilities.ts` 当前将以下能力放在 Provider 静态表中：

```ts
interface ProviderCapabilities {
  image: boolean
  pdf: boolean
  audio: boolean
  filesApi: boolean
  toolImageTransport: 'tool-result' | 'user-message' | 'unsupported'
}
```

`pdf`、`audio` 和 `filesApi` 与新的产品策略不再一致：

- PDF 不再走 Provider 原生输入。
- 音频不再走 Provider 原生输入。
- `filesApi` 当前没有实际上传实现。

目标能力表只需要描述仍会发送到 Provider 的媒体能力，即图片和工具图片传输方式。

## 5. 问题清单

### 5.1 P0：PDF 两条路径行为不一致

### 表现

- `@PDF` 优先本地提取文本。
- `readFile(PDF)` 直接返回原始 PDF。
- 两者的大小限制分别为 20 MB 和 5 MB。
- 两者的错误、提示和后续 Session 行为不同。

### 影响

- 用户无法预测同一文件会以什么形式发送。
- Provider 行为和费用依赖入口。
- 修复扫描 PDF 时必须修改两套代码，容易再次漂移。
- 恢复 Session 后可能保留无法被当前模型接受的原始 PDF part。

### 解决方案

建立共享的 PDF 领域处理函数，两个入口只做输出格式适配。

### 5.2 P0：整份 PDF 的 200 字符判断会丢页

### 表现

当前逻辑只检查整份 PDF 的文本长度：

```text
extracted.trim().length > 200 → 整份 PDF 当文本处理
```

### 失败示例

```text
第 1-3 页：目录，提取到 500 字
第 4-50 页：扫描合同，无文本层
```

由于整份文档超过 200 字符，第 4-50 页不会被渲染或 OCR。

另一个常见场景：文本型报告包含流程图、图表和截图。文本提取成功并不代表视觉信息不重要。

### 解决方案

使用 `pdf-parse` 返回的 `TextResult.pages` 逐页分类，保留页码和顺序。

### 5.3 P0：扫描 PDF 仍可能发送原始 PDF

### 表现

静态 `caps.pdf` 为 true 时，扫描 PDF 会构造 `application/pdf` FilePart。

### 影响

- ChatGPT Codex endpoint 没有正式的 PDF 输入类型。
- OpenAI/Provider adapter 对 PDF 的支持并不一致。
- 原始 Base64 PDF 持久化进消息历史，容易造成请求膨胀或 Session poisoning。
- 产品策略要求 PDF 统一在本地处理。

### 解决方案

彻底移除新消息中的原始 PDF FilePart 生成路径。扫描页先本地栅格化，然后仅输出文本或图片。

### 5.4 P0：音频入口不一致

### 表现

- `readFile(audio)` 已始终本地转写。
- `@audio` 会根据 `caps.audio` 决定原生上传或本地转写。
- OpenAI 和 Google 当前静态配置为 `audio: true`。

### 影响

- 同一音频因入口不同而产生不同隐私和协议行为。
- 当前 AI SDK Responses adapter 会在 fetch 前拒绝音频 FilePart。
- README 的“模型不支持时才本地转写”不再符合产品决策。

### 解决方案

移除 `@audio` 原生分支，始终复用 `transcribeAudio()`；从文件摄取决策中删除 `audio` Provider capability。

### 5.5 P0：未知二进制可能被当作文本

### 表现

`classifyFile()` 可以返回 `unknown`，但两个入口都把 `unknown` 与 `text` 一起按 UTF-8 读取。

### 失败示例

- ZIP
- EXE
- SQLite
- 字体
- 未列入 Office 白名单的二进制文档

### 影响

- 向模型发送大量乱码和替换字符。
- 浪费上下文。
- 可能把不应内联的二进制片段暴露给外部模型。

### 解决方案

将未知文件进一步分成：

```ts
type FileKind = 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'notebook' | 'binary'
```

只有通过文本判定的文件才能走 UTF-8 路径。

### 5.6 P1：可解码图片没有规范化

### 表现

- 文件可能被识别为 BMP/TIFF/ICO/AVIF/HEIC。
- Provider 只接受 PNG/JPEG/GIF/WebP。
- 当前入口会直接拒绝非白名单 MIME。

### 影响

用户需要手动转换本地图片，而 Pi、Codex 等竞品会将可解码格式转为 PNG/JPEG。

### 解决方案

先验证真实 MIME，再尝试通过 Jimp 解码：

```text
标准格式 → 按现有逻辑压缩
可解码非标准格式 → 转 PNG/JPEG → 压缩
不可解码 / 伪装格式 → 明确拒绝
```

动画 GIF/WebP 在无需转换时保持原格式；一旦超出尺寸或字节预算，首版明确拒绝并提示用户主动转换，不静默展平为首帧。

### 5.7 P1：大型 PDF 只能截断，不能渐进式读取

### 表现

- 文本提取最多 200 页。
- OCR 最多 20 页。
- 超出后只追加截断提示。
- `readFile` 没有 `pages` 参数。

### 影响

模型无法按需继续读取剩余页面，只能依赖 shell 或重新处理整份文件。

### 解决方案

为 `readFile` 增加 PDF 专用 `pages` 参数，并让大型扫描/混合 PDF 默认生成轻量引用。

### 5.8 P1：二进制媒体会长期驻留上下文

图片和原始 FilePart 一旦写入消息历史，每次请求都可能重复发送。PDF 页面图片数量如果不受控，会造成：

- Prompt 缓存前缀变大。
- 输入 token 和请求字节数增加。
- Context compaction 过晚。
- 恢复 Session 时加载大量 Base64。

解决方案是限制自动内联页数和累计图片预算，并对大型文档使用引用 + 按页读取。

### 5.9 P2：附件路径和 UI 能力不足

当前路径提取正则不支持可靠的带空格路径和附件生命周期管理。后续可以增加：

```text
@"D:\docs\my report.pdf"
```

以及附件预览、删除、剪贴板和模糊文件选择。该问题不阻塞本次内容处理重构。

## 6. 竞品结论

### 6.1 Codex CLI

- 原生内容模型包含 Text、Image 和 Audio，但没有 PDF/File。
- 普通 PDF 通常只是路径，交给模型通过工具处理。
- 不会自动把 PDF 页面转换为图片。
- 有完善的图片解码、缩放、格式规范化和模型 input modalities。
- 当前协议同时支持普通 `LocalAudio` 输入并在发送前快照为 Data URL；这不改变 X-Code 将音频统一做本地转写的产品决策。

结论：借鉴其图片规范化和模型级视觉判断，不借鉴 PDF 路径。

### 6.2 Claude Code

- 支持原生 PDF document block。
- 支持 `Read({ pages: "1-5" })`。
- 使用 `pdftoppm -jpeg -r 100` 将指定页渲染成图片。
- 一次最多 20 页。
- 超过 10 页的 `@PDF` 变成轻量引用，引导模型按页读取。
- 页面图片继续经过 2000 px / 5 MB 限制。

结论：重点借鉴“轻量引用 + 按需页范围”的渐进式策略，不依赖其 Provider 原生 PDF 和外部 Poppler 命令。

### 6.3 Pi

- 只支持 TextContent 和 ImageContent。
- 非图片 `@file` 按 UTF-8 读取，PDF 会变成乱码。
- 图片会尝试转 PNG，并在 PNG/JPEG、多档质量和逐级缩放之间选择。

结论：不借鉴 PDF；借鉴可解码图片自动规范化。

### 6.4 Kimi CLI

- `ReadFile` 使用非文本后缀清单、文件头采样和 NUL 检测拒绝未知二进制。
- `ReadMediaFile` 根据当前模型的图片/视频能力决定是否注册和执行。
- 媒体标签属性使用 HTML 属性转义，避免路径破坏标签结构。
- 已知图片/视频后缀当前可在魔数校验前直接作为媒体返回，因此其分类顺序不能原样复制。

结论：借鉴 fail-closed、能力注入和统一标签转义；不复制扩展名可覆盖真实字节的分类捷径。

### 6.5 OpenCode

- UI 支持 PDF，但本地不提取文本、不 OCR、不渲染页面。
- 原始 PDF 以 Data URL FilePart 发送。
- 根据模型 PDF capability 决定保留或替换为错误文本。
- 新 OpenAI Responses adapter 明确拒绝 PDF，显示模型目录与 adapter 可能不一致。
- 未知二进制使用 MIME、魔数和内容采样拒绝，不会盲目读取为文本。

结论：借鉴其未知二进制 fail-closed 和媒体能力校验；不借鉴原始 PDF 直传。

## 7. 目标行为矩阵

| 文件类型          | 自动附件 `@path`           | `readFile`                      | 发送给模型         |
| ----------------- | -------------------------- | ------------------------------- | ------------------ |
| 文本/代码         | 本地读取，256 KB 上限      | 行号、offset/limit、256 KB 上限 | 文本               |
| Notebook          | 本地渲染单元格             | 同一渲染器                      | 文本               |
| Office            | 本地格式化提取             | 同一提取器                      | 文本               |
| 音频              | 本地转写                   | 本地转写                        | 时间戳文本         |
| 标准图片          | 验证、压缩                 | 验证、压缩                      | 图片或视觉回退文本 |
| 可解码非标准图片  | 转 PNG/JPEG、压缩          | 同一处理器                      | 图片或视觉回退文本 |
| 纯文本 PDF        | 逐页文本，受总字节预算限制 | 同一 PDF 管线                   | 文本               |
| 小型扫描 PDF      | 页面图片或 OCR             | 同一 PDF 管线                   | 图片/文本          |
| 小型混合 PDF      | 按页混合输出               | 同一 PDF 管线                   | 文本 + 图片        |
| 大型扫描/混合 PDF | 轻量引用                   | `pages` 按需读取                | 按需文本 + 图片    |
| 未知二进制        | 清晰错误                   | 清晰错误                        | 不发送内容         |

## 8. 目标架构

### 8.1 模块划分

建议最小化但清晰地拆分为：

```text
packages/core/src/agent/
  file-ingest.ts            # 路径提取和文件类型总调度
  file-classifier.ts        # MIME/魔数/文本编码/二进制分类
  image-ocr.ts              # Tesseract worker、ocrImage
  local-media.ts            # 中立结果到 user/tool part 的适配
  notebook-render.ts        # 两个入口共用的 Notebook 文本渲染
  pdf-ingest.ts             # PDF 检查、逐页分析、选择、渲染、OCR
  pdf-render-protocol.ts    # PDF worker 消息协议
  pdf-render-worker.ts      # PDF.js 解析和逐页 Canvas 渲染
  audio-transcribe.ts       # 保持现有实现
  provider-compat.ts        # 图片传输和历史遗留媒体清理

packages/core/src/utils/
  image-compress.ts         # 图片预检、规范化、预算与 worker 调度
  image-compress-worker.ts  # Jimp 解码、缩放和编码

packages/core/src/tools/
  read-file.ts              # 参数验证、输出适配，调用共享处理器

packages/core/src/providers/
  capabilities.ts           # 摄取只消费图片能力；兼容保留 deprecated 字段
```

为避免循环依赖，Tesseract worker 和 `ocrImage()` 位于 `image-ocr.ts`；分类器位于 `file-classifier.ts`。Office 提取暂由 `file-ingest.ts` 导出给 `read-file.ts` 复用，后续如继续扩展格式再独立拆分。

### 8.2 中立输出类型

共享处理器不应直接返回 AI SDK 的 `FilePart`、旧版 `ImagePart`、`image-data` 或 `file-data`，否则用户消息和工具结果会再次耦合。

建议定义：

```ts
export type ProcessedLocalPart =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'image'
      data: Buffer
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      filename?: string
      source?: {
        filePath: string
        page?: number
      }
    }
```

约束：

- 中立领域类型中不存在通用 `file` part。
- 不存在 `audio` part。
- 不存在 `application/pdf` part。
- 共享处理器只输出文本和标准图片。

适配层：

```ts
toUserContentParts(parts): Array<TextPart | FilePart>
toToolResultContent(parts): ToolContentResult
```

AI SDK v7 已将旧 `ImagePart` 标记为 deprecated。用户图片应映射为只承载 `image/*` MIME 的标准 `FilePart`：

```ts
{
  type: 'file',
  data: { type: 'data', data: part.data.toString('base64') },
  mediaType: part.mediaType,
  filename: part.filename,
}
```

这里的 `FilePart` 只是一种 AI SDK 图片表示，必须最终序列化为 Provider 的 `input_image`/image block。持久化消息中的二进制必须使用 Base64 字符串；不能把 `Buffer` 或 `Uint8Array` 放进嵌套的 `data.data`，否则 JSONL 恢复后会变成 SDK 不接受的普通对象。禁止使用它承载 PDF、音频、Office 或未知二进制。用户附件和 readFile 调用相同处理器，只在最后一步映射为各自需要的 AI SDK 结构。

## 9. PDF 处理设计

### 9.1 数据结构

```ts
export type PdfPageKind = 'text' | 'visual' | 'both'

export interface PdfPageAnalysis {
  pageNumber: number
  text: string
  normalizedChars: number
  replacementRatio: number
  hasExtractedText: boolean
  hasUsableText: boolean
  needsVisual: boolean
  kind: PdfPageKind
}

export interface PdfAnalysis {
  filePath: string
  size: number
  totalPages: number
  analyzedPages: number
  pages: PdfPageAnalysis[]
  truncated: boolean
}

export interface PdfPageRange {
  first: number
  last: number
}

export interface ProcessPdfOptions {
  pageRange?: PdfPageRange
  vision: boolean
  mode: 'auto' | 'text-only' | 'visual'
  maxTextBytes: number
  maxRenderedPages: number
  maxRenderedBytes: number
  abortSignal?: AbortSignal
  onNotice?: (message: string) => void
}

export interface PdfReference {
  type: 'reference'
  filePath: string
  size: number
  totalPages: number
  reason: 'too-many-visual-pages' | 'text-budget' | 'analysis-page-limit' | 'rendered-byte-budget'
  processedPages: number[]
  remainingPages: string[]
  suggestedPages: string
}

export type ProcessPdfResult =
  | {
      type: 'content'
      analysis: PdfAnalysis
      parts: ProcessedLocalPart[]
      continuation?: PdfReference
    }
  | PdfReference
  | {
      type: 'error'
      code: 'empty' | 'too-large' | 'password-protected' | 'corrupted' | 'invalid-range' | 'render-failed'
      message: string
    }
```

### 9.2 PDF 预检

处理前必须：

1. 使用 `readFileWithinLimit()` 从同一已打开 handle 最多读取 20 MiB + 1 byte，并拒绝空文件或超限文件。
2. 在这份有界 Buffer 的前 1024 字节确认包含 `%PDF-` 头。
3. 用同一份 Buffer 初始化隔离 PDF worker，捕获加密、损坏和无效格式错误。
4. 获取总页数。
5. 拒绝异常声明页数，并建立整次处理超时。
6. 验证页范围。

首版保留 `MAX_PDF_SOURCE_BYTES = 20 MB`，不要直接复制 Claude Code 的 100 MB：

- Claude Code 使用外部 `pdftoppm` 子进程。
- 当前实现会把整个 PDF 读入 Node Buffer，再由 PDF.js 解析。
- 100 MB 输入可能带来远高于 100 MB 的内存峰值。

提高限制前应使用真实的文本 PDF、扫描 PDF 和压缩炸弹样本做内存基准测试。

源字节限制不能替代解析复杂度限制。首版还应设置可配置的 `PDF_MAX_DECLARED_PAGES`、单页渲染超时和整次处理超时；超时后停止调度新页面。由于 `pdf-parse` 的 `partial` 实现仍会遍历声明页数，异常巨大的 `numPages` 必须在任何页循环前拒绝。

### 9.3 页范围语法

`readFile.pages` 支持：

```text
"5"      → 第 5 页
"1-5"    → 第 1 到 5 页
"10-20"  → 第 10 到 20 页
```

首版不支持开放区间 `"10-"`，避免模型无意请求余下数百页。需要时可在后续版本增加，但仍必须被最大页数限制截断。

约束：

- 1-based。
- first <= last。
- last <= totalPages。
- 单次最多 20 页。
- `pages` 仅适用于 PDF。
- `pages` 与文本文件的 `offset`/`limit` 互斥。

### 9.4 逐页文本提取

使用当前 `pdf-parse` v2 API：

```ts
const result = await parser.getText({
  partial: pageNumbers,
  pageJoiner: '',
})
```

`TextResult.pages` 已包含：

```ts
interface PageTextResult {
  num: number
  text: string
}
```

批量 `getText(pageNumbers)` 失败不能直接把整份 PDF 判为损坏。实现先按页重试以隔离坏文本层；单页仍失败时把该页文本视为空并进入既有视觉渲染/OCR 路径。worker 崩溃、超时、初始化失败仍是任务级错误，不能伪装成普通页面失败。

分类前规范化：

1. Unicode NFC/NFKC 选择一种固定策略；首版建议 NFC，避免改变代码和符号语义。
2. 移除控制字符，但保留换行和制表符。
3. 计算非空白字符数。
4. 计算 `U+FFFD` 和不可打印字符比例。
5. 统一页尾空白。

建议初始判定：

```ts
const PDF_TEXT_PAGE_MIN_CHARS = 80
const PDF_TEXT_PAGE_MAX_REPLACEMENT_RATIO = 0.1

hasExtractedText = normalizedChars > 0 && replacementRatio <= PDF_TEXT_PAGE_MAX_REPLACEMENT_RATIO
hasUsableText = normalizedChars >= PDF_TEXT_PAGE_MIN_CHARS && replacementRatio <= PDF_TEXT_PAGE_MAX_REPLACEMENT_RATIO
needsVisual = mode === 'visual' || !hasUsableText || detectedSignificantPageGraphics
kind = hasExtractedText && needsVisual ? 'both' : needsVisual ? 'visual' : 'text'
```

80 是初始保守值，不应写成不可调的产品契约。测试应覆盖中文、英文、标题页、收据和表单；根据误判数据调整。`detectedSignificantPageGraphics` 首版可以只覆盖可靠的页面大图信号；无法可靠识别的矢量图表由显式 `pdfMode: 'visual'` 兜底。

短文本页可以判为 `both`：保留可提取的精确文本，同时提供页面视觉信息。长文本页首版仍可能漏判矢量图表，因此 `readFile` 必须从首版公开 `pdfMode: 'visual'`，不能把唯一的恢复路径留在内部接口。

### 9.5 处理模式

### auto

默认模式：

- text 页输出文本。
- visual 页在视觉模型下输出页面图片。
- visual 页在非视觉模型下输出本地 OCR 文本。
- both 页在视觉模型下按页输出提取文本和页面图片；非视觉模型下输出提取文本，并在需要时附带带来源标识的 OCR 文本。
- 大型扫描/混合 PDF 根据预算返回引用。

### text-only

- 所有页只输出本地文本。
- visual 页执行 OCR。
- 适合文本模型和用户明确要求可搜索文本的场景。

### visual

- 指定范围内的所有页都渲染为图片。
- 适合“检查布局、图表、设计、签章”等任务。
- 首版通过 `readFile.pdfMode` 向模型公开；用户附件仍使用 `auto`。

### 9.6 页面渲染

使用 `PDFParse.getScreenshot()`，不使用系统命令，但必须按单页调用。`pdf-parse` 会把一次调用产生的所有页面 PNG 保存在返回对象中；对多个视觉页一次传入 `partial` 会破坏后文的流式预算和低内存目标。

```ts
const pageInfo = await parser.getInfo({
  partial: [pageNumber],
  parsePageInfo: true,
})
assertRenderBudget(pageInfo.pages[0], PDF_RENDER_WIDTH, PDF_RENDER_MAX_PIXELS)

const screenshot = await parser.getScreenshot({
  partial: [pageNumber],
  desiredWidth: 1600,
  imageDataUrl: false,
  imageBuffer: true,
})
```

选择 `desiredWidth` 而不是固定 `scale` 的原因：

- 让输出宽度更可预测；异常纵横比仍可能产生超高 Canvas，因此必须在调用前按页面元数据计算目标高度和像素数。
- 后续仍会经过 `compressImage()` 的 2000 px 和 3.75 MB 预算。

建议：

```ts
const PDF_RENDER_WIDTH = 1600
const PDF_RENDER_MAX_PIXELS = 16_000_000
```

若页面元数据计算出的目标像素超过限制，应在创建 Canvas 前停止处理该页并返回清晰错误/降级提示。渲染结果检查只能作为二次防线，不能代替预检。

PDF.js Canvas 渲染、PNG 编码和 Jimp 压缩可能占用较长 CPU 时间，即使 API 返回 Promise 也仍可能阻塞 Node 事件循环。生产路径应放入 `worker_threads` 中执行；worker 使用消息传递接收单页任务，完成后转移或释放页面 Buffer。若 worker 无法加载，首版允许受限的进程内回退，但必须保留严格页数/像素/超时限制并显示提示。

页面图片处理：

```text
PDF screenshot bytes
→ sniff real MIME
→ compressImage(existing budget)
→ PNG/JPEG
→ ProcessedLocalPart.image
```

文档页面通常优先保留 PNG 的文字锐度；超出预算时允许转换为 JPEG，并沿用现有质量梯度。

页面前必须增加文本标签：

```text
--- PDF page 4 of 12: report.pdf ---
The following image is the rendered page.
```

不能只发送无页码图片。

### 9.7 视觉页 OCR

当 `vision: false` 或模式为 `text-only` 时：

```text
rendered page image
→ ocrImage(Buffer)
→ page-tagged text
```

要求：

- 正常任务可以复用受调度器保护的 Tesseract worker，但每个 OCR job 必须有独立标识；取消一个任务不能终止其他 root/sub-agent 的并发 OCR。
- 默认语言保持 `eng+chi_sim`。
- 页面顺序串行处理，避免多页并行导致内存峰值。
- 每页和总输出受 256 KB 文本预算限制。
- 若单页文本本身超过 256 KB，则在 UTF-8 码点边界截断并写入明确标记，同时把该页记为已处理；不得把同一页再次放入 continuation，形成重复 `readFile(pages="N")` 循环。
- OCR 失败要保留页码和错误信息。
- 不应同时把同一页 OCR 文本和页面图片都发送，避免重复上下文；`both` 页中的 PDF 原生提取文本不属于 OCR，可与页面图片一起发送。

### 9.8 混合输出和顺序

假设页面分类为：

```text
1 text
2 visual
3 text
4 visual
```

输出必须保持：

```text
TextPart(page 1 label + text)
TextPart(page 2 image label)
ImageFilePart(page 2)
TextPart(page 3 label + text)
TextPart(page 4 image label)
ImageFilePart(page 4)
```

不得先聚合所有文本再追加所有图片，否则页序和语义关联会丢失。

### 9.9 自动内联与轻量引用

不应简单使用“总页数 > 10 就全部引用”，因为 100 页纯文本 PDF 在本地提取后可能仍小于 256 KB，直接发送文本比多轮工具调用更高效。

建议规则：

```text
纯文本 PDF：
  若文本输出 <= 256 KB 且分析页数 <= 200
  → 直接内联文本，不受 10 页视觉限制

扫描 / 混合 PDF：
  若待渲染页面 <= 10
     且累计图片 <= 15 MB
     且总媒体数未超限
  → 混合内联

  否则
  → 返回 PdfReference，引导 readFile.pages
```

建议初始预算：

```ts
const PDF_AUTO_MAX_RENDERED_PAGES = 10
const PDF_READ_MAX_PAGES = 20
const PDF_MAX_RENDERED_BYTES = 15 * 1024 * 1024
const PDF_MAX_TEXT_BYTES = 256 * 1024
```

`PDF_MAX_RENDERED_BYTES` 统计压缩后的原始图片字节，不统计 Base64；发送层还应考虑 Base64 的约 4/3 膨胀。

用户消息入口还必须在所有附件完成格式化后执行第二层累计预算；首版固定为：

```ts
const MAX_ATTACHMENT_TEXT_BYTES = 1024 * 1024
const MAX_ATTACHMENT_MEDIA_PARTS = 10
const MAX_ATTACHMENT_WIRE_BYTES = 21 * 1024 * 1024
```

`MAX_ATTACHMENT_WIRE_BYTES` 按附件 part 的 JSON/Session 表示计数，因此包含 Base64 膨胀、文本转义、文件名和 MIME 元数据。预算按附件原子准入，某个附件不能完整加入时以短文本提示替代，不能加入一半后留下无标签图片。单附件的 256 KB 文本限制同样在行号、编码转换、媒体标签和提示包装完成后复查，源文件大小只能作为读取前的粗筛。

引用文本示例：

```text
<<pdf-reference path="D:\docs\report.pdf">
Pages: 86
Size: 18.2 MB
Reason: this PDF contains too many visual pages to load safely in one request.
Use readFile with pages, for example pages: "1-5". Maximum 20 pages per call.
Start with the first few pages to understand the structure, then request relevant ranges.
<</pdf-reference>>
```

路径必须通过统一的 XML/HTML 属性转义函数处理 `& < > " '` 和换行，不能直接插入属性。`JSON.stringify` 只处理 JSON 字符串边界，不能单独作为 XML 属性转义方案。

### 9.10 错误和降级

| 错误            | 行为                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| 空 PDF          | 明确错误，不写入二进制 part                                                                          |
| 缺少 `%PDF-`    | 判定损坏/伪装文件                                                                                    |
| 密码保护        | 提示用户提供未加密版本                                                                               |
| PDF.js 解析失败 | 提示损坏，不能回退为 UTF-8                                                                           |
| 文本提取失败    | 尝试视觉渲染                                                                                         |
| 页面渲染失败    | 保留页码错误；不发送原始 PDF                                                                         |
| OCR 失败        | 保留页码错误；不发送空文本                                                                           |
| 超过源文件上限  | 返回 `too-large` 错误，建议用户拆分；不能返回无法继续读取的引用                                      |
| 超过图片预算    | 返回引用和未处理页范围，不静默丢页                                                                   |
| Abort           | 立即停止调度后续页面；取消/终止本任务拥有的 parser、render worker 和 OCR job；不能产生部分持久化结果 |

所有 parser 都必须在 `finally` 中调用 `destroy()`。这里的“立即”指收到信号后立即触发取消动作，不承诺第三方同步解码函数能在任意指令点抢占；无法抢占的 CPU 工作必须放进可终止 worker，或明确降级为阶段边界协作式取消。

## 10. readFile 设计

### 10.1 Schema

```ts
inputSchema: z.object({
  filePath: z.string().describe('Absolute path to the file'),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  pages: z.string().optional().describe('PDF page or inclusive range, for example "3" or "1-5"; maximum 20 pages'),
  pdfMode: z.enum(['auto', 'text-only', 'visual']).optional().describe('PDF processing mode; defaults to auto'),
}).superRefine((value, ctx) => {
  if (value.pages && (value.offset || value.limit)) {
    ctx.addIssue({
      code: 'custom',
      message: 'pages cannot be combined with offset or limit',
    })
  }
})
```

运行时仍需验证 `pages` 和 `pdfMode` 只用于 PDF，因为 schema 不知道文件类型。`pdfMode: 'visual'` 是模型处理图表、布局、签章和自动分类漏判时的首版恢复路径。

### 10.2 默认 PDF 行为

```text
readFile(small text PDF, no pages)
→ 处理完整文本

readFile(small scan/mixed PDF, no pages)
→ 预算内处理完整文件

readFile(large scan/mixed PDF, no pages)
→ 返回 reference，要求指定 pages

readFile(PDF, pages="5-10")
→ 只分析并处理第 5-10 页
```

工具描述应明确：

```text
- PDFs are processed locally.
- Text pages are returned as text.
- Scanned/visual pages are returned as images when the model supports vision, otherwise locally OCR'd text.
- For large PDFs, use pages, for example "1-5". Maximum 20 pages per call.
- Original PDF bytes are never uploaded.
```

### 10.3 工具结果映射

共享结果：

```ts
ProcessedLocalPart[]
```

映射为：

```ts
{
  type: 'content',
  value: parts.map(part =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image-data',
          data: part.data.toString('base64'),
          mediaType: part.mediaType,
        },
  ),
}
```

不能再产生 `file-data`。

## 11. 用户附件入口设计

`buildUserContent()` 仍负责：

1. 提取文件引用。
2. 去重。
3. 调用统一文件处理器。
4. 将中立结果映射为 UserContent。
5. 保留用户原始文本。

PDF 映射：

```ts
ProcessedLocalPart.text  → TextPart
ProcessedLocalPart.image → image-only FilePart
PdfReference             → TextPart
```

若当前模型不支持视觉，PDF pipeline 应在产生结果前选择 OCR；不要先生成 image-only FilePart 再依赖 provider-compat 二次 OCR，这会重复渲染并使职责不清。

## 12. 音频处理设计

### 12.1 统一策略

删除：

```text
if caps.audio → FilePart
else → transcribeAudio
```

改为：

```text
所有 audio → transcribeAudio
```

两个入口统一调用：

```ts
transcribeAudio(filePath, { abortSignal, onNotice })
formatTranscription(result, filePath)
```

约束：

- 原始音频不进入 AI SDK 消息。
- 音频源文件最大 25 MiB；以同一份有界暂存字节作为 native 解码输入。
- 转写结果受 256 KB 上限。
- 超长音频返回清晰错误或未来支持分段摘要。
- 保留进度回调和 abortSignal。
- README 改为“所有音频均本地转写”。
- Whisper context 初始化、同步音频解码和异步推理全部在 CLI 的隔离子进程中执行，不能占用 TUI 主线程。
- abort 必须立即结束父进程中的请求并终止当前 Whisper 子进程，因此取消不依赖 native 解码先返回 stop handle。
- Whisper 子进程的 60 秒计时器只表示“任务完成后的空闲时间”；转写运行期间不得启动或触发终止。
- 发布版 CLI 将 externalized 的 `@fugood/whisper.node` 声明为精确版本的 `optionalDependencies`，普通安装应自动取得当前平台 binding；不支持的平台仍由运行时给出明确提示。
- 首次模型下载使用可取消的跨进程文件锁，并在锁内二次检查目标文件；下载 URL 固定到已审计 revision，流式执行精确字节上限与 SHA-256 校验，只有通过校验的临时文件才能 rename 为缓存。
- 已有模型缓存首次使用时也校验长度和完整 SHA-256；初始化失败会在模型锁内重新校验并删除已损坏缓存。
- Whisper 子进程由进程内 single-flight 队列复用；并发任务不能同时覆盖或泄漏 context。

### 12.2 Provider 能力清理

内部最终目标类型：

```ts
export interface ProviderCapabilities {
  image: boolean
  toolImageTransport: 'tool-result' | 'user-message' | 'unsupported'
}
```

停止在摄取逻辑中使用：

- `pdf`
- `audio`
- `filesApi`

`ProviderCapabilities` 当前从 `@x-code-cli/core` 公共入口导出。首个兼容版本应保留 `pdf`、`audio`、`filesApi` 字段并标记 deprecated，只移除内部消费者；在明确的 major 版本中才能删除字段。若选择立即删除，必须作为公共 API 破坏单独评审并增加类型兼容测试。

如果 `filesApi` 未来被其他非摄取功能使用，应在真正实现上传功能时以独立 capability 重新引入，不能让摄取策略依赖一个没有消费者的字段。

## 13. 文件分类与未知二进制

### 13.1 分类顺序

建议：

```text
1. 读取受限文件头并执行 file-type/自定义魔数检测
2. 对 PDF、Office ZIP 等执行结构验证
3. 将扩展名白名单作为类型 hint，而不是覆盖真实字节
4. 未识别文件执行内容采样和编码检测
5. 输出 text 或 binary
```

采样读取前 32 KB，并额外读取最多 4 字节 look-ahead：

```ts
const FILE_TEXT_SAMPLE_BYTES = 32 * 1024
```

固定字节边界可能落在 UTF-8 多字节码点或 UTF-16 代理对中间。分类器必须用 look-ahead 验证边界，或以 streaming decoder 接受“样本末尾尚未完成、文件仍有后续字节”的状态；只有确认读到 EOF 时，尾部不完整序列才能判为无效。

文本判定至少包含：

- UTF-8（含 BOM）正文出现 NUL 字节则 binary。
- UTF-8、UTF-16LE/UTF-16BE BOM 应按对应编码验证；没有 BOM 时默认 UTF-8。
- 非打印控制字符比例低于阈值，例如 10%。
- 不能只根据扩展名判定未知文件为文本。

“出现 NUL 即 binary”只适用于已经排除 UTF-16 BOM 的样本，否则 Windows 生成的 UTF-16 文本会被误判。BOM 只是编码 hint，不能早于 PDF/图片/音频等魔数直接返回 text；魔数检测应剥离 BOM 后执行，既避免 UTF-16LE BOM 被误判为 AAC，也能识别 `UTF-8 BOM + %PDF-` 之类的伪装输入。分类失败或读取文件头失败必须 fail closed，不能像当前 `readFile` 一样回退为 text。

内部检查结果使用精确分类：

```ts
export type InspectedFileKind = 'text' | 'image' | 'pdf' | 'office' | 'audio' | 'notebook' | 'binary'
```

公共 `FileKind` 和 `classifyFile()` 已在既有版本导出。兼容版本保留原联合类型（含 `unknown`）及扩展名优先的旧分类行为；新摄取代码直接使用严格的 `inspectFile()`，避免为了兼容而降低 fail-closed 强度。`IngestedPart` 同期保留旧 `ImagePart` 成员，即使新路径只生成 image-only `FilePart`。

已知二进制错误示例：

```text
[Unsupported binary file: D:\tmp\archive.zip (application/zip, 4.2 MB).]
```

### 13.2 伪装文件

真实 MIME/魔数优先于文件名：

- `photo.png` 实际是 ZIP：拒绝为二进制。
- `scan.bin` 实际是 PDF：进入 PDF pipeline。
- `recording.dat` 实际是 WAV：进入本地音频转写。
- 无扩展 UTF-8 脚本：判定为文本。

新摄取代码使用 `knownMediaTypeFor()`，未知扩展返回 `null`，并优先采用已嗅探和验证的 MIME。既有公共 `mediaTypeFor()` 暂时保留未知扩展回退 `image/png` 的运行时契约并标记 deprecated，经过一个兼容周期后再在 major 版本删除；严格路径禁止调用该兼容函数。

## 14. 图片处理设计

### 14.1 标准路径

```text
用同一已打开 handle 读取源文件（<=25 MB，最多读取 limit + 1 字节）
→ 魔数 MIME
→ 解码/尺寸检查
→ 规范化格式
→ compressImage
→ 最长边 <=2000
→ 原始图片字节 <=3.75 MB
→ 当前 Provider/模型 MIME policy 允许的格式
```

### 14.2 非标准格式转换

处理顺序：

1. 若真实 MIME 为 PNG/JPEG/GIF/WebP 且已经满足尺寸/字节预算，仍必须在受限 worker 中完成一次真实解码验证，成功后才保持原字节；PNG 签名/IHDR/IEND 等容器标记不能替代解码。
2. 需要重编码时先确认所选 codec 确实支持该格式；当前 Jimp 默认 codec 不支持 WebP，不能把 `RECODABLE` 白名单当作真实解码能力。
3. PNG/JPEG/GIF、BMP/TIFF 使用 Jimp 解码；预算内 WebP 使用已随 PDF 运行时发布的 `@napi-rs/canvas` codec 验证。超预算 WebP 在没有重编码 codec 时明确拒绝。
4. 有 alpha 或适合无损时优先 PNG。
5. 超预算时使用 JPEG 质量梯度。
6. 解码失败则返回 unsupported notice。

不应仅因为 Provider 不接受 BMP 就拒绝一个本地可成功转换的 BMP。

### 14.3 安全限制

保留或补充：

- 25 MB 源文件限制。
- 100 MP 解压炸弹限制。
- 2000 px 最长边。
- 3.75 MB 原始字节预算。
- 动画格式检测。
- MIME 与真实字节一致性。
- 所有失败都必须在写入 Session 前转成文本提示。

路径级 `stat` 只用于快速拒绝。图片读取必须在同一 `FileHandle` 上再次 `stat` 并做有界循环读取，防止文件在检查后被替换或继续增长而绕过 25 MB 限制；读取循环本身最多接纳 `limit + 1` 字节。

100 MP 限制必须在完整像素分配前执行。对于无法从文件头安全取得尺寸的格式，应使用能提供解码前元数据的 codec，或把解码放进有内存/超时边界的 worker；在 `Jimp.fromBuffer()` 完成后再检查已经太晚。

动画策略必须唯一且可测试：预算内的 GIF/animated WebP 保留原动画；超出预算时首版默认拒绝并提示转换，不自动静默展平。若未来允许首帧展平，必须由显式选项启用并在输出中标注。

图片 MIME policy 不是全局常量。默认策略可接受 PNG/JPEG/GIF/WebP，但 xAI 当前仅允许 PNG/JPEG；新附件、`readFile` 工具图片、显式 caption 和历史 Session 请求投影都必须携带目标 model id，在进入请求前转换或拒绝不受支持的格式。

## 15. Office 和 Notebook

### 15.1 Office

保持当前格式专用本地解析：

- DOCX：mammoth。
- XLSX：受 sheet/row/cell 限制的表格文本。
- PPTX：读取 slide XML 并保留页序。
- ODT/ODS/ODP：受 ZIP entry 和解压字节限制的 XML 文本。

分类得到的真实 MIME 和 ZIP 根结构优先于扩展名。Office 源文件以 `readFileWithinLimit()` 读取一次，验证、格式分派以及 Mammoth/read-excel-file/ZIP XML 解析均消费同一份有界 Buffer，禁止验证路径后再让解析器重新打开路径。

暂不增加：

- Office 原生上传。
- PPTX 页面图片。
- DOCX 内嵌图片。
- XLSX 图表渲染。

这些可以作为未来“文档视觉模式”扩展，不应与本次 PDF 修复绑定。

### 15.2 Notebook

继续本地渲染：

- 保留 cell 顺序。
- 发送 source 和文本输出。
- 跳过二进制图片输出。
- 保留 5 MB 源文件限制。
- renderer 自身使用 `readFileWithinLimit()`，不能只依赖调用方的路径 `stat()`。

`@notebook` 和 `readFile(notebook)` 复用同一 Notebook renderer。

## 16. Provider 适配与历史消息清理

### 16.1 新消息约束

新生成的用户消息和工具结果必须满足：

```text
允许：text、image-only FilePart、image-data
禁止：application/pdf FilePart
禁止：audio/* FilePart
禁止：未知 binary FilePart
```

Provider compatibility 只负责：

- 当前模型是否支持视觉。
- 工具图片保留在 tool result，还是移到后续 user message。
- 不支持图片时的视觉回退/文本提示。
- 对历史图片执行真实解码和目标模型格式白名单检查；例如 xAI 请求只接收规范化后的 PNG/JPEG。

用户图片迁移为 `FilePart` 后，compatibility 层必须按 `type === 'file' && mediaType.startsWith('image/')` 识别图片并解码 tagged/bare Base64 数据。文本模型执行 OCR 或提示；视觉模型也必须真实解码，必要时把 BMP/TIFF 等转换为标准格式，损坏图片替换为提示。不能继续用 `caps.pdf` 判断所有 `FilePart`，也不能让任何模型收到未验证的 image FilePart。

### 16.2 历史 Session 迁移

旧 Session 可能已保存：

- `application/pdf` FilePart。
- `audio/*` FilePart。
- 非标准图片 part。

在发送下一次请求前增加兼容清理：

```text
legacy PDF part      → 替换为文本提示，不重新发送原始 PDF
legacy audio part    → 替换为文本提示，不重新发送原始音频
decodable image part → 在请求副本中验证并规范化，视觉模型接收标准图片
bad image part       → 在请求副本中替换为文本提示，不先发送并等待 400
```

建议提示：

```text
[Legacy PDF attachment omitted after local-file processing policy upgrade. Reattach or read the original file path to process it locally.]
```

如果历史 part 保存了可用的绝对路径且文件仍存在，可以选择重新走本地 pipeline；但首版不依赖路径仍然存在。已内联的历史图片可在请求投影中本地验证/规范化，文本模型沿用本地 OCR；PDF、音频和无法解码的图片安全默认是替换为提示。

首版采用“请求投影”语义：从 canonical `state.messages` 构造深度足够的请求副本，只在副本上清理、OCR 或规范化旧图片，不改写 Session。若未来改成永久迁移，必须原子更新 canonical history、标记 transcript rewrite/cache miss、重新计算安全上下文并持久化快照。禁止让请求副本与 `state.messages` 共享随后会被原地修改的 content/output 对象。

使用 Base64 字符串后不需要修改持久化 schema；但必须增加 nested FilePart 的 JSONL round-trip 测试，确保恢复后的消息仍通过 AI SDK ModelMessage 校验。

## 17. 上下文、缓存和性能

### 17.1 预算原则

必须同时限制：

- 源文件字节。
- 提取文本字节。
- 单张图片字节和尺寸。
- PDF 自动渲染页数。
- PDF 一次 read 页数。
- PDF 累计图片字节。
- 消息中的媒体数量。
- Base64 后的实际请求字节和会话持久化字节。

不能只依赖 Provider 返回 400。

### 17.2 顺序处理

PDF 页面处理首版使用顺序循环：

```text
extract/analyze page
→ render selected page
→ compress
→ OCR if needed
→ append output
→ check budget
```

不要对 20 页使用无界 `Promise.all()`，否则 PDF Canvas、Jimp Buffer 和 OCR worker 会形成高内存峰值。

这里的顺序必须覆盖 `getScreenshot()` 调用本身：每次只渲染一页并在压缩/OCR/预算判断后释放该页数据，不能先调用一次多页 screenshot 再顺序遍历返回数组。

### 17.3 缓存

首版可复用 readFile 的文件指纹：

```ts
{
  ;(mtimeMs, size)
}
```

建议后续增加 Session 级 PDF 分析缓存：

```ts
Map<
  absolutePath,
  {
    fingerprint
    totalPages
    pageTexts
    pageKinds
  }
>
```

不缓存 Base64 页面图片，避免内存和 Session 数据快速增长。只有确认同一页被频繁读取后，再考虑磁盘临时缓存；缓存目录必须位于 `userXcodeDir()`，并有大小和清理策略。

OCR、图片描述和图片兼容投影缓存都使用完整内容 SHA-256；长度加首尾采样不能作为内容身份，否则中间字节不同的图片会错误共享结果。

### 17.4 进度和 UI 线程

PDF 文本提取、页面渲染、图片压缩和 OCR 必须：

- 使用异步 I/O。
- 传递 `abortSignal`。
- 每页或每阶段调用 `onNotice`/`reportProgress`。
- 避免长同步循环冻结 ChatInput 的 stdout 渲染。

异步函数并不等于不占用主线程。Canvas 渲染、PNG/JPEG 编码和大图解码应在 worker thread 中运行；测试需要采样事件循环延迟，而不是只断言函数返回 Promise。第三方 API 没有 `AbortSignal` 参数时，adapter 应注册 abort listener 并取消本任务的 render/OCR job，或终止本任务独占的 worker。

建议进度文本：

```text
Inspecting PDF (86 pages)
Extracting PDF text (1-20/86)
Rendering PDF page 4/10
OCR PDF page 4/10
Compressing PDF page 4/10
```

## 18. 安全与可靠性

### 18.1 输入不可信

本地文档内容和媒体字节都视为不可信数据：

- 不执行 PDF/Office 内嵌脚本或宏。
- 不跟随文档内部外链。
- 不把文档中的文本当成系统指令。
- 不使用 shell 拼接未转义路径。
- 不在项目目录写临时文件。

### 18.2 压缩炸弹和资源耗尽

- PDF：源字节、页数、渲染页数、Canvas 像素和累计输出预算。
- Office ZIP：保持 entry 数和解压总字节上限。
- 图片：保持源字节和像素上限。
- OCR：顺序执行，输出字节上限，空闲 worker 自动释放。
- Notebook：保持源文件上限并跳过二进制输出。

### 18.3 Session poisoning 防护

任何 Provider 可能拒绝的二进制内容都必须在写入 `state.messages` 前处理完毕。400 后的重试清理只能是最后防线，不能作为正常格式协商机制。

## 19. API 和代码改动清单

### 19.1 新增

新增：

```text
packages/core/src/agent/file-classifier.ts
packages/core/src/agent/image-ocr.ts
packages/core/src/agent/local-media.ts
packages/core/src/agent/notebook-render.ts
packages/core/src/agent/pdf-ingest.ts
packages/core/src/agent/pdf-render-protocol.ts
packages/core/src/agent/pdf-render-worker.ts
packages/core/src/utils/image-compress-worker.ts
packages/core/src/utils/bounded-read.ts
packages/core/tests/pdf-ingest.test.ts
packages/core/tests/file-classifier.test.ts
```

### 19.2 修改

```text
packages/core/src/agent/file-ingest.ts
- 移出 OCR worker
- PDF 调用 processPdf
- 音频始终本地转写
- unknown 改为 binary fail-closed
- 中立处理结果到 UserContent 的映射

packages/core/src/tools/read-file.ts
- 增加 pages 参数
- PDF 调用 processPdf
- 删除 MAX_PDF_BYTES 原始 FilePart 路径
- unknown/binary 明确拒绝
- 统一图片规范化

packages/core/src/providers/capabilities.ts
- 摄取逻辑停用 pdf、audio、filesApi；兼容版本保留并 deprecated
- 保留 image、toolImageTransport

packages/core/src/agent/provider-compat.ts
- 只处理图片传输
- 增加历史 PDF/音频 part 清理
- 正确认出 image-only FilePart；历史图片在无别名请求投影中真实解码并规范化

packages/core/src/agent/loop.ts
- 向 createReadFileTool 注入当前 modelId/视觉策略
- 模型切换时随工具缓存失效重建能力绑定

packages/core/src/agent/session-store.ts
- 若适配层仍可能产生嵌套二进制，递归恢复 tagged FilePart；首选在适配层直接存 Base64

packages/core/src/utils/media-type.ts
- 移除未知扩展默认 image/png
- 只返回明确映射，或改为返回 null

packages/core/src/utils/image-compress.ts
- 支持可解码非标准格式进入规范化路径
- 将长 CPU 解码/编码移到 worker，并使格式白名单与真实 codec 一致

packages/cli/esbuild.config.js
packages/cli/package.json
- 将 PDF Canvas 的原生 runtime 依赖纳入发布包策略
- 确保 worker 入口随构建产物发布
- 将 `tesseract.js` externalize 为 CLI 运行时依赖，使其默认 Node worker 能相对已安装包解析
- 将 externalized 的 `@fugood/whisper.node` 放入 CLI `optionalDependencies`，覆盖正常发布安装

packages/core/src/types/index.ts
- 如 LoopState 增加 PDF 分析缓存，补充类型

README.md
README.zh-CN.md
- 更新音频隐私描述
- 更新 PDF 本地处理和大型 PDF 按页读取说明
```

### 19.3 公共 API

首版 `pdf-ingest.ts` 可以保持内部模块，不从 `packages/core/src/index.ts` 导出，避免新增公共 API。现有 `ProviderCapabilities` 已经公开；其字段删除必须保留兼容 deprecated 周期或作为 major change。只有外部插件明确需要复用 PDF 处理器时，再设计稳定公共接口。

## 20. 测试方案

### 20.1 PDF 单元测试夹具

需要最少准备：

1. 3 页纯文本 PDF。
2. 3 页纯扫描 PDF。
3. 混合 PDF：文本页 + 扫描页 + 文本页。
4. 11 页扫描 PDF，触发 reference。
5. 25 页 PDF，验证单次 pages 上限。
6. 密码保护 PDF。
7. 损坏 PDF。
8. HTML/ZIP 重命名为 `.pdf`。
9. 超大页面尺寸 PDF。
10. 中文和英文扫描页。
11. 只有短标题的页面。
12. 提取文本中包含大量 U+FFFD 的 PDF。

测试夹具应尽量小，避免仓库膨胀。可在测试中生成简单 PDF；只有扫描、加密等难以生成的样本才提交最小二进制 fixture。

### 20.2 PDF 行为测试

验证：

- 纯文本 PDF 只产生 text part。
- 扫描 PDF + vision 产生 image part，且页码顺序正确。
- 扫描 PDF + no vision 产生 OCR text，不产生 image。
- 混合 PDF 按原始页序交错 text/image。
- 短标题页保留提取文本并按 `both` 规则提供视觉信息。
- `pdfMode: 'visual'` 能强制渲染文本较多但包含图表的页面。
- 大型扫描 PDF 返回 reference，不静默处理前 20 页。
- `pages: "3"`、`"1-5"` 正确。
- 无效范围、反向范围、超 20 页范围被拒绝。
- `pages` 与 offset/limit 互斥。
- 累计图片预算触发 reference/continuation notice。
- continuation 明确包含 processedPages 和 remainingPages，不会诱导模型重复读取同一范围。
- 单页文本超过总文本预算时被截断并标记，不返回指向同一页的 continuation。
- 批量文本提取失败后逐页重试，单个坏文本层页面仍进入视觉渲染/OCR。
- abort 后 parser 被销毁，不继续 OCR。
- 超高纵横比页面在 Canvas 分配前被拒绝。
- worker 处理期间事件循环延迟保持在约定阈值内。
- 输出中不存在 `application/pdf`。

### 20.3 音频测试

- `@audio` 始终调用 `transcribeAudio()`。
- `readFile(audio)` 行为一致。
- OpenAI/Google 不再产生音频 FilePart。
- 转写文本超过 256 KB 时有明确提示。
- 原始音频 Base64 不进入消息历史。
- 超过 25 MiB 的源音频在 native 解码前拒绝。
- native 解码和转写不阻塞 TUI 事件循环；解码期间取消会立即 settle 并终止隔离进程。
- 转写持续超过 60 秒时子进程不被空闲计时器终止；任务完成 60 秒后才终止。
- 首次下载遇到网络流错误、磁盘 writer 错误或取消时 Promise 会结束、`.tmp` 被清理且无未处理事件。
- 任意 HTTP 200 的错误长度或错误 SHA-256 均不进入缓存；已有坏缓存会在锁内替换。
- 两个并发首次转写只下载一次并复用一个隔离进程 context；多 CLI 进程由同一模型锁串行化。
- 发布 tarball 普通 `npm install` 后能从 CLI package scope 解析 `@fugood/whisper.node`。

### 20.4 分类器测试

- 无扩展 UTF-8 文件 → text。
- ZIP/EXE/SQLite/字体 → binary。
- `.png` 伪装 ZIP → binary。
- `.bin` 但实际 PNG → image。
- `.dat` 但实际 WAV → audio。
- `.bin` 但实际 PDF → pdf。
- NUL 和高非打印比例文件 → binary。
- UTF-16LE/UTF-16BE BOM 文本不因 NUL 被误判为 binary。
- UTF-8 BOM + NUL → binary；UTF-8 BOM + `%PDF-` → pdf，且摄取不产生原始 TextPart。
- 文本中少量合法控制字符不误判。
- UTF-8 码点和 UTF-16 代理对跨越 32 KiB 采样边界时不误判为 binary。

### 20.5 图片测试

- PNG/JPEG/GIF/WebP 保持标准格式。
- xAI 新附件、工具图片和历史 Session 中的 GIF/WebP 在请求前被拒绝或转换，canonical history 不被请求投影修改。
- 仅有 PNG 容器头尾、没有可解码像素数据的损坏文件在写入 Session 前被拒绝。
- BMP/TIFF 等可解码格式转 PNG/JPEG。
- 伪装 MIME 被真实字节覆盖。
- 超 100 MP 拒绝。
- 超 25 MB 拒绝。
- 路径 `stat` 后文件被替换或增长时，handle 级复查/有界读取仍拒绝超过 25 MB 的图片。
- 压缩后满足 2000 px / 3.75 MB。
- 超预算 animated GIF/WebP 明确拒绝且不静默展平。
- 超预算 WebP 在没有可用 codec 时返回明确错误，不伪装成成功压缩。
- 已取消的预算内图片也返回 AbortError，不从预检快路径成功进入结果。
- 适配层最终生成 `input_image`，不是 `input_file`。

最后一项不是为了证明模型支持图片，而是锁定本地 adapter 的请求协议，避免 AI SDK 升级或 Provider shim 修改后发生回归。

### 20.6 readFile 集成测试

使用真实工具调用验证：

```text
readFile(text)
readFile(image)
readFile(audio)
readFile(office)
readFile(pdf)
readFile(pdf, pages)
readFile(binary)
```

断言工具结果只有文本和 `image-data`，没有 PDF/音频 `file-data`。

用户消息附件测试还必须覆盖：100,000 字节换行文本经行号包装后超过单附件上限；UTF-16 转 UTF-8 膨胀；多个单独合规附件累计触发 1 MiB 文本、10 个媒体 part 或 21 MiB 序列化预算。断言预算按附件原子应用，Session 中不存在半个附件。

### 20.7 Session 恢复测试

构造旧 Session 消息：

- PDF FilePart。
- audio FilePart。
- unsupported image FilePart。

恢复并提交下一轮时：

- 不再向 Provider 发送旧二进制 part。
- 替换为文本说明。
- 消息角色/工具调用序列仍合法。
- image-only tagged FilePart 的 Base64 在 JSONL round-trip 后不变，并通过 AI SDK ModelMessage schema。
- 文本模型对 image FilePart 执行 OCR/提示，不依据 PDF capability 误删或透传。
- 请求前 legacy sanitize 不修改 canonical `state.messages`。
- 视觉模型下历史 BMP/TIFF 被规范化为标准图片，损坏图片被替换为提示；两种情况都不修改 canonical history。

### 20.8 跨平台验证

必须在 Windows、macOS、Linux 验证：

- PDF 页面渲染不依赖系统命令。
- Windows 路径和带空格路径。
- abort 行为。
- 临时目录不污染项目。
- PDF.js/Jimp/Tesseract 的路径和 worker 加载。

此外必须对 `npm pack`/发布 tarball 做隔离安装冒烟测试；测试环境不能向 monorepo 根 `node_modules` 解析依赖。隔离包中应实际渲染至少一页 PDF，并从安装目录启动一次无语言数据的 Tesseract Node worker，以锁定 `@napi-rs/canvas` 平台包、PDF worker 入口和 `tesseract.js/worker-script/node` 的运行时解析。

## 21. 验收标准

功能完成必须同时满足：

1. 新消息和 readFile 工具结果不再生成 `application/pdf` FilePart。
2. 新消息和 readFile 工具结果不再生成 `audio/*` FilePart。
3. 纯文本 PDF 在本地提取并按页标记。
4. 扫描 PDF 在视觉模型下按页面图片发送。
5. 扫描 PDF 在非视觉模型下按页本地 OCR。
6. 混合 PDF 不丢失扫描页。
7. 大型扫描/混合 PDF 不全量内联，支持 `readFile.pages`。
8. PDF 页序在 text/image 混合结果中保持正确。
9. 未知二进制不再走 UTF-8 文本路径。
10. 可解码非标准图片能够转成标准图片格式。
11. 所有新媒体路径传递 `abortSignal`，CPU 密集任务可取消且不会终止其他并发 OCR/render job。
12. 历史 Session 的 PDF/音频 FilePart 在发送前被安全清理。
13. image-only FilePart 在 Session round-trip 后保持有效，文本模型不会误删或透传它。
14. 独立安装的发布包能在 Windows、macOS、Linux 渲染 PDF 页面。
15. `pnpm build`、`pnpm typecheck` 和相关单测通过。
16. README 的音频/PDF隐私和行为描述与实现一致。

## 22. 实施阶段

### 阶段 1：统一正确性

目标：先消除协议错误和入口漂移。

1. 提取 `image-ocr.ts`。
2. 建立 `pdf-ingest.ts` 中立输出类型。
3. `file-ingest.ts` 和 `read-file.ts` 共用 PDF pipeline。
4. 音频始终本地转写。
5. 删除新 PDF/音频 FilePart 生成路径。
6. 未知二进制 fail-closed。
7. 加入历史媒体 part 清理。
8. 图片适配层使用 Session-safe Base64 FilePart，provider compat 正确处理该形状。
9. readFile 注入当前模型视觉策略。
10. 完成 P0 测试。

阶段 1 完成后，即使尚未支持按页 reference，也不能再发送原始 PDF/音频。对于超出阶段 1 安全处理范围的扫描/混合 PDF，必须返回明确的“暂不支持/请拆分”错误，不能静默只处理前 N 页；阶段 2 上线后再替换为可继续的 reference。

### 阶段 2：渐进式 PDF

1. 增加逐页分类。
2. 增加页面渲染和混合输出。
3. 增加 `readFile.pages`。
4. 增加大型 PDF reference。
5. 增加累计图片预算。
6. 加入逐页预检、render worker、超时和任务级取消。
7. 把 `@napi-rs/canvas` 与 worker 纳入发布包并完成隔离包三平台冒烟测试。
8. 增加混合/大型/错误 PDF fixture 测试。

### 阶段 3：图片规范化

1. 非标准图片转 PNG/JPEG。
2. `mediaTypeFor()` 不再默认 image/png。
3. 对齐用户附件、readFile 和工具结果图片路径。
4. 增加图片 adapter 请求测试。

### 阶段 4：体验和优化

1. 支持带引号、空格路径。
2. 附件选择器、预览和删除。
3. PDF 分析缓存。
4. OCR 置信度和语言选择。
5. 文本页大图/图表检测。
6. Office 视觉模式。

## 23. 回滚策略

所有新行为应由内部实现切换完成，不改变 Session schema。若 PDF 新管线出现严重回归：

- 可以临时退回“所有 PDF 本地提取文本，扫描页本地 OCR”的安全模式。
- 不能回滚到发送原始 PDF。
- 音频始终本地转写的决策不回滚。
- 未知二进制 fail-closed 不回滚。

可选增加临时环境变量用于诊断：

```text
X_CODE_PDF_MODE=text-only
```

它只允许强制本地 OCR/text，不允许启用原生 PDF。稳定后应删除该临时开关，避免形成长期配置负担。

## 24. 被否决的方案

### 24.1 所有 PDF 原始上传

否决原因：Provider/adapter/endpoint 不一致、Base64 请求膨胀、隐私边界不统一、Session poisoning 风险。

### 24.2 所有 PDF 页面都转图片

否决原因：文本型 PDF 成本和延迟显著增加，大型 PDF 会生成过多视觉 token，文本搜索和引用能力变差。

### 24.3 所有 PDF 都本地 OCR

否决原因：数字文本 PDF 的原始文本质量远高于 OCR；图表和布局仍会丢失；处理速度慢。

### 24.4 继续使用整份 200 字符判断

否决原因：无法处理混合 PDF，会静默丢失扫描页。

### 24.5 依赖 pdftoppm/pdfinfo

否决原因：违反 Windows/macOS/Linux 的零额外系统依赖目标；用户安装状态不可控；shell 路径和权限处理更复杂。当前 `pdf-parse` 已支持逐页文本和截图。

### 24.6 根据 Provider 决定音频/PDF是否本地处理

否决原因：产品行为、隐私、测试和失败模式不一致；目录声明不等于 adapter 和 endpoint 真正支持。

## 25. 最终目标流程

```text
                         ┌────────────────────┐
User @path / readFile ──►│ Unified classifier │
                         └─────────┬──────────┘
                                   │
          ┌────────────┬───────────┼───────────┬──────────────┬────────────┐
          │            │           │           │              │            │
        text         office      notebook     audio          image         pdf
          │            │           │           │              │            │
       local read   local parse  local render local Whisper  normalize   per-page text
          │            │           │           │            + compress   classification
          │            │           │           │              │            │
          │            │           │           │              │      ┌─────┴─────┐
          │            │           │           │              │      │           │
          │            │           │           │              │    text page  visual page
          │            │           │           │              │      │           │
          │            │           │           │              │      │      render locally
          │            │           │           │              │      │       ┌────┴────┐
          │            │           │           │              │      │       │         │
          │            │           │           │              │      │    vision     no vision
          │            │           │           │              │      │       │         │
          │            │           │           │              │      │     image   local OCR
          │            │           │           │              │      │       │         │
          └────────────┴───────────┴───────────┴──────────────┴──────┴───────┴─────────┘
                                               │
                                  ProcessedLocalPart[]
                                     text | image only
                                               │
                          ┌────────────────────┴────────────────────┐
                          │                                         │
                    UserContent adapter                       ToolResult adapter
                TextPart/image FilePart                       text/image-data
                          │                                         │
                          └────────────────────┬────────────────────┘
                                               │
                                        Provider request
                                      text + input_image only
```

该架构让文件内容处理与 Provider 协议解耦：本地处理器只产生文本和标准图片，Provider 层只需要解决模型视觉能力和工具图片传输方式。由此可以同时获得跨 Provider 一致性、更清晰的隐私边界、更低的 PDF 成本，以及对扫描/混合 PDF 更完整的内容覆盖。

## 26. 调研基线与参考路径

本文档基于以下本地仓库快照完成调研；后续实现前若仓库已大幅更新，应重新核对相关路径和行为：

| 项目        | 调研提交                                   | 关键参考                                                                                                                                                                                                 |
| ----------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X-Code CLI  | `3a7e06c24f47e36de99adea45598070fd5c7c4d8` | `packages/core/src/agent/file-ingest.ts`、`packages/core/src/tools/read-file.ts`、`packages/core/src/providers/capabilities.ts`、`packages/core/src/utils/image-compress.ts`                             |
| Codex CLI   | `c9b19deb09c1841ce7acc33ddb96276030936a29` | `codex-rs/protocol/src/user_input.rs`、`codex-rs/protocol/src/models.rs`、`codex-rs/core/src/image_preparation.rs`、`codex-rs/protocol/src/local_media.rs`                                               |
| Claude Code | `9f51e71641c1472293ebe4a7968b44455c00f0ba` | `src/tools/FileReadTool/FileReadTool.ts`、`src/utils/pdf.ts`、`src/utils/attachments.ts`、`src/constants/apiLimits.ts`                                                                                   |
| Pi          | `a69bef789bc95abf0acee16f7b4660b70b650bb9` | `packages/coding-agent/src/cli/file-processor.ts`、`packages/coding-agent/src/core/tools/read.ts`、`packages/coding-agent/src/utils/image-process.ts`、`packages/coding-agent/src/utils/image-resize.ts` |
| Kimi CLI    | `cbc15c076d17f70fec9f89c90c0502e68657f505` | `src/kimi_cli/tools/file/utils.py`、`src/kimi_cli/tools/file/read.py`、`src/kimi_cli/tools/file/read_media.py`、`src/kimi_cli/utils/media_tags.py`                                                       |
| OpenCode    | `6b41ae910c51e72d3d70a4b7e7a75283c74c41db` | `packages/opencode/src/tool/read.ts`、`packages/opencode/src/provider/transform.ts`、`packages/llm/src/protocols/openai-responses.ts`、`packages/llm/src/protocols/utils/bedrock-media.ts`               |

本地 `D:\res\claude-code\README.md` 将该仓库描述为从公开 source map 还原的泄露源码，而非 Anthropic 官方 Git 仓库。本文仅将其作为实现思路参考，不把其中行为视为 Anthropic 的稳定 API 契约。Codex、Pi、Kimi 和 OpenCode 的模型目录及远程能力也可能随服务端更新，因此本设计只吸收其架构模式，不依赖竞品的动态能力声明。
