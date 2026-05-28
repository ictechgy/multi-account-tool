/**
 * adapter contract test — fixture 기반 회귀 가드 (PR-T).
 *
 * tests/fixtures/oauth/<cli>/*.json 의 각 fixture 를 로드해 adapter.compare 의
 * 분류 결과가 expected 와 일치하는지 검증한다. 새 fixture 추가 = 자동 회귀 가드.
 *
 * 목적:
 *  - adapter 분류 로직 변경이 의도된 결과인지 fixture diff 로 검증
 *  - 새 adapter 추가 시 동일 패턴으로 contract 정의 가능
 *  - CI 가 fixture vs adapter 일관성을 자동 검증 (npm run test:contract)
 *
 * fixture 포맷은 tests/fixtures/oauth/README.md 참고.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getAdapter,
  type CompareKind,
  type Confidence,
  type RotatedSubtype
} from '../../src/core/freshness.js';
import { registerAllBuiltinAdapters } from '../../src/core/freshness-adapters/index.js';

interface ExpectedFields {
  kind: CompareKind;
  subtype?: RotatedSubtype;
  confidence?: Confidence;
}

interface FixtureCase {
  name: string;
  cli: string;
  saveAs: string;
  stored: string;
  live: string;
  expected: ExpectedFields;
}

interface LoadedFixture extends FixtureCase {
  file: string;
}

const FIXTURE_ROOT = join(__dirname, '../fixtures/oauth');

/**
 * 모든 fixture 디렉토리 (README.md 제외) 의 *.json 을 로드. 비어 있는 디렉토리는
 * skip — 각 cli 별 fixture 가 누락돼도 다른 cli 검증은 계속 진행.
 */
function loadAllFixtures(): LoadedFixture[] {
  const out: LoadedFixture[] = [];
  const entries = readdirSync(FIXTURE_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cliDir = join(FIXTURE_ROOT, entry.name);
    const files = readdirSync(cliDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const raw = readFileSync(join(cliDir, file), 'utf8');
      const fixture = JSON.parse(raw) as FixtureCase;
      out.push({ ...fixture, file: `${entry.name}/${file}` });
    }
  }
  return out;
}

describe('adapter contract — fixture 기반 회귀 가드 (PR-T)', () => {
  // adapter 들이 등록되어 있어야 한다.
  registerAllBuiltinAdapters();

  const fixtures = loadAllFixtures();

  // sanity check: 최소 1개 이상 fixture 가 있어야 함 (CI 가 silent pass 차단).
  it('fixture 디렉토리가 비어 있지 않다', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // 각 fixture 가 자체 describe 블록 — vitest UI 에서 fixture 별 통과/실패 식별 용이.
  for (const fixture of fixtures) {
    describe(`fixture ${fixture.file}`, () => {
      it(`${fixture.name}`, () => {
        const adapter = getAdapter(fixture.cli);
        // adapter 가 등록되어 있지 않으면 fixture 자체가 잘못된 케이스.
        expect(adapter, `adapter for cli=${fixture.cli} not registered`).toBeTruthy();

        const result = adapter!.compare(fixture.saveAs, fixture.stored, fixture.live);

        // kind 는 항상 검증.
        expect(result.kind, 'kind mismatch').toBe(fixture.expected.kind);

        // subtype / confidence 는 fixture 에 명시된 경우만 검증.
        if (fixture.expected.subtype != null) {
          expect(result.subtype, 'subtype mismatch').toBe(fixture.expected.subtype);
        }
        if (fixture.expected.confidence != null) {
          expect(result.confidence, 'confidence mismatch').toBe(fixture.expected.confidence);
        }
      });
    });
  }
});
