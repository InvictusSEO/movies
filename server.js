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

        // 1. Следим ВСИЧКИ мрежови отговори (включително от iframe)
        page.on('response', (response) => {
            const respUrl = response.url();
            if (respUrl.includes('.m3u8') && !hlsUrl) {
                hlsUrl = respUrl;
                console.log('🎯 Открит HLS линк:', hlsUrl);
            }
        });

        // 2. Отваряме сайта
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 3. Изчакваме до 22 секунди за видеото (според документацията на VidCore)
        const startTime = Date.now();
        while (!hlsUrl && (Date.now() - startTime) < 22000) {
            await page.waitForTimeout(1000);
        }

        // 4. Извличаме заглавието и текста
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText);
        
        // 5. Проверяваме за съобщение за грешка (фалшив ID)
        const hasError = bodyText.toLowerCase().includes('not found') || 
                        bodyText.toLowerCase().includes('not available') ||
                        bodyText.toLowerCase().includes('no streams are available');

        await browser.close();

        res.json({
            success: true,
            url: url,
            title: title,
            hasM3u8: !!hlsUrl,
            hlsUrl: hlsUrl,
            hasError: hasError,
            snippet: bodyText.substring(0, 200)
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
