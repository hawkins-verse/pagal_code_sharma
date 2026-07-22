const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

let currentBaseUrl = "https://new1.movies4u.clinic";

function resolveUrl(base, relative) {
    try { return new URL(relative, base).href; } catch { return relative; }
}

app.post('/api/update-url', (req, res) => {
    let { newUrl } = req.body;
    if (newUrl) {
        if (newUrl.endsWith('/')) newUrl = newUrl.slice(0, -1);
        currentBaseUrl = newUrl;
        res.json({ success: true, currentBaseUrl });
    } else {
        res.json({ success: false });
    }
});

function checkAndUpdateDomain(responseUrl) {
    if (responseUrl) {
        const finalOrigin = new URL(responseUrl).origin;
        if (finalOrigin !== currentBaseUrl) {
            currentBaseUrl = finalOrigin;
        }
    }
}

app.get('/api/suggest', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);
    try {
        const searchUrl = `${currentBaseUrl}/?s=${encodeURIComponent(q)}`;
        const searchRes = await axios.get(searchUrl, { headers: HEADERS, timeout: 8000 });
        checkAndUpdateDomain(searchRes.request.res.responseUrl);
        const $ = cheerio.load(searchRes.data);
        let suggestions = [];
        $('article.post').each((i, el) => {
            if (i >= 6) return; 
            const titleEl = $(el).find('h3.entry-title a').first();
            const title = titleEl.text().trim();
            const link = titleEl.attr('href');
            let img = $(el).find('img').first().attr('src');
            if (title && link) suggestions.push({ title, link, img });
        });
        res.json(suggestions);
    } catch (e) { res.json([]); }
});

app.get('/api/search', async (req, res) => {
    const movieName = req.query.q;
    const movieUrlParam = req.query.url;

    try {
        let movieUrl = movieUrlParam;
        let titleText = req.query.title || movieName;

        if (!movieUrl) {
            if (!movieName) return res.status(400).json({ error: "Movie name required" });
            const searchUrl = `${currentBaseUrl}/?s=${encodeURIComponent(movieName)}`;
            const searchRes = await axios.get(searchUrl, { headers: HEADERS, timeout: 10000 });
            checkAndUpdateDomain(searchRes.request.res.responseUrl);

            const $ = cheerio.load(searchRes.data);
            const firstResult = $('article.post h3.entry-title a').first();
            if (firstResult.length === 0) return res.json({ error: "Movie not found" });
            
            movieUrl = firstResult.attr('href');
            titleText = firstResult.text().trim();
        }

        const detailsRes = await axios.get(movieUrl, { 
            headers: HEADERS, 
            timeout: 10000 
        });

        const $$ = cheerio.load(detailsRes.data);
        
        let qualities = new Set();
        let downloadLinks = [];
        let currentQuality = "Default Quality";

        $$('h2, h3, h4, h5, h6, p, div, span, strong, b, a').each((i, el) => {
            const tagName = el.tagName.toLowerCase();
            const text = $$(el).text().replace(/\s+/g, ' ').trim();

            if (tagName !== 'a') {
                // 🔥 FIXED: Ab exact pura naam pakdega, chahe wo Movie ho ya Web Series (Season/Episode)
                if (/(480p|720p|1080p|2160p|4k|Season|Episode|Pack|Complete)/i.test(text) && text.length > 3 && text.length < 150) {
                    if (!text.toLowerCase().includes('you may also like') && !text.toLowerCase().includes('related')) {
                        currentQuality = text.replace(/(Download|Links|Here|Now|-)/gi, '').trim();
                        qualities.add(currentQuality);
                    }
                }
            }

            if (tagName === 'a') {
                const href = $$(el).attr('href');
                if (!href || href.startsWith('#') || href.includes('tag=')) return;

                const hrefLower = href.toLowerCase();
                const className = ($$(el).attr('class') || '').toLowerCase();
                
                const isDownloadLink = 
                    hrefLower.includes('hubcloud') || hrefLower.includes('m4ulinks') || 
                    hrefLower.includes('vifix') || hrefLower.includes('gdflix') || 
                    className.includes('btn') || className.includes('button') || 
                    text.toLowerCase().includes('download links');

                const isTelegram =
                    hrefLower.includes('telegram') ||
                    hrefLower.includes('t.me') ||
                    hrefLower.includes('/tg/') ||
                    text.toLowerCase().includes('telegram') ||
                    text.toLowerCase().includes('download from telegram') ||
                    text.toLowerCase().includes('telegram group');

                if (isDownloadLink && !isTelegram) {
                    // 🔥 FIXED: Web series ke Episodes perfectly nikalenge ab
                    let epMatch = text.match(/(E\d+|Ep\s*\d+|Episode\s*\d+|Pack|Season\s*\d+)/i);
                    let episode = epMatch ? epMatch[0].toUpperCase() : 'Movie';

                    if (currentQuality === "Default Quality") {
                        qualities.add("All Available Links");
                        currentQuality = "All Available Links";
                    }

                    downloadLinks.push({ 
                        quality: currentQuality, // Exact bada wala naam (e.g., "720p HEVC [750MB]")
                        episode: episode, 
                        url: resolveUrl(movieUrl, href) 
                    });
                }
            }
        });

        res.json({ title: titleText, qualities: Array.from(qualities), links: downloadLinks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/extract', async (req, res) => {
    const { links } = req.body;
    let finalLinks = [];
    let seenGenerators = new Set();

    try {
        const interPromises = links.map(async (linkObj) => {
            try {
                let urlToFetch = linkObj.url;
                if (/^https:\/\/vifix\.site\/hubcloud\/([a-z0-9]+)$/i.test(urlToFetch)) {
                    urlToFetch = `https://hubcloud.one/drive/${urlToFetch.split("/").pop()}`;
                }

                const targetQualityText = (linkObj.quality || "").toLowerCase();

                const linkRes = await axios.get(urlToFetch, { headers: HEADERS, timeout: 12000 });
                const $ = cheerio.load(linkRes.data);
                let urls = [];

                $('a').each((i, el) => {
                    let href = $(el).attr('href');
                    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

                    let text = $(el).text().replace(/\s+/g, ' ').trim().toLowerCase();
                    
                    // 🔥 SMART MATCHING LOGIC 🔥
                    // Agar anchor tag par resolution likha hai (मतलब HubCloud ka Folder hai)
                    let linkHasRes = /(480p|720p|1080p|2160p|4k)/i.test(text);
                    
                    if (linkHasRes) {
                        let linkResMatch = text.match(/(480p|720p|1080p|2160p|4k)/i)[0];
                        if (linkResMatch === '4k') linkResMatch = '2160p';
                        
                        let targetResMatch = targetQualityText.match(/(480p|720p|1080p|2160p|4k)/i);
                        let targetRes = targetResMatch ? targetResMatch[0] : null;
                        if (targetRes === '4k') targetRes = '2160p';
                        
                        // 1. Resolution Check
                        if (targetRes && linkResMatch !== targetRes) return; 
                        
                        // 2. Extra Tags Check (HEVC, 10Bit, x264, HQ) -> Exact wahi uthayega jo select kiya hai
                        const tags = ['hevc', '10bit', 'hq', 'x264', 'x265', 'hdr'];
                        for (let tag of tags) {
                            let targetHasTag = targetQualityText.includes(tag);
                            let linkHasTag = text.includes(tag);
                            if (targetHasTag !== linkHasTag) return; // Mismatch hote hi Reject!
                        }
                    }
                    // Agar resolution NAHI likha hai (e.g. "Download FSL Server"), toh usko aane dega!

                    if (/^https:\/\/vifix\.site\/hubcloud\/([a-z0-9]+)$/i.test(href)) {
                        href = `https://hubcloud.one/drive/${href.split("/").pop()}`;
                    }
                    
                    const isValidHop = href.includes('hubcloud') || href.includes('gdflix') || 
                                       href.includes('gamerxyt') || href.includes('m4ulinks');
                                       
                    if (isValidHop) {
                        // episode aur quality directly user ke selection se aayegi, overwrite nahi hogi!
                        urls.push({ genUrl: href, episode: linkObj.episode, quality: linkObj.quality });
                    }
                });
                return urls;
            } catch (e) { return []; }
        });
        
        const allInterUrls = (await Promise.all(interPromises)).flat();

        const hubPromises = allInterUrls.map(async (item) => {
            try {
                const hubRes = await axios.get(item.genUrl, { headers: HEADERS, timeout: 10000 });
                const $ = cheerio.load(hubRes.data);
                let genUrls = [];
                
                const downloadBtn = $('#download').attr('href');
                if (downloadBtn) genUrls.push({ url: downloadBtn, episode: item.episode, quality: item.quality });
                
                $('a.btn, a').each((i, a) => {
                    const href = $(a).attr('href');
                    if (href && (href.includes('gamerxyt.com') || href.includes('hubcloud.php') || href.includes('fastdl'))) {
                        genUrls.push({ url: href, episode: item.episode, quality: item.quality });
                    }
                });
                return genUrls;
            } catch (e) { return []; }
        });
        
        let uniqueGenUrls = [];
        let seenGen = new Set();
        (await Promise.all(hubPromises)).flat().forEach(item => {
            if(!seenGen.has(item.url)){ seenGen.add(item.url); uniqueGenUrls.push(item); }
        });

        const genPromises = uniqueGenUrls.map(async (item) => {
            if (seenGenerators.has(item.url)) return [];
            seenGenerators.add(item.url);

            try {
                const genRes = await axios.get(item.url, {
                    headers: HEADERS,
                    timeout: 15000,
                    maxRedirects: 5
                });

                const pixelScriptMatch = genRes.data.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
                const jsPixelUrl = pixelScriptMatch ? pixelScriptMatch[1] : null;

                const $ = cheerio.load(genRes.data);
                let extracted = [];

                $('a').each((i, a) => {
                    let href = $(a).attr('href');
                    let text = $(a).text().trim() || "Download";
                    if (!href || !href.startsWith('http')) return;

                    const lowerText = text.toLowerCase();
                    const lowerHref = href.toLowerCase();

                    const blacklist = [
                        't.me', 'telegram', '/tg/', 'telegram.me', 'joinchat', 'whatsapp', 'discord'
                    ];

                    if (blacklist.some(term => lowerText.includes(term) || lowerHref.includes(term))) {
                        return;
                    }

                    const isDirectFile = /\.(zip|rar|7z|mkv|mp4|avi|mov|pdf|doc|docx)$/i.test(href);
                    const isCloudflare = lowerHref.includes("r2.dev") || lowerHref.includes("cloudflare") || lowerHref.includes("workers.dev");
                    const isDrive = lowerHref.includes("googleusercontent.com") || lowerHref.includes("drive.google.com");
                    const isExternal = lowerHref.includes("mediafire") || lowerHref.includes("mega.nz") || lowerHref.includes("dropbox");
                    const isPixel = lowerHref.includes("pixeldrain");
                    
                    const legacyIndicators = ['10gbps', 'zipdisk', 'ddl', 'fsl', 'fslv2', 'fsl 2', 'server', 'buzz'];
                    const hasLegacy = legacyIndicators.some(ind => lowerText.includes(ind) || lowerHref.includes(ind));
                    
                    if (isDirectFile || isCloudflare || isDrive || isExternal || isPixel || hasLegacy) {
                        let exactName = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
                        if(!exactName) exactName = "Direct File Server";

                        if (isPixel) {
                            if (jsPixelUrl) href = jsPixelUrl;
                            const id = href.match(/\/u\/([^/?#]+)/i)?.[1];
                            if (id) {
                                href = `https://pixeldrain.com/api/file/${id}`;
                                exactName = "PixelDrain (API Bypass)";
                            }
                        }

                        extracted.push({ server: exactName, url: href, episode: item.episode, quality: item.quality });
                    }
                });
                return extracted;
            } catch (e) { return []; }
        });

        let rawFinalLinks = (await Promise.all(genPromises)).flat();

        const doubleBypassPromises = rawFinalLinks.map(async (linkObj) => {
            if (linkObj.server.toLowerCase().includes('10gbps') || linkObj.url.toLowerCase().includes('10gbps')) {
                try {
                    const bypassRes = await axios.get(linkObj.url, { headers: HEADERS, timeout: 12000 });
                    const $bypass = cheerio.load(bypassRes.data);
                    let finalRealUrl = $bypass('a.btn, a.download-button').first().attr('href'); 
                    if(finalRealUrl) return { ...linkObj, url: finalRealUrl, server: linkObj.server + " (Unlocked)" };
                    return linkObj;
                } catch(e) { return linkObj; }
            }
            return linkObj;
        });

        rawFinalLinks = await Promise.all(doubleBypassPromises);

        // 🔥 Ek jaise duplicate servers hatane ke liye
        rawFinalLinks.forEach(f => {
            let isDuplicate = finalLinks.some(exist => 
                exist.url === f.url || 
                (exist.server === f.server && exist.episode === f.episode) 
            );

            if (!isDuplicate) {
                finalLinks.push(f);
            }
        });

        finalLinks.sort((a, b) => a.episode.localeCompare(b.episode));
    } catch (e) { console.error("Extraction error:", e.message); }

    res.json({ finalLinks });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at port ${PORT}`));
