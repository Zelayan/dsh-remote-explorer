# 离线部署（离线增强分支）

本功能将「准备资源」与「连接」分开。**离线不是不需要模型：仍需本机可访问且兼容 DSH 的内网模型服务。** 本机与远端必须能通过 SSH 互通。

## 1. 支持范围与限制

- `connect/provision --offline`：不进行镜像测速、在线版本解析、下载或 npm 安装。缺少 Node、DSH 或兼容 pnpm 时立即报错。
- `DSH_REMOTE_OFFLINE=1`：整个 Remote Explorer 进程的离线开关，对 CLI 和插件生效；插件版本下拉框不再访问公共版本源。
- `offline-export`：从已配置的同平台联网准备主机导出 **Node（含全局 pnpm）、DSH 安装及依赖**。
- `offline-import`：经 SSH 将离线包导入全新目标，先验证摘要、平台、归档安全和运行时，再发布；**拒绝覆盖已有安装**。
- 自包含插件包：在 Mac 上制作，复制到 Windows/Linux/macOS 后仅用 Node 安装到已有 DSH profile，不调用包管理器。
- 远端归档暂支持 Linux/macOS、x64/arm64。归档压缩大小最多 1 GiB，展开最多 8 GiB、200000 个成员。当前传输接口导出需要整包读入内存，应预留足够内存。
- 首版不提供插件离线升级/卸载、远端运行时覆盖升级或面板上传包。远端包导入导出使用 CLI；插件连接使用全局环境变量开启离线模式。
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
pnpm exec tsx src/cli/bin.ts provision myhost --node-version v24.21.0 --dsh-version 0.2.0-rc.2
```

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
.\dsh-remote-explorer.cmd connect myhost --offline --node-version v24.21.0 --dsh-version 0.2.0-rc.2 --cwd /home/youruser/project
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
4. 用已有 Node 运行安装器。也可使用独立客户端随包的 node.exe：

```powershell
& "D:\remote-client\node.exe" "D:\offline-plugin\install.cjs" --bundle "D:\offline-plugin" --profile "$env:USERPROFILE\.dsh\profiles\desktop" --host-stopped
```

Mac/Linux 示例：

```bash
node ./offline-plugin/install.cjs --bundle ./offline-plugin --profile "$HOME/.dsh/profiles/desktop" --host-stopped
```

安装器会校验文件清单与摘要，仅添加本插件目录和稳定的 `offline-packages` 本地源，备份并合并现有 profile manifest；不会修改用户 patch、凭据、其他插件或宿主 App。已登记或存在本插件时拒绝覆盖。安装器不下载、不调用 pnpm，也不保证宿主所有 peers 都兼容；实际兼容性由重启后的 DSH 加载器判断。

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
