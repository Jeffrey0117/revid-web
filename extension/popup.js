// What the current tab has loaded, and what can be done with it.

const $ = (id) => document.getElementById(id);

function shorten(url) {
    // The end of a stream URL is the part that identifies it; the host and a
    // long signed prefix are noise in a 380px popup.
    if (url.length <= 96) return url;
    return url.slice(0, 40) + ' … ' + url.slice(-48);
}

(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const state = await chrome.runtime.sendMessage({ type: 'captured', tabId: tab.id });
    const items = state?.items || [];
    const segments = state?.segments || 0;

    $('count').textContent = items.length
        ? `${items.length} 個來源` + (segments ? ` · ${segments} 個分段` : '')
        : '';
    const foot = $('foot');
    foot.textContent = segments
        ? '分段只計數不列出 — 一支直播會抓到成千上萬個。 '
        : '只觀察，不攔截。 ';
    const gear = document.createElement('a');
    gear.textContent = '設定金鑰';
    gear.onclick = () => $('setup').classList.toggle('hide');
    foot.appendChild(gear);

    // The token is what stops any page you visit from queueing downloads on
    // your machine through 127.0.0.1, so it is asked for rather than defaulted.
    const { revidToken = '' } = await chrome.storage.local.get('revidToken');
    $('token').value = revidToken;
    if (!revidToken) $('setup').classList.remove('hide');
    $('save').onclick = async () => {
        await chrome.storage.local.set({ revidToken: $('token').value.trim() });
        $('saved').textContent = '已儲存';
        setTimeout(() => { $('saved').textContent = ''; }, 1500);
    };

    if (!items.length) { $('empty').hidden = false; return; }

    const list = $('list');
    for (const item of items) {
        const li = document.createElement('li');

        const row = document.createElement('div');
        row.className = 'row';
        const kind = document.createElement('span');
        kind.className = 'kind ' + item.kind;
        kind.textContent = item.kind.toUpperCase();
        row.appendChild(kind);
        const t = document.createElement('span');
        t.style.cssText = 'font-size:10px;color:#6b7280';
        t.textContent = item.type;
        row.appendChild(t);
        li.appendChild(row);

        const url = document.createElement('div');
        url.className = 'url';
        url.textContent = shorten(item.url);
        url.title = item.url;
        li.appendChild(url);

        const acts = document.createElement('div');
        acts.className = 'acts';

        const copy = document.createElement('button');
        copy.textContent = '複製網址';
        copy.onclick = async () => {
            await navigator.clipboard.writeText(item.url);
            copy.textContent = '已複製';
            setTimeout(() => { copy.textContent = '複製網址'; }, 1200);
        };
        acts.appendChild(copy);

        const send = document.createElement('button');
        send.className = 'ok';
        send.textContent = '送到 ReVid';
        send.onclick = async () => {
            send.disabled = true;
            send.textContent = '送出中…';
            const r = await sendToReVid(item.url);
            send.textContent = r.ok ? '已送出' : (r.error || '送不到');
            if (!r.ok) send.disabled = false;
        };
        acts.appendChild(send);

        li.appendChild(acts);
        list.appendChild(li);
    }
})();

// ReVid listens on the machine itself. Nothing leaves this computer, and if
// the app is not running the popup says so rather than failing silently.
async function sendToReVid(url) {
    const { revidPort = 31849, revidToken = '' } = await chrome.storage.local.get(['revidPort', 'revidToken']);
    try {
        const res = await fetch(`http://127.0.0.1:${revidPort}/api/grab`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, token: revidToken })
        });
        if (res.status === 401) return { ok: false, error: '金鑰不符' };
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: 'ReVid 沒開' };
    }
}
