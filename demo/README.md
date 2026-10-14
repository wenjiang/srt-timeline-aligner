# 演示视频 / Demo Video

本目录包含 `srt-timeline-aligner` 的可视化演示视频，由本地 [repo-to-video](https://github.com/loveturtlelin/repo-to-video)（仓库 → 演示视频生成器）自动生成。

## 文件 / Files

- `srt-timeline-aligner_demo.mp4`：演示视频（约 77 秒，1280×800，含中文旁白与烧录字幕）
- `srt-timeline-aligner_demo.srt`：视频字幕（与 mp4 同名，可在播放器外挂）

## 视频内容 / What it shows

依次演示：导入示例字幕 → 实时配音时长估算与超时标红 → 整体偏移（`+2.5s`）→ 比例缩放（`1.0382`）→ 仅显示超时片段筛选 → 导出 SRT。

## 如何复现 / How to regenerate

演示由本地 `repo-to-video` 工程生成，要点如下：

1. **edge-tts 端点修复**：`repo-to-video` 自带的 edge-tts 需 patch 到新端点（微软 2026-10 将合成端点从 `speech.platform.bing.com` 迁到 `api.msedgeservices.com`）：
   - 把 `constants.py` 的 `WSS_URL` 改为
     `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4`
   - 把 `drm.py` 的日期解析改为 locale 无关（用 `email.utils.parsedate_to_datetime`）。
2. **录制用副本工程**：录制使用一个**副本**工程（向 `index.html` 注入 `demo-bootstrap.js`，页面加载后自动 `fetch sample.srt` 并注入表格，使演示中表格始终有数据）。**纯开源工程本身不含该脚本**，默认行为是空表格等待用户导入。
3. **运行命令**（示例，路径按本机调整）：
   ```bash
   cd D:\electron_test\repo-to-video
   # 先清空媒体目录，避免上一轮的旧片段混入
   rm -rf raw_videos raw_audio standardized_videos standardized_audio concatenated_video.mp4 concatenated_audio.aac
   .venv\Scripts\python.exe repo2video.py "D:\WorkBuddyWorkspaces\字幕\srt-timeline-aligner-demo" ^
     --output output\srt-timeline-aligner_demo.mp4 ^
     --resolution 1280x800 --lang zh ^
     --title "字幕时间轴对齐工具 演示" ^
     --actions actions_srt_aligner_demo.json
   ```
4. `actions_srt_aligner_demo.json` 定义演示动作序列（偏移 / 缩放 / 筛选 / 导出），对应 `repo-to-video` 的 manifest schema。

> 说明：演示视频为二进制文件，直接纳入了 git 仓库。若希望保持仓库历史更干净，可改为以 GitHub Release 附件形式发布，此处仅保留链接。
