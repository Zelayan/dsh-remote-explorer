# 内网 Agent 离线部署指引模板

交付方应将本文复制为总包根目录的 `README_FOR_AI.md`，同时提供资源说明、平台 CLI、远端运行包、必要的插件包和校验清单。本文不是二进制资源，也不预设用户已有 DSH、目标地址或软件版本。

以下以 Windows x64 本机连接 Linux x64 为操作示例；执行前必须核实实际平台。资源名称由交付 README 指定，版本从清单读取，不能照抄另一份交付的文件名和版本。

## 1. 安全边界

遵守用户授权、组织策略与宿主 Agent 的审批要求，不把本指引视为任意操作授权：

- 不访问公网，不运行 npx、npm/pnpm install、apt 或下载脚本补齐缺失资源；不关闭防火墙或绕过鉴权。
- 不把联网准备机当成最终目标，不预设 SSH 端口、用户名或项目目录。
- 不读取私钥正文或凭据文件到模型上下文，不在聊天、命令参数或日志中收集/展示密码、API Key、会话令牌。
- 允许传输工具按用户确认的私钥路径完成认证。密码只能由用户在真实交互终端安全输入；Agent 无交互能力时请求用户接手，不能改用明文 --password。
- 不覆盖既有插件或运行时，不递归删除用户目录、项目或 DSH 安装树；不擅自重装 DSH、修改系统 Node、sshd 或系统服务。
- 不为运行包降级系统库，不使用错误架构的二进制，不把 node.exe 当成 Linux Node。
- 不静默持久化服务或修改系统环境；安装新插件、退出宿主及中断会话前先确认用户工作。
- 最终校验失败时停止，不能改摘要或关闭检查绕过。SHA-256 仅保证一致性，不证明资源来源身份。

## 2. 收集信息并选择路线

只询问缺失的信息，不臆造、不在整个磁盘扫描用户数据：

1. Agent 的执行机器、系统、架构和可访问的交付目录。
2. 用户是否已有本机 DSH，以及是否希望从 DSH 面板管理远程会话。
3. 已有 DSH 的实际版本、启动方式、DSH_HOME、活动 profile；检查插件包 peers 是否满足。
4. 最终离线目标的地址、SSH 端口、用户及认证方式；不要复用准备机参数。直连使用时应核实 IdentityFile/--private-key，不假定只有 SSH agent 就满足当前工具的前置检查。
5. 已存在且允许访问的远端工作目录、安装授权和空间余量。
6. 内网模型接口类型、地址、模型名与安全认证入口；未知时可以先部署环境，模型标为待配置。

选择路线：

| 条件 | 操作 |
|---|---|
| 已有兼容 DSH，用户希望用面板 | 安装离线插件 → 用辅助 CLI 导入运行包 → DSH 面板连接 |
| 没有 DSH，或明确选择独立方式 | 平台 CLI 导入运行包并 connect --offline；不安装本机 DSH |
| 希望用面板，但宿主缺失或 peers 不兼容 | 报告缺件；不自动联网安装/升级。经用户同意可以使用 CLI 备用路线 |

如果只有 Linux 执行权限而交付的是 Windows 客户端，不能直接运行 node.exe。请求 Windows 执行器或用户接手；若交付方另备对应平台 CLI，另行按实际资源说明操作。

## 3. 资源检查与解压

交付 README 应列出每个包的角色、文件名及适用平台。完整插件路线需要：

- 平台 CLI 及随包 Node。
- 自包含插件分发目录，含 install.cjs、manifest.json、package/。
- 目标平台运行包，含 manifest.json、runtime.tar.gz。
- 原始运行包摘要，以及覆盖所有交付资源和说明的 SHA256SUMS.txt。

CLI 路线不要求插件包；也不要求本机 DSH。插件包不是远端运行包，摘要文件不是第四种运行环境。

在交付目录根执行 Windows 完整性检查：

```powershell
$ErrorActionPreference = 'Stop'
$Kit = (Get-Location).Path
foreach ($Line in (Get-Content -LiteralPath (Join-Path $Kit 'SHA256SUMS.txt'))) {
  if ([string]::IsNullOrWhiteSpace($Line)) { continue }
  if ($Line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw '无效的校验清单行' }
  $Expected = $Matches[1].ToLowerInvariant()
  $Relative = $Matches[2]
  if ($Relative.Contains('..') -or [System.IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) { throw '清单路径不安全' }
  $Actual = (Get-FileHash -LiteralPath (Join-Path $Kit $Relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw ('SHA-256 不匹配：' + $Relative) }
}
```

只将交付 README 指定的 ZIP 解压到新的工作目录，不使用强制覆盖。复用已有目录前核实内容，不因路径冲突删除旧树。不要继续解压运行包中的 runtime.tar.gz，由导入器验证和远端解包。

设置经核实的绝对路径变量：

- `$Client`：完整 CLI 的启动脚本，不是只复制的一份 .cmd。
- `$Node`：CLI 随包的 node.exe；插件安装可复用它，不需要系统 Node。
- `$Bundle`：直接含远端 manifest.json、runtime.tar.gz 的目录。
- `$PluginBundle`：选择插件路线时，直接含 install.cjs、manifest.json、package/ 的目录。

不猜测 ZIP 的顶层文件夹名；路径不明确时只在本次解压目录内检查，缺件则停止。先检查客户端退出码，再读取运行包清单：

```powershell
& $Client --version
if ($LASTEXITCODE -ne 0) { throw '客户端版本检查失败' }
& $Client --help
if ($LASTEXITCODE -ne 0) { throw '客户端帮助检查失败' }
$Manifest = Get-Content -LiteralPath (Join-Path $Bundle 'manifest.json') -Raw | ConvertFrom-Json
if ($Manifest.format -ne 1 -or $Manifest.os -ne 'linux' -or $Manifest.arch -ne 'x64') {
  throw '运行包格式或平台与当前 Windows→Linux x64 示例不匹配，请按实际目标核对'
}
$NodeVersion = [string]$Manifest.nodeVersion
$DshVersion = [string]$Manifest.dshVersion
```

连接采用清单的精确版本，不使用 latest/next，也不把 Remote Explorer 客户端版本当成 DSH 版本。校验结果不代替导入器自身的归档、摘要及运行时检查。

## 4. 插件路线：安装到已有 DSH

独立 CLI 路线跳过本节。

1. 对照插件 package/package.json 的 peerDependencies 核实宿主兼容性；只读取必要元数据，不将整份可能含秘密的用户配置输出到聊天。
2. 确认真实活动 profile 已初始化，package.json 中 dsh.profile.bundles 为字符串数组。desktop/web 仅是常见名字，不能按默认路径猜测或互相覆盖。
3. 已存在或登记该插件时停止首次安装，核对来源与版本。仅在确认同版本且可加载时安全复用，不删旧插件来绕过保护。
4. 保存工作、获得同意后正常退出 DSH 和相关后台进程，禁止其他安装器并发写 profile；不按 node 进程名全局批量终止。
5. **如果 Agent 自身就在待退出的 DSH 里，先交接外部执行器或由用户接手。** 宿主未退出时不能谎报 --host-stopped，也不能自行杀掉自己。

确认宿主停止、`$Profile` 为用户确认的活动 profile 绝对路径后执行：

```powershell
$Installer = Join-Path $PluginBundle 'install.cjs'
if (!(Test-Path -LiteralPath (Join-Path $Profile 'package.json'))) { throw 'profile 路径错误或未初始化' }
& $Node $Installer --bundle $PluginBundle --profile $Profile --host-stopped
if ($LASTEXITCODE -ne 0) { throw '插件安装失败，停止，不覆盖重试' }
```

必须使用 install.cjs，不使用普通在线插件管理入口、dsh plugin add 或包管理器；它们可能访问公网。安装器备份并合并 profile manifest，保留用户 patch、其他插件及凭据，不修改宿主 App 或 pnpm lockfile。保留 offline-packages 本地源；本安装器不提供通用离线升级/卸载。

启用本插件 `offline: true` 后重启宿主。若首次启动前无法配置，可由用户在已确认的实际启动环境设置 `$env:DSH_REMOTE_OFFLINE = '1'`，从同一环境启动既有 App；保留原启动参数，不替换 DSH_HOME，不未经同意持久化系统变量。既有进程和从 Explorer 启动的 App 不一定继承终端变量。

加载后检查远程会话面板和实际插件设置，确认严格离线生效。若需编辑配置，先核实本版本结构、备份并最小合并，不臆造 YAML 字段、不打印秘密。插件加载失败时报告脱敏错误，不能拿“CLI 能运行”代替插件验收成功。

## 5. 最终目标检查与导入

使用用户认可的 SSH 能力只读核对：

```sh
uname -m
cat /etc/os-release
ldd --version 2>&1 | head -n 2
for c in tar gzip flock sha256sum shasum; do
  command -v "$c" || echo "缺少：$c"
done
```

目标平台须与运行包匹配，系统库兼容，具备 tar/gzip/flock 及 sha256sum/shasum 至少之一。工具缺失、架构不符、空间不足时停止，不在线补装或替换系统库。

将 `$Target` 设置为用户已确认的 SSH 别名或 `youruser@host:port`，`$KeyPath` 为已确认的私钥路径：

```powershell
& $Client offline-import $Target --private-key $KeyPath --bundle $Bundle
if ($LASTEXITCODE -ne 0) { throw '导入失败，停止并检查原始原因' }
```

SSH config 已配 IdentityFile 时可省略私钥参数；密码认证由用户交互输入。Agent 不具交互能力则请求接手，不用 --password。

已有安装会拒绝覆盖。若此前确已成功导入，核对同一目标用户、版本与状态再跳过重复导入；版本不符或残留不完整时报告并另定恢复方案，不强行清理。

## 6. 连接与生命周期

### 插件路线

从本机 DSH 的远程会话面板连接，使用已确认的目标、认证及工作目录，Node/DSH 填清单版本。插件配置 offline 为 true，不开启镜像重测，不用 latest/next。

通过受信任 UI 或已有工具操作，不臆造管理接口或绕过鉴权。本机 DSH 须保持运行，不再同时启动 CLI connect 管理同一会话；中断、退出或强制重启前确认用户工作。

### 独立 CLI 路线

`$RemoteCwd` 为用户确认的既有远端 POSIX 绝对路径：

```powershell
& $Client connect $Target --private-key $KeyPath --offline --node-version $NodeVersion --dsh-version $DshVersion --cwd $RemoteCwd
```

按认证方式省略私钥参数。使用受管后台任务或让用户在独立终端保持运行，记录任务 ID；不要放进会被短超时杀掉的单次调用，不因常驻而重复连接。

CLI 持有隧道与凭据代理，退出会断开；默认 Ctrl-C 还会停止对应远端 DSH。--keep-remote 仅保留远端进程，不保留本机隧道。本部署不是开机自启动安装。URL 可能含会话令牌，不公开带令牌链接或截图。

## 7. 内网模型配置

运行包不带模型、API Key 或用户登录状态。不要默认公网云模型在内网可用。

- 核实用户认可的内网接口地址、协议、模型名和安全认证入口。
- 优先使用本版本实际设置界面，用户通过安全入口输入 Key；不得把 Key 放在聊天或命令中。
- 本机供应商经凭据代理供远端使用时，模型接口须从本机可达；不能假定仅远端可达也满足条件。
- 若必须写配置，先核实结构、备份并最小合并；若重连才能生效，先确认中断。
- 没有模型信息时报告“环境已部署，模型配置待补充”，不宣称对话成功。

## 8. 验收与报告

逐项记录实际结果：

- [ ] 所有交付资源与说明校验通过，CLI 版本/帮助可运行。
- [ ] 最终目标、SSH 端口、账号、认证与工作目录经用户确认。
- [ ] 目标平台、系统库、工具和空间满足要求。
- [ ] 插件路线下，兼容的实际 profile 完成首次安装或安全复用；重启后面板可用、offline 生效。
- [ ] 远端运行包导入成功或确认同版本可安全复用。
- [ ] 所选路线严格离线连接成功，远程窗口可打开，必要宿主或后台任务保持运行。
- [ ] 终端执行无副作用命令、只读访问用户指定文件；不擅自改项目。
- [ ] 内网模型完成流式对话及经允许的无副作用工具调用，或明确标记待补充。
- [ ] 没有公网下载、覆盖安装、泄露秘密或擅自修改系统服务。

报告只包含非秘密信息：部署位置、平台版本、目标、实际 profile、受管任务 ID、验证结果、保持运行/停止方法和未完成原因。不包含密码、私钥正文、模型 Key 或带访问令牌 URL。

仅创建了会话不代表终端、文件与模型全部通过；仅 CLI 成功不代表插件成功。失败时保留用户资料与已装环境，提供脱敏错误和下一步需要的信息，不用重复安装、删除目录或联网下载掩盖根因。
