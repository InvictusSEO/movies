const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

app.get('/check', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Липсва URL' });

    let browser;
    try {
        // Стартираме скрит браузър
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        
        // Отваряме сайта и изчакваме да се зареди мрежата
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
        
        // Извличаме заглавието и текста
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText);
        
        // Търсим индикатори за видео
        const hasM3u8 = bodyText.includes('.m3u8') || (await page.content()).includes('.m3u8');
        const hasError = bodyText.toLowerCase().includes('not found') || bodyText.toLowerCase().includes('not available');

        await browser.close();

        res.json({
            success: true,
            url: url,
            title: title,
            hasM3u8: hasM3u8,
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
