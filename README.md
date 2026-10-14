# srt-timeline-aligner · 字幕时间轴对齐工具

> 一个纯本地、无 AI、无联网的 SRT 字幕时间轴对齐工具。
> 适合把字幕时间码对齐到音视频、修复错乱的时间轴、并估算配音时长。

A local-only, no-AI, no-network SRT subtitle **timeline alignment** tool.
Align subtitle timecodes to audio/video, fix broken timelines, and estimate TTS duration.

---

## 它能做什么 / What it does

- **导入 / 编辑 / 导出 SRT**：表格化编辑，时间码与文本都可原地修改；支持区间导出。
- **时间轴对齐（核心）**：
  - **整体偏移**：把整段（或全部）字幕平移 `+1.5s` / `-300ms` 等。
  - **比例缩放**：以首段为锚点整体拉长 / 压缩（如 `1.0382` = 拉长 3.82%）。
  - **两点锚点同步**：已知字幕两处对应视频的真实时间，线性映射全部时间点——这是修正「音画整体错位」的主手段。
  - **从视频取时**：拖入音视频后，把播放头时间直接写入任意时间框。
- **一键修复错乱**：自动处理起始倒退、相邻重叠、时长非法，提供「收窄重叠（总时长不变）」与「保时长顺推」两种策略。
- **时间轴完整性校验**：实时检测倒退 / 重叠 / 超长间隙，顶部横幅与逐行标记提示，可一键跳到第一处问题。
- **配音时长估算**：按设定语速（字/秒）估算每段 TTS 是否会超出时间轴，标出超时片段。
- **其他**：撤销 / 重做、查找替换、合并 / 拆分片段、浏览器语音试听、拖拽导入。

> 设计取舍：本工具**不含任何 AI / 大模型调用**，也不做翻译、润色、自动改写。
> 它从原 `srt-tts-checker` 项目中抽取了「字幕对齐」能力并做了精简，便于作为独立开源工具维护。

---

## 两种运行方式 / Two ways to run

本项目同一套前端代码（`index.html` + `renderer.js` + `styles.css`）既能在 Electron 中运行，也能**直接用浏览器打开**——`renderer.js` 已内置「无 `window.api` 时回退到 `<input type=file>` + 下载」的兼容逻辑。

### 方式一：Electron（推荐，文件对话框体验更好）

```bash
npm install        # 仅安装 electron 开发依赖
npm start          # 启动应用
```

### 方式二：浏览器直接打开（零安装）

直接用浏览器打开 `index.html` 即可（双击或拖入浏览器窗口）。
导入 / 导出走浏览器原生文件选择 + 下载，媒体预览与全部对齐功能完全可用。

---

## 使用流程（对齐字幕到视频）/ Alignment workflow

1. 拖入 `.srt` 文件（或音视频用于同步预览）。
2. 拖入对应的视频 / 音频，播放到「第一处明显对齐点」，点 `⏱ 取当前播放时间` 把播放头写入某段开始。
3. 若整段都存在固定偏移或比例偏差：
   - 固定错位 → 用 **整体偏移** 或 **两点锚点同步**（填两对「原时间 → 视频真实时间」）。
   - 整体偏快 / 偏慢 → 用 **比例缩放**。
4. 若时间轴有倒退 / 重叠 → 点 `🔧 修复错乱`，按提示选择「收窄重叠」或「保时长顺推」。
5. 检查顶部横幅是否为「✓ 时间轴顺序正常」，确认无误后 `导出 SRT`。

---

## 目录结构 / Project layout

```
srt-timeline-aligner/
├── index.html         # 页面结构（已移除所有 AI 配置/按钮/结果区）
├── renderer.js        # 前端逻辑（解析/编辑/导出 + 时间轴对齐 + 媒体同步，无 AI）
├── styles.css         # 样式（已移除 .ai-config / .ai-result 等 AI 相关样式）
├── main.js            # Electron 主进程（已移除 ai-request handler）
├── preload.js         # Electron 预加载（已移除 aiRequest）
├── sample.srt         # 示例字幕
├── demo/              # 演示视频与录制说明（见 demo/README.md）
├── package.json       # 工程元信息
├── LICENSE            # MIT
└── README.md
```

---

## 与原项目的关系 / Relation to upstream

本工程从 `srt-tts-checker`（字幕配音时长分析器）中**抽取「字幕对齐」功能**并剥离了以下 AI 相关部分：

- 删除：AI 全文翻译、AI 自动优化、AI 全文整理、AI 配置面板、AI 结果展示区、单句 AI 重写。
- 删除：主进程 `ai-request` handler、预加载 `aiRequest`、所有 `fetch` 调用、AI 风格系统提示词、AI 分组区间规整逻辑。
- 保留：SRT 解析/编辑/导出、时间轴偏移/缩放/两点锚点同步、错乱修复、媒体同步、配音时长估算（均为纯本地计算，非 AI）。

---

## 演示视频 / Demo

观看可视化演示：导入示例字幕 → 配音时长估算与超时标红 → 整体偏移 → 比例缩放 → 仅显示超时片段 → 导出 SRT。

- 视频与字幕：`demo/srt-timeline-aligner_demo.mp4`、`.srt`
- 生成方式与可复现步骤：见 [demo/README.md](./demo/README.md)

---

## 许可证 / License

[MIT](./LICENSE)
