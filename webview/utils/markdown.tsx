/**
 * Tiny markdown renderer for assistant messages in chat.
 *
 * Why hand-rolled: keeps the bundle dep-free (preact + signals are the
 * only runtime deps today) and keeps output as JSX, not innerHTML — no
 * sanitizer needed because text never becomes raw HTML.
 *
 * Supported: fenced code blocks (``` with optional lang), inline code,
 * **bold**, *italic*, [text](url), headers (# through ###), bullet
 * lists (- or *), numbered lists (1.), and paragraph line breaks.
 *
 * Out of scope (intentional): tables, images, blockquotes, nested
 * lists, HTML passthrough. Add when an actual chat reply needs them.
 */

import type { JSX } from 'preact';

type InlineNode = string | JSX.Element;

/** Render a markdown string as an array of JSX nodes. Each top-level
 *  node corresponds to one block (paragraph, code block, header, list).
 *  Caller drops them into a container with `whiteSpace: normal` or
 *  similar — line wrapping is the container's job, not markdown's. */
export function renderMarkdown(text: string): JSX.Element {
  const blocks = parseBlocks(text);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

// ---------------- block parsing ----------------

type Block =
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'ulist'; items: string[] }
  | { kind: 'olist'; items: string[] }
  | { kind: 'para'; text: string };

function parseBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      // Skip the closing fence (or end-of-text)
      if (i < lines.length) i++;
      out.push({ kind: 'code', lang, body: bodyLines.join('\n') });
      continue;
    }

    // Heading (# ## ###; deeper levels collapse to h3 since chat is small)
    const head = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (head) {
      const level = head[1].length as 1 | 2 | 3;
      out.push({ kind: 'heading', level, text: head[2] });
      i++;
      continue;
    }

    // Bullet list — collect contiguous - or * lines
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ulist', items });
      continue;
    }

    // Numbered list — collect contiguous N. lines
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push({ kind: 'olist', items });
      continue;
    }

    // Blank line — eat it (block separator)
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Otherwise: paragraph — collect until blank or block-starter
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push({ kind: 'para', text: paraLines.join('\n') });
  }

  return out;
}

// ---------------- block rendering ----------------

function renderBlock(b: Block, key: number): JSX.Element {
  switch (b.kind) {
    case 'code':
      return <CodeBlock key={key} lang={b.lang} body={b.body} />;
    case 'heading': {
      const Tag: keyof JSX.IntrinsicElements = `h${b.level}` as keyof JSX.IntrinsicElements;
      const sizes: Record<number, string> = { 1: '15px', 2: '14px', 3: '13px' };
      return (
        <Tag
          key={key}
          style={{
            margin: '4px 0',
            fontSize: sizes[b.level],
            fontWeight: 600,
            color: 'var(--vscode-foreground)',
          }}
        >
          {renderInline(b.text)}
        </Tag>
      );
    }
    case 'ulist':
      return (
        <ul key={key} style={{ margin: '2px 0', paddingLeft: '20px' }}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case 'olist':
      return (
        <ol key={key} style={{ margin: '2px 0', paddingLeft: '20px' }}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case 'para':
      return (
        <div key={key} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {renderInline(b.text)}
        </div>
      );
  }
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  return (
    <div style={{ position: 'relative' }}>
      {lang && (
        <div
          style={{
            position: 'absolute',
            top: '2px',
            right: '6px',
            fontSize: '10px',
            color: 'var(--vscode-descriptionForeground)',
            opacity: 0.7,
          }}
        >
          {lang}
        </div>
      )}
      <pre
        style={{
          margin: '4px 0',
          padding: '8px 10px',
          background: 'var(--vscode-textCodeBlock-background)',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: '4px',
          overflow: 'auto',
          fontSize: '12px',
          fontFamily: 'var(--vscode-editor-font-family)',
          whiteSpace: 'pre',
        }}
      >
        <code>{body}</code>
      </pre>
    </div>
  );
}

// ---------------- inline rendering ----------------

/**
 * Render inline markdown — `code`, **bold**, *italic*, [text](url).
 *
 * Order matters: code first (so backticks inside bold don't get
 * mis-parsed), then links, then bold, then italic. Each pass turns
 * matched substrings into JSX nodes and leaves the rest as plain
 * strings; the next pass walks the resulting array and only inspects
 * string segments. Avoids regex compositions that would be hard to
 * audit for backtracking.
 */
function renderInline(text: string): InlineNode[] {
  let nodes: InlineNode[] = [text];
  nodes = applyPattern(nodes, /`([^`\n]+)`/g, (m) => (
    <code style={inlineCodeStyle}>{m[1]}</code>
  ));
  nodes = applyPattern(nodes, /\[([^\]]+)\]\(([^)]+)\)/g, (m) => (
    <a
      href={m[2]}
      style={{ color: 'var(--vscode-textLink-foreground)' }}
      target="_blank"
      rel="noopener noreferrer"
    >
      {m[1]}
    </a>
  ));
  nodes = applyPattern(nodes, /\*\*([^*\n]+)\*\*/g, (m) => (
    <strong>{m[1]}</strong>
  ));
  nodes = applyPattern(nodes, /(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (m) => (
    <em>{m[1]}</em>
  ));
  return nodes;
}

const inlineCodeStyle = {
  padding: '1px 4px',
  background: 'var(--vscode-textCodeBlock-background)',
  borderRadius: '3px',
  fontSize: '12px',
  fontFamily: 'var(--vscode-editor-font-family)',
};

/** Walk every plain-string node, run the pattern, and replace matched
 *  substrings with the JSX produced by `make`. JSX nodes already in the
 *  array are skipped — this lets passes layer cleanly without one
 *  pass mangling another's output. */
function applyPattern(
  nodes: InlineNode[],
  pattern: RegExp,
  make: (m: RegExpExecArray) => JSX.Element,
): InlineNode[] {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    if (typeof node !== 'string') {
      out.push(node);
      continue;
    }
    pattern.lastIndex = 0;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(node)) !== null) {
      if (m.index > lastIdx) out.push(node.slice(lastIdx, m.index));
      out.push(make(m));
      lastIdx = m.index + m[0].length;
      // Avoid infinite loop on zero-width matches
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
    if (lastIdx < node.length) out.push(node.slice(lastIdx));
  }
  return out;
}
