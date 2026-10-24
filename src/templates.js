import crypto from 'node:crypto';
import { currentLang, t } from './i18n.js';
import { TEMPLATES_PATH, ensureDirs } from './paths.js';
import { INIT_GOAL } from './prompts.js';
import { readJson, writeJsonAtomic } from './util.js';

// Built-in task templates in three languages. The parts to replace are marked 【…】 (Chinese/Japanese) or [[…]]
// (English); Tab jumps between them in the UI. A template may also carry settings (e.g. Vulnerability Hunting mode).
export const BUILTIN_TEMPLATES = [
  {
    id: 'feature',
    i18n: {
      en: {
        name: 'New feature',
        hint: 'Add a feature to an existing project',
        body: `Implement [[feature name]] in this project.

Background: [[why it is needed and who will use it]]

Requirements:
- [[requirement 1, e.g. add an --export option to the CLI that writes the result as CSV]]
- [[requirement 2]]
- Follow the existing code style and directory layout; no new dependencies unless necessary

Acceptance criteria:
- The feature has unit tests covering normal input, edge cases and invalid input
- All existing tests still pass
- README (or the relevant docs) explains how to use it`,
      },
      zh: {
        name: '新功能',
        hint: '在现有项目里加一个功能',
        body: `在这个项目里实现【功能名称】。

背景：【为什么需要这个功能、谁来用】

具体要求：
- 【要求 1，例如：命令行新增 --export 参数，把结果导出为 CSV】
- 【要求 2】
- 沿用项目现有的代码风格和目录结构，没有必要不引入新依赖

验收标准：
- 新功能有单元测试，覆盖正常输入、边界情况和错误输入
- 项目原有测试全部通过
- README 或相关文档补充了用法说明`,
      },
      ja: {
        name: '新機能',
        hint: '既存のプロジェクトに機能を追加',
        body: `このプロジェクトに【機能名】を実装してください。

背景：【なぜ必要か、誰が使うか】

要件：
- 【要件 1。例：CLI に --export オプションを追加し、結果を CSV で出力する】
- 【要件 2】
- 既存のコードスタイルとディレクトリ構成に従い、必要がなければ新しい依存関係は追加しない

完了条件：
- 新機能に単体テストがあり、正常系・境界値・異常系をカバーしている
- 既存のテストがすべて通る
- README または関連ドキュメントに使い方を追記している`,
      },
    },
  },
  {
    id: 'bugfix',
    i18n: {
      en: {
        name: 'Fix a bug',
        hint: 'Find the root cause, fix it, add a regression test',
        body: `Fix this problem: [[the symptom, e.g. the program crashes when importing an Excel file with more than 10,000 rows]]

How to reproduce: [[commands, steps or input data]]
Expected result: [[what should happen]]
Known clues: [[error messages, suspected location; delete this line if none]]

Requirements:
- First write a test that reproduces the problem (fails before the fix), then fix it
- Find the root cause instead of working around the symptom
- Don't change code unrelated to the problem

Acceptance criteria:
- The new regression test and all existing tests pass
- Following the reproduction steps confirms the problem is gone`,
      },
      zh: {
        name: '修 Bug',
        hint: '定位根因并修复，附回归测试',
        body: `修复这个问题：【问题现象，例如：导入超过 1 万行的 Excel 时程序崩溃】

复现方法：【命令、操作步骤或输入数据】
期望结果：【正常情况下应该是什么样】
已知线索：【报错信息、怀疑的位置；没有就删掉这一行】

要求：
- 先写一个能复现问题的测试（修复前失败），再动手修
- 找到根本原因，不要只绕开症状
- 不改与这个问题无关的代码

验收标准：
- 新增的回归测试通过，原有测试全部通过
- 按上面的复现方法确认问题已经消失`,
      },
      ja: {
        name: 'バグ修正',
        hint: '根本原因を突き止めて修正し、回帰テストを追加',
        body: `次の問題を修正してください：【症状。例：1 万行を超える Excel を取り込むとクラッシュする】

再現手順：【コマンド、操作手順、入力データ】
期待される結果：【本来どうなるべきか】
手がかり：【エラーメッセージや怪しい箇所。なければこの行を削除】

要件：
- まず問題を再現するテスト（修正前は失敗する）を書き、それから修正する
- 症状を回避するのではなく根本原因を直す
- 問題と関係のないコードは変更しない

完了条件：
- 追加した回帰テストと既存のテストがすべて通る
- 上の再現手順で問題が解消したことを確認している`,
      },
    },
  },
  {
    id: 'new-project',
    i18n: {
      en: {
        name: 'New project',
        hint: 'Build from scratch in an empty folder',
        body: `Build [[project name]] from scratch in this folder: [[one sentence on what it does]].

Tech stack: [[language, framework and versions, e.g. Python 3.12 + FastAPI + pytest; or "recommended by GPT"]]

Core features:
1. [[feature 1]]
2. [[feature 2]]
3. [[feature 3]]

Requirements:
- A clear directory layout; README explains installation, running and testing
- Unit tests for the core logic
- A runnable example

Acceptance criteria:
- Following the README from scratch works
- All tests pass`,
      },
      zh: {
        name: '新项目',
        hint: '在空目录里从零搭建',
        body: `在这个目录里从零实现【项目名称】：【一句话说明它是做什么的】。

技术栈：【语言、框架和版本，例如 Python 3.12 + FastAPI + pytest；不确定就写“由 GPT 推荐”】

核心功能：
1. 【功能 1】
2. 【功能 2】
3. 【功能 3】

要求：
- 目录结构清晰，README 写明安装、运行和测试方法
- 核心逻辑有单元测试
- 附一个能直接运行的示例

验收标准：
- 按 README 的步骤能从零跑起来
- 全部测试通过`,
      },
      ja: {
        name: '新規プロジェクト',
        hint: '空のフォルダーにゼロから構築',
        body: `このフォルダーに【プロジェクト名】をゼロから実装してください：【何をするものか一文で】。

技術スタック：【言語・フレームワーク・バージョン。例：Python 3.12 + FastAPI + pytest。決めていなければ「GPT のおすすめ」】

主な機能：
1. 【機能 1】
2. 【機能 2】
3. 【機能 3】

要件：
- 分かりやすいディレクトリ構成。README にインストール・実行・テストの方法を書く
- コアロジックに単体テストがある
- そのまま動かせるサンプルを付ける

完了条件：
- README の手順どおりにゼロから動かせる
- すべてのテストが通る`,
      },
    },
  },
  {
    id: 'refactor',
    i18n: {
      en: {
        name: 'Refactor',
        hint: 'Improve the structure, keep the behaviour',
        body: `Refactor [[module, file or directory]] to [[e.g. split an oversized file / remove duplication / clarify module boundaries]].

Constraints:
- External behaviour and interfaces stay the same
- Work in small steps; tests pass after every step
- [[other constraints, e.g. don't change the database schema; delete this line if none]]

Acceptance criteria:
- All existing tests pass; where coverage is thin, add tests before changing code
- [[a measurable result, e.g. no file longer than 400 lines]]`,
      },
      zh: {
        name: '重构',
        hint: '行为不变，改善代码结构',
        body: `重构【模块、文件或目录】，目标是【例如：拆分过大的文件 / 消除重复代码 / 理清模块边界】。

约束：
- 对外行为和接口保持不变
- 分小步进行，每一步完成后测试都能通过
- 【其他约束，例如：不改数据库结构；没有就删掉这一行】

验收标准：
- 原有测试全部通过；覆盖不足的地方先补测试再改
- 【可以衡量的结果，例如：单个文件不超过 400 行】`,
      },
      ja: {
        name: 'リファクタリング',
        hint: '振る舞いを変えずに構造を改善',
        body: `【モジュール・ファイル・ディレクトリ】をリファクタリングしてください。目的は【例：大きすぎるファイルの分割 / 重複の除去 / モジュール境界の整理】です。

制約：
- 外部から見た振る舞いとインターフェースは変えない
- 小さなステップで進め、各ステップの後でテストが通る状態を保つ
- 【その他の制約。例：DB スキーマは変更しない。なければこの行を削除】

完了条件：
- 既存のテストがすべて通る。カバレッジが薄い箇所は先にテストを追加する
- 【測定できる結果。例：1 ファイル 400 行以内】`,
      },
    },
  },
  {
    id: 'perf',
    i18n: {
      en: {
        name: 'Performance',
        hint: 'Measure a baseline, find the bottleneck, optimise',
        body: `Speed up [[feature or endpoint]]: today [[e.g. processing 100,000 records takes 40 s]], target [[e.g. under 10 s]].

How to measure: [[how to reproduce and time it, e.g. python bench.py --rows 100000]]

Requirements:
- Measure a baseline and find the real bottleneck before optimising
- The results after optimisation must be identical to before
- [[other constraints, e.g. memory use must not grow noticeably; delete this line if none]]

Acceptance criteria:
- The target is reached with the same measurement method; before/after numbers are recorded
- All existing tests pass`,
      },
      zh: {
        name: '性能优化',
        hint: '先测基线，再找瓶颈优化',
        body: `优化【功能或接口】的性能：目前【现状，例如：处理 10 万条记录要 40 秒】，目标【例如：10 秒以内】。

测量方法：【怎么复现和计时，例如：python bench.py --rows 100000】

要求：
- 先测出基线并找到真正的瓶颈，再动手优化
- 优化后的结果必须和优化前完全一致
- 【其他约束，例如：内存占用不能明显增加；没有就删掉这一行】

验收标准：
- 用同一测量方法达到目标，并记录优化前后的数据
- 原有测试全部通过`,
      },
      ja: {
        name: 'パフォーマンス改善',
        hint: 'まず基準を測り、ボトルネックを見つけて改善',
        body: `【機能・エンドポイント】の性能を改善してください：現状【例：10 万件の処理に 40 秒】、目標【例：10 秒以内】。

測定方法：【再現と計測の方法。例：python bench.py --rows 100000】

要件：
- まず基準値を測り、本当のボトルネックを特定してから最適化する
- 最適化後の結果は最適化前と完全に一致すること
- 【その他の制約。例：メモリ使用量を目立って増やさない。なければこの行を削除】

完了条件：
- 同じ測定方法で目標を達成し、前後の数値を記録している
- 既存のテストがすべて通る`,
      },
    },
  },
  {
    id: 'tests',
    i18n: {
      en: {
        name: 'Add tests',
        hint: 'Fill the test gaps and fix the bugs they find',
        body: `Add automated tests for [[module or directory]].

Requirements:
- Use the project's existing test framework; if there is none, use [[pytest / vitest / go test …]]
- Cover the main features, edge cases and error handling
- Fix the bugs the tests uncover; every fix gets its own regression test

Acceptance criteria:
- All tests pass
- [[coverage target, e.g. at least 80% line coverage for the core module]]`,
      },
      zh: {
        name: '补测试',
        hint: '补齐测试，顺手修掉发现的 bug',
        body: `给【模块或目录】补充自动化测试。

要求：
- 用项目现有的测试框架；如果还没有，用【pytest / vitest / go test 等】
- 覆盖主要功能、边界情况和错误处理
- 测试中发现的 bug 一并修复，每个修复都要有对应的回归测试

验收标准：
- 全部测试通过
- 【覆盖率目标，例如：核心模块行覆盖率不低于 80%】`,
      },
      ja: {
        name: 'テスト追加',
        hint: 'テストの穴を埋め、見つかったバグも直す',
        body: `【モジュール・ディレクトリ】に自動テストを追加してください。

要件：
- 既存のテストフレームワークを使う。なければ【pytest / vitest / go test など】
- 主要な機能、境界値、エラー処理をカバーする
- テストで見つかったバグは修正し、修正ごとに回帰テストを付ける

完了条件：
- すべてのテストが通る
- 【カバレッジ目標。例：コアモジュールの行カバレッジ 80% 以上】`,
      },
    },
  },
  {
    id: 'review',
    i18n: {
      en: {
        name: 'Review & fix',
        hint: 'Check the code thoroughly and fix what is wrong',
        body: `Review the code of [[module or the whole project]] thoroughly, find the problems and fix them.

Focus on:
- Correctness: logic errors, edge cases, error handling, concurrency
- Security: input validation, injection, leaking sensitive data
- [[other concerns, e.g. performance, maintainability; delete this line if none]]

Requirements:
- First list the problems (ordered by severity), then fix them one by one
- Every fix has a test or a clear way to verify it
- No large changes unrelated to the problems

Acceptance criteria:
- All critical and major problems on the list are fixed
- All existing tests pass`,
      },
      zh: {
        name: '审查修复',
        hint: '全面检查代码并修复问题',
        body: `全面检查【模块或整个项目】的代码，找出问题并修复。

重点关注：
- 正确性：逻辑错误、边界条件、错误处理、并发问题
- 安全性：输入校验、注入、敏感信息泄露
- 【其他关注点，例如：性能、可维护性；没有就删掉这一行】

要求：
- 先列出问题清单（按严重程度排序），再逐项修复
- 每个修复都有测试或明确的验证方法
- 不做和问题无关的大改动

验收标准：
- 清单里的严重和重要问题全部修复
- 原有测试全部通过`,
      },
      ja: {
        name: 'レビューと修正',
        hint: 'コードを全面的に点検して問題を直す',
        body: `【モジュールまたはプロジェクト全体】のコードを全面的に点検し、問題を見つけて修正してください。

重点：
- 正しさ：ロジックの誤り、境界条件、エラー処理、並行処理
- セキュリティ：入力検証、インジェクション、機密情報の漏えい
- 【その他の観点。例：性能、保守性。なければこの行を削除】

要件：
- まず問題の一覧（重大度順）を作り、それから一つずつ直す
- どの修正にもテストか明確な確認方法がある
- 問題と関係のない大きな変更はしない

完了条件：
- 一覧の重大・重要な問題がすべて修正されている
- 既存のテストがすべて通る`,
      },
    },
  },
  {
    id: 'init',
    i18n: {
      en: { name: 'Write AGENTS.md', hint: 'Analyse the project and document it for agents (/init)', body: INIT_GOAL.en },
      zh: { name: '生成 AGENTS.md', hint: '分析项目，写一份给智能体看的说明（/init）', body: INIT_GOAL.zh },
      ja: { name: 'AGENTS.md 作成', hint: 'プロジェクトを分析しエージェント向けに文書化（/init）', body: INIT_GOAL.ja },
    },
  },
  {
    id: 'deepresearch',
    // snow-cli's /deepresearch as a task: GPT splits the question and checks the sources, WorkBuddy searches and writes
    settings: { codex: { webSearch: true } },
    i18n: {
      en: {
        name: 'Deep research',
        hint: 'Research on the web and write a report with sources',
        body: `Research this question and write a detailed report with sources:
[[the question, e.g. how do the main Rust async runtimes compare for a small web service?]]

Audience and depth: [[e.g. engineers choosing a runtime; technical detail welcome]]

How to research:
- Split the question into 6–10 sub-questions (background, current state, comparison, trade-offs, outlook…) and answer them one by one
- Search in English and in the report's language, from several angles; read 2–3 credible sources per sub-question (official docs, papers, reputable publications) and skip SEO filler
- Back every important claim with at least two independent sources; when sources disagree, say so
- Never invent facts, sources, quotes or image links; mark anything you could not verify as unconfirmed

The report:
- Save it as .wbloop/deepresearch/<topic>-YYYYMMDD-HHmm.md in the working directory
- Sections: summary, background and scope, key findings, detailed analysis, comparison table, trends and outlook, recommendations, open questions and limitations, method, references
- Every non-trivial claim has a Markdown footnote ([^1]) pointing to a real URL in the references
- At least one table and one Mermaid diagram; 2,000 words or more; written in English

Done when the file is saved, every footnote has its source, and the last reply gives the file path, a 2–3 sentence summary and the number of sources.`,
      },
      zh: {
        name: '深度调研',
        hint: '联网查资料，写一份带出处的报告',
        body: `调研下面这个问题，写一份详细、注明出处的报告：
【问题，例如：做一个小型 Web 服务时，主流 Rust 异步运行时各有什么优劣？】

读者与深度：【例如：要做技术选型的工程师，可以深入技术细节】

调研方法：
- 把问题拆成 6–10 个子问题（背景、现状、对比、取舍、前景……），逐个回答
- 用英文和报告所用的语言分别搜索，换几个角度；每个子问题读 2–3 个可信来源（官方文档、论文、可靠媒体），跳过营销软文
- 重要结论至少有两个独立来源互相印证；来源说法不一致时，写明分歧
- 不编造事实、来源、引文或图片链接；无法核实的内容注明“未经证实”

报告要求：
- 保存为工作目录下的 .wbloop/deepresearch/<主题>-YYYYMMDD-HHmm.md
- 章节：摘要、背景与范围、主要发现、详细分析、对比表、趋势与展望、建议、未解决的问题与局限、调研方法、参考资料
- 每条重要论断都有 Markdown 脚注（[^1]），在参考资料里对应真实的网址
- 至少一张表格和一张 Mermaid 图；不少于 3000 字；用中文写

完成标准：文件已保存，每个脚注都有对应来源；最后的回复给出文件路径、两三句话的结论摘要和来源数量。`,
      },
      ja: {
        name: 'ディープリサーチ',
        hint: 'Web で調べて、出典付きのレポートを書く',
        body: `次の問いを調査し、出典付きの詳しいレポートを書いてください：
【調べたい問い。例：小規模な Web サービスを作るとき、主要な Rust 非同期ランタイムにはそれぞれどんな長所と短所があるか？】

読者と深さ：【例：技術選定をするエンジニア向け。技術的な詳細まで踏み込んでよい】

調べ方：
- 問いを 6〜10 個のサブクエスチョン（背景、現状、比較、トレードオフ、今後の見通し…）に分け、1 つずつ答える
- 英語とレポートの言語の両方で、角度を変えて検索する。サブクエスチョンごとに信頼できる情報源（公式ドキュメント、論文、信頼できるメディア）を 2〜3 件読み、宣伝目的の記事は飛ばす
- 重要な主張は独立した 2 つ以上の情報源で裏付ける。情報源の見解が食い違うときはそのことを書く
- 事実・出典・引用・画像リンクを捏造しない。確認できなかったことは「未確認」と明記する

レポート：
- 作業ディレクトリの .wbloop/deepresearch/<テーマ>-YYYYMMDD-HHmm.md に保存する
- 構成：要約、背景と範囲、主な発見、詳細な分析、比較表、動向と見通し、推奨事項、未解決の問いと限界、調査方法、参考文献
- 重要な主張にはすべて Markdown の脚注（[^1]）を付け、参考文献の実在する URL に対応させる
- 表と Mermaid 図を少なくとも 1 つずつ入れる。4000 字以上。日本語で書く

完了条件：ファイルが保存され、すべての脚注に出典があること。最後の返信でファイルのパス、2〜3 文の要約、出典の数を示す。`,
      },
    },
  },
  {
    id: 'security',
    settings: { agents: { mode: 'vuln' } },
    i18n: {
      en: {
        name: 'Security audit',
        hint: 'Vulnerability Hunting mode: find, prove and report',
        body: `Look for vulnerabilities in [[module or directory — one area at a time]].

Focus: [[e.g. input validation and injection / authentication and authorization / both]]
Known concerns: [[anything suspicious you already know; delete this line if none]]

Deliverables:
- Every finding with exact location, evidence, attack scenario and impact
- A safe, runnable verification script for every finding, actually executed
- A report ranked by severity with fix recommendations
- Don't modify the source code (only the vulnerability-hunting folder)`,
      },
      zh: {
        name: '安全审计',
        hint: '漏洞排查模式：找出、验证并出报告',
        body: `排查【模块或目录——一次只看一块】的安全漏洞。

关注点：【例如：输入校验与注入 / 认证与授权 / 两者都要】
已知疑点：【你已经怀疑的地方；没有就删掉这一行】

交付物：
- 每个发现都有精确位置、证据、攻击场景和影响
- 每个发现都有安全、可运行的验证脚本，并且实际运行过
- 一份按严重程度排序、附修复建议的报告
- 不修改源代码（只写漏洞排查目录）`,
      },
      ja: {
        name: 'セキュリティ監査',
        hint: '脆弱性ハンティングモード：発見・実証・報告',
        body: `【モジュール・ディレクトリ（一度に一領域）】の脆弱性を調査してください。

重点：【例：入力検証とインジェクション / 認証・認可 / 両方】
既知の懸念：【怪しいと思っている箇所。なければこの行を削除】

成果物：
- 各指摘に正確な場所、証拠、攻撃シナリオ、影響を記載
- 各指摘に安全で実行可能な検証スクリプトを用意し、実際に実行する
- 重大度順に並べ、修正案を付けたレポート
- ソースコードは変更しない（脆弱性ハンティング用フォルダーのみ書き込む）`,
      },
    },
  },
  {
    id: 'team-docs',
    settings: { team: { mode: 'auto' } },
    i18n: {
      en: {
        name: 'Parallel work',
        hint: 'Team Mode: split independent parts across teammates',
        body: `[[the overall goal, e.g. add English, Chinese and Japanese user documentation for every CLI command]]

Parts that can be done independently (one teammate each):
1. [[part 1 and the files it owns]]
2. [[part 2 and the files it owns]]
3. [[part 3 and the files it owns]]

Shared conventions every part must follow: [[naming, formats, interfaces]]

Acceptance criteria:
- Every part is complete and consistent with the others
- [[how to verify the whole, e.g. npm test and the docs build pass]]`,
      },
      zh: {
        name: '并行协作',
        hint: '团队模式：把互不依赖的部分分给多个队友',
        body: `【总体目标，例如：为每个命令行子命令补充中、英、日三种语言的用户文档】

可以各自独立完成的部分（每部分一个队友）：
1. 【第 1 部分，以及它负责的文件】
2. 【第 2 部分，以及它负责的文件】
3. 【第 3 部分，以及它负责的文件】

各部分都要遵守的共同约定：【命名、格式、接口】

验收标准：
- 每部分都完成，并且彼此一致
- 【整体的验证方法，例如：npm test 和文档构建都通过】`,
      },
      ja: {
        name: '並行作業',
        hint: 'チームモード：独立した部分を複数のメンバーに分担',
        body: `【全体の目標。例：CLI の全サブコマンドに英・中・日のユーザードキュメントを追加する】

独立して進められる部分（それぞれ 1 人のメンバーが担当）：
1. 【部分 1 と担当ファイル】
2. 【部分 2 と担当ファイル】
3. 【部分 3 と担当ファイル】

全員が守る共通ルール：【命名、形式、インターフェース】

完了条件：
- すべての部分が完成し、互いに整合している
- 【全体の検証方法。例：npm test とドキュメントのビルドが通る】`,
      },
    },
  },
];

const MAX_CUSTOM = 50;

function readCustom() {
  const list = readJson(TEMPLATES_PATH, {})?.custom;
  return Array.isArray(list) ? list.filter((x) => x && x.id && x.name && typeof x.body === 'string') : [];
}

export function builtinTemplates(lang = currentLang()) {
  return BUILTIN_TEMPLATES.map((tpl) => ({ id: tpl.id, settings: tpl.settings || null, ...(tpl.i18n[lang] || tpl.i18n.en) }));
}

export function listTemplates(lang = currentLang()) {
  return { builtin: builtinTemplates(lang), custom: readCustom() };
}

/** Saves a custom template; one with the same name is overwritten. */
export function saveTemplate({ name, body }) {
  const n = String(name || '').trim().slice(0, 30);
  const b = String(body || '').trim();
  if (!n) throw new Error(t('srv.tpl.noName'));
  if (!b) throw new Error(t('srv.tpl.empty'));
  if (b.length > 20_000) throw new Error(t('srv.tpl.tooLong'));
  ensureDirs();
  const custom = readCustom();
  const existing = custom.find((x) => x.name === n);
  if (existing) {
    existing.body = b;
    existing.updatedAt = new Date().toISOString();
  } else {
    if (custom.length >= MAX_CUSTOM) throw new Error(t('srv.tpl.tooMany', { n: MAX_CUSTOM }));
    custom.push({ id: crypto.randomBytes(6).toString('hex'), name: n, body: b, updatedAt: new Date().toISOString() });
  }
  writeJsonAtomic(TEMPLATES_PATH, { custom });
  return listTemplates();
}

export function deleteTemplate(id) {
  const custom = readCustom();
  const next = custom.filter((x) => x.id !== id);
  if (next.length === custom.length) throw new Error(t('srv.tpl.notFound'));
  writeJsonAtomic(TEMPLATES_PATH, { custom: next });
  return listTemplates();
}

/** For the CLI: a template by id or name (any language). */
export function findTemplate(key, lang = currentLang()) {
  const builtin = BUILTIN_TEMPLATES.find((x) => x.id === key || Object.values(x.i18n).some((v) => v.name === key));
  if (builtin) return { id: builtin.id, settings: builtin.settings || null, ...(builtin.i18n[lang] || builtin.i18n.en) };
  return readCustom().find((x) => x.id === key || x.name === key) || null;
}

/** Placeholders still to be replaced in a goal: 【…】 or [[…]]. */
export const PLACEHOLDER_RE = /【[^】\n]*】|\[\[[^\]\n]*\]\]/g;
