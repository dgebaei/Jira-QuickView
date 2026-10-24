const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const docsDir = path.join(repoRoot, 'docs');
const readmePath = path.join(repoRoot, 'README.md');
const userGuidePath = path.join(docsDir, 'user-guide.md');
const outputDir = path.join(repoRoot, '.site-build');
const faviconSvgPath = path.join(docsDir, 'branding', 'jira-quickview-mark.svg');
const faviconPngPath = path.join(docsDir, 'branding', 'jira-quickview-mark-128.png');

const DOWNLOAD_URL = 'https://chromewebstore.google.com/detail/jira-quickview/oddgjhpfjkeckcppcldgjomlnablfkia';
const WEBSITE_URL = 'https://dgebaei.github.io/Jira-QuickView/';
const REPO_URL = 'https://github.com/dgebaei/Jira-QuickView';
const ISSUES_URL = 'https://github.com/dgebaei/Jira-QuickView/issues';

function renderMarkdownHtml(markdownPath) {
  try {
    return execFileSync('pandoc', [markdownPath, '--from=gfm', '--to=html5', '--wrap=none'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    throw new Error('pandoc is required to build the Pages site from Markdown files');
  }
}

function rewriteDocsLinks(html) {
  return html
    .replace(/href="docs\/user-guide\.md"/g, 'href="user-guide.html"')
    .replace(/(src|href)="docs\//g, '$1="');
}

function attr(tag, name) {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag);
  return match ? match[1] : '';
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractParagraph(html, needle) {
  const needleIndex = html.indexOf(needle);
  if (needleIndex < 0) return null;
  const start = html.lastIndexOf('<p>', needleIndex);
  const end = html.indexOf('</p>', needleIndex);
  if (start < 0 || end < 0) return null;
  return {
    block: html.slice(start, end + 4),
    inner: html.slice(start + 3, end),
    rest: html.slice(0, start) + html.slice(end + 4),
  };
}

function extractFirstImageParagraph(html) {
  const match = /<p>\s*(<img\b[^>]*src="screenshots\/[^"]*"[^>]*>)\s*<\/p>/.exec(html);
  if (!match) return null;
  return {
    imageTag: match[1],
    rest: html.slice(0, match.index) + html.slice(match.index + match[0].length),
  };
}

function buildHeroActions(paragraph) {
  const links = [...paragraph.matchAll(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  return links
    .map((match, index) => {
      const label = match[2].trim();
      const primary = /download extension/i.test(label) ? ' hero-action-primary' : '';
      return `<a class="hero-action${primary}" href="${match[1]}">${label}</a>`;
    })
    .join('\n          ');
}

function buildHeroBadges(paragraph) {
  const images = [...paragraph.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  return images.join('\n          ');
}

function buildHeroFigure(imageTag) {
  const src = attr(imageTag, 'src');
  const alt = attr(imageTag, 'alt') || 'Jira QuickView popup';
  return `<figure class="hero-figure">
        <div class="hero-shot-frame">
          <button type="button" class="lightbox-trigger" aria-label="Open ${alt} in full screen">
            <img class="hero-shot" src="${src}" alt="${alt}" loading="eager" fetchpriority="high" decoding="async">
          </button>
        </div>
        <figcaption>${alt}</figcaption>
      </figure>`;
}

function convertGallery(body) {
  const galleryHeading = body.search(/<h2 id="gallery"/);
  if (galleryHeading < 0) return body;
  const tableStart = body.indexOf('<table>', galleryHeading);
  const tableEnd = body.indexOf('</table>', tableStart);
  if (tableStart < 0 || tableEnd < 0) return body;
  const table = body.slice(tableStart, tableEnd + '</table>'.length);
  const images = [...table.matchAll(/<img\b[^>]*>/g)]
    .map(match => {
      const src = attr(match[0], 'src');
      const alt = attr(match[0], 'alt');
      if (!src) return '';
      const caption = alt || 'Jira QuickView screenshot';
      return `<figure class="gallery-item">
          <button type="button" class="lightbox-trigger" aria-label="Open ${stripTags(caption)} in full screen">
            <img src="${src}" alt="${caption}" loading="lazy" decoding="async">
          </button>
          <figcaption>${caption}</figcaption>
        </figure>`;
    })
    .filter(Boolean)
    .join('\n        ');
  const grid = `<div class="gallery-grid">\n        ${images}\n      </div>`;
  return body.slice(0, tableStart) + grid + body.slice(tableEnd + '</table>'.length);
}

function buildToc(body) {
  const items = [...body.matchAll(/<h2\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)].map(match => {
    const id = match[1];
    const label = stripTags(match[2]);
    return `<li><a class="toc-link" href="#${id}">${label}</a></li>`;
  });
  if (!items.length) return '';
  return `<details class="toc" open>
        <summary>On this page</summary>
        <nav aria-label="On this page">
          <ol>
            ${items.join('\n            ')}
          </ol>
        </nav>
      </details>`;
}

function extractUserGuideToc(html) {
  const marker = '<details class="user-guide-toc"';
  const start = html.indexOf(marker);
  if (start < 0) return { toc: '', rest: html };
  let depth = 0;
  for (let index = start; index < html.length; index += 1) {
    if (html.startsWith('<details', index)) {
      depth += 1;
      index += '<details'.length - 1;
      continue;
    }
    if (html.startsWith('</details>', index)) {
      depth -= 1;
      if (depth === 0) {
        const end = index + '</details>'.length;
        return {
          toc: html.slice(start, end),
          rest: html.slice(0, start) + html.slice(end),
        };
      }
      index += '</details>'.length - 1;
    }
  }
  return { toc: '', rest: html };
}

function buildHeader({current = ''}) {
  const link = (href, label, key) => `<a class="site-nav-link${current === key ? ' is-current' : ''}" href="${href}">${label}</a>`;
  return `<header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="index.html" aria-label="Jira QuickView home">
        <img class="brand-mark" src="favicon.svg" alt="" width="30" height="30">
        <span class="brand-name">Jira QuickView</span>
      </a>
      <nav class="site-nav" aria-label="Main navigation">
        ${link('user-guide.html', 'User guide', 'guide')}
        ${link('index.html#gallery', 'Gallery', 'gallery')}
        ${link('privacy-policy.html', 'Privacy', 'privacy')}
        ${link(REPO_URL, 'GitHub', 'github')}
      </nav>
      <a class="header-action" href="${DOWNLOAD_URL}">Download extension</a>
    </div>
  </header>`;
}

function buildFooter() {
  return `<footer class="site-footer">
    <div class="container footer-main">
      <div class="footer-brand">
        <a class="brand" href="index.html" aria-label="Jira QuickView home">
          <img class="brand-mark" src="favicon.svg" alt="" width="26" height="26">
          <span class="brand-name">Jira QuickView</span>
        </a>
        <p>Quick access to Jira issue details from links and ticket numbers.</p>
      </div>
      <div class="footer-links">
        <div>
          <p class="footer-title">Product</p>
          <a href="${DOWNLOAD_URL}">Download extension</a>
          <a href="user-guide.html">User guide</a>
          <a href="index.html#gallery">Gallery</a>
        </div>
        <div>
          <p class="footer-title">Project</p>
          <a href="${REPO_URL}">GitHub repository</a>
          <a href="${ISSUES_URL}">Issue tracker</a>
          <a href="privacy-policy.html">Privacy policy</a>
        </div>
      </div>
    </div>
    <div class="container footer-base">
      <p>MIT licensed. Built on Chrome Manifest V3.</p>
      <p><a href="${WEBSITE_URL}">dgebaei.github.io/Jira-QuickView</a></p>
    </div>
  </footer>`;
}

function buildPageHtml({title, description, hero, toc, bodyHtml, current = '', heroClass = ''}) {
  const aside = toc ? `<aside class="doc-aside">\n        ${toc}\n      </aside>` : '';
  const layoutClass = toc ? 'doc-layout' : 'doc-layout doc-layout-single';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="icon" href="favicon.png" type="image/png" sizes="128x128">
  <link rel="apple-touch-icon" href="favicon.png">
  <link rel="stylesheet" href="site.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${buildHeader({current})}
  <main id="main">
    <section class="hero${heroClass ? ` ${heroClass}` : ''}">
      <div class="container hero-inner">
        ${hero}
      </div>
    </section>
    <div class="container ${layoutClass}">
      ${aside}
      <article class="prose">
        ${bodyHtml}
      </article>
    </div>
  </main>
  ${buildFooter()}
  <script src="site.js"></script>
</body>
</html>
`;
}

function buildReadmeSite() {
  const renderedReadme = rewriteDocsLinks(renderMarkdownHtml(readmePath));
  const renderedUserGuide = rewriteDocsLinks(renderMarkdownHtml(userGuidePath));

  // Index: lift the README's opening into the hero.
  let indexBody = renderedReadme;
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(indexBody);
  const indexTitle = h1Match ? h1Match[1].trim() : 'Jira QuickView';
  if (h1Match) indexBody = indexBody.replace(h1Match[0], '');

  const blockquoteMatch = /<blockquote>\s*([\s\S]*?)\s*<\/blockquote>/.exec(indexBody);
  let indexLede = '';
  if (blockquoteMatch) {
    indexLede = blockquoteMatch[1].replace(/^<p>/, '').replace(/<\/p>$/, '').trim();
    indexBody = indexBody.replace(blockquoteMatch[0], '');
  }

  const badgesParagraph = extractParagraph(indexBody, 'img.shields.io');
  let badges = '';
  if (badgesParagraph) {
    badges = buildHeroBadges(badgesParagraph.block);
    indexBody = badgesParagraph.rest;
  }

  const actionsParagraph = extractParagraph(indexBody, 'Download Extension');
  let actions = '';
  if (actionsParagraph) {
    actions = buildHeroActions(actionsParagraph.block);
    indexBody = actionsParagraph.rest;
  }

  const screenshot = extractFirstImageParagraph(indexBody);
  let figure = '';
  if (screenshot) {
    figure = buildHeroFigure(screenshot.imageTag);
    indexBody = screenshot.rest;
  }

  indexBody = convertGallery(indexBody);

  const indexHero = `<div class="hero-copy">
          <h1 id="${h1Match ? attr(h1Match[0], 'id') : 'jira-quickview'}">${indexTitle}</h1>
          <p class="hero-lede">${indexLede}</p>
          <div class="hero-actions">
          ${actions}
          </div>
          <div class="hero-badges">
          ${badges}
          </div>
        </div>
        ${figure}`;

  // User guide: lift its masthead and existing table of contents.
  let guideBody = renderedUserGuide;
  const guideH1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(guideBody);
  const guideTitle = guideH1Match ? guideH1Match[1].trim() : 'Jira QuickView User Guide';
  if (guideH1Match) guideBody = guideBody.replace(guideH1Match[0], '');

  const guideBlockquoteMatch = /<blockquote>\s*([\s\S]*?)\s*<\/blockquote>/.exec(guideBody);
  let guideLede = '';
  if (guideBlockquoteMatch) {
    guideLede = guideBlockquoteMatch[1].replace(/^<p>/, '').replace(/<\/p>$/, '').trim();
    guideBody = guideBody.replace(guideBlockquoteMatch[0], '');
  }

  const guideBadges = extractParagraph(guideBody, 'img.shields.io');
  let guideBadgesHtml = '';
  if (guideBadges) {
    guideBadgesHtml = buildHeroBadges(guideBadges.block);
    guideBody = guideBadges.rest;
  }

  const guideActions = extractParagraph(guideBody, 'Download Extension');
  let guideActionsHtml = '';
  if (guideActions) {
    guideActionsHtml = buildHeroActions(guideActions.block);
    guideBody = guideActions.rest;
  }

  const guideToc = extractUserGuideToc(guideBody);
  guideBody = guideToc.rest;

  const guideHero = `<div class="hero-copy hero-copy-doc">
          <h1 id="${guideH1Match ? attr(guideH1Match[0], 'id') : 'jira-quickview-user-guide'}">${guideTitle}</h1>
          <p class="hero-lede">${guideLede}</p>
          <div class="hero-actions">
          ${guideActionsHtml}
          </div>
          <div class="hero-badges">
          ${guideBadgesHtml}
          </div>
        </div>`;

  const indexHtml = buildPageHtml({
    title: 'Jira QuickView',
    description: 'Act on Jira issues from Gmail, Outlook, GitHub, docs, and other enabled pages without opening a new Jira tab.',
    hero: indexHero,
    toc: buildToc(indexBody),
    bodyHtml: indexBody,
    current: 'home',
  });

  const userGuideHtml = buildPageHtml({
    title: 'Jira QuickView User Guide',
    description: 'Detailed setup and day-to-day usage guide for the Jira QuickView Chrome extension.',
    hero: guideHero,
    toc: guideToc.toc,
    bodyHtml: guideBody,
    current: 'guide',
    heroClass: 'hero-doc',
  });

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.cpSync(path.join(docsDir, 'privacy-policy.html'), path.join(outputDir, 'privacy-policy.html'));
  fs.cpSync(path.join(docsDir, 'site.css'), path.join(outputDir, 'site.css'));
  fs.cpSync(path.join(docsDir, 'site.js'), path.join(outputDir, 'site.js'));
  fs.cpSync(faviconSvgPath, path.join(outputDir, 'favicon.svg'));
  fs.cpSync(faviconPngPath, path.join(outputDir, 'favicon.png'));
  fs.cpSync(path.join(docsDir, 'screenshots'), path.join(outputDir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'index.html'), indexHtml);
  fs.writeFileSync(path.join(outputDir, 'user-guide.html'), userGuideHtml);

  console.log(`Built Pages site in ${outputDir}`);
}

buildReadmeSite();
