/**
 * cli-defs-plugin 단위 테스트 + getAllCliDefs / findCliDef 의 plugin 통합.
 *
 * setupTmpHome 으로 $HOME 격리 → dataDir() 가 tmp 를 가리키므로
 * `~/.multi-account-tool/cli-defs/` 도 tmp 하위. resetCliDefCache 로 매 테스트마다 캐시 무효화.
 *
 * 검증 매트릭스:
 *  - loadUserCliDefs: 디렉토리 없음 / 빈 디렉토리 / 정상 plugin / .json 외 무시 / 정렬
 *  - 검증 실패 매트릭스: malformed JSON / non-object / id 누락 / id 형식 위반 /
 *    name 누락 / sources 빈 배열 / source.type 잘못 / source.saveAs 위반 / source.path 빈 값 /
 *    source.service 빈 값 / plugin 끼리 id 충돌
 *  - getAllCliDefs / findCliDef 통합: builtin 우선 / plugin 추가 / 충돌 시 warn
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_CLI_DEFS,
  findCliDef,
  getAllCliDefs,
  getCliDefsWarnings,
  resetCliDefCache
} from '../../src/core/cli-defs.js';
import {
  loadUserCliDefs,
  validateCliDefRaw
} from '../../src/core/cli-defs-plugin.js';
import { dataDir } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

function cliDefsDir(): string {
  return join(dataDir(), 'cli-defs');
}

async function writePlugin(name: string, content: unknown): Promise<void> {
  const dir = cliDefsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), JSON.stringify(content));
}

async function writePluginRaw(name: string, raw: string): Promise<void> {
  const dir = cliDefsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), raw);
}

describe('validateCliDefRaw (순수 validator)', () => {
  it('정상 입력 → def 반환, error 없음', () => {
    const r = validateCliDefRaw({
      id: 'aider',
      name: 'Aider',
      sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }]
    });
    expect(r.error).toBeUndefined();
    expect(r.def?.id).toBe('aider');
    expect(r.def?.sources).toHaveLength(1);
  });

  it.each([
    [null, '최상위'],
    [42, '최상위'],
    ['string', '최상위'],
    [['array'], '최상위'],
    [{}, 'id'],
    [{ id: 'x' }, 'name'],
    [{ id: 'x', name: '' }, 'name'],
    [{ id: 'x', name: 'X' }, 'sources'],
    [{ id: 'x', name: 'X', sources: [] }, 'sources'],
    [{ id: '../escape', name: 'X', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] }, 'id'],
    [{ id: 'x', name: 'X', sources: [{ type: 'invalid', saveAs: 'a.json' }] }, 'type'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '/p' }] }, 'saveAs'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '/p', saveAs: '../escape.json' }] }, 'saveAs'],
    [{ id: 'x', name: 'X', sources: [{ type: 'file', path: '', saveAs: 'a.json' }] }, 'path'],
    [{ id: 'x', name: 'X', sources: [{ type: 'keychain', saveAs: 'a.json' }] }, 'service'],
    [{ id: 'x', name: 'X', sources: [{ type: 'keychain', service: '', saveAs: 'a.json' }] }, 'service']
  ])('잘못된 입력 → error 메시지에 "%s" 포함', (raw, expectedKeyword) => {
    const r = validateCliDefRaw(raw);
    expect(r.def).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error).toContain(expectedKeyword as string);
  });

  it('파일/keychain 혼합 sources 정상 처리', () => {
    const r = validateCliDefRaw({
      id: 'mixed',
      name: 'Mixed',
      sources: [
        { type: 'file', path: '/tmp/x', saveAs: 'x.json' },
        { type: 'keychain', service: 'My Service', saveAs: 'y.json' }
      ]
    });
    expect(r.error).toBeUndefined();
    expect(r.def?.sources).toHaveLength(2);
    expect(r.def?.sources[0].type).toBe('file');
    expect(r.def?.sources[1].type).toBe('keychain');
  });
});

describe('loadUserCliDefs — fs 통합', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
  });
  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('cli-defs 디렉토리 없음 → 빈 결과, warning 없음 (조용)', () => {
    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('빈 디렉토리 → 빈 결과', async () => {
    await fs.mkdir(cliDefsDir(), { recursive: true });
    const r = loadUserCliDefs();
    expect(r.defs).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('정상 plugin 1개 → defs 에 포함', async () => {
    await writePlugin('aider.json', {
      id: 'aider',
      name: 'Aider',
      sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }]
    });
    const r = loadUserCliDefs();
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].id).toBe('aider');
    expect(r.warnings).toEqual([]);
  });

  it('.json 확장자 외 파일 무시', async () => {
    await writePlugin('valid.json', { id: 'valid', name: 'Valid', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    await writePluginRaw('README.md', '# 사용자 메모');
    await writePluginRaw('schema.yaml', 'id: ignored');
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['valid']);
  });

  it('파일명 알파벳순 정렬 → 결정적 등장 순서', async () => {
    await writePlugin('z-third.json', { id: 'three', name: 'Three', sources: [{ type: 'file', path: '/3', saveAs: '3.json' }] });
    await writePlugin('a-first.json', { id: 'one', name: 'One', sources: [{ type: 'file', path: '/1', saveAs: '1.json' }] });
    await writePlugin('m-middle.json', { id: 'two', name: 'Two', sources: [{ type: 'file', path: '/2', saveAs: '2.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['one', 'two', 'three']);
  });

  it('JSON 파싱 실패 → warning 추가, 나머지 plugin 은 계속 처리', async () => {
    await writePluginRaw('broken.json', '{ not valid json');
    await writePlugin('valid.json', { id: 'valid', name: 'V', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['valid']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('broken.json');
    expect(r.warnings[0]).toContain('JSON 파싱 실패');
  });

  it('validation 실패 → warning 추가, 나머지 plugin 은 계속 처리', async () => {
    await writePlugin('bad-id.json', { id: '../escape', name: 'Bad', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    await writePlugin('ok.json', { id: 'ok', name: 'OK', sources: [{ type: 'file', path: '/p', saveAs: 'a.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['ok']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('bad-id.json');
  });

  it('plugin 끼리 id 충돌 → 첫 등장만 채택, 후속은 warning + skip', async () => {
    // 파일명 정렬 기준: 'a-x' < 'b-x'. 따라서 a-x 가 채택, b-x 가 skip.
    await writePlugin('a-x.json', { id: 'dup', name: 'A', sources: [{ type: 'file', path: '/a', saveAs: 'a.json' }] });
    await writePlugin('b-x.json', { id: 'dup', name: 'B', sources: [{ type: 'file', path: '/b', saveAs: 'b.json' }] });
    const r = loadUserCliDefs();
    expect(r.defs.map(d => d.id)).toEqual(['dup']);
    expect(r.defs[0].name).toBe('A');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('b-x.json');
    expect(r.warnings[0]).toContain('dup');
  });
});

describe('getAllCliDefs / findCliDef — builtin + plugin 통합', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
  });
  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('plugin 없음 → builtin 만 반환', () => {
    const defs = getAllCliDefs();
    expect(defs.map(d => d.id)).toEqual(BUILTIN_CLI_DEFS.map(d => d.id));
    expect(getCliDefsWarnings()).toEqual([]);
  });

  it('plugin 추가 시 builtin 뒤에 append', async () => {
    await writePlugin('aider.json', {
      id: 'aider', name: 'Aider', sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }]
    });
    const defs = getAllCliDefs();
    expect(defs.map(d => d.id)).toEqual([...BUILTIN_CLI_DEFS.map(d => d.id), 'aider']);
    expect(findCliDef('aider')?.name).toBe('Aider');
  });

  it('id 가 builtin 과 충돌 → plugin 무시 + warning', async () => {
    // 'claude' 는 builtin id — plugin 의 동일 id 는 skip.
    await writePlugin('claude.json', {
      id: 'claude', name: 'Custom Claude', sources: [{ type: 'file', path: '/custom', saveAs: 'custom.json' }]
    });
    const defs = getAllCliDefs();
    expect(defs.filter(d => d.id === 'claude')).toHaveLength(1);  // builtin 만
    expect(findCliDef('claude')?.name).toBe('Claude Code');  // builtin name 유지
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('claude') && w.includes('builtin'))).toBe(true);
  });

  it('module-level 캐시: 두 번째 호출은 fs 재읽지 않음 (resetCliDefCache 로만 갱신)', async () => {
    // 1) 처음 호출: plugin 없음 → builtin 만
    const first = getAllCliDefs();
    expect(first.map(d => d.id)).toEqual(['claude', 'codex', 'gemini']);

    // 2) 캐시 후 plugin 추가 → getAllCliDefs 는 여전히 캐시 반환
    await writePlugin('late.json', { id: 'late', name: 'Late', sources: [{ type: 'file', path: '/l', saveAs: 'l.json' }] });
    const second = getAllCliDefs();
    expect(second.map(d => d.id)).toEqual(['claude', 'codex', 'gemini']);  // 캐시

    // 3) resetCliDefCache 후 호출 → 새로 로드
    resetCliDefCache();
    const third = getAllCliDefs();
    expect(third.map(d => d.id)).toEqual(['claude', 'codex', 'gemini', 'late']);
  });

  it('잘못된 plugin warning 이 getCliDefsWarnings 에 surface 됨', async () => {
    await writePluginRaw('broken.json', 'not json');
    getAllCliDefs();  // 로드 트리거
    const warnings = getCliDefsWarnings();
    expect(warnings.some(w => w.includes('broken.json'))).toBe(true);
  });
});
