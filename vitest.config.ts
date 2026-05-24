import { defineConfig } from 'vitest/config';

// vitest 설정.
// - environment node: ink/JSX 테스트가 아닌 순수 노드 모듈 단위 테스트만 다룬다.
// - pool 'forks': tests/helpers/tmp-home.ts 가 process.env.HOME 을 전역 변경하므로
//   각 테스트 파일을 별도 자식 프로세스에 격리해 동시 worker 의 HOME race 를 회피한다.
//   threads pool 로 바뀌면 같은 process 내 worker 가 HOME 을 덮어써 침묵 회귀 위험.
// - testTimeout 10s: lockfile 의 in-flight write wait (200ms) + 동시 acquire / fs 작업의
//   최악 사례에 충분한 margin. CI 부하 환경까지 고려한 값으로 200ms 의 약 50배는 의도된 여유.
// - coverage v8: src/core 만 측정 (cli.tsx 의 ink UI 렌더 경로는 별도 e2e/smoke 영역).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    pool: 'forks',
    // vitest 4: pool 옵션은 top-level 로 이동. singleFork=false 가 default 이므로 명시 생략.
    // pool='forks' 만으로 각 테스트 파일이 별도 child process 에 격리됨.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/types.ts']
    }
  }
});
