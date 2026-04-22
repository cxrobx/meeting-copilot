#ifndef CWHISPERVAD_H
#define CWHISPERVAD_H

// Umbrella header for the Silero VAD subset of whisper.cpp's C API.
// Only pulls in the VAD symbols we use from Swift — the full whisper.h
// has a lot more surface we don't need and some of which doesn't map
// cleanly to Swift. Since whisper.h is well-behaved (no Objective-C
// glue, no platform ifdefs we care about), re-exporting it wholesale
// is fine and saves us from having to redeclare types.
//
// At build time, Swift finds whisper.h via /opt/homebrew/include
// (headerSearchPath in Package.swift). At runtime, the app loads
// libwhisper.1.8.3.dylib from the bundle's Resources/whisper/lib/
// directory via rpath — same dylib whisper-server already uses.

#include <whisper.h>

#endif /* CWHISPERVAD_H */
