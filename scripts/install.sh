#!/usr/bin/env bash
set -euo pipefail

required_major=20
required_minor=19

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 20.19.0 or newer, then rerun npm run setup." >&2
  exit 1
fi

version="$(node -p "process.versions.node")"
major="${version%%.*}"
rest="${version#*.}"
minor="${rest%%.*}"

if [ "$major" -lt "$required_major" ] || { [ "$major" -eq "$required_major" ] && [ "$minor" -lt "$required_minor" ]; }; then
  echo "Node.js $version detected. Canon Quill requires Node.js 20.19.0+ for OpenSpec compatibility." >&2
  echo "Install a newer Node.js version, then rerun npm run setup." >&2
  echo "Recommended with nvm: nvm install 20 && nvm use 20" >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "Installing OpenCode..."
  npm install -g opencode-ai
else
  echo "OpenCode detected: $(opencode --version)"
fi

if ! command -v openspec >/dev/null 2>&1; then
  echo "Installing OpenSpec..."
  npm install -g @fission-ai/openspec@latest
else
  echo "OpenSpec detected: $(openspec --version)"
fi

if [ ! -f ".env" ]; then
  cat > ".env" <<'EOF'
# Canon Quill local settings
# Fill these in after setup, before starting Drive-backed workflows.

# Required for Google Drive OAuth. Use a Desktop OAuth client JSON from Google Cloud Console.
GOOGLE_OAUTH_CLIENT_JSON=

# Default is least-privilege file access. Change only if you intentionally need broader Drive access.
CANON_QUILL_DRIVE_SCOPES=https://www.googleapis.com/auth/drive.file

# Keep false unless you intentionally want target Drive files with matching names to be overwritten.
CANON_QUILL_ALLOW_OVERWRITE=false

# Local preview server port.
CANON_QUILL_PREVIEW_PORT=4181

# Local setup wizard port.
CANON_QUILL_WIZARD_PORT=4177
EOF
  echo "Created .env. Fill in GOOGLE_OAUTH_CLIENT_JSON before using Drive tools."
else
  echo ".env already exists; leaving it unchanged."
fi

npm install
npm run build
npm run validate:workflow
npm run init:project

echo "Canon Quill setup complete. Restart OpenCode after changing opencode.json or agent files."
