# 离线支持验证记录

本文记录已验证的环境与范围，不是安装时必须使用的版本组合。通用流程见[离线部署指南](offline-cn.md)，部署版本始终以实际包内清单为准。

## 测试环境与版本快照

- Remote Explorer：0.8.4。
- 远端运行时：Node v24.21.0、DSH 0.2.1-alpha.3、pnpm 11.7.0。
- 联网准备机：Ubuntu 22.04.3、x86_64、glibc 2.35。
- 离线目标提供的环境信息：Ubuntu 22.04.4、x86_64、glibc 2.35。
- Windows 本机已安装 DSH，但未收集精确宿主版本；不能据此认定所有 0.2.x 宿主兼容。
- 维护侧 Windows x64 复核：typecheck、check-plugin、build:plugin、`package:offline-plugin` 与 `tests/offline-plugin-artifact.ts`（禁网禁子进程）通过；单元测试 575/578（3 项按平台守卫跳过，见下表）。

## 已验证范围

| 验证项 | 结果与边界 |
|---|---|
| 类型、构建及护栏 | TypeScript、插件构建与 check-plugin 通过 |
| 单元测试（POSIX） | 排除下述本机不兼容组后，574 项通过 |
| 单元测试（Windows） | 578 项中 575 过、3 项按平台守卫跳过：`offline-transfer` 集成回归依赖真实 POSIX shell/flock 整体跳过；链接攻击两个用例在无符号链接特权（未开开发者模式）的环境跳过 |
| 回环真实 SSH doctor | 临时 HOME、测试密钥下通过，不访问生产服务器；脚本依赖 /bin/sh 与 POSIX HOME，win32 直接跳过 |
| Linux 真实迁移 | 在准备机独立临时 HOME 导入真实运行包、验证 Node/DSH/pnpm 并完成严格离线新 profile 初始化；原安装未覆盖，测试目录已清理 |
| 插件分发安装器 | 真实分发包在禁止网络与子进程的条件下安装到临时 profile 通过 |
| 完整交付 ZIP | 插件、CLI、运行包、摘要和说明从最终 ZIP 读取并逐项校验通过 |
| 离线 Windows 插件 | 用户确认安装成功 |
| 新建远程会话 | 用户确认可新建；不等同于窗口、终端、文件及模型功能全部通过 |

平台边界约定：

- `tests/unit/offline-transfer.test.ts` 是真实 shell 集成回归，仅在 Linux/macOS 运行（win32 自动跳过并说明原因）。
- 链接攻击用例需要创建符号链接：Windows 需开发者模式或管理员权限，无能力时自动跳过；macOS/Linux 不受影响。
- 本机 Mac 上原有 `ReverseListener 多地址绑定` 测试组无法绑定额外回环地址，且失败后遗留监听。完整套件运行未获得通过结果，不将此组计入成功数。兼容回归使用：

```bash
pnpm exec tsx --test --test-skip-pattern='ReverseListener 多地址绑定' tests/unit/*.test.ts
```

## 尚未收集的逐项结果

- 用户最终目标上的远程窗口完整操作。
- 终端、文件读写与会话重连行为。
- 内网模型流式对话、认证及工具调用。
- 其他 Windows DSH 版本、其他 Linux 发行版与架构的兼容性。

这些项目应按部署指南在实际目标逐项验收；本记录不包含服务器地址、账号凭据、密钥、模型 Key 或会话访问令牌。
