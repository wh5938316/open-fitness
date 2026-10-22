import Foundation

#if canImport(FoundationXML)
  import FoundationXML
#endif

public enum PathCommand: Codable, Sendable, Equatable {
  case move(Double, Double)
  case line(Double, Double)
  case cubic(Double, Double, Double, Double, Double, Double)
  case close
}

public struct MuscleMapArtwork: Codable, Sendable {
  public struct ViewBox: Codable, Sendable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
  }
  public var viewBox: ViewBox
  public var outline: [[PathCommand]]
  public var surfaces: [String: [[PathCommand]]]
  public var regions: [String: String]
}

public enum MuscleMap {
  public static func parse(svg: Data) throws -> MuscleMapArtwork {
    let delegate = ArtworkParser()
    let parser = XMLParser(data: svg)
    parser.shouldResolveExternalEntities = false
    parser.delegate = delegate
    guard parser.parse(), delegate.failure == nil, let viewBox = delegate.viewBox,
      !delegate.outline.isEmpty, !delegate.surfaces.isEmpty
    else { throw delegate.failure ?? APIError("UNSUPPORTED_SVG") }
    return .init(
      viewBox: viewBox, outline: delegate.outline, surfaces: delegate.surfaces,
      regions: delegate.regions)
  }
}

private final class ArtworkParser: NSObject, XMLParserDelegate {
  var viewBox: MuscleMapArtwork.ViewBox?
  var outline: [[PathCommand]] = []
  var surfaces: [String: [[PathCommand]]] = [:]
  var regions: [String: String] = [:]
  var failure: Error?

  func parser(
    _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
    qualifiedName qName: String?, attributes: [String: String]
  ) {
    do {
      if elementName == "svg" {
        let values = (attributes["viewBox"] ?? "").split {
          $0.isWhitespace || $0 == ","
        }.compactMap { Double($0) }
        guard values.count == 4, values.allSatisfy(\.isFinite), values[2] > 0, values[3] > 0 else {
          throw APIError("UNSUPPORTED_SVG")
        }
        viewBox = .init(x: values[0], y: values[1], width: values[2], height: values[3])
      }
      guard elementName == "path",
        attributes["data-outline"] != nil || attributes["data-surface"] != nil
      else { return }
      var pathParser = try SVGPathParser(attributes["d"] ?? "")
      let commands = try pathParser.parse()
      if attributes["data-outline"] != nil { outline.append(commands) }
      if let surface = attributes["data-surface"] {
        surfaces[surface, default: []].append(commands)
        if let region = attributes["data-region"] { regions[surface] = region }
      }
    } catch {
      failure = error
      parser.abortParsing()
    }
  }
}

private struct SVGPathParser {
  private enum Token {
    case command(Character)
    case number(Double)
  }
  private var tokens: [Token] = []
  private var index = 0
  private var x = 0.0
  private var y = 0.0
  private var startX = 0.0
  private var startY = 0.0

  init(_ path: String) throws {
    let expression = try NSRegularExpression(
      pattern: #"[A-Za-z]|[-+]?(?:[0-9]*\.[0-9]+|[0-9]+\.?[0-9]*)(?:[eE][-+]?[0-9]+)?"#)
    let input = path as NSString
    let matches = expression.matches(in: path, range: NSRange(location: 0, length: input.length))
    var end = 0
    for match in matches {
      let gap = input.substring(with: NSRange(location: end, length: match.range.location - end))
      guard gap.allSatisfy({ $0.isWhitespace || $0 == "," }) else {
        throw APIError("UNSUPPORTED_SVG")
      }
      let value = input.substring(with: match.range)
      if let number = Double(value), number.isFinite {
        tokens.append(.number(number))
      } else if value.count == 1, let command = value.first, command.isLetter {
        tokens.append(.command(command))
      } else {
        throw APIError("UNSUPPORTED_SVG")
      }
      end = NSMaxRange(match.range)
    }
    guard input.substring(from: end).allSatisfy({ $0.isWhitespace || $0 == "," }) else {
      throw APIError("UNSUPPORTED_SVG")
    }
  }

  mutating func parse() throws -> [PathCommand] {
    var result: [PathCommand] = []
    var command: Character?
    while index < tokens.count {
      if case .command(let value) = tokens[index] {
        command = value
        index += 1
      }
      guard let current = command else { throw APIError("UNSUPPORTED_SVG") }
      let relative = current.isLowercase
      let op = current.uppercased()
      guard !result.isEmpty || op == "M" else { throw APIError("UNSUPPORTED_SVG") }
      switch op {
      case "M", "L":
        let nextX = try number() + (relative ? x : 0)
        let nextY = try number() + (relative ? y : 0)
        x = nextX
        y = nextY
        if op == "M" {
          result.append(.move(x, y))
          startX = x
          startY = y
          command = relative ? "l" : "L"
        } else {
          result.append(.line(x, y))
        }
      case "H":
        x = try number() + (relative ? x : 0)
        result.append(.line(x, y))
      case "V":
        y = try number() + (relative ? y : 0)
        result.append(.line(x, y))
      case "C":
        let x1 = try number() + (relative ? x : 0)
        let y1 = try number() + (relative ? y : 0)
        let x2 = try number() + (relative ? x : 0)
        let y2 = try number() + (relative ? y : 0)
        let nextX = try number() + (relative ? x : 0)
        let nextY = try number() + (relative ? y : 0)
        result.append(.cubic(x1, y1, x2, y2, nextX, nextY))
        x = nextX
        y = nextY
      case "Z":
        result.append(.close)
        x = startX
        y = startY
        command = nil
      default: throw APIError("UNSUPPORTED_SVG")
      }
    }
    guard !result.isEmpty else { throw APIError("UNSUPPORTED_SVG") }
    return result
  }

  private mutating func number() throws -> Double {
    guard index < tokens.count, case .number(let number) = tokens[index] else {
      throw APIError("UNSUPPORTED_SVG")
    }
    index += 1
    return number
  }
}
