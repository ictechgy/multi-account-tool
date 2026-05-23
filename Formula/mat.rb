# Homebrew formula for `mat` (Multi-Subscription Terminal)
#
# 배포 흐름:
#   1. `npm publish` 로 npm 에 새 버전을 올린다.
#   2. 새 버전의 tarball URL/sha256 으로 아래 url/sha256 을 갱신한다.
#      sha256 계산:
#        curl -sL https://registry.npmjs.org/multi-subscription-terminal/-/multi-subscription-terminal-X.Y.Z.tgz | shasum -a 256
#   3. 이 파일을 `homebrew-mat` tap 저장소 (https://github.com/ictechgy/homebrew-mat)
#      의 Formula/mat.rb 로 복사/푸시한다.
#   4. 사용자는 `brew tap ictechgy/mat && brew install mat` 로 설치한다.
#
# 자세한 안내는 저장소 PUBLISHING.md 참고.

class Mat < Formula
  desc "여러 AI CLI(Claude Code, Codex, Gemini/Antigravity) 계정을 하나의 TUI에서 전환"
  homepage "https://github.com/ictechgy/multi-subscription-terminal"
  url "https://registry.npmjs.org/multi-subscription-terminal/-/multi-subscription-terminal-0.1.0.tgz"
  sha256 "REPLACE_WITH_REAL_SHA256_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # 바이너리가 존재하고 실행 가능해야 한다.
    assert_predicate bin/"mat", :exist?
    assert_predicate bin/"mat", :executable?
  end
end
