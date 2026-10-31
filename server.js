// server.js — WAM Radar
// Проверява дали една плейър страница РЕАЛНО дава видео (а не само дали страница съществува).
//
// Ендпойнти (всички искат API ключ, освен /health):
//   GET /check?url=...&runtime=122&wait=30&debug=1   -> JSON с присъда и доказателства
//   GET /screenshot?url=...&wait=15                  -> PNG: какво вижда браузърът (за дебъг)
//   GET /health
//
// Ключът се подава с хедър  x-api-key: ...  или  ?key=...
// Променливи на средата: API_KEY (задължителна), PORT, MAX_CONCURRENT (по подразбиране 2), ALLOW_PRIVATE=1 (само за тест)

const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || '2', 10));
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CF_RE = /just a moment|verifying you are human|verify you are human|checking your browser|attention required/i;
const LOADING_RE = /fetching|loading|please wait/i;
const ERROR_RE = /not found|not available|unavailable|no sources?|could not find|couldn.?t find|failed to (load|fetch)|something went wrong|\b404\b/i;

const app = express();

// ---------------------------------------------------------------- сигурност
function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
    if (!API_KEY) return res.status(503).json({ success: false, error: 'Сървърът няма зададен API_KEY (променлива на средата).' });
    const given = req.get('x-api-key') || req.query.key || '';
    if (!safeEqual(given, API_KEY)) return res.status(401).json({ success: false, error: 'Невалиден ключ.' });
    next();
}

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
               (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (net.isIPv6(ip)) {
        const x = ip.toLowerCase();
        return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:');
    }
    return true;
}

// Не даваме на сървъра да се използва за достъп до вътрешни адреси (напр. метаданните на Oracle Cloud 169.254.169.254).
async function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Error('Невалиден URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Позволени са само http и https адреси.');
    if (ALLOW_PRIVATE) return u;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Този адрес не е позволен.');
    return u;
}

// ---------------------------------------------------------------- браузър и опашка
let browserPromise = null;
function getBrowser() {
    if (!browserPromise) {
        browserPromise = chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',                       // в Docker /dev/shm е малка и Chrome се срива
                '--disable-blink-features=AutomationControlled',
                '--autoplay-policy=no-user-gesture-required',
            ],
        }).then((b) => {
            b.on('disconnected', () => { browserPromise = null; });
            return b;
        }).catch((e) => { browserPromise = null; throw e; });
    }
    return browserPromise;
}

let active = 0;
const waiters = [];
async function acquire() {
    if (active < MAX_CONCURRENT) { active++; return; }
    await new Promise((resolve) => waiters.push(resolve));
}
function release() {
    const next = waiters.shift();
    if (next) next(); else active--;
}
async function runLimited(fn) {
    await acquire();
    try { return await fn(); } finally { release(); }
}

// ---------------------------------------------------------------- проверка на самия поток
function sniffBytes(buf) {
    if (!buf || !buf.length) return 'empty';
    const head = buf.slice(0, 64).toString('latin1').trimStart().toLowerCase();
    if (head.startsWith('<') || head.startsWith('{') || head.startsWith('[')) return 'text';
    if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
    if (buf.length >= 8 && /ftyp|styp|moof|moov|sidx/.test(buf.slice(4, 8).toString('latin1'))) return 'fmp4';
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
    return 'binary'; // непознат двоичен формат (някои сайтове маскират сегментите): не го броим за грешка
}

function isoDuration(s) {
    const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(s || '');
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
}

function fmtDur(sec) {
    return sec < 120 ? Math.round(sec) + ' сек.' : Math.round(sec / 60) + ' мин.';
}

function durationOk(seconds, runtimeMin) {
    if (!seconds || !runtimeMin) return null;                  // не знаем -> не решаваме
    const r = runtimeMin * 60;
    return seconds >= r * 0.6 && seconds <= r * 1.5;
}

async function validateCandidate(context, cand) {
    const ref = cand.referer || cand.url;
    let origin = '';
    try { origin = new URL(ref).origin; } catch {}
    const headers = { 'User-Agent': UA, Referer: ref, ...(origin ? { Origin: origin } : {}) };
    const get = (u, extra = {}) => context.request.get(u, { headers: { ...headers, ...extra }, timeout: 15000, failOnStatusCode: false });

    try {
        if (cand.kind === 'hls') {
            let r = await get(cand.url);
            if (!r.ok()) return { valid: false, why: 'манифестът връща HTTP ' + r.status() };
            let text = await r.text();
            if (!/^\s*#EXTM3U/.test(text)) return { valid: false, why: 'манифестът не е валиден (няма #EXTM3U)' };

            let playlistUrl = cand.url;
            if (/#EXT-X-STREAM-INF/.test(text)) {                // главен плейлист -> взимаме първия вариант
                const lines = text.split(/\r?\n/);
                const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
                const next = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
                if (!next) return { valid: false, why: 'главният манифест няма варианти' };
                playlistUrl = new URL(next.trim(), cand.url).href;
                r = await get(playlistUrl);
                if (!r.ok()) return { valid: false, why: 'вариантът връща HTTP ' + r.status() };
                text = await r.text();
                if (!/^\s*#EXTM3U/.test(text)) return { valid: false, why: 'вариантът не е валиден плейлист' };
            }

            let duration = 0;
            const segs = [];
            for (const raw of text.split(/\r?\n/)) {
                const l = raw.trim();
                if (l.startsWith('#EXTINF:')) duration += parseFloat(l.slice(8)) || 0;
                else if (l && !l.startsWith('#')) segs.push(l);
            }
            if (!segs.length) return { valid: false, why: 'плейлистът няма сегменти' };

            const vod = /#EXT-X-ENDLIST/.test(text);
            const encrypted = /#EXT-X-KEY:[^\n]*METHOD=(?!NONE)/.test(text);
            const segUrl = new URL(segs[0], playlistUrl).href;
            const sr = await get(segUrl, { Range: 'bytes=0-4095' });
            if (sr.status() !== 200 && sr.status() !== 206) return { valid: false, why: 'първият сегмент връща HTTP ' + sr.status() };
            const kind = sniffBytes(await sr.body());
            if (kind === 'text' || kind === 'empty') {
                return { valid: false, why: 'първият сегмент не е видео (връща ' + (kind === 'empty' ? 'празно тяло' : 'текст/HTML') + ')' };
            }
            return { valid: true, duration: vod ? Math.round(duration) : null, vod, segments: segs.length, encrypted, segmentKind: kind };
        }

        if (cand.kind === 'dash') {
            const r = await get(cand.url);
            if (!r.ok()) return { valid: false, why: 'MPD връща HTTP ' + r.status() };
            const text = await r.text();
            if (!/<MPD[\s>]/.test(text)) return { valid: false, why: 'MPD не е валиден' };
            const m = /mediaPresentationDuration="([^"]+)"/.exec(text);
            return { valid: true, duration: m ? Math.round(isoDuration(m[1]) || 0) || null : null, segmentKind: 'not-checked' };
        }

        // директен файл (mp4/webm)
        const r = await get(cand.url, { Range: 'bytes=0-4095' });
        if (r.status() !== 200 && r.status() !== 206) return { valid: false, why: 'файлът връща HTTP ' + r.status() };
        const kind = sniffBytes(await r.body());
        if (kind === 'text' || kind === 'empty') return { valid: false, why: 'файлът не е видео' };
        const cr = /\/(\d+)$/.exec(r.headers()['content-range'] || '');
        return { valid: true, duration: null, size: cr ? parseInt(cr[1], 10) : null, segmentKind: kind };
    } catch (e) {
        return { valid: false, why: 'грешка при проверка: ' + e.message.split('\n')[0] };
    }
}

// ---------------------------------------------------------------- помощни за страницата
async function readVideos(page) {
    const out = [];
    for (const f of page.frames()) {
        try {
            const vs = await f.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => ({
                src: (v.currentSrc || v.src || '').slice(0, 160),
                rs: v.readyState, t: v.currentTime, d: v.duration,
                w: v.videoWidth, h: v.videoHeight, paused: v.paused, err: v.error ? v.error.code : null,
            })));
            for (const v of vs) out.push({ frame: f === page.mainFrame() ? 'main' : f.url().slice(0, 120), ...v });
        } catch { /* рамката може да е затворена */ }
    }
    return out;
}

async function frameTexts(page) {
    const out = [];
    for (const f of page.frames()) {
        try {
            const t = await f.evaluate(() => (document.body ? document.body.innerText : '') || '');
            const s = t.replace(/\s+/g, ' ').trim();
            if (s) out.push({ frame: f === page.mainFrame() ? 'main' : f.url().slice(0, 120), text: s.slice(0, 300) });
        } catch { /* ignore */ }
    }
    return out;
}

const PLAY_SELECTORS = [
    'button[aria-label*="play" i]', '.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid',
    '.play-button', '.btn-play', '[class*="play-btn" i]', '[class*="playbtn" i]',
];

async function tryPlay(page) {
    let target = null;
    for (const f of page.frames()) {
        try {
            await f.evaluate(() => {
                document.querySelectorAll('video').forEach((v) => {
                    v.muted = true;
                    const p = v.play();
                    if (p && p.catch) p.catch(() => {});
                });
            });
        } catch { /* ignore */ }
        for (const sel of PLAY_SELECTORS) {
            try {
                const el = await f.$(sel);
                if (el && (await el.isVisible())) {
                    await el.click({ timeout: 1500 });
                    return (f === page.mainFrame() ? 'main' : f.url().slice(0, 60)) + ' ' + sel;
                }
            } catch { /* ignore */ }
        }
    }
    try { await page.mouse.click(640, 360); target = 'център (640,360)'; } catch { /* ignore */ }
    return target;
}

// Видимите елементи, които приличат на бутони: за да се види къде реално може да се кликне.
async function listClickables(page) {
    const out = [];
    for (const f of page.frames()) {
        try {
            const items = await f.evaluate(() => {
                const sel = 'button,[role=button],a,[onclick],[class*="play" i],[id*="play" i],[class*="server" i],[aria-label],svg,video';
                return Array.from(document.querySelectorAll(sel)).slice(0, 600).map((e) => {
                    const r = e.getBoundingClientRect();
                    const cs = getComputedStyle(e);
                    const cls = typeof e.className === 'string' ? e.className : ((e.className && e.className.baseVal) || '');
                    return {
                        tag: e.tagName.toLowerCase(), id: e.id || '', cls: cls.slice(0, 80),
                        label: (e.getAttribute('aria-label') || '').slice(0, 40), text: (e.innerText || '').trim().slice(0, 30),
                        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                        vis: r.width > 10 && r.height > 10 && cs.visibility !== 'hidden' && cs.display !== 'none',
                    };
                }).filter((i) => i.vis).slice(0, 40);
            });
            if (items.length) out.push({ frame: f === page.mainFrame() ? 'main' : f.url().slice(0, 100), items });
        } catch { /* ignore */ }
    }
    return out;
}

// ---------------------------------------------------------------- основната проверка
async function analyze(rawUrl, opts) {
    const t0 = Date.now();
    const url = (await assertSafeUrl(rawUrl)).href;
    const browser = await getBrowser();
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 }, locale: 'en-US', ignoreHTTPSErrors: true });
    const killer = setTimeout(() => context.close().catch(() => {}), 170000);

    const found = [];
    const seen = new Set();
    const netLog = [];
    const failed = [];
    const consoleErrors = [];
    const allReq = [];
    const sockets = [];
    const clickLog = [];
    let popupsClosed = 0;
    let firstFoundAt = 0;

    try {
        if (!ALLOW_PRIVATE) {
            await context.route('**/*', (route) => {
                try {
                    const h = new URL(route.request().url()).hostname.replace(/^\[|\]$/g, '');
                    if (net.isIP(h) && isPrivateIp(h)) return route.abort();
                } catch { /* ignore */ }
                return route.continue();
            });
        }

        const page = await context.newPage();
        context.on('page', (p) => { if (p !== page) { popupsClosed++; p.close().catch(() => {}); } });   // рекламни прозорци

        // Пълен списък на заявките (всички типове), за да се види какво плейърът изобщо прави.
        context.on('request', (r) => {
            if (allReq.length < 250) allReq.push(r.resourceType() + ' ' + r.method() + ' ' + r.url().slice(0, 150));
        });
        page.on('websocket', (ws) => { if (sockets.length < 10) sockets.push(ws.url().slice(0, 160)); });

        context.on('requestfailed', (r) => {
            if (failed.length < 40) failed.push({ url: r.url().slice(0, 160), error: (r.failure() || {}).errorText });
        });
        page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 15) consoleErrors.push(m.text().slice(0, 200)); });
        page.on('pageerror', (e) => { if (consoleErrors.length < 15) consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)); });

        // Слушаме на ниво браузър-контекст: хваща и рамките, и работниците (workers).
        context.on('response', async (resp) => {
            try {
                const req = resp.request();
                const rt = req.resourceType();
                const u = resp.url();
                const status = resp.status();
                const ct = (resp.headers()['content-type'] || '').toLowerCase();
                const isData = ['xhr', 'fetch', 'media', 'other'].includes(rt);
                if (isData && netLog.length < 120) netLog.push({ type: rt, status, ct, url: u.slice(0, 180) });
                if (seen.has(u)) return;

                let kind = null;
                if (/\.m3u8(\?|#|$)/i.test(u) || /mpegurl/.test(ct)) kind = 'hls';
                else if (/\.mpd(\?|#|$)/i.test(u) || /dash\+xml/.test(ct)) kind = 'dash';
                else if (/\.(mp4|webm)(\?|#|$)/i.test(u) || /^video\//.test(ct)) kind = 'file';
                else if (['xhr', 'fetch', 'other'].includes(rt) && status === 200) {
                    // адресът може да е маскиран ("/api/x"): гледаме какво има вътре
                    const len = parseInt(resp.headers()['content-length'] || '0', 10);
                    if (!len || len < 2000000) {
                        const head = (await resp.body()).slice(0, 200).toString('utf8').trimStart();
                        if (head.startsWith('#EXTM3U')) kind = 'hls';
                        else if (/^<\?xml[\s\S]{0,120}<MPD|^<MPD/.test(head)) kind = 'dash';
                    }
                }
                if (kind && status >= 200 && status < 400) {
                    seen.add(u);
                    if (!firstFoundAt) firstFoundAt = Date.now();
                    found.push({ url: u, kind, status, ct, referer: req.headers()['referer'] || url });
                }
            } catch { /* тялото може да не е достъпно */ }
        });

        let navError = null;
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            navError = e.message.split('\n')[0];
        }

        let canDecode = null;
        try {
            canDecode = await page.evaluate(() => ({
                h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') || 'no',
                mse_h264: !!(window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')),
            }));
        } catch { /* ignore */ }

        // Изчакваме, докато плейърът излъже или пусне видео. Не чакаме фиксирано време.
        const start = Date.now();
        const deadline = start + opts.wait * 1000;
        let lastClick = 0;
        let clicks = 0;
        let bestTime = 0;
        let playedDuration = null;
        let videos = [];

        while (Date.now() < deadline) {
            await page.waitForTimeout(1000);
            videos = await readVideos(page);
            for (const v of videos) {
                if (!v.err && v.w > 0 && v.rs >= 2 && v.t > bestTime) {
                    bestTime = v.t;
                    playedDuration = Number.isFinite(v.d) ? v.d : null;
                }
            }
            if (bestTime >= 3) break;                                                // видеото върви

            const el = Date.now() - start;
            if (clicks < 5 && el > 2500 && Date.now() - lastClick > 2500) {         // още не върви: клик (първият често отваря реклама, вторият пуска плейъра)
                const target = await tryPlay(page);
                clickLog.push({ atSec: Math.round(el / 1000), target, popupsClosed });
                clicks++;
                lastClick = Date.now();
            }
            if (firstFoundAt && Date.now() - firstFoundAt > 8000) break;             // има манифест, дадохме му време
        }

        // Какво "вижда" сайтът за този браузър: ако много неща изглеждат като автоматизация, плейърът може да спира нарочно.
        let env = null;
        if (opts.debug) {
            env = await page.evaluate(() => {
                let gl = null;
                try {
                    const c = document.createElement('canvas').getContext('webgl');
                    const ext = c && c.getExtension('WEBGL_debug_renderer_info');
                    gl = c && ext ? { vendor: c.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: c.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : 'няма WebGL';
                } catch (e) { gl = 'грешка'; }
                return {
                    webdriver: navigator.webdriver,
                    userAgent: navigator.userAgent,
                    languages: navigator.languages,
                    plugins: navigator.plugins.length,
                    chromeObject: !!window.chrome,
                    hardwareConcurrency: navigator.hardwareConcurrency,
                    touchPoints: navigator.maxTouchPoints,
                    screen: screen.width + 'x' + screen.height,
                    webgl: gl,
                };
            }).catch(() => null);
        }

        const clickables = opts.debug ? await listClickables(page) : null;
        const texts = await frameTexts(page);
        const title = await page.title().catch(() => '');
        const joined = texts.map((t) => t.text).join(' | ');
        const png = opts.screenshot ? await page.screenshot({ type: 'png' }).catch(() => null) : null;

        // Проверяваме намерените потоци (до 3, наведнъж)
        const order = { hls: 0, dash: 1, file: 2 };
        const cands = found.slice().sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 3);
        const checks = await Promise.all(cands.map((c) => validateCandidate(context, c)));
        const validated = cands.map((c, i) => ({ ...c, ...checks[i] }));
        const best = validated.filter((v) => v.valid).sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || null;

        // ------------------------------------------------ присъда
        const playing = bestTime >= 3;
        let status, reason;
        if (CF_RE.test(title + ' ' + joined.slice(0, 600)) && !found.length) {
            status = 'blocked'; reason = 'Cloudflare или друга защита блокира браузъра.';
        } else if (best) {
            const dOk = durationOk(best.duration || playedDuration, opts.runtime);
            if (dOk === false) {
                status = 'suspect';
                reason = 'Има видео, но дължината (' + fmtDur(best.duration || playedDuration) + ') не отговаря на филма (' + opts.runtime + ' мин.): трейлър или реклама.';
                const bad = validated.filter((v) => !v.valid && v.why).map((v) => v.why);
                if (bad.length) reason += ' Другите потоци не издържат проверка: ' + bad.join('; ');
            } else if (playing) {
                status = 'playing'; reason = 'Видеото върви (' + bestTime.toFixed(1) + ' сек. възпроизведени).';
            } else {
                status = 'stream_ok';
                reason = 'Потокът е валиден (манифест и първи сегмент са истински видео данни), но браузърът не го пусна' +
                         (canDecode && canDecode.h264 === 'no' ? ' (този браузър не може да декодира H.264).' : '.');
            }
        } else if (playing) {
            const dOk = durationOk(playedDuration, opts.runtime);
            status = dOk === false ? 'suspect' : 'playing';
            reason = dOk === false ? 'Върви видео, но с грешна дължина (трейлър/реклама).' : 'Видеото върви (' + bestTime.toFixed(1) + ' сек.).';
        } else if (validated.length) {
            status = 'suspect';
            reason = 'Намерен е адрес на поток, но не издържа проверка: ' + validated.map((v) => v.why).filter(Boolean).join('; ');
        } else if (joined.length < 1500 && ERROR_RE.test(joined)) {
            status = 'no_source'; reason = 'Плейърът показва, че няма източник: "' + joined.slice(0, 120) + '"';
        } else if (!joined || LOADING_RE.test(joined)) {
            status = 'stuck';
            reason = 'Плейърът остана на "зареждане" до края на изчакването. Не се знае дали няма източник, или е блокиран.';
        } else {
            status = 'no_source'; reason = 'Не е намерен нито един видео поток.';
        }
        if (navError && status !== 'playing' && status !== 'stream_ok') reason = 'Страницата не се зареди докрай (' + navError + '). ' + reason;

        const result = {
            success: true,
            url,
            status,
            ok: status === 'playing' || status === 'stream_ok',
            reason,
            title,
            // старите полета, за да не се чупи кодът, който вече ползва сървъра
            hasM3u8: found.some((f) => f.kind === 'hls'),
            hlsUrl: (found.find((f) => f.kind === 'hls') || {}).url || null,
            hasError: ERROR_RE.test(joined),
            snippet: joined.slice(0, 200),
            // новите
            stream: best ? {
                kind: best.kind, url: best.url, durationSec: best.duration || null, segments: best.segments || null,
                encrypted: !!best.encrypted, segmentKind: best.segmentKind || null,
            } : null,
            playback: { seconds: Number(bestTime.toFixed(1)), durationSec: playedDuration ? Math.round(playedDuration) : null, videos: videos.slice(0, 3) },
            canDecode,
            frames: texts.slice(0, 5),
            candidates: validated.map((v) => ({ kind: v.kind, url: v.url.slice(0, 200), valid: v.valid, why: v.why || null })),
            elapsedMs: Date.now() - t0,
        };
        if (opts.debug) result.debug = { netLog, failed, consoleErrors, allRequests: allReq, websockets: sockets, env, clickLog, popupsClosed, clickables };
        if (png) Object.defineProperty(result, '_png', { value: png, enumerable: false });
        return result;
    } finally {
        clearTimeout(killer);
        await context.close().catch(() => {});
    }
}

// ---------------------------------------------------------------- маршрути
function parseOpts(q) {
    return {
        wait: Math.min(60, Math.max(5, parseInt(q.wait || '30', 10) || 30)),
        runtime: parseFloat(q.runtime || '') || null,
        debug: q.debug === '1',
    };
}

app.get('/health', (_req, res) => res.json({ ok: true, active, queued: waiters.length }));

app.get('/check', auth, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, error: 'Липсва URL' });
    try {
        res.json(await runLimited(() => analyze(String(url), parseOpts(req.query))));
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/screenshot', auth, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, error: 'Липсва URL' });
    try {
        const out = await runLimited(() => analyze(String(url), { ...parseOpts(req.query), screenshot: true }));
        if (!out._png) return res.json(out);
        res.set('Content-Type', 'image/png');
        res.set('X-Radar-Status', out.status);
        res.send(out._png);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('SIGTERM', async () => {
    try { if (browserPromise) await (await browserPromise).close(); } catch { /* ignore */ }
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('Radar сървърът работи на порт ' + PORT + (API_KEY ? '' : '  (ВНИМАНИЕ: няма API_KEY, всички заявки ще бъдат отказани)'));
});
