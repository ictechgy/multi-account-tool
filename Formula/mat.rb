class Mat < Formula
  desc "Switch between AI CLI accounts (Claude Code, Codex, Gemini, ...) from one TUI"
  homepage "https://github.com/ictechgy/multi-account-tool"
  url "https://registry.npmjs.org/multi-account-tool/-/multi-account-tool-0.5.2.tgz"
  sha256 "7e921b11cbde163ac6f1ba13dd5fbf044abdbbef427ded105e2846ccfb1cd879"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_path_exists bin/"mat"
    assert_predicate bin/"mat", :executable?
  end
end
