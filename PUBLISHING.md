# 배포 가이드 (npm + Homebrew)

> 이 문서는 `multi-account-tool` (`mat`) 을 npm 과 Homebrew 두 채널로 배포하는 절차를 정리한다.

---

## 사전 준비

- [ ] GitHub 저장소: `ictechgy/multi-account-tool` 생성 후 push
- [ ] Homebrew tap 저장소: `ictechgy/homebrew-mat` 생성 (이름은 반드시 `homebrew-<탭명>` 형식)
- [ ] npm 계정 로그인: `npm login`
- [ ] (fork 한 경우만) `package.json` 의 `YOUR-USERNAME`, `YOUR-NAME` 자리표시자를 실제 값으로 일괄 치환
- [ ] (fork 한 경우만) `LICENSE` 의 `YOUR-NAME` 도 치환
- [ ] (fork 한 경우만) `README.md` 의 `YOUR-USERNAME` 도 치환

전체 일괄 치환 예시 (macOS):

```bash
grep -rl 'YOUR-USERNAME' . --exclude-dir=node_modules --exclude-dir=.git \
  | xargs sed -i '' 's/YOUR-USERNAME/jinhongan/g'

grep -rl 'YOUR-NAME' . --exclude-dir=node_modules --exclude-dir=.git \
  | xargs sed -i '' 's/YOUR-NAME/Jinhong An/g'
```

---

## 1. npm 배포

```bash
# 깨끗한 빌드 + 타입체크
npm run typecheck
npm run build

# 버전 bump (semver)
npm version patch   # 또는 minor / major

# 배포 (prepublishOnly 가 빌드 다시 수행)
npm publish --access public
```

성공하면 `https://www.npmjs.com/package/multi-account-tool` 에 노출된다.

사용자는 이제 다음 명령으로 설치 가능:

```bash
npm install -g multi-account-tool
mat
```

> **패키지 이름 충돌 시**: `npm view multi-account-tool` 으로 점유 여부를 미리 확인.
> 이미 사용 중이면 `package.json` 의 `name` 을 (`@your-scope/multi-account-tool` 같은) scoped name 으로 변경.

---

## 2. Homebrew tap 배포

### 2.1 tap 저장소 준비 (최초 1회)

```bash
gh repo create ictechgy/homebrew-mat --public --description "Homebrew tap for mat"
git clone https://github.com/ictechgy/homebrew-mat.git
cd homebrew-mat
mkdir -p Formula
```

### 2.2 Formula 동기화 (배포마다)

새 npm 버전을 publish 한 직후:

```bash
# 1) sha256 계산
VERSION=$(node -p "require('./package.json').version")
curl -sL "https://registry.npmjs.org/multi-account-tool/-/multi-account-tool-${VERSION}.tgz" \
  | shasum -a 256

# 2) Formula/mat.rb 의 url / sha256 갱신
#    (이 저장소의 Formula/mat.rb 를 참고용 템플릿으로 사용)

# 3) tap 저장소에 push
cd ../homebrew-mat
cp ../multi-account-tool/Formula/mat.rb Formula/mat.rb
# (Formula/mat.rb 의 url 과 sha256 을 실제 값으로 갱신)
git add Formula/mat.rb
git commit -m "Update mat to v${VERSION}"
git push
```

### 2.3 사용자 설치

```bash
brew tap ictechgy/mat
brew install mat
mat
```

업데이트는 `brew update && brew upgrade mat`.

---

## 3. GitHub Actions 자동화

v0.2.x 부터 두 워크플로가 추가됨:

### 3.1 `.github/workflows/ci.yml` — PR 검증

`main` push / PR 시 자동 실행. matrix:
- OS: `macos-latest`, `ubuntu-latest` (package.json os 제한과 동일)
- Node: `18.17`, `20`, `22`

각 조합마다 `npm ci` → `typecheck` → `test` (vitest) → `build` → `check-publish-readiness` 순으로 실행. smoke-test 는 CI 환경에선 자격증명 없어 missing 으로 나오므로 `continue-on-error: true`.

### 3.2 `.github/workflows/publish.yml` — Trusted Publishing

tag `v*` push 시 자동으로 npm 에 OIDC publish (`--provenance` attestation 첨부).

**사전 설정 (최초 1회, npmjs.com 웹 UI)**:
1. https://www.npmjs.com/package/multi-account-tool/access → "Trusted Publisher" → "Add Trusted Publisher"
2. 설정값:
   - **Publisher**: `GitHub Actions`
   - **Organization / user**: `ictechgy`
   - **Repository**: `multi-account-tool`
   - **Workflow filename**: `publish.yml`
   - **Environment**: (비우거나 `npm-publish` 같은 이름 — workflow 의 `jobs.publish.environment` 와 일치해야 함, 현재는 미사용)
3. Save. 이후로 NPM_TOKEN secret 불필요.

**배포 절차 (v0.3 이후)**:
```bash
# 1. main 에서 version bump (commit + tag 자동 생성)
npm version minor  # 또는 patch / major

# 2. main commit + tag push → workflow 자동 trigger
git push --follow-tags

# 3. https://github.com/ictechgy/multi-account-tool/actions 에서 workflow 결과 확인
#    "Publish to npm" job 이 success 면 npm 에 publish 완료
```

workflow 가 `--provenance` 로 publish 하므로 패키지 페이지 (`https://www.npmjs.com/package/multi-account-tool`) 에 "Provenance" badge 가 표시되어 빌드 출처를 검증할 수 있다.

**tag 와 package.json version 일치 검증**: workflow 의 `Verify tag matches package version` step 이 사전 차단. `npm version` 이 둘 다 동시 갱신하므로 정상 흐름에선 깨지지 않음.

### 3.3 Homebrew tap 자동화 (미구현, 후속)

현재 tap repo (`ictechgy/homebrew-mat`) 의 `Formula/mat.rb` url/sha256 갱신은 수동. 자동화하려면 publish workflow 마지막 단계에 deploy key 또는 PAT 로 tap repo 에 commit & push 추가 필요.

---

## 4. 버전 체크리스트

배포 직전 확인 사항:

- [ ] `npm run typecheck` 통과
- [ ] `npm run build` 성공 (`dist/cli.js` 에 shebang 존재)
- [ ] `node scripts/smoke-test.mjs` 모두 PASS
- [ ] README 의 설치 명령어가 최신 패키지명/태그 반영
- [ ] CHANGELOG (있다면) 갱신
- [ ] 시맨틱 버전 적절히 bump
