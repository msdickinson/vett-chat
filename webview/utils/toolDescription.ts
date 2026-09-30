/**
 * Build a short, human-readable description of a tool call from its
 * args. Used as the second line of a tool card ("Bash · List home dir")
 * so users can scan a long chat without expanding every card.
 *
 * Falls back to the first ~60 chars of the primary arg for unknown
 * tools — better than blank, never long enough to wreck layout.
 */

export function describeToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';

  switch (toolName) {
    case 'terminal':
    case 'bash':
      return describeBash(asString(args.command));

    case 'file_editor':
      return describeFileEditor(args);

    case 'think':
      return truncate(asString(args.thought), 80);

    case 'finish':
      return asString(args.message) || 'Mark task complete';

    case 'task_tracker': {
      const op = asString(args.op);
      if (op === 'plan') return 'Update task plan';
      if (op === 'view') return 'View task plan';
      return op || 'Task tracker';
    }

    // Team / leader tools
    case 'assign_task':
    case 'assign_async': {
      const member = asString(args.member);
      const task = truncate(asString(args.task), 50);
      const prefix = toolName === 'assign_async' ? 'Async dispatch' : 'Dispatch';
      if (member && task) return `${prefix} → ${member}: ${task}`;
      if (member) return `${prefix} → ${member}`;
      return prefix;
    }
    case 'check_task':
    case 'wait_task':
    case 'cancel_task':
    case 'inject_into_task': {
      const id = asString(args.task_id);
      const verb = toolName.replace(/_/g, ' ');
      return id ? `${verb} ${id}` : verb;
    }
    case 'check_tasks':
      return 'Check all tasks';
    case 'report_progress':
      return truncate(asString(args.note), 80) || 'Report progress';

    default:
      return describeUnknown(args);
  }
}

function describeBash(cmd: string): string {
  if (!cmd) return '';
  const trimmed = cmd.trim();
  // Take the first command of a chain (split on ; && || |)
  const firstCmd = trimmed.split(/\s*(?:;|&&|\|\||\|)\s*/)[0];
  // If it's short enough, just show it. Otherwise summarize by verb.
  if (firstCmd.length <= 60) return firstCmd;
  const verb = firstCmd.split(/\s+/)[0];
  return `${verb} … (${firstCmd.length} chars)`;
}

function describeFileEditor(args: Record<string, unknown>): string {
  // file_editor uses either `command` or `command_name`; normalize.
  const op = asString(args.command_name) || asString(args.command);
  const path = asString(args.path) || asString(args.file_text) || '';
  const shortPath = shortenPath(path);
  if (op === 'view') {
    const range = args.view_range as [number, number] | undefined;
    if (Array.isArray(range) && range.length === 2) {
      return `Read ${shortPath} (lines ${range[0]}–${range[1]})`;
    }
    return `Read ${shortPath}`;
  }
  if (op === 'create') return `Create ${shortPath}`;
  if (op === 'str_replace') return `Edit ${shortPath}`;
  if (op === 'insert') {
    const line = args.insert_line;
    return typeof line === 'number' ? `Insert at ${shortPath}:${line}` : `Insert into ${shortPath}`;
  }
  if (op === 'undo_edit') return `Undo last edit to ${shortPath}`;
  return op ? `${op} ${shortPath}` : shortPath;
}

function describeUnknown(args: Record<string, unknown>): string {
  // Pick the first string-valued arg and use it as the description.
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim().length > 0) {
      return truncate(v.trim(), 80);
    }
  }
  return '';
}

function shortenPath(p: string): string {
  if (!p) return '';
  // Keep just the last 2 segments — enough to be unambiguous in chat,
  // short enough to fit in a card header.
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
