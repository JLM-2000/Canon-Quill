const idPatterns = [
  /\/folders\/([a-zA-Z0-9_-]+)/,
  /\/file\/d\/([a-zA-Z0-9_-]+)/,
  /[?&]id=([a-zA-Z0-9_-]+)/,
  /^([a-zA-Z0-9_-]{10,})$/
];

export function extractDriveId(input: string): string {
  for (const pattern of idPatterns) {
    const match = input.match(pattern);
    if (match?.[1]) return match[1];
  }
  throw new Error("Could not extract a Google Drive ID from the input.");
}
