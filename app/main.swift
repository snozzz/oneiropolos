import Cocoa
@preconcurrency import WebKit

// Oneiropolos (守梦人 · 夢守) desktop shell: starts the local Node service (wbloop serve) and shows it in a WKWebView.
// Tasks run in separate background runner processes, so quitting the app does not stop them.

/// The strip under the transparent title bar: the web page covers the title bar, so dragging the window and
/// double-click-to-zoom are handled by this native view.
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            // follow the system setting: double-click zooms / minimizes / does nothing
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" {
                window?.performMiniaturize(nil)
            } else if action != "None" {
                window?.performZoom(nil)
            }
            return
        }
        window?.performDrag(with: event)
    }
}

/// The shell's own words in the three interface languages; the web page has its own dictionaries.
enum L10n {
    static let names = ["en": "Oneiropolos", "zh": "守梦人", "ja": "夢守"]

    static let strings: [String: [String: String]] = [
        "en": [
            "waking": "Waking up…",
            "restartLoop": "The local service keeps exiting",
            "restartLoopDetail": "Automatic restarts stopped. Log: %@. Background tasks are not affected; quit and reopen the app.",
            "noFiles": "Program files not found",
            "noFilesDetail": "Run app/build-app.sh again to rebuild the app.",
            "noNode": "Node.js not found",
            "noNodeDetail": "Install Node.js 20 or later (e.g. brew install node), or install WorkBuddy.",
            "notStarted": "The local service did not start",
            "notStartedDetail": "Exit code %@. Log: %@",
            "launchFailed": "Could not start",
            "timeout": "Starting took too long",
            "timeoutDetail": "Log: %@",
            "ok": "OK", "cancel": "Cancel",
            "choose": "Choose", "chooseDir": "Choose WorkBuddy's working directory",
            "about": "About %@", "settings": "Settings…", "hide": "Hide %@", "hideOthers": "Hide Others",
            "quit": "Quit %@ (background tasks keep running)",
            "file": "File", "newTask": "New Task", "palette": "Search & Commands…", "closeWindow": "Close Window",
            "edit": "Edit", "undo": "Undo", "redo": "Redo", "cut": "Cut", "copy": "Copy", "paste": "Paste", "selectAll": "Select All",
            "view": "View", "reload": "Reload", "openInBrowser": "Open in Browser", "openData": "Open Data Folder (~/.wbloop)",
            "window": "Window", "minimize": "Minimize", "zoom": "Zoom",
            "help": "Help", "userGuide": "%@ Help",
            "aboutCredits": "Homer's \"one who deals with dreams\". You take a nap; it keeps watch over the dream:\nGPT plans and audits, WorkBuddy does the work.",
        ],
        "zh": [
            "waking": "正在醒来…",
            "restartLoop": "本地服务反复退出",
            "restartLoopDetail": "已停止自动重启。日志：%@。后台任务不受影响，可退出后重新打开 App。",
            "noFiles": "找不到程序文件",
            "noFilesDetail": "请重新运行 app/build-app.sh 构建。",
            "noNode": "找不到 Node.js",
            "noNodeDetail": "请安装 Node.js 20 以上版本（例如 brew install node），或安装 WorkBuddy。",
            "notStarted": "本地服务没能启动",
            "notStartedDetail": "退出码 %@。日志：%@",
            "launchFailed": "启动失败",
            "timeout": "启动超时",
            "timeoutDetail": "日志：%@",
            "ok": "确定", "cancel": "取消",
            "choose": "选择", "chooseDir": "选择 WorkBuddy 的工作目录",
            "about": "关于%@", "settings": "设置…", "hide": "隐藏%@", "hideOthers": "隐藏其他",
            "quit": "退出%@（后台任务继续运行）",
            "file": "文件", "newTask": "新任务", "palette": "搜索与命令…", "closeWindow": "关闭窗口",
            "edit": "编辑", "undo": "撤销", "redo": "重做", "cut": "剪切", "copy": "拷贝", "paste": "粘贴", "selectAll": "全选",
            "view": "显示", "reload": "刷新", "openInBrowser": "在浏览器中打开", "openData": "打开数据目录（~/.wbloop）",
            "window": "窗口", "minimize": "最小化", "zoom": "缩放",
            "help": "帮助", "userGuide": "使用说明",
            "aboutCredits": "荷马史诗里“与梦打交道的人”。你打个盹，它替你照看这场梦：\nGPT 规划与审计，WorkBuddy 动手执行。",
        ],
        "ja": [
            "waking": "目覚めています…",
            "restartLoop": "ローカルサービスが繰り返し終了しています",
            "restartLoopDetail": "自動再起動を停止しました。ログ：%@。バックグラウンドのタスクには影響しません。アプリを終了して開き直してください。",
            "noFiles": "プログラムファイルが見つかりません",
            "noFilesDetail": "app/build-app.sh をもう一度実行してアプリを作り直してください。",
            "noNode": "Node.js が見つかりません",
            "noNodeDetail": "Node.js 20 以降（例：brew install node）または WorkBuddy をインストールしてください。",
            "notStarted": "ローカルサービスを起動できませんでした",
            "notStartedDetail": "終了コード %@。ログ：%@",
            "launchFailed": "起動できませんでした",
            "timeout": "起動に時間がかかりすぎています",
            "timeoutDetail": "ログ：%@",
            "ok": "OK", "cancel": "キャンセル",
            "choose": "選択", "chooseDir": "WorkBuddy の作業ディレクトリを選択",
            "about": "%@について", "settings": "設定…", "hide": "%@を隠す", "hideOthers": "ほかを隠す",
            "quit": "%@を終了（バックグラウンドのタスクは続行）",
            "file": "ファイル", "newTask": "新しいタスク", "palette": "検索とコマンド…", "closeWindow": "ウインドウを閉じる",
            "edit": "編集", "undo": "取り消す", "redo": "やり直す", "cut": "カット", "copy": "コピー", "paste": "ペースト", "selectAll": "すべてを選択",
            "view": "表示", "reload": "再読み込み", "openInBrowser": "ブラウザで開く", "openData": "データフォルダを開く（~/.wbloop）",
            "window": "ウインドウ", "minimize": "しまう", "zoom": "拡大/縮小",
            "help": "ヘルプ", "userGuide": "%@ ヘルプ",
            "aboutCredits": "ホメロスの叙事詩にある「夢を扱う者」。あなたがひと眠りする間、この夢を見守ります：\nGPT が計画と監査を、WorkBuddy が実作業を。",
        ],
    ]

    static func normalize(_ value: String?) -> String {
        let s = (value ?? "").lowercased()
        if s.hasPrefix("zh") { return "zh" }
        if s.hasPrefix("ja") { return "ja" }
        return "en"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var dragStrip: DragStrip!
    private var server: Process?
    private var serverURL: URL?
    private var stdoutBuffer = Data()
    private var launchFinished = false
    private var terminating = false
    private var healthFailures = 0
    private var restarts: [Date] = []
    private var healthTimer: Timer?

    private let stripHeight: CGFloat = 30
    private let home = FileManager.default.homeDirectoryForCurrentUser.path
    private lazy var dataDir: String = {
        if let custom = ProcessInfo.processInfo.environment["WBLOOP_HOME"], !custom.isEmpty { return custom }
        return home + "/.wbloop"
    }()
    private lazy var logPath = dataDir + "/logs/app-server.log"

    /// Interface language: ui.language in config.json (the web settings write it), WBLOOP_LANG overrides; default English.
    private lazy var lang: String = {
        if let env = ProcessInfo.processInfo.environment["WBLOOP_LANG"], !env.isEmpty { return L10n.normalize(env) }
        if let data = FileManager.default.contents(atPath: dataDir + "/config.json"),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let ui = obj["ui"] as? [String: Any], let value = ui["language"] as? String {
            return L10n.normalize(value)
        }
        return "en"
    }()

    private var appName: String { L10n.names[lang] ?? "Oneiropolos" }

    private func tr(_ key: String, _ args: String...) -> String {
        let s = L10n.strings[lang]?[key] ?? L10n.strings["en"]?[key] ?? key
        var out = s
        for a in args {
            if let r = out.range(of: "%@") { out.replaceSubrange(r, with: a) }
        }
        return out
    }

    // MARK: - lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        createWindow()
        showMessage(title: tr("waking"), detail: "")
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        healthTimer?.invalidate()
        if let p = server, p.isRunning { p.terminate() }
    }

    // when the local service dies unexpectedly (killed, crashed), restart it and reload; background tasks are unaffected
    private func startHealthCheck() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
    }

    private func checkHealth() {
        guard launchFinished, !terminating, let base = serverURL,
              let url = URL(string: "api/health", relativeTo: base) else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self, !self.terminating else { return }
                if response is HTTPURLResponse {
                    self.healthFailures = 0
                    return
                }
                self.healthFailures += 1
                if self.healthFailures >= 2 { self.restartServer() }
            }
        }.resume()
    }

    private func restartServer() {
        let now = Date()
        restarts = restarts.filter { now.timeIntervalSince($0) < 120 } + [now]
        healthFailures = 0
        if restarts.count > 3 {
            healthTimer?.invalidate()
            showMessage(title: tr("restartLoop"), detail: tr("restartLoopDetail", logPath))
            return
        }
        if let p = server, p.isRunning { p.terminate() }
        server = nil
        launchFinished = false
        stdoutBuffer = Data()
        startServer()
    }

    // MARK: - paths

    private func resolveRoot() -> String? {
        let fm = FileManager.default
        if let configured = Bundle.main.object(forInfoDictionaryKey: "WBLoopRoot") as? String,
           fm.fileExists(atPath: configured + "/bin/wbloop.js") {
            return configured
        }
        if let res = Bundle.main.resourcePath, fm.fileExists(atPath: res + "/wbloop/bin/wbloop.js") {
            return res + "/wbloop"
        }
        return nil
    }

    /// Returns (executable, needs ELECTRON_RUN_AS_NODE)
    private func resolveNode() -> (String, Bool)? {
        let fm = FileManager.default
        var candidates: [String] = []
        if let configured = Bundle.main.object(forInfoDictionaryKey: "WBLoopNode") as? String, !configured.isEmpty {
            candidates.append(configured)
        }
        let nvm = home + "/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            let sorted = versions.sorted { a, b in a.compare(b, options: .numeric) == .orderedDescending }
            candidates += sorted.map { "\(nvm)/\($0)/bin/node" }
        }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", home + "/.volta/bin/node"]
        for c in candidates where fm.isExecutableFile(atPath: c) { return (c, false) }
        // fallback: WorkBuddy's bundled Electron works as Node
        let electron = "/Applications/WorkBuddy.app/Contents/MacOS/Electron"
        if fm.isExecutableFile(atPath: electron) { return (electron, true) }
        return nil
    }

    // MARK: - server

    private func startServer() {
        guard let root = resolveRoot() else {
            showMessage(title: tr("noFiles"), detail: tr("noFilesDetail"))
            return
        }
        guard let (node, isElectron) = resolveNode() else {
            showMessage(title: tr("noNode"), detail: tr("noNodeDetail"))
            return
        }
        try? FileManager.default.createDirectory(atPath: dataDir + "/logs", withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let log = FileHandle(forWritingAtPath: logPath)
        log?.seekToEndOfFile()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [root + "/bin/wbloop.js", "serve", "--json-ready"]
        p.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = ProcessInfo.processInfo.environment
        let nodeDir = (node as NSString).deletingLastPathComponent
        env["PATH"] = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", env["PATH"] ?? ""].joined(separator: ":")
        if isElectron { env["ELECTRON_RUN_AS_NODE"] = "1" }
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = log ?? FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { return }
            log?.write(data)
            DispatchQueue.main.async { self?.consumeStdout(data) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self else { return }
                if !self.launchFinished {
                    self.showMessage(title: self.tr("notStarted"), detail: self.tr("notStartedDetail", String(proc.terminationStatus), self.logPath))
                }
            }
        }
        do {
            try p.run()
            server = p
        } catch {
            showMessage(title: tr("launchFailed"), detail: error.localizedDescription)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self, !self.launchFinished else { return }
            self.showMessage(title: self.tr("timeout"), detail: self.tr("timeoutDetail", self.logPath))
        }
    }

    private func consumeStdout(_ data: Data) {
        stdoutBuffer.append(data)
        while let nl = stdoutBuffer.firstIndex(of: 0x0A) {
            let line = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<nl)
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...nl)
            guard !launchFinished,
                  let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  (obj["ready"] as? Bool) == true,
                  let urlString = obj["url"] as? String,
                  let url = URL(string: urlString) else { continue }
            launchFinished = true
            serverURL = url
            startHealthCheck()
            if (obj["reused"] as? Bool) == true { server = nil } // reusing a service that is already running; not ours to stop
            webView.load(URLRequest(url: url))
        }
    }

    // MARK: - window & web view

    private func createWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "wbloop")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = appName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 900, height: 600)
        window.delegate = self

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 1360, height: 880))
        webView.frame = container.bounds
        container.addSubview(webView)
        dragStrip = DragStrip(frame: NSRect(x: 0, y: container.bounds.height - stripHeight, width: container.bounds.width, height: stripHeight))
        dragStrip.autoresizingMask = [.width, .minYMargin]
        container.addSubview(dragStrip)
        window.contentView = container

        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("WBLoopMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // no traffic lights in full screen, so the strip isn't needed either
    func windowDidEnterFullScreen(_ notification: Notification) {
        dragStrip.isHidden = true
        webView.evaluateJavaScript("document.documentElement.classList.add('fullscreen')")
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        dragStrip.isHidden = false
        webView.evaluateJavaScript("document.documentElement.classList.remove('fullscreen')")
    }

    private func showMessage(title: String, detail: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let titleFont = lang == "en" ? "500 23px 'Iowan Old Style',Georgia,serif" : lang == "ja" ? "600 22px 'Hiragino Mincho ProN',serif" : "600 22px 'Songti SC',serif"
        let spacing = lang == "en" ? ".04em" : ".3em"
        let sub = lang == "en" ? "ὀνειροπόλος" : "ONEIROPOLOS"
        let html = """
        <html lang="\(lang)"><head><meta charset="utf-8"><style>
        body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;
        font:14px -apple-system,"PingFang SC","Hiragino Sans",sans-serif;color:#28251f;background:#f6f3ec;-webkit-user-select:none}
        @media (prefers-color-scheme: dark){body{color:#e2ddd0;background:#14151c}}
        .moon{width:30px;height:30px;color:#9a7a44;animation:b 2.6s ease-in-out infinite}
        @media (prefers-color-scheme: dark){.moon{color:#c9a86a}}
        @keyframes b{50%{opacity:.35;transform:scale(.88)}}
        h1{font:\(titleFont);letter-spacing:\(spacing);margin:16px 0 4px}
        .la{font:10px Optima,sans-serif;letter-spacing:.34em;color:#8f8779}
        .t{margin-top:26px;font-size:14px}
        p{color:#8f8779;font-size:12.5px;max-width:560px;text-align:center;line-height:1.7}
        </style></head><body>
        <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M15.6 4A8.3 8.3 0 1 0 20.1 15.6 6.8 6.8 0 0 1 15.6 4z"/></svg>
        <h1>\(esc(appName))</h1><div class="la">\(sub)</div>
        <div class="t">\(esc(title))</div><p>\(esc(detail))</p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url else { return true }
        if url.scheme == "about" || url.scheme == "data" { return true }
        return url.host == "127.0.0.1" || url.host == "localhost"
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, !isLocal(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if window.styleMask.contains(.fullScreen) {
            webView.evaluateJavaScript("document.documentElement.classList.add('fullscreen')")
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: tr("ok"))
        alert.addButton(withTitle: tr("cancel"))
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: tr("ok"))
        alert.runModal()
        completionHandler()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = serverURL { webView.load(URLRequest(url: url)) }
    }

    // MARK: - JS bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "pickFolder":
            let id = body["id"] as? String ?? ""
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = tr("choose")
            panel.message = tr("chooseDir")
            if let start = body["start"] as? String, !start.isEmpty {
                panel.directoryURL = URL(fileURLWithPath: start)
            }
            panel.beginSheetModal(for: window) { [weak self] response in
                let path = response == .OK ? panel.url?.path : nil
                let arg: String
                if let path, let data = try? JSONSerialization.data(withJSONObject: [path]),
                   let json = String(data: data, encoding: .utf8) {
                    arg = String(json.dropFirst().dropLast())
                } else {
                    arg = "null"
                }
                self?.webView.evaluateJavaScript("window.__wbloopNative.resolve(\(Self.jsString(id)), \(arg))")
            }
        case "open":
            if let s = body["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
        case "theme":
            // a light/dark choice in the interface also sets the window's appearance; "system" hands it back
            switch body["value"] as? String {
            case "light": window.appearance = NSAppearance(named: .aqua)
            case "dark": window.appearance = NSAppearance(named: .darkAqua)
            default: window.appearance = nil
            }
        case "language":
            // the page reports its language on every load and when it is changed in Settings
            let next = L10n.normalize(body["value"] as? String)
            if next != lang {
                lang = next
                window.title = appName
                buildMenu()
            }
        default:
            break
        }
    }

    private static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
    }

    // MARK: - menu

    /// Menu commands are handled by the page (new task, command palette, settings, help)
    private func pageCommand(_ name: String) {
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("window.__wbloopApp && window.__wbloopApp.command(\(Self.jsString(name)))")
    }

    @objc private func newTask() { pageCommand("new") }
    @objc private func openPalette() { pageCommand("palette") }
    @objc private func openSettings() { pageCommand("settings") }
    @objc private func openHelp() { pageCommand("help") }

    @objc private func reload() {
        if let url = serverURL { webView.load(URLRequest(url: url)) } else { webView.reload() }
    }

    @objc private func openInBrowser() {
        if let url = webView.url, isLocal(url), url.scheme == "http" { NSWorkspace.shared.open(url) }
    }

    @objc private func openDataFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: dataDir))
    }

    @objc private func showAbout() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let credits = NSMutableAttributedString()
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        para.lineSpacing = 3
        let body: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: para]
        credits.append(NSAttributedString(string: "Oneiropolos · ὀνειροπόλος\n", attributes: [.font: NSFont(name: "Optima", size: 12) ?? NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor, .paragraphStyle: para]))
        credits.append(NSAttributedString(string: tr("aboutCredits"), attributes: body))
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: appName,
            .applicationVersion: version,
            .version: "",
            .credits: credits,
        ])
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: tr("about", appName), action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: tr("settings"), action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: tr("hide", appName), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: tr("hideOthers"), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: tr("quit", appName), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let file = NSMenu(title: tr("file"))
        file.addItem(withTitle: tr("newTask"), action: #selector(newTask), keyEquivalent: "n")
        file.addItem(withTitle: tr("palette"), action: #selector(openPalette), keyEquivalent: "k")
        file.addItem(.separator())
        file.addItem(withTitle: tr("closeWindow"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: tr("edit"))
        edit.addItem(withTitle: tr("undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: tr("redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: tr("cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: tr("copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: tr("paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: tr("selectAll"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: tr("view"))
        view.addItem(withTitle: tr("reload"), action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: tr("openInBrowser"), action: #selector(openInBrowser), keyEquivalent: "")
        view.addItem(withTitle: tr("openData"), action: #selector(openDataFolder), keyEquivalent: "")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: tr("window"))
        win.addItem(withTitle: tr("minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: tr("zoom"), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        main.addItem(windowItem)
        NSApp.windowsMenu = win

        let helpItem = NSMenuItem()
        let help = NSMenu(title: tr("help"))
        help.addItem(withTitle: tr("userGuide", appName), action: #selector(openHelp), keyEquivalent: "/")
        helpItem.submenu = help
        main.addItem(helpItem)
        NSApp.helpMenu = help

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
