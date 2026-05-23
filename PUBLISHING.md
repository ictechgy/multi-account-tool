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

## 3. (선택) GitHub Actions 자동화

태그 push 시 자동으로 npm publish 와 tap 업데이트를 수행하려면 `.github/workflows/release.yml` 를 추가할 수 있다 (이번 v0.1 범위에선 미포함).

핵심 단계:

1. `actions/checkout` + `actions/setup-node`
2. `npm ci && npm run build && npm publish`
3. `curl` 로 sha256 계산
4. `homebrew-mat` 저장소 checkout → Formula 갱신 → commit & push (deploy key 또는 PAT 필요)

자세한 예시는 [JS Tooling — Publishing to Homebrew](https://docs.brew.sh/) 참고.

---

## 4. 버전 체크리스트

배포 직전 확인 사항:

- [ ] `npm run typecheck` 통과
- [ ] `npm run build` 성공 (`dist/cli.js` 에 shebang 존재)
- [ ] `node scripts/smoke-test.mjs` 모두 PASS
- [ ] README 의 설치 명령어가 최신 패키지명/태그 반영
- [ ] CHANGELOG (있다면) 갱신
- [ ] 시맨틱 버전 적절히 bump
