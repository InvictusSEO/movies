// deep-visit.js — FSS Deep Visit Worker (Bulletproof Edition)
const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const PORT = process.env.DEEP_VISIT_PORT || 3001;
const API_KEY = process.env.DEEP_VISIT_KEY || '';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.DEEP_VISIT_MAX_CONCURRENT || '2', 10));
const UA = process.env.DEEP_VISIT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const AD_DOMAINS = [
    'doubleclick.net','googlesyndication.com','googleadservices.com','adservice.google.com',
    'popads.net','popcash.net','propellerads.com','propellerpops.com','onclickalgo.com',
    'onclickmax.com','onclckds.com','onclckpro.com','profitablecpmrate.com','adsterra.com',
    'exoclick.com','exosrv.com','juicyads.com','trafficjunky.com','clickadu.com','adcash.com',
    'mgid.com','revcontent.com','taboola.com','outbrain.com','adnxs.com','rubiconproject.com',
    'pubmatic.com','openx.net','criteo.com','zedo.com','adroll.com','bidvertiser.com',
    'adf.ly','shorte.st','linkvertise.com','monetag.com','ad-maven.com','adnium.com',
    'exdynsrv.com','tsyndicate.com','a-ads.com','cointraffic.io','trafmag.com','kadam.net',
    'richads.com','adkernel.com','hilltopads.net','adpushup.com','ezoic.com','mediavine.com',
    'onesignal.com','pushwoosh.com','pushcrew.com','izooto.com','cleverpush.com',
    'betweendigital.com','adhigh.net','adhood.com','admedo.com','adnami.io','adnuntius.com',
    'adotmob.com','adpone.com','adsafeprotected.com','adsrvr.org','adtelligent.com',
    'adthrive.com','adtrue.com','aduptech.com','adverline.com','advertserve.com',
    'adyoulike.com','aniview.com','bidswitch.net','bluekai.com','casalemedia.com',
    'contextweb.com','crwdcntrl.net','demdex.net','dotomi.com','emxdgt.com','exelator.com',
    'eyeota.net','gumgum.com','improvedigital.com','indexww.com','inmobi.com','innity.com',
    'innovid.com','intellitxt.com','intergient.com','krxd.net','lijit.com','loopme.com',
    'mathtag.com','media.net','mediamath.com','mookie1.com','nativo.com','nexage.com',
    'nrich.ai','omnitagjs.com','onetag.com','outbrain.com','pagefair.com','perfectaudience.com',
    'pippio.com','plista.com','powerlinks.com','pubmatic.com','pulsepoint.com','quantcast.com',
    'quantserve.com','revcontent.com','richaudience.com','rlcdn.com','rtbhouse.com',
    'rubiconproject.com','sape.ru','sekindo.com','serving-sys.com','sharethrough.com',
    'simpli.fi','sitescout.com','smaato.com','smartadserver.com','sonobi.com','sovrn.com',
    'spotxchange.com','springserve.com','stackadapt.com','stickyadstv.com','supersonicads.com',
    'taboola.com','tapad.com','teads.tv','tremorhub.com','tribalfusion.com','triplelift.com',
    'tritondigital.com','turn.com','undertone.com','unrulymedia.com','vidoomy.com','vidora.com',
    'vidspring.com','viralize.com','vi-serve.com','vungle.com','yieldbot.com','yieldlab.net',
    'yieldmo.com','yieldoptimizer.com','zemanta.com','zeotap.com','zergnet.com','zorosrv.com',
];

const CF_RE = /just a moment|verifying you are human|verify you are human|checking your browser|attention required/i;

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function auth(req, res, next) {
    if (!API_KEY) return res.status(503).json({ success: false, error: 'No DEEP_VISIT_KEY configured' });
    const given = req.get('x-api-key') || req.query.key || '';
    if (!safeEqual(given, API_KEY)) return res.status(401).json({ success: false, error: 'Invalid key' });
    next();
}

let browserPromise = null;
function getBrowser() {
    if (!browserPromise) {
        browserPromise = chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
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
    await new Promise((r) => waiters.push(r));
}
function release() {
    const n = waiters.shift();
    if (n) n(); else active--;
}
async function runLimited(fn) {
    await acquire();
    try { return await fn(); } finally { release(); }
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

async function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Address not allowed');
    return u;
}

function adDomainMatch(urlStr) {
    try {
        const h = new URL(urlStr).hostname.toLowerCase();
        for (const ad of AD_DOMAINS) {
            if (h === ad || h.endsWith('.' + ad)) return ad;
        }
    } catch { /* ignore */ }
    return null;
}

async function analyze(rawUrl, opts) {
    const t0 = Date.now();
    const url = (await assertSafeUrl(rawUrl)).href;
    const browser = await getBrowser();

    const isMobile = opts.mobile;
    const context = await browser.newContext({
        userAgent: isMobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' : UA,
        viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
        locale: 'en-US',
        ignoreHTTPSErrors: true,
        isMobile: isMobile,
        hasTouch: isMobile,
        deviceScaleFactor: isMobile ? 3 : 1
    });

    const killer = setTimeout(() => context.close().catch(() => {}), 90000);

    let popups = 0;
    const hijacks = [];
    const hijackUrls = [];
    const popupUrls = [];
    const adDomainHits = {};
    const clickLog = [];
    let page;

    try {
        page = await context.newPage();

        // Подобрено хващане на нови изскачащи прозорци / тагове
        context.on('page', async (p) => {
            if (p === page) return;
            popups++;
            try {
                await p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
                const pu = p.url();
                if (pu && pu !== 'about:blank') {
                    popupUrls.push(pu.slice(0, 200));
                    const ad = adDomainMatch(pu);
                    if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
                }
            } catch { /* ignore */ }
            await p.close().catch(() => {});
        });

        // НЕ спираме изображенията и шрифтовете, за да не чупим рекламните скриптове!
        // Премахнат е агресивният route.abort() за картинки.

        context.on('request', (r) => {
            const ad = adDomainMatch(r.url());
            if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
        });

        let guardOn = false;
        const startHost = new URL(url).hostname;
        page.on('framenavigated', (fr) => {
            if (!guardOn || fr !== page.mainFrame()) return;
            try {
                const h = new URL(fr.url()).hostname;
                if (h && h !== startHost) {
                    hijackUrls.push(fr.url().slice(0, 200));
                    hijacks.push(fr.url().slice(0, 120));
                    page.goBack({ timeout: 3000 }).catch(() => {});
                }
            } catch { /* ignore */ }
        });

        let navError = null;
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
        } catch (e) {
            // Fallback ако networkidle се забави прекалено много
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            } catch (err) {
                navError = err.message.split('\n')[0];
            }
        }
        guardOn = true;

        // Изчакваме допълнително време за латентни (lazy-loaded) реклами
        await page.waitForTimeout(4000);

        const title = await page.title().catch(() => '');
        const bodySnip = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 800)).catch(() => '');
        const isCfChallenge = CF_RE.test(title + ' ' + bodySnip);

        let hasVideo = false, hasIframe = false, hasM3u8 = false;
        try {
            const info = await page.evaluate(() => ({
                v: document.querySelectorAll('video').length,
                i: document.querySelectorAll('iframe').length,
                h: document.documentElement.outerHTML.slice(0, 200000),
            }));
            hasVideo = info.v > 0;
            hasIframe = info.i > 0;
            hasM3u8 = /\.m3u8|\.mpd/.test(info.h);
        } catch { /* ignore */ }

        const clicks = Math.min(10, Math.max(1, opts.clicks));
        const waitMs = Math.max(1000, opts.waitMs);

        // Интелигентно кликане: Опитваме се да намерим реални линкове или бутони, за да предизвикаме попъндър
        for (let i = 0; i < clicks; i++) {
            const before = popups + hijacks.length;
            let clickedOnElement = false;

            try {
                // Взимаме списък с линкове или бутони видими на екрана
                const interactiveSelectors = 'a, button, input[type="submit"], [role="button"]';
                const elements = await page.$$(interactiveSelectors);
                
                if (elements && elements.length > 0) {
                    // Избираме произволен интерактивен елемент
                    const randomEl = elements[Math.floor(Math.random() * elements.length)];
                    const box = await randomEl.boundingBox();
                    
                    if (box && box.width > 0 && box.height > 0) {
                        const x = box.x + box.width / 2;
                        const y = box.y + box.height / 2;
                        
                        await page.mouse.move(x, y, { steps: 5 });
                        await page.mouse.click(x, y);
                        clickedOnElement = true;
                        clickLog.push({ n: i + 1, type: 'element', x: Math.round(x), y: Math.round(y), events: (popups + hijacks.length) - before });
                    }
                }
            } catch { /* fallback ако селекторите гръмнат */ }

            // Ако няма намерени елементи или стане грешка, кликаме на безопасна позиция с движение на мишката
            if (!clickedOnElement) {
                const vp = page.viewportSize() || { width: 1280, height: 720 };
                const x = Math.floor(Math.random() * (vp.width - 200)) + 100;
                const y = Math.floor(Math.random() * (vp.height - 200)) + 100;
                
                try {
                    await page.mouse.move(x, y, { steps: 5 });
                    await page.mouse.click(x, y);
                } catch { /* ignore */ }
                clickLog.push({ n: i + 1, type: 'fallback_coord', x, y, events: (popups + hijacks.length) - before });
            }

            await page.waitForTimeout(waitMs);
        }

        await page.waitForTimeout(2000);

        const totalAdHits = Object.values(adDomainHits).reduce((a, b) => a + b, 0);
        const score = (hijacks.length * 10) + (popups * 5) + totalAdHits;

        let level = 'none';
        if (score >= 30) level = 'high';
        else if (score >= 10) level = 'medium';
        else if (score >= 1) level = 'low';

        return {
            success: true,
            url,
            status: isCfChallenge ? 'blocked' : (navError ? 'error' : 'loaded'),
            nav_error: navError,
            title,
            cf_challenge: isCfChallenge,
            elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
            has_video: hasVideo,
            has_iframe: hasIframe,
            has_m3u8_in_html: hasM3u8,
            clicks: clicks,
            click_log: clickLog,
            popups,
            hijacks: hijacks.length,
            ad_domain_hits: totalAdHits,
            ad_domains: Object.keys(adDomainHits),
            ad_domain_breakdown: adDomainHits,
            bad_events: hijacks.length + popups,
            ad_score: score,
            ad_level: level,
            evidence: { popup_urls: popupUrls.slice(0, 10), hijack_urls: hijackUrls.slice(0, 10) },
        };
    } catch (e) {
        return { success: false, error: e.message.split('\n')[0], elapsed_sec: Math.round((Date.now() - t0) / 100) / 10 };
    } finally {
        clearTimeout(killer);
        await context.close().catch(() => {});
    }
}

const app = express();

app.get('/health', (_req, res) => res.json({ ok: true, service: 'deep-visit', active, queued: waiters.length }));

app.get('/deep-check', auth, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, error: 'Missing URL' });
    const clicks = Math.min(10, Math.max(1, parseInt(req.query.clicks || '5', 10) || 5));
    const waitSec = Math.min(10, Math.max(1, parseFloat(req.query.wait || '3') || 3));
    const mobile = req.query.mobile === '1';
    
    try {
        const result = await runLimited(() => analyze(String(url), { clicks, waitMs: Math.round(waitSec * 1000), mobile }));
        res.json(result);
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
    console.log(`[deep-visit] Running on port ${PORT} (max concurrent: ${MAX_CONCURRENT})` + (API_KEY ? '' : ' — WARNING: no key set'));
});
