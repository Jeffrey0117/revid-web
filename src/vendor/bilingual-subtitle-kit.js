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

'use strict';

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
module.exports = {
  parseSubtitles,
  timestampToSeconds,
  parseVTT,
  fetchVTT,
  findSubtitleAtTime,
  translateSubtitles,
  createQueue,
  TranslationQueue,
  createSubtitleSync,
  createCache,
  withRetry,
};
