# cove 构建与发行

本仓库通过 GitHub Actions 构建 cove 正式安装包，并自动发布到本仓库的 **Releases**。各平台使用同一个源码提交和发行版本。

## 凭据

读取源码使用已配置的 Repository Secret **`PRIVATE_TOKEN`**，需要具有源码仓库的 **Contents: Read-only** 权限。发布本仓库 Release 使用工作流的 `GITHUB_TOKEN`。

源码仓库地址在运行时从当前仓库名去掉 `-release` 后缀得到，不写入文档、工作流或发行元数据，并在任务日志中屏蔽。如果以后改变仓库命名关系，可以用可选 Secret `COVE_SOURCE_REPOSITORY` 指定源码仓库的 `owner/repository`；当前命名无需添加该 Secret。

## 自动版本号

版本格式为 **`主版本.次版本.构建号`**。例如选择 `v0.1`，第 42 次工作流运行会生成：

- Release 标签：`v0.1.42`
- 应用内版本：`0.1.42`
- 安装包版本：`0.1.42`，按系统与架构区分。

构建号使用 `GITHUB_RUN_NUMBER`，每次新运行自动递增，无需修改源码版本。重跑同一次运行保留原构建号，允许续传未公开的 Release 草稿；已公开版本禁止覆盖。PR 和失败运行也会占用运行编号，因此已发布版本的构建号可能不连续。参见 [GitHub 运行编号说明](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)。

生成的版本同时写入打包元数据和原生构建版本，源码 `package.json` 与 lockfile 保持原样。

## 运行构建

打开本仓库 **Actions → Build cove → Run workflow**，设置：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `source_ref` | `main` | 源码分支、标签或完整提交 SHA |
| `base_version` | 留空 | 版本前缀，例如 `v0.1` 或 `0.1`；留空取源码版本的主、次版本 |
| `platform` | `all` | `all`、`windows`、`macos`、`linux`；macOS 同时构建 Intel 与 Apple Silicon |

在本仓库目录登录 GitHub CLI 后，也可以运行：

```bash
gh workflow run build.yml -f source_ref=main -f base_version=v0.1 -f platform=all
gh run list --workflow build.yml
gh run watch <RUN_ID>
```

推送本仓库 `main` 时，自动使用源码 `main` 和源码主、次版本构建并发布。推送本仓库 `v主版本.次版本` 标签时，例如 `v0.1`，使用该版本前缀构建；源码仍从 `main` 获取，不要求源码存在同名标签。PR 只检查发行脚本。源码仓库的 push 不会直接触发本仓库构建。

工作流先固定源码 SHA，再执行 lint、类型检查、单元测试和 Electron 集成测试，随后构建所选平台的正式安装包。校验和打包均使用 Node.js 24，依赖通过源码 lockfile 执行 `npm ci` 安装。

## 下载发行包

成功构建后，在本仓库的 **Releases** 下载对应版本的安装包。所选目标全部成功并通过文件完整性检查后，Release 才会从草稿转为公开。

| 平台 | Runner | 架构 | 格式 |
| --- | --- | --- | --- |
| Windows | `windows-2025` | x64 | NSIS `.exe` |
| Linux | `ubuntu-24.04` | x64 | `.AppImage` |
| macOS Intel | `macos-15-intel` | x64 | `.dmg`、`.zip` |
| macOS Apple Silicon | `macos-15` | arm64 | `.dmg`、`.zip` |

安装包输出到 `release/`。Actions Artifact 仅用于构建任务向发行任务传输文件，保留 1 天。发行包包含 SHA-256 校验清单与构建信息，不包含源码仓库地址、源码或 builder 内部配置。

```bash
# Linux：在下载目录校验，再运行 AppImage
sha256sum -c SHA256SUMS-linux-x64.txt
chmod +x *.AppImage

# macOS Intel
shasum -a 256 -c SHA256SUMS-macos-x64.txt
```

需要校验全部平台文件时，使用汇总 `SHA256SUMS.txt`。Windows 可以使用 `Get-FileHash` 计算下载文件的 SHA-256，与清单比较。

每次发行还会为已验证的 EXE、DMG 和 AppImage 创建不含版本号的下载副本，例如 `lifecove-win-x64.exe`、`lifecove-mac-arm64.dmg`、`lifecove-mac-x64.dmg` 和 `lifecove-linux-x86_64.AppImage`。这些副本与对应版本包的字节完全一致，校验值见 `SHA256SUMS-latest.txt`，也包含在汇总清单中。

固定入口使用 `/releases/latest/download/<文件名>`，可以配合 Xget 的 `/gh/` 前缀加速。只有 `platform=all` 的完整三平台正式发行会被标记为 GitHub Latest；单平台发行仍可通过版本页面下载，不替换完整发行的 Latest 入口。

现有版本缺少固定文件名时，可运行 **Actions → Backfill latest downloads** 为当前 Latest 补齐下载副本及校验清单。该流程检查原始安装包哈希，只添加缺失文件，不覆盖已发布的任何安装包；已有副本也会核对大小与 GitHub 的 SHA-256 摘要。

## 可选签名

| Secret | 用途 |
| --- | --- |
| `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` | Windows 代码签名证书及密码 |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | macOS Developer ID 证书及密码 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证凭据 |

未配置证书时，Windows 包未签名，macOS 使用 ad-hoc 签名且未公证。打包沿用源码中的正式应用身份与数据存储规则。本工作流不配置客户端自动更新源。

## 本地校验

发行脚本仅依赖 Node.js 内置模块：

```bash
node --test
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/build.yml
```
