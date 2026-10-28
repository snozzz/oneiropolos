Windows 桌面版（Windows 10/11 x64）。

- **安装版**：下载 `windows-x64-setup.exe`，按向导安装。
- **免安装版**：下载 `windows-x64.zip`，完整解压后运行 `Oneiropolos.exe`。
- 内置 Node.js 24；请另外安装所用的智能体引擎，以及 Git for Windows。
- 原生文件夹选择、Ctrl 快捷键、CLI 自动查找、Windows 系统代理、后台任务、进程树停止、快照回滚与团队工作区。
- 移除顶部 File / Edit / View / Help 菜单栏，常用功能从应用内按钮和 Ctrl 快捷键访问。
- 验收命令、钩子与自定义命令使用 cmd.exe；PowerShell 语法请显式调用 powershell.exe。

**验证**：Windows 自动测试覆盖任务闭环、计划审批、中断恢复、快照、团队合并，以及包含空格和中文的命令参数、npm 启动器、子进程停止。已在本机验证打包版启动、内置 Node 后端、原生文件夹选择，以及真实 WorkBuddy / DeepSeek CLI 启动。

**已知限制**：安装包未做代码签名。Windows 上 Claude / WorkBuddy 审计方只使用只读文件与联网工具；配置的验收命令仍由程序独立执行。未进行付费模型任务或新账户登录。

附 `SHA256SUMS.txt` 供校验。macOS 源码构建方式保持可用。

---

Windows x64 installer and ZIP distribution with bundled Node.js. Install Git and your chosen agent engines separately. The desktop shell has no menu bar; Ctrl shortcuts and in-app controls remain available. Windows binaries are unsigned. See README.md for build instructions and platform-specific behavior.
