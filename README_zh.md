# 守梦人 · Oneiropolos · 夢守

[English](README.md) · **中文**

> 你打个盹，它替你照看这场梦。

一个本地的双智能体闭环编排器（macOS App、浏览器界面和命令行）。两个角色，谁来担任由你选：

- **审计（主管）**：调研、拆计划、每轮给执行方一条指令；每轮结束后读 diff、亲自看文件、跑测试，再决定下一步。它从不改动你的项目。
- **执行**：真正读写文件、运行命令——可以一个人干，也可以组成**团队**并行干。

两个角色都可以是 **GPT**（Codex CLI，ChatGPT 订阅）、**Claude**（Claude Code，Claude 订阅）、**DeepSeek**（DeepSeek Harness，DeepSeek 账号或 API key）或 **WorkBuddy**（WorkBuddy.app 自带的内核，WorkBuddy 账号）。默认是 GPT 审计、WorkBuddy 执行。每个引擎在 **设置 → 账户** 里登录一次，与它自己的 App 互不影响。

循环一直进行，直到审计方判定目标完成；之后默认再开一个不知道前情的全新会话做独立验收。执行方单次跑不长（有步数上限、会中途停下）的问题，由程序自动续跑和逐轮指令解决。

```
你的目标 ─▶ 审计方规划 ─▶┌──────────────────────────────────────────────────────┐
（先出计划模式：         │ 第 N 轮：执行方完成指令                                  │
  你批准后才动手）        │         （或 2–3 个队友并行，结束后用 git 合并）          │
                        │      ↓ 影子 git 快照 · 验收命令自动运行                   │
                        │ 审计方：读 diff、看文件、跑测试 → 下一条指令              │
                        └───────────────────── 继续 ◀──────────────────────────────┘
                                               │ 完成
                                               ▼
                               全新会话独立验收 ─▶ 结束（或继续修复）
```

### 名字

**守梦人**，西文名 *Oneiropolos*，取自荷马史诗里的 *ὀνειροπόλος*——“与梦打交道的人”，也就是解梦者。《奥德赛》里说，梦有两扇门：穿过象牙门的梦会骗人，穿过角门的梦终会成真。WorkBuddy 的汇报就像一场梦，GPT 的审计、验收命令和独立验收，都是为了分辨它从哪扇门来。日文名是“夢守”。图标是睡神许普诺斯（Hypnos）：鬓角生着一只翅膀，闭着眼，枕着一弯新月（由 Codex 生图，原图在 `app/icon-source.png`）。

首页的诗句写的都是睡眠与打盹，按界面语言挑选：孟浩然、苏轼、杨万里、陶渊明、《庄子》，荷马、奥维德、济慈，芭蕉、小野小町……这些只是装饰；按钮、设置项等功能文字都保持直白。命令行和数据目录沿用旧名 `wbloop`。

## 准备

| 需要 | 说明 |
|---|---|
| macOS + Node.js ≥ 20 | 例如 `brew install node` 或 nvm |
| 用到的引擎 | 四个里任选；默认组合需要 GPT 和 WorkBuddy |
| · GPT | Codex CLI：`npm i -g @openai/codex` |
| · Claude | Claude Code：`npm i -g @anthropic-ai/claude-code` |
| · DeepSeek | DeepSeek Harness.app，装在“应用程序”里（[harness.deepseek.com](https://harness.deepseek.com)） |
| · WorkBuddy | WorkBuddy.app，装在“应用程序”里 |

检查环境（顺带显示 GPT 额度）：

```bash
node bin/wbloop.js doctor
```

## 启动

**App（推荐）**

```bash
bash app/build-app.sh                       # 构建 dist/Oneiropolos.app
open dist/Oneiropolos.app                   # 中文系统下显示为“守梦人”，日文系统下为“夢守”
cp -R dist/Oneiropolos.app ~/Applications/  # 想从启动台/Spotlight 打开就复制过去
```

App 优先使用项目目录里的代码，改了界面代码刷新（⌘R）即可；改了 Swift 外壳才需要重新构建。

**浏览器**：`node bin/wbloop.js serve --open`

**命令行**（想直接用 `wbloop` 命令，可以在本目录执行一次 `npm link`）：

```bash
node bin/wbloop.js run -d ~/projects/myproj --check "npm test" "实现……，约束……，验收标准：……"
```

## 语言

界面默认是**英文**。**设置 → 通用 → 语言 · Language** 可以在 English、中文、日本語 之间切换（⌘K 里搜“language”也行）。切换后页面会用新语言重新加载，App 的菜单也跟着变；运行中的任务消息会按当前语言重新显示。

- 命令行：`wbloop config ui.language=zh`（或 `ja`、`en`）；`WBLOOP_LANG=ja` 只对单条命令生效。
- **智能体写作用的语言**是另一回事：默认跟你写目标用的语言一致；也可以在 **模型与参数 → 回复语言**（或 `--lang en|zh|ja`）里固定。
- Dock 和访达里显示的名字跟随 macOS 系统语言（Oneiropolos / 守梦人 / 夢守），不受 App 内设置影响。

## 登录

**设置 → 账户**（或点左下角的引擎）列出四个引擎。点**登录**会在浏览器打开该引擎自己的登录页，登录完成后这一行变绿。终端里用 `wbloop login <gpt|claude|deepseek|workbuddy>` 也一样。

每份登录只属于本应用，引擎自己的 App 照旧用它们自己的：

| 引擎 | 怎么登录 | 登录存在哪 |
|---|---|---|
| GPT | `codex login`（ChatGPT） | codex 目录（`~/.codex`，或 高级 → Codex home） |
| Claude | `claude auth login`（Claude 订阅）；如果页面最后给出一段授权码，粘贴到这一行即可 | `~/.wbloop/claude-home`（目录填 `~/.claude` 则共用你平时 Claude Code 的登录） |
| DeepSeek | DeepSeek 自己的浏览器登录（platform.deepseek.com），或 **改用 API key** | `~/.wbloop/dsh-home`（与桌面版的 `~/.dsh` 分开）；key 存在 `~/.wbloop/keys.json`（权限 0600） |
| WorkBuddy | 官方登录页（国内站或国际站） | `wbloop-cli.info`，与桌面版自己的（加密）登录并排，从不改动它 |

任务中途登录过期时，任务会暂停并给出**账户**按钮；重新登录后点“继续”即可。

## 使用

左边是任务列表（置顶的在最上，其次是进行中的），右边是对话。**你和审计方的消息在右侧，执行方的在左侧**：你提出目标 → 审计方制定计划并交出指令 → 执行方干活并汇报 → 审计方检查、给出下一步……每个角色有自己的徽记：雅典娜的猫头鹰是审计方，赫菲斯托斯的锤子是执行方，新月是你，忒弥斯的天平是独立验收员。

在左侧任务上点右键：**置顶**、**重命名**、**在访达中打开**、**导出**、暂停 / 停止 / 继续、**删除**。

### 新建任务

1. 在首页输入框里写清楚**目标、技术约束、验收标准**。`@` 引用工作目录里的文件，`#` 点名一个子代理，`/` 打开命令。输入框底部：
   - **工作目录**（文件夹按钮）：选一个专门的项目文件夹（最好是 git 仓库）。点开会列出最近用过的目录，“选择其他目录…”打开文件夹选择器。
   - **模型与参数**（右侧的模型名）：审计和执行各自的**引擎**（GPT、Claude、DeepSeek、WorkBuddy）、模型与思考强度，WorkBuddy 的上下文窗口、GPT 联网搜索、给执行方的额外目录、团队模式与人数、任务模式、回复语言、最多轮数、token 预算、**验收命令**、决策方式、独立验收、敏感命令策略。
   - **+**：模板和三个选项。改过的选项会以小标签显示在按钮上方：点标签可以再改，点 × 恢复默认。
     - **团队模式**：单人、自动（GPT 可以把一轮拆给几个队友）、总是。
     - **任务模式**：普通、**先出计划**（你批准 GPT 的计划之前不会改任何文件）、**漏洞排查**（审查你自己的代码：每个发现都用最小的复现来验证，并附修复建议）。
     - **开始时间**：立即开始，或定在今晚 23:00、深夜、早上、任意时刻；选的 WorkBuddy 模型有夜间折扣时，还会多一个“折扣开始时”。到点前任务只是等待（期间 Mac 不会空闲休眠），也可以随时“立即开始”。
2. 点金色箭头（或 ⌘↩）开始。
3. **模板**（在 **+** 里，或输入 `/template`）：新功能、修 Bug、新项目、重构、性能优化、补测试、审查修复、生成 AGENTS.md（`/init`）、**深度调研**、安全审计、并行协作。选一个填入，把带【】的地方换成自己的内容，按 Tab 跳到下一处；还有没替换的【】时点开始会提醒。列表最后的“存为模板”可以把写好的目标存下来。

参数说明：

- **验收命令**（例如 `npm test`、`python3 -m unittest -q`）：每轮 WorkBuddy 做完后，程序自己在工作目录里运行它，把退出码和输出直接交给 GPT 审计；独立验收前也会再跑一次。这份结果不经过 WorkBuddy 转述，比它自己的汇报更可信。
- **WorkBuddy 的模型信息与桌面版同步**：倍率、“夜间折扣”等标签、上下文窗口档位、思考强度档位都来自 WorkBuddy 服务器下发的实时配置（App 启动时如果超过 2 小时没更新会自动刷新；参数面板里也能点“刷新”，不调用模型、不耗积分）。
- **最多轮数**和 **token 预算**（单位百万 token，GPT 与 WorkBuddy 合计）：到达任一上限时，GPT 先做一次**收尾总结**（完成了什么、还差什么、下一步交给 WorkBuddy 什么），再暂停；调高上限后点继续即可。
- **决策方式**默认“GPT 自行决定”，适合无人值守；选“重要决策时问我”时，GPT 会在需要时暂停并发系统通知。
- **独立验收**默认开启：GPT 判定完成后，再开一个不知道前情的新会话复核一遍，发现问题会继续修。

### 任务进行中

- 在底部给 GPT **留言**（↩ 发送，下一次审计时生效），例如“改用 pytest”“先别管性能”。
- **打断并留言**（⌥↩，或 `/cut 留言`）：马上结束正在进行的这一步——GPT 在思考就带着留言重答，WorkBuddy 在执行就停下、交给 GPT 结合你的留言处理。任务本身不停。
- **随口问问**（标题栏的对话气泡，或 `/btw 问题`）：问 GPT 一个问题，例如“现在进度怎么样”。回答在右侧抽屉里，只给你看，不让任何一方停下来（会用一点 GPT 额度）。
- **敏感命令**（`rm -rf`、`git push --force`、`git reset --hard`、把下载内容直接交给 shell 执行……内置 17 条规则，也可以自己加）：默认策略下 WorkBuddy 会停下等待，界面弹出一张卡片——**允许**、**总是允许**（本任务内）或**拒绝**（可以写原因，会转告 WorkBuddy）。10 分钟没回应按拒绝处理。`/yolo` 切换“不问直接允许”。
- **先出计划**模式：GPT 的计划下面有**批准**按钮（或 `/approve`）；留言则会让 GPT 修改计划。
- **团队模式**：每个队友有自己的一条泳道，实时显示其执行过程；队友之间有共享留言板（`/board`，或 `>>名字 消息` 发给某个队友）。一轮结束时用 git 合并大家的改动，冲突交回 GPT 处理。
- **暂停 / 继续 / 停止**；标题栏的“调整”可以中途改模型、轮数、预算、验收命令。
- **实时看 WorkBuddy 干活**：每一轮的“执行过程”里能看到它的思考、说明文字和每一次工具调用，点开一步看细节——运行的命令和输出、编辑前后的差异、写入的文件、子代理做了什么；高风险命令会有标记。一轮结束后执行过程自动收起，保留汇报、本轮改动（文件列表 / diff）和验收命令的结果。`/tool-display` 在“详细 / 精简 / 只看汇报”之间切换。

### 任务结束后

- 在底部写新要求，任务会自动接着做。
- **回滚工作区**（每轮改动旁的“回滚”、“⋯”菜单、`/rollback`，或连按两次 Esc）：把工作目录恢复到某一轮开始前或结束时。回滚前会先把当前状态存成快照，所以随时可以撤销；node_modules 等被排除的目录、超过 5MB 的大文件不受影响。下次继续时 GPT 会知道文件被恢复过。
- **导出对话记录**（`/export`）：整理成 Markdown 存到“下载”文件夹；`/copy` 复制最后一条回复。

## 从 snow-cli 迁移来的功能

工作方式、许多命令和系统提示词参考了 [snow-cli](https://github.com/MayDay-wpf/snow-cli)，并按“GPT 总控 + WorkBuddy 执行”的结构做了改造：

| snow-cli | 这里 |
|---|---|
| 系统提示词、`ROLE.md`、覆盖式角色 | 每个角色（总控、执行者、队友、验收员、顾问）都有内置提示词；**设置 → 提示词**可以把任意一个完全替换（支持 `{{workdir}}`、`{{date}}` 等变量）。项目根目录（或 `~/.wbloop`）的 `ROLE.md` 可以作为“用户强调的规则”附加，也可以直接替换 WorkBuddy 的提示词。GPT 通过 Codex 的 `model_instructions_file` 接收提示词，WorkBuddy 通过 `--system-prompt-file`。 |
| 子代理、`/agent`、`#` 选择器、`.snow/agents/*.md` | 内置六个（explore、plan、general、analyze、QA、debug），用 `--agents` 交给 WorkBuddy；可以在“设置 → 子代理”里自建，或在 `<项目>/.wbloop/agents`、`<项目>/.snow/agents`、`~/.wbloop/agents` 里放 Markdown 文件。在目标或留言里写 `#agent_explore` 即可点名。 |
| `/role-subagent`（`ROLE-<name>.md`） | 每个子代理旁的“规则”会写入 `~/.wbloop/ROLE-<id>.md`；项目根目录里的 `ROLE-<id>.md` 对该项目优先。 |
| 团队模式（`/team`） | GPT 把一轮的工作分给几个队友（名字、角色、负责的文件）。每人在一份 APFS 克隆的目录副本里工作，结束后用 git 三方合并；队友通过共享的 `BOARD.md` 留言。 |
| Plan 模式、`/goal` | “先出计划”模式，批准后才执行；整个 App 本身就是目标驱动、按证据审计的。 |
| 漏洞挖掘模式 | 任务模式“漏洞排查”和“安全审计”模板。 |
| 钩子（9 种，`.snow/hooks`） | 同样的类型和退出码含义（0 正常 / 可返回 JSON `additionalContext`，1 替换，2 拦截），支持命令、提示词、上下文三种钩子；全局放在 `~/.wbloop/hooks`，项目放在 `.snow/hooks` 或 `.wbloop/hooks`。工具类钩子通过 WorkBuddy 的 PreToolUse/PostToolUse 生效。 |
| 敏感命令、YOLO、`/permissions` | 策略：询问 / 拒绝 / 允许；17 条规则可逐条开关，可加自定义正则规则；“总是允许”按任务生效；`/yolo`。 |
| 技能、`/skills` | 从 `~/.wbloop/skills` 和项目的 `.claude`、`.codebuddy`、`.snow`、`.wbloop` 技能目录读取 `SKILL.md`；`/skills` 把某个技能放进消息。 |
| 自定义命令（`$ARGUMENTS`、命名空间） | “设置 → 技能与命令”，或 `~/.wbloop/commands`、`.snow/commands` 里的 JSON 文件；分“作为消息发送”和“在终端运行”两种。 |
| MCP | `~/.wbloop/mcp.json`（设置 → MCP），每个服务器可以只给 WorkBuddy、只给 GPT 或都给。 |
| `/loop` | `/loop 30m 检查日志`、`/loop 每天 09:30 ……`（也认 daily / 毎日）：定时新建任务或给任务留言。 |
| 代码记忆 | 每个项目一本笔记本，WorkBuddy 会读并更新（`/notebook`）。 |
| `` !`cmd` ``、`` !!`cmd` `` | 目标和留言里的命令注入：输出插进文本，或只显示给你看。 |
| `/review`、`/new-prompt`、`/usage`、`/todo`、`/gitline`、`/deepresearch`、`/compact`、`/init`、`/btw`、`/cut`、`/pause`、`/export`、`/copy`、`/tool-display`、`/profiles`、`/config` 导入导出、连按两次 Esc 回滚 | 都有（配置方案在“设置 → 默认参数”，导入导出在“系统与数据”）。 |

有意没有迁移的：只在终端里有意义的功能（宠物、小游戏、像素编辑器、状态栏、工具图标与名称、速度表、思考显示、简洁主题）；snow 自己的模型运行时设置，在这里由 Codex 和 WorkBuddy 自己负责（模型提供商与 OAuth、自定义请求头、工具搜索、工具调用纠错、压缩模式、子代理嵌套深度）；IDE/LSP 集成与代码库索引；服务模式、远程实例和遥测。`/branch` 的替代是新建任务，`/worktree` 用 git 本身；`/auto-format` 可以用 `afterToolCall` 钩子实现；`/backend` 和 `/taskmanager` 对应任务列表（每个任务都是独立进程）；`/todolist`、`/ultra-todo` 对应 GPT 带状态的计划和每轮的审计关卡。

## 快捷键与命令

| 快捷键 | 作用 |
|---|---|
| ⌘K | 命令面板：任务、命令、设置、语言、主题 |
| ⌘N / ⌘, / ⌘/ | 新任务 / 设置 / 使用说明 |
| ⌘↩ | 开始任务（首页） |
| ↩ / ⇧↩ / ⌥↩ | 发送 / 换行 / 打断并发送 |
| ↑ ↓ | 输入框为空时翻看之前的输入 |
| Esc Esc | 回滚到某一轮 |
| `/` | 斜杠命令（中文输入法打出的“、”也算），Tab 补全；支持拼音首字母，例如 `/hg` 是回滚 |
| `@` / `#` / `>>` | 引用文件 / 点名子代理 / 给队友留言 |

对话页：`/cut` `/btw` `/approve` `/pause` `/resume` `/stop` `/plan` `/diff` `/rollback` `/review` `/export` `/copy` `/compact` `/team` `/yolo` `/rounds 40` `/budget 20` `/check npm test` `/skills` `/agents` `/todo` `/gitline` `/new-prompt` `/loop` `/notebook` `/board` `/usage` `/tool-display` `/settings` `/help`，以及你的自定义命令。

首页：`/dir` `/params` `/template` `/team` `/mode` `/init` `/deepresearch <问题>` `/gitline` `/new-prompt` `/review` `/skills` `/agents` `/todo` `/loop` `/notebook` `/usage` `/mcp` `/hooks` `/settings` `/help`。

## 设置

共十一页：**通用**（语言、主题、执行过程详略）、**账户**（每个引擎的登录）、**默认参数**（新任务的参数、保存的配置方案）、**提示词**（每个角色用内置还是自定义、给 GPT 和 WorkBuddy 的长期要求、ROLE.md）、**子代理**、**安全**（策略、等待时间、规则）、**钩子**、**技能与命令**、**MCP**、**长时间运行**（单次步数、自动续跑、无输出超时、限流等待、验收命令超时、自动压缩）、**系统与数据**（通知、防止休眠、笔记本、清理、用量、定时循环、设置的导入导出）。

## 命令行

```bash
node bin/wbloop.js templates                  # 列出模板
node bin/wbloop.js templates bugfix > goal.md # 导出后编辑【】里的内容
node bin/wbloop.js run -d ~/projects/myproj --goal-file goal.md --team auto --check "npm test" --start-at 23:00
node bin/wbloop.js run -d . --mode plan "……"  # 然后：wbloop approve-plan last
node bin/wbloop.js run -d . --lead claude --lead-model opus --exec deepseek "……"
node bin/wbloop.js login claude               # 或 gpt、deepseek、workbuddy；退出用 logout <引擎>
node bin/wbloop.js allow last --always        # 回复敏感命令请求（或：deny last --reason "……"）
node bin/wbloop.js loop add "每天 09:30 检查日志并修复新出现的错误"
node bin/wbloop.js quota | usage 7d | agents | prompt executor
```

其余：`wbloop list / show / tail / msg / pause / stop / resume / compact / export <ID|last>`，`wbloop config key=value`。前台运行时直接输入文字就是留言；`/cut ……`、`/approve`、`/allow`、`/deny`、`/compact`、`/pause`、`/resume`、`/stop` 也都能用。

## 适合长时间运行的设计

- 每个任务由独立的后台进程执行，**关掉 App 或界面不影响任务**；重新打开即可接着看。
- 状态每一步都落盘（`~/.wbloop/runs/<ID>/`）。电脑重启或进程意外退出后，任务显示“已中断”，点“继续”从断点接着跑（WorkBuddy 会续接原会话）。
- WorkBuddy 因步数上限、网络中断、长时间无输出而停下时自动续跑；限流时自动等待重试。
- ChatGPT 额度用完时，GPT 按 5→10→15→30→60 分钟的间隔自动重试，最多等 8 小时（可设置），额度恢复后自动接着干。左下角随时能看到剩余额度。
- 运行期间阻止 Mac 空闲休眠（合盖仍会休眠）；完成、出错、需要你决定时发系统通知。
- GPT 选的模型在当前账号不可用时，自动换下一个可用模型并记住。

## 安全说明

- **WorkBuddy 在工作目录里拥有完整的读写和执行权限**（默认“跳过确认”模式，敏感命令按上面的策略处理）。请选择专门的项目目录；程序拒绝把根目录或整个用户目录作为工作目录，同一目录同时只允许一个未结束的任务。
- WorkBuddy 只开放编码相关的工具（文件、命令、子代理、任务清单、联网、技能、MCP 资源）；关掉了无人值守时会卡住或出错的（向用户提问、计划模式、它自己的团队/频道功能、远程 A2A），以及耗积分的图片/视频生成。需要全部工具时：`wbloop config workbuddy.tools=all`。
- **审计方不能修改你的项目**：GPT 在 Codex 沙箱里运行，项目只读（只有它的草稿目录和临时目录可写，用来跑测试）；Claude 从草稿目录运行，Claude Code 的沙箱把命令的写入限制在那里，也拿不到写文件的工具；DeepSeek 在 DeepSeek Harness 的只读沙箱里运行；WorkBuddy 当审计时只有只读工具，会写文件的命令会被拦下。随口问问和代码审查也是只读的。
- **执行方**：WorkBuddy 和 Claude 在工作目录里有完整权限，敏感命令按上面的策略处理；GPT 和 DeepSeek 没有工具钩子，策略没法在那里问你，改由各自的沙箱（workspace-write）把写入限制在工作目录和额外目录之内。
- 验收命令、钩子和自定义命令都是你自己写的，程序原样运行（`zsh -c`），请只用你信任的命令。
- 每轮改动用放在 `~/.wbloop/runs/<ID>/shadow.git` 的独立 git 仓库记录，**不会碰你项目自己的 .git**；回滚也只用这份影子仓库。
- 本地服务只监听 127.0.0.1，接口需要随机令牌，并校验 Host 头。

## 数据位置

| 路径 | 内容 |
|---|---|
| `~/.wbloop/config.json` | 设置（`wbloop config` 可查看/修改） |
| `~/.wbloop/runs/<ID>/` | 一个任务：状态、事件日志、每轮的指令/工具记录/diff/验收输出、系统提示词、审批记录、团队工作区、影子 git |
| `~/.wbloop/hooks/`、`commands/`、`skills/`、`agents/` | 全局的钩子、自定义命令、技能、子代理 |
| `~/.wbloop/ROLE.md`、`ROLE-<id>.md` | 全局 ROLE 文件；某个子代理的规则 |
| `~/.wbloop/mcp.json`、`loops.json` | MCP 服务器；定时循环 |
| `~/.wbloop/notebooks/` | 项目笔记本 |
| `~/.wbloop/usage/` | 每天的 token 用量 |
| `~/.wbloop/templates.json`、`ui-state.json` | 你的模板；界面的小偏好 |
| `~/.wbloop/workbuddy-home/` | WorkBuddy 内核给本程序用的配置与会话记录（与桌面版的 `~/.workbuddy` 隔离） |
| `~/.wbloop/claude-home/`、`dsh-home/`、`keys.json` | 本程序自己的 Claude Code 与 DeepSeek Harness 目录（登录与会话）；DeepSeek 的 API key |
| `~/.wbloop/runs/<ID>/meta.json` | 任务的名字和置顶（来自右键菜单） |
| `~/.wbloop/logs/app-server.log` | App 启动的本地服务日志 |

彻底清理：删除 `~/.wbloop` 和上面的 `wbloop-cli.info`。只想清理旧任务：设置 → 系统与数据 → 清理。

## 常见问题

- **GPT 报 “model is not supported when using Codex with a ChatGPT account”**：说明该模型在你的订阅下不可用。程序会自动换模型；调用 Codex 时用 `--ignore-user-config` 并显式指定模型，因为 `~/.codex/config.toml` 里的默认模型不一定适用于订阅登录。
- **GPT 额度显示“来自最近一次会话”**：实时读取需要连上 chatgpt.com（`codex app-server` 的 account/rateLimits/read，不耗额度）；连不上时退回最近一次 Codex 会话里记录的数据。
- **从 App 启动连不上 ChatGPT**：App 不继承终端里的 `*_proxy` 变量，程序会自动读取 macOS 系统代理设置。若仍失败，检查系统代理是否开启。
- **想换 WorkBuddy 模型**：新建任务时在参数里选，或 `wbloop config workbuddy.model=glm-5.3`。下拉框里标了各模型当前的倍率、标签和下一次折扣开始的时间，与桌面版一致。Auto 由 WorkBuddy 自动选。
- **长时间编译/测试被打断**：WorkBuddy 30 分钟没有任何输出会被视为卡住并自动续跑；单次调用最长 120 分钟。都可以在“设置 → 长时间运行”里调整。
- **Dock 里旧的 WBLoop 图标打不开了**：新版 App 叫 `Oneiropolos.app`，把新的拖进 Dock 即可。

## 实现说明（给想改代码的人）

文件结构见 [README.md 的 For developers 一节](README.md#for-developers)。GPT 的每次回复都按 `src/schema.js` 的 JSON Schema 输出：`verdict`（continue / done / ask_user / abort）、`assessment`、`plan`、`issues`、`next_instruction`、`team`、`progress`、`question_for_user`。测试：`npm test`（Node 自带的测试运行器；Codex 和 WorkBuddy 用假的替身）。
