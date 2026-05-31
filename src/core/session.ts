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
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { findCliDef } from './cli-defs.js';
import { UsageError } from './errors.js';
import { writeFileAtomic } from './io-atomic.js';
import { isProcessAlive, sanitizeForStderr } from './lockfile.js';
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
import type { CliDef } from './types.js';

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
    // 후행 구분자 제거 — `/` 와 `\`(Windows) 모두 처리 (Antigravity LOW).
    baseAbs: expandTilde(r.base).replace(/[/\\]+$/, ''),
    creds: [] as SessionCred[]
  }));

  for (const src of def.sources) {
    if (src.type !== 'file') {
      throw new UsageError(
        `세션 격리는 file source 만 지원합니다 (${def.id}: '${src.type}' source).`
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
    // share 항목 traversal-safe 검증 (절대/`..`/구분자 거부) — 정규화된 rel 로 통일 (Codex/Claude MED).
    const share = (rd.root.share ?? []).map((s) => validateShareRel(s));
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
      // (나중) allow-list symlink — 양측 경로 봉쇄 검증 (스펙 §4.2).
      for (const shareRel of root.share) {
        await materializeShareLink(root, shareRel);
      }
    }
  } catch (err) {
    await removeSessionDir(plan.id).catch(() => {
      /* best-effort 롤백 — 원본 에러 전파 */
    });
    throw err;
  }
}

/**
 * allow-list 항목 1개를 base 원본으로 symlink 공유. 스펙 §4.2 양측 검증:
 *  (b) base 측: 대상이 symlink 면 거부(fail-closed) + 대상 부모가 base realpath 하위로 봉쇄
 *      (nested shareRel 의 symlink 컴포넌트 escape 차단).
 *  (a) 세션 측: 링크 부모가 실제 디렉토리(symlink 아님)인지 검증 후 링크 생성.
 * shareRel 은 planSession 의 validateShareRel 로 이미 traversal-safe.
 */
async function materializeShareLink(root: MaterializedRoot, shareRel: string): Promise<void> {
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
  // 일반 파일만 공유 (PR #61 2회차 Forge): 디렉토리를 symlink 하면 그 안의 nested/미래 파일·
  // symlink 가 개별 allow-list 없이 통째 노출돼 좁은 공유 계약이 깨진다. 디렉토리 공유는 미지원.
  if (!tst.isFile()) {
    throw new Error(`allow-list 대상이 일반 파일이 아닙니다 (디렉토리 공유 미지원): ${target}`);
  }
  await assertContainedRealpath(root.baseAbs, dirname(target));

  const linkPath = join(root.dir, shareRel);
  const linkParent = dirname(linkPath);
  await fs.mkdir(linkParent, { recursive: true, mode: 0o700 });
  const pst = await fs.lstat(linkParent);
  if (!pst.isDirectory() || pst.isSymbolicLink()) {
    throw new Error(`allow-list 세션측 부모가 정상 디렉토리가 아닙니다: ${linkParent}`);
  }
  await fs.symlink(target, linkPath);
}

/** child 의 realpath 가 base realpath 하위(또는 동일)인지 — symlink 컴포넌트 escape 차단. */
async function assertContainedRealpath(baseAbs: string, childAbs: string): Promise<void> {
  const baseReal = await fs.realpath(baseAbs);
  const childReal = await fs.realpath(childAbs);
  const rel = relative(baseReal, childReal);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`allow-list 대상이 base 밖을 가리킵니다: ${childAbs}`);
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
 * 종료 재캡처 (2-phase commit — split 방지, PR #61 Codex H1 정정).
 *  - preflight: 각 cred 의 (프로필 현재값=롤백 백업) + (격리본 새 값) 수집. 격리본 부재는 skip.
 *  - phase 1 (stage): 각 cred 의 새 값을 프로필 경로 옆 staging 파일에 쓴다(라이브 무변경).
 *    cred 단위 withTimeout(liveness 보호). 한 건이라도 hang/실패 → commit 이 전무하므로 라이브
 *    프로필은 손상 0(split 0) — staging 만 best-effort 정리 후 throw. hung stage 가 late-landing
 *    해도 staging 임시파일만 오염되고 라이브에 닿지 않는다.
 *  - phase 2 (commit): staging → 라이브 일괄 rename(동일 fs 내 빠른 atomic). rename 은 취소 불가라
 *    withTimeout 으로 감싸지 않는다(timeout 후 late-land 시 롤백 누락 split 방지) — 완료/예외까지
 *    대기. 부분 실패 → 미커밋 staging 정리 + 커밋된 cred 를 compare-and-restore 역순 원복(없던
 *    cred 는 삭제) 후 throw.
 *
 * 한계 (스펙 §6.1): 같은 cli·**같은 프로필**을 동시에 두 세션이 띄우면 재캡처가 lock 없이 같은
 * 프로필에 써서 토큰 세대가 섞일 수 있다(같은 계정 한정 — wrong-account 아님, 다음 사용 시 자가
 * 치유). 본 기능은 터미널마다 다른 프로필 전제. 프로필 단위 lock 은 follow-up 아키텍처 결정.
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
  if (items.length === 0) return;

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
      void u.then(
        (p) => {
          if (!stagedPaths.has(p)) void discardStagedFile(p);
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

/** processStartSignature ps 호출 timeout (ms) — 행 방지. */
const PS_SIGNATURE_TIMEOUT_MS = 2_000;

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

async function classifyOwner(meta: SessionMeta): Promise<OwnerStatus> {
  if (!isProcessAlive(meta.pid)) return 'dead-or-reused';
  if (!meta.pidStart) return 'owner'; // 옛 메타(서명 미기록) — liveness-only
  // 기록된 서명이 현재 버전 형식이 아니면 비교 불가 → unknown(보존). 형식 차이를 재사용으로 오인해
  // 살아있는 세션을 dead-or-reused 로 삭제하는 것을 막는다 (PR #61 3회차 Codex).
  if (!meta.pidStart.startsWith(`${PID_SIG_VERSION}:`)) return 'unknown';
  const liveSig = await processStartSignature(meta.pid);
  if (!liveSig) return 'unknown'; // 현재값 조회 실패 → 확정 불가
  return liveSig === meta.pidStart ? 'owner' : 'dead-or-reused';
}

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
  /**
   * 소유 mat 프로세스의 시작 서명(`ps -o lstart`). pid 재사용 검출용 — pid 가 죽고 재할당된
   * 뒤 다른 프로세스가 같은 pid 를 점유해도 시작 시각이 달라 구분된다. ps 미지원/조회 실패 시
   * undefined (옛 메타도 동일) → liveness-only 폴백 (PR #61 Codex H2).
   */
  pidStart?: string;
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
  // pid 재사용 검출용 시작 서명 (조회 실패해도 세션 생성을 막지 않음 — liveness-only 폴백).
  const pidStart = (await processStartSignature(process.pid)) ?? undefined;
  await writeSessionMeta(id, {
    id,
    cli: opts.cliId,
    profile: profileName,
    pid: process.pid,
    pidStart,
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
    return {
      id: parsed.id,
      cli: typeof parsed.cli === 'string' ? parsed.cli : '',
      profile: typeof parsed.profile === 'string' ? parsed.profile : '',
      pid: parsed.pid,
      pidStart: typeof parsed.pidStart === 'string' ? parsed.pidStart : undefined,
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
  await removeSessionDir(id); // dead-or-reused — 재캡처 없이 정리
}

/**
 * orphan 세션 회수 — 소유 프로세스 사망 AND startedAt TTL 초과 AND 세션 디렉토리 mtime TTL
 * 초과 (셋 다 충족만, 보수적). 재캡처 없이 삭제 + 경고. 회수한 id 목록 반환.
 *
 * "소유 프로세스 사망" 판정은 시작 서명까지 본다 (PR #61 Codex H2): pid 가 재사용돼 살아있는
 * 것처럼 보여도 서명이 다르면(`dead-or-reused`) 회수 대상에 포함 — pid 재사용이 stale 세션을
 * 영구 보존하던 문제 해소. `owner`/`unknown`(서명 조회 실패로 확정 불가)은 보존(보수적 — 살아있는
 * 세션을 잘못 삭제하지 않음, PR #61 2회차 Forge).
 */
export async function reapOrphans(): Promise<string[]> {
  const now = Date.now();
  const reaped: string[] = [];
  for (const id of await listSessionIds()) {
    const meta = await readSessionMeta(id);
    if (!meta) continue;
    if ((await classifyOwner(meta)) !== 'dead-or-reused') continue; // owner/unknown → 보존
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
