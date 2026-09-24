import AppKit
import XCTest
@testable import MeetingCopilot

final class EvidenceClipboardTests: XCTestCase {
    // A private pasteboard, so the test never touches the user's clipboard.
    private let pasteboard = NSPasteboard(name: NSPasteboard.Name("com.christopherrobinson.meeting-copilot.tests"))

    override func tearDown() {
        pasteboard.releaseGlobally()
        super.tearDown()
    }

    // A 1×1 PNG, the shape the server's /present/evidence/:i/file sends.
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

    func testAnImageLandsOnThePasteboardAsAnImage() {
        XCTAssertTrue(EvidenceClipboard.copy(imageData: png, to: pasteboard))
        let images = pasteboard.readObjects(forClasses: [NSImage.self]) as? [NSImage]
        XCTAssertEqual(images?.count, 1)
        XCTAssertEqual(images?.first?.size, NSSize(width: 1, height: 1))
    }

    func testDataThatIsNotAnImageLeavesThePasteboardAlone() {
        pasteboard.clearContents()
        pasteboard.setString("kept", forType: .string)
        XCTAssertFalse(EvidenceClipboard.copy(imageData: Data("That snapshot is not here any more.".utf8), to: pasteboard))
        XCTAssertEqual(pasteboard.string(forType: .string), "kept")
    }
}
