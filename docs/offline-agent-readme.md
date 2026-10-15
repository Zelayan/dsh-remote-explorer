# 给内网 Agent：离线部署任务说明

> 本文是离线总包 `README_FOR_AI.md` 的版本化来源，适用于“Windows 已装 DSH，离线 Linux 尚无运行环境”的场景。制作总包时将本文复制到交付根目录并重命名，连同插件、Windows 辅助 CLI、Linux 运行包及校验清单一起分发；单独一份文档不能替代运行资源。以下具体版本和文件名对应本次验证过的交付，制作其他版本时必须同步更新并重新校验。

## 0. 任务与边界：先读完，再执行

你收到的是一个可独立移交的离线部署交付包。请在用户授权的内网环境完成：

**已知用户的离线 Windows x64 已安装 DSH 客户端。本次优先安装本机 DSH 的 Remote Explorer 离线插件，使用随包独立 CLI 将运行包经内网 SSH 导入 Ubuntu 22.04 x86_64 服务器，再从本机 DSH 的远程会话面板以严格离线模式连接。**

插件、远端运行环境及独立 CLI 均已随包提供，不需要访问公网，不需要 clone 仓库、安装 npm/pnpm 或编译源码。不要重装、升级、降级或替换已有 Windows DSH。本包不包含 DSH 桌面安装器；须先核对现有宿主是否兼容插件 peers。CLI 用于运行包导入、诊断及经用户同意的备用连接，不默认代替插件部署。

这是一份操作指引，不是允许执行任意高风险操作的授权。遵循用户、宿主 Agent 和组织安全策略；禁止执行以下行为：

- 不访问公网，不调用 npx、npm install、pnpm install、apt、curl/wget 下载，不关闭防火墙或修改系统安全策略来“解决”问题。
- 不把任何准备机当作目标。本交付包没有预填目标服务器地址，必须向用户确认最终离线目标。
- 不读取、展示或复制 SSH 私钥正文、API Key、DSH 凭据文件或会话令牌，不索取聊天中的明文密码。
- 不在命令参数、任务说明、日志或交付报告中写入密码、API Key；SSH 私钥只能按用户提供的文件路径引用。
- 不覆盖已有安装、不删用户目录、不递归清理 ~/.dsh、~/.dsh-remote-explorer 或项目目录；不修改系统 Node、PATH、sshd 或 systemd。
- 不为套用本包而降级系统库，不把 Linux x64 运行时用于 ARM64，不使用 Windows node.exe 执行 Linux 二进制。
- 不静默启动或持久化未知服务。若需要开机启动，单独征求用户授权，先完成前台/受管后台验收。

## 1. 本包内容与固定版本

```text
dsh-offline-agent-kit/
  README.md
  README_FOR_AI.md       # 本指引
  SHA256SUMS.txt         # 校验 packages/ 内全部四个交付文件及说明文件
  packages/
    dsh-remote-explorer-0.8.4-win32-x64.zip
    dsh-remote-explorer-0.8.4-offline-plugin.zip
    dsh-runtime-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3.zip
    dsh-runtime-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3.zip.sha256
```

运行时固定版本：

| 项目 | 值 |
|---|---|
| 本机 DSH | 用户已安装；必须核对实际版本、DSH_HOME 及活动 profile，不修改宿主 App |
| 离线插件 | Remote Explorer 0.8.4；非宿主依赖已内联，peers 由现有 DSH 提供 |
| 辅助 CLI | Windows x64；包内自带 node.exe，可运行插件安装器和远端导入命令 |
| 远端系统 | Ubuntu 22.04，x86_64/amd64/x64 |
| 远端 glibc | 2.35；已知目标与准备机均为此版本 |
| Node | v24.21.0 |
| DSH | 0.2.1-alpha.3 |
| pnpm | 11.7.0 |

注意：客户端版本 0.8.4 与远端 DSH 版本不是一回事。后续连接必须填写 DSH **0.2.1-alpha.3**，不能照其他文档里的旧示例填写 0.2.0-rc.2，也不能用 latest/next。

验证记录：摘要、归档白名单与链接安全检查通过；在同平台联网准备机的独立临时 HOME 中真实导入、Node/DSH/pnpm 验证及严格离线新 profile 初始化通过；插件专用安装器的禁网、禁子进程测试通过。用户随后确认离线 Windows 的插件安装成功，并已能新建远程会话。未单独记录远程窗口完整操作、终端、文件读写及内网模型对话结果，不能把准备机测试或“能新建会话”等同于所有功能验收通过。当前 Windows DSH 的精确版本未收集，不将这次反馈扩大为所有 0.2.x 宿主都兼容。

归档不包含 SSH 私钥、DSH 登录凭据、会话历史、准备机 profiles 或项目目录。SHA-256 只检验一致性，不证明来源身份；必须使用用户认可的可信介质获得本交付包。

## 2. 最少询问信息

开始前集中向用户确认以下信息，已有可靠上下文可复用，不要臆造：

1. 你在哪台机器执行：是否为目标 Windows x64 客户端？是否能访问本包文件并执行 PowerShell？
2. **最终离线 Linux** 的 IP/内网主机名、SSH 端口和用户名。必须独立确认实际端口，不复用联网准备机的地址或端口。
3. SSH 认证：本机已配置的 IdentityFile 或用户明确提供的私钥文件路径；若只能密码认证，需要用户在交互终端输入，不能通过聊天或 --password 传递。当前工具的直连使用场景应提供 IdentityFile/--private-key，不要假设仅有 SSH agent 就一定可用。
4. 远端工作目录，必须是已存在、有权限访问的 POSIX 绝对路径，例如 root 账号的 /root 或用户自己的项目目录。不得擅自选定敏感目录或创建项目。
5. 是否确认目标没有本工具的既有运行时，并允许在当前 SSH 用户家目录的 .dsh-remote-explorer/btsd321 下新建运行环境？安装不需要修改系统级 Node；不要无必要改用 root。
6. 本机 DSH 的实际版本、启动方式、DSH_HOME、活动 profile 和是否已装 Remote Explorer。用户已说明安装了 DSH，不再重复安装；桌面通常为 desktop profile，但必须以实际 profileContext/启动配置为准。确认是否允许完全退出 DSH 安装插件。若本 Agent 本身运行在该 DSH 里，先安排外部执行器或用户接手，不能直接杀掉自身宿主。
7. 若需要模型对话：用户认可的内网模型服务地址、接口类型、模型名及认证配置方式。Key 由用户通过安全输入/既有凭据配置，不在聊天中收集。不知道模型信息也可以先完成环境导入与界面验证，报告“模型配置待用户提供”，不得虚报全部完成。

若 Agent 实际运行在 Linux 上、只拿到本包但无法操作 Windows：**停止执行 Windows 命令**。本包只提供 Windows 客户端，不能直接使用 node.exe；请用户在 Windows Agent 中执行，或另行提供 Linux 客户端包。不要为了规避限制联网安装 Node/tsx。

## 3. 校验：失败立即停止

将外层总包解压到一个普通本地目录，建议路径短一些，例如 D:\dsh-offline-agent-kit。以下 PowerShell 命令均在本交付目录根执行。

先检查根目录中 SHA256SUMS.txt、README_FOR_AI.md、packages 是否存在，不扫描整个磁盘。使用下面的校验逻辑，不执行从外部获取的脚本：

```powershell
$ErrorActionPreference = 'Stop'
$Kit = (Get-Location).Path
$Lines = Get-Content -LiteralPath (Join-Path $Kit 'SHA256SUMS.txt')
foreach ($Line in $Lines) {
  if ([string]::IsNullOrWhiteSpace($Line)) { continue }
  if ($Line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw '无效的校验清单行' }
  $Expected = $Matches[1].ToLowerInvariant()
  $Relative = $Matches[2]
  if ($Relative.Contains('..') -or [System.IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) { throw '清单路径不安全' }
  $File = Join-Path $Kit $Relative
  $Actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw ('SHA-256 不匹配：' + $Relative) }
}
'交付文件校验通过'
```

Linux 只用于做移交前校验时，可在本交付目录执行 `sha256sum -c SHA256SUMS.txt`；这不代表 Windows 客户端能在 Linux 上运行。

禁止忽略校验失败、重新生成清单来绕过错误、修改 manifest 或解压后二进制。

## 4. 解压三个内部 ZIP

所有临时工作均放在本交付目录的 work 子目录。仅新建，不强行覆盖既有 work/client、work/runtime、work/plugin：

```powershell
$Work = Join-Path $Kit 'work'
$ClientDir = Join-Path $Work 'client'
$RuntimeDir = Join-Path $Work 'runtime'
$PluginDir = Join-Path $Work 'plugin'
if ((Test-Path -LiteralPath $ClientDir) -or (Test-Path -LiteralPath $RuntimeDir) -or (Test-Path -LiteralPath $PluginDir)) {
  throw '已有解压工作目录；请先核查既有内容，不能强行覆盖或删除'
}
New-Item -ItemType Directory -Path $Work -Force | Out-Null
Expand-Archive -LiteralPath (Join-Path $Kit 'packages/dsh-remote-explorer-0.8.4-win32-x64.zip') -DestinationPath $ClientDir
Expand-Archive -LiteralPath (Join-Path $Kit 'packages/dsh-runtime-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3.zip') -DestinationPath $RuntimeDir
Expand-Archive -LiteralPath (Join-Path $Kit 'packages/dsh-remote-explorer-0.8.4-offline-plugin.zip') -DestinationPath $PluginDir

$PluginBundle = Join-Path $PluginDir 'dsh-remote-explorer-offline-candidate'
$Node = Join-Path $ClientDir 'dsh-remote-explorer/node.exe'
if (!(Test-Path -LiteralPath (Join-Path $PluginBundle 'install.cjs'))) { throw '插件安装器不存在' }
if (!(Test-Path -LiteralPath (Join-Path $PluginBundle 'package/package.json'))) { throw '插件包元数据不存在' }
$Client = Join-Path $ClientDir 'dsh-remote-explorer/dsh-remote-explorer.cmd'
$Bundle = Join-Path $RuntimeDir 'offline-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3'
if (!(Test-Path -LiteralPath $Client)) { throw '启动脚本不存在，检查解压目录' }
if (!(Test-Path -LiteralPath (Join-Path $Bundle 'manifest.json'))) { throw '运行包清单不存在' }
if (!(Test-Path -LiteralPath (Join-Path $Bundle 'runtime.tar.gz'))) { throw '运行时归档不存在' }

& $Client --version
if ($LASTEXITCODE -ne 0) { throw '客户端版本检查失败' }
& $Client --help
if ($LASTEXITCODE -ne 0) { throw '客户端帮助检查失败' }
```

不要继续解压 runtime.tar.gz。它由导入器做安全验证与远端解包。

再次读取运行包 manifest.json，仅应得到 format/os/arch/nodeVersion/dshVersion/sha256 等非秘密信息；验证 linux、x64、v24.21.0、0.2.1-alpha.3 与本指引一致。

## 4.1 本机 DSH 离线插件安装（本次优先路径）

### A. 确认兼容性与活动 profile

用户已经装有 Windows DSH，不要重装本体。通过实际 App 的关于/版本信息、受信任启动配置和活动 profile 信息确定版本与路径，不猜测安装盘符。

仅选择性读取 `$PluginBundle/package/package.json` 的 name/version/peerDependencies/dsh 字段，与当前宿主实际依赖对照。插件针对 0.2 系宿主；具体以包内 peers 和宿主加载器为准，不因为“装了 DSH”就认定兼容。版本不匹配时停止，不能联网升级或强制绕过 peers。

确认真实 DSH_HOME 和实际 desktop/profile 路径，目录下必须有已初始化的 package.json，其 dsh.profile.bundles 应是字符串数组。常见路径是 `$env:USERPROFILE\.dsh\profiles\desktop`，但这只是候选，不得在未核实情况下直接写入。不要把 web profile 覆盖到 desktop，也不要改 App 安装目录。

检查该 profile 是否已经登记 dsh-remote-explorer：若有，核对版本和来源，停止覆盖安装。当前安装器只支持首次安装，不提供升级、卸载或 pnpm store 修复。用户确需升级时单独制定方案，不能通过删包绕过保护。

### B. 必须完全退出目标 DSH

先保存用户工作并征得退出同意，再使用 App 正常退出方式关闭所有相关后台进程。不要使用全局 taskkill/node 进程名批量杀进程。

**如果本 Agent 就运行在待安装插件的 DSH 内，退出会终止本 Agent：** 先把任务状态、交付包路径及待执行命令交接给外部终端/另一个已授权执行器，或请求用户代为退出并执行安装。不能在宿主仍活着时用 --host-stopped 假装满足条件，也不能擅自杀掉自身。

### C. 运行专用安装器

在确认目标宿主停止后，用客户端随包 Node 执行，无需系统 Node 或包管理器：

```powershell
# 使用用户确认的真实活动 profile；占位符不可直接执行。
$Profile = 'C:\用户确认的DSH_HOME\profiles\desktop'
$Installer = Join-Path $PluginBundle 'install.cjs'
if (!(Test-Path -LiteralPath (Join-Path $Profile 'package.json'))) { throw '目标 profile 未初始化或路径错误' }
& $Node $Installer --bundle $PluginBundle --profile $Profile --host-stopped
if ($LASTEXITCODE -ne 0) { throw '插件离线安装失败，停止，不强制覆盖' }
```

安装器校验文件摘要，合并 profile 的依赖及 bundle 登记，备份原 package.json，并保留用户 patch、其他插件与凭据。它不修改宿主 App，也不更新 pnpm lockfile；保留新增的 offline-packages 稳定本地源，不要在后续清理时删除。

**不要用本机 DSH 的普通插件安装入口、dsh plugin add、npm/pnpm 或 npx 安装这个离线专用 ZIP。** 本次必须运行 install.cjs，以免包管理器预检访问公网。

### D. 开启严格离线，再重启宿主

优先将本插件的宿主配置 `offline` 设为 `true`，保留现有字段，不覆盖整个用户配置。若还无法在 UI 设置，可在启动现有 App 的 PowerShell 环境里临时设置 `$env:DSH_REMOTE_OFFLINE = '1'`，然后从同一环境启动用户确认的既有 DSH 程序；保留原启动参数/DSH_HOME。不要通过 Explorer 启动后假设其继承终端环境，也不要未经同意持久修改系统环境变量。

宿主首次重新启动后，检查插件加载日志及“远程会话”入口；确认无缺失 peers、模块加载错误和公网版本查询。再通过实际插件配置界面将 `offline: true` 持久保存在该插件配置中。若只能编辑文件，先核实本版本实际 patch 结构、备份待改文件，只合并本插件的 offline 字段；禁止 dump 整份可能含秘密的配置到聊天，也不要凭空造 YAML 字段。

本次用户已确认真实离线 Windows 的插件安装和新建远程会话可用；这不替代其他机器、其他宿主版本的加载验证。若在新环境加载失败，保留日志的脱敏错误并停止，不以“CLI 能用”替代“插件安装成功”。经用户同意可临时使用下述 CLI 备用连接。

## 5. 目标检查：不修改系统

在用户认可的 SSH 会话中只读检查：

```sh
uname -m
cat /etc/os-release
ldd --version 2>&1 | head -n 2
for c in tar gzip flock sha256sum shasum; do
  command -v "$c" || echo "缺少：$c"
done
```

要求 x86_64、Ubuntu 22.04、glibc 2.35；需要 tar、gzip、flock，以及 sha256sum/shasum 二者至少之一。工具缺失、平台不匹配、空间不足时停止，不在线安装或替换系统库。

若没有现成 SSH 检查能力，不为检查而安装新客户端；使用用户已有 SSH 终端，或让用户执行并提供无秘密输出。导入器也会验证平台与运行时，不能因此省略用户对目标地址和安装的确认。

不得为了“检查认证”而读取私钥正文或凭据文件。允许传输库按用户指定的密钥路径完成认证，但不能把内容传入模型上下文。

## 6. 导入：必须确认最终目标地址

把下面占位符改成用户已确认的值后执行。保留 $Client、$Bundle 的实际绝对路径变量；跨执行器时 PowerShell 变量可能不持久，必要时重新设置。

```powershell
$Target = 'youruser@目标离线服务器IP:实际SSH端口'
$KeyPath = 'C:\用户确认的SSH私钥路径'
$RemoteCwd = '/home/youruser/用户确认的既有项目目录'

& $Client offline-import $Target --private-key $KeyPath --bundle $Bundle
if ($LASTEXITCODE -ne 0) { throw '运行包导入失败，停止；先分析原始错误，不覆盖重试' }
```

占位符不能直接执行。若已通过 SSH config 的 Host 别名配置认证，可用该别名并省略 --private-key。若密码认证，省略私钥参数，由用户在真实交互终端运行并输入；Agent 无交互能力时停在此处请求用户执行，禁止改用 --password。

导入会：校验压缩包及清单、校验远端平台、上传后比对摘要、在唯一暂存路径中运行 Node/DSH/pnpm 验证，再经安装锁发布。

**已有安装会拒绝覆盖。** 此错误不能靠删除目录或修改清单绕过。如果之前已经成功导入，请核对是否为同一个目标账号及同一版本，再跳过重复导入进入连接；若安装不完整或版本不符，向用户报告并单独制定恢复计划。

## 7. 从 DSH 远程会话面板连接（优先）及 CLI 备用

本次用户希望在已有 Windows DSH 中使用插件。远端运行包导入成功后，在已加载插件的本机 DSH 中：

1. 打开“远程会话”面板，使用用户确认的 SSH Host 别名或 user@host:port、认证与远端工作目录。
2. 确认本插件配置 `offline: true` 或宿主确实继承 DSH_REMOTE_OFFLINE=1；Node 填 `v24.21.0`，DSH 填 `0.2.1-alpha.3`，不开启镜像重测。
3. 发起一次连接，观察面板中的严格离线日志和就绪状态，打开对应远程窗口。
4. 优先通过当前受信任的 DSH UI/既有工具操作，不臆造 HTTP 管理接口、不绕过鉴权、不泄露管理令牌。
5. 面板连接由本机 DSH 进程维持，本机 DSH 必须保持运行。不要再同时为同一主机/目录启动 CLI connect，以免两个管理端竞争同一远端会话。
6. 退出本机 DSH 或断开会话可能停止对应远端服务；需要中断或强制重启前先告知用户。

**只有插件加载不兼容、界面操作不可用且用户同意备用路线时，才使用下面的独立 CLI 连接。CLI 成功不等于插件验收成功，报告中必须区分。**

```powershell
& $Client connect $Target --private-key $KeyPath --offline --node-version v24.21.0 --dsh-version 0.2.1-alpha.3 --cwd $RemoteCwd
```

使用 SSH config 或密码认证时按上一节调整，不携带未经确认的私钥路径。

- 必须带 --offline，不开启 --refresh-mirrors，不请求 latest/next。
- 此命令是常驻客户端，会建立 SSH 隧道并打开本机浏览器。不要把它放在会被短超时自动杀掉的单次工具调用里。
- 使用 Agent 的受管后台任务能力，并保留任务 ID；若没有可靠后台能力，请用户在独立终端运行并保持窗口打开。
- 不要因命令常驻就判断“卡住”或重复发起同一连接；先观察就绪与错误日志。
- CLI 持有隧道和模型凭据代理，CLI 退出会断开连接。默认 Ctrl-C 还会停止对应远端 DSH，不能在验收后无提示退出；--keep-remote 只保留远端进程，不会让本地隧道在 CLI 退出后继续存在。
- URL 可能带会话访问令牌。不要在最终报告中展示 token、将其发到外部或发布带 token 的截图；只在用户本机按需打开。
- 首次导入不是自启动安装，不承诺重启系统后自动恢复。

## 8. 内网模型配置：单独验收

本包提供运行环境，不附带模型、API Key 或用户登录状态。默认云端模型在断网环境不一定可用。

1. 确认用户认可的内网接口地址、协议（例如 OpenAI-compatible）和精确模型名。
2. 优先使用当前 DSH 网页提供的设置入口配置，不臆造 settings.yaml/patch 的字段。若必须写配置，先核实本版本的实际配置结构并备份待修改文件，只做最小合并；不打印现有秘密。
3. 如果配置本机供应商再经代理传给远端，内网接口应从 Windows 本机可达；不能擅自假设只有远端可达也能用。
4. 若需要重新连接来生效环境或供应商路由，先告知并确认中断，避免重复会话；强制重启只限本次目标会话。
5. 不把 API Key 放进命令行。让用户通过既有安全凭据入口输入，Agent 只验证认证是否成功。
6. 缺少内网模型信息时明确报告“环境已部署，模型配置待补充”，不要宣称模型对话成功。

## 9. 验收与交接报告

逐项记录真实结果：

- [ ] 四个交付文件（含插件 ZIP）及说明校验通过。
- [ ] Windows 辅助 CLI 可输出版本和帮助，无需联网安装依赖。
- [ ] 已确认现有 Windows DSH 的兼容版本、DSH_HOME 与实际活动 profile，没有重装或替换宿主。
- [ ] 完全退出目标 DSH 后用 install.cjs 首次安装插件；或核验已有同版本而安全复用，未覆盖未知安装。
- [ ] 重启后插件加载成功，存在“远程会话”入口，offline: true 生效；没有修改凭据或破坏其他插件。
- [ ] 目标地址、SSH 端口、用户名和工作目录经用户确认。
- [ ] 目标为 Ubuntu 22.04 x86_64 / glibc 2.35，必要工具齐全。
- [ ] 运行包导入成功；或确认同一目标用户已安装同版本而安全复用。
- [ ] DSH 远程会话面板严格离线连接成功、远程窗口可打开，宿主保持运行；若仅 CLI connect --offline 成功，明确插件部分尚未完成。
- [ ] 终端可执行无副作用命令；文件功能先只读访问用户指定文件，不随意创建/修改项目文件。
- [ ] 用户提供内网模型时，完成一次流式对话和经用户允许的无副作用工具调用；否则明确标记待配置。
- [ ] 没有公网下载、密钥泄露、覆盖既有安装、修改系统 Node 或持久化未知服务。

最终报告只包含非秘密信息：部署目录、目标主机及账号、版本、连接进程/受管任务 ID、验证结果、保持运行及停止方法、未完成项与具体原因。不包含私钥正文、密码、模型 Key、凭据文件内容或带令牌 URL。

若失败，保留用户资料与已有安装；提供脱敏错误和下一步需要的信息。不要靠重复安装、删库或联网下载来掩盖根因。
