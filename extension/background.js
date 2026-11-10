/* What this tab is actually loading.
 *
 * This is the one thing a userscript cannot do. A script manager sees the DOM
 * and whatever XHR it can monkey-patch; it never sees a request a player makes
 * from a worker, and it never sees the playlist a native HLS implementation
 * fetches. webRequest sees all of them, which is what makes "give me the URL
 * of what I am watching" possible at all.
 *
 * Observe-only: MV3 removed blocking webRequest, and nothing here wants to
 * block anything. Reading is still allowed with the webRequest permission.
 */

const MEDIA_RE = /\.(m3u8|mpd|mp4|m4s|webm|mov|mkv|ts)(\?|#|$)/i;

// A live stream fetches a segment every few seconds forever. Keeping every one
// would fill memory and bury the playlist — the thing actually worth having —
// under thousands of near-identical rows. So segments are counted, not listed.
const SEGMENT_RE = /\.(ts|m4s)(\?|#|$)/i;

// The service worker is killed whenever Chrome feels like it, so nothing may
// live only in a module variable. session storage survives the worker and dies
// with the browser, which is the right lifetime for "what is this tab loading".
const KEY = (tabId) => `cap:${tabId}`;

async function read(tabId) {
    const got = await chrome.storage.session.get(KEY(tabId));
    return got[KEY(tabId)] || { items: [], segments: 0 };
}

async function write(tabId, state) {
    await chrome.storage.session.set({ [KEY(tabId)]: state });
}

function kindOf(url) {
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    return 'file';
}

// Several playlists per stream is normal: a master listing the variants, then
// one per quality. The master is the one worth handing to a downloader, and it
// is almost always the first seen, so order is preserved and nothing is
// deduplicated away except exact repeats.
async function note(details) {
    const { tabId, url, type } = details;
    if (tabId < 0 || !url.startsWith('http')) return;
    if (!MEDIA_RE.test(url) && type !== 'media') return;

    const state = await read(tabId);

    if (SEGMENT_RE.test(url)) {
        state.segments += 1;
        await write(tabId, state);
        return;
    }
    if (state.items.some((i) => i.url === url)) return;
    if (state.items.length >= 50) return;        // a page gone mad

    state.items.push({
        url,
        kind: kindOf(url),
        type,
        at: Date.now()
    });
    await write(tabId, state);
    chrome.action.setBadgeText({ tabId, text: String(state.items.length) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
}

chrome.webRequest.onBeforeRequest.addListener(
    (d) => { note(d); },
    { urls: ['<all_urls>'] }
);

// A new page is a new question; the old answers would just be misleading.
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' && info.url) {
        chrome.storage.session.remove(KEY(tabId));
        chrome.action.setBadgeText({ tabId, text: '' });
    }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(KEY(tabId)));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === 'captured') {
        read(msg.tabId).then(reply);
        return true;        // async reply
    }
    return false;
});
