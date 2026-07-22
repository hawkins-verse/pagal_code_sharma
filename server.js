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

        const detailsRes = await axios.get(movieUrl, { headers: HEADERS, timeout: 10000 });
        const $$ = cheerio.load(detailsRes.data);
        
        let qualities = new Set();
        let downloadLinks = [];
        let currentQuality = "Default Quality";

        $$('h2, h3, h4, h5, h6, p, div, span, strong, b, a').each((i, el) => {
            const tagName = el.tagName.toLowerCase();
            const text = $$(el).text().replace(/\s+/g, ' ').trim();

            if (tagName !== 'a') {
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
                    hrefLower.includes('telegram') || hrefLower.includes('t.me') ||
                    hrefLower.includes('/tg/') || text.toLowerCase().includes('telegram') ||
                    text.toLowerCase().includes('download from telegram');

                if (isDownloadLink && !isTelegram) {
                    let epMatch = text.match(/(E\d+|Ep\s*\d+|Episode\s*\d+|Pack|Season\s*\d+)/i);
                    let episode = epMatch ? epMatch[0].toUpperCase() : 'Movie';

                    if (currentQuality === "Default Quality") {
                        qualities.add("All Available Links");
                        currentQuality = "All Available Links";
                    }

                    downloadLinks.push({ 
                        quality: currentQuality, 
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

// 🔥 THE MASTERMIND EXTRACTION LOGIC (Now with Auto-Episode Detection!) 🔥
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

                const lockedQuality = linkObj.quality || ""; 
                const lockedEpisode = linkObj.episode || "Movie";

                let sizeMatch = lockedQuality.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
                let targetSizeNum = sizeMatch ? sizeMatch[1] : null; 
                
                let resMatch = lockedQuality.match(/(480p|720p|1080p|2160p|4k)/i);
                let targetRes = resMatch ? resMatch[0].toLowerCase() : null;
                if (targetRes === '4k') targetRes = '2160p';
                let targetTags = ['hevc', '10bit', 'hq', 'x264', 'x265', 'hdr'].filter(t => lockedQuality.toLowerCase().includes(t));

                if (urlToFetch.includes('hubcloud') || urlToFetch.includes('gdflix')) {
                    return [{ genUrl: urlToFetch, episode: lockedEpisode, quality: lockedQuality }];
                }

                const linkRes = await axios.get(urlToFetch, { headers: HEADERS, timeout: 12000 });
                const $ = cheerio.load(linkRes.data);
                
                let urlObjs = [];

                $('a').each((i, el) => {
                    let href = $(el).attr('href');
                    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

                    const isValidHop = href.includes('hubcloud') || href.includes('gdflix') || href.includes('gamerxyt') || href.includes('m4ulinks');
                    
                    if (isValidHop) {
                        let headerText = "";
                        let curr = $(el).parent();
                        
                        // Upar ki 6 lines mein closest Heading dhoondho (Resolution ya Episode)
                        for (let k = 0; k < 6; k++) {
                            if (!curr.length || curr.prop('tagName') === 'HR') break;
                            let txt = curr.text().toLowerCase();
                            // Resolution ya Episode text ko pakadna
                            if (/(480p|720p|1080p|2160p|4k|episode|ep\s*\d+|e\d+)/i.test(txt)) {
                                headerText = txt;
                                break;
                            }
                            curr = curr.prev();
                        }
                        
                        if (!headerText) headerText = $(el).text().toLowerCase() + " " + $(el).parent().text().toLowerCase();
                        
                        // 🔥 WEB SERIES EPISODE EXTRACTOR 🔥
                        let linkEpisode = lockedEpisode;
                        let epMatch = headerText.match(/(?:episodes?|ep)\s*[:-]*\s*(\d+)/i);
                        if (epMatch) {
                            // Format: Episode 01, Episode 02 (taki sorting perfectly ho)
                            linkEpisode = `Episode ${epMatch[1].padStart(2, '0')}`;
                        }

                        urlObjs.push({ href, headerText, linkEpisode });
                    }
                });

                let matchedUrls = [];

                // 🚨 WEB SERIES DETECTOR: Agar select kiye gaye naam me TV Show/Season ho ya URL page par Episode dikh jaye
                let isWebSeries = /season|episode|tv show/i.test(lockedQuality) || urlObjs.some(obj => /episode|ep\s*\d+/i.test(obj.headerText));

                if (isWebSeries) {
                    // Web Series ke page par saare links accept honge kyunki unpe sirf Episode no. hota hai, size nahi!
                    matchedUrls = urlObjs;
                } else {
                    // Movie Filter Logic
                    if (targetSizeNum) {
                        matchedUrls = urlObjs.filter(obj => obj.headerText.includes(targetSizeNum));
                    }
                    if (matchedUrls.length === 0 && targetRes) {
                        matchedUrls = urlObjs.filter(obj => {
                            let hResMatch = obj.headerText.match(/(480p|720p|1080p|2160p|4k)/i);
                            let hRes = hResMatch ? hResMatch[0].toLowerCase() : null;
                            if (hRes === '4k') hRes = '2160p';
                            let hasRes = (hRes === targetRes);
                            let hasAllTags = targetTags.every(t => obj.headerText.includes(t));
                            return hasRes && hasAllTags;
                        });
                    }
                    if (matchedUrls.length === 0 && targetRes) {
                        matchedUrls = urlObjs.filter(obj => {
                            let hResMatch = obj.headerText.match(/(480p|720p|1080p|2160p|4k)/i);
                            let hRes = hResMatch ? hResMatch[0].toLowerCase() : null;
                            if (hRes === '4k') hRes = '2160p';
                            return hRes === targetRes;
                        });
                    }
                }

                let urls = [];
                matchedUrls.forEach(obj => {
                    let href = obj.href;
                    if (/^https:\/\/vifix\.site\/hubcloud\/([a-z0-9]+)$/i.test(href)) {
                        href = `https://hubcloud.one/drive/${href.split("/").pop()}`;
                    }
                    // Yahan hum specific Episode assign kar rahe hain
                    urls.push({ genUrl: href, episode: obj.linkEpisode, quality: lockedQuality });
                });

                // Remove exact duplicates
                return urls.filter((v, i, a) => a.findIndex(t => (t.genUrl === v.genUrl)) === i);
            } catch (e) { return []; }
        });
        
        const allInterUrls = (await Promise.all(interPromises)).flat();

        // Step 3: HubCloud Bypass
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

        // Step 4: Final Links Extraction
        const genPromises = uniqueGenUrls.map(async (item) => {
            if (seenGenerators.has(item.url)) return [];
            seenGenerators.add(item.url);

            try {
                const genRes = await axios.get(item.url, { headers: HEADERS, timeout: 15000 });
                const pixelScriptMatch = genRes.data.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
                const jsPixelUrl = pixelScriptMatch ? pixelScriptMatch[1] : null;

                const $ = cheerio.load(genRes.data);
                let extracted = [];

                $('a').each((i, a) => {
                    let href = $(a).attr('href');
                    let text = $(a).text().trim() || "Download";
                    if (!href || !href.startsWith('http')) return;

                    const lowerHref = href.toLowerCase();
                    const blacklist = ['t.me', 'telegram', '/tg/', 'whatsapp', 'discord'];
                    if (blacklist.some(term => lowerHref.includes(term))) return;

                    const isDirectFile = /\.(zip|rar|7z|mkv|mp4|avi|mov|pdf|doc|docx)$/i.test(href);
                    const isCloudflare = lowerHref.includes("r2.dev") || lowerHref.includes("cloudflare") || lowerHref.includes("workers.dev");
                    const isDrive = lowerHref.includes("googleusercontent.com") || lowerHref.includes("drive.google.com");
                    const isExternal = lowerHref.includes("mediafire") || lowerHref.includes("mega.nz") || lowerHref.includes("dropbox");
                    const isPixel = lowerHref.includes("pixeldrain");
                    const hasLegacy = ['10gbps', 'zipdisk', 'ddl', 'fsl', 'server', 'buzz'].some(ind => lowerHref.includes(ind) || text.toLowerCase().includes(ind));
                    
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

        // Duplicate links hatana
        rawFinalLinks.forEach(f => {
            let isDuplicate = finalLinks.some(exist => exist.url === f.url);
            if (!isDuplicate) finalLinks.push(f);
        });

        // 🔥 SORTING BY EPISODE (Episode 01, Episode 02 ekdum line se aayenge)
        finalLinks.sort((a, b) => a.episode.localeCompare(b.episode));
    } catch (e) { console.error("Extraction error:", e.message); }

    res.json({ finalLinks });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at port ${PORT}`));
