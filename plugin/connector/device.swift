// claude-bridge-device: this computer's own line to the Claude Bridge relay, one per computer.
//
// Each open Claude Code session has its own connector (connector.swift). This process is the
// computer itself: it keeps the computer reachable while no session is open, and answers what
// only the computer knows, all from Claude Code's own files (no database of its own):
//   projects        the folders Claude Code has worked in, most recent first
//   sessions        a project's recent sessions, from its transcripts (~/.claude/projects)
//   names           what live sessions are called (custom title, desktop title, first prompt)
//   rename_session  appends a `custom-title` row to the transcript, as the Agent SDK does
//   open_session    opens a session where the person works: the Claude desktop app (claude://
//                   links), or a Terminal window running the Claude Code CLI
//   start_session   starts a new session in a project, there too
//   fork_session    a side chat: a new session with a copy of another's whole conversation
//   screenshot      the screen, for show_screen with no session open
//
// launchd runs it (~/Library/LaunchAgents/com.claudebridge.device.plist, installed by the plugin).
// It reads ~/.config/claude-bridge/{key, device.json, config.json} on every connect.

import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

let PROTOCOL = 4
let home = FileManager.default.homeDirectoryForCurrentUser.path
let configDir = "\(home)/.config/claude-bridge"
let projectsRoot = "\(home)/.claude/projects"
let desktopSessionsRoot = "\(home)/Library/Application Support/Claude/claude-code-sessions"

func log(_ line: String) {
  let stamp = ISO8601DateFormatter().string(from: Date())
  print("\(stamp) \(line)")
}

// MARK: - Settings

func readText(_ path: String) -> String? {
  (try? String(contentsOfFile: path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
}

func readJSON(_ path: String) -> [String: Any]? {
  guard let data = FileManager.default.contents(atPath: path) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// This computer's id: made once, shared with the plugin (which writes it the same way).
func deviceId() -> String {
  let path = "\(configDir)/device.json"
  if let id = readJSON(path)?["id"] as? String, !id.isEmpty { return id }
  let id = UUID().uuidString.lowercased()
  try? FileManager.default.createDirectory(atPath: configDir, withIntermediateDirectories: true)
  let data = try? JSONSerialization.data(withJSONObject: ["id": id])
  FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
  return id
}

func computerName() -> String {
  let out = run("/usr/sbin/scutil", ["--get", "ComputerName"], timeout: 5).out.trimmingCharacters(in: .whitespacesAndNewlines)
  return out.isEmpty ? (Host.current().localizedName ?? "Mac") : out
}

// MARK: - Running programs

struct Ran { let status: Int32; let out: String; let timedOut: Bool }

func run(_ path: String, _ args: [String], cwd: String? = nil, env: [String: String] = [:], timeout: TimeInterval) -> Ran {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
  var environment = ProcessInfo.processInfo.environment
  for (k, v) in env { environment[k] = v }
  p.environment = environment
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  p.standardInput = FileHandle.nullDevice
  var collected = Data()
  let lock = NSLock()
  pipe.fileHandleForReading.readabilityHandler = { h in
    let d = h.availableData
    lock.lock(); collected.append(d); lock.unlock()
  }
  do { try p.run() } catch { return Ran(status: -1, out: "\(error)", timedOut: false) }
  let deadline = Date().addingTimeInterval(timeout)
  while p.isRunning && Date() < deadline { usleep(100_000) }
  let timedOut = p.isRunning
  if timedOut { p.terminate() }
  p.waitUntilExit()
  pipe.fileHandleForReading.readabilityHandler = nil
  lock.lock(); collected.append(pipe.fileHandleForReading.readDataToEndOfFile()); lock.unlock()
  return Ran(status: p.terminationStatus, out: String(decoding: collected, as: UTF8.self), timedOut: timedOut)
}

/// The newest Claude Code the desktop app ships, else the one on the PATH.
func claudeBinary() -> String? {
  let root = "\(home)/Library/Application Support/Claude/claude-code"
  let versions = ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [])
    .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
  for v in versions {
    guard let builds = try? FileManager.default.contentsOfDirectory(atPath: "\(root)/\(v)") else { continue }
    for b in builds {
      let path = "\(root)/\(v)/\(b)/claude.app/Contents/MacOS/claude"
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
  }
  let found = run("/bin/zsh", ["-lc", "command -v claude"], timeout: 10).out.trimmingCharacters(in: .whitespacesAndNewlines)
  return found.isEmpty ? nil : found
}

// MARK: - Claude Code's files

/// Claude Code keeps a project's transcripts in a folder named after its path.
func transcriptsDir(_ folder: String) -> String {
  "\(projectsRoot)/\(folder.replacingOccurrences(of: "[^A-Za-z0-9]", with: "-", options: .regularExpression))"
}

let uuidPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
func isUUID(_ s: String) -> Bool { uuidPattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

struct DesktopSession {
  let localId: String
  /// The transcript the session writes to now, then the ones it moved on from (a rewind, a clear).
  let current: String?
  let cliIds: [String]
  let cwd: String
  let title: String?
  let lastActivity: Double
  let archived: Bool
}

var desktopCache: (at: Date, rows: [DesktopSession])?

/// The Claude desktop app's own records of its Code sessions: titles, folders, archive state.
func desktopSessions() -> [DesktopSession] {
  if let c = desktopCache, Date().timeIntervalSince(c.at) < 10 { return c.rows }
  var rows: [DesktopSession] = []
  let fm = FileManager.default
  for a in (try? fm.contentsOfDirectory(atPath: desktopSessionsRoot)) ?? [] {
    for b in (try? fm.contentsOfDirectory(atPath: "\(desktopSessionsRoot)/\(a)")) ?? [] {
      let dir = "\(desktopSessionsRoot)/\(a)/\(b)"
      for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where f.hasPrefix("local_") && f.hasSuffix(".json") {
        guard let d = readJSON("\(dir)/\(f)"), let local = d["sessionId"] as? String else { continue }
        var cli: [String] = []
        if let id = d["cliSessionId"] as? String { cli.append(id) }
        cli += (d["priorCliSessionIds"] as? [String]) ?? []
        rows.append(DesktopSession(
          localId: local, current: d["cliSessionId"] as? String, cliIds: cli, cwd: d["cwd"] as? String ?? "", title: d["title"] as? String,
          lastActivity: d["lastActivityAt"] as? Double ?? 0, archived: d["isArchived"] as? Bool ?? false))
      }
    }
  }
  desktopCache = (Date(), rows)
  return rows
}

func desktopRecord(for id: String) -> DesktopSession? {
  desktopSessions().first { $0.cliIds.contains(id) || $0.localId == "local_\(id)" }
}

func mtime(_ path: String) -> Double {
  ((try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate]) as? Date)?.timeIntervalSince1970 ?? 0
}

/// The latest value of a `"type":"<kind>"` row's `field`, searching the file from its end.
func latestTitle(_ data: Data, kind: String, field: String) -> String? {
  guard let marker = "\"type\":\"\(kind)\"".data(using: .utf8) else { return nil }
  guard let hit = data.range(of: marker, options: .backwards) else { return nil }
  let newline = UInt8(ascii: "\n")
  var start = hit.lowerBound
  while start > data.startIndex && data[start - 1] != newline { start -= 1 }
  var end = hit.upperBound
  while end < data.endIndex && data[end] != newline { end += 1 }
  guard let row = (try? JSONSerialization.jsonObject(with: data[start..<end])) as? [String: Any] else { return nil }
  let value = (row[field] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
  return value?.isEmpty == false ? value : nil
}

/// What the person typed first, skipping the notices Claude Code and the app add as user rows.
func firstPrompt(_ data: Data) -> String? {
  let head = data.prefix(400_000)
  for line in head.split(separator: UInt8(ascii: "\n")).prefix(400) {
    guard let row = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any],
      row["type"] as? String == "user", row["isMeta"] as? Bool != true,
      let message = row["message"] as? [String: Any]
    else { continue }
    var text = ""
    if let s = message["content"] as? String { text = s }
    else if let blocks = message["content"] as? [[String: Any]] {
      if blocks.contains(where: { $0["type"] as? String == "tool_result" }) { continue }
      text = blocks.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: " ")
    }
    text = text.replacingOccurrences(of: "<system-reminder>[\\s\\S]*?</system-reminder>", with: " ", options: .regularExpression)
    text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    if text.isEmpty || text.hasPrefix("<") || text.hasPrefix("[Subagent") || text.hasPrefix("Caveat:") { continue }
    if text.contains("started from the Claude app through Claude Bridge") || text.hasPrefix("## Side chat") { continue }
    return text.count > 70 ? String(text.prefix(69)) + "…" : text
  }
  return nil
}

struct SessionInfo {
  let id: String
  let name: String
  let named: Bool
  let lastActive: Double
  let archived: Bool
  let side: Bool
}

/// A session's name: the one the person gave it (custom title), else the desktop app's title,
/// else Claude Code's own title, else its first prompt.
func sessionInfo(id: String, folder: String) -> SessionInfo? {
  let path = "\(transcriptsDir(folder))/\(id).jsonl"
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped) else { return nil }
  let record = desktopRecord(for: id)
  // The desktop app writes its placeholder title too; it names nothing.
  func meaningful(_ s: String?) -> String? {
    guard let t = s?.trimmingCharacters(in: .whitespaces), !t.isEmpty, t != "New session", t != "Untitled" else { return nil }
    return t
  }
  let custom = meaningful(latestTitle(data, kind: "custom-title", field: "customTitle"))
  let desktopTitle = meaningful(record?.title)
  let first = firstPrompt(data)
  if custom == nil && desktopTitle == nil && first == nil { return nil }  // nothing was ever said
  let name = custom ?? desktopTitle ?? meaningful(latestTitle(data, kind: "ai-title", field: "aiTitle")) ?? first ?? "Untitled"
  return SessionInfo(
    id: id, name: name, named: custom != nil, lastActive: max(mtime(path) * 1000, record?.lastActivity ?? 0),
    archived: record?.archived ?? false, side: (record?.title ?? "").hasPrefix("btw:"))
}

// MARK: - The calls

func projects(limit: Int) -> [[String: Any]] {
  var last: [String: Double] = [:]
  var counts: [String: Int] = [:]
  let fm = FileManager.default
  for dir in (try? fm.contentsOfDirectory(atPath: projectsRoot)) ?? [] {
    let full = "\(projectsRoot)/\(dir)"
    let files = ((try? fm.contentsOfDirectory(atPath: full)) ?? []).filter { $0.hasSuffix(".jsonl") }
    guard let newest = files.max(by: { mtime("\(full)/\($0)") < mtime("\(full)/\($1)") }) else { continue }
    // The folder name is lossy; the transcript says the real path.
    guard let handle = FileHandle(forReadingAtPath: "\(full)/\(newest)") else { continue }
    let head = handle.readData(ofLength: 200_000)
    try? handle.close()
    let text = String(decoding: head, as: UTF8.self)
    guard let r = text.range(of: "\"cwd\":\"([^\"]+)\"", options: .regularExpression) else { continue }
    let folder = String(text[r]).replacingOccurrences(of: "\"cwd\":\"", with: "").dropLast().description
    guard transcriptsDir(folder) == full else { continue }
    last[folder] = max(last[folder] ?? 0, mtime("\(full)/\(newest)") * 1000)
    counts[folder] = files.count
  }
  for d in desktopSessions() where !d.cwd.isEmpty {
    last[d.cwd] = max(last[d.cwd] ?? 0, d.lastActivity)
  }
  var isDir: ObjCBool = false
  return last
    .filter { fm.fileExists(atPath: $0.key, isDirectory: &isDir) && isDir.boolValue && $0.key != home }
    // The desktop app's throwaway scratch folders aren't projects.
    .filter { !$0.key.hasPrefix("\(home)/Library/Application Support/Claude/") }
    .sorted { $0.value > $1.value }
    .prefix(limit)
    .map { ["folder": $0.key, "name": ($0.key as NSString).lastPathComponent, "lastActive": $0.value, "sessions": counts[$0.key] ?? 0] }
}

func sessions(folder: String, limit: Int) -> [[String: Any]] {
  let dir = transcriptsDir(folder)
  let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
    .filter { $0.hasSuffix(".jsonl") && isUUID(String($0.dropLast(6))) }
    .sorted { mtime("\(dir)/\($0)") > mtime("\(dir)/\($1)") }
  var out: [[String: Any]] = []
  for f in files {
    if out.count >= limit { break }
    let id = String(f.dropLast(6))
    // A transcript a desktop session has moved on from is that session's past, not a session.
    if let record = desktopRecord(for: id), record.current != id, record.localId != "local_\(id)" { continue }
    guard let info = sessionInfo(id: id, folder: folder) else { continue }
    var row: [String: Any] = ["id": info.id, "name": info.name, "lastActive": info.lastActive]
    if info.archived { row["archived"] = true }
    if info.side { row["side"] = true }
    out.append(row)
  }
  return out
}

func renameSession(id: String, folder: String, name: String) -> [String: Any] {
  let clean = name.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  guard isUUID(id), !clean.isEmpty, clean.count <= 120 else { return ["error": "Give a name of 1 to 120 characters."] }
  let path = "\(transcriptsDir(folder))/\(id).jsonl"
  guard let handle = FileHandle(forUpdatingAtPath: path) else { return ["error": "That session's transcript isn't on this computer."] }
  defer { try? handle.close() }
  let size = (try? handle.seekToEnd()) ?? 0
  var prefix = Data()
  if size > 0 {
    try? handle.seek(toOffset: size - 1)
    if handle.readData(ofLength: 1) != Data([UInt8(ascii: "\n")]) { prefix = Data([UInt8(ascii: "\n")]) }
  }
  let row: [String: Any] = [
    "type": "custom-title", "customTitle": clean, "sessionId": id,
    "uuid": UUID().uuidString.lowercased(), "timestamp": ISO8601DateFormatter().string(from: Date()),
  ]
  guard let json = try? JSONSerialization.data(withJSONObject: row) else { return ["error": "Couldn't write the name."] }
  _ = try? handle.seekToEnd()
  handle.write(prefix + json + Data([UInt8(ascii: "\n")]))
  return ["renamed": clean]
}

// MARK: Where sessions open

func desktopInstalled() -> Bool {
  ["/Applications/Claude.app", "\(home)/Applications/Claude.app"].contains { FileManager.default.fileExists(atPath: $0) }
}

/// "desktop" or "terminal": the call's choice, else this computer's setting, else the desktop app
/// when it is installed.
func openTarget(_ requested: Any?) -> String {
  if let r = requested as? String, r == "desktop" || r == "terminal" { return r }
  if let c = readJSON("\(configDir)/config.json")?["openIn"] as? String, c == "desktop" || c == "terminal" { return c }
  return desktopInstalled() ? "desktop" : "terminal"
}

/// Whether the Claude Code CLI trusts `folder` (it, or a folder above it): an untrusted folder
/// would stop at the trust question with no one there to answer it.
func cliTrusted(_ folder: String) -> Bool {
  guard let projects = readJSON("\(home)/.claude.json")?["projects"] as? [String: Any] else { return false }
  // The path as given and as resolved: the CLI records whichever it was started with (and
  // standardizing would turn /private/tmp into /tmp, a key it never wrote).
  for start in Set([folder, (folder as NSString).resolvingSymlinksInPath]) {
    var path = start
    while !path.isEmpty {
      if let p = projects[path] as? [String: Any], p["hasTrustDialogAccepted"] as? Bool == true { return true }
      if path == "/" { break }
      path = (path as NSString).deletingLastPathComponent
    }
  }
  return false
}

func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

/// Runs the Claude Code CLI in a new terminal window: a `.command` script opened with `open -a`,
/// which needs no Automation permission. The person's own `claude` when their shell has one,
/// else the one the desktop app ships.
func openInTerminal(folder: String, arguments: [String], app requested: String? = nil) -> [String: Any] {
  guard cliTrusted(folder) else {
    return ["error": "The Claude Code CLI hasn't been trusted in this folder yet, so it would stop at the trust question. Open it once in a terminal on the computer, or use the desktop app."]
  }
  let dir = "\(configDir)/run"
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  // Scripts from earlier runs, a day old or more, go.
  for f in (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [] where Date().timeIntervalSince1970 - mtime("\(dir)/\(f)") > 86_400 {
    try? FileManager.default.removeItem(atPath: "\(dir)/\(f)")
  }
  let args = arguments.map(shellQuote).joined(separator: " ")
  let fallback = claudeBinary().map(shellQuote) ?? "claude"
  let script = """
    #!/bin/zsh -l
    # Opened by Claude Bridge from the Claude app.
    cd \(shellQuote(folder)) || exit 1
    clear
    if command -v claude >/dev/null 2>&1; then exec claude \(args); else exec \(fallback) \(args); fi

    """
  let path = "\(dir)/session-\(UUID().uuidString.prefix(8)).command"
  guard FileManager.default.createFile(atPath: path, contents: Data(script.utf8), attributes: [.posixPermissions: 0o700]) else {
    return ["error": "Couldn't prepare the terminal window."]
  }
  let known = ["Terminal", "iTerm"]
  let app = requested.flatMap { known.contains($0) ? $0 : nil } ?? (readJSON("\(configDir)/config.json")?["terminalApp"] as? String) ?? "Terminal"
  let r = run("/usr/bin/open", ["-a", app, path], timeout: 15)
  return r.status == 0 ? ["opened": "opened in a \(app) window"] : ["error": "\(app) didn't open: \(r.out.prefix(200))"]
}

/// Opens a session where the person works: the desktop app, or the CLI in a terminal window.
/// `--model` and `--effort` for a model and effort level, when they are well formed.
func modelArguments(model: String?, effort: String?) -> [String] {
  var args: [String] = []
  if let model, model.range(of: "^[A-Za-z0-9._\\-\\[\\]]{1,80}$", options: .regularExpression) != nil { args += ["--model", model] }
  if let effort, ["low", "medium", "high", "xhigh", "max"].contains(effort) { args += ["--effort", effort] }
  return args
}

func openSession(id: String, folder: String, target: String, terminalApp: String? = nil, extra: [String] = []) -> [String: Any] {
  guard isUUID(id) else { return ["error": "Not a session id."] }
  if target == "terminal" { return openInTerminal(folder: folder, arguments: ["--resume", id] + extra, app: terminalApp) }
  desktopCache = nil
  let url: String
  let how: String
  if let record = desktopRecord(for: id), !record.archived {
    url = "claude://code/continue?session=\(record.localId)"
    how = "opened in the desktop app"
  } else {
    url = "claude://resume?session=\(id)"
    how = "imported into the desktop app"
  }
  let r = run("/usr/bin/open", [url], timeout: 15)
  return r.status == 0 ? ["opened": how] : ["error": "The desktop app didn't open it: \(r.out.prefix(200))"]
}

let BOOTSTRAP =
  "This session was started from the Claude app through Claude Bridge. Its first request follows in the next message. Reply with only: Ready."

/// A new session in `folder`. In a terminal, the CLI starts it directly under an id chosen here
/// (named with -n). For the desktop app, whose "new session" link only fills its composer,
/// Claude Code makes it with one short turn (headless), then the app imports and opens it.
func startSession(folder: String, name: String?, target: String) -> [String: Any] {
  var isDir: ObjCBool = false
  guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDir), isDir.boolValue else {
    return ["error": "That folder isn't on this computer."]
  }
  guard projects(limit: 500).contains(where: { $0["folder"] as? String == folder }) else {
    return ["error": "Claude Code has never worked in that folder; start the first session there on the computer."]
  }
  guard let claude = claudeBinary() else { return ["error": "Claude Code isn't installed on this computer."] }
  let id = UUID().uuidString.lowercased()
  if target == "terminal" {
    var args = ["--session-id", id]
    if let name, !name.isEmpty { args += ["-n", name] }
    let opened = openInTerminal(folder: folder, arguments: args)
    if let error = opened["error"] { return ["error": error] }
    return ["id": id, "opened": opened["opened"] ?? "opened in a terminal"]
  }
  let r = run(claude, ["-p", "--session-id", id, "--output-format", "json", BOOTSTRAP], cwd: folder,
              env: ["CLAUDE_BRIDGE_BOOTSTRAP": "1"], timeout: 150)
  if r.timedOut { return ["error": "Claude Code took too long to start the session."] }
  guard FileManager.default.fileExists(atPath: "\(transcriptsDir(folder))/\(id).jsonl") else {
    return ["error": "Claude Code didn't start the session: \(r.out.suffix(300))"]
  }
  if let name, !name.isEmpty { _ = renameSession(id: id, folder: folder, name: name) }
  let opened = openSession(id: id, folder: folder, target: "desktop")
  if let error = opened["error"] { return ["id": id, "error": error] }
  return ["id": id, "opened": opened["opened"] ?? "opened in the desktop app"]
}

/// The first message of a side chat the Claude app forks: it tells the side chat what it is, and
/// tells the plugin (and the session list) which session it came from.
func forkNote(parent: String, model: String?, effort: String?) -> String {
  let same = model.map { m in " It runs on \(m)\(effort.map { " at \($0) effort" } ?? ""), as the original does." } ?? ""
  return """
  ## Side chat
  The person forked this session from the Claude app (Claude Bridge) to work on something else while the original session (\(parent)) carries on with its own work.\(same) The side task comes in the next message. Leave the original session's work alone unless the person asks otherwise. Reply with only: Ready.
  """
}

/// A side chat: a new session holding a copy of `id`'s whole conversation, under an id chosen
/// here (`claude --resume <id> --fork-session`), named, then opened where the person works.
/// The original session is only read, so it carries on undisturbed, even mid-turn.
func forkSession(id: String, folder: String, name: String?, target: String, terminalApp: String?, model: String?, effort: String?) -> [String: Any] {
  guard isUUID(id), FileManager.default.fileExists(atPath: "\(transcriptsDir(folder))/\(id).jsonl") else {
    return ["error": "That session's transcript isn't on this computer."]
  }
  guard let claude = claudeBinary() else { return ["error": "Claude Code isn't installed on this computer."] }
  let newId = UUID().uuidString.lowercased()
  // The original's model and effort, never the computer's default (which may cost more).
  let same = modelArguments(model: model, effort: effort)
  let r = run(claude, ["-p", "--resume", id, "--fork-session", "--session-id", newId, "--output-format", "json"] + same + [forkNote(parent: id, model: same.isEmpty ? nil : model, effort: effort)],
              cwd: folder, env: ["CLAUDE_BRIDGE_BOOTSTRAP": "1"], timeout: 150)
  if r.timedOut { return ["error": "Claude Code took too long to fork the session."] }
  guard FileManager.default.fileExists(atPath: "\(transcriptsDir(folder))/\(newId).jsonl") else {
    return ["error": "Claude Code didn't fork the session: \(r.out.suffix(300))"]
  }
  if let name, !name.isEmpty { _ = renameSession(id: newId, folder: folder, name: name) }
  let opened = openSession(id: newId, folder: folder, target: target, terminalApp: terminalApp, extra: same)
  if let error = opened["error"] { return ["id": newId, "error": error] }
  return ["id": newId, "opened": opened["opened"] ?? "opened"]
}

func screenshot() -> [String: Any] {
  if readJSON("\(configDir)/config.json")?["screen"] as? Bool == false {
    return ["error": "Screenshots are turned off on this computer (Claude Bridge panel, setup). The person can turn them on there."]
  }
  let raw = "/tmp/claude-bridge-device-shot.png"
  let jpg = "/tmp/claude-bridge-device-shot.jpg"
  defer { try? FileManager.default.removeItem(atPath: raw); try? FileManager.default.removeItem(atPath: jpg) }
  guard run("/usr/sbin/screencapture", ["-x", "-t", "png", raw], timeout: 20).status == 0 else {
    return ["error": "Couldn't take a screenshot (Screen Recording permission?)."]
  }
  for (size, quality) in [(1280, 70), (1100, 55), (900, 45)] {
    _ = run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "\(quality)", "-Z", "\(size)", raw, "--out", jpg], timeout: 20)
    if let data = FileManager.default.contents(atPath: jpg) {
      let b64 = data.base64EncodedString()
      if b64.count < 450_000 { return ["data": b64, "mimeType": "image/jpeg"] }
    }
  }
  return ["error": "The screenshot was too large."]
}

func handle(_ tool: String, _ args: [String: Any]) -> Any {
  let folder = args["folder"] as? String ?? ""
  switch tool {
  case "projects": return ["projects": projects(limit: min(50, args["limit"] as? Int ?? 25))]
  case "sessions": return ["sessions": sessions(folder: folder, limit: min(15, args["limit"] as? Int ?? 15))]
  case "names":
    var names: [String: String] = [:]
    for item in args["sessions"] as? [[String: Any]] ?? [] {
      guard let id = item["id"] as? String, let f = item["folder"] as? String else { continue }
      if let info = sessionInfo(id: id, folder: f) { names[id] = info.name }
    }
    return ["names": names]
  case "rename_session": return renameSession(id: args["id"] as? String ?? "", folder: folder, name: args["name"] as? String ?? "")
  case "open_session": return openSession(id: args["id"] as? String ?? "", folder: folder, target: openTarget(args["open_in"]))
  case "start_session": return startSession(folder: folder, name: args["name"] as? String, target: openTarget(args["open_in"]))
  case "fork_session":
    return forkSession(
      id: args["id"] as? String ?? "", folder: folder, name: args["name"] as? String, target: openTarget(args["open_in"]),
      terminalApp: args["terminal_app"] as? String, model: args["model"] as? String, effort: args["effort"] as? String)
  case "screenshot": return screenshot()
  default: return ["error": "This computer's Claude Bridge doesn't know \(tool); update the plugin."]
  }
}

// MARK: - The relay

final class Device: NSObject, URLSessionWebSocketDelegate {
  private let q = DispatchQueue(label: "claude-bridge.device")
  private let work = DispatchQueue(label: "claude-bridge.device.work", attributes: .concurrent)
  private var session: URLSession!
  private var task: URLSessionWebSocketTask?
  private var generation = 0
  private var attempts = 0
  private var pinger: DispatchSourceTimer?

  override init() {
    super.init()
    session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
  }

  func connect() {
    q.async { self.open() }
  }

  private func open() {
    generation += 1
    let current = generation
    pinger?.cancel()
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    guard let key = readText("\(configDir)/key"), !key.isEmpty else {
      log("no key yet; waiting")
      return retry(current)
    }
    let config = readJSON("\(configDir)/config.json") ?? [:]
    guard let chatUrl = config["chatUrl"] as? String, let url = URL(string: "\(chatUrl)/chat/connect") else {
      log("no relay configured yet; waiting")
      return retry(current)
    }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    let socket = session.webSocketTask(with: request)
    socket.maximumMessageSize = 16 * 1024 * 1024
    task = socket
    socket.resume()
    send([
      "type": "hello", "role": "device", "protocol": PROTOCOL, "device": deviceId(), "name": computerName(),
      "host": ProcessInfo.processInfo.hostName,
    ])
    receive(socket, current)
    pinger?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: q)
    timer.schedule(deadline: .now() + 30, repeating: 30)
    timer.setEventHandler { [weak self] in self?.send(["type": "ping"]) }
    timer.resume()
    pinger = timer
  }

  private func retry(_ current: Int) {
    attempts += 1
    let delay = min(30.0, pow(2.0, Double(min(attempts, 5))) / 2)
    q.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, self.generation == current else { return }
      self.open()
    }
  }

  private func receive(_ socket: URLSessionWebSocketTask, _ current: Int) {
    socket.receive { [weak self] result in
      guard let self else { return }
      self.q.async {
        guard self.generation == current else { return }
        switch result {
        case .failure(let error):
          log("connection dropped (\(error.localizedDescription))")
          self.pinger?.cancel()
          self.retry(current)
        case .success(let message):
          if case .string(let text) = message { self.received(text) }
          self.receive(socket, current)
        }
      }
    }
  }

  private func received(_ text: String) {
    guard let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
    switch json["type"] as? String {
    case "welcome":
      attempts = 0
      log("connected")
    case "call":
      guard let id = json["id"] else { return }
      let tool = json["tool"] as? String ?? ""
      let args = json["args"] as? [String: Any] ?? [:]
      log("call \(tool)")
      work.async {
        let result = handle(tool, args)
        self.q.async { self.send(["type": "result", "id": id, "result": result]) }
      }
    case "error":
      log("relay: \(json["message"] as? String ?? "")")
    default:
      break
    }
  }

  private func send(_ message: [String: Any]) {
    guard let task, let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
  }
}

// `claude-bridge-device --call <tool> '<json args>'` answers one call and exits: for checking it by hand.
if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--call" {
  let args = (try? JSONSerialization.jsonObject(with: Data((CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "{}").utf8))) as? [String: Any] ?? [:]
  let out = handle(CommandLine.arguments[2], args)
  if let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
  exit(0)
}

log("starting, device \(deviceId())")
let device = Device()
device.connect()
// Picks up a new key or relay without a restart: reconnects when the files change.
var seen = (readText("\(configDir)/key") ?? "") + (readText("\(configDir)/config.json") ?? "")
let watcher = DispatchSource.makeTimerSource(queue: .main)
watcher.schedule(deadline: .now() + 10, repeating: 10)
watcher.setEventHandler {
  let now = (readText("\(configDir)/key") ?? "") + (readText("\(configDir)/config.json") ?? "")
  if now != seen {
    seen = now
    log("settings changed; reconnecting")
    device.connect()
  }
}
watcher.resume()
dispatchMain()
