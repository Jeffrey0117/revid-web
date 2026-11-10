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
     * The box
     * ---------------------------------------------------------------- */

    var style = loadStyle();
    var host = null, box = null, enEl = null, zhEl = null;
    var video = null, track = null;
    var drag = null, resize = null, moved = false;

    // A shadow root of our own, so the page's CSS cannot reach in. Pages with
    // aggressive resets would otherwise flatten the box.
    function build() {
        host = document.createElement('div');
        host.id = 'revid-subs-host';
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
            'box-shadow:0 0 0 1px rgba(0,0,0,.55)}'
        ].join('');
        root.appendChild(css);

        box = document.createElement('div');
        box.className = 'box';
        box.title = '拖曳移動 · 四角等比縮放 · 兩側改寬度 · 雙擊回原位';
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

    function tick() {
        if (!video) return;
        var cue = cueAt(track, video.currentTime);
        if (!cue) {
            box.style.display = 'none';
            return;
        }
        box.style.display = '';
        var inner = Math.max(120, Math.round(videoRect().width * style.widthPct / 100) - 32);
        var piece = visibleCue({
            en: cue.text.replace(/<[^>]+>/g, ''),   // VTT allows inline markup
            zh: '',
            progress: cueProgress({ start: cue.startTime, end: cue.endTime }, video.currentTime),
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
            overlayUp: !!box
        };
        return r;
    }

    function start() {
        video = mainVideo();
        if (!video) return false;
        if (!host) build();
        track = cuesFromTracks(video);
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
        setStyle: function (patch) { Object.assign(style, patch); saveStyle(style); place(); }
    };
})();
