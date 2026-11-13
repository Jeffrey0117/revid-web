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
