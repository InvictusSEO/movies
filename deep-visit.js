// deep-visit.js — FSS Deep Visit Worker (Advanced Hybrid Edition with DGA & Safe Bounds)
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
const SOCIAL_RE = /facebook\.com|twitter\.com|x\.com|instagram\.com|t\.me|telegram\.me|whatsapp\.com|reddit\.com|pinterest\.com|mailto:|javascript:/i;

// Известни легитимни CDN/услуги, които да изключим от подозрителните DGA домейни
const LEGIT_CDNS = [
    'cloudflare.com', 'jsdelivr.net', 'googletagmanager.com', 'google-analytics.com',
    'gstatic.com', 'bootstrapcdn.com', 'jquery.com', 'sharethis.com', 'whatsapp.net'
];

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
                '--disable-features=IsolateOrigins,site-per-process',
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

function getRootDomain(hostname) {
    const parts = hostname.toLowerCase().split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname.toLowerCase();
}

function isLegitCdn(hostname) {
    const h = hostname.toLowerCase();
    return LEGIT_CDNS.some((c) => h === c || h.endsWith('.' + c));
}

function adDomainMatch(urlStr) {
    try {
        const u = new URL(urlStr);
        const h = u.hostname.toLowerCase();
        
        // 1. Проверка в познатия масив
        for (const ad of AD_DOMAINS) {
            if (h === ad || h.endsWith('.' + ad)) return ad;
        }

        // 2. Детекция на динамични/генерирани домейни (DGA) за реклами/попъндъри
        // Характерно за стрийминг сайтовете е да ползват поддомейни от тип случайни думи (напр. fo.ochringptolemy.com)
        if (!isLegitCdn(h)) {
            const parts = h.split('.');
            if (parts.length >= 3) {
                const sub = parts[0];
                // Ако поддомейнът е с дължина над 6 символа и изглежда като случаен сбор от букви (без типични думи като www, api, static)
                if (sub.length >= 6 && !/^(www|api|cdn|static|assets|img|video|stream|player|embed)$/.test(sub)) {
                    return h; // Връщаме го като засечен съмнителен домен
                }
            }
        }
    } catch { /* ignore */ }
    return null;
}

async function analyze(rawUrl, opts) {
    const t0 = Date.now();
    const parsedStart = await assertSafeUrl(rawUrl);
    const url = parsedStart.href;
    const startHost = parsedStart.hostname.toLowerCase();
    const startRoot = getRootDomain(startHost);
    const browser = await getBrowser();

    const isMobile = opts.mobile;
    const context = await browser.newContext({
        userAgent: isMobile
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            : UA,
        viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
        locale: 'en-US',
        ignoreHTTPSErrors: true,
        isMobile,
        hasTouch: isMobile,
        deviceScaleFactor: isMobile ? 3 : 1,
    });

    const killer = setTimeout(() => context.close().catch(() => {}), 90000);

    let popups = 0;
    const hijacks = [];
    const hijackUrls = [];
    const popupUrls = [];
    const interceptedOpens = [];
    const redirectChains = [];
    const externalScripts = new Set();
    const adDomainHits = {};
    const clickLog = [];
    let page;

    try {
        page = await context.newPage();

        await page.addInitScript(() => {
            window.__fssIntercepted = [];

            const record = (type, targetUrl) => {
                if (!targetUrl || typeof targetUrl !== 'string') return;
                if (targetUrl.startsWith('about:') || targetUrl.startsWith('javascript:')) return;
                window.__fssIntercepted.push({
                    type,
                    url: targetUrl.slice(0, 300),
                    ts: Date.now(),
                });
            };

            const origOpen = window.open;
            window.open = function (u) {
                record('window.open', u);
                return origOpen ? origOpen.apply(this, arguments) : null;
            };

            const origAnchorClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                if (this.href && (this.target === '_blank' || this.hostname !== location.hostname)) {
                    record('synthetic_a_click', this.href);
                }
                return origAnchorClick.apply(this, arguments);
            };

            try {
                const origAssign = window.location.assign.bind(window.location);
                window.location.assign = function (u) { record('location.assign', u); return origAssign(u); };
                const origReplace = window.location.replace.bind(window.location);
                window.location.replace = function (u) { record('location.replace', u); return origReplace(u); };
            } catch (_) {}
        });

        context.on('page', async (p) => {
            if (p === page) return;
            try {
                await p.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
                const pu = p.url();
                if (pu && pu !== 'about:blank' && !SOCIAL_RE.test(pu)) {
                    popups++;
                    popupUrls.push(pu.slice(0, 200));
                    const ad = adDomainMatch(pu);
                    if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
                }
            } catch { /* ignore */ }
            await p.close().catch(() => {});
        });

        context.on('request', (req) => {
            const reqUrl = req.url();
            const ad = adDomainMatch(reqUrl);
            if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;

            try {
                const u = new URL(reqUrl);
                const reqRoot = getRootDomain(u.hostname);
                if (reqRoot !== startRoot && !SOCIAL_RE.test(reqUrl)) {
                    const rType = req.resourceType();
                    if (rType === 'script' || rType === 'document' || rType === 'subdocument') {
                        externalScripts.add(u.hostname.toLowerCase());
                    }
                }
            } catch { /* ignore */ }
        });

        context.on('response', (res) => {
            const status = res.status();
            if (status >= 300 && status < 400) {
                const loc = res.headers()['location'];
                if (loc) {
                    try {
                        const target = new URL(loc, res.url());
                        const targetRoot = getRootDomain(target.hostname);
                        if (targetRoot !== startRoot && !SOCIAL_RE.test(target.href)) {
                            redirectChains.push({
                                from: res.url().slice(0, 120),
                                to: target.href.slice(0, 200),
                                status,
                            });
                            const ad = adDomainMatch(target.href);
                            if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
                        }
                    } catch { /* ignore */ }
                }
            }
        });

        let guardOn = false;
        page.on('framenavigated', (fr) => {
            if (!guardOn || fr !== page.mainFrame()) return;
            try {
                const u = new URL(fr.url());
                const h = u.hostname.toLowerCase();
                if (h && getRootDomain(h) !== startRoot && !SOCIAL_RE.test(fr.url())) {
                    hijackUrls.push(fr.url().slice(0, 200));
                    hijacks.push(fr.url().slice(0, 120));
                    page.goBack({ timeout: 3000 }).catch(() => {});
                }
            } catch { /* ignore */ }
        });

        let navError = null;
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
        } catch {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            } catch (err) {
                navError = err.message.split('\n')[0];
            }
        }
        guardOn = true;

        await page.waitForTimeout(3500);

        const title = await page.title().catch(() => '');
        const bodySnip = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 800)).catch(() => '');
        const isCfChallenge = CF_RE.test(title + ' ' + bodySnip);

        let techStack = 'unknown';
        let hasVideo = false, hasIframe = false, hasM3u8 = false;
        let suspiciousOverlays = 0;

        try {
            const info = await page.evaluate(() => {
                const html = document.documentElement.outerHTML.slice(0, 250000);
                const isNextOrReact = Boolean(
                    document.getElementById('__next') ||
                    document.getElementById('root') ||
                    window.__NEXT_DATA__ ||
                    document.querySelector('[data-reactroot]')
                );

                let overlays = 0;
                const allEls = document.querySelectorAll('div, a, iframe');
                for (const el of allEls) {
                    const style = window.getComputedStyle(el);
                    const z = parseInt(style.zIndex, 10) || 0;
                    if ((style.position === 'fixed' || style.position === 'absolute') && z > 999) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 300 && rect.height > 250) {
                            overlays++;
                        }
                    }
                }

                return {
                    isNextOrReact,
                    overlays,
                    v: document.querySelectorAll('video').length,
                    i: document.querySelectorAll('iframe').length,
                    h: html,
                };
            });

            techStack = info.isNextOrReact ? 'spa_react_next' : 'classic_ssr_php';
            suspiciousOverlays = info.overlays;
            hasVideo = info.v > 0;
            hasIframe = info.i > 0;
            hasM3u8 = /\.m3u8|\.mpd/.test(info.h);
        } catch { /* ignore */ }

        const clicks = Math.min(10, Math.max(1, opts.clicks));
        const waitMs = Math.max(1000, opts.waitMs);
        const vp = page.viewportSize() || { width: 1280, height: 720 };

        for (let i = 0; i < clicks; i++) {
            const before = popups + hijacks.length;

            try {
                if (i === 0) {
                    const cx = vp.width / 2 + (Math.random() * 30 - 15);
                    const cy = vp.height / 2 + (Math.random() * 30 - 15);
                    await page.mouse.move(cx, cy, { steps: 6 });
                    await page.mouse.down();
                    await page.waitForTimeout(60);
                    await page.mouse.up();
                    clickLog.push({ n: i + 1, type: 'center_overlay_probe', x: Math.round(cx), y: Math.round(cy), events: (popups + hijacks.length) - before });
                } else if (i === 1 && techStack === 'classic_ssr_php') {
                    const internalLink = await page.evaluate((host) => {
                        const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
                            try {
                                const u = new URL(a.href);
                                const r = a.getBoundingClientRect();
                                return u.hostname === host && u.pathname.length > 2 && r.width > 20 && r.height > 15 && r.left > 0 && r.top > 80 && r.top < window.innerHeight;
                            } catch { return false; }
                        });
                        if (!links.length) return null;
                        const pick = links[Math.floor(Math.random() * Math.min(links.length, 10))];
                        const r = pick.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    }, startHost);

                    if (internalLink && internalLink.x > 0) {
                        await page.mouse.move(internalLink.x, internalLink.y, { steps: 6 });
                        await page.mouse.click(internalLink.x, internalLink.y);
                        clickLog.push({ n: i + 1, type: 'php_internal_nav', x: Math.round(internalLink.x), y: Math.round(internalLink.y), events: (popups + hijacks.length) - before });
                    }
                } else {
                    const safeTarget = await page.evaluate(() => {
                        const social = /facebook|twitter|x\.com|instagram|telegram|whatsapp|reddit|share|intent/i;
                        const els = Array.from(document.querySelectorAll('a, button, [role="button"], .play, [class*="play"], [class*="poster"], [class*="card"]')).filter((el) => {
                            const href = el.getAttribute('href') || '';
                            const cls = String(el.className || '');
                            if (social.test(href) || social.test(cls)) return false;
                            const r = el.getBoundingClientRect();
                            return r.left >= 0 && r.width > 25 && r.height > 20 && r.top >= 60 && r.bottom <= window.innerHeight - 40;
                        });
                        if (!els.length) return null;
                        const el = els[Math.floor(Math.random() * Math.min(els.length, 12))];
                        const r = el.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    });

                    if (safeTarget && safeTarget.x > 0) {
                        await page.mouse.move(safeTarget.x, safeTarget.y, { steps: 6 });
                        await page.mouse.click(safeTarget.x, safeTarget.y);
                        clickLog.push({ n: i + 1, type: 'filtered_element', x: Math.round(safeTarget.x), y: Math.round(safeTarget.y), events: (popups + hijacks.length) - before });
                    } else {
                        // Строго гарантираме x > 0 (вътре в екрана)
                        const x = Math.floor(Math.random() * (vp.width * 0.5)) + (vp.width * 0.25);
                        const y = Math.floor(Math.random() * (vp.height * 0.5)) + (vp.height * 0.25);
                        await page.mouse.move(x, y, { steps: 6 });
                        await page.mouse.click(x, y);
                        clickLog.push({ n: i + 1, type: 'safe_zone_coord', x: Math.round(x), y: Math.round(y), events: (popups + hijacks.length) - before });
                    }
                }
            } catch { /* ignore */ }

            await page.waitForTimeout(waitMs);
        }

        await page.waitForTimeout(1500);

        try {
            const rawIntercepted = await page.evaluate(() => window.__fssIntercepted || []);
            for (const item of rawIntercepted) {
                if (!SOCIAL_RE.test(item.url)) {
                    interceptedOpens.push(item);
                    const ad = adDomainMatch(item.url);
                    if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
                }
            }
        } catch { /* ignore */ }

        const totalAdHits = Object.values(adDomainHits).reduce((a, b) => a + b, 0);
        const uniqueJsOpens = new Set(interceptedOpens.map((x) => x.url)).size;
        const uniqueRedirects = new Set(redirectChains.map((x) => x.to)).size;

        const score =
            (hijacks.length * 10) +
            (popups * 5) +
            (uniqueJsOpens * 4) +
            (uniqueRedirects * 3) +
            (suspiciousOverlays * 2) +
            totalAdHits;

        let level = 'none';
        if (score >= 30) level = 'high';
        else if (score >= 10) level = 'medium';
        else if (score >= 1) level = 'low';

        return {
            success: true,
            url,
            detected_stack: techStack,
            status: isCfChallenge ? 'blocked' : (navError ? 'error' : 'loaded'),
            nav_error: navError,
            title,
            cf_challenge: isCfChallenge,
            elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
            has_video: hasVideo,
            has_iframe: hasIframe,
            has_m3u8_in_html: hasM3u8,
            suspicious_overlays: suspiciousOverlays,
            clicks,
            click_log: clickLog,
            popups,
            hijacks: hijacks.length,
            js_runtime_hooks_triggered: uniqueJsOpens,
            network_redirects_triggered: uniqueRedirects,
            ad_domain_hits: totalAdHits,
            ad_domains: Object.keys(adDomainHits),
            ad_domain_breakdown: adDomainHits,
            external_script_hosts: Array.from(externalScripts).slice(0, 25),
            bad_events: hijacks.length + popups + uniqueJsOpens,
            ad_score: score,
            ad_level: level,
            evidence: {
                popup_urls: popupUrls.slice(0, 10),
                hijack_urls: hijackUrls.slice(0, 10),
                js_intercepted: interceptedOpens.slice(0, 10),
                redirect_chains: redirectChains.slice(0, 10),
            },
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
    const waitSec = Math.min(10, Math.max(1, parseFloat(req.query.wait || '2.5') || 2.5));
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
