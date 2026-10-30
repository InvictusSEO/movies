const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const app = express();
app.use(express.json());

app.get('/check', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Липсва URL' });

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        let hlsUrl = null;

        // 1. Прихващаме ВСИЧКИ мрежови заявки
        await page.route('**/*', (route) => {
            const reqUrl = route.request().url();
            if (reqUrl.includes('.m3u8')) {
                hlsUrl = reqUrl;
                console.log('🎯 Открит HLS линк:', hlsUrl);
            }
            route.continue();
        });

        // 2. Отваряме сайта
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 3. Изчакваме 7 секунди за видеото
        await page.waitForTimeout(7000);

        // 4. Ако все още нямаме HLS, изчакваме още малко
        if (!hlsUrl) {
            await page.waitForResponse((resp) => resp.url().includes('.m3u8'), { timeout: 5000 }).catch(() => {});
        }

        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText);
        const hasError = bodyText.toLowerCase().includes('not found') || bodyText.toLowerCase().includes('not available');

        await browser.close();

        res.json({
            success: true,
            url: url,
            title: title,
            hasM3u8: !!hlsUrl, // true ако сме намерили .m3u8
            hlsUrl: hlsUrl,
            hasError: hasError,
            snippet: bodyText.substring(0, 150)
        });

    } catch (error) {
        if (browser) await browser.close();
        res.json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Radar сървърът работи на порт ${PORT}`);
});
