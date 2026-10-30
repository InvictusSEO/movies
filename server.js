const express = require('express');
// Използваме playwright-extra вместо стандартния playwright
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
        // Стартираме скрития браузър
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        // Отваряме сайта
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        
        // Извличаме заглавието и текста
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText);
        
        // Проверяваме дали Cloudflare все още ни блокира
        const isCloudflare = title.includes('Attention Required') || bodyText.includes('you have been blocked');
        
        const hasM3u8 = bodyText.includes('.m3u8') || (await page.content()).includes('.m3u8');
        const hasError = bodyText.toLowerCase().includes('not found') || bodyText.toLowerCase().includes('not available');

        await browser.close();

        res.json({
            success: true,
            url: url,
            title: title,
            hasM3u8: hasM3u8,
            hasError: hasError,
            isCloudflare: isCloudflare,
            snippet: bodyText.substring(0, 150) // Показваме само първите 150 символа
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
