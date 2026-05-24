import { defineConfig } from 'vitest/config';

// vitest 설정.
// - environment node: ink/JSX 테스트가 아닌 순수 노드 모듈 단위 테스트만 다룬다.
// - testTimeout 10s: lockfile 의 in-flight write wait (200ms) + race 시나리오를 위한 여유.
// - coverage v8: src/core 만 측정 대상 (cli.tsx 의 ink UI 렌더 경로는 별도 e2e/smoke 영역).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/types.ts']
    }
  }
});
