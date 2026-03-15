#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  record --session <id>     Record a session's transcript for replay"
    echo "  run    --fixture <path>   Replay saved transcript through intelligence + workers"
    echo "  diff   --fixture <path>   Compare suggestions against expected baseline"
    echo ""
    echo "Examples:"
    echo "  $0 record --session abc123"
    echo "  $0 run --fixture fixtures/standup-2024-03-09.json"
    echo "  $0 diff --fixture fixtures/standup-2024-03-09.json"
}

if [ $# -lt 1 ]; then
    usage
    exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
    record)
        SESSION_ID=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --session) SESSION_ID="$2"; shift 2 ;;
                *) echo "Unknown option: $1"; usage; exit 1 ;;
            esac
        done

        if [ -z "$SESSION_ID" ]; then
            echo "ERROR: --session <id> is required"
            usage
            exit 1
        fi

        SESSION_DIR="$HOME/.meeting-copilot/sessions/$SESSION_ID"
        if [ ! -d "$SESSION_DIR" ]; then
            echo "ERROR: Session not found: $SESSION_DIR"
            exit 1
        fi

        FIXTURE_FILE="$PROJECT_DIR/fixtures/$(date +%Y-%m-%d)-$SESSION_ID.json"

        echo "Recording fixture from session $SESSION_ID..."
        cd "$PROJECT_DIR/server"
        npx tsx -e "
            const Database = require('better-sqlite3');
            const path = require('path');
            const db = new Database(path.join('$SESSION_DIR', 'session.db'));
            const segments = db.prepare('SELECT * FROM transcript ORDER BY timestamp').all();
            const fixture = {
                sessionId: '$SESSION_ID',
                recordedAt: new Date().toISOString(),
                segments: segments.map(s => ({
                    text: s.text,
                    source: s.source,
                    label: s.label,
                    timestamp: s.timestamp,
                    duration: s.duration,
                    wordCount: s.wordCount
                }))
            };
            require('fs').writeFileSync('$FIXTURE_FILE', JSON.stringify(fixture, null, 2));
            console.log('Fixture written: $FIXTURE_FILE');
            console.log('Segments: ' + segments.length);
            db.close();
        "
        ;;

    run)
        FIXTURE_PATH=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --fixture) FIXTURE_PATH="$2"; shift 2 ;;
                *) echo "Unknown option: $1"; usage; exit 1 ;;
            esac
        done

        if [ -z "$FIXTURE_PATH" ]; then
            echo "ERROR: --fixture <path> is required"
            usage
            exit 1
        fi

        # Resolve to absolute path
        if [[ "$FIXTURE_PATH" != /* ]]; then
            FIXTURE_PATH="$(cd "$(dirname "$FIXTURE_PATH")" && pwd)/$(basename "$FIXTURE_PATH")"
        fi

        if [ ! -f "$FIXTURE_PATH" ]; then
            echo "ERROR: Fixture file not found: $FIXTURE_PATH"
            exit 1
        fi

        OUTPUT_PATH="${FIXTURE_PATH%.json}.output.json"

        echo "Replaying fixture: $FIXTURE_PATH"
        echo "Output will be written to: $OUTPUT_PATH"
        echo ""

        cd "$PROJECT_DIR/server"
        npx tsx src/replay.ts "$FIXTURE_PATH" "$OUTPUT_PATH"

        echo ""
        echo "Replay complete. Output: $OUTPUT_PATH"
        ;;

    diff)
        FIXTURE_PATH=""
        while [ $# -gt 0 ]; do
            case "$1" in
                --fixture) FIXTURE_PATH="$2"; shift 2 ;;
                *) echo "Unknown option: $1"; usage; exit 1 ;;
            esac
        done

        if [ -z "$FIXTURE_PATH" ]; then
            echo "ERROR: --fixture <path> is required"
            usage
            exit 1
        fi

        # Resolve to absolute path
        if [[ "$FIXTURE_PATH" != /* ]]; then
            FIXTURE_PATH="$(cd "$(dirname "$FIXTURE_PATH")" && pwd)/$(basename "$FIXTURE_PATH")"
        fi

        if [ ! -f "$FIXTURE_PATH" ]; then
            echo "ERROR: Fixture file not found: $FIXTURE_PATH"
            exit 1
        fi

        EXPECTED_PATH="${FIXTURE_PATH%.json}.expected.json"
        OUTPUT_PATH="${FIXTURE_PATH%.json}.output.json"

        if [ ! -f "$EXPECTED_PATH" ]; then
            echo "ERROR: Expected baseline not found: $EXPECTED_PATH"
            echo "Run '$0 run --fixture $FIXTURE_PATH' first to generate output,"
            echo "review it, then save as: $EXPECTED_PATH"
            exit 1
        fi

        # Step 1: Run the replay to generate fresh output
        echo "Step 1/2: Running replay..."
        echo ""

        cd "$PROJECT_DIR/server"
        npx tsx src/replay.ts "$FIXTURE_PATH" "$OUTPUT_PATH"

        echo ""
        echo "Step 2/2: Comparing against baseline..."
        echo ""

        # Step 2: Diff the output against expected
        npx tsx src/replay-diff.ts "$OUTPUT_PATH" "$EXPECTED_PATH"
        ;;

    *)
        echo "Unknown command: $COMMAND"
        usage
        exit 1
        ;;
esac
