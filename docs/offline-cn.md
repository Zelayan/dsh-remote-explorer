# 离线部署（离线增强分支）

本功能将「准备资源」与「连接」分开。**离线不是不需要模型：仍需本机可访问且兼容 DSH 的内网模型服务。** 本机与远端必须能通过 SSH 互通。

## 0. 先按本机是否已有 DSH 选择路线

| 场景 | 推荐路线 | 必需资源 |
|---|---|---|
| 离线 Windows 已安装兼容 DSH | 安装本机离线插件 → 用辅助 CLI 导入远端运行包 → 从 DSH 远程会话面板连接 | 插件包、Windows CLI、Linux 运行包及校验文件 |
| 本机不使用 DSH | 用独立 CLI 导入远端运行包并连接 | Windows CLI、Linux 运行包及校验文件 |

**本机插件包不是远端 Linux 运行包，Windows CLI 也不是 DSH 桌面安装器。** 用户希望在已有 DSH 中使用远程会话面板时，总包必须带插件，不能只分发 CLI 和 Linux 运行包。

将整个交付包交给内网 Agent 时使用[AI 部署指引](offline-agent-readme.md)，操作前仍需确认目标地址、SSH 认证、活动 profile 和退出宿主的权限。完整资源清单与制作流程见第 7 节，已确认的验证结果见第 8 节。

## 1. 支持范围与限制

- `connect/provision --offline`：不进行镜像测速、在线版本解析、下载或 npm 安装。缺少 Node、DSH 或兼容 pnpm 时立即报错。
- `DSH_REMOTE_OFFLINE=1`：整个 Remote Explorer 进程的离线开关，对 CLI 和插件生效；插件版本下拉框不再访问公共版本源。
- `offline-export`：从已配置的同平台联网准备主机导出 **Node（含全局 pnpm）、DSH 安装及依赖**。
- `offline-import`：经 SSH 将离线包导入全新目标，先验证摘要、平台、归档安全和运行时，再发布；**拒绝覆盖已有安装**。
- 自包含插件包：在 Mac 上制作，复制到 Windows/Linux/macOS 后仅用 Node 安装到已有 DSH profile，不调用包管理器。
- 远端归档暂支持 Linux/macOS、x64/arm64。归档压缩大小最多 1 GiB，展开最多 8 GiB、200000 个成员。当前传输接口导出需要整包读入内存，应预留足够内存。
- 首版不提供插件离线升级/卸载、远端运行时覆盖升级或面板上传包。远端包导入导出使用 CLI；插件通过 `offline: true` 配置或全局环境变量开启离线模式。
- 严格离线是本插件的**引导与版本探测策略**，不是操作系统级网络沙箱。DSH 本体、其他插件、用户命令、模型调用仍可能访问网络。验收应另用防火墙禁止公网出站。

## 2. Mac 制作 Windows 独立客户端

在联网 Mac 上准备 Node 和项目指定 pnpm，然后在仓库根执行：

```bash
pnpm install --frozen-lockfile
pnpm exec tsx scripts/package.ts --os win32 --arch x64
```

将生成的 `dist/dsh-remote-explorer-<版本>-win32-x64.zip` 完整复制并解压到 Windows。终端进入目录后：

```powershell
.\dsh-remote-explorer.cmd --help
```

不要仅复制 `.cmd`，同目录 Node 和 CJS 文件都要保留。

## 3. 准备远端运行包

准备一台与离线远端 **同系统、同 CPU 架构、尽量同发行版/系统库版本** 的联网主机。Mac 不能通过安装 Mac 依赖来生成 Linux DSH 运行环境；应从 Mac 连接兼容的 Linux 准备机制作。

先在线引导（版本按实际需要指定）：

```bash
pnpm exec tsx src/cli/bin.ts provision myhost --node-version v24.21.0 --dsh-version 0.2.1-alpha.3
```

如果准备机已在本工具管理目录中装有合适版本，先只读检查并复用，不为套用示例而覆盖、降级或升级现有安装。本次实际导出的是 Node `v24.21.0`、DSH `0.2.1-alpha.3`、pnpm `11.7.0`；示例采用这一组合，其他包应以自己的 manifest.json 为准，不把客户端 0.8.4 当成 DSH 版本。

停止该准备机上所有 Remote Explorer 会话与安装操作，然后导出到一个**尚不存在**的本地目录：

```bash
pnpm exec tsx src/cli/bin.ts offline-export myhost --output ./offline-linux-x64 --node-version v24.21.0
```

输出目录：

```text
offline-linux-x64/
  manifest.json
  runtime.tar.gz
```

清单包含目标平台、精确版本和 SHA-256。归档仅包含运行时白名单：`node/`、`node_modules/`、根安装 `package.json`；不包含凭据、会话令牌、历史、profiles、skills、项目代码或 npm 缓存。外部/绝对符号链接、链式链接、硬链接和特殊文件会拒绝，不能把任意整个 home 目录当作运行包。

如准备机已有自定义依赖，应使用干净专用准备机；不要把含私有代码的安装目录当成可公开发行资源。Node 与依赖的许可证及通知仍需按各自要求随分发提供。

## 4. 离线 Windows 导入远端并连接

把运行包目录复制到离线 Windows，确保 SSH 密钥已配置，远端具备 tar、gzip、flock 及 sha256sum 或 shasum。解压客户端后运行：

```powershell
.\dsh-remote-explorer.cmd offline-import myhost --bundle "D:\offline-linux-x64"
.\dsh-remote-explorer.cmd connect myhost --offline --node-version v24.21.0 --dsh-version 0.2.1-alpha.3 --cwd /home/youruser/project
```

`myhost` 来自该 Windows 用户的 SSH config，也可替换成 `youruser@内网地址`。私钥与交互式密码沿用现有逻辑，不要把密码写入离线包。

导入不会迁移准备机的会话或登录状态，连接时创建新会话。包的 SHA-256 只能检测损坏，不能证明发布者身份；包内 DSH 是可执行代码，只能导入你信任来源的包。

如果运行库不兼容，暂存目录验证会失败，不会进入正常安装发布步骤。发布中的一般命令失败会在安装锁内回退本次移动项，可重新导入；断电、SIGKILL、磁盘/文件系统故障仍可能阻止回退。此时须由管理员确认目标目录与进程状态后修复，安装器不会强行覆盖已有路径。

## 5. 本机 DSH 插件离线安装

### 5.1 在联网 Mac 制作专用插件包

```bash
pnpm run package:offline-plugin
```

产物为 `dist/dsh-remote-explorer-<版本>-offline-plugin/`，包含 `package/`、`manifest.json` 和 `install.cjs`。输出目录存在时拒绝覆盖，请先保留或移走旧产物。

此包不是普通 npm 包：非宿主依赖已内联，不带 tsx、源码 CLI 或安装脚本；DSH/Cordis peers 由宿主提供，不能再复制另一份宿主依赖。包是纯 JS，可从 Mac 复制到 Windows。需要目标已有兼容 DSH（peer 范围为 0.2.x，含相应预发布版本），不支持用它安装 DSH 本体。

### 5.2 在离线机器安装

1. 安装并启动一次 DSH，使实际使用的 profile 初始化。
2. **完全退出目标 DSH，包括后台进程**，禁止其他插件安装器同时写 profile。
3. 确认实际 DSH_HOME 与 profile：桌面一般为 `desktop`，网页一般为 `web`，不要拿 web 模板覆盖桌面配置；以实际目录中的 package.json 为准。
4. 若部署 Agent 本身运行在待退出的 DSH 中，先交接给外部终端/已授权执行器，或由用户退出并安装；不能直接终止自身，也不能在宿主仍运行时传 `--host-stopped` 假装退出。
5. 用已有 Node 运行安装器。也可使用独立客户端随包的 node.exe：

```powershell
& "D:\remote-client\node.exe" "D:\offline-plugin\install.cjs" --bundle "D:\offline-plugin" --profile "$env:USERPROFILE\.dsh\profiles\desktop" --host-stopped
```

Mac/Linux 示例：

```bash
node ./offline-plugin/install.cjs --bundle ./offline-plugin --profile "$HOME/.dsh/profiles/desktop" --host-stopped
```

安装器会校验文件清单与摘要，仅添加本插件目录和稳定的 `offline-packages` 本地源，备份并合并现有 profile manifest；不会修改用户 patch、凭据、其他插件或宿主 App。已登记或存在本插件时拒绝覆盖。安装器不下载、不调用 pnpm，也不保证宿主所有 peers 都兼容；实际兼容性由重启后的 DSH 加载器判断。

**安装入口限制：** 只运行本包的 `install.cjs`，不要把专用 ZIP 交给普通在线插件安装入口，也不要用 `dsh plugin add` 或 `npm/pnpm install` 替代；其预检/修复路径可能访问公网。使用真实活动 profile，不能写入 App 安装目录或为了通过检查覆盖已有插件。

**维护限制：** 安装器不伪造或重写现有 pnpm lockfile。后续使用包管理器可能重排整个 profile，请保留本地源；离线更新整个 profile 仍需其余依赖的完整缓存。不要把手工注入当作通用 pnpm 离线仓库。

### 5.3 插件严格离线连接

推荐在 DSH 的本插件配置中将 `offline` 设为 `true`，重启/重新加载插件后生效。该配置同时控制连接引导与版本下拉探测，桌面用户不必依赖环境变量。

也可以在启动目标 DSH 进程前设置全局环境变量：

```powershell
$env:DSH_REMOTE_OFFLINE = '1'
# 从同一环境启动你已安装的 DSH；不要用 npx 临时下载。
```

Mac/Linux：

```bash
export DSH_REMOTE_OFFLINE=1
# 从此环境启动 DSH，确保桌面宿主确实继承变量。
```

注意已经运行的桌面进程不会因你在终端设置环境变量而改变；应完全退出后重启。连接面板中 Node 版本填写包内精确值，DSH 可填写精确值或留空以复用已安装版本，不可填写 latest/next 等标签，不要开启镜像重测。

## 6. 断网验收

准备完后，在操作系统层阻止本机与远端公网出站，但允许内网 SSH、模型服务：

1. 本机全新目录解压客户端，运行帮助。
2. 全新远端导入包，核对清单版本。
3. `connect --offline` 成功打开网页，终端与文件读写正常。
4. 不存在的 Node/DSH 版本应立即报缺资源，不能等待网络超时。
5. 插件版本下拉探测不访问 npm/Node 站点。
6. 内网模型完成一次对话、工具调用和流式响应。
7. 检查没有把准备机凭据、会话历史、原项目代码误带入包。

自动回归：

```bash
pnpm run typecheck
pnpm exec tsx --test tests/unit/*.test.ts
pnpm exec tsx tests/offline-ssh-smoke.ts
pnpm run build:plugin
pnpm run check:plugin
```

回环 SSH 冒烟使用临时 HOME 和临时主机密钥，不访问用户生产服务器。它验证真实 SSH 协议和 shell 探测，不等价于 Windows 桌面、Linux 全新导入和内网模型的完整验收。

插件专用分发目录构建后还可运行真实安装器冒烟（只操作临时 profile，预加载器禁止网络与子进程）：

```bash
pnpm exec tsx tests/offline-plugin-artifact.ts dist/dsh-remote-explorer-offline-candidate
```

## 7. 交给内网 Agent 的一体化总包

### 7.1 必须包含的四份资源

| 资源 | 用途 |
|---|---|
| `dsh-remote-explorer-0.8.4-offline-plugin.zip` | 本机已有 DSH 时使用的离线插件及 install.cjs，**不得漏发** |
| `dsh-remote-explorer-0.8.4-win32-x64.zip` | Windows 辅助 CLI 及 node.exe，用于插件安装和运行包导入 |
| `dsh-runtime-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3.zip` | 本次 Linux x64 运行包，内含 manifest.json 和 runtime.tar.gz |
| 对应运行包的 `.zip.sha256` | 检查运行包传输完整性，不是另一个运行环境 |

再加入 `README.md`、复制自 [AI 部署指引](offline-agent-readme.md) 的 `README_FOR_AI.md` 和 `SHA256SUMS.txt`。插件 ZIP 是三种 ZIP 之一，SHA 文件只是第四份交付文件；不要把“CLI、Linux 包、摘要”当成支持插件场景的完整集合。

本次完整交付命名为 `dsh-offline-agent-kit-v2-with-plugin.zip`。ZIP、运行时、私钥和部署现场文件不提交 Git；`dist/` 仍被忽略。Git 仓库只保存功能代码、构建入口和这份可复用指引，不代表已创建 GitHub Release 或上传二进制。

### 7.2 制作资源与总包（联网 Mac）

客户端用第 2 节打包脚本制作。插件建议显式采用下面的隔离输出名称，以匹配 AI 指引中的解压路径：

```bash
pnpm exec tsx scripts/package-offline-plugin.ts --output dist/dsh-remote-explorer-offline-candidate
```

目标目录必须不存在。使用 Mac 自带 bsdtar 将插件目录压成 ZIP，禁用 AppleDouble 元数据；若文件已存在应另用新文件名，不强行覆盖已交付包：

```bash
test ! -e dist/dsh-remote-explorer-0.8.4-offline-plugin.zip && \
  COPYFILE_DISABLE=1 tar --format=zip -cf dist/dsh-remote-explorer-0.8.4-offline-plugin.zip \
  -C dist dsh-remote-explorer-offline-candidate
```

Linux 资源必须从同系统/架构的准备机导出，不能由 Mac 的本机运行时替代。导出目录保留内层 runtime.tar.gz 和 manifest.json，再套一层便于带入 Windows 的 ZIP，并用 `shasum -a 256` 生成该 ZIP 的 `.sha256`。

准备好上表四份资源后，下面示例只组装已有文件，不会登录远端或安装任何东西。示例名字对应本次实际交付；其他版本必须同步更新资源名、AI 指引和校验清单：

```bash
set -eu
KIT=dist/dsh-offline-agent-kit
OUT=dist/dsh-offline-agent-kit-v2-with-plugin.zip
# 新建一次性目录，不复用旧工作树，避免夹带旧资源或用户凭据。
test ! -e "$KIT"
test ! -e "$OUT"
mkdir -p "$KIT/packages"
cp dist/dsh-remote-explorer-0.8.4-offline-plugin.zip "$KIT/packages/"
cp dist/dsh-remote-explorer-0.8.4-win32-x64.zip "$KIT/packages/"
cp dist/dsh-runtime-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3.zip "$KIT/packages/"
cp dist/dsh-runtime-linux-x64-ubuntu22.04-dsh0.2.1-alpha.3.zip.sha256 "$KIT/packages/"
cp docs/offline-agent-readme.md "$KIT/README_FOR_AI.md"
printf '# 离线部署交付包\n\n请先完整阅读 README_FOR_AI.md，校验后再执行；本机已有 DSH 时优先离线插件路线。\n' > "$KIT/README.md"
(
  cd "$KIT"
  shasum -a 256 README.md README_FOR_AI.md packages/* > SHA256SUMS.txt
  shasum -a 256 -c SHA256SUMS.txt
)
COPYFILE_DISABLE=1 tar --format=zip -cf "$OUT" -C dist dsh-offline-agent-kit
shasum -a 256 "$OUT" > "$OUT.sha256"
```

分发前还应核对 ZIP 条目，确认四份资源与 AI 指引都在里面、没有 `.ssh`、credentials、会话或无关工作目录；从总 ZIP 中流式读取并比对各文件摘要，不只检查源目录。若替换任何一个包或说明，必须重新生成内外层摘要，不能复用旧校验清单。

### 7.3 内网 Agent 的优先执行顺序

1. 完整读取 AI 指引、校验包，确认 Windows x64、现有 DSH 版本与活动 profile。
2. 获得退出同意，完全退出 DSH；若 Agent 就在该宿主运行，先安排外部执行器或用户接手。
3. 使用随包 node.exe 执行插件 install.cjs；已登记/存在插件时不强行覆盖。
4. 启用插件 `offline: true`，重启已有 DSH，确认远程会话面板加载正常。
5. 独立确认最终离线 Linux 的 SSH 地址、端口、账号及项目目录，再用辅助 CLI 导入运行包。
6. 从 DSH 远程会话面板连接，Node/DSH 版本与 manifest 一致，不同时启动 CLI connect 竞争同一会话。
7. 分项验证窗口、终端、文件与内网模型；缺少模型信息时明确标记待配置。

用户只需把总包交给内网 Agent；不需要让它访问 GitHub、npm 或准备机。目标地址、认证权限、实际 profile 和内网模型信息仍须由用户确认，不能从包里推断。该包不附带 DSH 本体、密钥或模型。

## 8. 本次已确认的验证结果

| 验证项 | 依据与状态 |
|---|---|
| TypeScript、插件构建及护栏 | 开发阶段通过 |
| 单元测试 | 574 项通过；测试命令排除原有 `ReverseListener 多地址绑定` 组，该组在本机 Mac 上绑定额外回环地址失败并遗留监听，不把它计为通过 |
| 回环真实 SSH doctor | 临时 HOME 与测试密钥下通过，不访问生产服务器 |
| Linux 真实运行包迁移 | Ubuntu 22.04.3 / x86_64 / glibc 2.35 准备机的独立临时 HOME 导入、运行时校验和严格离线新 profile 初始化通过；原安装未覆盖，测试树已清理 |
| 插件分发安装器 | 在禁止网络与子进程的预加载器下，真实分发包安装到临时 profile 通过 |
| 完整总包 | ZIP 内插件、CLI、运行包、原始摘要及说明逐项校验通过 |
| 离线 Windows 插件安装 | 用户反馈安装成功；没有收集精确宿主版本，不泛化为所有版本兼容 |
| 新建远程会话 | 用户反馈已可新建；不与终端/文件/模型完整验收混同 |
| 远程窗口完整操作、终端、文件读写、内网模型 | 本次未收集逐项结果，仍按第 6 节与 AI 指引继续验收 |

实际交付版本为 Remote Explorer 0.8.4、Node v24.21.0、DSH 0.2.1-alpha.3、pnpm 11.7.0。用户目标截图为 Ubuntu 22.04.4 / x86_64 / glibc 2.35。以上只记录已确认事实，不包含目标地址、私钥、密码、API Key 或会话令牌。
