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
 *  - allow-list(`SessionRoot.share`): read-mostly 비-secret config 만 실제 base 로 symlink
 *    공유(대상이 symlink 면 거부 — fail-closed). **1차 빌트인 메타는 share=∅**(M-A).
 *  - 그 외 base 엔트리: materialize 안 함(세션 내 ephemeral) — fail-closed.
 *
 * 종료 재캡처는 `switcher.applyRestorePlan` 패턴으로 **원자화**하되, timeout 을 재캡처
 * 전체-race 가 아니라 **각 write(cred 단위)** 에 걸어 hang 시에도 롤백이 우회되지 않게 한다
 * (C1 — exec.ts:276-297 구조 미러). split 상태(절반 새/절반 옛 토큰)를 방지.
 *
 * 이 모듈은 부작용 코어(planSession/materializeSession/recaptureSession/removeSessionDir)
 * 를 export 한다. spawn/시그널/라이프사이클(runSession 등)은 PR-S3 에서 추가된다.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { findCliDef } from './cli-defs.js';
import { UsageError } from './errors.js';
import { writeFileAtomic } from './io-atomic.js';
import { isProcessAlive, sanitizeForStderr } from './lockfile.js';
import { expandTilde, sessionDir, sessionsDir, validateSessionId } from './paths.js';
import {
  profileExists,
  readProfileFile,
  validateProfileName,
  writeProfileFile
} from './profile-store.js';
import type { CliDef } from './types.js';

/** 재캡처 write 의 타임아웃 (ms, default 10s). `mat exec` 와 동일 env 재사용 (신규 env 금지). */
function getRecaptureTimeoutMs(): number {
  const raw = process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
  if (!raw) return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/** Promise.race timeout — timer cleanup 보장 (exec.ts withTimeout 동형). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 시작 시점에 고정되는 자격증명 매핑 (종료 시 재계산 금지 — 시작/종료 불일치 차단). */
interface SessionCred {
  /** 프로필 내 파일명 (readProfileFile/writeProfileFile 의 fileName). */
  saveAs: string;
  /** base 기준 상대경로 (= 세션 디렉토리 내 격리본 위치). */
  rel: string;
  /** 세션 격리본 절대경로 (실파일, non-symlink). */
  absInSession: string;
}

/** 한 env-root 의 materialize 계획. */
interface MaterializedRoot {
  /** 주입할 env var 이름. */
  env: string;
  /** 세션 디렉토리 내 이 root 의 디렉토리 (env 값으로 주입). */
  dir: string;
  /** 실제 base 절대경로 (allow-list symlink 대상 계산용). */
  baseAbs: string;
  /** 이 root 의 자격증명 격리본 목록. */
  creds: SessionCred[];
  /** base 와 symlink 공유할 read-mostly config (base 상대경로, cred 와 disjoint). */
  share: string[];
}

/** 시작 시점 고정 세션 계획. */
export interface SessionPlan {
  id: string;
  cli: string;
  profile: string;
  roots: MaterializedRoot[];
}

/** source(file)가 base 의 직속 자식인지 — rel 이 비어있지 않고 `..`/구분자 미포함. */
function directChildRel(baseAbs: string, fileAbs: string): string | null {
  const rel = relative(baseAbs, fileAbs);
  if (rel === '' || rel.startsWith('..') || rel.includes(sep)) return null;
  return rel;
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
    baseAbs: expandTilde(r.base).replace(/\/+$/, ''),
    creds: [] as SessionCred[]
  }));

  for (const src of def.sources) {
    if (src.type !== 'file') {
      throw new UsageError(
        `세션 격리는 file source 만 지원합니다 (${def.id}: '${src.type}' source).`
      );
    }
    const fileAbs = expandTilde(src.path);
    const matches = rootData.filter((rd) => directChildRel(rd.baseAbs, fileAbs) !== null);
    if (matches.length !== 1) {
      throw new UsageError(
        `source '${src.path}' 가 정확히 1개 root 의 base 직속이 아닙니다 ` +
          `(매칭 ${matches.length}개). 비직속 자격증명은 1차 미지원.`
      );
    }
    const rd = matches[0];
    rd.creds.push({ saveAs: src.saveAs, rel: directChildRel(rd.baseAbs, fileAbs)!, absInSession: '' });
  }

  const roots: MaterializedRoot[] = rootData.map((rd) => {
    const dir = join(sessionDir(id), rd.root.env);
    const share = rd.root.share ?? [];
    const credRels = new Set(rd.creds.map((c) => c.rel));
    for (const s of share) {
      if (credRels.has(s)) {
        throw new UsageError(`share 항목 '${s}' 가 자격증명과 겹칩니다 (자격증명은 항상 격리 복사).`);
      }
    }
    return {
      env: rd.root.env,
      dir,
      baseAbs: rd.baseAbs,
      share,
      creds: rd.creds.map((c) => ({ ...c, absInSession: join(dir, c.rel) }))
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
  if (await pathExists(sdir)) {
    throw new Error(`세션 디렉토리가 이미 존재합니다: ${plan.id}`);
  }
  try {
    await fs.mkdir(sdir, { recursive: true, mode: 0o700 });
    for (const root of plan.roots) {
      await fs.mkdir(root.dir, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(root.dir)).isSymbolicLink()) {
        throw new Error(`세션 root 가 symlink 입니다: ${root.dir}`);
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
        await writeFileAtomic(cred.absInSession, value);
      }
      // (나중) allow-list symlink — 대상이 symlink/부재면 거부 (fail-closed).
      for (const shareRel of root.share) {
        const target = join(root.baseAbs, shareRel);
        let tst;
        try {
          tst = await fs.lstat(target);
        } catch {
          throw new Error(`allow-list 대상이 base 에 없습니다: ${target}`);
        }
        if (tst.isSymbolicLink()) {
          throw new Error(`allow-list 대상이 symlink 입니다 (공유 거부): ${target}`);
        }
        const linkPath = join(root.dir, shareRel);
        await fs.mkdir(dirname(linkPath), { recursive: true });
        await fs.symlink(target, linkPath);
      }
    }
  } catch (err) {
    await removeSessionDir(plan.id).catch(() => {
      /* best-effort 롤백 — 원본 에러 전파 */
    });
    throw err;
  }
}

/** 재캡처 1건 단위 (preflight 수집물). */
interface RecaptureItem {
  saveAs: string;
  /** 프로필 현재값 (롤백 백업). 신규 프로필이면 null. */
  backup: string | null;
  /** 격리본 새 값. */
  newValue: string;
}

/**
 * 종료 재캡처 (원자적, switcher.applyRestorePlan + exec.ts:276-297 미러 — C1).
 *  - preflight: 각 cred 의 (프로필 현재값=롤백 백업) + (격리본 새 값) 수집. 격리본 부재는 skip.
 *  - 순차 적용: 각 writeProfileFile 을 **cred 단위 withTimeout** 으로 감싼다 (전체-race 금지).
 *  - 한 cred 실패/timeout → applied 역순 백업 원복(롤백 write 도 cred 단위 timeout + best-effort)
 *    후 원본 에러 throw. split(절반 새/절반 옛) 방지.
 */
export async function recaptureSession(plan: SessionPlan): Promise<void> {
  const items: RecaptureItem[] = [];
  for (const root of plan.roots) {
    for (const cred of root.creds) {
      let newValue: string;
      try {
        newValue = await fs.readFile(cred.absInSession, 'utf8');
      } catch {
        process.stderr.write(
          `[mat] 세션 격리본 부재 — 재캡처 skip: ${plan.cli}/${plan.profile}/${cred.saveAs}\n`
        );
        continue;
      }
      const backup = await readProfileFile(plan.cli, plan.profile, cred.saveAs);
      items.push({ saveAs: cred.saveAs, backup, newValue });
    }
  }

  const ms = getRecaptureTimeoutMs();
  const applied: RecaptureItem[] = [];
  try {
    for (const it of items) {
      await withTimeout(
        writeProfileFile(plan.cli, plan.profile, it.saveAs, it.newValue),
        ms,
        `recapture(${it.saveAs})`
      );
      applied.push(it);
    }
  } catch (err) {
    // 이미 적용한 cred 들을 백업값으로 역순 원복 (split 방지). 롤백 write 도 timeout+best-effort.
    for (const it of applied.reverse()) {
      if (it.backup == null) continue;
      await withTimeout(
        writeProfileFile(plan.cli, plan.profile, it.saveAs, it.backup),
        ms,
        `rollback(${it.saveAs})`
      ).catch(() => {
        /* best-effort — 원본 에러를 전파 */
      });
    }
    throw err;
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

/** 경로 존재 여부 (디렉토리 재사용 가드용). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PR-S3: runSession (spawn + 시그널 + finally) + 라이프사이클(list/stop/orphan)
// exec.ts 의 forwarder/settled-guard/finally 패턴 미러, 단 전역 swap/lock 미사용.
// ─────────────────────────────────────────────────────────────────────────────

/** 외부에서 잡고 자식에게 전달할 시그널 (exec.ts FORWARD_SIGNALS 동형). */
const SESSION_FORWARD_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** orphan 회수 TTL (ms). pid 죽음 AND startedAt 이 이보다 오래됐을 때만 회수 (M2). */
const ORPHAN_TTL_MS = 60 * 60 * 1000; // 1h

export interface SessionStartOptions {
  cliId: string;
  profileName: string;
}

export interface SessionResult {
  /** 자식(subshell) 종료 코드. signal 종료 시 null. */
  code: number | null;
  /** 자식이 받은 시그널 (있으면). */
  signal: NodeJS.Signals | null;
  /** 종료 재캡처 실패/timeout 시 설정. cli.tsx 가 별도 exit code 로 매핑. */
  recaptureError?: Error;
}

/** session.json 스키마 (세션 디렉토리에 기록 — list/orphan 이 읽음). */
interface SessionMeta {
  id: string;
  cli: string;
  profile: string;
  /** 세션을 소유한 mat 프로세스 pid (subshell 아님). */
  pid: number;
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
  const def = findCliDef(opts.cliId);
  if (!def) throw new UsageError(`알 수 없는 CLI: ${opts.cliId}`);
  if (!def.session || def.session.roots.length === 0) {
    throw new UsageError(`'${opts.cliId}' 는 세션 격리를 지원하지 않습니다 (env override 미지원).`);
  }
  const profileName = validateProfileName(opts.profileName);
  if (!(await profileExists(opts.cliId, profileName))) {
    throw new UsageError(`프로필을 찾을 수 없습니다: ${opts.cliId}/${profileName}`);
  }

  await reapOrphans().catch(() => {
    /* best-effort — start 를 막지 않는다 */
  });

  const id = makeSessionId(opts.cliId, profileName);
  const plan = planSession(def, profileName, id);
  await materializeSession(plan); // 세션 디렉토리 생성 + 자격증명 복사
  await writeSessionMeta(id, {
    id,
    cli: opts.cliId,
    profile: profileName,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    roots: plan.roots.map((r) => ({ env: r.env, dir: r.dir }))
  });

  const childRef: { current: ChildProcess | null } = { current: null };
  const forwarders = registerSessionForwarders(childRef);
  try {
    let spawnResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let spawnError: unknown;
    try {
      spawnResult = await spawnSessionShell(plan, childRef);
    } catch (err) {
      spawnError = err;
    }

    // spawn 성공/실패와 무관하게 재캡처 + 정리 (exec.ts runUnderLock 패턴 미러).
    const recaptureError = await recaptureBestEffort(plan);
    await removeSessionDir(id).catch(() => {
      /* best-effort */
    });

    if (spawnError) throw spawnError;
    return { code: spawnResult!.code, signal: spawnResult!.signal, recaptureError };
  } finally {
    forwarders.dispose();
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

/** subshell spawn (stdio inherit, env 에 root env + MAT_SESSION 주입, 셸 미경유 argv). */
function spawnSessionShell(
  plan: SessionPlan,
  childRef: { current: ChildProcess | null }
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/sh';
    const env: NodeJS.ProcessEnv = { ...process.env, MAT_SESSION: plan.id };
    for (const root of plan.roots) env[root.env] = root.dir; // 격리 디렉토리 주입 (토큰 미포함, 경로만)
    const child = spawn(shell, [], { stdio: 'inherit', env });
    childRef.current = child;

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
      `[mat] 세션 종료 재캡처 실패 (${plan.cli}/${plan.profile}): ${sanitizeForStderr(e.message)}. ` +
        `'mat freshness ${plan.cli}' 로 확인하세요.\n`
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
    if (typeof parsed.id !== 'string' || typeof parsed.pid !== 'number') return null;
    return {
      id: parsed.id,
      cli: typeof parsed.cli === 'string' ? parsed.cli : '',
      profile: typeof parsed.profile === 'string' ? parsed.profile : '',
      pid: parsed.pid,
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

/** 세션 종료. 살아있으면 SIGTERM(소유 mat 의 finally 가 정리), 죽었으면 orphan 정리. */
export async function stopSession(id: string): Promise<void> {
  validateSessionId(id);
  const meta = await readSessionMeta(id);
  if (!meta) {
    await removeSessionDir(id).catch(() => {
      /* best-effort */
    });
    return;
  }
  if (isProcessAlive(meta.pid)) {
    try {
      process.kill(meta.pid, 'SIGTERM');
    } catch {
      /* 이미 죽었으면 아래 orphan 정리로 */
    }
    return;
  }
  await removeSessionDir(id); // 죽은 세션 — 재캡처 없이 정리
}

/**
 * orphan 세션 회수 — pid 죽음 AND startedAt TTL 초과 AND 세션 디렉토리 mtime TTL 초과
 * (셋 다 충족만, 보수적). 재캡처 없이 삭제 + 경고. 회수한 id 목록 반환.
 */
export async function reapOrphans(): Promise<string[]> {
  const now = Date.now();
  const reaped: string[] = [];
  for (const id of await listSessionIds()) {
    const meta = await readSessionMeta(id);
    if (!meta) continue;
    if (isProcessAlive(meta.pid)) continue; // 살아있으면 보존
    const startedMs = Date.parse(meta.startedAt);
    if (Number.isFinite(startedMs) && now - startedMs <= ORPHAN_TTL_MS) continue; // TTL 내 보존
    // 세션 디렉토리 자체 mtime 교차검증 (격리본 mtime 아님 — 죽은 세션 식별 안정성, M-B).
    let dirMtime = 0;
    try {
      dirMtime = (await fs.stat(sessionDir(id))).mtimeMs;
    } catch {
      continue;
    }
    if (now - dirMtime <= ORPHAN_TTL_MS) continue; // 최근 디렉토리 → 보존
    await removeSessionDir(id).catch(() => {
      /* best-effort */
    });
    process.stderr.write(
      `[mat] orphan 세션 회수: ${sanitizeForStderr(id)} ` +
        `(비정상 종료 — 프로필은 마지막 정상 재캡처 상태).\n`
    );
    reaped.push(id);
  }
  return reaped;
}
