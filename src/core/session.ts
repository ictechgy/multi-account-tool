/**
 * 세션별 자격증명 격리 (`mat session`).
 *
 * `mat exec` 는 OS 전역 swap 의 **시간 격리**라 두 터미널이 동시에 다른 계정을 못 쓴다.
 * session 은 자식 프로세스에 env(예: `CODEX_HOME`)를 주입해 각 CLI 가 **세션 전용 격리
 * 디렉토리**에서 자격증명을 읽게 한다 → 동시 다계정. 전역 swap/lock 은 사용하지 않는다.
 *
 * materialize 전략 — **copy-isolate + allow-list** (ralplan consensus, 스펙 §4):
 *  - 자격증명: mat 이 새로 만든 fresh 세션 디렉토리에 0600 으로 **복사**(symlink 아님).
 *    `writeFileAtomic` 의 mkdir/rename 은 symlink-safe 가 아니지만(io-atomic.ts), fresh
 *    non-symlink 경로에만 쓰므로 base 오염 경로가 구조적으로 없다.
 *  - allow-list(`SessionRoot.share`/`shareDirs`): read-mostly 비-secret config/asset tree
 *    (예: codex `config.toml`, `skills/`)를
 *    base 원본에서 세션 디렉토리로 **0600 파일/0700 디렉토리 복사**한다(symlink 아님 — issue #72). 세션 내 CLI 가
 *    그 config 를 수정해도(예: `codex mcp add`/`plugin add` 가 `[mcp_servers.*]` 같은
 *    authority-bearing 설정을 실제로 기록함 — 실측 확인) 격리본만 바뀌고 base 는 오염되지 않는다.
 *    격리본은 종료 시 폐기되며 재캡처(creds 전용) 대상이 아니라 write-back 이 없다. base 대상이
 *    symlink 면 거부(fail-closed).
 *  - 그 외 base 엔트리: materialize 안 함(세션 내 ephemeral) — fail-closed.
 *
 * 종료 재캡처는 **2-phase commit(stage → commit)** 으로 split(절반 새/절반 옛 토큰)을
 * 방지한다 (PR #61 quad-review Codex H1 정정 — 단순 per-cred `Promise.race` timeout 은
 * hung write 를 취소하지 못해, timeout 후 그 write 가 late-landing 하면 롤백된 cred 와
 * 섞여 split 이 재발생했다). 새 설계: ① 모든 cred 의 새 값을 프로필 경로 옆 staging 파일에
 * 먼저 쓴다(라이브 무변경 — hang/late-landing 해도 staging 만 오염). ② 전부 stage 성공 후
 * 일괄 commit(rename). rename 은 동일 fs 내 빠른 atomic 이라 잔여 split 윈도우가 byte-write
 * 전체에서 rename 으로 축소된다(catastrophic fs 한정). 부분 commit 실패는 backup 으로 역순
 * 원복(없던 cred 는 삭제). 각 단계엔 liveness 보호용 cred 단위 timeout 을 유지한다.
 *
 * 이 모듈은 부작용 코어(planSession/materializeSession/recaptureSession/removeSessionDir)
 * 를 export 한다. spawn/시그널/라이프사이클(runSession 등)은 PR-S3 에서 추가된다.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { findCliDef } from './cli-defs.js';
import { UsageError, errorMessage } from './errors.js';
import { writeFileAtomic } from './io-atomic.js';
import { acquireRecaptureLock, isProcessAlive, sanitizeForStderr } from './lockfile.js';
import {
  expandTilde,
  sessionDir,
  sessionsDir,
  validateSessionId,
  validateShareRel
} from './paths.js';
import {
  commitStagedFile,
  discardStagedFile,
  profileExists,
  readProfileFile,
  removeProfileFile,
  stageProfileFile,
  validateProfileName,
  writeProfileFile
} from './profile-store.js';
import { getRecaptureTimeoutMs, withTimeout } from './timeout.js';
import type { CliDef, SessionShareDir } from './types.js';

const DEFAULT_SHARE_DIR_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_SHARE_DIR_MAX_FILES = 2000;
const DEFAULT_SHARE_DIR_MAX_ENTRIES = 2500;
const DEFAULT_SHARE_DIR_MAX_DEPTH = 16;
const SHARE_DIR_READ_CHUNK_BYTES = 64 * 1024;

/** 시작 시점에 고정되는 자격증명 매핑 (종료 시 재계산 금지 — 시작/종료 불일치 차단). */
interface SessionCred {
  /** 프로필 내 파일명 (readProfileFile/writeProfileFile 의 fileName). */
  saveAs: string;
  /** base 기준 상대경로 (= 세션 디렉토리 내 격리본 위치). */
  rel: string;
  /** 세션 격리본 절대경로 (실파일, non-symlink). */
  absInSession: string;
}

interface MaterializedShareDir {
  /** base 기준 상대 디렉토리(root 단일 세그먼트). */
  rel: string;
  maxBytes: number;
  maxFiles: number;
  maxEntries: number;
  maxDepth: number;
}

interface ShareDirRootGuard {
  path: string;
  real: string;
  dev: number;
  ino: number;
}

/** 한 env-root 의 materialize 계획. */
interface MaterializedRoot {
  /** 주입할 env var 이름. */
  env: string;
  /** 세션 디렉토리 내 이 root 의 디렉토리 (env 값으로 주입 — base 의 부모일 수 있음, envSubdir 참고). */
  dir: string;
  /**
   * 자격증명/share 격리본의 실제 루트. envSubdir 가 있으면 `join(dir, envSubdir)`(예: gemini
   * `<dir>/.gemini`), 없으면 `dir` 과 동일. base 내용과 1:1 미러 — cred/share 경로 합성의 기준.
   */
  credRoot: string;
  /** 실제 base 절대경로 (allow-list 복사 대상 계산용). */
  baseAbs: string;
  /** 이 root 의 자격증명 격리본 목록. */
  creds: SessionCred[];
  /** base 에서 세션으로 0600 복사할 read-mostly config (base 상대경로, cred 와 disjoint, write-back 없음 — #72). */
  share: string[];
  /** base 에서 세션으로 재귀 복사할 read-mostly 디렉토리 (copy-isolate, write-back 없음). */
  shareDirs: MaterializedShareDir[];
  /** 이 root 를 사용하는 세션 시작 시 stderr 로 출력할 사용자 경고(있으면). */
  warning?: string;
}

/** 시작 시점 고정 세션 계획. */
export interface SessionPlan {
  id: string;
  cli: string;
  profile: string;
  roots: MaterializedRoot[];
  /** Command-scoped session run 전용 자격증명 격리본. env root 없이 builtin CLI argv 로 강제 주입된다. */
  commandCreds?: SessionCred[];
  /** Command-scoped session run 전용 보조 파일. 재캡처 대상이 아니며 세션 종료 시 폐기된다. */
  commandExtraFiles?: Array<{ rel: string; absInSession: string; content: string }>;
}

export interface SessionRunPreflightBlocker {
  phase: string;
  code: string;
  message: string;
}

export interface SessionRunPreflightPhase {
  id: string;
  status: 'ok' | 'blocked' | 'skipped';
}

export interface SessionRunPreflightReport {
  schemaVersion: 1;
  cliId: string;
  profileName: string;
  args: string[];
  ok: boolean;
  supported: boolean;
  profileExists: boolean | null;
  executable?: string;
  blockers: SessionRunPreflightBlocker[];
  warnings: string[];
  phases: SessionRunPreflightPhase[];
}

/** source(file)가 base 의 직속 자식인지 — rel 이 비어있지 않고 `..`/구분자 미포함. */
function directChildRel(baseAbs: string, fileAbs: string): string | null {
  const rel = relative(baseAbs, fileAbs);
  if (rel === '' || rel.startsWith('..') || rel.includes(sep)) return null;
  return rel;
}

/**
 * SessionRoot.envSubdir 검증 — validateShareRel(traversal-safe: 절대/`..`/구분자/빈값/NUL 거부)에
 * **단일 세그먼트** 제약을 더한다. 다중 세그먼트(`a/b`)를 막아, credRoot 의 중간 디렉토리 생성
 * 단계에서 생길 수 있는 symlink TOCTOU(materializeSession 은 마지막 컴포넌트만 symlink 검증)를
 * 원천 차단한다 (security 리뷰 L1, fail-closed). 현재 빌트인은 gemini `.gemini` 단일 세그먼트뿐 —
 * 다중 세그먼트가 필요해지면 컴포넌트별 검증을 별도 도입한다.
 */
function validateEnvSubdir(rawSubdir: string): string {
  const sub = validateShareRel(rawSubdir);
  if (sub.includes('/')) {
    throw new UsageError(`envSubdir 는 단일 세그먼트여야 합니다 (중간 디렉토리 symlink 회피): ${rawSubdir}`);
  }
  return sub;
}

function validatePositiveLimit(raw: number | undefined, fallback: number, label: string): number {
  const value = raw ?? fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${label} 는 양의 정수여야 합니다: ${String(raw)}`);
  }
  return value;
}

function validateShareDir(rawDir: SessionShareDir): MaterializedShareDir {
  const rel = validateShareRel(rawDir.rel);
  if (rel.includes('/')) {
    throw new UsageError(
      `shareDirs 항목은 단일 세그먼트여야 합니다 (디렉토리 root symlink TOCTOU 방지): ${rawDir.rel}`
    );
  }
  return {
    rel,
    maxBytes: validatePositiveLimit(rawDir.maxBytes, DEFAULT_SHARE_DIR_MAX_BYTES, 'shareDirs.maxBytes'),
    maxFiles: validatePositiveLimit(rawDir.maxFiles, DEFAULT_SHARE_DIR_MAX_FILES, 'shareDirs.maxFiles'),
    maxEntries: validatePositiveLimit(rawDir.maxEntries, DEFAULT_SHARE_DIR_MAX_ENTRIES, 'shareDirs.maxEntries'),
    maxDepth: validatePositiveLimit(rawDir.maxDepth, DEFAULT_SHARE_DIR_MAX_DEPTH, 'shareDirs.maxDepth')
  };
}

/**
 * CliDef.session + def.sources → SessionPlan (시작 시점 매핑 고정).
 * 검증 실패는 UsageError throw (세션 생성 전 중단):
 *  - session 미지정 → 세션 격리 미지원
 *  - 비-file source / base 미커버 / 비직속 → throw
 *  - share ∩ creds(rel) ≠ ∅ → throw
 */
export function planSession(def: CliDef, profile: string, id: string): SessionPlan {
  validateSessionId(id);
  const spec = def.session;
  if (!spec || spec.roots.length === 0) {
    throw new UsageError(`'${def.id}' 는 세션 격리를 지원하지 않습니다 (env override 미지원).`);
  }

  const rootData = spec.roots.map((r) => ({
    root: r,
    // 후행 구분자 제거 — `/` 와 `\`(Windows) 모두 처리 (Antigravity LOW).
    baseAbs: expandTilde(r.base).replace(/[/\\]+$/, ''),
    creds: [] as SessionCred[]
  }));

  for (const src of def.sources) {
    if (src.type !== 'file') {
      // keychain(macOS claude)/os-keyring(linux goose) 자격증명은 파일이 아니라 OS 보안 저장소에
      // 있어, env 디렉토리 리다이렉트(예: CLAUDE_CONFIG_DIR)로는 격리할 수 없다 — 그 env 는 파일
      // 경로만 옮길 뿐 keychain/keyring entry 는 그대로다. 따라서 file source 만 세션 격리한다.
      throw new UsageError(
        `세션 격리는 file source 만 지원합니다 (${def.id}: '${src.type}' source). ` +
          `keychain/OS-keyring 자격증명은 env 디렉토리 리다이렉트로 격리할 수 없습니다.`
      );
    }
    const fileAbs = expandTilde(src.path);
    // rel 을 한 번만 계산 — base 직속이면 string, 아니면 null (이중 호출 제거, Antigravity LOW).
    const matches = rootData
      .map((rd) => ({ rd, rel: directChildRel(rd.baseAbs, fileAbs) }))
      .filter((m): m is { rd: (typeof rootData)[number]; rel: string } => m.rel !== null);
    if (matches.length !== 1) {
      throw new UsageError(
        `source '${src.path}' 가 정확히 1개 root 의 base 직속이 아닙니다 ` +
          `(매칭 ${matches.length}개). 비직속 자격증명은 1차 미지원.`
      );
    }
    const { rd, rel } = matches[0];
    rd.creds.push({ saveAs: src.saveAs, rel, absInSession: '' });
  }

  const roots: MaterializedRoot[] = rootData.map((rd) => {
    const dir = join(sessionDir(id), rd.root.env);
    // env 가 base 의 부모를 가리키는 CLI(예: gemini `GEMINI_CLI_HOME` → `<dir>/.gemini`)는
    // envSubdir 로 자격증명 루트를 한 단계 내린다. validateEnvSubdir 가 traversal-safe + **단일
    // 세그먼트** 를 강제하고, credRoot 가 주입 dir 안에 lexical 봉쇄됨을 재확인 — credRoot 가 dir
    // 밖을 가리키지 못한다. 미지정(undefined)이면 env 가 곧 base 라 credRoot = dir (기존
    // codex/kimi/qwen/crush 동작 불변).
    const credRoot = rd.root.envSubdir != null ? join(dir, validateEnvSubdir(rd.root.envSubdir)) : dir;
    assertLexicallyContained(dir, credRoot);
    // share 항목 traversal-safe 검증 (절대/`..`/구분자 거부) — 정규화된 rel 로 통일 (Codex/Claude MED).
    // share 는 **단일 세그먼트**만 허용한다 (nested 'a/b.json' 거부). nested share 는 세션측 중간
    // 디렉토리 생성이 필요해 path-based traversal 의 TOCTOU race(lstat↔mkdir/write 사이 컴포넌트
    // symlink 교체)를 구조적으로 안고 가는데(quad-review Codex), 현 빌트인은 nested share 를 쓰지
    // 않으므로(codex='config.toml' 단일, gemini=∅) 미지원으로 봉쇄한다. 단일 세그먼트면 copyParent
    // 가 항상 credRoot(materializeSession 이 이미 생성·non-symlink 검증)라 중간 컴포넌트 자체가 없다.
    const share = (rd.root.share ?? []).map((s) => {
      const seg = validateShareRel(s);
      if (seg.includes('/')) {
        throw new UsageError(
          `share 항목은 단일 세그먼트여야 합니다 (nested 디렉토리 symlink TOCTOU 방지): ${s}`
        );
      }
      return seg;
    });
    const credRels = new Set(rd.creds.map((c) => c.rel));
    for (const s of share) {
      if (credRels.has(s)) {
        throw new UsageError(`share 항목 '${s}' 가 자격증명과 겹칩니다 (자격증명은 항상 격리 복사).`);
      }
    }
    const shareDirs = (rd.root.shareDirs ?? []).map(validateShareDir);
    const seenShareDirs = new Set<string>();
    for (const shareDir of shareDirs) {
      if (seenShareDirs.has(shareDir.rel)) {
        throw new UsageError(`shareDirs 항목 '${shareDir.rel}' 가 중복됩니다.`);
      }
      seenShareDirs.add(shareDir.rel);
      if (credRels.has(shareDir.rel)) {
        throw new UsageError(`shareDirs 항목 '${shareDir.rel}' 가 자격증명과 겹칩니다.`);
      }
      if (share.includes(shareDir.rel)) {
        throw new UsageError(`shareDirs 항목 '${shareDir.rel}' 가 share 파일 allow-list 와 겹칩니다.`);
      }
    }
    return {
      env: rd.root.env,
      dir,
      credRoot,
      baseAbs: rd.baseAbs,
      share,
      shareDirs,
      warning: rd.root.warning,
      creds: rd.creds.map((c) => ({ ...c, absInSession: join(credRoot, c.rel) }))
    };
  });

  return { id, cli: def.id, profile, roots };
}

/**
 * copy-isolate + allow-list 실제 생성 (스펙 §4). 부분 실패 시 removeSessionDir 후 rethrow.
 * 세션 디렉토리가 이미 존재하면 재사용 금지로 throw.
 */
export async function materializeSession(plan: SessionPlan): Promise<void> {
  const sdir = sessionDir(plan.id);
  // 부모(sessionsDir) 보장 후, 세션 디렉토리는 **비재귀 mkdir** 로 생성 — 이미 존재하면 EEXIST
  // 로 즉시 실패해 pathExists→mkdir 의 TOCTOU 윈도우를 제거한다 (Codex MEDIUM, lockfile
  // tryAcquire 패턴 동형).
  await fs.mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(sdir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`세션 디렉토리가 이미 존재합니다: ${plan.id}`);
    }
    throw err;
  }
  try {
    // 방금 만든 세션 디렉토리가 symlink 가 아닌지 재확인 (defense-in-depth).
    if ((await fs.lstat(sdir)).isSymbolicLink()) {
      throw new Error(`세션 디렉토리가 symlink 입니다: ${sdir}`);
    }
    for (const root of plan.roots) {
      await fs.mkdir(root.dir, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(root.dir)).isSymbolicLink()) {
        throw new Error(`세션 root 가 symlink 입니다: ${root.dir}`);
      }
      // envSubdir(예: gemini `.gemini`)로 cred 루트가 dir 하위면 명시 생성 + symlink 검증 —
      // root.dir 와 동형 방어(fresh non-symlink 경로 보장). credRoot===dir 면 위에서 이미 처리됨.
      if (root.credRoot !== root.dir) {
        // 단일 세그먼트 envSubdir(validateEnvSubdir 강제)라 credRoot 는 방금 만든 non-symlink root.dir 의
        // **직속 자식**이다 → 비재귀 mkdir. 이미 존재하면(특히 symlink) EEXIST 로 즉시 실패해(fail-closed),
        // recursive mkdir 이 기존 symlink 를 silent 추종하는 TOCTOU 를 차단한다 (quad-review agy MEDIUM).
        await fs.mkdir(root.credRoot, { mode: 0o700 });
        if ((await fs.lstat(root.credRoot)).isSymbolicLink()) {
          throw new Error(`세션 cred 루트가 symlink 입니다: ${root.credRoot}`);
        }
      }
      // (먼저) 자격증명 격리본 복사 — fresh non-symlink 경로라 io-atomic 안전.
      for (const cred of root.creds) {
        const value = await readProfileFile(plan.cli, plan.profile, cred.saveAs);
        if (value == null) {
          throw new UsageError(
            `프로필에 캡처된 자격증명이 없습니다: ${plan.cli}/${plan.profile}/${cred.saveAs}. ` +
              `먼저 mat 으로 자격증명을 캡처하세요.`
          );
        }
        await writeFileAtomic(cred.absInSession, value, { durable: false });
      }
      // (나중) allow-list 복사 — 양측 경로 봉쇄 검증 (스펙 §4.2, copy-isolate #72).
      for (const shareRel of root.share) {
        await materializeShareCopy(root, shareRel);
      }
      for (const shareDir of root.shareDirs) {
        await materializeShareDirCopy(root, shareDir);
      }
    }
    await materializeCommandOnlyFiles(plan);
  } catch (err) {
    await removeSessionDir(plan.id).catch(() => {
      /* best-effort 롤백 — 원본 에러 전파 */
    });
    throw err;
  }
}

async function materializeCommandOnlyFiles(plan: SessionPlan): Promise<void> {
  const creds = plan.commandCreds ?? [];
  const extras = plan.commandExtraFiles ?? [];
  if (creds.length === 0 && extras.length === 0) return;

  const commandDir = join(sessionDir(plan.id), 'command');
  await fs.mkdir(commandDir, { mode: 0o700 });
  const stat = await fs.lstat(commandDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`command-only 세션 디렉토리가 정상 디렉토리가 아닙니다: ${sessionPathForError(commandDir)}`);
  }

  for (const cred of creds) {
    assertLexicallyContained(commandDir, cred.absInSession);
    const value = await readProfileFile(plan.cli, plan.profile, cred.saveAs);
    if (value == null) {
      throw new UsageError(
        `프로필에 캡처된 자격증명이 없습니다: ${plan.cli}/${plan.profile}/${cred.saveAs}. ` +
          `먼저 mat 으로 자격증명을 캡처하세요.`
      );
    }
    await writeFileAtomic(cred.absInSession, value, { durable: false });
  }

  for (const file of extras) {
    assertLexicallyContained(commandDir, file.absInSession);
    await writeFileAtomic(file.absInSession, file.content, { durable: false });
  }
}

/**
 * allow-list 항목 1개를 base 원본에서 세션 디렉토리로 **0600 복사**한다 (copy-isolate, #72).
 *
 * **왜 symlink 가 아니라 복사인가**: codex 는 `config.toml` 을 read-only 로만 쓰지 않는다 —
 * `codex mcp add`/`codex plugin add` 등이 `[mcp_servers.*]` 같은 authority-bearing 설정을
 * config.toml 에 **실제로 기록**한다(실측 확인). symlink 공유였다면 세션 안에서 그 명령을 쓰는
 * 순간 base `~/.codex/config.toml` 이 변경돼 세션 격리가 깨지고 동시 세션끼리 간섭한다. 복사하면
 * 세션의 수정은 격리본에만 남고, 격리본은 종료 시 removeSessionDir 로 폐기되며 재캡처(creds 전용)
 * 대상이 아니라 write-back 이 발생하지 않는다. 세션 시작 시점의 사용자 설정 재현(UX)은 유지된다.
 *
 * 스펙 §4.2 양측 검증 (symlink 공유 시절의 봉쇄를 복사에도 그대로 유지):
 *  (b) base 측: 대상이 symlink 면 거부(fail-closed) + 대상 부모가 base realpath 하위로 봉쇄
 *      (nested shareRel 의 symlink 컴포넌트 escape 차단). 읽기는 O_NOFOLLOW 로 열어 lstat→read
 *      사이 symlink swap(TOCTOU)에도 마지막 컴포넌트 추적을 막는다(writeFileAtomic tmp 와 동형).
 *  (a) 세션 측: 복사 부모가 실제 디렉토리(symlink 아님)인지 검증 후 0600 atomic 복사.
 * shareRel 은 planSession 의 validateShareRel 로 이미 traversal-safe.
 */
async function materializeShareCopy(root: MaterializedRoot, shareRel: string): Promise<void> {
  const target = join(root.baseAbs, shareRel);
  // 방어적 봉쇄 (#71 결함4): shareRel 은 planSession 의 validateShareRel 로 진입 시점에 이미
  // traversal/absolute 가 차단돼 join 결과가 base 안에 있음이 보장된다. 그럼에도 아래 optional
  // ENOENT skip 이 base-containment 검증보다 먼저이므로, "정규화된 target 이 base 안"임을 **존재
  // 여부와 무관하게 순수 경로 레벨로 재확인**한 뒤 skip 한다(부재 대상이라 realpath 는 못 씀).
  // 이로써 ENOENT skip 은 base 봉쇄가 보장된 경로에만 적용된다 — fail-closed 유지.
  assertLexicallyContained(root.baseAbs, target);
  // share 대상이 base에 없으면 optional 복사로 간주해 건너뛴다(config.toml 등 read-mostly
  // 설정은 부재해도 세션 진행 무관, 자격증명 아님). ENOENT 이외의 예기치 못한 오류(권한 등)는
  // 그대로 surface한다(CLAUDE.md 에러 무시 금지 원칙). 아래 symlink/비-파일/escape 보안 검증은
  // 대상이 존재할 때 fail-closed 유지.
  let tst;
  try {
    tst = await fs.lstat(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (tst.isSymbolicLink()) {
    throw new Error(`allow-list 대상이 symlink 입니다 (복사 거부): ${sessionPathForError(target)}`);
  }
  // 일반 파일만 복사 (PR #61 2회차 Forge): 디렉토리를 통째로 복사하면 그 안의 nested/미래 파일·
  // symlink 가 개별 allow-list 없이 노출돼 좁은 공유 계약이 깨진다. 디렉토리 공유는 미지원.
  if (!tst.isFile()) {
    throw new Error(
      `allow-list 대상이 일반 파일이 아닙니다 (디렉토리 공유 미지원): ${sessionPathForError(target)}`
    );
  }
  await assertContainedRealpath(root.baseAbs, dirname(target));

  // 세션측 복사 위치는 자격증명 루트(credRoot) 기준 — envSubdir 가 있으면 base 내용과 1:1
  // 미러되도록 cred 와 동일 루트에 둔다(gemini 등). envSubdir 없으면 credRoot===dir.
  const copyPath = join(root.credRoot, shareRel);
  const copyParent = dirname(copyPath);
  // share 는 planSession 에서 **단일 세그먼트**로 강제되므로 copyParent 는 항상 credRoot 다 — 세션측에
  // 새 중간 디렉토리를 만들지 않는다(nested share path-traversal TOCTOU 원천 제거, quad-review Codex).
  // credRoot 는 materializeSession 이 이미 생성·non-symlink 검증했으나, 방어적으로 등식·non-symlink 를
  // 재확인한다(불변식이 깨지면 fail-closed).
  if (copyParent !== root.credRoot) {
    throw new Error(
      `allow-list share 가 credRoot 직속이 아닙니다(단일 세그먼트 위반): ${sessionPathForError(copyPath)}`
    );
  }
  const pst2 = await fs.lstat(copyParent);
  if (!pst2.isDirectory() || pst2.isSymbolicLink()) {
    throw new Error(
      `allow-list 세션측 부모(credRoot)가 정상 디렉토리가 아닙니다: ${sessionPathForError(copyParent)}`
    );
  }
  // base 원본을 O_NOFOLLOW 로 읽어(마지막 컴포넌트 symlink swap 차단) 격리본으로 0600 atomic 복사.
  // 세션측은 copyParent===credRoot(단일 세그먼트 share, 위에서 non-symlink 검증)이고 fresh non-symlink
  // 쓰기는 writeFileAtomic(O_EXCL|O_NOFOLLOW|0600)이 담당한다 — 자격증명 격리본 복사와 동일 보안 모델.
  // 중간 디렉토리를 만들지 않으므로 nested-path symlink TOCTOU 가 구조적으로 없다.
  // share 대상은 **UTF-8 텍스트 전제**(codex config.toml=TOML=UTF-8). 비-UTF-8 바이너리 config 를
  // share 에 추가하면 utf8 round-trip 으로 손상될 수 있어 미지원 — 그런 대상은 share 에 넣지 않는다.
  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content: string;
  try {
    content = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  await writeFileAtomic(copyPath, content, { durable: false });
}

interface ShareDirCopyStats {
  files: number;
  bytes: number;
  entries: number;
}

async function materializeShareDirCopy(root: MaterializedRoot, shareDir: MaterializedShareDir): Promise<void> {
  const sourceRoot = join(root.baseAbs, shareDir.rel);
  assertLexicallyContained(root.baseAbs, sourceRoot);

  let sourceStat;
  try {
    sourceStat = await fs.lstat(sourceRoot);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`allow-list 디렉토리가 symlink 입니다 (복사 거부): ${sessionPathForError(sourceRoot)}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`allow-list 디렉토리 대상이 디렉토리가 아닙니다: ${sessionPathForError(sourceRoot)}`);
  }
  const sourceRootReal = await assertContainedRealpath(root.baseAbs, sourceRoot);
  const guard: ShareDirRootGuard = {
    path: sourceRoot,
    real: sourceRootReal,
    dev: sourceStat.dev,
    ino: sourceStat.ino
  };

  const destRoot = join(root.credRoot, shareDir.rel);
  if (dirname(destRoot) !== root.credRoot) {
    throw new Error(`allow-list 디렉토리가 credRoot 직속이 아닙니다: ${sessionPathForError(destRoot)}`);
  }
  await assertSafeDestinationDir(root.credRoot);
  await fs.mkdir(destRoot, { mode: 0o700 });
  await assertSafeDestinationDir(destRoot);

  const stats: ShareDirCopyStats = { files: 0, bytes: 0, entries: 0 };
  await copyShareDirChildren(guard, sourceRoot, destRoot, shareDir, 0, stats);
}

async function copyShareDirChildren(
  guard: ShareDirRootGuard,
  sourceDir: string,
  destDir: string,
  shareDir: MaterializedShareDir,
  depth: number,
  stats: ShareDirCopyStats
): Promise<void> {
  const beforeStat = await assertShareDirSourceDirectory(guard, sourceDir);
  const dir = await fs.opendir(sourceDir);
  try {
    await assertShareDirSourceDirectory(guard, sourceDir, beforeStat);
    while (true) {
      await assertShareDirSourceDirectory(guard, sourceDir, beforeStat);
      const entry = await dir.read();
      await assertShareDirSourceDirectory(guard, sourceDir, beforeStat);
      if (entry == null) break;

      await copyShareDirEntry(guard, sourceDir, destDir, entry, shareDir, depth, stats);
    }
  } finally {
    await dir.close().catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ERR_DIR_CLOSED') throw err;
    });
  }
}

async function copyShareDirEntry(
  guard: ShareDirRootGuard,
  sourceDir: string,
  destDir: string,
  entry: { name: string },
  shareDir: MaterializedShareDir,
  depth: number,
  stats: ShareDirCopyStats
): Promise<void> {
  const sourcePath = join(sourceDir, entry.name);
  const destPath = join(destDir, entry.name);
  const entryDepth = depth + 1;
  assertShareDirDepth(shareDir, entryDepth, sourcePath);
  assertLexicallyContained(guard.path, sourcePath);
  assertLexicallyContained(destDir, destPath);
  assertShareDirEntryLimit(shareDir, stats, sourcePath);

  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`allow-list 디렉토리 하위 symlink 입니다 (복사 거부): ${sessionPathForError(sourcePath)}`);
  }
  if (stat.isDirectory()) {
    await assertShareDirSourceDirectory(guard, sourcePath, stat);
    await fs.mkdir(destPath, { mode: 0o700 });
    await assertSafeDestinationDir(destPath);
    await copyShareDirChildren(guard, sourcePath, destPath, shareDir, entryDepth, stats);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`allow-list 디렉토리 하위 항목이 일반 파일이 아닙니다: ${sessionPathForError(sourcePath)}`);
  }
  await copyShareDirFile(guard, sourcePath, destPath, shareDir, stats, stat);
}

async function copyShareDirFile(
  guard: ShareDirRootGuard,
  sourcePath: string,
  destPath: string,
  shareDir: MaterializedShareDir,
  stats: ShareDirCopyStats,
  preOpenStat: { dev: number; ino: number; isFile(): boolean; isSymbolicLink(): boolean; mode: number }
): Promise<void> {
  await assertSafeDestinationDir(dirname(destPath));
  await assertRealpathContained(guard.real, sourcePath);
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    assertSameInode(preOpenStat, openedStat, sourcePath);
    const postOpenStat = await fs.lstat(sourcePath);
    if (postOpenStat.isSymbolicLink()) {
      throw new Error(`allow-list 디렉토리 하위 symlink 입니다 (복사 거부): ${sessionPathForError(sourcePath)}`);
    }
    assertSameInode(openedStat, postOpenStat, sourcePath);
    await assertRealpathContained(guard.real, sourcePath);
    if (!openedStat.isFile()) {
      throw new Error(`allow-list 디렉토리 하위 항목이 일반 파일이 아닙니다: ${sessionPathForError(sourcePath)}`);
    }
    if (openedStat.nlink > 1) {
      throw new Error(`allow-list 디렉토리 하위 hardlink 파일은 복사하지 않습니다: ${sessionPathForError(sourcePath)}`);
    }
    if (stats.files + 1 > shareDir.maxFiles) {
      throw new Error(`allow-list 디렉토리 파일 수 초과 (${shareDir.maxFiles}): ${sessionPathForError(sourcePath)}`);
    }
    if (stats.bytes + openedStat.size > shareDir.maxBytes) {
      throw new Error(`allow-list 디렉토리 용량 초과 (${shareDir.maxBytes} bytes): ${sessionPathForError(sourcePath)}`);
    }
    const content = await readBoundedFile(handle, shareDir.maxBytes - stats.bytes, sourcePath);
    stats.files += 1;
    stats.bytes += content.byteLength;
    await writeFileAtomic(destPath, content, { durable: false, mode: copiedShareDirFileMode(openedStat.mode) });
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(handle: FileHandle, maxBytes: number, sourcePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const buf = Buffer.allocUnsafe(Math.min(SHARE_DIR_READ_CHUNK_BYTES, Math.max(1, maxBytes - total + 1)));
    const { bytesRead } = await handle.read(buf, 0, buf.length, null);
    if (bytesRead === 0) break;
    if (total + bytesRead > maxBytes) {
      throw new Error(`allow-list 디렉토리 용량 초과 (${maxBytes} bytes remaining): ${sessionPathForError(sourcePath)}`);
    }
    chunks.push(buf.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

function copiedShareDirFileMode(sourceMode: number): number {
  return (sourceMode & 0o111) !== 0 ? 0o700 : 0o600;
}

async function assertShareDirSourceDirectory(
  guard: ShareDirRootGuard,
  sourceDir: string,
  expected?: { dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean }
): Promise<{ dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean }> {
  await assertShareDirRootUnchanged(guard);
  assertLexicallyContained(guard.path, sourceDir);
  const stat = await fs.lstat(sourceDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`allow-list 디렉토리 하위 symlink 입니다 (복사 거부): ${sessionPathForError(sourceDir)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`allow-list 디렉토리 하위 항목이 디렉토리가 아닙니다: ${sessionPathForError(sourceDir)}`);
  }
  if (expected) assertSameInode(expected, stat, sourceDir);
  await assertRealpathContained(guard.real, sourceDir);
  return stat;
}

async function assertShareDirRootUnchanged(guard: ShareDirRootGuard): Promise<void> {
  const stat = await fs.lstat(guard.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`allow-list 디렉토리가 materialize 중 변경되었습니다: ${sessionPathForError(guard.path)}`);
  }
  assertSameInode(guard, stat, guard.path);
}

function assertSameInode(
  expected: { dev: number; ino: number },
  actual: { dev: number; ino: number },
  path: string
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`allow-list 디렉토리 항목이 materialize 중 변경되었습니다: ${sessionPathForError(path)}`);
  }
}

function assertShareDirEntryLimit(
  shareDir: MaterializedShareDir,
  stats: ShareDirCopyStats,
  sourcePath: string
): void {
  if (stats.entries + 1 > shareDir.maxEntries) {
    throw new Error(`allow-list 디렉토리 항목 수 초과 (${shareDir.maxEntries}): ${sessionPathForError(sourcePath)}`);
  }
  stats.entries += 1;
}

function assertShareDirDepth(shareDir: MaterializedShareDir, depth: number, sourcePath: string): void {
  if (depth > shareDir.maxDepth) {
    throw new Error(`allow-list 디렉토리 깊이 초과 (${shareDir.maxDepth}): ${sessionPathForError(sourcePath)}`);
  }
}

async function assertSafeDestinationDir(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`allow-list 세션측 디렉토리가 정상 디렉토리가 아닙니다: ${sessionPathForError(path)}`);
  }
}

/**
 * child 경로가 base 하위(또는 동일)인지 **순수 경로(lexical) 레벨**로 검증 — fs 접근 없음 (#71 결함4).
 * realpath(assertContainedRealpath)와 달리 대상이 존재하지 않아도 쓸 수 있어, optional share 의
 * ENOENT skip 전 봉쇄 재확인에 쓴다. symlink 컴포넌트 escape 는 대상 존재 시 assertContainedRealpath
 * 가 별도로 막는다(이 함수는 정규화된 경로의 `..` escape 만 본다).
 */
function assertLexicallyContained(baseAbs: string, childAbs: string): void {
  const rel = relative(baseAbs, childAbs);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`allow-list 대상이 base 밖을 가리킵니다: ${sessionPathForError(childAbs)}`);
  }
}

/** child 의 realpath 가 base realpath 하위(또는 동일)인지 — symlink 컴포넌트 escape 차단. */
async function assertContainedRealpath(baseAbs: string, childAbs: string): Promise<string> {
  const baseReal = await fs.realpath(baseAbs);
  const childReal = await fs.realpath(childAbs);
  assertRealpathStringContained(baseReal, childReal, childAbs);
  return childReal;
}

async function assertRealpathContained(baseReal: string, childAbs: string): Promise<string> {
  const childReal = await fs.realpath(childAbs);
  assertRealpathStringContained(baseReal, childReal, childAbs);
  return childReal;
}

function assertRealpathStringContained(baseReal: string, childReal: string, childAbs: string): void {
  const rel = relative(baseReal, childReal);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`allow-list 대상이 base 밖을 가리킵니다: ${sessionPathForError(childAbs)}`);
  }
}

/**
 * session allow-list 경로가 Error.message 를 거쳐 top-level stderr 에 노출될 수 있으므로,
 * throw 시점에 terminal control chars 를 제거한다. 경로 redact 가 아니라 표시 안전성 방어.
 */
function sessionPathForError(path: string): string {
  return sanitizeForStderr(path);
}

/** 재캡처 1건 단위 (preflight 수집물). */
interface RecaptureItem {
  saveAs: string;
  /** 프로필 현재값 (롤백 백업). 신규 프로필이면 null. 락 획득 이후 채운다(TOCTOU 차단). */
  backup: string | null;
  /** 격리본 새 값. */
  newValue: string;
}

/**
 * 종료 재캡처 (2-phase commit + 프로필 단위 advisory 락 — split 방지, issue #62).
 *
 *  - **phase 0 (락 밖)**: 각 cred 의 격리본 새 값만 수집한다. 격리본은 세션 전용(non-shared)이라
 *    락 밖 읽기가 정합성을 깨지 않는다. 후보 없으면 즉시 return.
 *  - **프로필 락 획득**: `acquireRecaptureLock`. best-effort — null(획득 실패/timeout)이면 경고
 *    1회 후 현행 lock-free 2-phase commit 으로 degrade(오늘 동작 보존, "오늘보다 나빠지지 않음").
 *  - **락 안 (try)**: backup-read(`readProfileFile`)를 **락 획득 이후**에 수행해 두 세션이 같은
 *    backup 을 보는 TOCTOU 를 차단한다(시나리오 3①). 이어서 phase 1(stage)→phase 2(commit), 실패
 *    시 compare-and-restore 역순 rollback. **release 는 finally** 에 둬 "release > 마지막 commit/
 *    rollback" 불변식을 구조적으로 보장한다(MAJOR-2, 시나리오 3②).
 *
 * 양쪽 세션이 모두 락 획득에 성공하면 backup-read→commit→rollback 전체가 직렬화돼 multi-cred 의
 * cred 별 winner 분기 split(compare-and-restore 가 cred 별 독립이라 흡수 못 하는 cross-cred 비일관)
 * 까지 제거된다. 한쪽이라도 락 실패 시 그 구간은 lock-free 로 degrade(같은 계정 한정 — wrong-account
 * 아님, 다음 사용 시 자가 치유). 스펙 §6.1 참조.
 */
export async function recaptureSession(plan: SessionPlan): Promise<void> {
  const items = await collectRecaptureItems(plan);
  if (items.length === 0) return;

  const release = await acquireRecaptureLock(plan.cli, plan.profile);
  if (!release) {
    process.stderr.write(
      `[mat] 프로필 락 획득 실패 — lock-free 재캡처로 진행: ` +
        `${sanitizeForStderr(plan.cli)}/${sanitizeForStderr(plan.profile)}\n`
    );
  }
  try {
    await runRecaptureLocked(plan, items); // 락 안: backup-read(TOCTOU 차단) → stage → commit → rollback
  } finally {
    if (release) await release(); // release 인덱스 > 마지막 commit/rollback 인덱스 보장
  }
}

/** phase 0 (락 밖): 각 cred 의 격리본 새 값만 수집. 격리본 부재는 안내 후 skip. backup 은 락 안에서 채운다. */
async function collectRecaptureItems(plan: SessionPlan): Promise<RecaptureItem[]> {
  const items: RecaptureItem[] = [];
  for (const root of plan.roots) {
    for (const cred of root.creds) {
      let newValue: string;
      try {
        newValue = await fs.readFile(cred.absInSession, 'utf8');
      } catch {
        process.stderr.write(
          `[mat] 세션 격리본 부재 — 재캡처 skip: ${sanitizeForStderr(plan.cli)}/${sanitizeForStderr(plan.profile)}/${sanitizeForStderr(cred.saveAs)}\n`
        );
        continue;
      }
      items.push({ saveAs: cred.saveAs, backup: null, newValue });
    }
  }
  for (const cred of plan.commandCreds ?? []) {
    let newValue: string;
    try {
      newValue = await fs.readFile(cred.absInSession, 'utf8');
    } catch {
      process.stderr.write(
        `[mat] 세션 격리본 부재 — 재캡처 skip: ${sanitizeForStderr(plan.cli)}/${sanitizeForStderr(plan.profile)}/${sanitizeForStderr(cred.saveAs)}\n`
      );
      continue;
    }
    items.push({ saveAs: cred.saveAs, backup: null, newValue });
  }
  return items;
}

/**
 * 락 안 재캡처 본문 — backup-read(TOCTOU 차단) → 2-phase commit → 실패 시 rollback.
 * 본 함수 전체가 프로필 락 보유 구간이다(release 는 호출자 finally).
 */
async function runRecaptureLocked(plan: SessionPlan, items: RecaptureItem[]): Promise<void> {
  // backup-read 는 반드시 락 획득 이후 (두 세션이 같은 backup 을 보는 TOCTOU 차단, 시나리오 3①).
  for (const it of items) {
    it.backup = await readProfileFile(plan.cli, plan.profile, it.saveAs);
  }

  const ms = getRecaptureTimeoutMs();

  // phase 1 — stage (라이브 무변경). hang/실패 → commit 0 → split 0.
  const staged: { it: RecaptureItem; path: string }[] = [];
  const pending: Promise<string>[] = []; // 각 stage 의 underlying(취소 불가) — late-land 정리용
  try {
    for (const it of items) {
      const underlying = stageProfileFile(plan.cli, plan.profile, it.saveAs, it.newValue);
      pending.push(underlying);
      const path = await withTimeout(underlying, ms, `stage(${it.saveAs})`);
      staged.push({ it, path });
    }
  } catch (err) {
    for (const s of staged) await discardStagedFile(s.path);
    // withTimeout 은 underlying 을 취소하지 못한다. timeout 으로 빠져나온 stage 가 늦게 완료
    // (late-land)되면 자격증명이 든 고아 `.recap-*` 가 남는다 → staged 에 없는(=미커밋) underlying
    // 의 결과 path 에 한해 정리를 연결한다 (PR #61 3회차 Codex). staged 가 완성된 catch 시점에
    // 연결하므로 flag 경쟁이 없고, 자기 path 만 건드려 동시 세션 staging sweep race 도 없다.
    const stagedPaths = new Set(staged.map((s) => s.path));
    for (const u of pending) {
      // discardStagedFile 은 내부 catch 로 reject 하지 않으나, detached 연속이라 명시 .catch 로
      // unhandled rejection 가능성을 봉인한다 (PR #61 3회차 Codex/Forge — defense-in-depth).
      void u.then(
        (p) => {
          if (!stagedPaths.has(p)) void discardStagedFile(p).catch(() => {});
        },
        () => {
          /* stage 자체 실패면 writeFileAtomic 가 자기 tmp 를 이미 정리 */
        }
      );
    }
    throw err;
  }

  // phase 2 — commit (staging → 라이브 rename). 부분 실패 → 미커밋 정리 + 커밋분 역순 원복.
  // commit 은 **withTimeout 으로 감싸지 않는다** (PR #61 2회차 Codex/Forge HIGH): rename 은 동일
  // fs 내 빠른 atomic 이지만 취소 불가라, timeout 후 늦게 landing 하면 committed 에 없어 롤백에서
  // 빠져 split 을 남긴다. 따라서 rename 은 완료/예외까지 기다린다 — 완료=committed 기록, 예외=미발생
  // 으로 확정돼 롤백이 정확해진다. (stall 가능한 byte-write 는 phase 1 staging 에서 이미 끝남)
  const committed: RecaptureItem[] = [];
  try {
    for (const s of staged) {
      await commitStagedFile(s.path, plan.cli, plan.profile, s.it.saveAs);
      committed.push(s.it);
    }
  } catch (err) {
    for (const s of staged) {
      if (!committed.includes(s.it)) await discardStagedFile(s.path);
    }
    for (const it of committed.reverse()) {
      await rollbackCred(plan, it, ms);
    }
    throw err;
  }
}

/**
 * 커밋된 cred 1건 원복 — backup 있으면 그 값으로, 없으면(종료 전 부재) 삭제. best-effort.
 *
 * **compare-and-restore** (PR #61 2회차 Codex/Claude): 동시에 같은 프로필을 재캡처한 다른
 * 세션이 우리 commit 값을 이미 자기 값으로 덮었다면, blind 원복은 그 값을 stale backup 으로
 * clobber 한다(두 세션 누구의 것도 아닌 상태). 따라서 **현재 디스크값이 우리가 commit 한 값
 * (it.newValue)일 때만** 원복한다 — 다른 세션이 바꿨으면 그대로 둬 last-writer-wins 를 보존한다.
 */
async function rollbackCred(plan: SessionPlan, it: RecaptureItem, ms: number): Promise<void> {
  try {
    const current = await readProfileFile(plan.cli, plan.profile, it.saveAs);
    if (current !== it.newValue) return; // 동시 세션/외부가 이미 변경 → clobber 회피
    if (it.backup == null) {
      await removeProfileFile(plan.cli, plan.profile, it.saveAs); // 종료 전 부재 → 삭제로 원복
    } else {
      await withTimeout(
        writeProfileFile(plan.cli, plan.profile, it.saveAs, it.backup),
        ms,
        `rollback(${it.saveAs})`
      );
    }
  } catch {
    /* best-effort — 원본 에러를 전파 */
  }
}

/** 세션 디렉토리 안전 삭제 (validateSessionId + sessionsDir 한정). symlink 는 링크만 제거. */
export async function removeSessionDir(id: string): Promise<void> {
  validateSessionId(id);
  const sdir = sessionDir(id);
  // defense-in-depth: 삭제 대상이 sessionsDir 하위인지 재확인 (validateSessionId 로 이미 traversal 차단).
  const root = sessionsDir();
  if (sdir !== join(root, id)) {
    throw new Error(`세션 디렉토리 경로 검증 실패: ${id}`);
  }
  await fs.rm(sdir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// PR-S3: runSession (spawn + 시그널 + finally) + 라이프사이클(list/stop/orphan)
// exec.ts 의 forwarder/settled-guard/finally 패턴 미러, 단 전역 swap/lock 미사용.
// ─────────────────────────────────────────────────────────────────────────────

/** 외부에서 잡고 자식에게 전달할 시그널 (exec.ts FORWARD_SIGNALS 동형). */
const SESSION_FORWARD_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** orphan 회수 TTL (ms). pid 죽음 AND startedAt 이 이보다 오래됐을 때만 회수 (M2). */
const ORPHAN_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * unknown(소유 미확정) 세션 회수 TTL (ms, default 24h). ORPHAN_TTL_MS(1h)보다 충분히 길어
 * 일시적 ps 실패 회복 시간을 보장한다 — pid 는 살아있으나 서명 조회 실패로 소유 확정 불가한
 * 세션을, ps 영구 불능 환경에서도 결국 회수해 orphan 디렉토리 무한 잔존을 막는다 (#63-1).
 */
const UNKNOWN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** MAT_UNKNOWN_SESSION_TTL_MS override 의 최소값 (ms, 1h). 그 미만은 거부 — 일시적 ps 실패 회복 보장. */
const UNKNOWN_TTL_MIN_MS = 3_600_000; // 1h

/** processStartSignature ps 호출 timeout (ms) — 행 방지. */
const PS_SIGNATURE_TIMEOUT_MS = 2_000;

/**
 * unknown 세션 회수 TTL (ms) — `MAT_UNKNOWN_SESSION_TTL_MS` 로 override 가능. **호출 시점 평가**
 * (getRecaptureTimeoutMs 동형) — test/daemon 이 env 를 동적으로 바꿔도 다음 호출부터 반영된다.
 *
 * **최소값 가드 1h**: override 가 1h 미만이거나 파싱 불가(음수/NaN/0)면 default(24h)로 폴백한다.
 * 너무 짧은 TTL 은 일시적 ps 실패 회복 시간을 없애 살아있는 unknown 세션을 조기 회수할 위험이 있다.
 */
function getUnknownTtlMs(): number {
  const raw = process.env.MAT_UNKNOWN_SESSION_TTL_MS;
  if (!raw) return UNKNOWN_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= UNKNOWN_TTL_MIN_MS ? n : UNKNOWN_TTL_MS;
}

/**
 * pidStart 서명 형식 버전. 서명 산출 방식(ps 포맷/필드)이 바뀌면 bump 한다. 기록된 서명이 현재
 * 버전과 다르면 비교 불가로 보아 `unknown`(보존)으로 처리 — 형식 차이를 pid 재사용으로 오인해
 * 살아있는 세션을 삭제하지 않게 한다 (PR #61 3회차 Codex). 미접두(옛 메타)도 `unknown`.
 */
const PID_SIG_VERSION = 'v1';

/**
 * 프로세스의 시작 서명(`ps -o lstart= -p <pid>`) — 부팅 후 고정값이라 pid 재사용 검출에 쓴다.
 *
 * pid 만으로는 죽은 mat 의 pid 가 재할당된 무관 프로세스와 구분할 수 없어, `stopSession` 이
 * 그 프로세스를 잘못 kill 하거나(파괴적) `reapOrphans` 가 stale 세션을 영구 보존할 수 있다
 * (PR #61 Codex H2). 시작 서명을 session.json 에 기록해두고 비교한다.
 *
 * macOS / Linux 의 `ps` 만 사용(프로젝트 타깃 OS). 미지원/조회 실패/타임아웃 시 null →
 * 호출부가 보수적 폴백. child_process 가 mock 된 단위 테스트에서는 execFile 부재 → null.
 *
 * `LC_ALL=C` + `TZ=UTC` 를 강제한다 (PR #61 2회차 Forge HIGH): `lstart` 출력은 locale/TZ 에
 * 따라 월/요일 표기·시각이 달라져, 같은 owner 라도 기록 시점과 조회 시점의 환경이 다르면 서명이
 * 불일치해 살아있는 세션을 stale 로 오판할 수 있다. 환경을 고정해 자기일관성을 보장한다. 단
 * `lstart` 는 1초 granularity 라 같은 pid·같은 초 재사용은 여전히 미탐(알려진 잔여 한계).
 */
export async function processStartSignature(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const cp = await import('node:child_process');
    if (typeof cp.execFile !== 'function') return null; // 일부 단위 테스트에서 mock-out
    const stdout = await new Promise<string>((resolve, reject) => {
      cp.execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { timeout: PS_SIGNATURE_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
        (err, out) => (err ? reject(err) : resolve(out))
      );
    });
    const sig = stdout.trim();
    return sig ? `${PID_SIG_VERSION}:${sig}` : null; // 버전 접두 — 형식 변경 감지용
  } catch {
    return null; // ps 부재/조회 실패/timeout → null (호출부가 보수적으로 폴백)
  }
}

/**
 * 세션 소유 프로세스의 신원 판정 (pid 재사용 방어, tri-state — PR #61 2회차 Forge HIGH).
 *
 *  - `dead-or-reused`: pid 가 죽었거나, 서명이 기록돼 있고 현재 서명도 읽혔는데 다름(재사용).
 *  - `owner`: pid 살아있고 + (서명 미기록 옛 메타 → liveness-only) 또는 (서명 일치).
 *  - `unknown`: pid 살아있고 서명은 기록돼 있으나 현재 서명을 못 읽음(ps 실패/타임아웃) → 소유
 *    여부 확정 불가.
 *
 * 단일 boolean 을 정반대 안전 바이어스(stop=kill / reap=delete) 두 곳에 쓰면, "불확실"을
 * `owner`로 접는 순간 stop 이 무관 프로세스를 kill 한다(H2 가 막으려던 바로 그 결함). 호출부가
 * `unknown` 을 각자 보수적으로(stop=신호·삭제 안 함, reap=보존) 처리하도록 3-state 로 분리한다.
 */
type OwnerStatus = 'owner' | 'dead-or-reused' | 'unknown';

/**
 * pid + 시작 서명으로 프로세스 신원을 판정하는 tri-state 코어. 소유 mat(classifyOwner)과
 * 자식 subshell(classifyChildOwner)이 동일 로직을 공유하게 추출했다 (#63-2).
 *
 *  - `dead-or-reused`: pid 죽음, 또는 서명이 기록·조회됐는데 불일치(재사용).
 *  - `owner`: pid 생존 + (서명 미기록 옛 메타 → liveness-only) 또는 (서명 일치).
 *  - `unknown`: pid 생존 + 서명 기록됐으나 현재값 조회 실패(ps 실패/타임아웃) → 확정 불가.
 *
 * **알려진 잔여 한계(부모·자식 공통)**: 서명은 `processStartSignature` 의 `ps -o lstart`(1초
 * granularity)라, pid 가 죽고 **같은 초 안에** 재할당된 무관 프로세스는 시작 서명까지 동일해
 * 'owner' 로 오판될 수 있다(미탐). 동일 OS 한계로, lstart 보다 정밀한 신원(예: PID 네임스페이스/
 * 시작 tick)이 없는 한 해소 불가 — 영향은 극히 좁은 타이밍 윈도우. 상세는 processStartSignature 참조.
 */
async function classifyPid(pid: number, pidStart: string | undefined): Promise<OwnerStatus> {
  if (!isProcessAlive(pid)) return 'dead-or-reused';
  if (!pidStart) return 'owner'; // 옛 메타(서명 미기록) — liveness-only
  // 기록된 서명이 현재 버전 형식이 아니면 비교 불가 → unknown(보존). 형식 차이를 재사용으로 오인해
  // 살아있는 세션을 dead-or-reused 로 삭제하는 것을 막는다 (PR #61 3회차 Codex).
  if (!pidStart.startsWith(`${PID_SIG_VERSION}:`)) return 'unknown';
  const liveSig = await processStartSignature(pid);
  if (!liveSig) return 'unknown'; // 현재값 조회 실패 → 확정 불가
  return liveSig === pidStart ? 'owner' : 'dead-or-reused';
}

/** 세션 소유 mat 프로세스의 신원 판정 (pid 재사용 방어, tri-state — PR #61 2회차 Forge HIGH). */
async function classifyOwner(meta: SessionMeta): Promise<OwnerStatus> {
  return classifyPid(meta.pid, meta.pidStart);
}

/**
 * 자식 subshell 프로세스의 신원 판정 (#63-2). 부모(classifyOwner)와 달리 **자식은 서명 필수**
 * 정책을 적용한다 (#71 결함2):
 *  - `childPid` 없는 옛 메타 → 'dead-or-reused' (자식 가드 skip — 소유 mat 만 보던 기존 동작 유지).
 *  - `childPid` 있으나 `childPidStart` 없음(서명 조회 실패) → **'unknown'** (liveness-only 'owner'
 *    금지). childPid/childPidStart 는 #63 에서 새로 도입된 필드라 부모처럼 옛-메타 하위호환 대상이
 *    아니다. 서명 없는 childPid 를 liveness-only 'owner' 로 접으면, 재사용된 child pid 가 무관
 *    프로세스를 자식으로 오인해 stale 세션을 영구 보존한다. 따라서 서명 없으면 unknown 으로 보내
 *    bounded TTL 회수 경로(결함3)를 타게 한다.
 *  - `childPid` + `childPidStart` 둘 다 있음 → classifyPid 로 정상 판정(서명 일치=owner/불일치=재사용).
 *
 * classifyPid 의 `!pidStart→owner`(liveness-only)는 부모용으로 보존하고, 여기서만 "서명 없는
 * childPid → unknown" 분기를 얇게 덧씌운다.
 */
async function classifyChildOwner(meta: SessionMeta): Promise<OwnerStatus> {
  if (meta.childPid == null) return 'dead-or-reused'; // 옛 메타 — 자식 추적 정보 없음
  // 죽은 자식 pid 는 서명 유무와 무관하게 dead-or-reused (재사용 무관 — 그냥 죽음).
  if (!isProcessAlive(meta.childPid)) return 'dead-or-reused';
  // 살아있으나 서명 미기록(ps 실패) → unknown. liveness-only 'owner' 금지(child pid 재사용 위험).
  if (!meta.childPidStart) return 'unknown';
  return classifyPid(meta.childPid, meta.childPidStart);
}

export interface SessionStartOptions {
  cliId: string;
  profileName: string;
}

export interface SessionCommandOptions extends SessionStartOptions {
  /** Arguments passed to the builtin CLI executable selected by `CliDef.sessionRun`. */
  args: string[];
}

export interface SessionResult {
  /** 자식(subshell) 종료 코드. signal 종료 시 null. */
  code: number | null;
  /** 자식이 받은 시그널 (있으면). */
  signal: NodeJS.Signals | null;
  /** 종료 재캡처 실패/timeout 시 설정. cli.tsx 가 별도 exit code 로 매핑. */
  recaptureError?: Error;
}

type SessionSpawnTarget =
  | { kind: 'shell' }
  | { kind: 'command'; executable: string; args: string[]; env?: Record<string, string | undefined> };

// Provider/API credential and endpoint envs that can bypass profile copy-isolation.
const SESSION_CHILD_PROVIDER_ENV_DENY_NAMES = [
  'AICORE_SERVICE_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_API_BASE',
  'DEEPSEEK_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_API_BASE',
  'GEMINI_BASE_URL',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'MOONSHOT_API_BASE',
  'MOONSHOT_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_API_BASE',
  'OPENAI_API_HOST',
  'OPENAI_API_TYPE',
  'OPENAI_API_VERSION',
  'OPENAI_API_DEPLOYMENT_ID',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION_ID',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_BASE',
  'OPENROUTER_BASE_URL',
  'QWEN_API_KEY',
  'SNOWFLAKE_CORTEX_PAT'
] as const;

// OpenCode session start can also bypass auth.json via env/config content.
const OPENCODE_BYPASS_ENV_NAMES = [
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_DB',
  'OPENCODE_MODELS_PATH',
  'OPENCODE_MODELS_URL',
  'OPENCODE_PERMISSION',
  'OPENCODE_TEST_HOME',
  'OPENCODE_TUI_CONFIG',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR'
] as const;

const AWS_CREDENTIAL_CHAIN_ENV_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_DEFAULT_PROFILE',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE'
] as const;

const GCP_VERTEX_CREDENTIAL_CHAIN_ENV_NAMES = [
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_AUTH_SUPPRESS_CREDENTIALS_WARNINGS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_PROJECT',
  'VERTEXAI_LOCATION',
  'VERTEXAI_PROJECT'
] as const;

const SESSION_CHILD_CREDENTIAL_ENV_DENY_NAMES = [
  ...SESSION_CHILD_PROVIDER_ENV_DENY_NAMES,
  ...OPENCODE_BYPASS_ENV_NAMES,
  ...AWS_CREDENTIAL_CHAIN_ENV_NAMES,
  ...GCP_VERTEX_CREDENTIAL_CHAIN_ENV_NAMES
] as const;

const SESSION_CHILD_CREDENTIAL_ENV_DENY = new Set(SESSION_CHILD_CREDENTIAL_ENV_DENY_NAMES);

const SESSION_CHILD_CREDENTIAL_ENV_HARDENING: Record<string, string> = {
  AWS_CONFIG_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/dev/null',
  GOOGLE_APPLICATION_CREDENTIALS: '/dev/null',
  NO_GCE_CHECK: 'true'
};

const GENERIC_CREDENTIAL_ENV_PATTERN =
  /(^|_)(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|SERVICE_KEY|CLIENT_SECRET|SECRET_KEY|TOKEN|PAT)$/i;

const AIDER_PROVIDER_CREDENTIAL_OR_ENDPOINT_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_API_BASE',
  'DEEPSEEK_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_API_BASE',
  'GEMINI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_HOST',
  'OPENAI_API_KEY',
  'OPENAI_API_TYPE',
  'OPENAI_API_VERSION',
  'OPENAI_API_DEPLOYMENT_ID',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION_ID',
  'OPENROUTER_API_KEY',
  'OPENROUTER_API_BASE',
  'OPENROUTER_BASE_URL'
] as const;

const AIDER_EXPLICIT_PROVIDER_CREDENTIAL_ENV_NAMES = [
  ...AIDER_PROVIDER_CREDENTIAL_OR_ENDPOINT_ENV_NAMES,
  ...AWS_CREDENTIAL_CHAIN_ENV_NAMES,
  ...GCP_VERTEX_CREDENTIAL_CHAIN_ENV_NAMES
] as const;

const OPENCODE_EXPLICIT_PROVIDER_CREDENTIAL_ENV_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SNOWFLAKE_CORTEX_PAT',
  'AICORE_SERVICE_KEY'
] as const;

function isGenericCredentialLikeEnv(name: string): boolean {
  return GENERIC_CREDENTIAL_ENV_PATTERN.test(name);
}

/** session.json 스키마 (세션 디렉토리에 기록 — list/orphan 이 읽음). */
interface SessionMeta {
  id: string;
  cli: string;
  profile: string;
  /** 세션을 소유한 mat 프로세스 pid (subshell 아님). */
  pid: number;
  /**
   * 소유 mat 프로세스의 시작 서명(`ps -o lstart`). pid 재사용 검출용 — pid 가 죽고 재할당된
   * 뒤 다른 프로세스가 같은 pid 를 점유해도 시작 시각이 달라 구분된다. ps 미지원/조회 실패 시
   * undefined (옛 메타도 동일) → liveness-only 폴백 (PR #61 Codex H2).
   */
  pidStart?: string;
  /**
   * subshell(자식) OS pid (#63-2). reapOrphans/stopSession 이 소유 mat 사망 후에도 자식 생존을
   * 확인해 라이브 세션 디렉토리 오삭제를 막는 데 쓴다. 옛 메타는 undefined (자식 추적 정보 없음).
   */
  childPid?: number;
  /**
   * subshell 의 시작 서명(`ps -o lstart`) — childPid 재사용 방어 (pidStart 와 동형). 자식 pid 가
   * 죽고 재할당돼도 시작 시각이 달라 구분된다. ps 미지원/조회 실패·옛 메타는 undefined.
   */
  childPidStart?: string;
  /** ISO-8601 시작 시각. */
  startedAt: string;
  roots: { env: string; dir: string }[];
}

export interface SessionInfo {
  id: string;
  cli: string;
  profile: string;
  pid: number;
  startedAt: string;
  alive: boolean;
}

/**
 * 세션 격리 실행 — 격리 디렉토리 materialize → env 주입 subshell spawn → 종료 시
 * 원자 재캡처 + 정리. 전역 swap/lock 을 건드리지 않아 동시 다계정 안전.
 */
export async function runSession(opts: SessionStartOptions): Promise<SessionResult> {
  return runSessionWithTarget(opts, () => ({ kind: 'shell' }));
}

/**
 * Command-scoped session 실행 — `$SHELL` 대신 mat 이 고른 builtin executable 을 직접 spawn 한다.
 *
 * `args` 는 executable 의 argv 로만 전달된다. 임의 command/shell 은 받지 않으므로, `mat exec` 와 달리
 * 전역 swap/lock 없이 기존 session copy-isolate + 재캡처 lifecycle 을 그대로 쓴다.
 */
export async function runSessionCommand(opts: SessionCommandOptions): Promise<SessionResult> {
  const preflight = await preflightSessionRunCommand(opts);
  assertSessionRunPreflightOk(preflight);

  const def = findCliDef(opts.cliId);
  if (!def?.sessionRun) throw new UsageError(`'${opts.cliId}' 는 session run 을 지원하지 않습니다 (builtin executable 미정의).`);
  const profileName = validateProfileName(opts.profileName);

  await reapOrphans().catch(() => {
    /* best-effort — start 를 막지 않는다 */
  });

  const id = makeSessionId(opts.cliId, profileName);
  const executable = validateSessionRunExecutable(def.sessionRun.executable);

  if (def.id === 'aider') {
    const plan = planAiderCommandSession(def, profileName, id);
    const target: SessionSpawnTarget = {
      kind: 'command',
      executable,
      args: aiderForcedArgs(plan, opts.args),
      env: sessionRunEnvOverrides(def.id)
    };
    return runPlannedSession(plan, target, () => inspectAiderMaterializedProfile(plan));
  }

  if (!def.session || def.session.roots.length === 0) {
    throw new UsageError(`'${opts.cliId}' 는 세션 격리를 지원하지 않습니다 (env override 미지원).`);
  }
  const plan = planSession(def, profileName, id);
  const target: SessionSpawnTarget = {
    kind: 'command',
    executable,
    args: opts.args.slice(),
    env: sessionRunEnvOverrides(def.id)
  };
  return runPlannedSession(plan, target);
}

export async function preflightSessionRunCommand(opts: SessionCommandOptions): Promise<SessionRunPreflightReport> {
  const report = makeSessionRunPreflightReport(opts);
  const def = findCliDef(opts.cliId);
  if (!def) {
    return blockPreflight(report, 'cli', 'unknown-cli', `알 수 없는 CLI: ${opts.cliId}`);
  }
  if (!def.sessionRun) {
    return blockPreflight(
      report,
      'support',
      'session-run-unsupported',
      `'${opts.cliId}' 는 session run 을 지원하지 않습니다 (builtin executable 미정의).`
    );
  }
  report.supported = true;

  try {
    await preflightSessionRun(def.id, opts.args);
    okPhase(report, 'preflight');
  } catch (err) {
    return blockPreflight(report, preflightPhaseForCli(def.id), 'session-run-hard-stop', err);
  }

  let profileName: string;
  try {
    profileName = validateProfileName(opts.profileName);
    okPhase(report, 'profile-name');
  } catch (err) {
    return blockPreflight(report, 'profile', 'profile-name-invalid', err);
  }

  try {
    report.profileExists = await profileExists(opts.cliId, profileName);
  } catch (err) {
    report.profileExists = null;
    return blockPreflight(report, 'profile', 'profile-check-failed', err);
  }
  if (!report.profileExists) {
    return blockPreflight(report, 'profile', 'profile-missing', `프로필을 찾을 수 없습니다: ${opts.cliId}/${profileName}`);
  }
  okPhase(report, 'profile');

  try {
    report.executable = validateSessionRunExecutable(def.sessionRun.executable);
    okPhase(report, 'executable');
  } catch (err) {
    return blockPreflight(report, 'executable', 'executable-invalid', err);
  }

  if (def.id !== 'aider' && (!def.session || def.session.roots.length === 0)) {
    return blockPreflight(
      report,
      'support',
      'session-isolation-unsupported',
      `'${opts.cliId}' 는 세션 격리를 지원하지 않습니다 (env override 미지원).`
    );
  }

  if (def.id === 'aider') {
    try {
      const text = await readProfileFile(def.id, profileName, 'aider.yml');
      if (text == null) {
        throw new UsageError(`aider session run 차단: profile config aider.yml 이 프로필에 없습니다.`);
      }
      inspectAiderProfileConfigText(text);
      okPhase(report, 'aider-profile');
    } catch (err) {
      return blockPreflight(report, 'aider-profile', 'aider-profile-hard-stop', err);
    }
  }

  report.ok = true;
  return report;
}

function makeSessionRunPreflightReport(opts: SessionCommandOptions): SessionRunPreflightReport {
  return {
    schemaVersion: 1,
    cliId: opts.cliId,
    profileName: opts.profileName,
    args: opts.args.slice(),
    ok: false,
    supported: false,
    profileExists: null,
    blockers: [],
    warnings: [],
    phases: []
  };
}

function okPhase(report: SessionRunPreflightReport, id: string): void {
  report.phases.push({ id, status: 'ok' });
}

function blockPreflight(
  report: SessionRunPreflightReport,
  phase: string,
  code: string,
  errOrMessage: unknown
): SessionRunPreflightReport {
  const message = errOrMessage instanceof UsageError
    ? errOrMessage.message
    : typeof errOrMessage === 'string'
      ? errOrMessage
      : errorMessage(errOrMessage);
  report.ok = false;
  report.blockers.push({ phase, code, message });
  report.phases.push({ id: phase, status: 'blocked' });
  return report;
}

function preflightPhaseForCli(cliId: string): string {
  if (cliId === 'aider') return 'aider-preflight';
  if (cliId === 'opencode') return 'opencode-preflight';
  return 'preflight';
}

function assertSessionRunPreflightOk(report: SessionRunPreflightReport): void {
  if (report.ok) return;
  const blocker = report.blockers[0];
  throw new UsageError(blocker?.message ?? 'session run preflight failed');
}

export function formatSessionRunPreflightReport(report: SessionRunPreflightReport): string {
  const lines: string[] = [];
  lines.push(`session run preflight: ${report.ok ? 'ok' : 'blocked'} (${report.cliId}/${report.profileName})`);
  if (report.executable) {
    lines.push(`would execute: ${report.executable}${report.args.length ? ` ${report.args.join(' ')}` : ''}`);
  }
  if (report.blockers.length > 0) {
    lines.push('blockers:');
    for (const blocker of report.blockers) {
      lines.push(`  - [${blocker.phase}] ${blocker.message}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runSessionWithTarget(
  opts: SessionStartOptions,
  targetFor: (def: CliDef) => SessionSpawnTarget | Promise<SessionSpawnTarget>
): Promise<SessionResult> {
  const def = findCliDef(opts.cliId);
  if (!def) throw new UsageError(`알 수 없는 CLI: ${opts.cliId}`);
  if (!def.session || def.session.roots.length === 0) {
    throw new UsageError(`'${opts.cliId}' 는 세션 격리를 지원하지 않습니다 (env override 미지원).`);
  }
  const target = await targetFor(def);
  const profileName = validateProfileName(opts.profileName);
  if (!(await profileExists(opts.cliId, profileName))) {
    throw new UsageError(`프로필을 찾을 수 없습니다: ${opts.cliId}/${profileName}`);
  }

  await reapOrphans().catch(() => {
    /* best-effort — start 를 막지 않는다 */
  });

  const id = makeSessionId(opts.cliId, profileName);
  const plan = planSession(def, profileName, id);
  return runPlannedSession(plan, target);
}

async function runPlannedSession(
  plan: SessionPlan,
  target: SessionSpawnTarget,
  afterMaterialize?: () => Promise<void>
): Promise<SessionResult> {
  await materializeSession(plan); // 세션 디렉토리 생성 + 자격증명 복사
  if (afterMaterialize) {
    try {
      await afterMaterialize();
    } catch (err) {
      await removeSessionDir(plan.id).catch(() => {
        /* best-effort rollback — 원본 에러 전파 */
      });
      throw err;
    }
  }
  emitSessionWarnings(plan);
  // pid 재사용 검출용 시작 서명 (조회 실패해도 세션 생성을 막지 않음 — liveness-only 폴백).
  const pidStart = (await processStartSignature(process.pid)) ?? undefined;
  const meta: SessionMeta = {
    id: plan.id,
    cli: plan.cli,
    profile: plan.profile,
    pid: process.pid,
    pidStart,
    startedAt: new Date().toISOString(),
    roots: plan.roots.map((r) => ({ env: r.env, dir: r.dir }))
  };
  await writeSessionMeta(plan.id, meta);

  const childRef: { current: ChildProcess | null } = { current: null };
  const forwarders = registerSessionForwarders(childRef);
  try {
    // 자식 pid 기록(recordChildPid)의 진행 중인 promise 를 캡처한다 (#71 결함: race + lifecycle).
    // spawnSessionTarget 은 onSpawned 를 await 없이(`void`) 시작하므로, child 가 빨리 exit 하면 spawn 이
    // resolve 돼 아래 cleanup 으로 넘어가는데 그 시점에 recordChildPid 가 아직 ps 대기/2단계 write 중일
    // 수 있다. cleanup 의 removeSessionDir 가 세션 디렉토리를 지운 뒤 recordChildPid 의 writeSessionMeta
    // 가 실행되면 writeFileAtomic 의 recursive mkdir 가 삭제된 디렉토리에 session.json 만 재생성(orphan)
    // 한다. 이를 막기 위해 record promise 를 잡아 cleanup 직전에 settle 을 보장한다.
    let recordChildPidDone: Promise<void> = Promise.resolve();
    let spawnResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnError: unknown;
    try {
      spawnResult = await spawnSessionTarget(plan, target, childRef, (childPid, isChildAlive) => {
        // recordChildPid 는 내부 try/catch 로 throw 하지 않지만, 방어적으로 .catch 를 달아
        // settle 만 보장(unhandled rejection 봉인). isChildAlive 를 함께 넘겨 서명 캡처 전/중에
        // child 가 exit 했는지 쓰기 직전 확인하게 한다 (#71 결함: pid 재사용 서명 오기록 차단).
        recordChildPidDone = recordChildPid(plan.id, meta, childPid, isChildAlive).catch(() => {
          /* best-effort — recordChildPid 내부에서 이미 흡수, settle 만 필요 */
        });
        return recordChildPidDone;
      });
    } catch (err) {
      spawnError = err;
    }

    // cleanup(재캡처/removeSessionDir) **이전에** pending 자식 pid 기록을 settle 한다 — spawn 성공/실패
    // (콜백이 이미 시작됐을 수 있음) 무관 공통 경로. 이로써 removeSessionDir 는 항상 recordChildPid
    // 완료 후 실행돼 삭제된 디렉토리에 orphan session.json 이 재생성되거나 recapture 와 race 하지 않는다.
    await recordChildPidDone;

    // spawn 성공/실패와 무관하게 재캡처 + 정리 (exec.ts runUnderLock 패턴 미러).
    const recaptureError = await recaptureBestEffort(plan);
    await removeSessionDir(plan.id).catch(() => {
      /* best-effort */
    });

    if (spawnError) throw spawnError;
    return { code: spawnResult!.code, signal: spawnResult!.signal, recaptureError };
  } finally {
    forwarders.dispose();
  }
}

/** builtin executable name 방어 검증 — plugin/user input 이 아니라도 spawn 전 fail-closed. */
function validateSessionRunExecutable(executable: string): string {
  if (
    typeof executable !== 'string' ||
    executable.length === 0 ||
    !/^[a-zA-Z0-9._-]+$/.test(executable) ||
    executable.includes('/') ||
    executable.includes('\\') ||
    executable.includes('\x00')
  ) {
    throw new UsageError(`session run executable 이 유효하지 않습니다: ${sanitizeForStderr(String(executable))}`);
  }
  return executable;
}

/** CLI별 command-scoped session run preflight. 실행 전 credential 우회 채널을 fail-closed 로 차단한다. */
async function preflightSessionRun(cliId: string, args: readonly string[]): Promise<void> {
  if (cliId === 'aider') await preflightAiderSessionRun(args);
  if (cliId === 'opencode') await preflightOpenCodeSessionRun(args);
}

function sessionRunEnvOverrides(cliId: string): Record<string, string | undefined> | undefined {
  if (cliId === 'aider') {
    return {
      // Aider can switch models interactively after startup. Keep Bedrock/Vertex from silently using host
      // AWS/GCP shared credentials, ADC, instance metadata, or container credentials.
      AWS_CONFIG_FILE: '/dev/null',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/dev/null',
      GOOGLE_APPLICATION_CREDENTIALS: '/dev/null',
      NO_GCE_CHECK: 'true',
      AWS_ACCESS_KEY_ID: undefined,
      AWS_BEARER_TOKEN_BEDROCK: undefined,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
      AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
      AWS_DEFAULT_PROFILE: undefined,
      AWS_PROFILE: undefined,
      AWS_ROLE_ARN: undefined,
      AWS_ROLE_SESSION_NAME: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_SESSION_TOKEN: undefined,
      AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
      GOOGLE_AUTH_SUPPRESS_CREDENTIALS_WARNINGS: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
      GOOGLE_CLOUD_QUOTA_PROJECT: undefined,
      GOOGLE_PROJECT: undefined,
      VERTEXAI_LOCATION: undefined,
      VERTEXAI_PROJECT: undefined
    };
  }
  if (cliId !== 'opencode') return undefined;
  return {
    // OpenCode's Amazon Bedrock provider can fall back to the AWS SDK credential chain. A command-scoped
    // opencode run should not silently read host AWS shared credentials or instance/container metadata.
    AWS_CONFIG_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    GOOGLE_APPLICATION_CREDENTIALS: '/dev/null',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
    AWS_CONTAINER_AUTHORIZATION_TOKEN: undefined,
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined
  };
}

function planAiderCommandSession(def: CliDef, profile: string, id: string): SessionPlan {
  validateSessionId(id);
  const source = def.sources.find((src) => src.type === 'file' && src.saveAs === 'aider.yml');
  if (!source || source.type !== 'file') {
    throw new UsageError(`aider session run 은 file source 'aider.yml' 이 필요합니다.`);
  }
  const commandDir = join(sessionDir(id), 'command');
  return {
    id,
    cli: def.id,
    profile,
    roots: [],
    commandCreds: [
      {
        saveAs: source.saveAs,
        rel: 'command/aider.yml',
        absInSession: join(commandDir, 'aider.yml')
      }
    ],
    commandExtraFiles: [
      {
        rel: 'command/.env',
        absInSession: join(commandDir, '.env'),
        content: ''
      }
    ]
  };
}

function aiderCommandCred(plan: SessionPlan, saveAs: string): SessionCred {
  const cred = (plan.commandCreds ?? []).find((c) => c.saveAs === saveAs);
  if (!cred) throw new UsageError(`aider command-only 세션 계획에 ${saveAs} 가 없습니다.`);
  return cred;
}

function aiderCommandExtraFile(plan: SessionPlan, rel: string): { rel: string; absInSession: string; content: string } {
  const file = (plan.commandExtraFiles ?? []).find((f) => f.rel === rel);
  if (!file) throw new UsageError(`aider command-only 세션 계획에 ${rel} 가 없습니다.`);
  return file;
}

function aiderForcedArgs(plan: SessionPlan, userArgs: readonly string[]): string[] {
  return [
    '--config',
    aiderCommandCred(plan, 'aider.yml').absInSession,
    '--env-file',
    aiderCommandExtraFile(plan, 'command/.env').absInSession,
    ...userArgs
  ];
}

async function inspectAiderMaterializedProfile(plan: SessionPlan): Promise<void> {
  const path = aiderCommandCred(plan, 'aider.yml').absInSession;
  const text = await fs.readFile(path, 'utf8');
  inspectAiderProfileConfigText(text);
}

function inspectAiderProfileConfigText(text: string): void {
  const bypass = findAiderProfileSidecarPointer(text);
  if (bypass) {
    throw new UsageError(
      `aider session run 차단: profile config 에 ${bypass} sidecar 경로 설정이 있어 격리 밖 파일을 로드할 수 있습니다.`
    );
  }
  const setEnv = findAiderProfileSetEnv(text);
  if (setEnv) {
    throw new UsageError(
      `aider session run 차단: profile config 에 ${setEnv} 설정이 있어 mat 의 child env scrub 을 우회할 수 있습니다.`
    );
  }
  const hostChainModel = findAiderHostCredentialChainModel(text);
  if (hostChainModel) {
    throw new UsageError(
      `aider session run 차단: profile config 의 ${hostChainModel} 모델은 host AWS/Google credential chain 을 사용할 수 있어 partial-run 격리 범위 밖입니다.`
    );
  }
  const hostChainAlias = findAiderHostCredentialChainAlias(text);
  if (hostChainAlias) {
    throw new UsageError(
      `aider session run 차단: profile config 의 alias ${hostChainAlias} 는 host AWS/Google credential chain 모델을 가리켜 partial-run 격리 범위 밖입니다.`
    );
  }
}

const AIDER_BLOCK_ARG_FLAGS = [
  '--anthropic-api-key',
  '--api-key',
  '--api-base',
  '--api-base-url',
  '--base-url',
  '--config',
  '--env',
  '--env-file',
  '--model-metadata-file',
  '--model-settings-file',
  '--openai-api-base',
  '--openai-api-deployment-id',
  '--openai-api-host',
  '--openai-api-key',
  '--openai-api-type',
  '--openai-api-version',
  '--openai-base-url',
  '--openai-organization-id',
  '--set-env'
] as const;

async function preflightAiderSessionRun(args: readonly string[]): Promise<void> {
  preflightAiderArgs(args);
  preflightAiderEnv();
  await inspectAiderOAuthKeysCandidate(aiderOAuthKeysPath());
  for (const candidate of await aiderEnvCandidates(process.cwd())) await inspectAiderEnvCandidate(candidate);
  for (const candidate of await aiderModelSidecarCandidates(process.cwd())) {
    await inspectAiderSidecarCandidate(candidate.path, candidate.label);
  }
}

function preflightAiderArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-c' || arg.startsWith('-c=')) {
      throw new UsageError(`aider session run 차단: ${arg} 인자는 mat 이 강제하는 config 를 우회할 수 있습니다.`);
    }
    if (arg.length > 2 && arg.startsWith('-c') && !arg.startsWith('--')) {
      throw new UsageError(`aider session run 차단: ${arg} 인자는 mat 이 강제하는 config 를 우회할 수 있습니다.`);
    }
    for (const flag of AIDER_BLOCK_ARG_FLAGS) {
      if (aiderArgMatchesBlockedFlag(arg, flag)) {
        throw new UsageError(
          `aider session run 차단: ${arg} 인자는 자격증명/config/env/model sidecar 격리를 우회할 수 있습니다.`
        );
      }
    }
    const modelValue = aiderModelValueFromArg(args, i);
    if (modelValue && isAiderHostCredentialChainModel(modelValue)) {
      throw new UsageError(
        `aider session run 차단: ${modelValue} 모델은 host AWS/Google credential chain 을 사용할 수 있어 partial-run 격리 범위 밖입니다.`
      );
    }
    const aliasValue = aiderAliasValueFromArg(args, i);
    if (aliasValue && isAiderHostCredentialChainAlias(aliasValue)) {
      throw new UsageError(
        `aider session run 차단: ${aliasValue} alias 는 host AWS/Google credential chain 모델을 가리켜 partial-run 격리 범위 밖입니다.`
      );
    }
  }
}

function aiderArgMatchesBlockedFlag(arg: string, flag: (typeof AIDER_BLOCK_ARG_FLAGS)[number]): boolean {
  if (!arg.startsWith('--')) return false;
  const option = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
  if (option === flag) return true;
  if (!flag.startsWith(option)) return false;

  // Aider currently uses Python argparse/configargparse long-option abbreviation. Prefixes such as
  // `--conf`, `--env-fi`, or `--api-ke` can therefore select blocked options too. Fail closed for
  // dangerous prefixes, while preserving the common safe exact `--model` option (a prefix of the
  // model-sidecar flags but not itself a sidecar path).
  if (option === '--model') return false;
  if (
    (flag === '--model-settings-file' || flag === '--model-metadata-file') &&
    !option.startsWith('--model-')
  ) {
    return false;
  }
  return option.length > 2;
}

const AIDER_MODEL_VALUE_FLAGS = ['--model', '--weak-model', '--editor-model', '--list-models', '--models'] as const;
const AIDER_ALIAS_VALUE_FLAGS = ['--alias'] as const;

function aiderModelValueFromArg(args: readonly string[], index: number): string | null {
  const arg = args[index] ?? '';
  for (const flag of AIDER_MODEL_VALUE_FLAGS) {
    if (!aiderArgMatchesModelValueFlag(arg, flag)) continue;
    const equals = arg.indexOf('=');
    if (equals >= 0) return arg.slice(equals + 1);
    return args[index + 1] ?? null;
  }
  return null;
}

function aiderArgMatchesModelValueFlag(arg: string, flag: (typeof AIDER_MODEL_VALUE_FLAGS)[number]): boolean {
  if (!arg.startsWith('--')) return false;
  const option = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
  if (option === flag) return true;
  if (flag === '--model') return false;
  return flag.startsWith(option) && option.length > 2;
}

function isAiderHostCredentialChainModel(value: string): boolean {
  return /^(bedrock|vertex_ai)\//i.test(value);
}

function aiderAliasValueFromArg(args: readonly string[], index: number): string | null {
  const arg = args[index] ?? '';
  for (const flag of AIDER_ALIAS_VALUE_FLAGS) {
    if (!aiderArgMatchesValueFlag(arg, flag)) continue;
    const equals = arg.indexOf('=');
    if (equals >= 0) return arg.slice(equals + 1);
    return args[index + 1] ?? null;
  }
  return null;
}

function aiderArgMatchesValueFlag(arg: string, flag: (typeof AIDER_ALIAS_VALUE_FLAGS)[number]): boolean {
  if (!arg.startsWith('--')) return false;
  const option = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
  if (option === flag) return true;
  return flag.startsWith(option) && option.length > 2;
}

function isAiderHostCredentialChainAlias(value: string): boolean {
  const separator = value.indexOf(':');
  if (separator <= 0) return false;
  return isAiderHostCredentialChainModel(value.slice(separator + 1).trim());
}

function preflightAiderEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AIDER_')) {
      throw new UsageError(`aider session run 차단: ${name} env 는 Aider 설정을 우회할 수 있습니다.`);
    }
    if (isAiderProviderCredentialEnv(name)) {
      throw new UsageError(`aider session run 차단: ${name} env 는 provider credential 로 동작할 수 있습니다.`);
    }
  }
}

function isAiderProviderCredentialEnv(name: string): boolean {
  return (
    (AIDER_EXPLICIT_PROVIDER_CREDENTIAL_ENV_NAMES as readonly string[]).includes(name) ||
    isGenericCredentialLikeEnv(name)
  );
}

function aiderOAuthKeysPath(): string {
  return join(expandTilde('~/.aider'), 'oauth-keys.env');
}

async function aiderEnvCandidates(startDir: string): Promise<string[]> {
  const out = [join(expandTilde('~'), '.env')];
  let dir = startDir;
  for (;;) {
    out.push(join(dir, '.env'));
    if (await aiderPathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return Array.from(new Set(out));
}

async function aiderModelSidecarCandidates(
  startDir: string
): Promise<Array<{ path: string; label: string }>> {
  const names = ['.aider.model.settings.yml', '.aider.model.metadata.json'];
  const out: Array<{ path: string; label: string }> = [];
  for (const name of names) out.push({ path: join(expandTilde('~'), name), label: 'home model sidecar' });
  let dir = startDir;
  for (;;) {
    for (const name of names) out.push({ path: join(dir, name), label: 'project model sidecar' });
    if (await aiderPathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return Array.from(new Map(out.map((candidate) => [candidate.path, candidate])).values());
}

async function inspectAiderOAuthKeysCandidate(path: string): Promise<void> {
  const stat = await aiderLstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UsageError(`aider session run 차단: OAuth key dotenv 후보가 symlink 입니다: ${path}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`aider session run 차단: OAuth key dotenv 후보가 일반 파일이 아닙니다: ${path}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new UsageError(`aider session run 차단: OAuth key dotenv 후보를 읽을 수 없습니다: ${path}: ${errorText(err)}`);
  }
  if (text.length > 0) {
    throw new UsageError(
      `aider session run 차단: OAuth key dotenv 후보가 존재해 forced --env-file 격리를 우회할 수 있습니다: ${path}`
    );
  }
}

async function inspectAiderEnvCandidate(path: string): Promise<void> {
  const stat = await aiderLstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UsageError(`aider session run 차단: .env 후보가 symlink 입니다: ${path}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`aider session run 차단: .env 후보가 일반 파일이 아닙니다: ${path}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new UsageError(`aider session run 차단: .env 후보를 읽을 수 없습니다: ${path}: ${errorText(err)}`);
  }
  const envName = findAiderCredentialEnvAssignment(text);
  if (envName) {
    throw new UsageError(`aider session run 차단: .env 에 ${envName} 설정이 있어 격리를 우회할 수 있습니다: ${path}`);
  }
}

async function inspectAiderSidecarCandidate(path: string, label: string): Promise<void> {
  const stat = await aiderLstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UsageError(`aider session run 차단: ${label} 후보가 symlink 입니다: ${path}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`aider session run 차단: ${label} 후보가 일반 파일이 아닙니다: ${path}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new UsageError(`aider session run 차단: ${label} 후보를 읽을 수 없습니다: ${path}: ${errorText(err)}`);
  }
  if (text.length > 0) {
    throw new UsageError(`aider session run 차단: ${label} 후보가 존재해 model sidecar 격리를 보장할 수 없습니다: ${path}`);
  }
}

function findAiderCredentialEnvAssignment(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (name.startsWith('AIDER_') || isAiderProviderCredentialEnv(name)) return name;
  }
  return null;
}

function findAiderProfileSidecarPointer(text: string): string | null {
  if (/(^|[{\n\r,])\s*["']?model[-_]settings[-_]file["']?\s*[:=]/im.test(text)) return 'model-settings-file';
  if (/(^|[{\n\r,])\s*["']?model[-_]metadata[-_]file["']?\s*[:=]/im.test(text)) return 'model-metadata-file';
  return null;
}

function findAiderProfileSetEnv(text: string): string | null {
  if (/(^|[{\n\r,])\s*["']?set[-_]env["']?\s*[:=]/im.test(text)) return 'set-env';
  return null;
}

function findAiderHostCredentialChainModel(text: string): string | null {
  const match = /(^|[{\n\r,])\s*["']?(?:model|models|weak[-_]model|editor[-_]model|list[-_]models)["']?\s*[:=]\s*["']?(bedrock|vertex_ai)\//im.exec(text);
  return match ? `${match[2]}/` : null;
}

function findAiderHostCredentialChainAlias(text: string): string | null {
  const match = /(^|[\s\["',])([^:\s"',\[\]][^:"',\[\]]*?\s*:\s*(bedrock|vertex_ai)\/[^\s"',\]]*)/im.exec(text);
  return match ? match[2] : null;
}

const OPENCODE_GLOBAL_CONFIG_FILE_NAMES = ['config', 'config.json', 'opencode.json', 'opencode.jsonc', 'tui.json', 'tui.jsonc'] as const;
const OPENCODE_PROJECT_CONFIG_FILE_NAMES = ['opencode.json', 'opencode.jsonc', 'tui.json', 'tui.jsonc'] as const;

/**
 * OpenCode command-scoped run preflight.
 *
 * OpenCode credentials normally live in XDG data (`auth.json`), which mat can copy-isolate. But OpenCode also
 * merges config from env, global/managed/project config files, and those configs can specify provider
 * `apiKey` values that bypass `auth.json`. Warning-only would be a false isolation claim, so known local
 * bypass channels hard-stop before profile lookup, materialization, or spawn.
 */
async function preflightOpenCodeSessionRun(args: readonly string[]): Promise<void> {
  await preflightOpenCodeArgs(args);

  for (const name of OPENCODE_BYPASS_ENV_NAMES) {
    if (process.env[name] !== undefined) {
      throw new UsageError(
        `opencode session run 차단: ${name} env 가 설정되어 있어 auth.json 격리를 우회할 수 있습니다.`
      );
    }
  }
  for (const name of Object.keys(process.env)) {
    if (isOpenCodeProviderCredentialEnv(name)) {
      throw new UsageError(
        `opencode session run 차단: ${name} env 가 provider credential 로 동작해 auth.json 격리를 우회할 수 있습니다.`
      );
    }
  }

  for (const candidate of openCodeGlobalConfigCandidates()) {
    await inspectOpenCodeConfigCandidate(candidate, 'global/managed config');
  }
  for (const candidate of await openCodeHomeDotOpenCodeConfigCandidates()) {
    await inspectOpenCodeConfigCandidate(candidate, 'home .opencode config');
  }
  for (const candidate of await openCodeProjectConfigCandidates(process.cwd())) {
    await inspectOpenCodeConfigCandidate(candidate, 'project config');
  }
  for (const candidate of await openCodeProjectEnvCandidates(process.cwd())) {
    await inspectOpenCodeEnvCandidate(candidate);
  }
  for (const candidate of await openCodePluginDirectoryCandidates(process.cwd())) {
    await failIfOpenCodePluginDirectoryExists(candidate.path, candidate.label);
  }
  for (const candidate of await openCodePackageManifestCandidates(process.cwd())) {
    await failIfPathExists(candidate.path, candidate.label);
  }
  for (const candidate of openCodeManagedPreferenceCandidates()) {
    await failIfPathExists(candidate, 'macOS managed preference');
  }
}

async function preflightOpenCodeArgs(args: readonly string[]): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === 'attach' || arg === '--attach' || arg.startsWith('--attach=')) {
      throw new UsageError(
        `opencode session run 차단: attach 인자는 이미 실행 중인 OpenCode backend credential 을 사용할 수 있습니다: ${arg}`
      );
    }
    if (arg === 'pr') {
      throw new UsageError(
        `opencode session run 차단: pr 인자는 preflight 이후 project tree 를 변경할 수 있습니다: ${arg}`
      );
    }
    if (arg === '--dir' || arg === '--cwd' || arg === '-C' || arg.startsWith('--dir=') || arg.startsWith('--cwd=')) {
      throw new UsageError(
        `opencode session run 차단: cwd/project directory 변경 인자는 preflight 범위를 우회할 수 있습니다: ${arg}`
      );
    }
    if (arg === '--dangerously-skip-permissions' || arg.startsWith('--dangerously-skip-permissions=')) {
      throw new UsageError(
        `opencode session run 차단: dangerously-skip-permissions 인자는 permission prompt 를 우회할 수 있습니다: ${arg}`
      );
    }
    if (arg === '--share' || arg.startsWith('--share=')) {
      throw new UsageError(
        `opencode session run 차단: share 인자는 대화 이력/메타데이터를 public link 로 동기화할 수 있습니다: ${arg}`
      );
    }
    if (arg === '--command' || arg.startsWith('--command=')) {
      throw new UsageError(
        `opencode session run 차단: command 인자는 share/custom command 경로로 격리 범위를 우회할 수 있습니다: ${arg}`
      );
    }
    if (arg === '--file' || arg.startsWith('--file=') || arg === '-f' || arg.startsWith('-f=')) {
      throw new UsageError(
        `opencode session run 차단: file attachment 인자는 host 파일을 prompt 에 첨부해 격리 범위를 우회할 수 있습니다: ${arg}`
      );
    }
    if (arg.length > 2 && arg.startsWith('-f') && !arg.startsWith('--')) {
      throw new UsageError(
        `opencode session run 차단: file attachment 인자는 host 파일을 prompt 에 첨부해 격리 범위를 우회할 수 있습니다: ${arg}`
      );
    }
    if (looksLikeOpenCodeProjectPathArg(arg)) {
      throw new UsageError(
        `opencode session run 차단: path-like project 인자는 preflight 범위를 우회할 수 있습니다: ${arg}`
      );
    }
    if (await openCodeArgIsExistingDirectory(arg)) {
      throw new UsageError(
        `opencode session run 차단: project directory 인자는 preflight 범위를 우회할 수 있습니다: ${arg}`
      );
    }
  }
}

function looksLikeOpenCodeProjectPathArg(arg: string): boolean {
  if (arg.length === 0 || arg.startsWith('-')) return false;
  return arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('~');
}

async function openCodeArgIsExistingDirectory(arg: string): Promise<boolean> {
  if (arg.length === 0 || arg.startsWith('-') || arg.includes('\0')) return false;
  const path = isAbsolute(arg) ? arg : join(process.cwd(), arg);
  const stat = await lstatIfExists(path);
  return stat?.isDirectory() === true || stat?.isSymbolicLink() === true;
}

function openCodeGlobalConfigCandidates(): string[] {
  const out: string[] = [];
  const addRoot = (root: string) => {
    for (const name of OPENCODE_GLOBAL_CONFIG_FILE_NAMES) out.push(join(root, 'opencode', name));
  };

  addRoot(expandTilde('~/.config'));
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome && xdgConfigHome.length > 0) addRoot(xdgConfigHome);
  for (const name of OPENCODE_GLOBAL_CONFIG_FILE_NAMES) out.push(join('/etc/opencode', name));
  if (process.platform === 'darwin') {
    for (const name of OPENCODE_GLOBAL_CONFIG_FILE_NAMES) {
      out.push(join('/Library/Application Support/opencode', name));
    }
  }
  return Array.from(new Set(out));
}

async function openCodeHomeDotOpenCodeConfigCandidates(): Promise<string[]> {
  const out: string[] = [];
  const dotOpenCode = expandTilde('~/.opencode');
  const dotStat = await lstatIfExists(dotOpenCode);
  if (!dotStat) return out;
  if (dotStat.isSymbolicLink()) {
    throw new UsageError(`opencode session run 차단: home .opencode 디렉토리가 symlink 입니다: ${dotOpenCode}`);
  }
  if (!dotStat.isDirectory()) {
    throw new UsageError(`opencode session run 차단: home .opencode 경로가 디렉토리가 아닙니다: ${dotOpenCode}`);
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dotOpenCode);
  } catch (err) {
    throw new UsageError(
      `opencode session run 차단: home .opencode 디렉토리를 읽을 수 없습니다: ${dotOpenCode}: ${errorText(err)}`
    );
  }
  for (const entry of entries) {
    if (entry.endsWith('.json') || entry.endsWith('.jsonc')) out.push(join(dotOpenCode, entry));
  }
  return out;
}

async function openCodePackageManifestCandidates(
  startDir: string
): Promise<Array<{ path: string; label: string }>> {
  const out: Array<{ path: string; label: string }> = [
    { path: join(expandTilde('~/.config'), 'opencode', 'package.json'), label: 'global package manifest' },
    { path: join(expandTilde('~/.opencode'), 'package.json'), label: 'home package manifest' },
    { path: join('/etc/opencode', 'package.json'), label: 'managed package manifest' }
  ];
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome && xdgConfigHome.length > 0) {
    out.push({ path: join(xdgConfigHome, 'opencode', 'package.json'), label: 'XDG global package manifest' });
  }
  if (process.platform === 'darwin') {
    out.push({
      path: join('/Library/Application Support/opencode', 'package.json'),
      label: 'macOS managed package manifest'
    });
  }

  let dir = startDir;
  for (;;) {
    out.push({ path: join(dir, '.opencode', 'package.json'), label: 'project package manifest' });
    if (await pathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function openCodeProjectConfigCandidates(startDir: string): Promise<string[]> {
  const out: string[] = [];
  let dir = startDir;
  for (;;) {
    for (const name of OPENCODE_PROJECT_CONFIG_FILE_NAMES) out.push(join(dir, name));

    const dotOpenCode = join(dir, '.opencode');
    const dotStat = await lstatIfExists(dotOpenCode);
    if (dotStat) {
      if (dotStat.isSymbolicLink()) {
        throw new UsageError(`opencode session run 차단: .opencode 디렉토리가 symlink 입니다: ${dotOpenCode}`);
      }
      if (!dotStat.isDirectory()) {
        throw new UsageError(`opencode session run 차단: .opencode 경로가 디렉토리가 아닙니다: ${dotOpenCode}`);
      }
      let entries: string[];
      try {
        entries = await fs.readdir(dotOpenCode);
      } catch (err) {
        throw new UsageError(
          `opencode session run 차단: .opencode 디렉토리를 읽을 수 없습니다: ${dotOpenCode}: ${errorText(err)}`
        );
      }
      for (const entry of entries) {
        if (entry.endsWith('.json') || entry.endsWith('.jsonc')) out.push(join(dotOpenCode, entry));
      }
    }

    if (await pathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function openCodeProjectEnvCandidates(startDir: string): Promise<string[]> {
  const out: string[] = [];
  let dir = startDir;
  for (;;) {
    out.push(join(dir, '.env'));
    if (await pathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function openCodePluginDirectoryCandidates(
  startDir: string
): Promise<Array<{ path: string; label: string }>> {
  const out: Array<{ path: string; label: string }> = [
    { path: join(expandTilde('~/.config'), 'opencode', 'plugins'), label: 'global plugin directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'plugin'), label: 'global plugin directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'tools'), label: 'global custom tools directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'tool'), label: 'global custom tools directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'commands'), label: 'global commands directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'command'), label: 'global commands directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'modes'), label: 'global modes directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'mode'), label: 'global modes directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'agents'), label: 'global agents directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'agent'), label: 'global agents directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'skills'), label: 'global skills directory' },
    { path: join(expandTilde('~/.config'), 'opencode', 'skill'), label: 'global skills directory' },
    { path: join(expandTilde('~/.agents'), 'skills'), label: 'global agent-compatible skills directory' },
    { path: join(expandTilde('~/.agents'), 'skill'), label: 'global agent-compatible skills directory' },
    { path: join(expandTilde('~/.claude'), 'skills'), label: 'global Claude-compatible skills directory' },
    { path: join(expandTilde('~/.claude'), 'skill'), label: 'global Claude-compatible skills directory' },
    { path: join(expandTilde('~/.opencode'), 'plugins'), label: 'home plugin directory' },
    { path: join(expandTilde('~/.opencode'), 'plugin'), label: 'home plugin directory' },
    { path: join(expandTilde('~/.opencode'), 'tools'), label: 'home custom tools directory' },
    { path: join(expandTilde('~/.opencode'), 'tool'), label: 'home custom tools directory' },
    { path: join(expandTilde('~/.opencode'), 'commands'), label: 'home commands directory' },
    { path: join(expandTilde('~/.opencode'), 'command'), label: 'home commands directory' },
    { path: join(expandTilde('~/.opencode'), 'modes'), label: 'home modes directory' },
    { path: join(expandTilde('~/.opencode'), 'mode'), label: 'home modes directory' },
    { path: join(expandTilde('~/.opencode'), 'agents'), label: 'home agents directory' },
    { path: join(expandTilde('~/.opencode'), 'agent'), label: 'home agents directory' },
    { path: join(expandTilde('~/.opencode'), 'skills'), label: 'home skills directory' },
    { path: join(expandTilde('~/.opencode'), 'skill'), label: 'home skills directory' }
  ];
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome && xdgConfigHome.length > 0) {
    out.push({ path: join(xdgConfigHome, 'opencode', 'plugins'), label: 'XDG global plugin directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'plugin'), label: 'XDG global plugin directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'tools'), label: 'XDG global custom tools directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'tool'), label: 'XDG global custom tools directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'commands'), label: 'XDG global commands directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'command'), label: 'XDG global commands directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'modes'), label: 'XDG global modes directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'mode'), label: 'XDG global modes directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'agents'), label: 'XDG global agents directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'agent'), label: 'XDG global agents directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'skills'), label: 'XDG global skills directory' });
    out.push({ path: join(xdgConfigHome, 'opencode', 'skill'), label: 'XDG global skills directory' });
  }

  let dir = startDir;
  for (;;) {
    out.push({ path: join(dir, '.opencode', 'plugins'), label: 'project plugin directory' });
    out.push({ path: join(dir, '.opencode', 'plugin'), label: 'project plugin directory' });
    out.push({ path: join(dir, '.opencode', 'tools'), label: 'project custom tools directory' });
    out.push({ path: join(dir, '.opencode', 'tool'), label: 'project custom tools directory' });
    out.push({ path: join(dir, '.opencode', 'commands'), label: 'project commands directory' });
    out.push({ path: join(dir, '.opencode', 'command'), label: 'project commands directory' });
    out.push({ path: join(dir, '.opencode', 'modes'), label: 'project modes directory' });
    out.push({ path: join(dir, '.opencode', 'mode'), label: 'project modes directory' });
    out.push({ path: join(dir, '.opencode', 'agents'), label: 'project agents directory' });
    out.push({ path: join(dir, '.opencode', 'agent'), label: 'project agents directory' });
    out.push({ path: join(dir, '.opencode', 'skills'), label: 'project skills directory' });
    out.push({ path: join(dir, '.opencode', 'skill'), label: 'project skills directory' });
    out.push({ path: join(dir, '.agents', 'skills'), label: 'project agent-compatible skills directory' });
    out.push({ path: join(dir, '.agents', 'skill'), label: 'project agent-compatible skills directory' });
    out.push({ path: join(dir, '.claude', 'skills'), label: 'project Claude-compatible skills directory' });
    out.push({ path: join(dir, '.claude', 'skill'), label: 'project Claude-compatible skills directory' });
    if (await pathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function openCodeManagedPreferenceCandidates(): string[] {
  if (process.platform !== 'darwin') return [];
  const out = ['/Library/Managed Preferences/ai.opencode.managed.plist'];
  const usernames = new Set<string>();
  try {
    const username = userInfo().username;
    usernames.add(username || 'user');
  } catch {
    // Match OpenCode's fallback candidate and keep fail-closed coverage even if os.userInfo() fails.
    usernames.add('user');
  }
  if (process.env.USER) usernames.add(process.env.USER);
  usernames.add('user');
  for (const username of usernames) out.push(join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'));
  return Array.from(new Set(out));
}

function isOpenCodeProviderCredentialEnv(name: string): boolean {
  return (
    (OPENCODE_EXPLICIT_PROVIDER_CREDENTIAL_ENV_NAMES as readonly string[]).includes(name) ||
    isGenericCredentialLikeEnv(name)
  );
}

async function inspectOpenCodeEnvCandidate(path: string): Promise<void> {
  const stat = await lstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UsageError(`opencode session run 차단: project .env 후보가 symlink 입니다: ${path}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`opencode session run 차단: project .env 후보가 일반 파일이 아닙니다: ${path}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new UsageError(`opencode session run 차단: project .env 후보를 읽을 수 없습니다: ${path}: ${errorText(err)}`);
  }
  const envName = findOpenCodeCredentialEnvAssignment(text);
  if (envName) {
    throw new UsageError(
      `opencode session run 차단: project .env 에 ${envName} credential 이 있어 auth.json 격리를 우회할 수 있습니다: ${path}`
    );
  }
}

function findOpenCodeCredentialEnvAssignment(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    const name = match[1];
    if ((OPENCODE_BYPASS_ENV_NAMES as readonly string[]).includes(name) || isOpenCodeProviderCredentialEnv(name)) {
      return name;
    }
  }
  return null;
}

async function inspectOpenCodeConfigCandidate(path: string, label: string): Promise<void> {
  const stat = await lstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UsageError(`opencode session run 차단: ${label} 후보가 symlink 입니다: ${path}`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`opencode session run 차단: ${label} 후보가 일반 파일이 아닙니다: ${path}`);
  }
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new UsageError(`opencode session run 차단: ${label} 후보를 읽을 수 없습니다: ${path}: ${errorText(err)}`);
  }
  const credentialBypass = findOpenCodeCredentialBypass(text);
  if (credentialBypass) {
    throw new UsageError(
      `opencode session run 차단: ${label} 에 ${credentialBypass} 설정이 있어 auth.json 격리를 우회할 수 있습니다: ${path}`
    );
  }
}

function findOpenCodeCredentialBypass(text: string): string | null {
  const haystack = decodeJsonUnicodeEscapes(text);
  if (/\{file\s*:/i.test(haystack)) return 'file substitution';
  if (/\bapiKey\b/i.test(haystack)) return 'apiKey';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'plugin')) return 'plugin';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'npm')) return 'npm';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'mcp')) return 'mcp';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'instructions')) return 'instructions';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'skills')) return 'skills';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'reference')) return 'reference';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'references')) return 'references';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'share')) return 'share';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'agent')) return 'agent';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'mode')) return 'mode';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'permission')) return 'permission';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'tools')) return 'tools';
  if (hasOpenCodeConfigKeyOrTable(haystack, 'prompt')) return 'prompt';
  if (
    ['formatter', 'lsp', 'command', 'shell'].some((key) => hasOpenCodeConfigKeyOrTable(haystack, key))
  ) {
    return 'command';
  }
  if (
    /\bprovider\b/i.test(haystack) &&
    ['baseURL', 'endpoint', 'enterpriseUrl', 'url', 'api'].some((key) => hasOpenCodeConfigKeyOrTable(haystack, key))
  ) {
    return 'provider endpoint';
  }
  if (/\bprovider\b/i.test(haystack) && hasOpenCodeConfigAssignment(haystack, 'env')) return 'provider env';
  if (/\bheaders\b/i.test(haystack) && /\b(authorization|api[-_]?key|x-api-key|token|secret)\b/i.test(haystack)) {
    return 'credential header';
  }
  if (hasOpenCodeConfigAssignment(haystack, 'Authorization')) return 'Authorization header';
  if (/\b(amazon[-_]?bedrock|bedrock)\b/i.test(haystack) && /\bprofile\b/i.test(haystack)) return 'AWS profile';
  if (
    /\b(api[-_]?key|authToken|auth_token|serviceKey|service_key|clientSecret|client_secret|bearerToken|bearer_token|accessToken|refreshToken|accessKeyId|secretAccessKey|sessionToken|credentials)\b/i.test(
      haystack
    )
  ) {
    return 'credential option';
  }
  return null;
}

function hasOpenCodeConfigKeyOrTable(text: string, key: string): boolean {
  return (
    hasOpenCodeConfigAssignment(text, key) ||
    hasOpenCodeTomlTable(text, key) ||
    hasOpenCodeTomlDottedAssignmentPrefix(text, key)
  );
}

function hasOpenCodeConfigAssignment(text: string, key: string): boolean {
  return new RegExp(`${openCodeConfigKeyPattern(key)}\\s*[:=]`, 'i').test(text);
}

function hasOpenCodeTomlTable(text: string, key: string): boolean {
  return new RegExp(`^\\s*\\[\\[?\\s*${openCodeConfigKeyPattern(key)}(?:\\s*\\]\\]?|\\s*\\.)`, 'im').test(text);
}

function hasOpenCodeTomlDottedAssignmentPrefix(text: string, key: string): boolean {
  return new RegExp(`^\\s*${openCodeConfigKeyPattern(key)}\\s*\\.`, 'im').test(text);
}

function openCodeConfigKeyPattern(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?:["']${escaped}["']|\\b${escaped}\\b)`;
}

function decodeJsonUnicodeEscapes(text: string): string {
  return text
    .replace(/\\U([0-9a-fA-F]{8})/g, (match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
}

async function failIfPathExists(path: string, label: string): Promise<void> {
  if (await lstatIfExists(path)) {
    throw new UsageError(`opencode session run 차단: ${label} 이 존재해 config 병합 여부를 배제할 수 없습니다: ${path}`);
  }
}

async function failIfOpenCodePluginDirectoryExists(path: string, label: string): Promise<void> {
  const stat = await lstatIfExists(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new UsageError(`opencode session run 차단: ${label} 후보가 symlink 입니다: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new UsageError(`opencode session run 차단: ${label} 후보가 디렉토리가 아닙니다: ${path}`);
  }
  let entries: string[];
  try {
    entries = await fs.readdir(path);
  } catch (err) {
    throw new UsageError(`opencode session run 차단: ${label} 후보를 읽을 수 없습니다: ${path}: ${errorText(err)}`);
  }
  if (entries.length > 0) {
    throw new UsageError(
      `opencode session run 차단: ${label} 에 local plugin/tool/command/mode/agent/skill 가 있어 auth.json 격리를 우회할 수 있습니다: ${path}`
    );
  }
}

async function lstatIfExists(
  path: string,
  failurePrefix = 'opencode session run 차단: config 후보 확인 실패'
): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new UsageError(`${failurePrefix}: ${path}: ${errorText(err)}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstatIfExists(path)) != null;
}

async function aiderLstatIfExists(path: string): Promise<import('node:fs').Stats | null> {
  return lstatIfExists(path, 'aider session run 차단: 후보 확인 실패');
}

async function aiderPathExists(path: string): Promise<boolean> {
  return (await aiderLstatIfExists(path)) != null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 세션 root 별 경고 출력 — OpenCode 의 XDG_DATA_HOME 같은 broad-env EXPERIMENTAL 경고용. */
function emitSessionWarnings(plan: SessionPlan): void {
  const seen = new Set<string>();
  for (const root of plan.roots) {
    if (!root.warning || seen.has(root.warning)) continue;
    seen.add(root.warning);
    process.stderr.write(`[mat] ${sanitizeForStderr(root.warning)}\n`);
  }
}

/**
 * 자식 subshell pid + 시작 서명을 session.json 에 **2단계로** 병합 기록 (#63-2, best-effort).
 *
 * **2단계 persist 가 핵심 (#71 결함1)**: childPidStart 서명 조회(`processStartSignature`)는 ps
 * exec 라 최대 PS_SIGNATURE_TIMEOUT_MS 만큼 걸린다. 한 번에 기록하면 그 ps 시간 동안 session.json
 * 에 childPid 가 없어, 그 윈도우에 소유 mat 이 죽고 subshell 이 장기 생존하면 reapOrphans 가
 * childPid 부재 메타를 옛 메타로 오인해 라이브 세션을 삭제할 수 있다. 따라서:
 *  1) spawn 직후 **childPid 만 먼저** 기록 (ps 호출 전) — 보호 윈도우를 ps 시간만큼 제거한다.
 *  2) 그 다음 서명을 구해 **childPidStart 를 후속 기록** — best-effort, 실패해도 spawn 미차단.
 *
 * 각 write 는 완결된 meta(half-update 아님)를 쓴다 — 1단계 후 meta 는 {childPid, childPidStart:
 * undefined}(옛-메타 동형 liveness-only 가 아닌 unknown 으로 안전 처리됨, 결함2), 2단계 후
 * {childPid, childPidStart} 로 in-memory/on-disk 정합을 유지한다. 서명 조회 실패는 undefined
 * 폴백. 기록 실패는 경고만 남기고 라이프사이클을 막지 않는다 — 자식 추적은 보강이라 부재 시 안전 degrade.
 *
 * **pid 재사용 방어 (#71 결함, round3 Codex HIGH)**: 서명 캡처(`processStartSignature`)는 ps exec 라
 * 최대 PS_SIGNATURE_TIMEOUT_MS 걸린다. 그 사이 child(subshell)가 exit 하고 OS 가 그 pid 를 **재사용**
 * 하면, ps 가 무관 프로세스의 시작 서명을 잡아 childPidStart 로 굳을 수 있다 → classifyChildOwner 가
 * 그 무관 프로세스를 '서명 일치 라이브 child owner' 로 오인해 bounded TTL 을 우회한 영구 보존이 발생한다.
 * 이를 막기 위해 서명을 구한 **뒤 그 값을 기록하기 직전에 `isChildAlive()` 로 child 생존을 재확인**한다.
 * child 가 이미 종료했으면(`!isChildAlive()`) 죽은 child 의 pid 서명은 재사용된 무관 서명일 수 있어
 * **기록하지 않는다(childPidStart 미설정 → undefined 유지)** → classifyChildOwner 가 'unknown' 으로
 * 처리해 bounded TTL(UNKNOWN_TTL_MS) 회수 경로를 타게 한다. child 가 살아있으면 서명(또는 ps 실패 시
 * undefined)을 정상 기록한다. childPid(1단계)는 생존 여부와 무관하게 항상 먼저 기록한다(round1 수정 유지
 * — reapOrphans 가 옛 메타로 라이브 세션을 오삭제하는 것을 방지).
 */
async function recordChildPid(
  id: string,
  meta: SessionMeta,
  childPid: number,
  isChildAlive: () => boolean
): Promise<void> {
  try {
    // 1단계: childPid 만 먼저 persist (ps 호출 전) — childPid 부재 보호 윈도우 제거.
    meta.childPid = childPid;
    await writeSessionMeta(id, meta);
    // 2단계: 서명을 구한다 (best-effort). ps 가 느려도 1단계로 이미 childPid 는 디스크에 있어
    // reapOrphans 가 라이브 세션을 옛 메타로 오삭제하지 않는다.
    const sig = (await processStartSignature(childPid)) ?? undefined;
    // child 가 서명 캡처 전/중 종료했으면 재사용된 pid 의 무관 서명일 수 있어 기록하지 않는다 →
    // classifyChildOwner 가 unknown(bounded TTL)으로 처리. 살아있을 때만 서명을 persist 한다.
    if (isChildAlive()) {
      meta.childPidStart = sig;
      await writeSessionMeta(id, meta);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mat] 자식 pid 기록 실패 (계속 진행): ${sanitizeForStderr(message)}\n`);
  }
}

/** 세션 id 생성 — `<cli>-<profile>-<rand8>`. profile 은 sessionId 화이트리스트로 sanitize + 길이 cap. */
function makeSessionId(cliId: string, profileName: string): string {
  const rand8 = randomBytes(4).toString('hex');
  const safeCli = cliId.slice(0, 24);
  const safeProfile = profileName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  const id = `${safeCli}-${safeProfile}-${rand8}`;
  return validateSessionId(id); // 방어 — 위 sanitize 로 항상 통과
}

function buildSessionChildEnv(plan: SessionPlan, target: SessionSpawnTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // session child 는 profile copy-isolate 를 우회할 수 있는 host provider credential env 를
  // 기본 상속하지 않는다. 광범위한 TOKEN/PAT 패턴 삭제는 호환성 영향이 커서 고신뢰 목록만 처리한다.
  for (const name of SESSION_CHILD_CREDENTIAL_ENV_DENY) delete env[name];

  // AWS/GCP SDK fallback 이 host shared credential/config/metadata 를 읽지 않게 한다.
  Object.assign(env, SESSION_CHILD_CREDENTIAL_ENV_HARDENING);

  if (target.kind === 'command' && target.env) {
    for (const [name, value] of Object.entries(target.env)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }

  // 내부 invariant 는 마지막에 주입한다. hostile inherited env 나 target.env 충돌이 있어도
  // MAT_SESSION 과 CLI-specific root redirect 가 항상 실제 세션을 가리켜야 한다.
  env.MAT_SESSION = plan.id;
  for (const root of plan.roots) env[root.env] = root.dir; // 격리 디렉토리 주입 (토큰 미포함, 경로만)
  return env;
}

/**
 * session child spawn (stdio inherit, env 에 root env + MAT_SESSION 주입, 셸 미경유 argv).
 *
 * - `kind:'shell'`: 기존 `mat session start` — `$SHELL` 을 argv 없이 spawn.
 * - `kind:'command'`: `mat session run` — builtin executable 을 직접 spawn 하고 사용자가 준 tail 을
 *   argv 로만 전달. shell/alias 는 거치지 않는다.
 *
 * `onSpawned` 는 spawn 직후 child.pid 가 유효한 정수일 때 1회 호출된다 (#63-2, await 하지 않음) —
 * 자식 pid 추적 정보를 session.json 에 기록할 기회를 호출자에게 준다. 콜백은 즉시 시작만 하고 그
 * 완료를 여기서 기다리지 않으므로(child exit/error 이벤트로만 resolve 해 데드락 회피), runSession 이
 * 반환된 promise 를 캡처해 종료 정리(recapture/removeSessionDir) 전에 그 완료를 보장한다 (#71 결함:
 * 빨리 exit 한 child 의 cleanup 이 진행 중인 콜백의 write 보다 앞서 디렉토리를 지워 orphan session.json
 * 을 남기는 race 차단). 콜백 throw/실패는 spawn 라이프사이클을 막지 않게 호출자가 best-effort 로
 * 흡수해야 한다. spawn 실패로 child.pid 가 undefined 면 호출 안 함.
 *
 * 콜백에는 `isChildAlive` 도 함께 넘긴다 (#71 round3 결함): child 객체로 `exitCode == null &&
 * signalCode == null` 을 평가해 호출 시점의 child 생존을 알려준다. recordChildPid 가 서명 캡처(ps)
 * 후 그 값을 기록하기 직전 이 함수로 child 가 이미 exit 했는지 확인해, 재사용된 pid 의 무관 서명을
 * childPidStart 로 굳히지 않게 한다.
 */
function spawnSessionTarget(
  plan: SessionPlan,
  target: SessionSpawnTarget,
  childRef: { current: ChildProcess | null },
  onSpawned?: (childPid: number, isChildAlive: () => boolean) => Promise<void>
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const command = target.kind === 'shell' ? (process.env.SHELL || '/bin/sh') : target.executable;
    const args = target.kind === 'shell' ? [] : target.args;
    const env = buildSessionChildEnv(plan, target);
    const child = spawn(command, args, { stdio: 'inherit', env });
    childRef.current = child;

    // child 생존 확인 함수 — exit/signal 로 종료하면 exitCode/signalCode 중 하나가 non-null 이 된다.
    // recordChildPid 가 서명 기록 직전 호출해 죽은 child 의 재사용 pid 서명 오기록을 막는다 (#71 round3).
    const isChildAlive = (): boolean => child.exitCode == null && child.signalCode == null;

    // 자식 pid 가 유효하면 추적 콜백 호출 (best-effort — 콜백 실패가 spawn 을 막지 않게 호출자 책임).
    if (onSpawned && Number.isInteger(child.pid) && (child.pid as number) > 0) {
      void onSpawned(child.pid as number, isChildAlive);
    }

    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      childRef.current = null;
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      action();
    };
    child.on('error', (err) => settle(() => reject(err)));
    child.on('exit', (code, signal) => settle(() => resolve({ code, signal })));
  });
}

/** SIGINT/SIGTERM/SIGHUP 을 subshell 에 forward (exec.ts registerForwarders 동형). */
function registerSessionForwarders(childRef: {
  current: ChildProcess | null;
}): { dispose(): void } {
  const handlers = SESSION_FORWARD_SIGNALS.map((sig) => {
    const handler = () => {
      const child = childRef.current;
      if (!child) return;
      if (child.exitCode != null || child.signalCode != null) return;
      try {
        child.kill(sig);
      } catch {
        /* best-effort */
      }
    };
    process.on(sig, handler);
    return { sig, handler };
  });
  return {
    dispose() {
      for (const { sig, handler } of handlers) process.removeListener(sig, handler);
    }
  };
}

/** 재캡처를 best-effort 로 — 실패/timeout 은 stderr 안내 후 error 반환(정리는 계속 진행). */
async function recaptureBestEffort(plan: SessionPlan): Promise<Error | undefined> {
  try {
    await recaptureSession(plan);
    return undefined;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(
      `[mat] 세션 종료 재캡처 실패 (${sanitizeForStderr(plan.cli)}/${sanitizeForStderr(plan.profile)}): ${sanitizeForStderr(e.message)}. ` +
        `'mat freshness ${sanitizeForStderr(plan.cli)}' 로 확인하세요.\n`
    );
    return e;
  }
}

/** session.json 기록 (writeFileAtomic, 0600). */
async function writeSessionMeta(id: string, meta: SessionMeta): Promise<void> {
  await writeFileAtomic(join(sessionDir(id), 'session.json'), JSON.stringify(meta, null, 2));
}

/** session.json 읽기. 없거나 손상되면 null. */
async function readSessionMeta(id: string): Promise<SessionMeta | null> {
  try {
    const raw = await fs.readFile(join(sessionsDir(), id, 'session.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionMeta>;
    // pid 는 양의 정수여야 — 손상/조작된 메타(음수/0/소수/NaN)는 unreadable 로 처리해 신호·
    // liveness 경로로 흘러들지 않게 한다 (PR #61 2회차 Forge). isProcessAlive 도 가드하나 경계 방어.
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return null;
    }
    // childPid 는 양의 정수만 인정 — 손상/조작된 값(음수/0/소수/NaN)은 undefined 로 떨궈
    // 자식 생존 가드가 무관 프로세스를 살아있다고 오판하지 않게 한다 (#63-2, pid 파싱과 동형).
    const childPid =
      typeof parsed.childPid === 'number' &&
      Number.isInteger(parsed.childPid) &&
      parsed.childPid > 0
        ? parsed.childPid
        : undefined;
    return {
      id: parsed.id,
      cli: typeof parsed.cli === 'string' ? parsed.cli : '',
      profile: typeof parsed.profile === 'string' ? parsed.profile : '',
      pid: parsed.pid,
      pidStart: typeof parsed.pidStart === 'string' ? parsed.pidStart : undefined,
      childPid,
      childPidStart: typeof parsed.childPidStart === 'string' ? parsed.childPidStart : undefined,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      roots: Array.isArray(parsed.roots) ? (parsed.roots as SessionMeta['roots']) : []
    };
  } catch {
    return null;
  }
}

/** sessionsDir 내 세션 디렉토리 id 목록 (없으면 빈 배열). */
async function listSessionIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** 실행 중/orphan 세션 목록 (pid liveness 포함). */
export async function listSessions(): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  for (const id of await listSessionIds()) {
    const meta = await readSessionMeta(id);
    if (!meta) continue;
    out.push({
      id: meta.id,
      cli: meta.cli,
      profile: meta.profile,
      pid: meta.pid,
      startedAt: meta.startedAt,
      alive: isProcessAlive(meta.pid)
    });
  }
  return out;
}

/**
 * 세션 종료 (tri-state 신원 판정 — PR #61 2회차 Forge HIGH):
 *  - `owner`(소유 mat 생존 확인): SIGTERM → 그 finally 가 재캡처+정리.
 *  - `dead-or-reused`(죽음 또는 pid 재사용): 신호 없이 디렉토리만 정리.
 *  - `unknown`(서명 조회 실패로 확정 불가): **신호도 삭제도 하지 않는다** — 소유 mat 이 살아있을
 *    수 있어 kill 하면 무관 프로세스 파괴, 삭제하면 라이브 세션 디렉토리 제거 위험. 경고 후 보존.
 */
export async function stopSession(id: string): Promise<void> {
  validateSessionId(id);
  const meta = await readSessionMeta(id);
  if (!meta) {
    await removeSessionDir(id).catch(() => {
      /* best-effort */
    });
    return;
  }
  const status = await classifyOwner(meta);
  if (status === 'owner') {
    try {
      process.kill(meta.pid, 'SIGTERM');
    } catch {
      /* 이미 죽었으면 다음 호출의 orphan 정리로 */
    }
    return;
  }
  if (status === 'unknown') {
    // pid 살아있으나 소유 여부 확정 불가 — 무관 프로세스 kill / 라이브 디렉토리 삭제 둘 다 회피.
    process.stderr.write(
      `[mat] 세션 ${sanitizeForStderr(id)} 의 소유 프로세스(pid ${meta.pid})를 확인할 수 없습니다 ` +
        `(프로세스 시작 정보 조회 실패) — 안전을 위해 신호/정리를 생략합니다. 잠시 후 다시 시도하세요.\n`
    );
    return;
  }
  // dead-or-reused 라도 자식 subshell 이 살아있거나(owner) 생존 여부 확정 불가(unknown)면 라이브
  // 세션일 수 있어 정리를 회피한다 (#63-2, #71 결함3). stopSession 은 사용자 명시 종료라 TTL 이
  // 없으므로 unknown 도 보수적으로 보존한다 — bounded 회수는 reapOrphans 의 unknown TTL 이 담당.
  if ((await classifyChildOwner(meta)) !== 'dead-or-reused') {
    process.stderr.write(
      `[mat] 세션 ${sanitizeForStderr(id)} 의 자식 프로세스(pid ${meta.childPid}) 생존 여부를 ` +
        `확정할 수 없어 정리를 생략합니다 (라이브 세션 가능성). 자식 종료 후 다시 시도하세요.\n`
    );
    return;
  }
  await removeSessionDir(id); // dead-or-reused (소유 mat·자식 모두 죽음) — 재캡처 없이 정리
}

/**
 * orphan 세션 회수 — 소유 프로세스 신원에 따라 회수 경로가 갈린다. 재캡처 없이 삭제 + 경고.
 * 회수한 id 목록 반환. (모든 경로에서 자식 subshell 생존 시 보존 — #63-2)
 *
 * 회수 여부는 소유 mat·자식 신원을 결합한 **명확한 우선순위**로 결정한다 (#71 결함3 — child
 * 'unknown' 이 bounded TTL 을 우회해 무한 보존되던 결함 해소):
 *  (a) 소유 mat = 'owner'(서명 확인 생존) → 무조건 보존.
 *  (b) 자식 = 'owner'(서명 확인 생존) → 무조건 보존.
 *  (c) 그 외 — owner/child 중 'unknown'(확정 불가)이 하나라도 끼면 **UNKNOWN_TTL_MS(24h)** 기반
 *      bounded 회수, 둘 다 'dead-or-reused' 면 **ORPHAN_TTL_MS(1h)** 기반 회수.
 *
 * 소유 mat × 자식 신원 결정 매트릭스 (행=mat 신원, 열=child 신원; 값=적용 TTL 또는 보존):
 * ```
 *  mat \ child:    owner       unknown      dead-or-reused
 *  owner           보존(a)     보존(a)      보존(a)
 *  unknown         보존(b)     24h(c)       24h(c)
 *  dead-or-reused  보존(b)     24h(c)       1h(c)
 * ```
 * (mat='owner' 행은 (a), child='owner' 열은 (b) 로 TTL 평가 전에 early-continue → 절대 회수 안 함.)
 *
 * 핵심 불변식: **확실히 살아있는(owner) 부모나 자식이 있으면 절대 회수하지 않는다.** unknown 은
 * 무한 보존하지 않고 충분히 긴 TTL(24h)로 bounded 회수해, ps 영구 불능 환경의 orphan 무한 잔존을
 * 막되 라이브 child 오삭제는 긴 TTL 로 방지한다. pid 가 살아있어도 **SIGTERM 은 보내지 않고**
 * 디렉토리만 삭제한다 — 무관 프로세스 kill 회피. TTL 회수는 startedAt·디렉토리 mtime 이 둘 다
 * 초과일 때만(교차검증, M-B).
 */
export async function reapOrphans(): Promise<string[]> {
  const now = Date.now();
  const reaped: string[] = [];
  for (const id of await listSessionIds()) {
    const meta = await readSessionMeta(id);
    if (!meta) continue;
    const ownerStatus = await classifyOwner(meta);
    if (ownerStatus === 'owner') continue; // (a) 소유 mat 생존 확인 → 보존
    const childStatus = await classifyChildOwner(meta);
    if (childStatus === 'owner') continue; // (b) 자식 생존 확인 → 라이브 세션 보존
    // (c) owner/child 중 unknown 이 하나라도 있으면 24h, 둘 다 dead-or-reused 면 1h.
    const isUnknown = ownerStatus === 'unknown' || childStatus === 'unknown';
    const ttl = isUnknown ? getUnknownTtlMs() : ORPHAN_TTL_MS;
    if (!(await isReapableByTtl(id, meta.startedAt, now, ttl))) continue; // startedAt·mtime 둘 다 초과만 회수
    await removeSessionDir(id).catch(() => {
      /* best-effort */
    });
    writeReapWarning(id, isUnknown ? 'unknown' : 'dead-or-reused');
    reaped.push(id);
  }
  return reaped;
}

/**
 * startedAt 과 세션 디렉토리 mtime 이 둘 다 ttl 초과인지 — 죽은 세션 식별 안정성 교차검증 (M-B).
 *
 * 파라미터는 의존하는 값만 받는다(`startedAt` + `id`) — 전체 `SessionMeta` 가 아니라 실제
 * 사용하는 `startedAt` 만 명시해 계약을 좁혔다 (#71 follow-up, cosmetic). 회수 판정이
 * pid/childPid 등 메타의 다른 필드와 무관함을 시그니처로 드러낸다. `id` 는 세션 디렉토리
 * mtime 교차검증(M-B)에만 쓰인다.
 */
async function isReapableByTtl(
  id: string,
  startedAt: string,
  now: number,
  ttl: number
): Promise<boolean> {
  const startedMs = Date.parse(startedAt);
  if (Number.isFinite(startedMs) && now - startedMs <= ttl) return false; // TTL 내 보존
  // 세션 디렉토리 자체 mtime 교차검증 (격리본 mtime 아님 — 죽은 세션 식별 안정성, M-B).
  let dirMtime = 0;
  try {
    dirMtime = (await fs.stat(sessionDir(id))).mtimeMs;
  } catch {
    return false;
  }
  return now - dirMtime > ttl; // 최근 디렉토리면 보존
}

/** 회수 사유별 stderr 경고 — unknown 은 소유 확인 불가임을 명시한다 (#63-1). */
function writeReapWarning(id: string, status: OwnerStatus): void {
  if (status === 'unknown') {
    process.stderr.write(
      `[mat] unknown 세션 TTL 초과 회수: ${sanitizeForStderr(id)} ` +
        `(소유 확인 불가 — 프로필은 마지막 정상 재캡처 상태).\n`
    );
    return;
  }
  process.stderr.write(
    `[mat] orphan 세션 회수: ${sanitizeForStderr(id)} ` +
      `(비정상 종료 — 프로필은 마지막 정상 재캡처 상태).\n`
  );
}
