#!/usr/bin/env node
/**
 * README.md / README.ko.md → GitHub Pages 정적 사이트 빌드.
 *
 * 산출물 (`site/`): index.html(EN) · ko.html(KO) · style.css · .nojekyll.
 * `.github/workflows/pages.yml` 이 이 스크립트를 돌려 `site/` 를 Pages 로 배포한다
 * (배포 소스 = 빌드 산출물이라 `docs/` 내부 설계문서는 사이트에 노출되지 않는다).
 *
 * 변환 규칙:
 *  - marked(GFM) 로 markdown → HTML.
 *  - heading 에 slug id 부여(앵커/딥링크용, 중복은 -N 으로 구분).
 *  - 링크 재작성: README.md↔ko.html/index.html(언어 전환), 상대 `.md`/`LICENSE` → GitHub blob URL
 *    (사이트엔 README 파생 HTML 만 있으므로 그 외 문서는 GitHub 원본으로 보낸다).
 *  - 반응형 + prefers-color-scheme 다크모드 + sticky 헤더(언어 전환) 템플릿으로 래핑.
 *
 * 결정성: 입력(README) 동일 → 출력 동일(타임스탬프/랜덤 미포함) → CI 의 `git diff --exit-code site/`
 * staleness 가드가 성립한다. 커밋된 `site/` 는 리뷰/로컬 프리뷰용 스냅샷, 배포본은 워크플로가 재빌드.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'site');
const REPO = 'ictechgy/multi-account-tool';
const BLOB_BASE = `https://github.com/${REPO}/blob/main/`;

/** 빌드할 페이지: README 소스 → 출력 파일 + 언어 메타. */
const PAGES = [
  {
    lang: 'en',
    src: 'README.md',
    out: 'index.html',
    title: 'multi-account-tool (mat)',
    description: 'Switch between multiple AI CLI accounts (Claude Code, Codex, Gemini, Aider, Kimi, Qwen, Crush, OpenCode, Goose) from a single TUI — safe-by-default credential switching.',
    switcher: { current: 'English', other: { label: '한국어', href: 'ko.html' } }
  },
  {
    lang: 'ko',
    src: 'README.ko.md',
    out: 'ko.html',
    title: 'multi-account-tool (mat)',
    description: '여러 AI CLI 계정을 단일 TUI 에서 전환 — 안전 기본값 자격증명 스위처.',
    switcher: { current: '한국어', other: { label: 'English', href: 'index.html' } }
  }
];

/** heading 텍스트 → URL slug. 유니코드 문자/숫자 보존(한글 헤딩 지원), 그 외는 하이픈. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '') // 인라인 태그(<code> 등) 제거
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, '') // HTML 엔티티 제거 (named/숫자/hex)
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** 생성된 HTML 의 `<h1..6>` 에 고유 id 부여 (중복 slug 는 -1, -2 …). */
function addHeadingIds(html) {
  const seen = new Map();
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_m, level, attrs, inner) => {
    let slug = slugify(inner) || `section`;
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    return `<h${level}${attrs} id="${slug}">${inner}</h${level}>`;
  });
}

/**
 * 단일 링크 target 재작성 — 언어 전환 / 상대 .md·LICENSE → GitHub blob.
 * fragment(#anchor)·query(?…)는 분리해 경로만으로 분류한 뒤 다시 붙인다 — `README.md#sec`
 * 나 `docs/x.md#a` 같은 앵커 동반 상대링크가 미변환된 채 404 되는 것을 방지(검증 MED).
 */
function rewriteHref(url) {
  // 외부 URL / 페이지 내 앵커 / mailto 등은 그대로
  if (/^(https?:|mailto:|#|\/\/)/.test(url)) return url;
  const hashIdx = url.indexOf('#');
  const queryIdx = url.indexOf('?');
  const sepIdx = [hashIdx, queryIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const path = sepIdx >= 0 ? url.slice(0, sepIdx) : url;
  const suffix = sepIdx >= 0 ? url.slice(sepIdx) : '';
  if (path === 'README.ko.md' || path === './README.ko.md') return 'ko.html' + suffix;
  if (path === 'README.md' || path === './README.md') return 'index.html' + suffix;
  const rel = path.replace(/^\.?\//, '');
  // 사이트에 존재하지 않는 저장소 문서(.md / LICENSE)는 GitHub 원본으로 (fragment 보존)
  if (/\.md$/i.test(rel) || /(^|\/)LICENSE$/.test(rel)) return BLOB_BASE + rel + suffix;
  return url;
}

/** 본문 내 모든 href 재작성. */
function rewriteLinks(html) {
  return html.replace(/href="([^"]+)"/g, (_m, url) => `href="${rewriteHref(url)}"`);
}

/**
 * 본문 첫머리의 인라인 언어 전환 단락에 aria-hidden 부여 — sticky 헤더 nav 와 기능이 중복되므로
 * 스크린리더가 같은 내비를 두 번 만나지 않게 한다(검증 LOW). 본문에서 otherHref(ko.html/index.html)
 * 를 가진 `<p>` 는 이 전환 줄뿐이다(그 외 문서 링크는 GitHub blob 으로 재작성됨).
 */
function hideInlineLangSwitcher(html, otherHref) {
  // 동적 RegExp(ReDoS 경고) 회피 — 문자열 인덱스로 해당 단락만 정확히 처리.
  const at = html.indexOf(`href="${otherHref}"`);
  if (at < 0) return html;
  const open = html.lastIndexOf('<p>', at); // 감싸는 <p> 시작 (HTML 은 <p> 중첩 불가)
  const close = html.indexOf('</p>', at);
  if (open < 0 || close < 0) return html;
  return (
    html.slice(0, open) +
    '<p class="inline-lang" aria-hidden="true">' +
    html.slice(open + '<p>'.length, close + '</p>'.length) +
    html.slice(close + '</p>'.length)
  );
}

/** HTML 속성/텍스트 escape (title·description 용 — 신뢰 입력이나 정합성 위해). */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 페이지 HTML 문서 합성. */
function renderPage(page, bodyHtml) {
  const { lang, title, description, switcher } = page;
  const otherLink = `<a class="lang-link" href="${switcher.other.href}">${esc(switcher.other.label)}</a>`;
  const currentLink = `<span class="lang-link active" aria-current="page">${esc(switcher.current)}</span>`;
  // 언어 순서는 두 페이지 공통(EN | KO 표기 통일)
  const nav = lang === 'en' ? `${currentLink}<span class="sep">·</span>${otherLink}` : `${otherLink}<span class="sep">·</span>${currentLink}`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="site-header">
  <a class="site-title" href="${lang === 'en' ? 'index.html' : 'ko.html'}">multi-account-tool <code>mat</code></a>
  <nav class="lang-switcher" aria-label="language">${nav}</nav>
</header>
<main class="markdown-body">
${bodyHtml}
</main>
<footer class="site-footer">
  <a href="https://github.com/${REPO}">GitHub</a> ·
  <span>Generated from <code>${esc(page.src)}</code> by <code>scripts/build-docs.mjs</code> — do not edit by hand.</span>
</footer>
</body>
</html>
`;
}

/** GitHub-유사 라이트/다크 반응형 스타일. */
const STYLE_CSS = `/* 생성물 — scripts/build-docs.mjs 의 STYLE_CSS 를 편집하세요. */
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0;
  --link: #0969da; --code-bg: #eff1f3; --pre-bg: #f6f8fa; --header-bg: #f6f8fa;
  --table-stripe: #f6f8fa; --accent: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d;
    --link: #4493f8; --code-bg: #6e76811f; --pre-bg: #161b22; --header-bg: #161b22;
    --table-stripe: #161b22; --accent: #4493f8;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
/* 키보드 포커스 가시화 (모든 인터랙티브 요소 공통) */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  /* 한글: OS 네이티브 폰트 우선(외부 CDN 미사용) — macOS/iOS·Windows·Linux 순. */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR", Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.6;
}
.site-header {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.75rem 1.25rem; background: var(--header-bg);
  border-bottom: 1px solid var(--border); backdrop-filter: saturate(1.2) blur(4px);
}
.site-title { font-weight: 600; color: var(--fg); text-decoration: none; font-size: 1.05rem; }
.site-title code, .site-footer code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 5px; font-size: 0.9em; }
.lang-switcher { font-size: 0.95rem; }
.lang-link { color: var(--link); text-decoration: none; }
/* active 표시는 색+굵기에 더해 밑줄로 — color-only 신호 회피(검증 LOW). */
.lang-link.active { color: var(--muted); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
.inline-lang { /* 헤더 nav 와 중복되는 본문 내 언어 전환 줄 (aria-hidden) */ }
.lang-switcher .sep { color: var(--muted); margin: 0 0.4rem; }
.markdown-body { max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
.markdown-body h1, .markdown-body h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin-top: 1.6em; }
.markdown-body h1 { font-size: 2rem; margin-top: 0.2em; }
.markdown-body h2 { font-size: 1.5rem; }
.markdown-body h3 { font-size: 1.25rem; margin-top: 1.4em; }
.markdown-body a { color: var(--link); text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body code {
  background: var(--code-bg); padding: 0.2em 0.4em; border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.88em;
}
.markdown-body pre {
  background: var(--pre-bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 1rem; overflow-x: auto; line-height: 1.45;
}
.markdown-body pre code { background: none; padding: 0; font-size: 0.85em; }
.markdown-body table { border-collapse: collapse; display: block; width: max-content; max-width: 100%; overflow-x: auto; margin: 1rem 0; }
.markdown-body th, .markdown-body td { border: 1px solid var(--border); padding: 0.5rem 0.9rem; text-align: left; min-width: 5rem; white-space: nowrap; }
/* 마지막 열(보통 긴 설명/주의)은 줄바꿈 허용 — 좁은 화면에서 셀 붕괴 방지 + 가독성(검증 MED). */
.markdown-body th:last-child, .markdown-body td:last-child { white-space: normal; min-width: 12rem; }
.markdown-body tr:nth-child(2n) { background: var(--table-stripe); }
.markdown-body blockquote { margin: 1rem 0; padding: 0 1rem; color: var(--muted); border-left: 0.25em solid var(--border); }
.markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
.markdown-body img { max-width: 100%; }
.markdown-body del { color: var(--muted); }
.site-footer {
  max-width: 860px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem;
  border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem;
}
.site-footer a { color: var(--link); text-decoration: none; }
@media (max-width: 600px) {
  .markdown-body { padding: 1.25rem 1rem 2rem; }
  body { font-size: 15px; }
  .site-header { padding: 0.6rem 1rem; }
  /* 가로 스크롤 가능한 wide 코드블록에 우측 페이드 힌트 — 모바일에서 스크롤 가능함을 시사(검증 MED). */
  .markdown-body pre {
    background-image: linear-gradient(to right, transparent calc(100% - 1.5rem), var(--pre-bg));
    background-attachment: local;
  }
}
`;

async function build() {
  marked.setOptions({ gfm: true, breaks: false });
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const page of PAGES) {
    const md = await fs.readFile(join(ROOT, page.src), 'utf8');
    const rawHtml = marked.parse(md);
    const linked = rewriteLinks(addHeadingIds(rawHtml));
    const html = hideInlineLangSwitcher(linked, page.switcher.other.href);
    await fs.writeFile(join(OUT_DIR, page.out), renderPage(page, html));
    process.stdout.write(`build-docs: ${page.src} → site/${page.out}\n`);
  }

  await fs.writeFile(join(OUT_DIR, 'style.css'), STYLE_CSS);
  // .nojekyll: Actions 배포에선 불필요하나, /docs 브랜치 소스로 전환해도 Jekyll 처리를 막아 안전.
  await fs.writeFile(join(OUT_DIR, '.nojekyll'), '');
  process.stdout.write('build-docs: site/style.css, site/.nojekyll\n');
}

build().catch((err) => {
  process.stderr.write(`build-docs 실패: ${err?.stack ?? err}\n`);
  process.exit(1);
});
