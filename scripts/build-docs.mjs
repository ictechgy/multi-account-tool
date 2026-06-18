#!/usr/bin/env node
/**
 * README.md / README.ko.md → GitHub Pages 정적 "모던 독스" 사이트 빌드.
 *
 * 산출물 (`site/`): index.html(EN) · ko.html(KO) · style.css · .nojekyll.
 * `.github/workflows/pages.yml` 이 이 스크립트를 돌려 `site/` 를 Pages 로 배포한다.
 *
 * 디자인 (frontend-design — "Engineered & precise" 기술 문서):
 *  - 타이포: IBM Plex Sans/Mono/Sans KR (Google Fonts) — 기술적·개성 + 한글 지원.
 *  - 컬러: warm 뉴트럴(stone) + 단일 에메랄드 액센트. 라이트/다크 + 수동 토글(localStorage).
 *  - 레이아웃: sticky 탑바 → 히어로(eyebrow·제목·태그라인·CTA·터미널 카드) → [TOC 사이드바|본문] → 푸터.
 *  - 컴포넌트: blockquote→callout 카드, 라운드 테이블(가로 스크롤), 코드 다크 카드, scroll-spy TOC.
 *  - 모션: 히어로 로드 스태거(prefers-reduced-motion 가드).
 *
 * 변환: marked(GFM) → heading slug id → 링크 재작성(언어 전환 / .md·LICENSE→GitHub blob, fragment 보존)
 * → 인라인 언어전환 단락 aria-hidden → 히어로/본문 분리 → TOC 생성 → 템플릿 래핑.
 *
 * 결정성: 입력 동일 → 출력 동일(타임스탬프/랜덤 미포함) → CI `git diff --exit-code site/` 가드 성립.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'site');
const REPO = 'ictechgy/multi-account-tool';
const REPO_URL = `https://github.com/${REPO}`;
const BLOB_BASE = `${REPO_URL}/blob/main/`;
/** 배포된 문서 사이트 URL. README 상단의 이 링크는 GitHub 에서만 유용하므로 생성 사이트에선 제거(자기참조 + 히어로 오염 방지). */
const SITE_URL = 'https://ictechgy.github.io/multi-account-tool/';

/** 빌드할 페이지: README 소스 → 출력 + 언어별 UI 문자열. */
const PAGES = [
  {
    lang: 'en',
    src: 'README.md',
    out: 'index.html',
    title: 'multi-account-tool (mat)',
    description: 'Switch between multiple AI CLI accounts (Claude Code, Codex, Gemini, Aider, Kimi, Qwen, Crush, OpenCode, Goose) in a single TUI — safe-by-default credential switching.',
    eyebrow: 'AI CLI account switcher',
    tocTitle: 'On this page',
    skipLabel: 'Skip to content',
    navLabel: 'Site',
    languageLabel: 'Language',
    themeToggleLabel: 'Toggle theme',
    githubLabel: 'GitHub repository',
    footerGenerated: 'Generated from',
    cta: { install: 'Install', github: 'GitHub' },
    switcher: { current: 'EN', other: { label: 'KO', href: 'ko.html' } }
  },
  {
    lang: 'ko',
    src: 'README.ko.md',
    out: 'ko.html',
    title: 'multi-account-tool (mat)',
    description: '여러 AI CLI 계정을 하나의 TUI에서 전환 — 기본이 안전한 자격증명 스위처.',
    eyebrow: 'AI CLI 계정 스위처',
    tocTitle: '이 페이지에서',
    skipLabel: '본문으로 건너뛰기',
    navLabel: '사이트',
    languageLabel: '언어',
    themeToggleLabel: '테마 전환',
    githubLabel: 'GitHub 저장소',
    footerGenerated: '생성 원본',
    cta: { install: '설치', github: 'GitHub' },
    switcher: { current: 'KO', other: { label: 'EN', href: 'index.html' } }
  }
];

/** heading 텍스트 → URL slug. 유니코드 문자/숫자 보존(한글 헤딩), 그 외는 하이픈. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, '')
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** 생성된 HTML 의 `<h1..6>` 에 고유 id 부여 (중복 slug 는 -1, -2 …). */
function addHeadingIds(html) {
  const seen = new Map();
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_m, level, attrs, inner) => {
    let slug = slugify(inner) || 'section';
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    return `<h${level}${attrs} id="${slug}">${inner}</h${level}>`;
  });
}

/** 링크 target 재작성 — 언어 전환 / 상대 .md·LICENSE → GitHub blob. fragment·query 보존. */
function rewriteHref(url) {
  if (/^(https?:|mailto:|#|\/\/)/.test(url)) return url;
  const hashIdx = url.indexOf('#');
  const queryIdx = url.indexOf('?');
  const sepIdx = [hashIdx, queryIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const path = sepIdx >= 0 ? url.slice(0, sepIdx) : url;
  const suffix = sepIdx >= 0 ? url.slice(sepIdx) : '';
  if (path === 'README.ko.md' || path === './README.ko.md') return 'ko.html' + suffix;
  if (path === 'README.md' || path === './README.md') return 'index.html' + suffix;
  const rel = path.replace(/^\.?\//, '');
  if (/\.md$/i.test(rel) || /(^|\/)LICENSE$/.test(rel)) return BLOB_BASE + rel + suffix;
  return url;
}

function rewriteLinks(html) {
  return html.replace(/href="([^"]+)"/g, (_m, url) => `href="${rewriteHref(url)}"`);
}

/** 본문 첫머리의 인라인 언어 전환 단락에 aria-hidden (sticky 헤더 nav 와 중복 — 스크린리더 1회만). */
function hideInlineLangSwitcher(html, otherHref) {
  const at = html.indexOf(`href="${otherHref}"`);
  if (at < 0) return html;
  const open = html.lastIndexOf('<p>', at);
  const close = html.indexOf('</p>', at);
  if (open < 0 || close < 0) return html;
  return (
    html.slice(0, open) +
    '<p class="inline-lang" aria-hidden="true">' +
    html.slice(open + '<p>'.length, close + '</p>'.length) +
    html.slice(close + '</p>'.length)
  );
}

/** needle(예: 사이트 자기 URL)을 포함하는 첫 `<p>` 단락을 통째로 제거. (동적 RegExp 미사용 — 문자열 인덱스.) */
function stripParagraphWith(html, needle) {
  const at = html.indexOf(needle);
  if (at < 0) return html;
  const open = html.lastIndexOf('<p>', at);
  const close = html.indexOf('</p>', at);
  if (open < 0 || close < 0) return html;
  return html.slice(0, open) + html.slice(close + '</p>'.length);
}

/** HTML 속성/텍스트 escape. */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 본문을 히어로(첫 `<hr>` 이전)와 본문(이후)으로 분리. hr 없으면 전체가 본문. */
function splitHero(body) {
  const m = body.match(/<hr\s*\/?>/);
  if (!m) return { hero: '', main: body };
  const idx = m.index;
  return { hero: body.slice(0, idx), main: body.slice(idx + m[0].length) };
}

/** 히어로에 eyebrow(제목 앞) + CTA 버튼(첫 코드블록 앞) 삽입. */
function injectHeroExtras(hero, page) {
  const eyebrow = `<p class="eyebrow">${esc(page.eyebrow)}</p>`;
  let out = hero.replace(/<h1/, `${eyebrow}\n<h1`);
  const cta =
    `<div class="hero-cta">` +
    `<a class="btn btn-primary" href="#install">${esc(page.cta.install)}</a>` +
    `<a class="btn" href="${REPO_URL}">${esc(page.cta.github)} <span aria-hidden="true">↗</span></a>` +
    `</div>`;
  const preIdx = out.indexOf('<pre');
  if (preIdx >= 0) out = out.slice(0, preIdx) + cta + '\n' + out.slice(preIdx);
  else out += cta;
  return out;
}

/** 본문의 h2/h3(id 보유)로 중첩 TOC 생성. */
function buildToc(mainHtml) {
  const re = /<h([23])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  const groups = [];
  for (const m of mainHtml.matchAll(re)) {
    const level = Number(m[1]);
    const id = m[2];
    const text = m[3].replace(/<[^>]+>/g, '').replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, '').trim();
    if (level === 2) groups.push({ id, text, children: [] });
    else if (groups.length) groups[groups.length - 1].children.push({ id, text });
    else groups.push({ id, text, children: [] });
  }
  if (!groups.length) return '';
  let html = '<ul class="toc-list">';
  for (const g of groups) {
    html += `<li><a href="#${g.id}" data-toc="${g.id}">${esc(g.text)}</a>`;
    if (g.children.length) {
      html += '<ul class="toc-sub">';
      for (const c of g.children) html += `<li><a href="#${c.id}" data-toc="${c.id}">${esc(c.text)}</a></li>`;
      html += '</ul>';
    }
    html += '</li>';
  }
  return html + '</ul>';
}

/** 페이지 HTML 문서 합성. */
function renderPage(page, heroHtml, mainHtml, tocHtml) {
  const { lang, title, description } = page;
  const langNav =
    `<a class="lang ${lang === 'en' ? 'active' : ''}" ${lang === 'en' ? 'aria-current="page"' : 'href="index.html"'}>EN</a>` +
    `<span class="lang-sep">/</span>` +
    `<a class="lang ${lang === 'ko' ? 'active' : ''}" ${lang === 'ko' ? 'aria-current="page"' : 'href="ko.html"'}>KO</a>`;
  const home = lang === 'en' ? 'index.html' : 'ko.html';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<title>${esc(title)}</title>
<script>(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip-link" href="#main">${esc(page.skipLabel)}</a>
<header class="topbar">
  <a class="brand" href="${home}"><span class="brand-mark">mat</span> <span class="brand-sub">multi-account-tool</span></a>
  <nav class="topnav" aria-label="${esc(page.navLabel)}">
    <span class="langswitch" aria-label="${esc(page.languageLabel)}">${langNav}</span>
    <button id="theme-toggle" class="icon-btn" type="button" aria-label="${esc(page.themeToggleLabel)}" title="${esc(page.themeToggleLabel)}">
      <span class="i-moon" aria-hidden="true">☾</span><span class="i-sun" aria-hidden="true">☀</span>
    </button>
    <a class="icon-btn gh" href="${REPO_URL}" aria-label="${esc(page.githubLabel)}" title="GitHub">
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    </a>
  </nav>
</header>
<section class="hero">
  <div class="hero-inner">
${heroHtml}
  </div>
</section>
<div class="layout">
  <aside class="sidebar">
    <details class="toc-collapse">
      <summary class="toc-title">${esc(page.tocTitle)}</summary>
      <nav class="toc" aria-label="${esc(page.tocTitle)}">
${tocHtml}
      </nav>
    </details>
  </aside>
  <main id="main" class="content markdown-body">
${mainHtml}
  </main>
</div>
<footer class="site-footer">
  <div class="footer-inner">
    <span><a href="${REPO_URL}">${REPO}</a> · MIT</span>
    <span class="gen">${esc(page.footerGenerated)} <code>${esc(page.src)}</code> · <code>scripts/build-docs.mjs</code></span>
  </div>
</footer>
<script>
(function(){
  var btn=document.getElementById('theme-toggle');
  if(btn)btn.addEventListener('click',function(){
    var cur=document.documentElement.getAttribute('data-theme');
    var sysDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark=cur?cur==='dark':sysDark;
    var next=isDark?'light':'dark';
    document.documentElement.setAttribute('data-theme',next);
    try{localStorage.setItem('theme',next);}catch(e){}
  });
  var links=Array.prototype.slice.call(document.querySelectorAll('[data-toc]'));
  if(links.length&&'IntersectionObserver'in window){
    var map={};links.forEach(function(l){map[l.getAttribute('data-toc')]=l;});
    var obs=new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){links.forEach(function(l){l.classList.remove('active');});var l=map[e.target.id];if(l)l.classList.add('active');}
      });
    },{rootMargin:'0px 0px -75% 0px',threshold:0});
    links.forEach(function(l){var h=document.getElementById(l.getAttribute('data-toc'));if(h)obs.observe(h);});
  }
})();
</script>
</body>
</html>
`;
}

const STYLE_CSS = `/* 생성물 — scripts/build-docs.mjs 의 STYLE_CSS 를 편집하세요. */
:root {
  --bg: #fbfbfa; --bg-soft: #f4f4f2; --surface: #ffffff;
  --fg: #1c1b1a; --fg-soft: #44403c; --muted: #6b635b;
  --border: #e7e5e4; --border-soft: #f0efed;
  --accent: #047857; --accent-strong: #065f46; --accent-contrast: #ffffff;
  --accent-soft-bg: #ecfdf5; --accent-soft-border: #a7f3d0;
  --code-bg: #f1f0ed; --code-fg: #1c1b1a;
  --term-bg: #1a1917; --term-fg: #e7e5e4; --term-bar: #2a2826; --term-border: #322f2c;
  --shadow-sm: 0 1px 2px rgba(28,27,26,.05);
  --shadow: 0 1px 2px rgba(28,27,26,.05), 0 12px 28px -16px rgba(28,27,26,.22);
  --maxw: 1180px;
}
:root[data-theme="dark"] {
  --bg: #0c0d0c; --bg-soft: #131413; --surface: #161816;
  --fg: #eae8e4; --fg-soft: #c2bdb5; --muted: #8a857c;
  --border: #292b27; --border-soft: #1d1f1c;
  --accent: #34d399; --accent-strong: #6ee7b7; --accent-contrast: #06231a;
  --accent-soft-bg: #0d1f16; --accent-soft-border: #14532d;
  --code-bg: #181a17; --code-fg: #eae8e4;
  --term-bg: #0a0b0a; --term-fg: #d9d6d0; --term-bar: #161815; --term-border: #24261f;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 16px 40px -20px rgba(0,0,0,.7);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --bg: #0c0d0c; --bg-soft: #131413; --surface: #161816;
    --fg: #eae8e4; --fg-soft: #c2bdb5; --muted: #8a857c;
    --border: #292b27; --border-soft: #1d1f1c;
    --accent: #34d399; --accent-strong: #6ee7b7; --accent-contrast: #06231a;
    --accent-soft-bg: #0d1f16; --accent-soft-border: #14532d;
    --code-bg: #181a17; --code-fg: #eae8e4;
    --term-bg: #0a0b0a; --term-fg: #d9d6d0; --term-bar: #161815; --term-border: #24261f;
    --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 16px 40px -20px rgba(0,0,0,.7);
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; scroll-padding-top: 5rem; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: "IBM Plex Sans", "IBM Plex Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  font-size: 16px; line-height: 1.7; letter-spacing: -0.003em;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
::selection { background: var(--accent); color: var(--accent-contrast); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-strong); }
.skip-link { position: absolute; left: -999px; top: 0; background: var(--accent); color: var(--accent-contrast); padding: .6rem 1rem; border-radius: 0 0 8px 0; z-index: 100; }
.skip-link:focus { left: 0; }

/* topbar */
.topbar {
  position: sticky; top: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: .7rem clamp(1rem, 4vw, 2.5rem);
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: baseline; gap: .55rem; color: var(--fg); }
.brand-mark { font-family: "IBM Plex Mono", monospace; font-weight: 600; font-size: 1.05rem; background: var(--accent); color: var(--accent-contrast); padding: .12em .45em; border-radius: 7px; letter-spacing: -0.02em; }
.brand-sub { color: var(--muted); font-size: .85rem; font-weight: 500; }
.topnav { display: flex; align-items: center; gap: .35rem; }
.langswitch { font-family: "IBM Plex Mono", monospace; font-size: .82rem; margin-right: .3rem; }
.langswitch .lang { color: var(--muted); padding: .2rem .15rem; }
.langswitch .lang.active { color: var(--fg); font-weight: 600; }
.langswitch .lang-sep { color: var(--border); margin: 0 .15rem; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 8px; color: var(--fg-soft); border: 1px solid transparent; background: transparent; cursor: pointer; font-size: 1rem; transition: background .15s, color .15s, border-color .15s; }
.icon-btn:hover { background: var(--bg-soft); color: var(--fg); border-color: var(--border); }
.i-sun { display: none; } .i-moon { display: inline; }
:root[data-theme="dark"] .i-sun { display: inline; } :root[data-theme="dark"] .i-moon { display: none; }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) .i-sun { display: inline; } :root:not([data-theme]) .i-moon { display: none; } }

/* hero */
.hero { border-bottom: 1px solid var(--border); background: radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 60%); }
.hero-inner { max-width: var(--maxw); margin: 0 auto; padding: clamp(2.5rem, 7vw, 5rem) clamp(1rem, 4vw, 2.5rem) clamp(2rem, 5vw, 3.5rem); }
.hero .inline-lang { display: none; }
.eyebrow { font-family: "IBM Plex Mono", monospace; text-transform: uppercase; letter-spacing: .18em; font-size: .72rem; color: var(--accent); margin: 0 0 1rem; font-weight: 600; animation: rise .6s cubic-bezier(.2,.7,.2,1) both; }
.hero h1 { font-size: clamp(2.1rem, 5.2vw, 3.4rem); line-height: 1.06; letter-spacing: -0.03em; font-weight: 700; margin: 0 0 1rem; max-width: 22ch; text-wrap: balance; animation: rise .6s cubic-bezier(.2,.7,.2,1) .05s both; }
.hero h1 code { font-family: "IBM Plex Mono", monospace; font-size: .62em; font-weight: 600; color: var(--accent); background: none; padding: 0; letter-spacing: -0.01em; vertical-align: .04em; }
.hero-inner > p:not(.inline-lang):not(.eyebrow) { font-size: clamp(1.05rem, 1.8vw, 1.35rem); color: var(--fg-soft); max-width: 60ch; margin: 0 0 1.8rem; line-height: 1.55; animation: rise .6s cubic-bezier(.2,.7,.2,1) .1s both; }
.hero-cta { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.6rem 0 2.2rem; animation: rise .6s cubic-bezier(.2,.7,.2,1) .15s both; }
.btn { display: inline-flex; align-items: center; gap: .4rem; padding: .62rem 1.15rem; border-radius: 10px; font-weight: 600; font-size: .95rem; border: 1px solid var(--border); color: var(--fg); background: var(--surface); transition: transform .12s, box-shadow .15s, border-color .15s, background .15s; box-shadow: var(--shadow-sm); }
.btn:hover { transform: translateY(-1px); border-color: var(--muted); color: var(--fg); background: var(--bg-soft); }
.btn-primary { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--accent-contrast); box-shadow: 0 8px 20px -8px color-mix(in srgb, var(--accent) 60%, transparent); }
.hero pre { position: relative; margin: 0; background: var(--term-bg); color: var(--term-fg); border: 1px solid var(--term-border); border-radius: 14px; padding: 2.7rem 1.25rem 1.25rem; overflow-x: auto; box-shadow: var(--shadow); animation: rise .7s cubic-bezier(.2,.7,.2,1) .2s both; font-size: .82rem; line-height: 1.5; }
.hero pre::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 2.4rem; background: var(--term-bar); border-bottom: 1px solid var(--term-border); border-radius: 14px 14px 0 0; }
.hero pre::after { content: ""; position: absolute; top: .95rem; left: 1.1rem; width: .62rem; height: .62rem; border-radius: 50%; background: #ff5f56; box-shadow: 1rem 0 0 #ffbd2e, 2rem 0 0 #27c93f; }
.hero pre code { background: none; padding: 0; color: inherit; font-size: inherit; }

/* layout */
.layout { max-width: var(--maxw); margin: 0 auto; padding: 0 clamp(1rem, 4vw, 2.5rem); display: grid; grid-template-columns: 232px minmax(0,1fr); gap: clamp(1.5rem, 4vw, 3.5rem); align-items: start; }
.sidebar { position: sticky; top: 4.2rem; align-self: start; padding: 2.2rem 0; max-height: calc(100vh - 4.2rem); overflow-y: auto; }
.toc-title { font-family: "IBM Plex Mono", monospace; text-transform: uppercase; letter-spacing: .12em; font-size: .68rem; color: var(--muted); margin: 0 0 .9rem; font-weight: 600; }
.toc-collapse > summary { list-style: none; cursor: pointer; display: flex; align-items: center; }
.toc-collapse > summary::-webkit-details-marker { display: none; }
.toc-collapse > summary::after { content: "\\25B8"; margin-left: auto; color: var(--muted); transition: transform .15s; }
.toc-collapse[open] > summary::after { transform: rotate(90deg); }
@media (min-width: 921px) {
  /* 데스크톱: details 닫힘 상태여도 TOC 항상 표시 + summary 비-인터랙티브 (캐럿 숨김). */
  .toc-collapse > .toc { display: block !important; }
  .toc-collapse > summary { cursor: default; pointer-events: none; }
  .toc-collapse > summary::after { display: none; }
}
.toc-list, .toc-sub { list-style: none; margin: 0; padding: 0; }
.toc-list > li { margin: 0 0 .1rem; }
.toc a { display: block; color: var(--muted); font-size: .86rem; padding: .28rem .7rem; border-left: 2px solid transparent; line-height: 1.35; transition: color .12s, border-color .12s; }
.toc a:hover { color: var(--fg); }
.toc a.active { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
.toc-sub { margin: .1rem 0 .4rem; }
.toc-sub a { padding-left: 1.4rem; font-size: .82rem; }

/* content */
.content { padding: 2.2rem 0 4rem; min-width: 0; }
.markdown-body h2 { font-size: 1.55rem; letter-spacing: -0.02em; margin: 2.6rem 0 1rem; padding-top: .4rem; scroll-margin-top: 5rem; }
.markdown-body h2:first-child { margin-top: .5rem; }
.markdown-body h3 { font-size: 1.18rem; letter-spacing: -0.015em; margin: 2rem 0 .8rem; scroll-margin-top: 5rem; }
.markdown-body h2 code, .markdown-body h3 code { font-family: "IBM Plex Mono", monospace; font-size: .82em; background: var(--code-bg); padding: .06em .35em; border-radius: 7px; }
.markdown-body p, .markdown-body li { color: var(--fg-soft); }
.markdown-body strong { color: var(--fg); font-weight: 600; }
.markdown-body del { color: var(--muted); }
.markdown-body a { font-weight: 500; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent); text-underline-offset: 2px; }
.markdown-body a:hover { text-decoration-color: var(--accent); }
.markdown-body ul, .markdown-body ol { padding-left: 1.3rem; }
.markdown-body li { margin: .35rem 0; }
.markdown-body li::marker { color: var(--accent); }
.markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 2.5rem 0; }
.markdown-body img { max-width: 100%; }
.markdown-body code { font-family: "IBM Plex Mono", monospace; font-size: .85em; background: var(--code-bg); color: var(--code-fg); padding: .15em .4em; border-radius: 6px; border: 1px solid var(--border-soft); }
.markdown-body pre { background: var(--term-bg); color: var(--term-fg); border: 1px solid var(--term-border); border-radius: 12px; padding: 1.15rem 1.25rem; overflow-x: auto; box-shadow: var(--shadow-sm); margin: 1.2rem 0; line-height: 1.55; }
.markdown-body pre code { background: none; border: 0; padding: 0; color: inherit; font-size: .84em; }
.markdown-body blockquote { margin: 1.3rem 0; padding: .9rem 1.1rem .9rem 1.2rem; background: var(--accent-soft-bg); border: 1px solid var(--accent-soft-border); border-left: 3px solid var(--accent); border-radius: 10px; color: var(--fg-soft); }
.markdown-body blockquote > :first-child { margin-top: 0; } .markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body .table-wrap { overflow-x: auto; margin: 1.3rem 0; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-sm); }
.markdown-body table { border-collapse: collapse; width: 100%; font-size: .92rem; }
.markdown-body thead th { background: var(--bg-soft); color: var(--fg); font-weight: 600; text-align: left; }
.markdown-body th, .markdown-body td { padding: .6rem .9rem; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border-soft); vertical-align: top; }
.markdown-body th:last-child, .markdown-body td:last-child { border-right: 0; }
.markdown-body tbody tr:last-child td { border-bottom: 0; }
.markdown-body tbody tr:hover { background: var(--bg-soft); }

/* footer */
.site-footer { border-top: 1px solid var(--border); margin-top: 2rem; }
.footer-inner { max-width: var(--maxw); margin: 0 auto; padding: 2rem clamp(1rem, 4vw, 2.5rem); display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; justify-content: space-between; color: var(--muted); font-size: .85rem; }
.footer-inner code { font-family: "IBM Plex Mono", monospace; font-size: .82em; }

.sidebar::-webkit-scrollbar, .markdown-body pre::-webkit-scrollbar, .table-wrap::-webkit-scrollbar { height: 8px; width: 8px; }
.sidebar::-webkit-scrollbar-thumb, .markdown-body pre::-webkit-scrollbar-thumb, .table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }

@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }

@media (max-width: 920px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { position: static; max-height: none; padding: 1.4rem 0 0; border-bottom: 1px solid var(--border); }
  .toc-list { columns: 2; column-gap: 1.5rem; }
  .content { padding-top: 1.6rem; }
}
@media (max-width: 920px) and (min-width: 561px) {
  /* 다중 컬럼 TOC 에선 left-border 가 컬럼 거터와 충돌 → 배경 틴트로 active 표시. */
  .toc a.active { border-left-color: transparent; background: var(--accent-soft-bg); border-radius: 6px; }
}
@media (max-width: 560px) {
  body { font-size: 15px; }
  .brand-sub { display: none; }
  .toc-list { columns: 1; }
  .markdown-body pre { background-image: linear-gradient(to right, transparent calc(100% - 1.5rem), var(--term-bg)); background-attachment: local; }
}
`;

async function build() {
  marked.setOptions({ gfm: true, breaks: false });
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const page of PAGES) {
    const md = await fs.readFile(join(ROOT, page.src), 'utf8');
    let body = rewriteLinks(addHeadingIds(marked.parse(md)));
    body = hideInlineLangSwitcher(body, page.switcher.other.href);
    body = stripParagraphWith(body, SITE_URL); // README 의 문서 사이트 링크 줄 제거 (사이트 자기참조)
    body = body.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
    const { hero, main } = splitHero(body);
    const heroHtml = injectHeroExtras(hero, page);
    const tocHtml = buildToc(main);
    await fs.writeFile(join(OUT_DIR, page.out), renderPage(page, heroHtml, main, tocHtml));
    process.stdout.write(`build-docs: ${page.src} → site/${page.out}\n`);
  }

  await fs.writeFile(join(OUT_DIR, 'style.css'), STYLE_CSS);
  await fs.writeFile(join(OUT_DIR, '.nojekyll'), '');
  process.stdout.write('build-docs: site/style.css, site/.nojekyll\n');
}

build().catch((err) => {
  process.stderr.write(`build-docs 실패: ${err?.stack ?? err}\n`);
  process.exit(1);
});
