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

// 🔥 NAYA PROXY SERVER (CodeTabs) 🔥
async function fetchViaProxy(targetUrl) {
    try {
        console.log("-> Searching URL:", targetUrl);
        
        // Proxy change kar di: CodeTabs use kar rahe hain ab
        const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${targetUrl}`;
        
        const res = await axios.get(proxyUrl, { timeout: 15000 });
        
        // CodeTabs seedha HTML deta hai (contents variable nahi hota)
        if (!res.data || typeof res.data !== 'string' || res.data.trim() === "") {
            console.log("-> ALERT: Proxy returned empty HTML!");
            return "";
        }
        return res.data; 
    } catch (error) {
        console.error("-> PROXY CRASH ERROR:", error.message);
        return "";
    }
}

app.get('/api/suggest', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);
    try {
        const searchUrl = `${currentBaseUrl}/?s=${encodeURIComponent(q)}`;
        const html = await fetchViaProxy(searchUrl); 
        
        if (!html) return res.json([]); // Agar HTML khali hai toh empty bhejo
        
        const $ = cheerio.load(html);
        let suggestions = [];
        $('article.post').each((i, el) => {
            if (i >= 6) return; 
            const titleEl = $(el).find('h3.entry-title a').first();
            const title = titleEl.text().trim();
            const link = titleEl.attr('href');
            let img = $(el).find('img').first().attr('src');
            if (title && link) suggestions.push({ title, link, img });
        });
        
        console.log(`-> Found ${suggestions.length} movies for query: ${q}`);
        res.json(suggestions);
    } catch (e) { 
        console.error("-> Suggest Route Error:", e.message);
        res.json([]); 
    }
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
            const html = await fetchViaProxy(searchUrl); 
            const $ = cheerio.load(html);
            const firstResult = $('article.post h3.entry-title a').first();
            if (firstResult.length === 0) return res.json({ error: "Movie not found" });
            
            movieUrl = firstResult.attr('href');
            titleText = firstResult.text().trim();
        }

        const detailsHtml = await fetchViaProxy(movieUrl); 
        const $$ = cheerio.load(detailsHtml);
        
        let qualities = new Set();
        let downloadLinks = [];
        let currentQuality = "Default Quality";

        $$('h2, h3, h4, h5, h6, p, div, span, strong, b, a').each((i, el) => {
            const tagName = el.tagName.toLowerCase();
            const text = $$(el).text().replace(/\s+/g, ' ').trim();

            if (tagName !== 'a') {
                if (/(480p|720p|1080p|2160p|4k)/i.test(text) && text.length > 5 && text.length < 80) {
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

                const isTelegram = hrefLower.includes('telegram') || hrefLower.includes('t.me');

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

                const targetQualityMatch = (linkObj.quality || "").match(/(480p|720p|1080p|2160p|4k)/i);
                const targetResolution = targetQualityMatch ? targetQualityMatch[0].toLowerCase() : null;

                const html = await fetchViaProxy(urlToFetch); 
                const $ = cheerio.load(html);
                let urls = [];
                let currentEpisode = linkObj.episode; 
                let currentQuality = linkObj.quality; 

                $('*').each((i, el) => {
                    const tagName = el.tagName.toLowerCase();
                    
                    if (['p', 'div', 'h2', 'h3', 'h4', 'h5', 'span', 'strong', 'b'].includes(tagName)) {
                        let text = $(el).text().replace(/\s+/g, ' ').trim();
                        if (text.length > 0 && text.length < 80) {
                            let epMatch = text.match(/(?:[-:]\s*)?Ep(?:isode)?s?\s*[:\-]*\s*(\d+)/i);
                            if (epMatch) currentEpisode = `E${epMatch[1].padStart(2, '0')}`;
                            let qMatch = text.match(/(480p|720p|1080p|2160p|4k)/i);
                            if (qMatch) currentQuality = qMatch[0].toLowerCase();
                        }
                    }

                    if (tagName === 'a') {
                        let href = $(el).attr('href');
                        if (href) {
                            let text = $(el).text().replace(/\s+/g, ' ').trim();
                            let aQuality = currentQuality;
                            
                            let aQMatch = text.match(/(480p|720p|1080p|2160p|4k)/i);
                            if (aQMatch) aQuality = aQMatch[0].toLowerCase();

                            if (targetResolution) {
                                let aResMatch = aQuality.match(/(480p|720p|1080p|2160p|4k)/i);
                                if (aResMatch && aResMatch[0].toLowerCase() !== targetResolution) return;
                            }

                            if (/^https:\/\/vifix\.site\/hubcloud\/([a-z0-9]+)$/i.test(href)) {
                                href = `https://hubcloud.one/drive/${href.split("/").pop()}`;
                            }
                            if (href.includes('hubcloud') || href.includes('gdflix') || href.includes('gamerxyt')) {
                                urls.push({ genUrl: href, episode: currentEpisode, quality: aQuality });
                            }
                        }
                    }
                });
                return urls;
            } catch (e) { return []; }
        });
        const allInterUrls = (await Promise.all(interPromises)).flat();

        const hubPromises = allInterUrls.map(async (item) => {
            try {
                const html = await fetchViaProxy(item.genUrl); 
                const $ = cheerio.load(html);
                let genUrls = [];
                const downloadBtn = $('#download').attr('href');
                if (downloadBtn) genUrls.push({ url: downloadBtn, episode: item.episode, quality: item.quality });
                
                $('a.btn, a').each((i, a) => {
                    const href = $(a).attr('href');
                    if (href && (href.includes('gamerxyt.com') || href.includes('hubcloud.php'))) {
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
                const html = await fetchViaProxy(item.url); 

                const pixelScriptMatch = html.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
                const jsPixelUrl = pixelScriptMatch ? pixelScriptMatch[1] : null;

                const $ = cheerio.load(html);
                let extracted = [];

                $('a').each((i, a) => {
                    let href = $(a).attr('href');
                    let text = $(a).text().trim() || "Download";
                    if (!href || !href.startsWith('http')) return;

                    const lowerText = text.toLowerCase();
                    const lowerHref = href.toLowerCase();

                    const blacklist = ['t.me', 'telegram', '/tg/', 'joinchat', 'whatsapp', 'discord'];

                    if (blacklist.some(term => lowerText.includes(term) || lowerHref.includes(term))) return;

                    const isDirectFile = /\.(zip|rar|7z|mkv|mp4|avi|mov|pdf|doc|docx)$/i.test(href);
                    const isCloudflare = lowerHref.includes("r2.dev") || lowerHref.includes("cloudflare");
                    const isDrive = lowerHref.includes("googleusercontent.com") || lowerHref.includes("drive.google.com");
                    const isPixel = lowerHref.includes("pixeldrain");
                    const hasLegacy = ['10gbps', 'zipdisk', 'ddl', 'fsl', 'server'].some(ind => lowerText.includes(ind) || lowerHref.includes(ind));
                    
                    if (isDirectFile || isCloudflare || isDrive || isPixel || hasLegacy || lowerHref.includes("mediafire")) {
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
                    const bypassHtml = await fetchViaProxy(linkObj.url); 
                    const $bypass = cheerio.load(bypassHtml);
                    let finalRealUrl = $bypass('a.btn, a.download-button').first().attr('href'); 
                    if(finalRealUrl) return { ...linkObj, url: finalRealUrl, server: linkObj.server + " (Unlocked)" };
                    return linkObj;
                } catch(e) { return linkObj; }
            }
            return linkObj;
        });

        rawFinalLinks = await Promise.all(doubleBypassPromises);

        rawFinalLinks.forEach(f => {
            if (!finalLinks.some(exist => exist.url === f.url)) {
                finalLinks.push(f);
            }
        });

        finalLinks.sort((a, b) => a.episode.localeCompare(b.episode));
    } catch (e) { console.error("Extraction error:", e.message); }

    res.json({ finalLinks });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at port ${PORT}`));
