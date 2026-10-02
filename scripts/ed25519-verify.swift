// Checks a Sparkle update's EdDSA signature against the public key the app carries (SUPublicEDKey,
// from scripts/sparkle.conf). Sparkle's own sign_update --verify needs the private key, so it cannot
// say whether what shipped is verifiable by the copies already installed; this needs only the public half.
//
//   ed25519-verify <base64 public key> <file> <base64 signature>     exit 0 valid, 1 invalid, 2 bad input
//
// release.sh and verify-update-feed.sh compile and run it (swiftc, CryptoKit; nothing to install).
import CryptoKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 4,
      let keyBytes = Data(base64Encoded: arguments[1]), keyBytes.count == 32,
      let signature = Data(base64Encoded: arguments[3]), signature.count == 64,
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes),
      let contents = try? Data(contentsOf: URL(fileURLWithPath: arguments[2]), options: .mappedIfSafe)
else {
    FileHandle.standardError.write(Data("usage: ed25519-verify <base64 public key> <file> <base64 signature>\n".utf8))
    exit(2)
}
exit(key.isValidSignature(signature, for: contents) ? 0 : 1)
