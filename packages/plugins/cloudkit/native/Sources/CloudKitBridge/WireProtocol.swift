import Foundation

enum WireProtocol {
    static let version = 1
    static let maxFrameBytes = 16 * 1024 * 1024
}

enum WireValue: Codable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: WireValue])
    case array([WireValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([String: WireValue].self) { self = .object(value) }
        else { self = .array(try container.decode([WireValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var string: String? { if case let .string(value) = self { return value }; return nil }
    var object: [String: WireValue]? { if case let .object(value) = self { return value }; return nil }
    var data: Data? { string.flatMap { Data(base64Encoded: $0) } }
}

struct NativeRequest: Codable, Sendable {
    let id: String
    let op: String
    let input: [String: WireValue]
}

enum NativeReply: Encodable, Sendable {
    case success(id: String, result: WireValue)
    case failure(id: String, code: String)
    case event(String)

    private enum CodingKeys: String, CodingKey { case id, ok, result, error, code, event }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .success(id, result):
            try container.encode(id, forKey: .id); try container.encode(true, forKey: .ok); try container.encode(result, forKey: .result)
        case let .failure(id, code):
            try container.encode(id, forKey: .id); try container.encode(false, forKey: .ok); try container.encode(["code": code], forKey: .error)
        case let .event(event): try container.encode(event, forKey: .event)
        }
    }
}
