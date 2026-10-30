const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Активираме Stealth режима (прави браузъра невидим за Cloudflare)
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
        
        // 1. Отваряме сайта и чакаме мрежата да утихне
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        
        // 2. ДОБАВЕНО: Изчакваме допълнително 5 секунди за динамично съдържание
        await page.waitForTimeout(5000);
        
        // 3. Извличаме заглавието и текста
        const title = await page.title();
        let bodyText = await page.evaluate(() => document.body.innerText);
        
        // 4. ДОБАВЕНО: Ако все още пише "FETCHING", изчакваме още малко
        if (bodyText.includes('FETCHING YOUR CONTENT')) {
            await page.waitForTimeout(3000);
            bodyText = await page.evaluate(() => document.body.innerText);
        }

        const hasM3u8 = bodyText.includes('.m3u8') || (await page.content()).includes('.m3u8');
        const hasError = bodyText.toLowerCase().includes('not found') || bodyText.toLowerCase().includes('not available');

        await browser.close();

        res.json({
            success: true,
            url: url,
            title: title,
            hasM3u8: hasM3u8,
            hasError: hasError,
            snippet: bodyText.substring(0, 200) // Показваме първите 200 символа
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
