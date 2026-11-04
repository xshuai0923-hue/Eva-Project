// Plays scenarios.mjs in WKWebView — the engine Safari runs — with real NSEvent mouse and
// key events and with text an input method holds (marked text), through the session proxy.
// The window sits off screen and the app never activates, so nothing takes the keyboard
// from whoever is at the machine. One line per scenario; exits non-zero when any fails.
//
// Built and run by smoke-browser.sh:
//   swiftc -O -o webkit-smoke webkit.swift && ./webkit-smoke <proxy origin> <scenarios.json>
import AppKit
import WebKit

struct Step: Decodable {
  let op: String
  let path: String?, js: String?, timeoutMs: Int?, selector: String?, text: String?
  let key: String?, name: String?, label: String?, reason: String?, ms: Int?
  let width: Double?, height: Double?
}
struct Scenario: Decodable { let name: String; let steps: [Step] }
struct Plan: Decodable { let diagnose: String; let scenarios: [Scenario] }
struct Skip: Error { let reason: String }
struct Failure: Error { let message: String }

@MainActor
final class Runner {
  let base: String
  // A borderless window never becomes key, so a click reaches the page as it is: one that
  // could would spend the first click on becoming key, as any inactive window does.
  let window: NSWindow
  let web: WKWebView
  var height: CGFloat = 800

  init(base: String) {
    self.base = base
    window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 1280, height: 800),
                             styleMask: [.borderless], backing: .buffered, defer: false)
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: configuration)
    window.contentView = web
    window.acceptsMouseMovedEvents = true
    window.setFrameOrigin(NSPoint(x: -4000, y: -4000))
    window.orderFrontRegardless()
    window.makeFirstResponder(web)
  }

  func sleep(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }

  /// The size of the page's window, off screen where it stays: a phone's, or the wide default.
  func resize(_ width: CGFloat, _ height: CGFloat) {
    self.height = height
    window.setContentSize(NSSize(width: width, height: height))
    web.frame = NSRect(x: 0, y: 0, width: width, height: height)
    window.setFrameOrigin(NSPoint(x: -4000, y: -4000))
  }

  func value(_ source: String) async -> Any? { try? await web.evaluateJavaScript(source) }

  func truthy(_ source: String) async -> Bool {
    (await value("(() => { try { return !!(\(source)); } catch (e) { return false; } })()") as? Bool) ?? false
  }

  func waitFor(_ source: String, _ timeoutMs: Int) async -> Bool {
    var waited = 0
    while waited < timeoutMs {
      if await truthy(source) { return true }
      await sleep(150); waited += 150
    }
    return false
  }

  /// {{name}} filled in: as is in a path, as a JSON literal in JavaScript.
  func fill(_ text: String, _ vars: [String: String], literal: Bool) -> String {
    let pattern = try! NSRegularExpression(pattern: "\\{\\{(\\w+)\\}\\}")
    var result = text
    for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
      let name = String(text[Range(match.range(at: 1), in: text)!])
      let raw = vars[name] ?? ""
      let replacement = literal
        ? String(data: try! JSONSerialization.data(withJSONObject: raw, options: [.fragmentsAllowed]), encoding: .utf8)!
        : raw
      result.replaceSubrange(Range(match.range, in: result)!, with: replacement)
    }
    return result
  }

  func mouse(_ type: NSEvent.EventType, _ x: Double, _ y: Double) {
    let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: Double(height) - y), modifierFlags: [],
                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                   context: nil, eventNumber: 0, clickCount: type == .mouseMoved ? 0 : 1,
                                   pressure: type == .leftMouseDown ? 1 : 0)!
    window.sendEvent(event)
  }

  func click(_ selector: String) async throws {
    let literal = String(data: try JSONSerialization.data(withJSONObject: selector, options: [.fragmentsAllowed]), encoding: .utf8)!
    // A person scrolls to what they click; a point outside the window reaches nothing.
    guard let point = await value("(() => { const n = document.querySelector(\(literal)); if (!n) return null; n.scrollIntoView({ block: 'center' }); const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()") as? [Double] else {
      throw Failure(message: "没有 \(selector)")
    }
    mouse(.mouseMoved, point[0], point[1] - 4); await sleep(60)
    mouse(.mouseMoved, point[0], point[1]); await sleep(200)
    mouse(.leftMouseDown, point[0], point[1]); await sleep(80)
    mouse(.leftMouseUp, point[0], point[1])
  }

  func key(_ name: String) async throws {
    let (characters, code, flags): (String, UInt16, NSEvent.ModifierFlags)
    switch name {
    case "Enter": (characters, code, flags) = ("\r", 36, [])
    case "ArrowDown": (characters, code, flags) = (String(Character(UnicodeScalar(UInt16(NSDownArrowFunctionKey))!)), 125, [.numericPad, .function])
    default: throw Failure(message: "unknown key \(name)")
    }
    for type in [NSEvent.EventType.keyDown, .keyUp] {
      let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags,
                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                   context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                   isARepeat: false, keyCode: code)!
      window.sendEvent(event)
      await sleep(30)
    }
    await sleep(150)
  }

  func play(_ scenario: Scenario) async throws {
    var vars: [String: String] = [:]
    let noReplacement = NSRange(location: NSNotFound, length: 0)
    for step in scenario.steps {
      let js = step.js.map { fill($0, vars, literal: true) } ?? ""
      switch step.op {
      case "navigate":
        web.load(URLRequest(url: URL(string: base + fill(step.path ?? "/", vars, literal: false))!))
        await sleep(300)
        guard await waitFor("document.readyState === 'complete'", 20000) else { throw Failure(message: "页面没有载入") }
      case "waitFor":
        guard await waitFor(js, step.timeoutMs ?? 15000) else { throw Failure(message: "等不到：\(String((step.js ?? "").prefix(90)))") }
      case "click": try await click(step.selector ?? "")
      case "type": web.insertText(fill(step.text ?? "", vars, literal: false))
      case "compose":
        let text = fill(step.text ?? "", vars, literal: false)
        (web as AnyObject).setMarkedText?(text, selectedRange: NSRange(location: (text as NSString).length, length: 0), replacementRange: noReplacement)
      case "commit": (web as AnyObject).insertText?(fill(step.text ?? "", vars, literal: false), replacementRange: noReplacement)
      case "key": try await key(step.key ?? "")
      case "remember": vars[step.name ?? ""] = await value(js) as? String ?? ""
      case "expect": if !(await truthy(js)) { throw Failure(message: "没做到：\(step.label ?? "")") }
      case "skipUnless": if !(await truthy(js)) { throw Skip(reason: step.reason ?? "") }
      case "sleep": await sleep(step.ms ?? 0)
      case "viewport":
        resize(CGFloat(step.width ?? 1280), CGFloat(step.height ?? 800))
        await sleep(300)
      default: throw Failure(message: "unknown op \(step.op)")
      }
    }
  }

  func run(_ plan: Plan) async -> Int32 {
    var failures: Int32 = 0
    for scenario in plan.scenarios {
      // Each scenario starts on a wide screen; a phone's sets its own size.
      resize(1280, 800)
      do {
        try await play(scenario)
        print("  ✓ WebKit  \(scenario.name)")
      } catch let skip as Skip {
        print("  - WebKit  \(scenario.name)（跳过：\(skip.reason)）")
      } catch let failure as Failure {
        failures += 1
        let state = await value(plan.diagnose) as? String ?? ""
        print("  ✗ WebKit  \(scenario.name)：\(failure.message)\n      \(state)")
      } catch {
        failures += 1
        print("  ✗ WebKit  \(scenario.name)：\(error)")
      }
    }
    return failures == 0 ? 0 : 1
  }
}

let arguments = CommandLine.arguments
guard arguments.count == 3, let data = FileManager.default.contents(atPath: arguments[2]),
      let plan = try? JSONDecoder().decode(Plan.self, from: data) else {
  FileHandle.standardError.write("usage: webkit-smoke <proxy origin> <scenarios.json>\n".data(using: .utf8)!)
  exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in
  let runner = Runner(base: arguments[1])
  let code = await runner.run(plan)
  fflush(stdout)
  exit(code)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 600) { print("  ✗ WebKit  超时"); exit(3) }
app.run()
