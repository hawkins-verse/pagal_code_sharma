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

// 🔥 100x DEEP SCAN SEARCH LOGIC (STRICT BOTTOM-UP BUTTON MATCHER) 🔥
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

        // Ab hum sidha 'a' tags (Links) par focus karenge
        $$('a').each((i, el) => {
            const href = $$(el).attr('href');
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

            const hrefLower = href.toLowerCase();
            const className = ($$(el).attr('class') || '').toLowerCase();
            const lowerText = $$(el).text().toLowerCase().trim();
            
            const isDownloadLink = 
                hrefLower.includes('hubcloud') || hrefLower.includes('m4ulinks') || 
                hrefLower.includes('vifix') || hrefLower.includes('gdflix') || hrefLower.includes('fastdl') ||
                className.includes('btn') || className.includes('button') || 
                lowerText.includes('download links');

            const isTelegram = hrefLower.includes('telegram') || hrefLower.includes('t.me') || hrefLower.includes('/tg/') || lowerText.includes('telegram');
            const isWatchOnline = lowerText.includes('watch') || hrefLower.includes('watch');

            // Agar proper Download Button hai...
            if (isDownloadLink && !isTelegram && !isWatchOnline) {
                let qualityName = "";
                let prevElement = $$(el).parent().prev(); // Button ke direct upar wali line pe jao

                // Button ke upar maximum 4 lines tak dekhenge (taa ki kachra na aaye)
                for (let k = 0; k < 4; k++) {
                    if (!prevElement.length) break;
                    
                    let txt = prevElement.text().replace(/\s+/g, ' ').trim();
                    let lTxt = txt.toLowerCase();

                    // Agar upar wali line mein resolution ya episode likha hai
                    if (/(480p|720p|1080p|2160p|4k|season|episode|pack)/i.test(txt) && txt.length > 5 && txt.length < 150) {
                        // Paragraph (Download in 480p...) aur Main Title ko exclude karna
                        if (!lTxt.includes('download in') && !lTxt.includes('optimized file sizes')) {
                            let resCount = (lTxt.match(/480p|720p|1080p|2160p|4k/g) || []).length;
                            if (resCount < 3) {
                                // Exact box ka naam mil gaya!
                                qualityName = txt.replace(/Download Links?|Here|Now/gi, '').replace(/^[-:]+|[-:]+$/g, '').trim();
                                break;
                            }
                        }
                    }
                    prevElement = prevElement.prev(); // Agar is line mein nahi mila toh ek aur line upar jao
                }

                // Agar fir bhi koi fallback aata hai (bahut rare case)
                if (!qualityName) {
                    qualityName = titleText.split(/480p|720p|1080p|2160p|4k/i)[0].trim();
                    if (qualityName.endsWith('|') || qualityName.endsWith('-')) qualityName = qualityName.slice(0, -1).trim();
                }

                let epMatch = qualityName.match(/(E\d+|Ep\s*\d+|Episode\s*\d+|Pack|Season\s*\d+)/i);
                let episode = epMatch ? epMatch[0].toUpperCase() : 'Movie';

                qualities.add(qualityName);

                downloadLinks.push({ 
                    quality: qualityName, 
                    episode: episode, 
                    url: resolveUrl(movieUrl, href) 
                });
            }
        });

        res.json({ title: titleText, qualities: Array.from(qualities), links: downloadLinks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 🔥 THE MASTERMIND EXTRACTION LOGIC (BULLETPROOF OLD & NEW MOVIES FIX) 🔥
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

                const directHosts = ['hubcloud', 'gdflix', 'vifix', 'fastdl', 'filepress', 'gofile'];
                if (directHosts.some(host => urlToFetch.toLowerCase().includes(host))) {
                    return [{ genUrl: urlToFetch, episode: lockedEpisode, quality: lockedQuality }];
                }

                const linkRes = await axios.get(urlToFetch, { headers: HEADERS, timeout: 12000 });
                const $ = cheerio.load(linkRes.data);
                
                let urlObjs = [];

                $('a').each((i, el) => {
                    let href = $(el).attr('href');
                    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

                    const validDomains = ['hubcloud', 'gdflix', 'gamerxyt', 'm4ulinks', 'vifix', 'fastdl', 'filepress', 'gofile', 'dropgalaxy', 'clicknupload'];
                    const isValidHop = validDomains.some(domain => href.toLowerCase().includes(domain));
                    
                    if (isValidHop) {
                        let headerText = "";
                        let curr = $(el).parent();
                        
                        while (curr.length > 0 && curr.prop('tagName') !== 'BODY') {
                            let txt = curr.text().toLowerCase().replace(/\s+/g, ' ').trim();
                            if (/(480p|720p|1080p|2160p|4k|episode|ep\s*\d+|e\d+)/i.test(txt)) {
                                let resCount = (txt.match(/480p|720p|1080p|2160p|4k/g) || []).length;
                                if (txt.length < 350 && resCount <= 3) {
                                    headerText = txt;
                                    break;
                                }
                            }
                            curr = curr.parent();
                        }
                        
                        if (!headerText) headerText = $(el).text().toLowerCase() + " " + $(el).parent().text().toLowerCase();
                        
                        let linkEpisode = lockedEpisode;
                        let epMatch = headerText.match(/(?:episodes?|ep)\s*[:-]*\s*(\d+)/i);
                        if (epMatch) {
                            linkEpisode = `Episode ${epMatch[1].padStart(2, '0')}`;
                        }

                        urlObjs.push({ href, headerText, linkEpisode });
                    }
                });

                let matchedUrls = [];
                let isWebSeries = /season|episode|tv show/i.test(lockedQuality) || urlObjs.some(obj => /episode|ep\s*\d+/i.test(obj.headerText));

                if (isWebSeries) {
                    matchedUrls = urlObjs;
                } else {
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

                if (matchedUrls.length === 0 && urlObjs.length > 0) {
                    matchedUrls = [urlObjs[0]]; 
                }

                let urls = [];
                matchedUrls.forEach(obj => {
                    let href = obj.href;
                    if (/^https:\/\/vifix\.site\/hubcloud\/([a-z0-9]+)$/i.test(href)) {
                        href = `https://hubcloud.one/drive/${href.split("/").pop()}`;
                    }
                    urls.push({ genUrl: href, episode: obj.linkEpisode, quality: lockedQuality });
                });

                return urls.filter((v, i, a) => a.findIndex(t => (t.genUrl === v.genUrl)) === i);
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

                if (genUrls.length === 0) {
                    genUrls.push({ url: item.genUrl, episode: item.episode, quality: item.quality });
                }

                return genUrls;
            } catch (e) { 
                return [{ url: item.genUrl, episode: item.episode, quality: item.quality }];
            }
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
                    const lowerText = text.toLowerCase();
                    const className = ($(a).attr('class') || '').toLowerCase();
                    
                    const blacklist = ['t.me', 'telegram', '/tg/', 'whatsapp', 'discord', 'vpn', 'ads', 'betting', 'casino'];
                    if (blacklist.some(term => lowerHref.includes(term) || lowerText.includes(term))) return;

                    const isDirectFile = /\.(zip|rar|7z|mkv|mp4|avi|mov|pdf|doc|docx)$/i.test(href);
                    const isCloudflare = lowerHref.includes("r2.dev") || lowerHref.includes("cloudflare") || lowerHref.includes("workers.dev");
                    const isDrive = lowerHref.includes("googleusercontent.com") || lowerHref.includes("drive.google.com");
                    const isExternal = lowerHref.includes("mediafire") || lowerHref.includes("mega.nz") || lowerHref.includes("dropbox");
                    const isPixel = lowerHref.includes("pixeldrain");
                    const hasLegacy = ['10gbps', 'zipdisk', 'ddl', 'fsl', 'server', 'buzz', 'gofile', 'clicknupload', 'filepress'].some(ind => lowerHref.includes(ind) || lowerText.includes(ind));
                    
                    const isGenericBtn = (className.includes('btn') || className.includes('button') || lowerText.includes('download')) && lowerHref.startsWith('http');
                    
                    if (isDirectFile || isCloudflare || isDrive || isExternal || isPixel || hasLegacy || isGenericBtn) {
                        let exactName = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
                        if(!exactName || exactName.length > 30) exactName = "Download Server";

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

        rawFinalLinks.forEach(f => {
            let isDuplicate = finalLinks.some(exist => exist.url === f.url);
            if (!isDuplicate) finalLinks.push(f);
        });

        finalLinks.sort((a, b) => a.episode.localeCompare(b.episode));
    } catch (e) { console.error("Extraction error:", e.message); }

    res.json({ finalLinks });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at port ${PORT}`));
