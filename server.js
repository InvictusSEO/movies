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
        // 1. Стартираме с флагове за прикриване на бота
        browser = await chromium.launch({ 
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const page = await browser.newPage();
        
        let hlsUrl = null;

        // 2. Следим мрежовите заявки
        page.on('response', (response) => {
            const respUrl = response.url();
            if ((respUrl.includes('.m3u8') || respUrl.includes('/proxy/')) && !hlsUrl) {
                hlsUrl = respUrl;
            }
        });

        // 3. Отваряме сайта
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // 4. Изчакваме 4 секунди, за да се зареди интерфейса
        await page.waitForTimeout(4000);

        // 5. Опитваме да намерим и кликнем върху бутона за стартиране на сървъра
        try {
            const playButton = await page.$('button:has-text("Play"), button:has-text("Server"), [class*="play"]');
            if (playButton) {
                await playButton.click();
                console.log('✅ Кликнахме върху бутона за стартиране на сървъра');
            }
        } catch (e) {
            console.log('⚠️ Не намерихме бутон за кликване, продължаваме да чакаме...');
        }

        // 6. Изчакваме до 15 секунди за видеото
        const startTime = Date.now();
        while (!hlsUrl && (Date.now() - startTime) < 15000) {
            await page.waitForTimeout(1000);
        }

        // 7. Извличаме заглавието и текста
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body.innerText);
        
        const hasError = bodyText.toLowerCase().includes('not found') || 
                        bodyText.toLowerCase().includes('not available');

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
