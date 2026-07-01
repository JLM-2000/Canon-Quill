# Security Model

Canon Quill is safe-by-default.

## Secrets

- Never paste PATs, API keys, OAuth client secrets, refresh tokens, or service credentials into chat.
- Never commit credential files.
- Use `.env`, environment variables, local credential files, or existing CLI auth.

## Google Drive

Default scope is `https://www.googleapis.com/auth/drive.file`.

The Drive MCP exposes only:

- Extract ID from URL.
- List selected folders.
- Read selected file text/exported text.
- Write text files.
- Upsert text files with overwrite protection.

It does not expose:

- Delete.
- Share.
- Permission mutation.
- Ownership transfer.
- Trash.

## OpenCode Permissions

Agents are split by phase. Validation agents are read-only. Final posting agents can write only through safe Drive MCP tools and local manifests.

## User Review Gates

Required human gates:

- Preflight approval before drafting.
- Chapter approval before Drive posting.
- Final book approval before complete.

## GitHub

The project should be pushed using existing `gh` authentication or a token supplied outside chat. The repository is private by default.
