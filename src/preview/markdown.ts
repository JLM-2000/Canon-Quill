export function renderMarkdown(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/);
  return blocks.map(renderBlock).join("\n");
}

function renderBlock(block: string): string {
  const trimmed = block.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("# ")) return `<h1>${inline(trimmed.slice(2))}</h1>`;
  if (trimmed.startsWith("## ")) return `<h2>${inline(trimmed.slice(3))}</h2>`;
  if (trimmed.startsWith("### ")) return `<h3>${inline(trimmed.slice(4))}</h3>`;

  if (trimmed.startsWith("> ")) {
    const quote = trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^>\s?/, ""))
      .join("<br />");
    return `<blockquote>${inline(quote)}</blockquote>`;
  }

  if (/^[-*] /.test(trimmed)) {
    const items = trimmed
      .split(/\r?\n/)
      .filter((line) => /^[-*] /.test(line))
      .map((line) => `<li>${inline(line.slice(2))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  return `<p>${inline(trimmed.replace(/\r?\n/g, "<br />"))}</p>`;
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
