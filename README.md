# revid-web

ReVid 的字幕層,跑在**別人的網頁**上。

桌面版(Electron)、手機頁(區網分享)、這裡的腳本版,三個殼共用同一顆
[`subtitle-overlay-kit`](https://github.com/Jeffrey0117/subtitle-overlay-kit) ——
長句切片、拖曳、四角等比縮放、位置記憶,行為一模一樣。改 kit 一次,三邊一起升級。

```bash
node build.mjs          # → dist/revid-subs.user.js
```

把 `dist/revid-subs.user.js` 丟進 Tampermonkey 即可。

## 現況:做得到什麼

在本機測試頁實測通過(Chrome):

- 找到頁面的 `<video>`(含 open shadow DOM;取畫面上最大的那個,因為頁面到處是隱藏的預覽和廣告元素)
- 讀頁面自己的 `<track>` 字幕 —— 必須把 track 設成 `hidden`:`disabled` 永遠不會解析,`showing` 會讓瀏覽器把它自己的字幕畫在我們上面
- **200 字的 cue 即時切成兩行一片**,跟著 cue 自己的時間推進
- 拖曳移動、放開時自動換錨邊、寫進 localStorage
- 自己的 shadow root,頁面的 CSS reset 打不進來

框是對著**影片的矩形**定位,不是視窗 —— 不然播放器嵌在頁面中間時,字幕會跑到旁邊的空白區。

## 現況:做不到什麼

這些是結構性的,不是還沒寫:

- **DRM(Widevine)完全無解。** Netflix / Disney+ / YouTube 付費內容的影像不經過任何腳本讀得到的路徑。這是密碼學,不是難度。
- **closed shadow root 讀不到。** 設計上就不給外部存取,只能回報「看不到」而不是繞過。
- **不用 `<video>` 的播放器**(canvas 繪製)目前完全不支援。
- **腳本版拿不到 `webRequest`**,所以抓串流網址的能力天生比擴充版弱一截。這兩個版本功能不會對等,不要當成同一個東西規劃。

## 還沒做

- 自己的字幕來源(丟 .srt / 接 ReVid 本機的轉錄)—— 目前只吃頁面現有的 track
- 雙語(kit 支援,殼還沒接 `zh`)
- 擴充版:`webRequest` 攔 `.m3u8` / `.mp4`,把網址丟回 ReVid 桌面版下載

## 測試頁

```bash
cd testpage && python -m http.server 8777
```

刻意做成「敵意頁面」:全域 CSS reset、強制字體。裡面第二條 cue 是 200 字的真實轉錄形狀。

⚠️ `python -m http.server` **不支援 Range 請求**,所以那頁的影片**不能 seek**(`currentTime` 設了會彈回 0),而且有聲音會被自動播放政策擋住 —— 測試時靜音從頭播。
