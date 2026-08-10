export function renderMarkdown(markdown: string): string {
  const blocks = markdown.replace(/<br\s*\/?\s*>/gi, "\n").split(/\n{2,}/);
  return blocks.map(renderBlock).join("\n");
}

function renderBlock(block: string): string {
  const trimmed = block.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/);

  if (isTable(lines)) {
    const headers = tableCells(lines[0]);
    const rows = lines.slice(2).map(tableCells);
    return `<table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, index) => `<td>${inline(row[index] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  if (trimmed.startsWith("# ")) return `<h1>${inline(trimmed.slice(2))}</h1>`;
  if (trimmed.startsWith("## ")) return `<h2>${inline(trimmed.slice(3))}</h2>`;
  if (trimmed.startsWith("### ")) return `<h3>${inline(trimmed.slice(4))}</h3>`;

  if (trimmed.startsWith("> ")) {
    const quote = trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/^>\s?/, ""))
      .map(inline)
      .join("<br />");
    return `<blockquote>${quote}</blockquote>`;
  }

  if (/^[-*] /.test(trimmed)) {
    const items = trimmed
      .split(/\r?\n/)
      .filter((line) => /^[-*] /.test(line))
      .map((line) => `<li>${inline(line.slice(2))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  if (/^-{3,}$/.test(trimmed)) return "<hr />";

  return `<p>${lines.map(inline).join("<br />")}</p>`;
}

function isTable(lines: string[]): boolean {
  return lines.length >= 2
    && lines[0].includes("|")
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1]);
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
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
