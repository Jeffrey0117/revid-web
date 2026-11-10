// A static server that answers Range requests.
//
// python -m http.server does not, and without it a <video> cannot seek: the
// element asks for a byte range, gets the whole file with a 200, and quietly
// refuses to move. That cost an hour of thinking the player was broken.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8777);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8',
    '.mp4': 'video/mp4',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t'
};

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';

    const file = path.join(root, rel);
    if (!path.resolve(file).startsWith(path.resolve(root))) {
        res.writeHead(403); res.end(); return;
    }

    let stat;
    try { stat = fs.statSync(file); } catch (e) { res.writeHead(404); res.end('not found'); return; }

    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
            const start = m[1] ? parseInt(m[1], 10) : 0;
            const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
            if (start >= stat.size) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }
            res.writeHead(206, {
                'Content-Type': type,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1
            });
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
    }

    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`serving ${root} on http://127.0.0.1:${PORT}`));
