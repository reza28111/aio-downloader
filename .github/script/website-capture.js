const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const TurndownService = require('turndown');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const inputUrl = process.argv[2];
if (!inputUrl) {
  console.error('No URL provided');
  process.exit(1);
}

const MAX_LINKS = 20;
const MAX_MEDIA_PER_PAGE = 30;      // limit media per page
const VIEWPORT = { width: 1280, height: 720 };

// turndown instance – we'll tweak it to keep images/videos
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**'
});

// Keep image alt text and src
turndownService.addRule('images', {
  filter: ['img'],
  replacement: (content, node) => {
    const alt = node.getAttribute('alt') || '';
    const src = node.getAttribute('src') || '';
    return `![${alt}](${src})`;
  }
});

// ---------- random 5 lowercase letters ----------
function randomFiveLetters() {
  return Array.from({ length: 5 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26))
  ).join('');
}

// ---------- wait for page to be fully loaded ----------
async function waitForStable(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
    console.warn('Network did not become fully idle – continuing…');
  });
}

// ---------- download a media file & return local relative path ----------
async function downloadMedia(url, contentDir, prefix, counter) {
  try {
    const extMatch = url.match(/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|mov)(\?.*)?$/i);
    let ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    if (ext === 'jpeg') ext = 'jpg';
    const fileName = `${prefix}_${counter}.${ext}`;
    const filePath = path.join(contentDir, fileName);

    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(contentDir, { recursive: true });
    await fs.writeFile(filePath, buffer);
    return `website/content/${fileName}`;   // relative path for markdown
  } catch (err) {
    console.warn(`    ⚠️ Failed to download ${url}: ${err.message}`);
    return null;
  }
}

// ---------- capture a URL → PDF buffer (full page) ----------
async function captureUrlPdf(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForStable(page);

    await page.evaluate(async () => {
      await new Promise(resolve => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
    });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
    });
  } catch (err) {
    console.error(`Failed to capture PDF for ${url} – ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ---------- extract page content for Markdown ----------
async function capturePageMarkdown(page, url, hostname, randomStr, pageIndex) {
  // Get page title
  const title = await page.title().catch(() => url);
  // Grab the main content – you can adjust the selector for specific sites
  const html = await page.evaluate(() => {
    const article = document.querySelector('article, main, .content, #content, .post-content');
    return article ? article.innerHTML : document.body.innerHTML;
  });

  // Convert HTML to markdown
  const markdownBody = turndownService.turndown(html);

  // ---- extract and download media ----
  const mediaElements = await page.$$eval(
    'img[src], video[src], video source[src]',
    (els) => els.map(el => {
      const tag = el.tagName.toLowerCase();
      let src = '';
      if (tag === 'img') src = el.getAttribute('src');
      else src = el.getAttribute('src'); // video or source
      return { src, tag };
    })
  );

  // Download only unique media (by URL) up to a limit
  const downloadedMap = new Map();
  let counter = 0;
  for (const { src, tag } of mediaElements) {
    if (!src || !src.startsWith('http')) continue;
    if (downloadedMap.has(src)) continue;
    if (downloadedMap.size >= MAX_MEDIA_PER_PAGE) break;

    const contentDir = path.join('website', 'content');
    const prefix = `${hostname}_p${pageIndex}`;
    const localPath = await downloadMedia(src, contentDir, prefix, counter++);
    if (localPath) downloadedMap.set(src, localPath);
  }

  // Replace URLs in the markdown
  let finalMarkdown = markdownBody;
  for (const [originalUrl, localPath] of downloadedMap.entries()) {
    finalMarkdown = finalMarkdown.replace(new RegExp(originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), localPath);
  }

  // Build a page header
  return `## ${title}\n\n> ${url}\n\n${finalMarkdown}\n\n---\n`;
}

// ---------- extract unique links from a page ----------
async function extractLinks(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(href => href.startsWith('http'));
    return [...new Set(links)];
  });
}

// ---------- main ----------
(async () => {
  console.log('Launching browser…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  // Generate a random string for both PDF and MD
  const hostname = new URL(inputUrl).hostname.replace(/^www\./, '');
  const randomPart = randomFiveLetters();
  const baseFilename = `${hostname}-${randomPart}`;   // e.g. "example-abcde"

  // ---- 1. Capture main page (PDF) ----
  console.log(`Capturing main page: ${inputUrl}`);
  const mainPdfBuf = await captureUrlPdf(context, inputUrl);
  if (!mainPdfBuf) {
    console.error('Main page PDF capture failed');
    await browser.close();
    process.exit(1);
  }

  // ---- 2. Extract same‑origin links ----
  let page;
  const pageUrls = [inputUrl];   // we'll capture both PDF and MD for all these
  try {
    page = await context.newPage();
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForStable(page);
    const allLinks = await extractLinks(page);
    await page.close();

    const mainOrigin = new URL(inputUrl).origin;
    const uniqueLinks = [...new Set(
      allLinks
        .filter(link => link.startsWith(mainOrigin))
        .map(link => link.split('#')[0])
    )].slice(0, MAX_LINKS);

    console.log(`Found ${uniqueLinks.length} unique internal links (capped at ${MAX_LINKS})`);
    pageUrls.push(...uniqueLinks);
  } catch (err) {
    console.error('Link extraction failed, continuing with main page only.');
  }

  // ---- 3. Capture PDFs for all pages (main + linked) ----
  const allPdfBufs = [mainPdfBuf];
  for (const link of pageUrls.slice(1)) {   // skip the main page (already done)
    console.log(`Capturing PDF for: ${link}`);
    const buf = await captureUrlPdf(context, link);
    if (buf) allPdfBufs.push(buf);
  }

  // ---- 4. Merge PDFs ----
  const mergedPdf = await PDFDocument.create();
  for (const buf of allPdfBufs) {
    const srcDoc = await PDFDocument.load(buf);
    const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
    copiedPages.forEach(p => mergedPdf.addPage(p));
  }
  const finalPdfBytes = await mergedPdf.save();
  await fs.writeFile('output.pdf', finalPdfBytes);
  console.log(`PDF saved: output.pdf`);

  // ---- 5. Capture Markdown for all pages ----
  let combinedMarkdown = '';
  for (let i = 0; i < pageUrls.length; i++) {
    const url = pageUrls[i];
    console.log(`Extracting Markdown for: ${url}`);
    const mdPage = await context.newPage();
    try {
      await mdPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForStable(mdPage);
      const mdSection = await capturePageMarkdown(mdPage, url, hostname, randomPart, i);
      combinedMarkdown += mdSection;
    } catch (err) {
      console.error(`Failed to extract Markdown for ${url} – ${err.message}`);
    } finally {
      await mdPage.close();
    }
  }

  await fs.writeFile('output.md', combinedMarkdown);
  console.log(`Markdown saved: output.md`);

  // ---- 6. Export the base filename for the upload step ----
  // We'll move output.pdf and output.md to website/ using this base name
  await fs.appendFile(process.env.GITHUB_ENV, `FILENAME=${baseFilename}\n`);

  await context.close();
  await browser.close();
  console.log('Done.');
})();
