/* Built by build.mjs — do not edit.
 *   shell: src/overlay.js
 *   kit:   subtitle-overlay-kit @ 1cf60d14ddf52d9cfa76871c686e4aa0b912a30b
 */

(function(){
// VENDORED from subtitle-overlay-kit — do not edit here.
//
//   upstream: https://github.com/Jeffrey0117/subtitle-overlay-kit
//   commit:   1cf60d14ddf52d9cfa76871c686e4aa0b912a30b
//
// The body below is byte-identical to the kit's index.js; only the module
// epilogue differs. The kit ships CommonJS for the sake of userscripts and
// node, and Vite's dev server does not give a .cjs file a default export the
// way its production build does — importing it worked when built and left the
// renderer a black screen when run. So the vendored copy is ESM.
//
// lan-page.cjs reads this file as text and strips the epilogue, so nothing
// actually requires it at runtime. It lives under electron/ because that is
// what gets packaged; src/ does not.


/*
 * subtitle-overlay-kit — 字幕「怎麼顯示在影片上」的純邏輯（vanilla JS，零依賴）
 * ---------------------------------------------------------------------------
 * 這顆 kit 不解析字幕、不翻譯、不碰播放器，也不畫任何 DOM。它只回答兩個問題：
 *
 *   1. 這一刻該顯示哪段文字？（長 cue 切成讀得完的片段）
 *   2. 那個框該放在哪、多大？（錨邊 + 位移 + 寬度 + 等比縮放）
 *
 * 之所以是同一顆 kit：這兩件事互相咬合——「一行放得下幾個字」要先知道框多寬，
 * 而框多寬是幾何的事。拆成兩顆會逼呼叫端自己把寬度在兩邊傳來傳去。
 *
 * 【組合縫】
 *   - bilingual-subtitle-kit：負責 parse / 翻譯 / 找出當下的 cue；本 kit 接手它
 *     吐出來的 { start, end, text, zh } 決定「顯示什麼、放哪裡」。
 *   - video-core-kit：負責把串流接上 <video> 並發進度事件；本 kit 只吃一個
 *     0..1 的 progress 數字，不認識播放器。
 *
 * 【為什麼需要切片】
 *   Whisper 之類的轉錄會把一整段對話吐成單一 cue——六個句子、兩百個字。整段畫
 *   上去就是畫面中央一片七行的告示牌。縮小字級救不了（那只是變成小字的告示
 *   牌），必須把 cue 切開，每片各佔這個 cue 自己時間的一份。
 */

/* ------------------------------------------------------------------ *
 * 一、顯示什麼：把過長的 cue 切成讀得完的片段
 * ------------------------------------------------------------------ */

var DEFAULT_MAX_LINES = 2;

// 斷句優先序：句號 > 逗號 > 詞間空白 > 隨便斷（中文沒有前三種）
var BREAK_AFTER = /[.!?。！？]/;
var SOFT_AFTER = /[,;:，；：、]/;

// 一行放得下幾個字。CJK 字身約為拉丁的兩倍寬，所以混排以較寬的那半計。
// latinRatio 可注入：不同字體的平均字寬差很多，寫死 0.56 只對無襯線體準。
function charsPerLine(widthPx, fontSize, cjk, latinRatio) {
  var ratio = cjk ? 1.0 : (typeof latinRatio === 'number' ? latinRatio : 0.56);
  var per = fontSize * ratio;
  if (!(per > 0) || !(widthPx > 0)) return 6;
  return Math.max(6, Math.floor(widthPx / per));
}

// 切成每片都塞得進 maxChars 的片段，斷在人會斷的地方。
function chunkText(text, maxChars) {
  var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (!(maxChars > 0)) return [clean];
  if (clean.length <= maxChars) return [clean];

  var chunks = [];
  var rest = clean;

  while (rest.length > maxChars) {
    // 剛好 maxChars：在最後一個索引斷，切出來就是 maxChars，不會多一個。
    // 曾經多找一格，把 42 字的上限變成 43、把兩行擠成三行。
    var window_ = rest.slice(0, maxChars);
    var floor = Math.floor(maxChars * 0.4);
    var cut = -1;
    var i;

    for (i = window_.length - 1; i >= floor; i--) {
      if (BREAK_AFTER.test(window_[i])) { cut = i + 1; break; }
    }
    if (cut < 0) {
      for (i = window_.length - 1; i >= floor; i--) {
        if (SOFT_AFTER.test(window_[i])) { cut = i + 1; break; }
      }
    }
    if (cut < 0) {
      var gap = window_.lastIndexOf(' ');
      if (gap >= floor) cut = gap;
    }
    if (cut < 0) cut = maxChars;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

// 走到第幾片。平均分配，而不是按長度加權——加權會讓短片段一閃而過來不及讀。
function chunkAt(chunks, progress) {
  if (!chunks || !chunks.length) return '';
  var p = Math.max(0, Math.min(0.999, Number(progress) || 0));
  return chunks[Math.floor(p * chunks.length)];
}

// 難字底線是對「整句」的字元位移，只顯示其中一片就會整個對不上。
// 位移到片段自己的座標系，片段外的丟掉。
//
// 切片會正規化空白，所以片段不一定是原句的字面子字串。找不到時回空陣列而不是
// 猜——少一條底線讀者沒損失，底線畫錯字會教錯東西。
function marksForChunk(marks, text, chunk) {
  if (!marks || !marks.length || !chunk) return [];
  var at = String(text == null ? '' : text).indexOf(chunk);
  if (at < 0) return [];
  var end = at + chunk.length;
  var out = [];
  for (var i = 0; i < marks.length; i++) {
    var m = marks[i];
    if (m.start >= at && m.end <= end) {
      out.push(Object.assign({}, m, { start: m.start - at, end: m.end - at }));
    }
  }
  return out;
}

// 整件事：此刻原文與譯文各該顯示哪一片。
//
// 片數多的那一軌定節拍，另一軌按比例攤在同樣的拍子上。曾經為了對齊而把較短的
// 那軌重切，結果重切出來的片數可能比拍子多，超出的尾巴永遠不會被顯示——重複
// 一行只是難看，一整句話消失不是。
function visibleCue(opts) {
  opts = opts || {};
  var maxLines = opts.maxLines > 0 ? opts.maxLines : DEFAULT_MAX_LINES;
  var enMax = charsPerLine(opts.widthPx, opts.fontSize, false, opts.latinRatio) * maxLines;
  var zhMax = charsPerLine(opts.widthPx, Math.round(opts.fontSize * 0.8), true, opts.latinRatio) * maxLines;

  var enChunks = chunkText(opts.en, enMax);
  var zhChunks = chunkText(opts.zh, zhMax);

  var steps = Math.max(enChunks.length, zhChunks.length, 1);
  var p = Math.max(0, Math.min(0.999, Number(opts.progress) || 0));
  var step = Math.floor(p * steps);

  function pick(list) {
    if (!list.length) return '';
    return list[Math.min(list.length - 1, Math.floor(step * list.length / steps))];
  }

  var en = pick(enChunks);
  return {
    en: en,
    zh: pick(zhChunks),
    steps: steps,
    step: step,
    marks: marksForChunk(opts.marks, opts.en, en)
  };
}

// 0..1：這一刻走到這個 cue 的幾分之幾。給 visibleCue 餵 progress 用。
function cueProgress(cue, currentTime) {
  if (!cue) return 0;
  var span = Number(cue.end) - Number(cue.start);
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(0.999, (Number(currentTime) - Number(cue.start)) / span));
}

/* ------------------------------------------------------------------ *
 * 二、放在哪：錨邊 + 位移 ↔ 絕對座標
 * ------------------------------------------------------------------ */

// 儲存形式是「哪一邊 + 距離那一邊多遠」，因為 CSS 要的是這個，而且視窗改變大
// 小時它才撐得住。拖曳用的是絕對 top，所以需要兩邊互換。

var DRAG_THRESHOLD = 4;        // 小於此距離的按放是「點擊」不是「拖曳」
var MIN_WIDTH_PCT = 20;
var MAX_WIDTH_PCT = 100;
var MIN_FONT = 10;
var MAX_FONT = 144;

function clampTop(o) {
  var limit = Math.max(0, o.areaHeight - o.boxHeight);
  if (!isFinite(o.top)) return 0;
  return Math.min(limit, Math.max(0, o.top));
}

function anchorToTop(o) {
  var raw = o.position === 'top' ? o.offset : o.areaHeight - o.boxHeight - o.offset;
  return clampTop({ top: raw, boxHeight: o.boxHeight, areaHeight: o.areaHeight });
}

// 放開時該掛哪一邊：落在哪半邊就掛哪邊。這不是美觀問題——停在畫面上緣卻存成
// 「距離下緣 N」的字幕，視窗一變矮就會往下滑過整個畫面。
function dropAnchor(o) {
  var settled = clampTop(o);
  var centre = settled + o.boxHeight / 2;
  if (centre < o.areaHeight / 2) {
    return { position: 'top', offset: Math.round(settled) };
  }
  return {
    position: 'bottom',
    offset: Math.round(Math.max(0, o.areaHeight - o.boxHeight - settled))
  };
}

// 視窗變小以後，存起來的位移可能已經把框推出畫面。重算一次讓它回到畫面內，
// 而且維持原本的錨邊。ReVid 沒有這道，縮視窗就會看到字幕被切掉。
function fitInside(o) {
  var top = anchorToTop(o);
  return dropAnchor({ top: top, boxHeight: o.boxHeight, areaHeight: o.areaHeight });
}

/* ------------------------------------------------------------------ *
 * 三、多大：側邊拉寬度、四角等比縮放
 * ------------------------------------------------------------------ */

// 框是置中的，所以拉一邊等於兩邊一起動：游標外移 100px，框寬增加 200px。
// 用百分比是因為畫面會隨視窗改變大小，px 寬度換個視窗就不合身。
function widthPctFrom(o) {
  if (!(o.areaWidth > 0)) return MAX_WIDTH_PCT;
  var halfWidth = Math.abs(o.pointerX - o.centreX);
  var pct = Math.round((halfWidth * 2 / o.areaWidth) * 100);
  return Math.min(MAX_WIDTH_PCT, Math.max(MIN_WIDTH_PCT, pct));
}

// 四角＝整體等比縮放（框、背景、文字一起），跟任何編輯器的角控點一樣。
//
// 比例是「先夾再套用」，不是寬度和字級各自夾：讓其中一個先撞到上限、另一個繼
// 續長，正是「等比」不再等比的原因，然後文字就爬出自己的框了。
function scaleFrom(o) {
  var half = Math.max(8, Math.abs(o.pointerX - o.centreX));
  var base = Math.max(8, o.startHalfWidth);

  var lowest = Math.max(MIN_WIDTH_PCT / o.startWidthPct, MIN_FONT / o.startFont);
  var highest = Math.min(MAX_WIDTH_PCT / o.startWidthPct, MAX_FONT / o.startFont);
  var ratio = Math.min(highest, Math.max(lowest, half / base));

  return {
    widthPct: Math.round(o.startWidthPct * ratio),
    fontSize: Math.round(o.startFont * ratio)
  };
}

// 垂直滑桿的上限。停在「框會開始離開畫面」的地方，而不是畫面高度——位移量到
// 的是框的近邊，最後一個框高的行程會把它推到看不見。用字級推估而不是實測，
// 否則 cue 在一行與兩行之間變動時，滑桿的行程會自己跳來跳去。
function maxOffsetFor(o) {
  var guess = o.fontSize * 2.8 + 16;
  return Math.max(120, Math.round(o.areaHeight - guess));
}



// VENDORED from bilingual-subtitle-kit — do not edit here.
//
//   upstream: https://github.com/Jeffrey0117/bilingual-subtitle-kit
//   commit:   d9d4f2dd4ce3743bd1877950d160c5106496fdee
//
// The body below is byte-identical to the kit index.js. build.mjs inlines
// everything above the module.exports block, because a userscript is one
// document with no module loader.
//
// Only parseSubtitles and timestampToSeconds are used here. The translation
// queue and cache come along unused rather than being cherry-picked, so this
// stays a copy that can be diffed against upstream instead of a fork.

// ============================================================================
// bilingual-subtitle-kit — 雙語字幕核心（VTT 解析 + 漸進背景翻譯 + 快取）
// ----------------------------------------------------------------------------
// 零依賴（純 JS，可跑在瀏覽器或 Node）。從 meetube 抽出去耦：
// 不綁任何翻譯後端 —— 你自己注入一個 translate(texts, {from,to}) => Promise<string[]>，
// 想接 DeepL / Google / OpenAI / 自架 API 都行。
//
// 提供三件事：
//   1. parseSubtitles(content)       —— SRT 或 VTT 文字切成字幕片段陣列（容錯，新程式用這支）
//      parseVTT(vttContent)        —— 同上但嚴格要求 WEBVTT 標頭與 "." 毫秒（舊介面，維持原行為）
//   2. createQueue({ translate, ... })—— 漸進翻譯佇列：先翻前幾句、隨播放進度背景預載、
//                                        並行控制 + 失敗重試，翻好即回呼 onUpdate
//   3. createCache({ ... })          —— 瀏覽器 Web Storage 快取（Node 無 storage 時自動降級為 no-op）
//
// 用法：
//   const kit = require('bilingual-subtitle-kit');
//   const subs = kit.parseVTT(vttText);
//   const q = kit.createQueue({ translate: myTranslate, to: 'zh-TW' });
//   await q.initialize(subs, 50);         // 先翻前 50 句
//   q.preloadForTime(video.currentTime);  // 隨播放預載後面 2 分鐘
//   q.translateRemaining();               // 有空時把剩下的都翻完（背景）
//
// translate 合約：
//   translate(texts: string[], { from, to }) => Promise<string[]>
//   回傳陣列長度、順序必須對齊 texts；某句翻不出來回原文即可。
//
// 註：Vue/React 的字幕疊層 UI 不含在本 kit（見 README「接你自己的 UI」）。
// ============================================================================


// ---------------------------------------------------------------------------
// 內建重試（取代 meetube 的 ./retry 依賴）
// ---------------------------------------------------------------------------
function defaultIsRetryable(error) {
  if (!error) return false;
  // 網路類錯誤 / 5xx / 429 視為可重試；4xx（除 429）不重試
  const status = error.status || error.statusCode;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return true; // 沒有 status（多半是 fetch/網路失敗）→ 重試
}

async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 2;
  const baseDelay = opts.baseDelay != null ? opts.baseDelay : 500;
  const shouldRetry = opts.shouldRetry || defaultIsRetryable;
  const onRetry = opts.onRetry || (() => {});

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt > maxRetries || !shouldRetry(error)) {
        throw error;
      }
      onRetry(attempt, error);
      const delay = baseDelay * Math.pow(2, attempt - 1); // 指數退避
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// VTT 解析
// ---------------------------------------------------------------------------
/**
 * 把 VTT 內容切成字幕片段
 * @param {string} vttContent - WEBVTT 檔內容
 * @returns {Array<{index:number,text:string,start:number,end:number,translation:string|null}>}
 */
function parseVTT(vttContent) {
  if (!vttContent || !vttContent.includes('WEBVTT')) {
    return [];
  }

  const subtitles = [];
  const lines = vttContent.split('\n');
  let i = 0;
  let index = 0;

  // 跳過標頭，找到第一個時間軸
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const match = line.match(
        /(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})/
      );

      if (match) {
        const startHours = match[1] ? parseInt(match[1]) : 0;
        const startMins = parseInt(match[2]);
        const startSecs = parseInt(match[3]);
        const startMs = parseInt(match[4]);

        const endHours = match[5] ? parseInt(match[5]) : 0;
        const endMins = parseInt(match[6]);
        const endSecs = parseInt(match[7]);
        const endMs = parseInt(match[8]);

        const start = startHours * 3600 + startMins * 60 + startSecs + startMs / 1000;
        const end = endHours * 3600 + endMins * 60 + endSecs + endMs / 1000;

        // 收集文字行，直到空行或下一個時間軸
        i++;
        const textLines = [];
        while (i < lines.length && lines[i].trim() && !lines[i].includes('-->')) {
          const textLine = lines[i].trim();
          // 跳過 cue 設定（position/align/line/size）
          if (!textLine.match(/^(position|align|line|size):/)) {
            // 去掉 HTML 標籤
            textLines.push(textLine.replace(/<[^>]+>/g, ''));
          }
          i++;
        }

        if (textLines.length > 0) {
          subtitles.push({
            index,
            text: textLines.join(' '),
            start,
            end,
            translation: null,
          });
          index++;
        }
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return subtitles;
}

/**
 * 從 URL 抓 VTT（需環境有 fetch）
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchVTT(url) {
  if (typeof fetch !== 'function') {
    throw new Error('bilingual-subtitle-kit: 此環境沒有 fetch，請自行抓取 VTT 文字後傳給 parseVTT');
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch VTT: ${response.status}`);
  }
  return response.text();
}

/**
 * 找出某時間點正在顯示的字幕
 * @param {Array} subtitles
 * @param {number} currentTime - 秒
 * @returns {Object|null}
 */
// ---------------------------------------------------------------------------
// 容錯解析：SRT 與 VTT 都吃
// ---------------------------------------------------------------------------
// parseVTT 要求內容含 WEBVTT、毫秒只認 "."，所以吃不下 SRT（逗號毫秒、開頭是
// 編號而非標頭）。這裡不改它的行為 —— 有專案靠那個檢查當格式驗證 —— 而是另外
// 提供一支會嗅探格式的，新程式一律用這支。
//
// 寬容的地方：SRT 逗號毫秒、沒有 WEBVTT 標頭、毫秒 1~3 位、小時可省略
// (mm:ss.mmm)、小時超過兩位、CRLF、BOM、cue 之間沒有空行、時間軸右側帶 cue
// 設定（position/line/align…）。

// "00:01:02,500" / "01:02.500" / "1:02:03.5" → 秒數。看不懂回 null，不是 NaN：
// NaN 會一路流進 start/end 讓每一句 cue 都「永遠不在時間內」，那種壞法沒有症狀。
function timestampToSeconds(stamp) {
  if (stamp === null || stamp === undefined) return null;
  var parts = String(stamp).trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;   // 單獨一個數字＝SRT 編號
  var seconds = Number(parts.pop().replace(',', '.'));
  var minutes = Number(parts.pop());
  var hours = parts.length ? Number(parts.pop()) : 0;
  if (!isFinite(seconds) || !isFinite(minutes) || !isFinite(hours)) return null;
  if (seconds < 0 || minutes < 0 || hours < 0) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

var CUE_SETTING = /^(position|align|line|size|vertical|region)\s*:/i;

/**
 * 解析 SRT 或 VTT，回傳跟 parseVTT 同形狀的陣列
 * @param {string} content - 字幕檔全文
 * @returns {Array<{index:number,text:string,start:number,end:number,translation:null}>}
 */
function parseSubtitles(content) {
  if (!content) return [];
  var lines = String(content)
    .replace(/^\uFEFF/, '')      // 檔案下載常帶 BOM
    .replace(/\r\n?/g, '\n')
    .split('\n');

  var out = [];
  var i = 0;
  var index = 0;

  while (i < lines.length) {
    if (lines[i].indexOf('-->') === -1) { i++; continue; }

    var halves = lines[i].split('-->');
    var start = timestampToSeconds(halves[0]);
    // 右側可能跟著 cue 設定："00:00:04.000 position:50% line:85%"
    var endRaw = String(halves[1] || '').trim().split(/\s+/)[0];
    var end = timestampToSeconds(endRaw);
    i++;
    if (start === null || end === null) continue;

    var textLines = [];
    while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('-->') === -1) {
      var line = lines[i].trim();
      if (!CUE_SETTING.test(line)) textLines.push(line.replace(/<[^>]+>/g, ''));
      i++;
    }

    // cue 之間沒空行時，下一句的 SRT 編號會被當成這句的台詞收進來。
    if (textLines.length
        && /^\d+$/.test(textLines[textLines.length - 1])
        && i < lines.length
        && lines[i].indexOf('-->') !== -1) {
      textLines.pop();
    }

    if (textLines.length) {
      out.push({
        index: index,
        text: textLines.join(' '),
        start: start,
        end: end,
        translation: null,
      });
      index++;
    }
  }

  return out;
}

function findSubtitleAtTime(subtitles, currentTime) {
  if (!subtitles || subtitles.length === 0) {
    return null;
  }
  return subtitles.find((sub) => sub.start <= currentTime && sub.end > currentTime) || null;
}

// ---------------------------------------------------------------------------
// 一次性把整批字幕翻完（簡單版；大量字幕請用 createQueue）
// ---------------------------------------------------------------------------
/**
 * @param {Function} translate - translate(texts, {from,to}) => Promise<string[]>
 * @param {Array} subtitles
 * @param {Object} [opts] - { from, to, batchSize, onProgress }
 * @returns {Promise<Array>} 帶 translation 的新陣列
 */
async function translateSubtitles(translate, subtitles, opts = {}) {
  if (!subtitles || subtitles.length === 0) return subtitles;

  const from = opts.from || 'auto';
  const to = opts.to || 'zh-TW';
  const batchSize = opts.batchSize || 10;
  const onProgress = opts.onProgress || null;
  const results = [...subtitles];

  for (let i = 0; i < subtitles.length; i += batchSize) {
    const batch = subtitles.slice(i, i + batchSize);
    const texts = batch.map((s) => s.text);

    try {
      const translations = await withRetry(() => translate(texts, { from, to }), {
        maxRetries: 2,
        baseDelay: 500,
      });
      batch.forEach((sub, idx) => {
        results[i + idx] = { ...sub, translation: translations[idx] || sub.text };
      });
    } catch (error) {
      // 失敗保留原文、translation 留 null
      batch.forEach((sub, idx) => {
        results[i + idx] = { ...sub, translation: null };
      });
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, subtitles.length), subtitles.length);
    }
    if (i + batchSize < subtitles.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// TranslationQueue — 漸進載入 + 背景預載
// ---------------------------------------------------------------------------
class TranslationQueue {
  /**
   * @param {Object} options
   * @param {Function} options.translate  - 必填。translate(texts, {from,to}) => Promise<string[]>
   * @param {string}   [options.from]     - 來源語言（預設 'auto'）
   * @param {string}   [options.to]       - 目標語言（預設 'zh-TW'）
   * @param {number}   [options.concurrency] - 並行請求數（預設 5）
   * @param {number}   [options.batchSize]   - 每批句數（預設 10）
   * @param {number}   [options.preloadWindow] - 往前預載幾秒（預設 120）
   * @param {Function} [options.onUpdate]   - 字幕更新回呼(subtitles)
   * @param {Function} [options.onProgress] - 進度回呼(translated, total)
   * @param {Object}   [options.retry]      - 傳給 withRetry 的選項
   */
  constructor(options = {}) {
    if (typeof options.translate !== 'function') {
      throw new Error('bilingual-subtitle-kit: options.translate 必填，需為 (texts,{from,to})=>Promise<string[]>');
    }
    this.translate = options.translate;
    this.from = options.from || 'auto';
    this.to = options.to || 'zh-TW';
    this.concurrency = options.concurrency || 5;
    this.batchSize = options.batchSize || 10;
    this.preloadWindow = options.preloadWindow || 120; // 往前 2 分鐘
    this.onUpdate = options.onUpdate || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.retry = options.retry || { maxRetries: 2, baseDelay: 500 };

    this.subtitles = [];
    this.translatedIndices = new Set();
    this.pendingIndices = new Set();
    this.isInitialized = false;
    this.isDestroyed = false;
    this.activeRequests = 0;
    this.lastPreloadTime = -1;
  }

  /**
   * 灌入字幕並先翻前 initialCount 句
   * @param {Array} subtitles
   * @param {number} [initialCount=50]
   */
  async initialize(subtitles, initialCount = 50) {
    if (!subtitles || subtitles.length === 0) {
      throw new Error('No subtitles provided');
    }

    this.subtitles = subtitles.map((sub, idx) => ({
      ...sub,
      index: idx,
      translation: sub.translation || null,
    }));

    // 若灌入的字幕已有部分譯文（例如來自快取），先記錄下來
    this.subtitles.forEach((sub, idx) => {
      if (sub.translation) this.translatedIndices.add(idx);
    });

    const toTranslate = Math.min(initialCount, this.subtitles.length);
    await this._translateRange(0, toTranslate);

    this.isInitialized = true;
  }

  async _translateRange(startIdx, endIdx) {
    const indices = [];
    for (let i = startIdx; i < endIdx && i < this.subtitles.length; i++) {
      if (!this.translatedIndices.has(i) && !this.pendingIndices.has(i)) {
        indices.push(i);
      }
    }
    if (indices.length === 0) return;

    // 切批
    const batches = [];
    for (let i = 0; i < indices.length; i += this.batchSize) {
      batches.push(indices.slice(i, i + this.batchSize));
    }

    const processBatch = async (batch) => {
      if (this.isDestroyed) return;
      batch.forEach((idx) => this.pendingIndices.add(idx));
      const texts = batch.map((idx) => this.subtitles[idx].text);

      try {
        const translations = await withRetry(
          () => this.translate(texts, { from: this.from, to: this.to }),
          this.retry
        );
        batch.forEach((idx, i) => {
          if (!this.isDestroyed) {
            this.subtitles[idx] = {
              ...this.subtitles[idx],
              translation: translations[i] || this.subtitles[idx].text,
            };
            this.translatedIndices.add(idx);
            this.pendingIndices.delete(idx);
          }
        });
        this.onUpdate(this.subtitles);
        this.onProgress(this.translatedIndices.size, this.subtitles.length);
      } catch (error) {
        batch.forEach((idx) => this.pendingIndices.delete(idx));
      }
    };

    // 並行控制
    const queue = [...batches];
    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0 && !this.isDestroyed) {
            const batch = queue.shift();
            if (batch) {
              this.activeRequests++;
              await processBatch(batch);
              this.activeRequests--;
            }
          }
        })()
      );
    }
    await Promise.all(workers);
  }

  /**
   * 依目前播放時間預載後面的字幕
   * @param {number} currentTime - 秒
   */
  preloadForTime(currentTime) {
    if (!this.isInitialized || this.isDestroyed) return;

    // 每 10 秒才觸發一次，避免太頻繁
    const timeWindow = Math.floor(currentTime / 10);
    if (timeWindow === this.lastPreloadTime) return;
    this.lastPreloadTime = timeWindow;

    const windowEnd = currentTime + this.preloadWindow;
    const startIdx = this.subtitles.findIndex((s) => s.start >= currentTime);
    const endIdx = this.subtitles.findIndex((s) => s.start > windowEnd);
    if (startIdx === -1) return;
    const actualEndIdx = endIdx === -1 ? this.subtitles.length : endIdx;

    let needsPreload = false;
    for (let i = startIdx; i < actualEndIdx; i++) {
      if (!this.translatedIndices.has(i) && !this.pendingIndices.has(i)) {
        needsPreload = true;
        break;
      }
    }
    if (needsPreload) {
      this._translateRange(startIdx, actualEndIdx);
    }
  }

  getSubtitleAt(currentTime) {
    return findSubtitleAtTime(this.subtitles, currentTime);
  }

  getAllSubtitles() {
    return this.subtitles;
  }

  getProgress() {
    const translated = this.translatedIndices.size;
    const total = this.subtitles.length;
    return {
      translated,
      total,
      percent: total > 0 ? Math.round((translated / total) * 100) : 0,
    };
  }

  /**
   * 背景把剩下沒翻的都翻完
   */
  async translateRemaining() {
    if (!this.isInitialized || this.isDestroyed) return;
    const remaining = this.subtitles.length - this.translatedIndices.size;
    if (remaining === 0) return;

    const untranslated = [];
    for (let i = 0; i < this.subtitles.length; i++) {
      if (!this.translatedIndices.has(i)) untranslated.push(i);
    }

    const chunkSize = 50;
    for (let i = 0; i < untranslated.length; i += chunkSize) {
      if (this.isDestroyed) break;
      const chunk = untranslated.slice(i, i + chunkSize);
      const startIdx = chunk[0];
      const endIdx = chunk[chunk.length - 1] + 1;
      await this._translateRange(startIdx, endIdx);
      if (i + chunkSize < untranslated.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  isComplete() {
    return this.translatedIndices.size === this.subtitles.length;
  }

  destroy() {
    this.isDestroyed = true;
    this.subtitles = [];
    this.translatedIndices.clear();
    this.pendingIndices.clear();
  }
}

/**
 * 建立漸進翻譯佇列（工廠）
 * @param {Object} options - 見 TranslationQueue constructor（translate 必填）
 * @returns {TranslationQueue}
 */
function createQueue(options = {}) {
  return new TranslationQueue(options);
}

// ---------------------------------------------------------------------------
// 字幕同步控制器（把播放時間對應到字幕；用 queue 時順便觸發預載）
// ---------------------------------------------------------------------------
/**
 * @param {HTMLVideoElement} videoElement
 * @param {TranslationQueue|Array} queueOrSubtitles
 * @param {Function} onSubtitleChange - (subtitle|null)
 * @returns {{start:Function, stop:Function, update:Function, setSubtitles:Function}}
 */
function createSubtitleSync(videoElement, queueOrSubtitles, onSubtitleChange) {
  let intervalId = null;
  let currentSubtitle = null;
  const isQueue = queueOrSubtitles instanceof TranslationQueue;

  const getSubtitles = () =>
    isQueue ? queueOrSubtitles.getAllSubtitles() : queueOrSubtitles;

  const update = () => {
    if (!videoElement) return;
    const time = videoElement.currentTime;
    const subtitles = getSubtitles();
    const newSubtitle = findSubtitleAtTime(subtitles, time);
    if (isQueue) queueOrSubtitles.preloadForTime(time);
    if (newSubtitle !== currentSubtitle) {
      currentSubtitle = newSubtitle;
      onSubtitleChange(newSubtitle);
    }
  };

  const start = () => {
    if (intervalId) return;
    update();
    intervalId = setInterval(update, 100);
    if (videoElement) videoElement.addEventListener('seeked', update);
  };

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (videoElement) videoElement.removeEventListener('seeked', update);
    currentSubtitle = null;
    onSubtitleChange(null);
  };

  const setSubtitles = (newSubtitles) => {
    if (!isQueue) queueOrSubtitles = newSubtitles;
    update();
  };

  return { start, stop, update, setSubtitles };
}

// ---------------------------------------------------------------------------
// 快取 —— 瀏覽器 Web Storage（localStorage）。Node/無 storage 時自動降級為 no-op。
// ---------------------------------------------------------------------------
function resolveStorage(custom) {
  if (custom) return custom;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      // 探測可用性（無痕模式可能拋錯）
      const probe = '__bsk_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (e) {
    /* fall through */
  }
  return null; // 沒有可用 storage → 降級
}

/**
 * 建立字幕快取
 * @param {Object} [opts]
 * @param {Object}  [opts.storage]     - 自訂儲存後端（需有 getItem/setItem/removeItem/length/key）
 * @param {string}  [opts.prefix]      - key 前綴（預設 'bilingual_cache_'）
 * @param {number}  [opts.version]     - 快取版本（預設 1）
 * @param {number}  [opts.maxAgeMs]    - 過期時間（預設 7 天）
 * @param {number}  [opts.maxEntries]  - 最多幾部影片（預設 50）
 * @returns {Object} { available, get, set, clearExpired, stats }
 */
function createCache(opts = {}) {
  const storage = resolveStorage(opts.storage);
  const PREFIX = opts.prefix || 'bilingual_cache_';
  const VERSION = opts.version || 1;
  const MAX_AGE = opts.maxAgeMs || 7 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = opts.maxEntries || 50;
  const available = !!storage;

  const makeKey = (id, lang) => `${PREFIX}v${VERSION}_${id}_${lang}`;

  function get(id, lang) {
    if (!available) return null;
    try {
      const key = makeKey(id, lang);
      const cached = storage.getItem(key);
      if (!cached) return null;
      const data = JSON.parse(cached);
      if (data.version !== VERSION) {
        storage.removeItem(key);
        return null;
      }
      if (Date.now() > data.expiresAt) {
        storage.removeItem(key);
        return null;
      }
      data.lastAccessed = Date.now();
      storage.setItem(key, JSON.stringify(data));
      return data.subtitles;
    } catch (e) {
      return null;
    }
  }

  function cleanupOldEntries() {
    if (!available || typeof storage.length !== 'number' || typeof storage.key !== 'function') return;
    try {
      const entries = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(PREFIX)) {
          try {
            const data = JSON.parse(storage.getItem(key));
            if (data && data.lastAccessed) entries.push({ key, lastAccessed: data.lastAccessed });
          } catch (e) {
            /* skip invalid */
          }
        }
      }
      if (entries.length > MAX_ENTRIES) {
        entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
        entries.slice(0, entries.length - MAX_ENTRIES).forEach((e) => storage.removeItem(e.key));
      }
    } catch (e) {
      /* ignore */
    }
  }

  function set(id, lang, subtitles) {
    if (!available) return;
    if (!subtitles || subtitles.length === 0) return;
    // 只快取「幾乎翻完」的（>=90%），避免存半成品
    const translatedCount = subtitles.filter((s) => s.translation).length;
    if (translatedCount < subtitles.length * 0.9) return;

    const buildData = () => ({
      version: VERSION,
      videoId: id,
      lang,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      expiresAt: Date.now() + MAX_AGE,
      subtitles,
    });

    try {
      storage.setItem(makeKey(id, lang), JSON.stringify(buildData()));
      cleanupOldEntries();
    } catch (error) {
      if (error && error.name === 'QuotaExceededError') {
        clearExpired();
        try {
          storage.setItem(makeKey(id, lang), JSON.stringify(buildData()));
        } catch (e) {
          /* give up */
        }
      }
    }
  }

  function clearExpired() {
    if (!available || typeof storage.length !== 'number' || typeof storage.key !== 'function') return;
    try {
      const keysToRemove = [];
      const now = Date.now();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(PREFIX)) {
          try {
            const data = JSON.parse(storage.getItem(key));
            if (!data || data.expiresAt < now) keysToRemove.push(key);
          } catch (e) {
            keysToRemove.push(key);
          }
        }
      }
      keysToRemove.forEach((key) => storage.removeItem(key));
    } catch (e) {
      /* ignore */
    }
  }

  function stats() {
    if (!available || typeof storage.length !== 'number' || typeof storage.key !== 'function') {
      return { entries: 0, sizeBytes: 0, sizeMB: '0' };
    }
    try {
      let totalEntries = 0;
      let totalSize = 0;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(PREFIX)) {
          totalEntries++;
          const item = storage.getItem(key);
          if (item) totalSize += item.length * 2; // UTF-16
        }
      }
      return { entries: totalEntries, sizeBytes: totalSize, sizeMB: (totalSize / (1024 * 1024)).toFixed(2) };
    } catch (e) {
      return { entries: 0, sizeBytes: 0, sizeMB: '0' };
    }
  }

  return { available, get, set, clearExpired, stats };
}

// ---------------------------------------------------------------------------
// 匯出
// ---------------------------------------------------------------------------

/* ReVid subtitle overlay — the web shell.
 *
 * Everything about *what to show* and *where the box goes* comes from
 * subtitle-overlay-kit, the same file the desktop app and the phone page use.
 * This file is only the parts a browser needs and an Electron window does not:
 * finding somebody else's <video>, surviving their CSS, and reading whatever
 * subtitles the page already has.
 *
 * The kit's functions are in scope as globals — build.mjs inlines it above
 * this file, because a userscript is one document with no module loader.
 */

(function () {
    'use strict';

    var HOST_ID = 'revid-subs-host';

    // The userscript and the extension both match every page, so somebody
    // running both gets two overlays: doubled text, and a drag that moves only
    // one of them. Whichever arrives first owns the page; the second stands
    // down and says so rather than fighting over the same video.
    if (document.getElementById(HOST_ID)) {
        if (!window.ReVidSubs) {
            window.ReVidSubs = {
                report: function () {
                    return { standDown: true, reason: 'another ReVid overlay already owns this page' };
                }
            };
        }
        return;
    }

    var STORE_KEY = 'revid-web-subtitle-style';

    var DEFAULT_STYLE = {
        fontSize: 30,
        color: '#ffffff',
        bgOpacity: 0.72,
        position: 'bottom',
        offset: 76,
        widthPct: 82
    };

    function loadStyle() {
        try {
            var saved = JSON.parse(localStorage.getItem(STORE_KEY));
            return saved ? Object.assign({}, DEFAULT_STYLE, saved) : Object.assign({}, DEFAULT_STYLE);
        } catch (e) {
            return Object.assign({}, DEFAULT_STYLE);
        }
    }

    // One writer. The desktop app learned this the hard way: a panel that
    // saved and a drag that did not meant the dragged position silently
    // vanished on reload.
    function saveStyle(style) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(style)); } catch (e) { /* private mode */ }
    }

    /* ---------------------------------------------------------------- *
     * Finding somebody else's video
     * ---------------------------------------------------------------- */

    // Players hide their element inside open shadow roots often enough that
    // querySelectorAll alone misses them. Closed roots are unreachable by
    // design and are simply reported as such rather than worked around.
    function findVideos(root, out, depth) {
        out = out || [];
        depth = depth || 0;
        if (depth > 8) return out;
        var all;
        try { all = root.querySelectorAll('video, *'); } catch (e) { return out; }
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.tagName === 'VIDEO') { if (out.indexOf(el) < 0) out.push(el); }
            if (el.shadowRoot) findVideos(el.shadowRoot, out, depth + 1);
        }
        return out;
    }

    // The biggest one on screen: pages are full of hidden preview and ad
    // elements, and the one worth subtitling is the one being watched.
    function mainVideo() {
        var vids = findVideos(document);
        var best = null, bestArea = 0;
        for (var i = 0; i < vids.length; i++) {
            var r = vids[i].getBoundingClientRect();
            var area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = vids[i]; }
        }
        return best;
    }

    /* ---------------------------------------------------------------- *
     * Subtitles the page already has
     * ---------------------------------------------------------------- */

    // Reading cues out of a <track> needs the track in 'hidden' mode:
    // 'disabled' never parses, and 'showing' makes the browser draw its own
    // captions on top of ours.
    function cuesFromTracks(video) {
        var tracks = video.textTracks;
        if (!tracks || !tracks.length) return null;
        var picked = null;
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
            t.mode = 'hidden';
            if (!picked) picked = t;
        }
        return picked;
    }

    function cueAt(track, time) {
        if (!track || !track.cues) return null;
        // activeCues is the fast path but is empty while seeking in some
        // engines, so fall back to a scan.
        var active = track.activeCues;
        if (active && active.length) return active[0];
        for (var i = 0; i < track.cues.length; i++) {
            var c = track.cues[i];
            if (time >= c.startTime && time <= c.endTime) return c;
        }
        return null;
    }

    /* ---------------------------------------------------------------- *
     * Subtitles the page does not have
     * ---------------------------------------------------------------- */

    // Plenty of video has no subtitle track at all, and the ones that do are
    // often the wrong language. Dropping a .srt or .vtt onto the picture loads
    // it; a second file becomes the lower line, so two files make it bilingual.
    //
    // Parsing is parseSubtitles from bilingual-subtitle-kit, inlined above —
    // not a regex written here. Real subtitle files have comma milliseconds,
    // BOMs, CRLF and missing blank lines, and a hand-rolled parser gets the
    // first or last cue wrong without ever saying so.
    var loaded = null;        // { en: [cues], zh: [cues]|null, names: [] }

    // Pair a second file's lines onto the first by overlap, so the two
    // languages stay together even when their cue boundaries differ — which
    // they almost always do, because they were timed separately.
    function pairByTime(primary, secondary) {
        var out = [];
        var j = 0;
        for (var i = 0; i < primary.length; i++) {
            var p = primary[i];
            var mid = p.start + (p.end - p.start) / 2;
            while (j < secondary.length - 1 && secondary[j].end < mid) j++;
            var s = secondary[j];
            var overlaps = s && s.start <= p.end && s.end >= p.start;
            out.push({ start: p.start, end: p.end, text: p.text, second: overlaps ? s.text : '' });
        }
        return out;
    }

    function cueFromLoaded(time) {
        if (!loaded) return null;
        var list = loaded.paired || loaded.en;
        // A plain scan: subtitle files are a few thousand lines and this runs
        // on timeupdate (4Hz), not per frame.
        for (var i = 0; i < list.length; i++) {
            if (time >= list[i].start && time <= list[i].end) return list[i];
        }
        return null;
    }

    function subtitleKey() {
        var dur = video && isFinite(video.duration) ? Math.round(video.duration) : 0;
        return 'revid-web-subs:' + location.hostname + location.pathname + ':' + dur;
    }

    function rememberLoaded() {
        if (!loaded) return;
        var payload = JSON.stringify({ at: Date.now(), names: loaded.names, en: loaded.en, zh: loaded.zh });
        try {
            localStorage.setItem(subtitleKey(), payload);
        } catch (e) {
            // Out of quota: drop every other page's subtitles and try once
            // more. Losing an old cache beats losing the file just loaded.
            try {
                for (var i = localStorage.length - 1; i >= 0; i--) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('revid-web-subs:') === 0 && k !== subtitleKey()) localStorage.removeItem(k);
                }
                localStorage.setItem(subtitleKey(), payload);
            } catch (e2) { /* too big for storage; it still works this session */ }
        }
    }

    function recallLoaded() {
        try {
            var saved = JSON.parse(localStorage.getItem(subtitleKey()));
            if (!saved || !saved.en || !saved.en.length) return false;
            loaded = { en: saved.en, zh: saved.zh || null, names: saved.names || [] };
            loaded.paired = loaded.zh ? pairByTime(loaded.en, loaded.zh) : null;
            return true;
        } catch (e) {
            return false;
        }
    }

    function loadText(text, name) {
        var cues = parseSubtitles(text);
        if (!cues.length) {
            toast('讀不到字幕：' + (name || '檔案'));
            return 0;
        }
        if (!loaded) {
            loaded = { en: cues, zh: null, names: [name || '字幕'], paired: null };
            toast(cues.length + ' 句字幕 · ' + (name || '') + '\n再拖一個檔可以變雙語');
        } else if (!loaded.zh) {
            loaded.zh = cues;
            loaded.names.push(name || '第二語言');
            loaded.paired = pairByTime(loaded.en, loaded.zh);
            toast('雙語已開 · ' + loaded.names.join(' + '));
        } else {
            // A third file replaces the pair rather than being ignored: the
            // user is most likely correcting a wrong file.
            loaded = { en: cues, zh: null, names: [name || '字幕'], paired: null };
            toast('換成 ' + (name || '新字幕') + '（' + cues.length + ' 句）');
        }
        rememberLoaded();
        tick();
        return cues.length;
    }

    function clearLoaded() {
        loaded = null;
        try { localStorage.removeItem(subtitleKey()); } catch (e) { /* ignore */ }
        toast('已清掉載入的字幕' + (track ? '，回到網頁本身的字幕軌' : ''));
        tick();
    }

    var SUBTITLE_FILE = /\.(srt|vtt|ass|ssa)$/i;

    function readDropped(files) {
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (!SUBTITLE_FILE.test(f.name)) continue;
            (function (file) {
                var r = new FileReader();
                r.onload = function () { loadText(String(r.result), file.name); };
                r.onerror = function () { toast('讀檔失敗：' + file.name); };
                // Subtitle files are usually UTF-8; a mis-decoded Big5 file
                // shows as mojibake rather than failing, which at least tells
                // the user what happened.
                r.readAsText(file, 'utf-8');
            })(f);
            return true;
        }
        return false;
    }

    // Only intercept a drag that is over the video. Stealing every file drop on
    // the page would break the page's own uploads.
    function overVideo(e) {
        if (!video) return false;
        var r = video.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    function hasFiles(e) {
        var dt = e.dataTransfer;
        if (!dt) return false;
        if (dt.types) {
            for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
        }
        return false;
    }

    function installDrop() {
        window.addEventListener('dragover', function (e) {
            if (!hasFiles(e) || !overVideo(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            hint(true);
        }, true);
        window.addEventListener('dragleave', function () { hint(false); }, true);
        window.addEventListener('drop', function (e) {
            if (!hasFiles(e) || !overVideo(e)) return;
            hint(false);
            var files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length && readDropped(files)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    /* ---------------------------------------------------------------- *
     * The box
     * ---------------------------------------------------------------- */

    var style = loadStyle();
    var host = null, box = null, enEl = null, zhEl = null;
    var toastEl = null, dropEl = null, toastTimer = null;
    var video = null, track = null;
    var drag = null, resize = null, moved = false;

    function toast(message) {
        if (!toastEl) return;
        var r = videoRect();
        toastEl.textContent = message;
        toastEl.style.left = Math.round(r.left + 16) + 'px';
        toastEl.style.top = Math.round(r.top + 16) + 'px';
        toastEl.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 3200);
    }

    function hint(on) {
        if (!dropEl) return;
        if (on) {
            var r = videoRect();
            dropEl.style.left = Math.round(r.left + 8) + 'px';
            dropEl.style.top = Math.round(r.top + 8) + 'px';
            dropEl.style.width = Math.round(r.width - 16) + 'px';
            dropEl.style.height = Math.round(r.height - 16) + 'px';
        }
        dropEl.classList.toggle('on', !!on);
    }

    // A shadow root of our own, so the page's CSS cannot reach in. Pages with
    // aggressive resets would otherwise flatten the box.
    function build() {
        host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
        document.documentElement.appendChild(host);

        var root = host.attachShadow({ mode: 'open' });
        var css = document.createElement('style');
        css.textContent = [
            ':host{all:initial}',
            '.box{position:fixed;left:50%;transform:translateX(-50%);',
            'box-sizing:border-box;padding:7px 16px;border-radius:8px;',
            'text-align:center;white-space:pre-wrap;pointer-events:auto;',
            'cursor:grab;user-select:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}',
            '.box.dragging{cursor:grabbing}',
            '.en,.zh{line-height:1.4;margin:0}',
            '.zh{opacity:.78;margin-top:2px}',
            '.h{position:absolute;opacity:0;transition:opacity .12s}',
            '.box:hover .h,.box.active .h{opacity:1}',
            '.side{top:50%;margin-top:-17px;width:14px;height:34px;cursor:ew-resize;',
            'display:flex;align-items:center;justify-content:center}',
            '.side i{width:3px;height:18px;border-radius:2px;background:rgba(255,255,255,.8);',
            'box-shadow:0 0 2px rgba(0,0,0,.6)}',
            '.corner{width:16px;height:16px;display:flex;align-items:center;justify-content:center}',
            '.corner i{width:7px;height:7px;border-radius:1px;background:#fff;',
            'box-shadow:0 0 0 1px rgba(0,0,0,.55)}',
            // Feedback for loading a file. Without it a drop that silently
            // worked and a drop the page swallowed look identical.
            '.toast{position:fixed;padding:10px 14px;border-radius:8px;',
            'background:rgba(17,17,17,.92);color:#fff;font:500 13px/1.45 system-ui,sans-serif;',
            'white-space:pre-line;max-width:min(420px,70vw);opacity:0;transform:translateY(6px);',
            'transition:opacity .18s,transform .18s;pointer-events:none}',
            '.toast.on{opacity:1;transform:none}',
            '.drop{position:fixed;border:2px dashed rgba(255,255,255,.85);border-radius:10px;',
            'background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;',
            'color:#fff;font:600 15px/1.4 system-ui,sans-serif;text-shadow:0 1px 3px rgba(0,0,0,.8)}',
            '.drop.on{display:flex}',
            '@media (prefers-reduced-motion:reduce){.toast{transition:none}}'
        ].join('');
        root.appendChild(css);

        toastEl = document.createElement('div');
        toastEl.className = 'toast';
        root.appendChild(toastEl);

        dropEl = document.createElement('div');
        dropEl.className = 'drop';
        dropEl.textContent = '放開載入字幕（.srt / .vtt）';
        root.appendChild(dropEl);

        box = document.createElement('div');
        box.className = 'box';
        box.title = '拖曳移動 · 四角等比縮放 · 兩側改寬度 · 雙擊回原位
把 .srt / .vtt 拖到畫面上可換成自己的字幕，再拖第二個檔變雙語';
        enEl = document.createElement('p'); enEl.className = 'en';
        zhEl = document.createElement('p'); zhEl.className = 'zh';
        box.appendChild(enEl);
        box.appendChild(zhEl);

        ['left', 'right'].forEach(function (side) {
            var h = document.createElement('div');
            h.className = 'h side';
            h.style[side] = '-7px';
            h.appendChild(document.createElement('i'));
            h.addEventListener('pointerdown', startResize('width'));
            box.appendChild(h);
        });
        [['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']].forEach(function (pos) {
            var h = document.createElement('div');
            h.className = 'h corner';
            h.style[pos[0]] = '-8px';
            h.style[pos[1]] = '-8px';
            h.style.cursor = (pos[0] === 'top') === (pos[1] === 'left') ? 'nwse-resize' : 'nesw-resize';
            h.appendChild(document.createElement('i'));
            h.addEventListener('pointerdown', startResize('scale'));
            box.appendChild(h);
        });

        box.addEventListener('pointerdown', startDrag);
        box.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            style.position = DEFAULT_STYLE.position;
            style.offset = DEFAULT_STYLE.offset;
            saveStyle(style);
            place();
        });
        root.appendChild(box);
    }

    // The box is positioned against the video's own rectangle, not the
    // window's: a player letterboxed in the middle of a page would otherwise
    // get its subtitles somewhere off in the margins.
    function videoRect() {
        if (!video) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        var r = video.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) {
            return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        }
        return r;
    }

    function place() {
        var r = videoRect();
        var h = box.offsetHeight || 40;
        var fixed = fitInside({
            position: style.position, offset: style.offset,
            boxHeight: h, areaHeight: r.height
        });
        if (fixed.position !== style.position || fixed.offset !== style.offset) {
            style.position = fixed.position;
            style.offset = fixed.offset;
            saveStyle(style);
        }
        var top = anchorToTop({
            position: style.position, offset: style.offset,
            boxHeight: h, areaHeight: r.height
        });
        box.style.top = (r.top + top) + 'px';
        box.style.left = (r.left + r.width / 2) + 'px';
        box.style.width = Math.round(r.width * style.widthPct / 100) + 'px';
        box.style.background = 'rgba(0,0,0,' + style.bgOpacity + ')';
        enEl.style.fontSize = style.fontSize + 'px';
        enEl.style.color = style.color;
        zhEl.style.fontSize = Math.round(style.fontSize * 0.78) + 'px';
        zhEl.style.color = style.color;
    }

    function startDrag(e) {
        if (!video) return;
        e.stopPropagation();
        var r = videoRect();
        var b = box.getBoundingClientRect();
        moved = false;
        drag = {
            grabY: e.clientY,
            grabTop: b.top - r.top,
            boxHeight: b.height,
            areaHeight: r.height
        };
        box.classList.add('dragging', 'active');
    }

    function startResize(kind) {
        return function (e) {
            if (!video) return;
            e.stopPropagation();
            e.preventDefault();
            var r = videoRect();
            resize = {
                kind: kind,
                centreX: r.left + r.width / 2,
                areaWidth: r.width,
                startHalfWidth: Math.max(8, Math.abs(e.clientX - (r.left + r.width / 2))),
                startWidthPct: style.widthPct,
                startFont: style.fontSize
            };
            box.classList.add('active');
        };
    }

    window.addEventListener('pointermove', function (e) {
        if (resize) {
            if (resize.kind === 'width') {
                style.widthPct = widthPctFrom({
                    pointerX: e.clientX, centreX: resize.centreX, areaWidth: resize.areaWidth
                });
            } else {
                var s = scaleFrom({
                    pointerX: e.clientX, centreX: resize.centreX,
                    startHalfWidth: resize.startHalfWidth,
                    startWidthPct: resize.startWidthPct, startFont: resize.startFont
                });
                style.widthPct = s.widthPct;
                style.fontSize = s.fontSize;
            }
            place();
            return;
        }
        if (!drag) return;
        if (Math.abs(e.clientY - drag.grabY) > DRAG_THRESHOLD) moved = true;
        var top = clampTop({
            top: drag.grabTop + (e.clientY - drag.grabY),
            boxHeight: drag.boxHeight, areaHeight: drag.areaHeight
        });
        var r = videoRect();
        box.style.top = (r.top + top) + 'px';
        drag.lastTop = top;
    }, true);

    window.addEventListener('pointerup', function () {
        if (resize) { resize = null; saveStyle(style); box.classList.remove('active'); }
        if (drag) {
            if (moved && typeof drag.lastTop === 'number') {
                var dropped = dropAnchor({
                    top: drag.lastTop, boxHeight: drag.boxHeight, areaHeight: drag.areaHeight
                });
                style.position = dropped.position;
                style.offset = dropped.offset;
                saveStyle(style);
            }
            drag = null;
            box.classList.remove('dragging', 'active');
            place();
        }
    }, true);

    /* ---------------------------------------------------------------- *
     * Per-frame: which piece belongs on screen
     * ---------------------------------------------------------------- */

    // A file the user loaded wins over the page's own track: they went to the
    // trouble precisely because the page's subtitles were missing or wrong.
    // Both sources are normalised to { start, end, text, second } here so the
    // drawing code below has one shape to deal with.
    function currentCue(time) {
        var mine = cueFromLoaded(time);
        if (mine) return mine;
        if (loaded) return null;          // loaded but between cues — stay quiet
        var cue = cueAt(track, time);
        if (!cue) return null;
        return {
            start: cue.startTime,
            end: cue.endTime,
            text: cue.text.replace(/<[^>]+>/g, ''),   // VTT allows inline markup
            second: ''
        };
    }

    function tick() {
        if (!video || !box) return;
        var cue = currentCue(video.currentTime);
        if (!cue) {
            box.style.display = 'none';
            return;
        }
        box.style.display = '';
        var inner = Math.max(120, Math.round(videoRect().width * style.widthPct / 100) - 32);
        var piece = visibleCue({
            en: cue.text,
            zh: cue.second || '',
            progress: cueProgress({ start: cue.start, end: cue.end }, video.currentTime),
            widthPx: inner,
            fontSize: style.fontSize
        });
        if (enEl.textContent !== piece.en) enEl.textContent = piece.en;
        if (zhEl.textContent !== piece.zh) zhEl.textContent = piece.zh;
        zhEl.style.display = piece.zh ? '' : 'none';
        place();
    }

    /* ---------------------------------------------------------------- *
     * What this page actually gave us
     * ---------------------------------------------------------------- */

    function report() {
        var vids = findVideos(document);
        var r = {
            videos: vids.length,
            picked: !!video,
            duration: video ? Math.round(video.duration) : null,
            srcKind: video ? (/^blob:/.test(video.currentSrc || video.src) ? 'blob (MSE)' :
                /\.m3u8/.test(video.currentSrc || '') ? 'hls' : 'file') : null,
            textTracks: video && video.textTracks ? video.textTracks.length : 0,
            readableCues: track && track.cues ? track.cues.length : 0,
            inShadow: vids.some(function (v) { return v.getRootNode() !== document; }),
            overlayUp: !!box,
            // Which subtitles are actually on screen, and where they came from.
            source: loaded ? (loaded.zh ? 'loaded file (bilingual)' : 'loaded file')
                : (track ? 'page <track>' : 'none'),
            loadedNames: loaded ? loaded.names.slice() : [],
            loadedCues: loaded ? loaded.en.length : 0
        };
        return r;
    }

    function start() {
        var first = !host;
        video = mainVideo();
        if (!video) return false;
        if (first) build();
        track = cuesFromTracks(video);
        if (first) installDrop();
        // Subtitles loaded for this page last time come back without asking,
        // keyed by the page and the video's duration so a different episode on
        // the same URL does not inherit the wrong file.
        if (!loaded && recallLoaded()) {
            toast('沿用上次載入的字幕 · ' + loaded.names.join(' + '));
        }
        video.addEventListener('timeupdate', tick);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        tick();
        return true;
    }

    // Players arrive late and swap elements; keep looking rather than giving
    // up on the first miss.
    var tries = 0;
    var poll = setInterval(function () {
        if (start() || ++tries > 40) clearInterval(poll);
    }, 500);

    window.ReVidSubs = {
        report: report,
        style: function () { return style; },
        restart: start,
        setStyle: function (patch) { Object.assign(style, patch); saveStyle(style); place(); },
        // Dropping a file on the video is the normal way in; these are for the
        // extension popup and for driving it from the console.
        loadText: loadText,
        loadFile: function (file) { return readDropped([file]); },
        clear: clearLoaded,
        pick: function () {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.srt,.vtt,.ass,.ssa,text/vtt';
            input.style.display = 'none';
            input.addEventListener('change', function () {
                if (input.files && input.files.length) readDropped(input.files);
                input.remove();
            });
            document.documentElement.appendChild(input);
            input.click();
        }
    };
})();

})();
