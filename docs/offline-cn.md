# 离线部署

离线部署将资源准备与连接分开：在联网环境准备客户端、插件和远端运行包，再通过内网 SSH 导入、连接。本机与远端无需访问公共 Node/npm 站点，但仍需可达的模型服务及 SSH 认证。

## 1. 选择部署方式

| 本机环境 | 部署方式 | 所需资源 |
|---|---|---|
| 已有兼容 DSH，希望使用远程会话面板 | 安装离线插件，用辅助 CLI 导入远端运行包，再从面板连接 | 插件包、对应平台 CLI、远端运行包、校验文件 |
| 不使用本机 DSH | 独立 CLI 导入运行包并连接 | 对应平台 CLI、远端运行包、校验文件 |

插件包不包含 DSH 桌面本体，CLI 也不是 DSH 桌面安装器。远端运行包只用于匹配的平台，不能用 macOS 或 ARM64 运行时替代 Linux x64。

本指南以联网 Mac 制作资源、离线 Windows 连接 Linux 为例。插件安装器也支持已有兼容 DSH 的 Linux/macOS 本机；CLI 支持的平台以打包脚本为准。

## 2. 支持范围与限制

- `connect/provision --offline`：不做镜像测速、在线版本查询、下载或 npm 安装；缺少指定版本的 Node、DSH 或兼容 pnpm 时直接失败。
- 插件配置 `offline: true` 或环境变量 `DSH_REMOTE_OFFLINE=1`：同时控制连接引导和版本下拉探测；环境变量须由实际宿主进程继承。
- `offline-export`：导出本工具管理目录中选定的 Node、全局 pnpm、DSH 安装及依赖。
- `offline-import`：本地归档检查、上传后摘要校验、平台检查、暂存运行验证通过后再发布；只支持全新安装，拒绝覆盖已有路径。
- 远端包支持 Linux/macOS 的 x64/arm64。压缩包上限 1 GiB，展开上限 8 GiB、200000 个成员；导出会整包读入内存，需预留余量。
- 插件安装器只支持首次安装，不提供离线升级/卸载或通用 pnpm 缓存；远端也不支持覆盖升级、面板上传包。
- 严格离线是本工具的引导策略，不是系统级网络沙箱。DSH、其他插件、模型服务和用户命令可能自行联网；限制公网出站须由系统或网络策略实现。

## 3. 联网环境准备资源

### 3.1 平台 CLI

在仓库根目录使用项目指定的 Node/pnpm：

```bash
pnpm install --frozen-lockfile
pnpm exec tsx scripts/package.ts --os win32 --arch x64
```

产物位于 `dist/`，文件名为 `dsh-remote-explorer-<版本>-win32-x64.zip`。将其完整解压后，在直接包含启动脚本的目录运行：

```powershell
.\dsh-remote-explorer.cmd --help
```

CLI 包自带 Node 与单文件 CJS，不需要目标 Windows 安装 Node/npm。不要只复制启动脚本。

### 3.2 本机 DSH 离线插件

```bash
pnpm run package:offline-plugin
```

默认产物为 `dist/dsh-remote-explorer-<版本>-offline-plugin/`，包含 `package/`、`manifest.json`、`install.cjs`。输出目录已存在时拒绝覆盖；也可用脚本的 `--output` 指定新的仓库 `dist/` 子目录。

插件的非宿主依赖已内联，DSH/Cordis peers 由宿主提供。安装前检查插件 `package/package.json` 的 peer 要求与实际宿主是否兼容，不能仅因装有 DSH 就认定满足条件。

此目录可直接复制，或在 Mac 上压成 ZIP。只压插件分发目录，不混入源码、缓存、凭据或用户 profile。使用系统 bsdtar 时设置 `COPYFILE_DISABLE=1`，避免 AppleDouble 元数据。

### 3.3 同平台远端运行包

准备一台与离线目标同系统、同 CPU 架构、系统库兼容的联网主机。Linux 发行版及 glibc 尽量匹配；Mac 只能连接兼容 Linux 准备机，不能直接把 Mac 的依赖导出为 Linux 包。

若准备机已有合适的本工具管理环境，先检查并复用，不为套用文档而升级、降级或覆盖。否则，设置所需的**精确版本**后在线引导：

```bash
# NODE_VERSION、DSH_VERSION 须提前设置成选定版本，不使用 latest/next。
pnpm exec tsx src/cli/bin.ts provision myhost \
  --node-version "${NODE_VERSION:?请先设置精确 Node 版本}" \
  --dsh-version "${DSH_VERSION:?请先设置精确 DSH 版本}"
```

停止准备机上的相关会话和安装操作，再导出到尚不存在的本地目录：

```bash
pnpm exec tsx src/cli/bin.ts offline-export myhost \
  --output ./offline-runtime \
  --node-version "${NODE_VERSION:?请设置准备机实际安装的精确 Node 版本}"
```

输出：

```text
offline-runtime/
  manifest.json
  runtime.tar.gz
```

清单记录平台、精确版本和 SHA-256，后续连接以它为准。归档仅包含选定 `node/`、`node_modules/` 与根安装 `package.json`，不迁移凭据、会话、profiles、skills、项目或 npm 缓存。归档检查拒绝路径穿越、外部/绝对链接、链式链接、硬链接与特殊文件。

使用可信的专用准备环境，不把含私有代码的自定义安装当作公共发行资源。分发 Node 和依赖时遵守各自许可证。SHA-256 能检测损坏，不能证明发布者身份；运行包内含可执行代码，只能使用可信来源。

## 4. 离线 Windows 导入远端

目标须具备 `tar`、`gzip`、`flock`，以及 `sha256sum` 或 `shasum`。确认最终目标的 SSH 地址、端口、账号及 Windows 上的认证方式；准备机地址和端口不代表最终目标。

将运行包目录带入 Windows，不解压内层 `runtime.tar.gz`。在 CLI 目录执行：

```powershell
$Bundle = 'D:\offline-runtime'
$Manifest = Get-Content -LiteralPath (Join-Path $Bundle 'manifest.json') -Raw | ConvertFrom-Json
.\dsh-remote-explorer.cmd offline-import myhost --bundle $Bundle
if ($LASTEXITCODE -ne 0) { throw '导入失败，停止并检查原因' }
```

`myhost` 为该 Windows 用户的 SSH config 别名，也可替换为 `youruser@host:port`。直连需要时显式添加 `--private-key "用户确认的密钥路径"`；密码认证由用户在真实交互终端输入，不把密码写入包或命令。不能假定只有 SSH agent 就一定能满足当前工具的认证前置检查。

导入不迁移准备机的登录状态。暂存验证失败时不会发布；一般发布命令失败会在安装锁内回退本次移动项。断电、SIGKILL 或文件系统故障可能阻止回退，需管理员核查，不能用递归删除或强制覆盖绕过保护。

### 4.1 独立 CLI 连接

使用上一节读取的清单版本：

```powershell
.\dsh-remote-explorer.cmd connect myhost --offline --node-version $Manifest.nodeVersion --dsh-version $Manifest.dshVersion --cwd /home/youruser/project
```

工作目录须已存在且有权限。CLI 必须保持运行才能维持隧道与凭据代理；Ctrl-C 默认停止对应远端 DSH。`--keep-remote` 仅保留远端进程，不会让本地隧道在 CLI 退出后继续存在。

若选择本机 DSH 插件路线，完成导入后按第 5 节连接，不必再启动 CLI connect。

## 5. 本机 DSH 插件安装与连接

### 5.1 确认宿主并安全退出

1. 确认已有 DSH 满足插件 peers，实际使用的 profile 已初始化。
2. 确认真实 DSH_HOME 与活动 profile。桌面通常为 `desktop`，网页通常为 `web`；不得按默认路径猜测或用另一种模板覆盖。
3. 保存工作，征得退出同意，完全退出目标 DSH 及其后台进程，禁止其他安装器同时写 profile。
4. 若 Agent 就运行在该宿主中，先把安装交给外部执行器或用户，不直接终止自身，也不在宿主未退出时虚报 `--host-stopped`。

### 5.2 运行专用安装器

下面路径均为示例，应替换为真实解压目录与活动 profile。Node 可使用平台 CLI 随包的 `node.exe`：

```powershell
& "D:\remote-client\node.exe" "D:\offline-plugin\install.cjs" --bundle "D:\offline-plugin" --profile "$env:USERPROFILE\.dsh\profiles\desktop" --host-stopped
if ($LASTEXITCODE -ne 0) { throw '插件安装失败，不强行覆盖' }
```

Linux/macOS 本机示例：

```bash
node ./offline-plugin/install.cjs --bundle ./offline-plugin --profile "$HOME/.dsh/profiles/desktop" --host-stopped
```

安装器校验文件清单与摘要，备份并合并 profile manifest，添加插件及稳定的 `offline-packages` 本地源；保留其他插件、用户 patch、凭据和宿主 App。已登记或存在插件时拒绝覆盖。它不修改现有 pnpm lockfile，也不保证宿主 peers 必然兼容；重启后仍需验证加载。

**不要用普通在线插件安装入口、`dsh plugin add` 或 npm/pnpm 替代此安装器**，其预检/修复路径可能访问公网。保留本地源，后续包管理器操作可能重排 profile；这不是通用 pnpm 离线仓库。

### 5.3 严格离线连接

重启后在插件配置中启用 `offline: true`。也可在启动实际宿主前设置 `DSH_REMOTE_OFFLINE=1`；已经运行的桌面进程不会自动继承终端中新设的变量。

从远程会话面板连接时，使用已确认的目标、认证、既有工作目录及清单中的精确 Node/DSH 版本；DSH 也可留空以复用已装版本，不使用 latest/next，不开启镜像重测。不要同时启动 CLI connect 管理同一远端会话。

面板会话依赖本机 DSH 进程，宿主须保持运行。退出或强制重启前先确认用户工作；界面 URL 可能含会话令牌，不公开日志中的带令牌链接。

## 6. 委托内网 Agent

使用[Agent 部署指引模板](offline-agent-readme.md)。模板先判断是否已有兼容 DSH，再选择插件或 CLI，不包含目标地址、密钥或模型。

| 资源 | 要求 |
|---|---|
| 平台 CLI | 与本机系统/架构匹配，带完整 Node 与客户端文件 |
| 自包含插件包 | 选择 DSH 面板路线时必需，内含 install.cjs、manifest.json、package/ |
| 远端运行包 | 与目标系统/架构/系统库兼容，内含 manifest.json、runtime.tar.gz |
| 校验文件 | 运行包摘要，以及覆盖所有交付资源与说明的 SHA256SUMS.txt |

总包使用以下逻辑结构，实际文件名由交付方确定，不能靠固定版本或文件名猜测：

```text
offline-deployment/
  README.md
  README_FOR_AI.md
  SHA256SUMS.txt
  packages/
    <平台 CLI 压缩包>
    <离线插件压缩包，插件路线必需>
    <远端运行包压缩包>
    <对应校验文件>
```

制作时将本仓库 Agent 模板复制为 `README_FOR_AI.md`，在交付 README 中写明资源角色、包名和适用环境，必要时附清单路径。只组装已验证资源，不在交付目录中放凭据或用户工作树。

在新的交付目录中生成校验清单，Mac 可用 `shasum -a 256`；用 bsdtar 打 ZIP 时设置 `COPYFILE_DISABLE=1`。分发前直接检查最终 ZIP 的条目及各文件摘要，而不只校验源目录。替换资源或说明后重新生成内外层摘要，不覆盖已发布产物或复用旧清单。

交付包和 `dist/` 不纳入 Git；文档不代表已经上传 Release。Agent 仍须向用户确认目标、认证、profile、退出权限与模型信息，不能通过聊天索取明文秘密，也不能用联网安装补足缺件。

## 7. 验收与验证记录

部署后逐项验证，不把“安装成功”或“能新建会话”等同于全部功能通过：

1. 资源摘要、平台与版本正确，未携带准备机凭据或项目。
2. 插件路线下，真实 Windows DSH 能加载插件、开启离线模式并显示远程会话面板。
3. 全新目标导入成功；不存在的版本立即失败，不等待下载或自动回退在线安装。
4. 远程窗口、终端和用户指定文件的访问正常，不随意写入项目。
5. 内网模型完成一次流式对话和经允许的无副作用工具调用；信息不足时明确标记待配置。
6. 宿主/CLI 的生命周期、停止方法和必要的后台任务已交接。

自动检查：

```bash
pnpm run typecheck
pnpm exec tsx --test tests/unit/*.test.ts
pnpm exec tsx tests/offline-ssh-smoke.ts
pnpm run build:plugin
pnpm run check:plugin
# 参数为实际已构建的自包含插件目录。
pnpm exec tsx tests/offline-plugin-artifact.ts "${PLUGIN_BUNDLE:?请设置插件分发目录}"
```

回环 SSH 测试仅操作临时 HOME 和测试密钥；插件安装器测试使用临时 profile，并禁止网络与子进程。它们不等同于用户真实 Windows、目标 Linux 和模型链路的完整验收。已执行的测试组合、平台限制和实测反馈单独记录在[离线验证记录](offline-verification.md)。
