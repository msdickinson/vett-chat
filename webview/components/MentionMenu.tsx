/**
 * MentionMenu — autocomplete popup for @-mentions in the chat input.
 *
 * Reads its options from signals the host populates via
 * `requestMentionContext` / `mentionContext` messages. Phase 2 surfaces
 * five additional kinds beyond Phase 1's `@selection` / `@<file>`:
 *
 *   - `@<symbol-name>` — workspace symbol (function / class / etc.)
 *   - `@problems`      — current diagnostics (errors + warnings)
 *   - `@git`           — `git status` + recent log
 *   - `@diff`          — uncommitted `git diff`
 *
 * The trigger token (the substring starting at the most recent `@`)
 * is determined in ChatView; this component only renders.
 */

import type { Mention, MentionFile, MentionSymbol, ProblemsCount, GitStatusSummary } from '../../src/shared/types';

interface Props {
  visible: boolean;
  /** The query the user has typed AFTER the `@`, lowercase-trimmed.
   *  Empty when the cursor is right after `@`. */
  query: string;
  files: MentionFile[];
  symbols: MentionSymbol[];
  selectionAvailable: boolean;
  selectionPreview: string | null;
  problemsCount: ProblemsCount | null;
  git: GitStatusSummary;
  onPick: (m: Mention) => void;
}

// Special entries are matched via prefix on their token name (without
// the leading `@`). Keep this ordered so the menu's row order is stable
// regardless of how matching proceeds.
const SPECIAL_NAMES = ['selection', 'problems', 'git', 'diff'] as const;

export function MentionMenu({
  visible,
  query,
  files,
  symbols,
  selectionAvailable,
  selectionPreview,
  problemsCount,
  git,
  onPick,
}: Props) {
  if (!visible) return null;

  type Option =
    | { kind: 'selection' }
    | { kind: 'problems' }
    | { kind: 'git' }
    | { kind: 'diff' }
    | { kind: 'symbol'; symbol: MentionSymbol }
    | { kind: 'file'; file: MentionFile };

  const opts: Option[] = [];
  // Special items first, in the canonical order. Filtered by query so
  // the menu stays compact when the user has typed a few chars.
  const specials = new Set<string>();
  for (const name of SPECIAL_NAMES) {
    if (!name.startsWith(query)) continue;
    specials.add(name);
  }
  if (specials.has('selection') && selectionAvailable) opts.push({ kind: 'selection' });
  // `@problems` even with zero diagnostics — surfacing "0 problems" is
  // confusing UX, so hide the row when nothing's there.
  if (specials.has('problems') && problemsCount && (problemsCount.errors > 0 || problemsCount.warnings > 0)) {
    opts.push({ kind: 'problems' });
  }
  if (specials.has('git') && git.available) opts.push({ kind: 'git' });
  if (specials.has('diff') && git.available) opts.push({ kind: 'diff' });

  // Symbols next — typically 1–10 results; the host has already capped
  // the list and filtered by the query.
  for (const s of symbols) {
    opts.push({ kind: 'symbol', symbol: s });
  }

  // Files last. Already host-filtered to the query but we re-filter
  // belt-and-braces in case the menu re-renders against stale state.
  for (const f of files) {
    if (!query || f.basename.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)) {
      opts.push({ kind: 'file', file: f });
    }
  }
  if (opts.length === 0) return null;

  return (
    <div style={menuStyle}>
      {opts.slice(0, 14).map((opt, i) => {
        if (opt.kind === 'selection') {
          return (
            <Row
              key="selection"
              left="@selection"
              right={selectionPreview ? selectionPreview.slice(0, 60) : 'current editor selection'}
              first={i === 0}
              onPick={() => onPick({ token: '@selection', kind: 'selection' })}
            />
          );
        }
        if (opt.kind === 'problems') {
          const c = problemsCount!;
          const summary = `${c.errors} error${c.errors === 1 ? '' : 's'}` +
            (c.warnings > 0 ? `, ${c.warnings} warning${c.warnings === 1 ? '' : 's'}` : '');
          return (
            <Row
              key="problems"
              left="@problems"
              right={summary}
              first={i === 0}
              onPick={() => onPick({ token: '@problems', kind: 'problems' })}
            />
          );
        }
        if (opt.kind === 'git') {
          const right = git.branch
            ? `${git.branch}${git.dirtyFiles ? ` · ${git.dirtyFiles} dirty` : ''}`
            : 'workspace git status + recent log';
          return (
            <Row
              key="git"
              left="@git"
              right={right}
              first={i === 0}
              onPick={() => onPick({ token: '@git', kind: 'git' })}
            />
          );
        }
        if (opt.kind === 'diff') {
          return (
            <Row
              key="diff"
              left="@diff"
              right={git.dirtyFiles ? `${git.dirtyFiles} file${git.dirtyFiles === 1 ? '' : 's'} changed` : 'git diff (uncommitted)'}
              first={i === 0}
              onPick={() => onPick({ token: '@diff', kind: 'diff' })}
            />
          );
        }
        if (opt.kind === 'symbol') {
          const s = opt.symbol;
          // Token shape: `@<name>` — symbol names that include
          // characters outside the @-token allowlist (parens, generics,
          // spaces) get stripped to ascii-friendly slug. Keep the
          // canonical name in `symbolName` for re-resolution at
          // expansion time.
          const slug = sanitizeSymbolToken(s.name);
          const display = `@${s.name}`;
          const right = `${s.kind} · ${s.path}${s.containerName ? ` · ${s.containerName}` : ''}`;
          return (
            <Row
              key={`sym-${s.path}-${s.startLine}-${s.name}`}
              left={display}
              right={right}
              first={i === 0}
              onPick={() => onPick({
                token: `@${slug}`,
                kind: 'symbol',
                path: s.path,
                symbolName: s.name,
                startLine: s.startLine,
                endLine: s.endLine,
              })}
            />
          );
        }
        const f = opt.file;
        const dirname = f.path.length > f.basename.length
          ? f.path.slice(0, f.path.length - f.basename.length - 1)
          : '';
        return (
          <Row
            key={f.path}
            left={`@${f.basename}`}
            right={dirname || ''}
            first={i === 0}
            onPick={() => onPick({ token: `@${f.path}`, kind: 'file', path: f.path })}
          />
        );
      })}
    </div>
  );
}

interface RowProps { left: string; right: string; first: boolean; onPick: () => void; }
function Row({ left, right, onPick }: RowProps) {
  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      style={itemStyle}
      onMouseOver={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-list-hoverBackground)'; }}
      onMouseOut={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      <span style={{ fontWeight: 'bold', color: 'var(--vscode-textLink-foreground)' }}>{left}</span>
      {right && (
        <span style={{ marginLeft: '8px', color: 'var(--vscode-descriptionForeground)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {right}
        </span>
      )}
    </div>
  );
}

const menuStyle = {
  position: 'absolute' as const,
  bottom: '100%',
  left: 0,
  right: 0,
  marginBottom: '4px',
  maxHeight: '260px',
  overflowY: 'auto' as const,
  background: 'var(--vscode-editorWidget-background)',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '4px',
  fontSize: '12px',
  zIndex: 10,
  boxShadow: '0 -2px 8px rgba(0,0,0,0.2)',
};

const itemStyle = {
  padding: '6px 10px',
  cursor: 'pointer',
  borderBottom: '1px solid var(--vscode-panel-border)',
  display: 'flex',
  alignItems: 'baseline',
  overflow: 'hidden',
};

/** Replace any character a symbol name might contain that isn't allowed
 *  inside an @-token (paren, bracket, space, comma, generic-arrow, etc.)
 *  with a hyphen. Keeps the token round-trippable through the trigger
 *  detector — the host doesn't rely on the slug, just on the kind +
 *  symbolName carried in the Mention. */
function sanitizeSymbolToken(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_./\\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse out the @-token at the cursor in `text`, if any.
 *
 * Returns the trigger info (text from `@` to cursor, plus the
 * starting position of the `@`) when the cursor sits inside a
 * `@<word>` run; null otherwise. The "@" is included in the
 * returned token for display; the `query` field below is the chars
 * AFTER the `@` (which is what the menu filters by).
 */
export function findMentionTrigger(
  text: string,
  caret: number,
): { token: string; query: string; start: number } | null {
  // Walk backwards from caret looking for a recent @ that isn't
  // separated by whitespace. Mentions can include path separators
  // (/  \), dots, hyphens and underscores so `@src/foo-bar.ts` is
  // one token. Whitespace or another @ ends the search.
  const validChar = (c: string) =>
    /[A-Za-z0-9_./\\-]/.test(c);
  let i = caret - 1;
  while (i >= 0 && validChar(text[i])) i--;
  // i now points at the char before the run (or -1).
  if (i < 0 || text[i] !== '@') return null;
  // Mention must start the message OR follow whitespace — avoids
  // grabbing "you@example.com".
  if (i > 0 && /\S/.test(text[i - 1])) return null;
  const token = text.slice(i, caret);
  return { token, query: token.slice(1).toLowerCase(), start: i };
}
