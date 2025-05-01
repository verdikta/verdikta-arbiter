#!/bin/bash

# Create zip archives for multi-CID testing
echo "Creating zip archives for multi-CID integration tests..."

# Define directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PRIMARY_DIR="$SCRIPT_DIR/multi-cid-primary"
PLAINTIFF_DIR="$SCRIPT_DIR/multi-cid-plaintiff"
DEFENDANT_DIR="$SCRIPT_DIR/multi-cid-defendant"

echo "Using script directory: $SCRIPT_DIR"

# Create primary archive
echo "Creating primary archive from $PRIMARY_DIR"
cd "$PRIMARY_DIR" && zip -r "$SCRIPT_DIR/multi-cid-primary.zip" . && echo "Created primary archive"

# Create plaintiff archive
echo "Creating plaintiff archive from $PLAINTIFF_DIR"
cd "$PLAINTIFF_DIR" && zip -r "$SCRIPT_DIR/multi-cid-plaintiff.zip" . && echo "Created plaintiff archive"

# Create defendant archive
echo "Creating defendant archive from $DEFENDANT_DIR"
cd "$DEFENDANT_DIR" && zip -r "$SCRIPT_DIR/multi-cid-defendant.zip" . && echo "Created defendant archive"

echo "All archives created successfully" 