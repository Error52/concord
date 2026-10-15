import { Fragment, useState, type ReactNode } from 'react';

/**
 * Safe Markdown-like renderer: builds React elements directly (never innerHTML), so message
 * content can't inject markup. Supports code blocks, inline code, **bold**, *italic*, __underline__,
 * ~~strike~~, ||spoiler||, > quotes, http(s) links, <@user> mentions and @everyone.
 */

export interface MarkdownContext {
  renderMention(userId: string): ReactNode;
  highlightEveryone: boolean;
}

const URL_RE = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i;

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span className={`md-spoiler${shown ? ' shown' : ''}`} onClick={() => setShown(true)} role="button" tabIndex={0} aria-label="Спойлер">
      {children}
    </span>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span>{lang || 'code'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

type Rule = { open: string; close: string; render: (children: ReactNode, key: number) => ReactNode };
const INLINE_RULES: Rule[] = [
  { open: '||', close: '||', render: (c, k) => <Spoiler key={k}>{c}</Spoiler> },
  { open: '**', close: '**', render: (c, k) => <strong key={k}>{c}</strong> },
  { open: '__', close: '__', render: (c, k) => <u key={k}>{c}</u> },
  { open: '~~', close: '~~', render: (c, k) => <s key={k}>{c}</s> },
  { open: '*', close: '*', render: (c, k) => <em key={k}>{c}</em> },
  { open: '_', close: '_', render: (c, k) => <em key={k}>{c}</em> },
];

function renderInline(text: string, ctx: MarkdownContext, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let key = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // inline code
    if (rest[0] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(<code key={key++} className="md-inline-code">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    // mentions
    const mention = /^<@([0-9a-f-]{36})>/i.exec(rest);
    if (mention) {
      flush();
      out.push(<Fragment key={key++}>{ctx.renderMention(mention[1]!)}</Fragment>);
      i += mention[0].length;
      continue;
    }
    if ((rest.startsWith('@everyone') || rest.startsWith('@here')) && (i === 0 || /\s/.test(text[i - 1]!))) {
      flush();
      const word = rest.startsWith('@everyone') ? '@everyone' : '@here';
      out.push(<span key={key++} className="mention everyone">{word}</span>);
      i += word.length;
      continue;
    }
    // links
    if (rest[0] === 'h' && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      const m = URL_RE.exec(rest);
      if (m) {
        flush();
        out.push(
          <a key={key++} href={m[0]} target="_blank" rel="noopener noreferrer nofollow" className="md-link">
            {m[0]}
          </a>,
        );
        i += m[0].length;
        continue;
      }
    }
    // emphasis
    if (depth < 4) {
      let matched = false;
      for (const rule of INLINE_RULES) {
        if (!rest.startsWith(rule.open)) continue;
        const end = text.indexOf(rule.close, i + rule.open.length);
        if (end <= i + rule.open.length) continue;
        const inner = text.slice(i + rule.open.length, end);
        if (/^\s|\s$/.test(inner)) continue;
        flush();
        out.push(rule.render(renderInline(inner, ctx, depth + 1), key++));
        i = end + rule.close.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

function renderLines(text: string, ctx: MarkdownContext, baseKey: number): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let quote: string[] = [];
  const flushQuote = (k: number) => {
    if (!quote.length) return;
    out.push(
      <blockquote key={`q${baseKey}-${k}`} className="md-quote">
        {quote.map((l, i) => (
          <Fragment key={i}>
            {renderInline(l, ctx)}
            {i < quote.length - 1 && <br />}
          </Fragment>
        ))}
      </blockquote>,
    );
    quote = [];
  };
  lines.forEach((line, idx) => {
    if (line.startsWith('> ')) {
      quote.push(line.slice(2));
      return;
    }
    flushQuote(idx);
    out.push(
      <Fragment key={`l${baseKey}-${idx}`}>
        {renderInline(line, ctx)}
        {idx < lines.length - 1 && <br />}
      </Fragment>,
    );
  });
  flushQuote(lines.length);
  return out;
}

export function renderMarkdown(text: string, ctx: MarkdownContext): ReactNode {
  const parts: ReactNode[] = [];
  const fence = /```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = fence.exec(text))) {
    if (m.index > last) parts.push(...renderLines(text.slice(last, m.index).replace(/\n$/, ''), ctx, k++));
    parts.push(<CodeBlock key={`c${k++}`} lang={m[1] ?? ''} code={(m[2] ?? '').replace(/\n$/, '')} />);
    last = fence.lastIndex;
  }
  if (last < text.length) parts.push(...renderLines(text.slice(last).replace(/^\n/, ''), ctx, k++));
  return parts;
}

/** True if the message is only 1–3 emoji (rendered large). */
export function isEmojiOnly(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && [...t.replace(/\s/g, '')].length <= 12;
}

/** Plain-text preview: replaces <@id> tokens with @name (for reply previews and notifications). */
export function plainMentions(text: string, nameOf: (userId: string) => string): string {
  return text.replace(/<@([0-9a-f-]{36})>/gi, (_, id: string) => `@${nameOf(id)}`);
}
