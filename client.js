/**
 * dsh-cards-compaction, browser half: one Chat row per compaction.
 *
 * The row is projected from the ordinary compaction lifecycle events that the
 * host already writes to the Session log (compaction/start, /summary, /end),
 * so it reloads correctly and needs no client state of its own:
 *   - running  → "Compacting context…" with elapsed time;
 *   - failed   → the error recorded on compaction/end;
 *   - done     → the history cards and overview of a cards checkpoint,
 *                expandable like a tool call.
 * The lifecycle events carry no backend name, so running and failed rows use
 * wording that is true for any backend. A finished checkpoint from another
 * backend (compaction-basic) renders nothing here; the host's own compaction
 * row shows it. Manual /compact runs render nothing: the command's own card
 * already shows progress and outcome.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cards-compaction',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'cards-compaction';
    /** Chat node kind and its renderer key. */
    const KIND = 'cards-compaction';
    /** Conversation Definition kind (unique per registry). */
    const DEFINITION = 'cards-compaction-lifecycle';
    const STYLE_KEY = 'dsh-cards-compaction/row.css';

    const EN = Object.freeze({
      'title.running': 'Compacting context',
      'title.failed': 'Compaction failed',
      'title.done': 'History cards',
      'summary.running': '{elapsed}',
      'summary.done': '{cards} cards · replaced {events} events (~{tokens} tokens)',
      'summary.failed': '{error}',
      'overview': 'Overview',
      'card.meta': 'seqs {seqs} · {events} events',
      'card.archive': 'archive · depth {depth}',
      'hint.failed': 'The full history is kept. If this agent uses cards compaction, /cards shows its status.',
      'hint.done': 'The model can read any card’s original with cards_compaction_read_history.',
      'aria.toggle': 'Show history cards',
    });

    const ZH = Object.freeze({
      'title.running': '正在壓縮 context',
      'title.failed': '壓縮失敗',
      'title.done': '歷史卡片',
      'summary.running': '{elapsed}',
      'summary.done': '{cards} 張卡 · 取代 {events} 個事件（約 {tokens} tokens）',
      'summary.failed': '{error}',
      'overview': '整體摘要',
      'card.meta': 'seqs {seqs} · {events} 個事件',
      'card.archive': '彙整卡 · 第 {depth} 層',
      'hint.failed': '完整歷史已保留。若這個 agent 使用歷史卡片壓縮，可輸入 /cards 看狀態。',
      'hint.done': '模型可用 cards_compaction_read_history 以卡片 id 讀回原文。',
      'aria.toggle': '顯示歷史卡片',
    });

    // --- pure projection (tested) ---------------------------------------------

    const CARD_RE = /<card id="([^"]+)" seqs="([^"]*)" depth="(\d+)">\n([\s\S]*?)\n<\/card>/g;
    const OVERVIEW_RE = /<overview>\n([\s\S]*?)\n<\/overview>/;
    const MARKER = '<history-cards>';

    /** Undo the checkpoint's tag escaping for display. */
    function unescapeBody(text) {
      return String(text).replace(/<\\(\/?)(card|overview|history-cards)/gi, '<$1$2');
    }

    /** Count events in an encoded seq list such as "3-9,12". */
    function countSeqs(text) {
      let total = 0;
      for (const part of String(text).split(',')) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
        if (!match) continue;
        total += (match[2] === undefined ? 0 : Number(match[2]) - Number(match[1])) + 1;
      }
      return total;
    }

    /** Parse a cards checkpoint; undefined for any other summary text. */
    function parseCheckpoint(text) {
      if (typeof text !== 'string' || !text.includes(MARKER)) return undefined;
      const overview = OVERVIEW_RE.exec(text);
      if (!overview) return undefined;
      const cards = [];
      for (const match of text.matchAll(CARD_RE)) {
        cards.push({ id: match[1], seqs: match[2], events: countSeqs(match[2]), depth: Number(match[3]), body: unescapeBody(match[4]) });
      }
      return { cards, overview: unescapeBody(overview[1]) };
    }

    /** Text of a compaction/summary's content blocks. */
    function summaryText(data) {
      const blocks = Array.isArray(data && data.summary) ? data.summary : [];
      return blocks.filter((block) => block && block.type === 'text').map((block) => block.text).join('');
    }

    function errorText(error) {
      if (typeof error === 'string') return error;
      if (Array.isArray(error)) return error.map((item) => (item && item.message) || String(item)).join(': ');
      if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
      return 'unknown error';
    }

    /** Fold one lifecycle event into the row state. */
    function fold(state, event) {
      const base = state || { status: 'running' };
      const data = event.data || {};
      if (event.type === 'compaction/start') {
        return { ...base, status: base.status === 'running' ? 'running' : base.status, seq: event.seq, startTime: event.time, manual: data.sourceCommandId !== undefined };
      }
      if (event.type === 'compaction/summary') {
        const parsed = parseCheckpoint(summaryText(data));
        return {
          ...base,
          seq: base.seq === undefined ? event.seq : base.seq,
          manual: base.manual || data.sourceCommandId !== undefined,
          cards: parsed ? parsed.cards : undefined,
          overview: parsed ? parsed.overview : undefined,
          replacedEvents: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined,
          replacedTokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined,
        };
      }
      if (event.type === 'compaction/end') {
        const failed = data.error !== undefined;
        return {
          ...base,
          seq: base.seq === undefined ? event.seq : base.seq,
          manual: base.manual || data.sourceCommandId !== undefined,
          status: failed ? 'failed' : 'done',
          endTime: event.time,
          ...(failed ? { error: errorText(data.error) } : {}),
        };
      }
      return base;
    }

    /** Row data, or null when another surface already shows this compaction. */
    function rowOf(state) {
      if (!state || state.seq === undefined || state.manual) return null;
      if (state.status === 'running') return { status: 'running', startTime: state.startTime };
      if (state.status === 'failed') return { status: 'failed', error: state.error };
      if (state.cards === undefined) return null;
      return {
        status: 'done',
        cards: state.cards,
        overview: state.overview,
        replacedEvents: state.replacedEvents,
        replacedTokens: state.replacedTokens,
      };
    }

    function formatElapsed(ms) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }

    function matchEvent(event) {
      if (event.type !== 'compaction/start' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') return null;
      const id = event.data && event.data.compactionId;
      if (typeof id !== 'string' || id === '') return null;
      return { id, role: event.type === 'compaction/start' ? 'start' : 'update' };
    }

    const definition = {
      kind: DEFINITION,
      target: 'chat',
      match: matchEvent,
      start: (_context, match) => fold(undefined, match.event),
      update: (context, match) => fold(context.state, match.event),
      buildViewNode: (context) => {
        const row = rowOf(context.state);
        if (row === null) return null;
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.state.seq + 0.05,
          location: (context.start && context.start.location) || (context.matches[0] && context.matches[0].location) || { kind: 'unresolved' },
          visibility: 'visible',
          data: row,
        };
      },
    };

    // --- view --------------------------------------------------------------------

    const CSS = `
.cc-row{padding:2px 0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px)}
.cc-head{display:flex;align-items:center;gap:8px;width:100%;min-height:24px;padding:0;border:none;background:none;color:inherit;font:inherit;text-align:left;border-radius:6px}
.cc-head:not(:disabled){cursor:pointer}
@media (hover:hover){.cc-head:not(:disabled):hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}}
.cc-head:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.cc-icon{flex:none;width:16px;text-align:center}
.cc-title{flex:none}
.cc-sum{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row[data-status="failed"] .cc-title,.cc-row[data-status="failed"] .cc-sum{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.cc-body{margin:6px 0 4px 24px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary)}
.cc-card{border:1px solid var(--dsw-alias-label-caption);border-radius:6px;padding:6px 8px}
.cc-card-head{display:flex;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.cc-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary)}
.cc-text{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.cc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return () => {};
      let tag = document.querySelector(`style[data-plugin-css="${STYLE_KEY}"]`);
      if (!tag) {
        tag = document.createElement('style');
        tag.dataset.pluginCss = STYLE_KEY;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      return () => tag.remove();
    }

    /** Elapsed time that ticks while the row is running. */
    function useElapsed(startTime, running) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [running]);
      return typeof startTime === 'number' ? now - startTime : 0;
    }

    function CardView({ card, t }) {
      return h('div', { className: 'cc-card' },
        h('div', { className: 'cc-card-head' },
          h('span', { className: 'cc-id' }, card.id),
          h('span', null, t('card.meta', { seqs: card.seqs, events: card.events })),
          card.depth > 0 ? h('span', null, t('card.archive', { depth: card.depth })) : null),
        h('pre', { className: 'cc-text' }, card.body));
    }

    function CardsRow({ node, t }) {
      const row = node.data;
      const [open, setOpen] = React.useState(false);
      const elapsed = useElapsed(row.startTime, row.status === 'running');
      const expandable = row.status !== 'running';
      const icon = row.status === 'running' ? '↻' : row.status === 'failed' ? '!' : '▤';
      const summary = row.status === 'running'
        ? t('summary.running', { elapsed: formatElapsed(elapsed) })
        : row.status === 'failed'
          ? t('summary.failed', { error: row.error })
          : t('summary.done', { cards: row.cards.length, events: row.replacedEvents ?? '?', tokens: row.replacedTokens ?? '?' });
      return h('div', { className: 'cc-row', 'data-status': row.status, 'data-cards-compaction': '' },
        h('button', {
          type: 'button',
          className: 'cc-head',
          disabled: !expandable,
          'aria-expanded': expandable ? open : undefined,
          'aria-label': expandable ? t('aria.toggle') : undefined,
          onClick: () => setOpen((value) => !value),
        },
          h('span', { className: 'cc-icon', 'aria-hidden': 'true' }, icon),
          h('span', { className: 'cc-title' }, t(`title.${row.status}`)),
          h('span', { className: 'cc-sum' }, summary)),
        open && expandable ? h('div', { className: 'cc-body' },
          row.status === 'failed'
            ? [h('pre', { key: 'e', className: 'cc-text' }, row.error), h('div', { key: 'h', className: 'cc-hint' }, t('hint.failed'))]
            : [
              ...row.cards.map((card) => h(CardView, { key: card.id, card, t })),
              h('div', { key: 'o', className: 'cc-card' },
                h('div', { className: 'cc-card-head' }, t('overview')),
                h('pre', { className: 'cc-text' }, row.overview)),
              h('div', { key: 'h', className: 'cc-hint' }, t('hint.done')),
            ]) : null);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'cards-compaction: dictionaries');
      ctx.effect(() => ensureStyle(), 'cards-compaction: style');
      ctx.effect(() => ctx.uiConversation.events.register(definition), 'cards-compaction: definition');
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: KIND,
        locale: NS,
      }, CardsRow));
    }

    return {
      name: 'dsh-cards-compaction',
      inject: ['slots', 'locale', 'uiConversation'],
      apply,
      /** Pure helpers for node:test; not part of the plugin contract. */
      internals: { EN, ZH, parseCheckpoint, countSeqs, fold, rowOf, matchEvent, definition, formatElapsed, CardsRow },
    };
  },
});
