class Cctag < Formula
  desc "Slack ↔ local coding-agent TUI bridge (Claude Code / Codex CLI), via herdr"
  homepage "https://github.com/YosukeIida/claude-code-tag"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-darwin-arm64",
          using: :nounzip
      sha256 "bc0594ec3f7020895c31c569d2a18e0464403481e0aede1c4ffdc135528ab914"
    end
    on_intel do
      url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-darwin-x64",
          using: :nounzip
      sha256 "78f7edf965a213b9133d9d40526704077ce1060a17063ca539d269906a532f47"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-linux-arm64",
          using: :nounzip
      sha256 "b6a6bc4e7506d4d9930325dcf01f7a7408ca4258d277e4833d2f91c5847244c7"
    end
    on_intel do
      url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-linux-x64",
          using: :nounzip
      sha256 "fc6c69e70ce638cc60cb072c24f921cc903082d4dd59251a0ce997752b21b571"
    end
  end

  # cctag ships three binaries (standalone / hub / spoke) per platform. The
  # main url/sha256 above covers the standalone `cctag` entry; the other two
  # are fetched as extra resources, one per platform, and staged in `install`.
  resource "cctag-hub-darwin-arm64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-hub-darwin-arm64",
        using: :nounzip
    sha256 "92ee4b9ccdcc04fe84e2d9fbc18acde0b5dc91d6ce0c630ed167d66012891d3f"
  end
  resource "cctag-hub-darwin-x64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-hub-darwin-x64",
        using: :nounzip
    sha256 "e9083724bcdc2ea4d4fb8ea6f459a502f8522f7f87b9968462959d28c6b84ef8"
  end
  resource "cctag-hub-linux-arm64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-hub-linux-arm64",
        using: :nounzip
    sha256 "d3f3c89a5f2a4dd96505c0d639f8603105dca85171e9384e0ebe370f0e232e09"
  end
  resource "cctag-hub-linux-x64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-hub-linux-x64",
        using: :nounzip
    sha256 "769fb4336704bb5dcde569a19f9399f6d6f454ab8c639aca7a1e45813701afe7"
  end
  resource "cctag-spoke-darwin-arm64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-spoke-darwin-arm64",
        using: :nounzip
    sha256 "d91535b0f1e950f60d4bce3678b6893744860fc6a090e2b6dec37cbdd0afaf30"
  end
  resource "cctag-spoke-darwin-x64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-spoke-darwin-x64",
        using: :nounzip
    sha256 "963c9a016b97594872d4dcc63236670a31ef09a740c6b08a6cb5d59d56e6b423"
  end
  resource "cctag-spoke-linux-arm64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-spoke-linux-arm64",
        using: :nounzip
    sha256 "f0d642a43e7ceea7e16b89f26fb75cc48f926e7f159b3de7eee5fb3fcae97681"
  end
  resource "cctag-spoke-linux-x64" do
    url "https://github.com/YosukeIida/claude-code-tag/releases/download/v0.1.0/cctag-spoke-linux-x64",
        using: :nounzip
    sha256 "7fbaada6126728a382eee57f71f6206afeda8d21bb36ce4a5bf4f43bf48c237b"
  end

  def install
    platform =
      if OS.mac? && Hardware::CPU.arm?
        "darwin-arm64"
      elsif OS.mac?
        "darwin-x64"
      elsif Hardware::CPU.arm?
        "linux-arm64"
      else
        "linux-x64"
      end

    bin.install "cctag-#{platform}" => "cctag"
    resource("cctag-hub-#{platform}").stage { bin.install "cctag-hub-#{platform}" => "cctag-hub" }
    resource("cctag-spoke-#{platform}").stage { bin.install "cctag-spoke-#{platform}" => "cctag-spoke" }
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/cctag-spoke --version")
  end
end
