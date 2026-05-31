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

import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { UsageError } from './errors.js';
import { writeFileAtomic } from './io-atomic.js';
import { expandTilde, sessionDir, sessionsDir, validateSessionId } from './paths.js';
import { readProfileFile, writeProfileFile } from './profile-store.js';
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
