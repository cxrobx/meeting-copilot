import AppKit

/// Evidence snapshots onto the pasteboard, for pasting into a call's chat
/// (the dashboard's "Copy image"; server/src/present/evidence.ts). AppKit does
/// the copy because WKWebView's clipboard API loses the click's user
/// activation across the fetch the image needs.
enum EvidenceClipboard {
    /// Writes the image and returns whether it landed. Data that is not an
    /// image leaves the pasteboard as it was.
    @discardableResult
    static func copy(imageData data: Data, to pasteboard: NSPasteboard = .general) -> Bool {
        guard let image = NSImage(data: data), image.isValid else { return false }
        pasteboard.clearContents()
        return pasteboard.writeObjects([image])
    }
}
