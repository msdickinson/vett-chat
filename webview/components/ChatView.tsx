import { useRef, useEffect, useState } from 'preact/hooks';
import vscode from '../vscode';
import {
  messages,
  messageText,
  isSending,
  waitingForInput,
  canSend,
  toolCalls,
  dispatches,
  addUserMessage,
  cancelTurn,
  connectionErrorKind,
  currentProfile,
  profile,
  showWelcome,
  verboseMode,
  currentIteration,
  pendingImages,
  pendingImagePreviews,
  pendingMentions,
  mentionFiles,
  mentionSymbols,
  mentionSelectionPreview,
  mentionProblemsCount,
  mentionGit,
  agentPaused,
  pendingQuestion,
  pendingPermissions,
  pendingPlanActions,
  voiceInputState,
} from '../state/signals';
import type { VettImageAttachment, Mention } from '../../src/shared/types';
import { MentionMenu, findMentionTrigger } from './MentionMenu';
import { ToolCallCard } from './ToolCallCard';
import { DispatchCard } from './DispatchCard';
import { StatusBar } from './StatusBar';
import { ErrorBanner } from './ErrorBanner';
import { WelcomeView } from './WelcomeView';
import { ChatHeader } from './ChatHeader';
import { EmptyState } from './EmptyState';
import { VerboseView } from './VerboseView';
import { SettingsView } from './SettingsView';
import { isSlashing, tryDispatchSlash, SlashCommandMenu } from './SlashCommands';
import { GanttView } from '../gantt/GanttView';
import { viewMode } from '../state/signals';
import type { ChatMessage as Msg } from '../../src/shared/types';
import { renderMarkdown } from '../utils/markdown';
import { formatCost } from '../utils/pricing';
import { buildFeed } from '../utils/feed';
import { isLikelyVisionModel } from '../utils/multimodal';

/** Format a message timestamp as HH:MM:SS (24h, locale-default).
 * Compact enough to sit under each message without crowding. */
function formatMessageTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return '';
  }
}

export function ChatView() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The active @-trigger info — set when the cursor is inside a
   *  `@<word>` run; null when not. Drives MentionMenu visibility. */
  const [mentionTrigger, setMentionTrigger] = useState<{ token: string; query: string; start: number } | null>(null);

  // Auto-scroll on new messages / tool calls.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.value.length, toolCalls.value.length]);

  /** Garbage-collect mentions whose token no longer appears in the
   *  textarea — handles the user backspacing over `@foo.ts`. Runs on
   *  every input change; cheap because the mention list is short. */
  const pruneMentions = (text: string) => {
    if (pendingMentions.value.length === 0) return;
    const stillPresent = pendingMentions.value.filter((m) => text.includes(m.token));
    if (stillPresent.length !== pendingMentions.value.length) {
      pendingMentions.value = stillPresent;
    }
  };

  /** Detect @-trigger and post `requestMentionContext` whenever the
   *  user types in the input. Debounce-light: each keystroke posts,
   *  but the host's reply rate is bounded by VS Code's findFiles. */
  const updateMentionTrigger = (text: string, caret: number) => {
    const trig = findMentionTrigger(text, caret);
    setMentionTrigger(trig);
    if (trig) {
      vscode.postMessage({ type: 'requestMentionContext', data: { query: trig.query } });
    }
  };

  /** Replace the @-trigger range in the textarea with the picked
   *  mention's token (no expansion here — the host expands at send
   *  time so files stay fresh). Stage the mention in the signal so
   *  send-pipeline picks it up. */
  const handleMentionPick = (m: Mention) => {
    if (!mentionTrigger) return;
    const cur = messageText.value;
    const before = cur.slice(0, mentionTrigger.start);
    const after = cur.slice(mentionTrigger.start + mentionTrigger.token.length);
    const sep = after.startsWith(' ') ? '' : ' ';
    messageText.value = before + m.token + sep + after;
    setMentionTrigger(null);
    // De-dupe: same token twice in the input only stages once.
    if (!pendingMentions.value.some((x) => x.token === m.token)) {
      pendingMentions.value = [...pendingMentions.value, m];
    }
    inputRef.current?.focus();
  };

  const handleSend = () => {
    const text = messageText.value.trim();
    const imgs = pendingImages.value;
    const previews = pendingImagePreviews.value;
    // Filter mentions to only those still appearing in the outgoing
    // text — avoids sending stale mentions the user backspaced over
    // since the last prune.
    const ments = pendingMentions.value.filter((m) => text.includes(m.token));
    // Allow sending an images-only message (e.g. "look at this screenshot"
    // with no text). Without imgs.length the empty-text guard would
    // swallow the send.
    if (!text && imgs.length === 0) { return; }
    // Slash commands intercept BEFORE the message is queued for the
    // agent. Unknown slash commands surface inline as an assistant
    // message; known ones dispatch to the appropriate host action.
    // Slash commands run text-only — drop staged images so the user
    // doesn't lose them silently if they meant to attach.
    if (text && tryDispatchSlash(text)) return;
    // addUserMessage returns null when the message was queued (agent is
    // mid-turn). In that case we don't post to the host — the next
    // assistant_text / user_input_needed event handler drains the queue
    // and fires sendMessage at that point.
    const sentNow = addUserMessage(text, imgs.length > 0 ? imgs : undefined, previews);
    if (sentNow !== null) {
      vscode.postMessage({
        type: 'sendMessage',
        data: {
          text: sentNow,
          ...(imgs.length > 0 ? { images: imgs } : {}),
          ...(ments.length > 0 ? { mentions: ments } : {}),
        },
      });
    }
  };

  /** Read a Blob as a base64 string + media type and stage it for the
   *  next send. Used by the paste, drag-drop, and (eventually) screenshot
   *  paths so they share one ingestion code path. Cap is generous (8MB
   *  per image) because we don't want to block the user's UX on a strict
   *  limit — vision models will reject anything truly oversized
   *  themselves. */
  const ingestImageBlob = (blob: Blob) => {
    if (!blob.type.startsWith('image/')) return;
    // Refuse early when the active profile's model isn't vision-capable.
    // Without this gate, vett happily forwards the image to a text-only
    // endpoint and the LLM returns an opaque 400 — the failure looks
    // like vett broke. Toast names the offending model so the user
    // knows which profile to swap to.
    const cur = currentProfile.value;
    if (!isLikelyVisionModel(cur?.model)) {
      const modelLabel = cur?.model || profile.value || '(unknown)';
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          text: `[Image rejected: profile \`${profile.value}\` uses model \`${modelLabel}\`, which doesn't appear to support image inputs. Switch to a vision-capable profile (e.g. one pointing at qwen2.5-vl, gpt-4o, claude-opus-4, or gemini-1.5+) before attaching images.]`,
          timestamp: new Date().toISOString(),
        },
      ];
      return;
    }
    if (blob.size > 8 * 1024 * 1024) {
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          text: `[Image rejected: ${(blob.size / 1024 / 1024).toFixed(1)} MB exceeds the 8 MB cap.]`,
          timestamp: new Date().toISOString(),
        },
      ];
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result ?? '');
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
      if (!m) return;
      const mediaType = m[1];
      const base64 = m[2];
      pendingImages.value = [
        ...pendingImages.value,
        { data: base64, media_type: mediaType } as VettImageAttachment,
      ];
      pendingImagePreviews.value = [...pendingImagePreviews.value, dataUri];
    };
    reader.readAsDataURL(blob);
  };

  /** Paste handler — fires on the textarea. Walks ClipboardItem entries
   *  for image/* MIME types. Falls through to default text paste when
   *  no image is found, so pasted text still lands in the input. */
  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let consumed = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          ingestImageBlob(blob);
          consumed = true;
        }
      }
    }
    if (consumed) e.preventDefault();
  };

  /** Drag-drop handler — wired on the input bar's outer container.
   *  Accepts any number of image/* files; non-image drops fall through
   *  so VS Code's own file-into-editor handlers can take them. */
  const handleDrop = (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    let consumed = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type.startsWith('image/')) {
        ingestImageBlob(f);
        consumed = true;
      }
    }
    if (consumed) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleDragOver = (e: DragEvent) => {
    // Need to preventDefault on dragover for drop to fire at all.
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  };

  const removePendingImage = (idx: number) => {
    pendingImages.value = pendingImages.value.filter((_, i) => i !== idx);
    pendingImagePreviews.value = pendingImagePreviews.value.filter((_, i) => i !== idx);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      position: 'relative',
    }}>
      {/* Settings drawer overlays the panel when settingsOpen is true.
          Inside the same DOM tree as ChatView so it absolute-positions
          relative to the panel, not the entire viewport. */}
      <SettingsView />
      <ChatHeader />
      {/* Messages area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px',
        }}
      >
        {/* Error banner — shown above messages whenever the session is in
            an actionable failure state. */}
        {connectionErrorKind.value && <ErrorBanner />}

        {/* Raw events view: when toggled on, replace the curated body
            with a chronological event log. The error banner above
            still shows because errors are equally relevant in both
            modes. */}
        {/* All three views are always mounted; inactive ones are hidden
            with CSS instead of being unmounted. Empirically, conditional
            mount/unmount via Preact reconciliation in this webview was
            APPENDING the new view alongside the old (the "click Logs
            shows both" report) instead of replacing — likely a Preact
            interaction with @preact/signals around the conditional
            position. Always-mounted with display toggle eliminates the
            ambiguity. */}
        <div style={{ display: viewMode.value === 'gantt' ? 'block' : 'none' }}>
          <GanttView />
        </div>
        <div style={{ display: viewMode.value === 'logs' || viewMode.value === 'raw' ? 'block' : 'none' }}>
          <VerboseView />
        </div>
        <div style={{ display: viewMode.value === 'live' ? 'block' : 'none' }}>
          <LiveCurated>
            {/* Welcome / first-run view — shown until the user dismisses it.
                Pinned above messages when the user explicitly reopens it via
                the "Show Welcome" command mid-session. */}
            {showWelcome.value && !connectionErrorKind.value && <WelcomeView />}

            {!showWelcome.value && messages.value.length === 0 && toolCalls.value.length === 0 && !connectionErrorKind.value && (
              <EmptyState />
            )}

            {/* Interleaved chronological feed: messages + tool calls +
                dispatches sorted by timestamp. Without this they pool
                in three separate sections and the conversation reads
                out-of-order (assistant message at top, all tool cards
                bunched in the middle, all dispatch cards bunched at
                the bottom). */}
            {buildFeed(messages.value, toolCalls.value, dispatches.value).map((item) => {
              if (item.kind === 'message') {
                const msg = item.msg;
                return (
                  <div
                    key={`m-${item.idx}-${msg.timestamp}`}
                    style={{
                      margin: '6px 0',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      background: msg.role === 'user'
                        ? 'var(--vscode-button-background)'
                        : 'var(--vscode-textBlockQuote-background)',
                      color: msg.role === 'user'
                        ? 'var(--vscode-button-foreground)'
                        : 'var(--vscode-foreground)',
                      alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '90%',
                      // wordBreak only — no whiteSpace pre-wrap, the
                      // markdown renderer manages whitespace per block
                      // (paragraphs use pre-wrap, lists/headings don't,
                      // code blocks use pre).
                      wordBreak: 'break-word',
                      fontSize: '13px',
                      opacity: msg.queued ? 0.6 : 1,
                      border: msg.queued ? '1px dashed var(--vscode-charts-yellow)' : undefined,
                    }}
                  >
                    {msg.queued && (
                      <div style={{
                        fontSize: '10px',
                        marginBottom: '4px',
                        color: 'var(--vscode-descriptionForeground)',
                        fontStyle: 'italic',
                      }}>
                        queued — will send when the agent finishes its current step
                      </div>
                    )}
                    {/* Assistant messages get the markdown renderer
                        (code blocks / lists / inline emphasis); user
                        messages stay plain so we don't surprise people
                        with their own typing rendered as headings. */}
                    {msg.role === 'assistant' ? (
                      renderMarkdown(msg.text)
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
                    )}
                    {/* Image thumbnails — only on user messages that
                        carried attachments. Rendered as a small
                        bottom strip; click opens a fullsize new tab via
                        the data: URI (no host roundtrip needed). */}
                    {msg.images && msg.images.length > 0 && (
                      <div style={{
                        display: 'flex',
                        gap: '4px',
                        flexWrap: 'wrap',
                        marginTop: '6px',
                      }}>
                        {msg.images.map((src, i) => (
                          <img
                            key={i}
                            src={src}
                            alt={`attachment ${i + 1}`}
                            style={{
                              maxHeight: '120px',
                              maxWidth: '200px',
                              borderRadius: '3px',
                              border: '1px solid var(--vscode-panel-border)',
                              cursor: 'pointer',
                            }}
                            onClick={() => {
                              // window.open isn't sandboxed in webview
                              // contexts — fall back to anchor click so
                              // the data: URI opens in the user's browser
                              // for full-size view.
                              const a = document.createElement('a');
                              a.href = src;
                              a.target = '_blank';
                              a.rel = 'noopener';
                              a.click();
                            }}
                          />
                        ))}
                      </div>
                    )}
                    <div style={{
                      fontSize: '10px',
                      marginTop: '4px',
                      display: 'flex',
                      gap: '8px',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'space-between',
                      alignItems: 'baseline',
                      opacity: 0.6,
                      color: msg.role === 'user'
                        ? 'var(--vscode-button-foreground)'
                        : 'var(--vscode-descriptionForeground)',
                    }}>
                      <span>{formatMessageTime(msg.timestamp)}</span>
                      {/* Inline rewind button on user messages: trims
                          the visible chat history to before this turn.
                          Files-side restore is a separate flow
                          (worktree dropdown / /restore) — this button
                          is conversation-only on purpose. Skipped for
                          queued messages (they haven't been "spoken"
                          yet). */}
                      {msg.role === 'user' && !msg.queued && item.idx > 0 && (
                        <button
                          type="button"
                          title="Rewind chat to before this message (conversation-only; files unchanged)"
                          onClick={() => {
                            vscode.postMessage({ type: 'rewindConversationToIndex', data: { index: item.idx } });
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid currentColor',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontSize: '10px',
                            padding: '0 6px',
                            borderRadius: '3px',
                            opacity: 0.7,
                          }}
                        >↶ rewind</button>
                      )}
                      {/* Per-turn token + cost footer on assistant
                          messages. Local / unknown models: cost is 0,
                          so we show tokens only. Cloud models: tokens +
                          $-cost. */}
                      {msg.role === 'assistant' && (msg.turnInputTokens ?? 0) + (msg.turnOutputTokens ?? 0) > 0 && (
                        <span title="Tokens spent producing this reply">
                          {(msg.turnInputTokens ?? 0).toLocaleString()} in
                          {' / '}
                          {(msg.turnOutputTokens ?? 0).toLocaleString()} out
                          {(msg.turnCostUsd ?? 0) > 0 && (
                            <> · {formatCost(msg.turnCostUsd ?? 0)}</>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                );
              }
              if (item.kind === 'toolCall') {
                const tc = item.tc;
                return (
                  <ToolCallCard
                    key={`t-${tc.callId}`}
                    call={tc}
                    onToggle={() => {
                      const targetId = tc.callId;
                      toolCalls.value = toolCalls.value.map((c) =>
                        c.callId === targetId ? { ...c, expanded: !c.expanded } : c,
                      );
                    }}
                  />
                );
              }
              const d = item.disp;
              return (
                <DispatchCard
                  key={`d-${d.threadId}-${d.startedAt}-${item.idx}`}
                  dispatch={d}
                />
              );
            })}

            {/* Spinner when the agent is working. Shows whenever we're
                NOT explicitly waiting for user input — covers the case
                where vett emitted user_input_needed at session start
                (which flips isSending=false) but then immediately
                started processing the buffered first prompt. Without
                this Live looked frozen until the first assistant_text
                arrived. When a sub-agent dispatch is active, name it
                so the user knows who's doing what. */}
            {!waitingForInput.value && (() => {
              const activeDispatch = dispatches.value.find((d) => d.active);
              if (activeDispatch) {
                return (
                  <div style={{
                    padding: '8px',
                    fontSize: '12px',
                    color: 'var(--vscode-descriptionForeground)',
                    fontStyle: 'italic',
                  }}>
                    Leader is waiting on <strong>{activeDispatch.memberName}</strong>… (see card above for live progress)
                  </div>
                );
              }
              const iter = currentIteration.value;
              return (
                <div style={{
                  padding: '8px',
                  fontSize: '12px',
                  color: 'var(--vscode-descriptionForeground)',
                  fontStyle: 'italic',
                }}>
                  {iter
                    ? `Agent is thinking… (iteration ${iter.iteration})`
                    : 'Agent is thinking…'}
                </div>
              );
            })()}
          </LiveCurated>
        </div>
      </div>

      {/* Pending permission asks. One card per request — multiple
          can pile up if the agent emits parallel tool calls; the
          user works through them in arrival order. Each card resolves
          on Allow / Always Allow / Deny / Always Deny click. */}
      {pendingPermissions.value.map((p) => (
        <PermissionCard key={p.requestId} pending={p} />
      ))}

      {/* Per-call plan-mode action requests. One card per blocked
          write tool call. Approve → unlock gate + flip mode (no
          respawn); Reject → wrap returns error to the agent. After
          first approve, the gate stays unlocked for the session and
          subsequent writes don't surface here. */}
      {pendingPlanActions.value.map((p) => (
        <PlanModeActionCard key={p.requestId} pending={p} />
      ))}

      {/* Pending ask_user_question card. Sits above the input so the
          user can't miss it. Choices render as buttons; a free-text
          fallback uses the regular input + an "Answer" button. */}
      {pendingQuestion.value && (
        <div style={{
          padding: '10px 12px',
          margin: '0 8px 8px 8px',
          border: '1px solid var(--vscode-charts-blue)',
          borderRadius: '6px',
          background: 'var(--vscode-textBlockQuote-background)',
        }}>
          <div style={{
            fontSize: '10px',
            color: 'var(--vscode-charts-blue)',
            fontWeight: 600,
            letterSpacing: '0.5px',
            marginBottom: '4px',
          }}>
            AGENT IS ASKING
          </div>
          <div style={{
            fontSize: '13px',
            marginBottom: '8px',
            whiteSpace: 'pre-wrap',
          }}>
            {pendingQuestion.value.question}
          </div>
          {pendingQuestion.value.choices.length > 0 ? (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {pendingQuestion.value.choices.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    const q = pendingQuestion.value;
                    if (!q) return;
                    vscode.postMessage({
                      type: 'user_question_answer',
                      data: { question_id: q.questionId, text: c },
                    });
                    pendingQuestion.value = null;
                  }}
                  style={{
                    padding: '4px 12px',
                    background: 'var(--vscode-button-background)',
                    color: 'var(--vscode-button-foreground)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : (
            <div style={{
              fontSize: '11px',
              color: 'var(--vscode-descriptionForeground)',
              fontStyle: 'italic',
            }}>
              Type your answer in the input below and click "Answer".
            </div>
          )}
        </div>
      )}

      {/* Input area */}
      <div
        style={{
          padding: '8px',
          borderTop: '1px solid var(--vscode-panel-border)',
          background: 'var(--vscode-sideBar-background)',
          flexShrink: 0,
          position: 'relative',
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* Slash command auto-complete menu, positioned above textarea
            via absolute positioning. Only renders when the textarea
            currently starts with `/`. */}
        <SlashCommandMenu
          visible={isSlashing(messageText.value)}
          query={messageText.value}
          onPick={(c) => {
            // Single-token commands (no args) → run immediately. Commands
            // that take args → fill the textarea so the user can type
            // arguments before sending.
            if (c.takesArgs) {
              messageText.value = c.name + ' ';
              inputRef.current?.focus();
            } else {
              c.run('');
            }
          }}
        />
        {/* @-mention menu, positioned same way. Visible only when the
            cursor sits inside a `@<word>` run. Files come from the host;
            `@selection` is always offered. */}
        <MentionMenu
          visible={mentionTrigger !== null}
          query={mentionTrigger?.query ?? ''}
          files={mentionFiles.value}
          symbols={mentionSymbols.value}
          selectionAvailable={mentionSelectionPreview.value !== null}
          selectionPreview={mentionSelectionPreview.value}
          problemsCount={mentionProblemsCount.value}
          git={mentionGit.value}
          onPick={handleMentionPick}
        />
        {/* Pending-image thumbnail strip — only renders while there's
            something staged. Clicking the × removes one from the
            outgoing batch; the batch drains on Send. */}
        {pendingImagePreviews.value.length > 0 && (
          <div style={{
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            marginBottom: '6px',
            padding: '4px',
            border: '1px dashed var(--vscode-panel-border)',
            borderRadius: '4px',
            background: 'var(--vscode-editor-background)',
          }}>
            {pendingImagePreviews.value.map((dataUri, i) => (
              <div key={`${i}-${dataUri.length}`} style={{ position: 'relative' }}>
                <img
                  src={dataUri}
                  alt={`pending image ${i + 1}`}
                  style={{
                    maxHeight: '64px',
                    maxWidth: '120px',
                    border: '1px solid var(--vscode-panel-border)',
                    borderRadius: '3px',
                    display: 'block',
                  }}
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(i)}
                  title="Remove this attachment"
                  style={{
                    position: 'absolute',
                    top: '-6px',
                    right: '-6px',
                    width: '18px',
                    height: '18px',
                    padding: 0,
                    fontSize: '11px',
                    lineHeight: '16px',
                    borderRadius: '50%',
                    border: '1px solid var(--vscode-panel-border)',
                    background: 'var(--vscode-editor-background)',
                    color: 'var(--vscode-foreground)',
                    cursor: 'pointer',
                  }}
                >×</button>
              </div>
            ))}
            <span style={{
              alignSelf: 'center',
              fontSize: '10px',
              color: 'var(--vscode-descriptionForeground)',
              marginLeft: '4px',
            }}>
              {pendingImagePreviews.value.length} image{pendingImagePreviews.value.length === 1 ? '' : 's'} ready — sends with next message
            </span>
          </div>
        )}
        <div style={{ display: 'flex', gap: '6px' }}>
          <textarea
            ref={inputRef}
            value={messageText.value}
            onInput={(e) => {
              const t = e.target as HTMLTextAreaElement;
              messageText.value = t.value;
              pruneMentions(t.value);
              updateMentionTrigger(t.value, t.selectionStart ?? t.value.length);
            }}
            onKeyUp={(e) => {
              // selectionStart only updates after key events — also
              // re-evaluate on arrow / click navigation so the menu
              // closes if the cursor moves out of an @-run.
              const t = e.target as HTMLTextAreaElement;
              updateMentionTrigger(t.value, t.selectionStart ?? t.value.length);
            }}
            onClick={(e) => {
              const t = e.target as HTMLTextAreaElement;
              updateMentionTrigger(t.value, t.selectionStart ?? t.value.length);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message, /help for commands, @ for files / selection…  (paste / drop images to attach)"
            rows={2}
            style={{
              flex: 1,
              resize: 'vertical',
              padding: '6px 8px',
              background: 'var(--vscode-input-background)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border)',
              borderRadius: '4px',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
              outline: 'none',
            }}
          />
          {/* Send is always enabled — queues if the agent is busy. Cancel
              is shown alongside it whenever a turn is mid-flight, so the
              user can either queue follow-up text or interrupt. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignSelf: 'flex-end' }}>
            <button
              onClick={handleSend}
              title={isSending.value && !waitingForInput.value
                ? 'Queue this message for after the current step'
                : 'Send'}
              style={{
                padding: '6px 12px',
                background: 'var(--vscode-button-background)',
                color: 'var(--vscode-button-foreground)',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              {isSending.value && !waitingForInput.value ? 'Queue' : 'Send'}
            </button>
            <button
              type="button"
              onClick={() => vscode.postMessage({ type: 'toggleVoiceInput' })}
              disabled={voiceInputState.value === 'transcribing'}
              title={
                voiceInputState.value === 'idle'
                  ? 'Voice input — record via mic, transcribe with Whisper, drop into the chat input. Requires ffmpeg + a Whisper-compatible HTTP endpoint configured in vett-chat.whisperEndpoint.'
                  : voiceInputState.value === 'recording'
                    ? 'Recording — click again to stop and transcribe.'
                    : 'Transcribing the recording…'
              }
              style={{
                padding: '4px 12px',
                background: voiceInputState.value === 'recording'
                  ? 'var(--vscode-charts-red)'
                  : 'transparent',
                color: voiceInputState.value === 'recording'
                  ? 'var(--vscode-button-foreground)'
                  : 'var(--vscode-foreground)',
                border: '1px solid var(--vscode-panel-border)',
                borderRadius: '4px',
                cursor: voiceInputState.value === 'transcribing' ? 'wait' : 'pointer',
                fontSize: '11px',
                opacity: voiceInputState.value === 'transcribing' ? 0.6 : 1,
              }}
            >
              {voiceInputState.value === 'recording' ? '⏺ Stop' : voiceInputState.value === 'transcribing' ? '… Transcribing' : '🎤 Voice'}
            </button>
            {isSending.value && !waitingForInput.value && !agentPaused.value && (
              <>
                <button
                  onClick={() => {
                    // Pause asks the loop to stop at the next iteration
                    // boundary — current tool call completes, then it
                    // waits for Resume or a new user message. Different
                    // from Cancel (which aborts the turn outright).
                    vscode.postMessage({ type: 'pause' });
                  }}
                  title="Pause at next iteration boundary (current step finishes)"
                  style={{
                    padding: '4px 12px',
                    background: 'transparent',
                    color: 'var(--vscode-foreground)',
                    border: '1px solid var(--vscode-panel-border)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  ⏸ Pause
                </button>
                <button
                  onClick={() => {
                    vscode.postMessage({ type: 'cancel' });
                    cancelTurn();
                  }}
                  title="Interrupt the current agent turn"
                  style={{
                    padding: '4px 12px',
                    background: 'transparent',
                    color: 'var(--vscode-errorForeground)',
                    border: '1px solid var(--vscode-errorForeground)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  Cancel
                </button>
              </>
            )}
            {agentPaused.value && (
              <button
                onClick={() => {
                  // Tell the host to clear PauseRequest + ping the
                  // wake channel so the loop exits its idle wait. If
                  // the user has typed something, sending it instead
                  // also resumes (the loop treats a fresh user
                  // message as the implicit resume signal).
                  vscode.postMessage({ type: 'resume' });
                }}
                title="Resume the agent loop"
                style={{
                  padding: '4px 12px',
                  background: 'var(--vscode-charts-green)',
                  color: 'var(--vscode-editor-background)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 600,
                }}
              >
                ▶ Resume
              </button>
            )}
          </div>
        </div>
      </div>

      <StatusBar />
    </div>
  );
}

/** Distinct component identity for the live (curated) view body so
 * Preact's reconciler reliably unmounts it when the user toggles to
 * Logs / Raw / Gantt. With the previous keyed wrapper div, switching
 * was sometimes appending the new view below the old one instead of
 * replacing — Preact's diff between two keyed sibling divs at the
 * same conditional position turned out to be unreliable in this
 * webview context. Three distinct component types (GanttView,
 * VerboseView, LiveCurated) eliminate the ambiguity. */
function LiveCurated({ children }: { children: preact.ComponentChildren }) {
  // Real div so Preact has a dedicated DOM node to remove on unmount —
  // not a Fragment, which projects children into the parent and can
  // leave them stranded if the diff doesn't track them properly.
  return <div>{children}</div>;
}

/** Friendly label for each PermissionKind. Drives the chip + the
 *  "Always allow X" copy on the toggle buttons. */
const KIND_LABEL: Record<string, string> = {
  Read: 'read file',
  Edit: 'edit / write',
  TerminalSafe: 'safe terminal',
  TerminalUnsafe: 'terminal',
  Mcp: 'MCP tool',
  Other: 'tool',
};

/** Inline permission card. Renders a friendly summary plus four
 *  buttons: Allow (this call only), Always Allow This Kind (flips the
 *  per-session rule to auto), Deny (this call only), Always Deny (flips
 *  the per-session rule to deny). Click any button → post
 *  `permissionResponse` to the host → vett's PermissionGate's
 *  CheckAsync returns → tool either runs or returns a synthesized
 *  error. The card removes itself from `pendingPermissions` on click. */
function PermissionCard({ pending }: { pending: import('../../src/shared/types').PendingPermission }) {
  const kindLabel = KIND_LABEL[pending.kind] ?? 'tool';
  const respond = (decision: 'auto' | 'deny', remember: boolean) => {
    vscode.postMessage({
      type: 'permissionResponse',
      data: { requestId: pending.requestId, decision, rememberForKind: remember },
    });
    pendingPermissions.value = pendingPermissions.value.filter((p) => p.requestId !== pending.requestId);
  };
  return (
    <div style={{
      padding: '10px 12px',
      margin: '0 8px 8px 8px',
      border: '1px solid var(--vscode-charts-yellow)',
      borderRadius: '6px',
      background: 'var(--vscode-textBlockQuote-background)',
    }}>
      <div style={{
        fontSize: '10px',
        color: 'var(--vscode-charts-yellow)',
        fontWeight: 600,
        letterSpacing: '0.5px',
        marginBottom: '4px',
      }}>
        AGENT WANTS TO {pending.kind === 'Read' ? 'READ' : pending.kind === 'Edit' ? 'EDIT' : 'RUN'}
      </div>
      <div style={{ fontSize: '12px', marginBottom: '4px' }}>
        <strong>{pending.toolName}</strong>
        <span style={{ color: 'var(--vscode-descriptionForeground)' }}> · {kindLabel}</span>
      </div>
      {pending.preview && (
        <pre style={{
          fontFamily: 'var(--vscode-editor-font-family)',
          fontSize: '11px',
          margin: '4px 0 8px 0',
          padding: '6px 8px',
          background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.15))',
          borderRadius: '3px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          maxHeight: '180px',
          overflow: 'auto',
        }}>{pending.preview}</pre>
      )}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => respond('auto', false)} style={primaryBtn}>
          Allow
        </button>
        <button type="button" onClick={() => respond('auto', true)} style={secondaryBtn} title={`Future ${kindLabel} calls won't ask in this session`}>
          Always Allow {kindLabel}
        </button>
        <button type="button" onClick={() => respond('deny', false)} style={dangerBtn}>
          Deny
        </button>
        <button type="button" onClick={() => respond('deny', true)} style={dangerSecondaryBtn} title={`Future ${kindLabel} calls auto-deny in this session`}>
          Always Deny {kindLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Per-call plan-mode action card. Surfaced when the agent (in plan
 * mode) attempts a write-capable tool — the gate intercepts, emits a
 * plan_mode_action_request event, and blocks until the user responds.
 * Approve → unlock the gate for the rest of the session AND flip mode
 * to Execute (no respawn — agent keeps full context); the same tool
 * call dispatches immediately. Reject → wrap returns an error to the
 * agent, gate stays locked, agent can propose an alternative.
 */
function PlanModeActionCard({ pending }: { pending: import('../state/signals').PendingPlanAction }) {
  const respond = (approve: boolean) => {
    pendingPlanActions.value = pendingPlanActions.value.filter((p) => p.requestId !== pending.requestId);
    vscode.postMessage({
      type: 'planModeActionResponse',
      data: { requestId: pending.requestId, approve },
    });
  };

  const toolLabel = pending.toolName === 'terminal' ? 'Bash'
    : pending.toolName === 'file_editor' ? 'File'
    : pending.toolName;

  return (
    <div style={{
      padding: '12px 14px',
      margin: '0 8px 8px 8px',
      border: '2px solid var(--vscode-charts-purple, var(--vscode-charts-blue))',
      borderRadius: '6px',
      background: 'var(--vscode-textBlockQuote-background)',
    }}>
      <div style={{
        fontSize: '10px',
        color: 'var(--vscode-charts-purple, var(--vscode-charts-blue))',
        fontWeight: 600,
        letterSpacing: '0.5px',
        marginBottom: '6px',
        textTransform: 'uppercase',
      }}>
        🔒 Plan mode — agent wants to act
      </div>
      <div style={{ fontSize: '13px', marginBottom: '4px' }}>
        <strong>{toolLabel}</strong>
      </div>
      <div style={{
        fontSize: '12px',
        marginBottom: '10px',
        padding: '6px 8px',
        background: 'var(--vscode-editor-background)',
        border: '1px solid var(--vscode-widget-border, transparent)',
        borderRadius: '4px',
        fontFamily: 'var(--vscode-editor-font-family)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {pending.preview || '(no preview available)'}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginBottom: '8px' }}>
        Approve will switch this chat to execute mode for the rest of the session and run this call. Reject keeps plan mode and returns an error to the agent.
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => respond(false)} style={secondaryBtn}>
          Reject
        </button>
        <button type="button" onClick={() => respond(true)} style={primaryBtn}>
          Approve &amp; Switch
        </button>
      </div>
    </div>
  );
}

const primaryBtn = {
  padding: '4px 12px',
  background: 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};
const secondaryBtn = {
  padding: '4px 12px',
  background: 'transparent',
  color: 'var(--vscode-foreground)',
  border: '1px solid var(--vscode-panel-border)',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};
const dangerBtn = {
  padding: '4px 12px',
  background: 'var(--vscode-errorForeground, var(--vscode-button-background))',
  color: 'var(--vscode-button-foreground)',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};
const dangerSecondaryBtn = {
  padding: '4px 12px',
  background: 'transparent',
  color: 'var(--vscode-errorForeground, var(--vscode-foreground))',
  border: '1px solid var(--vscode-errorForeground, var(--vscode-panel-border))',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '12px',
};
