// claude-bridge-connector: one Claude Code session's connection to the Claude Bridge relay.
//
// The plugin starts it, writes its settings as one JSON object on stdin, reads events as JSON
// lines on stdout, and sends commands as HTTP POSTs over a Unix socket. It holds a WebSocket
// to the relay: the Claude app's tool calls come down it, and the plugin's answers go back up.

import Foundation

signal(SIGPIPE, SIG_IGN)

// MARK: - Events out

let outLock = NSLock()

func emit(_ event: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
  var bytes = [UInt8](data)
  bytes.append(0x0A)
  outLock.lock()
  defer { outLock.unlock() }
  var offset = 0
  while offset < bytes.count {
    let written = bytes[offset...].withUnsafeBytes { write(1, $0.baseAddress, $0.count) }
    if written < 0 {
      if errno == EINTR { continue }
      exit(0)  // the mod is gone
    }
    offset += written
  }
}

func log(_ message: String) { emit(["t": "log", "message": message]) }

func fail(_ message: String, code: String) -> Never {
  emit(["t": "error", "message": message, "code": code, "fatal": true])
  exit(1)
}

// MARK: - Settings

let settings: [String: Any] = {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  if let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { return json }
  fail("The connector got no settings.", code: "settings")
}()

let socketPath = settings["socketPath"] as? String ?? "/tmp/claude-bridge.sock"

// MARK: - The one queue all state lives on

let q = DispatchQueue(label: "claude-bridge.state")

// MARK: - Answers to Claude Code's questions

/// Answers keyed by question id. The plugin's hook long-polls `/wait_answer`
/// (its time waiting on a call does not count against its budget) while the
/// answer comes in through `/answer`, from the Claude app's answer_question or a press in the panel.
final class Mailbox {
  private var answers: [String: Any] = [:]
  private let condition = NSCondition()

  func put(_ id: String, _ value: Any) {
    condition.lock()
    answers[id] = value
    condition.broadcast()
    condition.unlock()
  }

  func wait(_ id: String, seconds: Double) -> Any? {
    let deadline = Date().addingTimeInterval(seconds)
    condition.lock()
    defer { condition.unlock() }
    while answers[id] == nil {
      if !condition.wait(until: deadline) { break }
    }
    return answers.removeValue(forKey: id)
  }
}

let mailbox = Mailbox()

// MARK: - Commands in, over a Unix socket

final class CommandServer {
  let path: String
  let handler: (String, [String: Any]) -> [String: Any]
  private var fd: Int32 = -1

  init(path: String, handler: @escaping (String, [String: Any]) -> [String: Any]) {
    self.path = path
    self.handler = handler
  }

  func start() throws {
    unlink(path)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      for (i, b) in bytes.enumerated() { raw[i] = b }
      raw[bytes.count] = 0
    }
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    chmod(path, 0o600)
    guard listen(fd, 16) == 0 else { throw POSIXError(.EIO) }
    let listener = fd
    Thread {
      while true {
        let client = accept(listener, nil, nil)
        if client < 0 {
          if errno == EINTR { continue }
          return
        }
        DispatchQueue.global().async { self.serve(client) }
      }
    }.start()
  }

  private func serve(_ client: Int32) {
    defer { close(client) }
    var noSigPipe: Int32 = 1
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var buffer = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 65536)
    var headerEnd: Int?
    var contentLength = 0
    while true {
      let n = read(client, &chunk, chunk.count)
      if n <= 0 { break }
      buffer.append(contentsOf: chunk[0..<n])
      if headerEnd == nil, let end = findHeaderEnd(buffer) {
        headerEnd = end
        let head = String(decoding: buffer[0..<end], as: UTF8.self)
        for line in head.split(separator: "\r\n") {
          let parts = line.split(separator: ":", maxSplits: 1)
          if parts.count == 2, parts[0].lowercased() == "content-length" {
            contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
          }
        }
      }
      if let end = headerEnd, buffer.count >= end + 4 + contentLength { break }
    }
    guard let end = headerEnd else { return }
    let head = String(decoding: buffer[0..<end], as: UTF8.self)
    let requestLine = head.split(separator: "\r\n").first.map(String.init) ?? ""
    let route = requestLine.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
    let bodyBytes = Array(buffer[(end + 4)...].prefix(contentLength))
    let body = (try? JSONSerialization.jsonObject(with: Data(bodyBytes))) as? [String: Any] ?? [:]
    let result = handler(route, body)
    let data = (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{}".utf8)
    let response =
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n"
    var out = [UInt8](response.utf8)
    out.append(contentsOf: data)
    var offset = 0
    while offset < out.count {
      let n = out[offset...].withUnsafeBytes { write(client, $0.baseAddress, $0.count) }
      if n <= 0 { break }
      offset += n
    }
  }

  private func findHeaderEnd(_ bytes: [UInt8]) -> Int? {
    guard bytes.count >= 4 else { return nil }
    for i in 0...(bytes.count - 4)
    where bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10 {
      return i
    }
    return nil
  }

  func stop() {
    if fd >= 0 { close(fd) }
    unlink(path)
  }
}

// MARK: - The relay

/// This chat's line to the relay: a WebSocket kept open (with pings and reconnects), tool
/// calls from the Claude app passed to the plugin as `tool` events, and the plugin's answers
/// sent back as MCP tool results.
final class BridgeClient: NSObject, URLSessionWebSocketDelegate {
  private let url: URL
  private let key: String
  private let session: String
  private let project: String
  private let folder: String
  /** The chat's last status, sent again after a reconnect. */
  private var lastState: [String: Any]?
  /// Events made while disconnected, sent once the relay is back (oldest first, at most 20).
  private var unsent: [[String: Any]] = []
  private var urlSession: URLSession!
  private var task: URLSessionWebSocketTask?
  private var generation = 0
  private var attempts = 0
  private var pinger: DispatchSourceTimer?
  private(set) var isConnected = false
  /// Whether the Claude app watches this chat (the relay keeps the list).
  private(set) var isWatched = false
  /// The person paused Claude Bridge (from any session): the relay refuses the Claude app's calls.
  private(set) var isPaused = false
  /// Relay request ids by the id the mod sees.
  private var calls: [String: Int] = [:]
  private var counter = 0

  init(url: URL, key: String, session: String, project: String, folder: String) {
    self.url = url
    self.key = key
    self.session = session
    self.project = project
    self.folder = folder
    super.init()
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    urlSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  /// On `q`.
  func connect() {
    generation += 1
    let current = generation
    isConnected = false
    var request = URLRequest(url: url)
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    let socket = urlSession.webSocketTask(with: request)
    task?.cancel(with: .goingAway, reason: nil)
    task = socket
    socket.resume()
    report("connecting")
    send(
      ["type": "hello", "protocol": 4, "session": session, "project": project, "folder": folder, "device": settings["device"] as? String ?? ""],
      on: socket)
    receive(socket, current)
    startPinging()
  }

  private func startPinging() {
    pinger?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: q)
    timer.schedule(deadline: .now() + 30, repeating: 30)
    timer.setEventHandler { [weak self] in
      guard let self, let task = self.task else { return }
      self.send(["type": "ping"], on: task)
    }
    timer.resume()
    pinger = timer
  }

  private func receive(_ socket: URLSessionWebSocketTask, _ current: Int) {
    socket.receive { [weak self] result in
      q.async {
        guard let self, current == self.generation else { return }
        switch result {
        case .success(let message):
          var data: Data?
          switch message {
          case .data(let d): data = d
          case .string(let s): data = s.data(using: .utf8)
          @unknown default: data = nil
          }
          if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            self.handle(json)
          }
          self.receive(socket, current)
        case .failure(let error):
          self.dropped(error.localizedDescription)
        }
      }
    }
  }

  private func handle(_ json: [String: Any]) {
    switch json["type"] as? String {
    case "welcome":
      isConnected = true
      attempts = 0
      isWatched = json["watched"] as? Bool ?? false
      isPaused = json["paused"] as? Bool ?? false
      report("connected")
      if let lastState, let task { send(lastState, on: task) }
      if let task {
        for event in unsent { send(event, on: task) }
      }
      unsent.removeAll()
    case "watched":
      isWatched = json["watched"] as? Bool ?? false
      report("connected")
    case "paused":
      isPaused = json["paused"] as? Bool ?? false
      report("connected")
    case "call":
      guard let relayId = json["id"] as? Int, let tool = json["tool"] as? String else { return }
      counter += 1
      let id = "b\(counter)"
      calls[id] = relayId
      emit(["t": "tool", "id": id, "name": tool, "args": json["args"] as? [String: Any] ?? [:]])
    case "error":
      emit(["t": "error", "message": json["message"] as? String ?? "Claude Bridge refused the connection.", "code": "bridge", "fatal": false])
    default:
      break
    }
  }

  private func dropped(_ reason: String) {
    generation += 1
    isConnected = false
    attempts += 1
    let delay = min(30.0, 0.5 * pow(2.0, Double(min(attempts, 7) - 1)))
    log("connection dropped (\(reason)); retrying in \(delay)s")
    report("offline")
    q.asyncAfter(deadline: .now() + delay) { self.connect() }
  }

  private func report(_ state: String) {
    emit(["t": "link", "state": state, "watched": isWatched, "paused": isPaused])
  }

  /// The plugin's answer to a call, sent back as an MCP tool result: the answer as JSON text,
  /// then any images it carries (`_images`: `[{ data, mimeType }]`). On `q`.
  func answer(id: String, response: [String: Any]) -> Bool {
    guard let relayId = calls.removeValue(forKey: id), let task else { return false }
    var body = response
    let images = body.removeValue(forKey: "_images") as? [[String: Any]] ?? []
    let isError = body["error"] != nil && body["status"] == nil
    var content: [[String: Any]] = []
    // The relay takes messages up to 1 MiB: images that would overflow it are left out, and
    // the answer says so.
    var room = 960_000
    var dropped = 0
    var kept: [[String: Any]] = []
    for image in images {
      guard let data = image["data"] as? String, let mime = image["mimeType"] as? String else { continue }
      if data.utf8.count > room {
        dropped += 1
        continue
      }
      room -= data.utf8.count
      kept.append(["type": "image", "data": data, "mimeType": mime])
    }
    if dropped > 0 { body["imagesLeftOut"] = "\(dropped) image(s) were too large to send." }
    let text = (try? JSONSerialization.data(withJSONObject: body)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    content.append(["type": "text", "text": text])
    content.append(contentsOf: kept)
    send(["type": "result", "id": relayId, "result": ["content": content, "isError": isError]], on: task)
    return true
  }

  /// What the chat is doing (working, side, asking, task), for list_chats; sent again after a
  /// reconnect. On `q`.
  func state(_ body: [String: Any]) {
    var message = body
    message["type"] = "state"
    lastState = message
    if isConnected, let task { send(message, on: task) }
  }

  /// News for the Claude app's feed: started, finished, a question, stopped, a side answer. On `q`.
  func event(_ body: [String: Any]) {
    var message = body
    message["type"] = "event"
    if isConnected, let task {
      send(message, on: task)
    } else {
      unsent.append(message)
      if unsent.count > 20 { unsent.removeFirst(unsent.count - 20) }
    }
  }

  /// Pauses Claude Bridge for the whole account, or resumes it. On `q`.
  func pause(_ on: Bool) -> Bool {
    guard isConnected, let task else { return false }
    send(["type": "pause", "paused": on], on: task)
    return true
  }

  /// Adds this session to the Claude app's watch list, or takes it off. On `q`.
  func watch(_ on: Bool) {
    guard isConnected, let task else { return }
    send(["type": "watch", "watched": on], on: task)
  }

  private func send(_ message: [String: Any], on socket: URLSessionWebSocketTask) {
    guard let data = try? JSONSerialization.data(withJSONObject: message),
      let text = String(data: data, encoding: .utf8)
    else { return }
    socket.send(.string(text)) { _ in }
  }

  func close() {
    pinger?.cancel()
    generation += 1
    task?.cancel(with: .normalClosure, reason: nil)
  }
}

// MARK: - Main

var keepAlive: DispatchSourceTimer?

func run() -> Never {
  guard let relay = settings["relay"] as? String, let url = URL(string: relay),
    let key = settings["key"] as? String, let session = settings["session"] as? String
  else { fail("The connector needs relay, key and session settings.", code: "settings") }
  let bridge = BridgeClient(
    url: url, key: key, session: session, project: settings["project"] as? String ?? "",
    folder: settings["folder"] as? String ?? "")

  let bridgeServer = CommandServer(path: socketPath) { route, body in
    switch route {
    case "/ping":
      return q.sync { ["ok": true, "connected": bridge.isConnected, "watched": bridge.isWatched, "paused": bridge.isPaused] }
    case "/tool_response":
      guard let id = body["id"] as? String else { return ["ok": false] }
      let response = body["response"] as? [String: Any] ?? [:]
      return ["ok": q.sync { bridge.answer(id: id, response: response) }]
    case "/state":
      q.async { bridge.state(body) }
      return ["ok": true]
    case "/event":
      q.async { bridge.event(body) }
      return ["ok": true]
    case "/watch":
      let on = body["watched"] as? Bool ?? true
      q.async { bridge.watch(on) }
      return ["ok": true]
    case "/pause":
      let on = body["paused"] as? Bool ?? true
      return ["ok": q.sync { bridge.pause(on) }]
    case "/answer":
      guard let id = body["id"] as? String, let value = body["value"] else { return ["ok": false] }
      mailbox.put(id, value)
      return ["ok": true]
    case "/wait_answer":
      guard let id = body["id"] as? String else { return ["ok": false] }
      let seconds = min(25, max(1, body["seconds"] as? Double ?? 20))
      if let value = mailbox.wait(id, seconds: seconds) { return ["ok": true, "value": value] }
      return ["ok": true, "pending": true]
    case "/stop":
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
        q.sync { bridge.close() }
        unlink(socketPath)
        exit(0)
      }
      return ["ok": true]
    default:
      return ["ok": false, "error": "unknown route \(route)"]
    }
  }
  do { try bridgeServer.start() } catch {
    fail("Couldn't open the command socket at \(socketPath): \(error)", code: "socket")
  }
  q.async { bridge.connect() }

  // Leave with the mod.
  let parent = getppid()
  let watchdog = DispatchSource.makeTimerSource(queue: .global())
  watchdog.schedule(deadline: .now() + 1, repeating: 1)
  watchdog.setEventHandler {
    if getppid() != parent {
      bridgeServer.stop()
      exit(0)
    }
  }
  watchdog.resume()
  keepAlive = watchdog
  emit(["t": "started", "pid": getpid()])
  dispatchMain()
}

run()
