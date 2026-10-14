/* =====================================================================
 * srt-timeline-aligner — renderer.js
 * 字幕时间轴对齐工具（纯本地、无 AI、无联网）。
 *
 * 功能：
 *  - 导入 / 编辑 / 导出 SRT（支持浏览器 <input type=file> 与 Electron 系统对话框两种模式）
 *  - 时间轴对齐：整体偏移、比例缩放、两点锚点同步、一键修复错乱
 *  - 媒体同步：拖入音视频后对比字幕与播放头，逐行高亮
 *  - 配音时长估算：按语速估算 TTS 是否会超出时间轴
 *  - 撤销 / 重做、查找替换、区间导出
 * ===================================================================== */

const state = {
  segments: [],
  rate: 4.5,
  tol: 0.05,
  rescale: false,
  onlyBad: false,
  fileName: '',
  focusIndex: -1, // 当前选中的行（用于时间轴批量操作的范围）
  tlAlertSig: '', // 时间轴问题的“指纹”，变了就重新弹横幅
  tlAlertDismissed: false,
};

/* ----------------------- 历史记录栈 (Undo/Redo) ----------------------- */
let historyStack = [];
let historyIndex = -1;

function saveState() {
  if (historyIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyIndex + 1);
  }
  historyStack.push(JSON.parse(JSON.stringify(state.segments)));
  if (historyStack.length > 50) {
    historyStack.shift();
  } else {
    historyIndex++;
  }
  updateUndoRedoUI();
}

function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    state.segments = JSON.parse(JSON.stringify(historyStack[historyIndex]));
    render();
    updateUndoRedoUI();
  }
}

function redo() {
  if (historyIndex < historyStack.length - 1) {
    historyIndex++;
    state.segments = JSON.parse(JSON.stringify(historyStack[historyIndex]));
    render();
    updateUndoRedoUI();
  }
}

function updateUndoRedoUI() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) undoBtn.disabled = historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = historyIndex >= historyStack.length - 1;
}

document.addEventListener('keydown', (e) => {
  // 避免在输入框中触发快捷键影响原生撤销
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') {
      if (e.shiftKey) redo();
      else undo();
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'y') {
      redo();
      e.preventDefault();
    }
  }
});

/* ----------------------- SRT parse/serialize ----------------------- */

function parseTimeToMs(t) {
  const m = t.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2], s = +m[3];
  let ms = +m[4];
  if (m[4].length === 1) ms *= 100;
  else if (m[4].length === 2) ms *= 10;
  return (h * 3600 + mi * 60 + s) * 1000 + ms;
}

function parseSRT(content) {
  const blocks = content.replace(/\r/g, '').split(/\n\s*\n/).filter((b) => b.trim());
  const segs = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { idx = i; break; }
    }
    if (idx === -1) continue;
    const tm = lines[idx].split('-->');
    const startMs = parseTimeToMs(tm[0]);
    const endMs = parseTimeToMs(tm[1]);
    if (startMs == null || endMs == null) continue;
    const text = lines.slice(idx + 1).join('\n');
    const index = /^\d+$/.test(lines[0].trim()) ? +lines[0].trim() : segs.length + 1;
    segs.push({ index, startMs, endMs, text });
  }
  return segs;
}

function serializeSRT(segs) {
  return segs
    .map((s, i) => {
      const index = s.index != null ? s.index : i + 1;
      return `${index}\n${fmt(s.startMs)} --> ${fmt(s.endMs)}\n${s.text}`;
    })
    .join('\n\n') + '\n';
}

/* 浏览器 / file:// 降级：本地文件选择 + 下载 */
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name, content: reader.result });
      reader.onerror = () => resolve(null);
      reader.readAsText(f, 'utf-8');
    });
    document.body.appendChild(input);
    input.click();
  });
}

function downloadText(filename, text, mime = 'text/plain') {
  // 添加 UTF-8 BOM 以增强 Windows 兼容性
  const blob = new Blob(['﻿', text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ----------------------- helpers ----------------------- */

function countChars(text) {
  let c = 0;
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) c += 1;          // CJK 汉字
    else if (/[a-zA-Z0-9]/.test(ch)) c += 1; // 字母/数字
    // 标点、空格不计入
  }
  return c;
}

function fmt(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const mi = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const m = t % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(mi)}:${p(s)},${p(m, 3)}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function analyze(seg) {
  const dur = seg.endMs - seg.startMs;
  const chars = countChars(seg.text);
  const est = state.rate > 0 ? (chars / state.rate) * 1000 : 0;
  const over = est - dur;
  const overflow = over > dur * state.tol;
  return { dur, chars, est, over, overflow };
}

/* ----------------------- 灵活时间输入解析 ----------------------- */
/**
 * 支持：
 *   00:01:23,456 / 1:23.4 / 0:49,82      → 绝对时间
 *   83.5                                 → 绝对秒数
 *   +1.5 / -0.3 / +1500ms / -300ms       → 相对偏移
 * 返回 { abs } 或 { delta }，无法识别返回 null
 */
function parseFlexibleTime(str) {
  const s = (str || '').trim();
  if (!s) return null;

  let m = s.match(/^([+-])\s*(\d+(?:\.\d+)?)\s*ms$/i);
  if (m) return { delta: (m[1] === '-' ? -1 : 1) * parseFloat(m[2]) };

  m = s.match(/^([+-])\s*(\d+(?:\.\d+)?)\s*s?$/i);
  if (m) return { delta: (m[1] === '-' ? -1 : 1) * parseFloat(m[2]) * 1000 };

  const parts = s.replace(/,/g, '.').split(':');
  if (parts.length >= 2 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    const nums = parts.map(Number);
    if (nums.length === 3) return { abs: Math.round((nums[0] * 3600 + nums[1] * 60 + nums[2]) * 1000) };
    if (nums.length === 2) return { abs: Math.round((nums[0] * 60 + nums[1]) * 1000) };
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(s)) return { abs: Math.round(parseFloat(s) * 1000) };
  return null;
}

/* ----------------------- rendering ----------------------- */

function visibleSegments() {
  if (!state.onlyBad) return state.segments.map((s, i) => ({ s, i }));
  return state.segments
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => analyze(s).overflow);
}

function render() {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  const rows = visibleSegments();
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:#6b7785;padding:20px;text-align:center">无可显示片段</td></tr>';
  }
  for (const { s, i } of rows) {
    const a = analyze(s);
    const tr = document.createElement('tr');
    tr.className = (a.overflow ? 'bad' : 'ok') + (i === state.focusIndex ? ' sel-row' : '');
    tr.dataset.i = i;
    const tTip = '可直接编辑：00:01:23,456 / 1:23.4 / 83.5 / +1.5 / -300ms';
    tr.innerHTML = `
      <td class="c-idx"><span class="idx-warn"></span>${i + 1}</td>
      <td>
        ${i < state.segments.length - 1 ? `<button class="btn-mini merge-btn" data-i="${i}" title="与下一条合并">🔗</button>` : ''}
        ${s.originalParts && s.originalParts.length > 0 ? `<button class="btn-mini split-btn" data-i="${i}" title="撤销合并（拆分回原样）">✂️</button>` : ''}
        <button class="btn-mini set-time-btn" data-i="${i}" title="把视频当前时间设为该段开始（按住 Alt 设为结束）">⏱</button>
        <button class="btn-mini play-tts-btn" data-i="${i}" title="浏览器语音试听当前语速">▶️</button>
      </td>
      <td class="time"><input class="t-in" data-i="${i}" data-f="startMs" value="${fmt(s.startMs)}" title="${tTip}" /></td>
      <td class="time"><input class="t-in" data-i="${i}" data-f="endMs" value="${fmt(s.endMs)}" title="${tTip}" /></td>
      <td class="num c-dur">${(a.dur / 1000).toFixed(2)}s</td>
      <td class="num c-chars">${a.chars}</td>
      <td class="num c-est">${(a.est / 1000).toFixed(2)}s</td>
      <td class="status c-status">${a.overflow ? '⚠ 超出 +' + (a.over / 1000).toFixed(2) + 's' : '✓ 适中'}</td>
      <td class="edit"><textarea rows="2" data-i="${i}">${escapeHtml(s.text)}</textarea></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('textarea').forEach((ta) => {
    ta.addEventListener('input', (e) => {
      const i = +e.target.dataset.i;
      state.segments[i].text = e.target.value;
      updateRow(i);
      updateSummary();
    });
    ta.addEventListener('change', () => {
      saveState(); // 失去焦点或内容确认改变时保存历史
    });
  });
  // 行点击 → 选中为“当前段”（用于批量时间轴操作的范围）
  tbody.querySelectorAll('tr[data-i]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('input, textarea, button')) return;
      setFocus(+tr.dataset.i);
    });
  });
  // 时间输入框
  tbody.querySelectorAll('.t-in').forEach((inp) => {
    inp.addEventListener('focus', () => { lastTimeInput = inp; });
    inp.addEventListener('change', () => applyTimeInput(inp));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = fmt(state.segments[+inp.dataset.i][inp.dataset.f]); inp.blur(); }
    });
  });
  tbody.querySelectorAll('.set-time-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.dataset.i);
      setTimeFromPlayer(i, e.altKey ? 'endMs' : 'startMs');
    });
  });
  tbody.querySelectorAll('.merge-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.i);
      mergeSegments(i);
    });
  });
  tbody.querySelectorAll('.split-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.i);
      splitSegment(i);
    });
  });
  tbody.querySelectorAll('.play-tts-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const i = parseInt(e.currentTarget.dataset.i);
      playTTS(i);
    });
  });
  updateSummary();
  updateTimelineHealth();
}

/** 浏览器内置语音试听（本地，非 AI） */
function playTTS(i) {
  const s = state.segments[i];
  if (!window.speechSynthesis) {
    alert('当前浏览器不支持语音合成（speechSynthesis）。');
    return;
  }
  window.speechSynthesis.cancel(); // 停止当前正在播放的语音

  const utterance = new SpeechSynthesisUtterance(s.text);
  utterance.lang = 'zh-CN';

  // 计算所需的语速倍率（让试听时长接近该段字幕时长）
  const durSec = (s.endMs - s.startMs) / 1000;
  if (durSec > 0) {
    const chars = countChars(s.text);
    const requiredCharsPerSec = chars / durSec;
    const normalCharsPerSec = state.rate || 4.5;

    // TTS API 的 base rate 是 1.0
    let speechRate = requiredCharsPerSec / normalCharsPerSec;
    // 限制倍率在 0.5 到 3 之间，避免 API 报错
    speechRate = Math.max(0.5, Math.min(speechRate, 3));

    utterance.rate = speechRate;
  }

  window.speechSynthesis.speak(utterance);
}

function mergeSegments(i) {
  if (i >= state.segments.length - 1) return;
  const s1 = state.segments[i];
  const s2 = state.segments[i + 1];

  // 记录原始片段，以便后续可以恢复
  const originalParts = [
    ...(s1.originalParts || [JSON.parse(JSON.stringify(s1))]),
    ...(s2.originalParts || [JSON.parse(JSON.stringify(s2))])
  ];

  // 合并文本，如果第一段结尾没有标点且第二段开头不是标点，加个空格
  const t1 = s1.text.trim();
  const t2 = s2.text.trim();
  const connector = /[，。！？；、,.!?;]$/.test(t1) ? "" : " ";
  const newText = t1 + connector + t2;

  // 时间轴合并：取两段的并集（min 开始 / max 结束），
  // 而不是直接沿用第二段的结束——否则某段时间异常时合并结果会错乱
  let startMs = Math.min(s1.startMs, s2.startMs);
  let endMs = Math.max(s1.endMs, s2.endMs);

  state.segments.splice(i, 2, {
    ...s1,
    startMs, endMs,
    text: newText,
    originalParts: originalParts
  });

  // 边界校正：合并结果不允许侵入前后邻段（否则会盖住邻段的显示）
  const notes = [];
  const prev = state.segments[i - 1];
  if (prev && startMs < prev.endMs - 1 && prev.endMs < endMs) {
    startMs = prev.endMs;
    notes.push(`开始已顺延到上一段结束 ${fmt(prev.endMs)}`);
  }
  const next = state.segments[i + 1];
  if (next && endMs > next.startMs + 1 && next.startMs > startMs) {
    endMs = next.startMs;
    notes.push(`结束已收拢到下一段开始 ${fmt(next.startMs)}`);
  }
  if (startMs !== state.segments[i].startMs || endMs !== state.segments[i].endMs) {
    state.segments[i].startMs = startMs;
    state.segments[i].endMs = endMs;
  }

  saveState();
  render();
  setTlStatus(
    `已合并第 ${i + 1}、${i + 2} 段 → ${fmt(state.segments[i].startMs)} ~ ${fmt(state.segments[i].endMs)}` +
    (notes.length ? `；${notes.join('；')}` : '')
  );
}

function splitSegment(i) {
  const s = state.segments[i];
  if (!s.originalParts || s.originalParts.length === 0) return;

  // 恢复出原始的所有片段
  const restoredSegments = s.originalParts.map(part => {
    // 移除深层的 originalParts 防止嵌套过深
    const { originalParts, ...cleanPart } = part;
    return cleanPart;
  });

  state.segments.splice(i, 1, ...restoredSegments);
  saveState();
  render();
}

function updateRow(i) {
  const tr = document.querySelector(`#rows tr[data-i="${i}"]`);
  if (!tr) return; // 过滤模式下该行可能未渲染
  const a = analyze(state.segments[i]);
  tr.className = (a.overflow ? 'bad' : 'ok') + (i === state.focusIndex ? ' sel-row' : '');
  tr.querySelector('.c-dur').textContent = (a.dur / 1000).toFixed(2) + 's';
  tr.querySelector('.c-chars').textContent = a.chars;
  tr.querySelector('.c-est').textContent = (a.est / 1000).toFixed(2) + 's';
  tr.querySelector('.c-status').textContent = a.overflow
    ? '⚠ 超出 +' + (a.over / 1000).toFixed(2) + 's'
    : '✓ 适中';
  // 同步时间输入框（正在编辑的那个不覆盖）
  const sin = tr.querySelector('.t-in[data-f="startMs"]');
  const ein = tr.querySelector('.t-in[data-f="endMs"]');
  if (sin && document.activeElement !== sin) sin.value = fmt(state.segments[i].startMs);
  if (ein && document.activeElement !== ein) ein.value = fmt(state.segments[i].endMs);
  applyRowFlags(); // 该行时间变了，错乱标记（含前后行）要重算
}

function updateSummary() {
  const total = state.segments.length;
  let bad = 0, sumDur = 0, sumEst = 0;
  state.segments.forEach((s) => {
    const a = analyze(s);
    if (a.overflow) bad++;
    sumDur += a.dur;
    sumEst += a.est;
  });
  const diff = sumEst - sumDur;
  const tail =
    diff > 0
      ? ` <span class="warn">(配音比字幕长 ${(diff / 1000).toFixed(1)}s)</span>`
      : ` <span class="oktext">(余量 ${((-diff) / 1000).toFixed(1)}s)</span>`;
  document.getElementById('summary').innerHTML =
    `共 <b>${total}</b> 段 ｜ 超时 <b class="warn">${bad}</b> 段 ｜ ` +
    `字幕总时长 <b>${(sumDur / 1000).toFixed(1)}s</b> ｜ ` +
    `估算配音总时长 <b>${(sumEst / 1000).toFixed(1)}s</b>${tail}`;
}

/* ----------------------- 时间轴编辑 ----------------------- */

let lastTimeInput = null; // 最近聚焦过的时间输入框（供“取当前播放时间”写入）

document.addEventListener('focusin', (e) => {
  const cl = e.target && e.target.classList;
  if (cl && (cl.contains('t-in') || cl.contains('t-anchor'))) lastTimeInput = e.target;
});

function setTlStatus(msg) {
  const el = document.getElementById('tlStatus');
  if (el) el.innerHTML = msg;
}

function setFocus(i) {
  state.focusIndex = i;
  document.querySelectorAll('#rows tr').forEach((tr) => {
    tr.classList.toggle('sel-row', +tr.dataset.i === i);
  });
  const el = document.getElementById('tlFocus');
  if (el) {
    el.textContent = i >= 0 ? `第 ${i + 1} 段（${fmt(state.segments[i].startMs)} → ${fmt(state.segments[i].endMs)}）` : '点击表格任意一行选中';
  }
}

/** 单行时间输入应用（change 事件） */
function applyTimeInput(inp) {
  const i = +inp.dataset.i;
  const f = inp.dataset.f;
  const seg = state.segments[i];
  if (!seg) return;
  const r = parseFlexibleTime(inp.value);
  if (!r) {
    inp.value = fmt(seg[f]);
    setTlStatus(`<span class="warn">无法识别的时间「${inp.value}」，已还原</span>`);
    return;
  }
  let v = r.abs != null ? r.abs : seg[f] + r.delta;
  v = Math.max(0, Math.round(v));
  saveState();
  if (f === 'startMs') {
    seg.startMs = v >= seg.endMs ? Math.max(0, seg.endMs - 200) : v;
  } else {
    seg.endMs = v <= seg.startMs ? seg.startMs + 200 : v;
  }
  inp.value = fmt(seg[f]);
  updateRow(i);
  updateSummary();
  updateFocusLabel();
  updateOverlapHint();
  setTlStatus(`第 ${i + 1} 段 ${f === 'startMs' ? '开始' : '结束'} → ${fmt(seg[f])}`);
}

function updateFocusLabel() {
  if (state.focusIndex >= 0) setFocus(state.focusIndex);
}

/** 把视频当前播放时间写入某段的开始/结束 */
function setTimeFromPlayer(i, field) {
  if (!mediaPlayer || !mediaPlayer.src || !isFinite(mediaPlayer.currentTime) || mediaPlayer.currentTime === 0) {
    alert('请先拖入视频/音频文件并播放到目标位置，再点此按钮。');
    return;
  }
  const t = Math.round(mediaPlayer.currentTime * 1000);
  saveState();
  const seg = state.segments[i];
  if (field === 'startMs') {
    seg.startMs = t;
    if (seg.endMs <= t) seg.endMs = t + 1000;
  } else {
    seg.endMs = t;
    if (seg.startMs >= t) seg.startMs = Math.max(0, t - 1000);
  }
  render();
  updateOverlapHint();
  setTlStatus(`第 ${i + 1} 段 ${field === 'startMs' ? '开始' : '结束'} ← 播放头 ${fmt(t)}`);
}

/** 根据“作用范围”返回要处理的下标 */
function scopeIndices() {
  const scopeEl = document.getElementById('tlScope');
  const scope = scopeEl ? scopeEl.value : 'all';
  const f = state.focusIndex;
  if (scope === 'all') return state.segments.map((_, i) => i);
  if (f < 0 || f >= state.segments.length) return [];
  if (scope === 'only') return [f];
  return state.segments.map((_, i) => i).slice(f); // from
}

function requireScope() {
  const idx = scopeIndices();
  if (idx.length) return idx;
  alert('请先在表格中点击一行以指定“当前段”，或把作用范围改为“全部字幕”。');
  return null;
}

/** 整体平移 */
function applyShift(deltaMs) {
  const idx = requireScope();
  if (!idx) return;
  saveState();
  idx.forEach((i) => {
    const s = state.segments[i];
    s.startMs = Math.max(0, Math.round(s.startMs + deltaMs));
    s.endMs = Math.max(0, Math.round(s.endMs + deltaMs));
  });
  render();
  updateOverlapHint();
  setTlStatus(`已偏移 ${deltaMs > 0 ? '+' : ''}${(deltaMs / 1000).toFixed(3)}s，共 ${idx.length} 段`);
}

/** 比例缩放（以范围内首段的开始为锚点，避免整体跳走） */
function applyScale(k) {
  if (!k || isNaN(k) || Math.abs(k - 1) < 1e-9) {
    setTlStatus('<span class="warn">缩放系数无效或为 1</span>');
    return;
  }
  const idx = requireScope();
  if (!idx) return;
  saveState();
  const anchor = state.segments[idx[0]].startMs;
  idx.forEach((i) => {
    const s = state.segments[i];
    s.startMs = Math.max(0, Math.round(anchor + (s.startMs - anchor) * k));
    s.endMs = Math.max(0, Math.round(anchor + (s.endMs - anchor) * k));
    if (s.endMs <= s.startMs) s.endMs = s.startMs + 200;
  });
  render();
  updateOverlapHint();
  setTlStatus(`已按比例 ${k} 缩放，共 ${idx.length} 段（锚点 ${fmt(anchor)}）`);
}

/** 两点锚点同步：已知 原A→新A、原B→新B，线性映射其余所有时间点 */
function applyAnchor() {
  const get = (id) => parseFlexibleTime(document.getElementById(id).value);
  const a1 = get('tlA1'), a2 = get('tlA2'), b1 = get('tlB1'), b2 = get('tlB2');
  if (!a1 || !a2 || !b1 || !b2) {
    alert('四个锚点时间都要填（支持 00:01:23,456 或 83.5 这类写法）。');
    return;
  }
  const A1 = a1.abs, A2 = a2.abs, B1 = b1.abs, B2 = b2.abs;
  if (A1 == null || A2 == null || B1 == null || B2 == null) {
    alert('锚点请用绝对时间，不要写 +1.5 这种相对值。');
    return;
  }
  if (B1 === A1) {
    alert('两个“原时间”不能相同，无法计算比例。');
    return;
  }
  const k = (B2 - A2) / (B1 - A1);
  const idx = requireScope();
  if (!idx) return;
  saveState();
  idx.forEach((i) => {
    const s = state.segments[i];
    s.startMs = Math.max(0, Math.round(A2 + (s.startMs - A1) * k));
    s.endMs = Math.max(0, Math.round(A2 + (s.endMs - A1) * k));
    if (s.endMs <= s.startMs) s.endMs = s.startMs + 200;
  });
  render();
  updateOverlapHint();
  setTlStatus(`两点同步完成：比例 ×${k.toFixed(6)}，偏移 ${((A2 - A1 * k) / 1000).toFixed(3)}s，共 ${idx.length} 段`);
}

/* ----------------------- 时间轴完整性校验 ----------------------- */

/** 相邻片段间隔超过这个值只给“提醒”（长静音/音乐是正常的），不算错乱 */
const TL_GAP_WARN_MS = 10000;

/**
 * 逐段检查时间轴，返回问题列表。
 * level: 'error' 必须修（播放器会跳字/叠字）｜ 'warn' 需人工确认（多半是长静音）
 * type : 'order' 起始倒退 ｜ 'overlap' 与上一段重叠 ｜ 'dur' 时长非法 ｜ 'gap' 超长间隙
 */
function timelineIssues(segs) {
  const list = segs || state.segments;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!(s.endMs > s.startMs)) {
      out.push({
        i, level: 'error', type: 'dur',
        msg: `时长非法：结束 ${fmt(s.endMs)} 不晚于开始 ${fmt(s.startMs)}`,
      });
    }
    if (i === 0) continue;
    const p = list[i - 1];
    const d = s.startMs - p.startMs;
    if (d < 0) {
      out.push({
        i, level: 'error', type: 'order',
        msg: `起始时间倒退：第 ${i + 1} 段 ${fmt(s.startMs)} 比第 ${i} 段 ${fmt(p.startMs)} 还早 ${((-d) / 1000).toFixed(3)}s`,
      });
    } else if (s.startMs < p.endMs - 1) {
      out.push({
        i, level: 'error', type: 'overlap',
        msg: `与上一段重叠：第 ${i} 段到 ${fmt(p.endMs)} 才结束，第 ${i + 1} 段 ${fmt(s.startMs)} 就开始了（重叠 ${((p.endMs - s.startMs) / 1000).toFixed(3)}s）`,
      });
    } else if (s.startMs - p.endMs > TL_GAP_WARN_MS) {
      out.push({
        i, level: 'warn', type: 'gap',
        msg: `与上一片段间隔 ${((s.startMs - p.endMs) / 1000).toFixed(2)}s（上一段结束 ${fmt(p.endMs)} → 本段开始 ${fmt(s.startMs)}；可能是音乐/静音，也可能漏了字幕）`,
      });
    }
  }
  return out;
}

/** index -> { level, msgs[] }，供表格行打标用 */
function timelineIssueMap() {
  const m = new Map();
  for (const it of timelineIssues()) {
    const cur = m.get(it.i);
    if (!cur) m.set(it.i, { level: it.level, msgs: [it.msg] });
    else {
      if (it.level === 'error') cur.level = 'error';
      cur.msgs.push(it.msg);
    }
  }
  return m;
}

/** 给已渲染的行加上错乱标记（render / updateRow 之后调用） */
function applyRowFlags() {
  const issMap = timelineIssueMap();
  const rows = document.querySelectorAll('#rows tr[data-i]');
  rows.forEach((tr) => {
    const i = +tr.dataset.i;
    const it = issMap.get(i);
    tr.classList.remove('tl-err', 'tl-warn');
    const w = tr.querySelector('.idx-warn');
    if (it) {
      tr.classList.add(it.level === 'error' ? 'tl-err' : 'tl-warn');
      if (w) {
        w.innerHTML = it.level === 'error' ? '⚠' : 'ⓘ';
        w.title = it.msgs.join('\n');
      }
      tr.title = '时间轴问题：\n' + it.msgs.join('\n');
    } else {
      if (w) { w.innerHTML = ''; w.title = ''; }
      tr.removeAttribute('title');
    }
  });
}

/** 顶部横幅 + 状态栏 + 行标记，一次刷新 */
function updateTimelineHealth() {
  applyRowFlags();

  const issues = timelineIssues();
  const errs = issues.filter((x) => x.level === 'error');
  const warns = issues.filter((x) => x.level === 'warn');
  const nOf = (t) => issues.filter((x) => x.type === t).length;

  const el = document.getElementById('tlOverlap');
  if (el) {
    if (!issues.length) {
      el.innerHTML = '<span class="oktext">✓ 时间轴顺序正常</span>';
    } else {
      const bits = [];
      if (nOf('order')) bits.push(`起始倒退 ${nOf('order')}`);
      if (nOf('overlap')) bits.push(`相邻重叠 ${nOf('overlap')}`);
      if (nOf('dur')) bits.push(`时长非法 ${nOf('dur')}`);
      if (nOf('gap')) bits.push(`长间隙 ${nOf('gap')}`);
      el.innerHTML = errs.length
        ? `<span class="tl-err-text">⚠ ${errs.length} 处错乱（${bits.join('、')}）</span>`
        : `<span class="tl-warn-text">ⓘ ${warns.length} 处待确认（${bits.join('、')}）</span>`;
    }
  }

  const banner = document.getElementById('tlAlert');
  if (banner) {
    const sig = `${errs.length}|${warns.length}|${errs[0] ? errs[0].i : warns[0] ? warns[0].i : -1}`;
    if (state.tlAlertSig !== sig) state.tlAlertDismissed = false;
    state.tlAlertSig = sig;

    if (!issues.length || state.tlAlertDismissed) {
      banner.style.display = 'none';
      banner.innerHTML = '';
      return;
    }
    const isErr = errs.length > 0;
    const picked = isErr ? errs : warns;
    const head = isErr
      ? `⚠ 时间轴错乱 ${errs.length} 处 —— 导出后播放器会跳字/叠字`
      : `ⓘ 时间轴有 ${warns.length} 处超长间隙，确认是否漏了字幕`;
    const li = picked.slice(0, 3)
      .map((x) => `<li><a href="javascript:void 0" onclick="gotoIssue(${x.i})">第 ${x.i + 1} 段</a> ${escapeHtml(x.msg)}</li>`)
      .join('');
    const more = picked.length > 3 ? `<li class="muted">…等共 ${picked.length} 处</li>` : '';
    banner.className = 'tl-alert ' + (isErr ? 'is-error' : 'is-warn');
    banner.innerHTML =
      `<div class="tl-alert-body"><b>${head}</b><ul>${li}${more}</ul></div>` +
      `<div class="tl-alert-act">` +
      `<button class="btn ${isErr ? 'danger' : 'secondary'}" onclick="gotoIssue(${picked[0].i})">定位第一处</button>` +
      (isErr ? `<button class="btn" onclick="fixTimelineOrder('trim')" title="重叠处收窄上一段结束时间，本段位置不动，时间轴总长不变">🔧 一键修复</button>` : '') +
      (isErr ? `<button class="btn secondary" onclick="fixTimelineOrder('shift')" title="保持每段时长、依次顺推，时间轴会整体向后延长">⇥ 保时长顺推</button>` : '') +
      `<button class="btn-mini" title="本次不再提示（问题变化后会重新出现）" onclick="dismissTlAlert()">✕</button>` +
      `</div>`;
    banner.style.display = 'flex';
  }
}

function dismissTlAlert() {
  state.tlAlertDismissed = true;
  const b = document.getElementById('tlAlert');
  if (b) { b.style.display = 'none'; b.innerHTML = ''; }
}

/** 跳到某一段：若被“仅显示超时”过滤掉，先关掉过滤 */
function gotoIssue(i) {
  if (i == null || i < 0) return;
  let tr = document.querySelector(`#rows tr[data-i="${i}"]`);
  if (!tr && state.onlyBad) {
    state.onlyBad = false;
    const cb = document.getElementById('onlyBad');
    if (cb) cb.checked = false;
    render();
    tr = document.querySelector(`#rows tr[data-i="${i}"]`);
  }
  if (!tr) return;
  setFocus(i);
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  tr.classList.remove('flash-row');
  void tr.offsetWidth; // 强制重排，让动画能重放
  tr.classList.add('flash-row');
  setTimeout(() => tr.classList.remove('flash-row'), 1400);
}

/**
 * 一键修复时间轴错乱。
 * mode = 'trim'（默认）｜ 'shift'
 *  - trim ：重叠处把「上一段」的结束时间收窄到本段开始，本段位置不动
 *           → 不改动任何开始时间，时间轴总长不变（推荐，字幕与配音的绝对时间保持对齐）。
 *           只有「起始倒退」这种靠收窄解决不了（收窄会让上一段时长为负）的，才把该段顺推。
 *  - shift：保持每段原时长，把出问题的段依次顺推到上一段结束之后
 *           → 时间轴会整体向后延长（30 处错乱会层层累积）。
 */
function fixTimelineOrder(mode) {
  const segs = state.segments;
  if (!segs.length) return;
  const errs = timelineIssues().filter((x) => x.level === 'error');
  if (!errs.length) {
    setTlStatus('<span class="oktext">时间轴无错乱，无需修复</span>');
    return;
  }
  const nOverlap = errs.filter((x) => x.type === 'overlap').length;
  const nOrder = errs.filter((x) => x.type === 'order').length;
  const nDur = errs.filter((x) => x.type === 'dur').length;
  const bits = [];
  if (nOverlap) bits.push(`相邻重叠 ${nOverlap}`);
  if (nOrder) bits.push(`起始倒退 ${nOrder}`);
  if (nDur) bits.push(`时长非法 ${nDur}`);

  const useTrim = mode !== 'shift';
  const rule = useTrim
    ? '修复方式【收窄重叠】：重叠处让「上一段」提前结束到本段开始，本段位置不动，时间轴总长不变；仅「起始倒退」等无法收窄的才顺推该段。'
    : '修复方式【保时长顺推】：保持每段原时长，把出问题的段依次顺推到上一段结束之后，时间轴会整体向后延长。';

  const go = confirm(
    `检测到 ${errs.length} 处时间轴错乱（${bits.join('、')}）。\n\n${rule}\n\n` +
    `可用 Ctrl+Z 撤销。是否继续？`
  );
  if (!go) return;
  saveState();
  const MIN_DUR = 200;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!(s.endMs > s.startMs)) s.endMs = s.startMs + MIN_DUR; // 时长非法先补正
    if (i === 0) continue;
    const p = segs[i - 1];
    if (s.startMs >= p.endMs - 1) continue; // 与检测口径一致：不算重叠就不动
    if (useTrim && s.startMs > p.startMs) {
      // 纯重叠：收窄上一段结束时间，本段开始时间保持不动 → 总时长不变
      p.endMs = s.startMs;
    } else {
      // 起始倒退（或顺推模式）：本段整体后移到上一段结束之后，保持原时长
      const dur = s.endMs - s.startMs;
      s.startMs = p.endMs;
      s.endMs = p.endMs + dur;
    }
  }
  render();
  setTlStatus(`已修复 ${errs.length} 处错乱（${useTrim ? '收窄重叠' : '保时长顺推'}，Ctrl+Z 可撤销）`);
}

/** 兼容旧调用名 */
function updateOverlapHint() {
  updateTimelineHealth();
}

/** 导出前把关：有错乱就拦一次，让用户选择“仍然导出”还是“去修” */
function confirmTimelineBeforeExport(segs) {
  const errs = timelineIssues(segs).filter((x) => x.level === 'error');
  if (!errs.length) return true;
  const list = errs.slice(0, 3).map((x) => `• 第 ${x.i + 1} 段：${x.msg}`).join('\n');
  const more = errs.length > 3 ? `\n… 等共 ${errs.length} 处` : '';
  const go = confirm(
    `⚠ 时间轴有 ${errs.length} 处错乱，导出后播放器会出现跳字/叠字。\n\n${list}${more}\n\n` +
    `【确定】仍然按原样导出\n【取消】先去修复（会跳到第一处）`
  );
  if (!go) {
    gotoIssue(errs[0].i);
    return false;
  }
  return true;
}

/* ----------------------- 重排时间轴（按比例拉伸语速） ----------------------- */

function rescaleSegments(segs) {
  const out = segs.map((s) => ({ ...s }));
  let cur = out.length ? out[0].startMs : 0;
  for (let i = 0; i < out.length; i++) {
    const a = analyze(out[i]);
    const need = Math.max(a.est, 300); // 单段最少 300ms
    out[i].startMs = Math.round(cur);
    out[i].endMs = Math.round(cur + need);
    const gap = i < out.length - 1 ? Math.max(0, segs[i + 1].startMs - segs[i].endMs) : 0;
    cur = out[i].endMs + gap; // 保留原片段之间的停顿
  }
  return out;
}

/* ----------------------- 载入与导出 ----------------------- */

function applyLoaded(segments, path) {
  state.segments = segments;
  state.fileName = path;
  state.focusIndex = -1;
  document.getElementById('file').textContent = path;
  historyStack = [];
  historyIndex = -1;
  saveState();
  render();
  setFocus(-1);
  updateOverlapHint();
  setTlStatus('已载入 ' + segments.length + ' 段');
}

document.getElementById('open').addEventListener('click', async () => {
  // Electron 模式：优先走 IPC（可调用系统文件对话框、读取任意路径）
  if (window.api && window.api.openFile) {
    const r = await window.api.openFile();
    if (!r) return;
    applyLoaded(r.segments, r.path);
    return;
  }
  // 浏览器 / file:// 降级：用 <input type=file> + FileReader 本地解析
  const picked = await pickFile('.srt,.vtt');
  if (!picked) return;
  const segments = parseSRT(picked.content);
  if (!segments.length) {
    alert('未能解析该文件，请确认是 SRT / VTT 格式。');
    return;
  }
  applyLoaded(segments, picked.name);
});

/* 把一批字幕导出为 SRT（renumber=true 时把序号重新编为 1..N，适合区间导出） */
async function exportSegs(segs, baseName, renumber) {
  if (!segs.length) {
    alert('没有可导出的字幕。');
    return;
  }
  let payload = segs.map((s) => ({ index: s.index, startMs: s.startMs, endMs: s.endMs, text: s.text }));
  if (renumber) payload = payload.map((s, i) => ({ ...s, index: i + 1 }));
  if (window.api && window.api.saveFile) {
    const p = await window.api.saveFile(payload);
    if (p) alert('已保存：\n' + p);
  } else {
    downloadText(baseName + '.srt', serializeSRT(payload), 'application/x-subrip');
  }
}

document.getElementById('save').addEventListener('click', async () => {
  if (state.segments.length === 0) {
    alert('请先导入字幕文件。');
    return;
  }
  let segs = state.segments;
  if (state.rescale) segs = rescaleSegments(state.segments);
  if (!confirmTimelineBeforeExport(segs)) return; // 有时间轴错乱先拦一道
  await exportSegs(segs, 'optimized', false);
});

/* 导出指定序号区间（含两端）的字幕，序号即表格左侧行号，从 1 开始 */
document.getElementById('saveRange').addEventListener('click', async () => {
  if (state.segments.length === 0) {
    alert('请先导入字幕文件。');
    return;
  }
  const n = state.segments.length;
  const fromRaw = document.getElementById('rangeFrom').value.trim();
  const toRaw = document.getElementById('rangeTo').value.trim();
  if (!fromRaw || !toRaw) {
    alert('请填写「起始序号」和「结束序号」（表格左侧的行号，从 1 开始）。');
    return;
  }
  const from = parseInt(fromRaw, 10);
  const to = parseInt(toRaw, 10);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > n || to > n) {
    alert(`序号需在 1 ~ ${n} 之间。当前共 ${n} 条字幕。`);
    return;
  }
  if (from > to) {
    alert('起始序号不能大于结束序号。');
    return;
  }
  let segs = state.segments.slice(from - 1, to); // slice 末端不含，故用 to 即可包含第 to 条
  if (state.rescale) segs = rescaleSegments(segs);
  if (!confirmTimelineBeforeExport(segs)) return;
  await exportSegs(segs, `subtitles_${from}-${to}`, true);
});

document.getElementById('rate').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0) {
    state.rate = v;
    render();
  }
});

document.getElementById('tol').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) {
    state.tol = v / 100;
    render();
  }
});

document.getElementById('rescale').addEventListener('change', (e) => {
  state.rescale = e.target.checked;
});

document.getElementById('onlyBad').addEventListener('change', (e) => {
  state.onlyBad = e.target.checked;
  render();
});

/* ----------------------- 时间轴面板事件绑定 ----------------------- */
document.getElementById('toggleTimeline')?.addEventListener('click', () => {
  const p = document.getElementById('timelinePanel');
  if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
});

document.getElementById('tlShiftBtn')?.addEventListener('click', () => {
  const raw = document.getElementById('tlShift').value.trim();
  const r = parseFlexibleTime(raw);
  if (!r) { alert('无法识别的偏移量，示例：+1.5（秒）、-0.3、-300ms'); return; }
  // 偏移框里不带符号的纯数字按“正向偏移”理解（如 1.5 => +1.5s）
  const delta = r.delta != null ? r.delta : (r.abs != null ? r.abs : 0);
  applyShift(Math.round(delta));
});

document.getElementById('tlScaleBtn')?.addEventListener('click', () => {
  applyScale(parseFloat(document.getElementById('tlScale').value));
});

document.getElementById('tlAnchorBtn')?.addEventListener('click', applyAnchor);

document.getElementById('tlFillBtn')?.addEventListener('click', () => {
  if (!state.segments.length) { alert('请先导入字幕文件。'); return; }
  const f = state.focusIndex >= 0 ? state.focusIndex : 0;
  document.getElementById('tlA1').value = fmt(state.segments[f].startMs);
  document.getElementById('tlB1').value = fmt(state.segments[state.segments.length - 1].startMs);
  setTlStatus(
    `已填入原时间：第 ${f + 1} 段 ${fmt(state.segments[f].startMs)} 与 末段 ` +
    `${fmt(state.segments[state.segments.length - 1].startMs)}；请在两个「→」后填视频里对应的真实时间`
  );
});

document.getElementById('tlPickBtn')?.addEventListener('click', () => {
  if (!mediaPlayer || !mediaPlayer.src || !isFinite(mediaPlayer.currentTime)) {
    alert('请先拖入视频/音频文件并播放到目标位置。');
    return;
  }
  const t = fmt(Math.round(mediaPlayer.currentTime * 1000));
  if (!lastTimeInput || !document.body.contains(lastTimeInput)) {
    alert('已取到时间 ' + t + '\n请先点击一个时间输入框（表格里的开始/结束，或上方的锚点框），再点此按钮。');
    return;
  }
  lastTimeInput.value = t;
  if (lastTimeInput.classList.contains('t-in')) applyTimeInput(lastTimeInput);
  setTlStatus(`已写入 ${t}`);
});

document.getElementById('tlScope')?.addEventListener('change', updateOverlapHint);

document.getElementById('tlFixBtn')?.addEventListener('click', fixTimelineOrder);

document.getElementById('tlJumpBtn')?.addEventListener('click', () => {
  const issues = timelineIssues();
  if (!issues.length) {
    setTlStatus('<span class="oktext">时间轴没有发现问题</span>');
    return;
  }
  gotoIssue(issues[0].i);
});


document.getElementById('undoBtn')?.addEventListener('click', undo);
document.getElementById('redoBtn')?.addEventListener('click', redo);

document.getElementById('replaceBtn')?.addEventListener('click', () => {
  const search = document.getElementById('searchInput').value;
  const replace = document.getElementById('replaceInput').value;
  if (!search) return;

  let changed = false;
  state.segments.forEach(s => {
    if (s.text.includes(search)) {
      s.text = s.text.split(search).join(replace);
      changed = true;
    }
  });

  if (changed) {
    saveState();
    render();
  } else {
    alert('未找到匹配的文本。');
  }
});


/* ----------------------- 拖拽导入与音视频同步 (Drag & Drop & Media Sync) ----------------------- */
const dropZoneHint = document.getElementById('dropZoneHint');
const mediaPlayer = document.getElementById('mediaPlayer');
const mediaPreview = document.getElementById('mediaPreview');

document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropZoneHint.style.display = 'flex';
});

document.body.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (e.relatedTarget === null) {
    dropZoneHint.style.display = 'none';
  }
});

document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZoneHint.style.display = 'none';

  const file = e.dataTransfer.files[0];
  if (!file) return;

  if (file.name.toLowerCase().endsWith('.srt')) {
    const reader = new FileReader();
    reader.onload = () => {
      const segs = parseSRT(reader.result);
      if (segs && segs.length) applyLoaded(segs, file.name);
    };
    reader.readAsText(file, 'utf-8');
  } else if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
    const url = URL.createObjectURL(file);
    mediaPlayer.src = url;
    mediaPreview.style.display = 'block';
  } else {
    alert('不支持的文件格式。请拖入 .srt 或音视频文件。');
  }
});

mediaPlayer.addEventListener('timeupdate', () => {
  const pt = document.getElementById('tlPlayerTime');
  if (pt) pt.textContent = '播放头 ' + fmt(Math.round(mediaPlayer.currentTime * 1000));
  if (state.segments.length === 0) return;
  const currentTimeMs = mediaPlayer.currentTime * 1000;

  const tbody = document.getElementById('rows');
  const rows = tbody.querySelectorAll('tr');
  rows.forEach(tr => tr.classList.remove('active-row'));

  const activeSegIndex = state.segments.findIndex(s => currentTimeMs >= s.startMs && currentTimeMs <= s.endMs);
  if (activeSegIndex !== -1) {
    const tr = tbody.querySelector(`tr[data-i="${activeSegIndex}"]`);
    if (tr) {
      tr.classList.add('active-row');
      // 可选：平滑滚动到当前行
      // tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
});

/* ----------------------- 启动初始化 ----------------------- */
render();
updateOverlapHint();
