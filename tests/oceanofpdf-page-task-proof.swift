import Foundation

@main
struct Proof {
    static func main() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        var missing = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        missing.removeValue(forKey: "headers")
        do {
            _ = try JSONDecoder().decode(ModulePageTask.self, from: JSONSerialization.data(withJSONObject: missing))
            fatalError("Expected the old request to fail")
        } catch DecodingError.keyNotFound(let key, _) {
            precondition(key.stringValue == "headers")
            print("Reproduced native failure: missing headers")
        }
        let fixed = try JSONDecoder().decode(ModulePageTask.self, from: data)
        precondition(fixed.headers.isEmpty)
        precondition(fixed.url.absoluteString == "https://oceanofpdf.com/recently-added/")
        print("Fixed module request passes actual Books ModulePageTask decoder")
    }
}
