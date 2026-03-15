# bin/

## sck-audio-capture

Pre-compiled Mach-O arm64 binary from the `spike/AudioSpike/` feasibility test (Spike 0).

**Purpose**: Standalone ScreenCaptureKit audio capture tool used to validate that system audio could be captured as 16kHz mono PCM before integrating into the SwiftUI app.

**Linked frameworks**: ScreenCaptureKit, CoreMedia, AVFoundation, CoreAudio

**Build source**: `spike/AudioSpike/` — run `cd spike/AudioSpike && swift build` to rebuild.

**Current status**: Superseded by the integrated `AudioCaptureManager` in `app/MeetingCopilot/`. Retained for debugging and standalone audio capture testing.

**Usage**:
```bash
# Requires Screen Recording permission in System Settings
./bin/sck-audio-capture
# Outputs raw 16kHz mono PCM to stdout
```
