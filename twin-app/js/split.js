/* ==========================================================================
   Money Splits — web client

   Owns the #view-split section of the dashboard and nothing else. Exposes
   window.splitApp so app.js can call splitApp.open() when the nav item is
   clicked, matching how tax.js and live-life.js are wired.

   Three rules this file follows throughout:

   1. **The server owns the money.** Every amount rendered here comes from a
      `{minor, amount, display, currency, symbol}` object the API built. The
      client never divides by 100, never rounds, and never re-adds shares — if
      it did, the careful integer arithmetic on the server would be undone on
      the last hop to the screen. The one exception is the live preview inside
      the Add Expense sheet, which mirrors the server's largest-remainder
      algorithm so the user can see the split before saving; that preview is
      never submitted, only the raw inputs are.

   2. **Render from a fetch, not from a guess.** After any mutation the
      affected screen is re-fetched rather than patched locally, so what the
      user sees is always what the balance engine computed.

   3. **Every string from the API is escaped.** Group names, descriptions and
      display names are user input, and they end up in innerHTML.

   Emoji are used as visual anchors, never as the only carrier of meaning: an
   expense's category emoji sits next to its written category, a group's emoji
   next to its name. A screen reader user loses nothing by ignoring them, which
   is why they are marked aria-hidden wherever a text equivalent is adjacent.
   ========================================================================== */
(function () {
  'use strict';

  const S = {
    tab: 'groups',
    groupId: null,
    friendId: null,
    // Set from an invitation deep link before anything renders; consumed by
    // the first open() so the user lands in the group they were invited to.
    pendingGroupId: null,
    me: null,
    entitlements: null,
    groups: [],
    friends: [],
    inboxOpen: false
  };

  /* ============ Utilities ============ */

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  /** Money classes: green when the user is up, coral when down, neutral at
   *  zero. Defined once so no screen invents its own convention — the colour
   *  is the meaning, so it has to agree everywhere. */
  function toneOf(minor) {
    if (minor > 0) return 'is-owed';
    if (minor < 0) return 'is-owe';
    return 'is-flat';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    // The API sends naive UTC timestamps; without the Z, Date() would read them
    // as local time and every entry would appear hours out.
    const then = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z');
    const secs = Math.floor((Date.now() - then.getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function money(m) { return m ? m.display : ''; }

  /** Amounts are shown as magnitudes with the direction carried by colour and
   *  a label ("you owe"), so a minus sign would be saying it twice. */
  function abs(m) { return m ? m.display.replace('-', '') : ''; }

  /* ==========================================================================
     EMOJI
     Visual anchors. Kept as data rather than sprinkled through templates so
     the vocabulary is consistent across the group list, the expense rows, the
     activity feed and the notification inbox.
     ========================================================================== */

  const CATEGORY_EMOJI = {
    'Food & Dining': '🍕',
    'Groceries': '🛒',
    'Rent / Housing': '🏠',
    'Utilities & Bills': '💡',
    'Travel & Transport': '🚗',
    'Entertainment': '🎬',
    'Shopping': '🛍️',
    'Health & Medical': '🏥',
    'Accommodation': '🏨',
    'Fuel': '⛽',
    'Gifts': '🎁',
    'Other': '🧾'
  };

  // Fallback when no category was chosen: guess from what the expense is
  // called. Ordered, first match wins, so "dinner drinks" reads as dinner.
  const DESCRIPTION_HINTS = [
    [/\b(dinner|lunch|breakfast|brunch|food|restaurant|meal|pizza|burger)\b/i, '🍕'],
    [/\b(coffee|cafe|café|chai|tea|starbucks)\b/i, '☕'],
    [/\b(beer|bar|drinks|pub|cocktail|wine|party)\b/i, '🍻'],
    [/\b(movie|cinema|film|netflix|show)\b/i, '🍿'],
    [/\b(hotel|villa|stay|airbnb|resort|hostel|room)\b/i, '🏨'],
    [/\b(flight|plane|airline|airfare)\b/i, '✈️'],
    [/\b(train|rail|metro)\b/i, '🚆'],
    [/\b(cab|taxi|uber|ola|auto|ride)\b/i, '🚕'],
    [/\b(petrol|diesel|fuel|gas)\b/i, '⛽'],
    [/\b(grocer|supermarket|vegetables|milk)\b/i, '🛒'],
    [/\b(rent|deposit|maintenance)\b/i, '🏠'],
    [/\b(electricity|water|wifi|internet|bill|recharge)\b/i, '💡'],
    [/\b(ticket|concert|event|entry)\b/i, '🎟️'],
    [/\b(gift|present|birthday)\b/i, '🎁'],
    [/\b(medicine|doctor|pharmacy|hospital|clinic)\b/i, '🏥'],
    [/\b(scooter|bike|rental|car)\b/i, '🛵'],
    [/\b(beach|snorkel|dive|water sports|surf)\b/i, '🏄'],
    [/\b(shopping|clothes|shoes|mall)\b/i, '🛍️']
  ];

  function expenseEmoji(expense) {
    if (expense.category && CATEGORY_EMOJI[expense.category]) return CATEGORY_EMOJI[expense.category];
    const text = expense.description || '';
    for (const [re, emoji] of DESCRIPTION_HINTS) if (re.test(text)) return emoji;
    return '🧾';
  }

  const GROUP_TYPE_EMOJI = {
    trip: '✈️', home: '🏠', couple: '💞', friends: '👥', other: '🎉'
  };

  // The picker offered when creating a group. Curated rather than a full emoji
  // keyboard: the point is a fast, recognisable choice, not completeness.
  const GROUP_EMOJI_CHOICES = [
    '✈️', '🏝️', '🏔️', '🗺️', '🏠', '🛏️', '🍽️', '🍕',
    '🍻', '🎉', '🎂', '🎬', '🎵', '🏏', '⚽', '🎮',
    '🚗', '🛵', '🚆', '⛺', '🎓', '💼', '💞', '👥',
    '🐶', '☕', '🛒', '💰'
  ];

  const ACTIVITY_EMOJI = {
    expense_added: '🧾', expense_updated: '✏️', expense_deleted: '🗑️',
    settlement_added: '💸', settlement_deleted: '↩️',
    group_created: '✨', member_added: '👋', member_left: '👋',
    friend_added: '🤝', invite_sent: '📨', invite_accepted: '🎉'
  };

  const NOTIFICATION_EMOJI = {
    split_expense_added: '🧾', split_expense_updated: '✏️', split_expense_deleted: '🗑️',
    split_settlement_received: '💸', split_settlement_recorded: '💰',
    split_group_invite: '👥', split_group_member_added: '🎉',
    split_friend_added: '🤝', split_friend_request: '🤝',
    split_you_are_owed: '💚', split_you_owe: '🧡'
  };

  const MODES = [
    { id: 'equal',    label: 'Equally',       emoji: '⚖️' },
    { id: 'exact',    label: 'Exact amounts', emoji: '💰' },
    { id: 'percent',  label: 'Percentages',   emoji: '📊' },
    { id: 'shares',   label: 'Shares',        emoji: '🔢' },
    { id: 'itemized', label: 'Items',         emoji: '🧾' }
  ];

  const TABS = [
    { id: 'groups',   label: 'Groups',   emoji: '👥' },
    { id: 'friends',  label: 'Friends',  emoji: '🤝' },
    { id: 'activity', label: 'Activity', emoji: '🔔' },
    { id: 'account',  label: 'Account',  emoji: '⚙️' }
  ];

  /* ============ Feedback ============ */

  function toast(message, emoji) {
    let el = $('#spToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'spToast';
      el.className = 'sp-toast';
      document.body.appendChild(el);
    }
    el.innerHTML = `${emoji ? `<span class="sp-toast__emoji" aria-hidden="true">${emoji}</span>` : ''}<span></span>`;
    el.lastElementChild.textContent = message;
    el.classList.add('is-on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('is-on'), 3200);
  }

  /** A brief confirmation after money is booked. Short by design — it marks
   *  the moment and gets out of the way rather than making anyone wait. */
  function burst(emoji) {
    const el = document.createElement('div');
    el.className = 'sp-burst';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="sp-burst__ring">${emoji || '✅'}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 800);
  }

  /** Turns an API error into something a person can act on. A 402 is not a
   *  failure — it is a locked feature — so it gets its own path. */
  function handleError(err) {
    if (err && err.status === 402) {
      const d = err.detail || {};
      toast(`${d.message || 'This is a Premium feature'} — available on MoneyKal Premium`, '✨');
      return;
    }
    toast((err && err.message) || 'Something went wrong', '⚠️');
  }

  function avatar(person, size) {
    const cls = 'sp-av' + (size ? ` sp-av--${size}` : '') + (person.is_guest ? ' sp-av--guest' : '');
    const style = person.is_guest ? '' : ` style="background:${esc(person.avatar_color || 'var(--sp-cyan)')}"`;
    const title = esc(person.display_name || person.name || '')
      + (person.is_guest ? ' (invited, not yet on MoneyKal)' : '');
    return `<span class="${cls}"${style} title="${title}">${esc(person.initials || '?')}</span>`;
  }

  /** Stacked avatars with an overflow count, for a group's member row. */
  function avatarStack(people, max) {
    max = max || 4;
    const shown = people.slice(0, max);
    const extra = people.length - shown.length;
    return `<span class="sp-avs">${shown.map(p => avatar(p, 'xs')).join('')}` +
      (extra > 0 ? `<span class="sp-av sp-av--xs sp-avs__more">+${extra}</span>` : '') + '</span>';
  }

  /* ==========================================================================
     SHELL
     ========================================================================== */

  function renderShell() {
    const root = $('#view-split');
    if (!root) return;
    root.innerHTML = `
      <div class="sp-wrap">
        <div id="spTop">
        <header class="sp-hero">
          <div class="sp-hero__inner">
            <span class="sp-hero__eyebrow"><span aria-hidden="true">✨</span> Splitting is free — for you and everyone you split with</span>
            <div class="sp-hero__heading">
              <h1 class="sp-hero__title">Money Splits</h1>
              <button type="button" class="feature-info-btn" data-feature-info="split"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="featureInfoPanel"
                aria-label="About this feature" title="About this feature">i</button>
            </div>
            <p class="sp-hero__sub">Split expenses. Stay even. Keep your friendships simple.</p>
            <div class="sp-hero__cta">
              <button class="sp-btn sp-btn--primary sp-btn--lg" id="spHeroAdd">
                <span aria-hidden="true">➕</span> Add Expense
              </button>
              <button class="sp-btn sp-btn--secondary sp-btn--lg" id="spHeroGroup">
                <span aria-hidden="true">👥</span> Create Group
              </button>
            </div>
          </div>
        </header>

        <div id="spSummary"></div>
        </div>

        <div class="sp-tabs" role="tablist" aria-label="Money Splits sections">
          ${TABS.map(t => `
            <button class="sp-tab${t.id === S.tab ? ' is-active' : ''}" data-tab="${t.id}"
                    role="tab" aria-selected="${t.id === S.tab}">
              <span class="sp-tab__emoji" aria-hidden="true">${t.emoji}</span>${t.label}
            </button>`).join('')}
        </div>

        <div id="spBody"></div>
      </div>
      <button class="sp-fab" id="spFab" title="Add an expense" aria-label="Add an expense">+</button>
    `;
    $$('.sp-tab', root).forEach(btn => {
      btn.addEventListener('click', () => {
        S.tab = btn.dataset.tab;
        S.groupId = null;
        S.friendId = null;
        renderShell();
        renderSummary();
        renderBody();
      });
    });
    $('#spFab').addEventListener('click', () => openExpenseModal({ groupId: S.groupId }));
    $('#spHeroAdd').addEventListener('click', () => openExpenseModal({ groupId: S.groupId }));
    $('#spHeroGroup').addEventListener('click', openGroupModal);
  }

  function renderSummary() {
    const el = $('#spSummary');
    if (!el || !S.me) return;
    const s = S.me.summary;
    const settled = s.status === 'settled';
    el.innerHTML = `
      <div class="sp-summary">
        <div class="sp-stat sp-stat--owed">
          <div class="sp-stat__label"><span aria-hidden="true">💚</span> You're owed</div>
          <div class="sp-stat__amount sp-pop">${esc(abs(s.owed_to_you))}</div>
          <div class="sp-stat__sub">Money coming back to you</div>
        </div>
        <div class="sp-stat sp-stat--owe">
          <div class="sp-stat__label"><span aria-hidden="true">🧡</span> You owe</div>
          <div class="sp-stat__amount sp-pop">${esc(abs(s.you_owe))}</div>
          <div class="sp-stat__sub">Still to settle up</div>
        </div>
        <div class="sp-stat sp-stat--flat">
          <div class="sp-stat__label"><span aria-hidden="true">${settled ? '✨' : '⚖️'}</span> ${settled ? 'Settled up' : 'Net position'}</div>
          <div class="sp-stat__amount sp-pop">${esc(abs(s.net))}</div>
          <div class="sp-stat__sub">${
            settled ? 'Everything is even — nice.'
              : s.status === 'owed' ? 'In your favour across everything'
                : 'Owed by you across everything'
          }</div>
        </div>
      </div>`;
  }

  function renderBody() {
    const body = $('#spBody');
    if (!body) return;
    const top = $('#spTop');
    if (top) top.hidden = !!(S.groupId || S.friendId);
    body.innerHTML = '<div class="sp-empty"><span class="sp-empty__emoji" aria-hidden="true">⏳</span><div class="sp-empty__text">Loading…</div></div>';
    if (S.groupId) return renderGroupDetail();
    if (S.friendId) return renderFriendDetail();
    if (S.tab === 'groups') return renderGroups();
    if (S.tab === 'friends') return renderFriends();
    if (S.tab === 'activity') return renderActivity();
    if (S.tab === 'account') return renderAccount();
  }

  /* ==========================================================================
     GROUPS
     ========================================================================== */

  function groupEmoji(g) {
    return g.emoji || GROUP_TYPE_EMOJI[g.group_type] || '👥';
  }

  function groupCard(g) {
    const tone = g.status === 'settled' ? 'flat' : (g.status === 'owed' ? 'owed' : 'owe');
    const names = (g.member_names || []).join(' • ');
    const members = g.members || [];
    return `
      <article class="sp-gcard sp-gcard--${tone}" data-group="${g.id}" tabindex="0" role="button"
               aria-label="Open ${esc(g.name)}">
        <div class="sp-gcard__top">
          <span class="sp-gcard__emoji" aria-hidden="true">${esc(groupEmoji(g))}</span>
          <div style="min-width:0;flex:1">
            <div class="sp-gcard__name">${esc(g.name)}</div>
            <div class="sp-gcard__meta">${g.member_count} member${g.member_count === 1 ? '' : 's'}${
              g.is_archived ? ' · archived' : ''}</div>
          </div>
        </div>

        <div class="sp-gcard__balance ${toneOf(g.your_balance.minor)}">
          <span aria-hidden="true">${g.status === 'settled' ? '✨' : g.status === 'owed' ? '💚' : '🧡'}</span>
          <span>${
            g.status === 'settled' ? 'Settled up'
              : `${g.status === 'owed' ? 'You are owed' : 'You owe'} ${esc(abs(g.your_balance))}`
          }</span>
        </div>

        <div class="sp-gcard__people">
          ${members.length ? avatarStack(members) : ''}
          <span class="sp-gcard__names">${esc(names)}</span>
        </div>

        <div class="sp-gcard__foot">
          <span>${g.expense_count || 0} expense${g.expense_count === 1 ? '' : 's'}</span>
          <span class="sp-gcard__arrow" aria-hidden="true">→</span>
        </div>
      </article>`;
  }

  async function renderGroups() {
    const body = $('#spBody');
    try {
      const data = await window.api.split.groups();
      S.groups = data.groups;

      if (!S.groups.length) {
        body.innerHTML = `
          <div class="sp-empty">
            <span class="sp-empty__emoji" aria-hidden="true">✨</span>
            <div class="sp-empty__title">Create your first Money Split</div>
            <div class="sp-empty__text">Trips, roommates, dinners, parties — keep everything together and let MoneyKal work out who owes what.</div>
            <button class="sp-btn sp-btn--secondary" id="spNewGroup"><span aria-hidden="true">➕</span> Create Group</button>
          </div>`;
        $('#spNewGroup').addEventListener('click', openGroupModal);
        return;
      }

      body.innerHTML = `
        <div class="sp-sec">
          <div class="sp-sec__head">
            <span class="sp-sec__title"><span aria-hidden="true">👥</span> Your groups</span>
            <button class="sp-sec__action" id="spNewGroup">+ New group</button>
          </div>
          <div class="sp-gcards">
            ${S.groups.map(groupCard).join('')}
            <article class="sp-gcard sp-gcard--new" id="spNewGroupCard" tabindex="0" role="button"
                     aria-label="Create a group">
              <span class="sp-gcard--new__icon" aria-hidden="true">➕</span>
              <span class="sp-gcard--new__title">Create a group</span>
              <span class="sp-gcard--new__sub">A trip, a flat, a dinner series — anything you share costs on.</span>
            </article>
          </div>
        </div>`;

      $('#spNewGroup').addEventListener('click', openGroupModal);
      $('#spNewGroupCard').addEventListener('click', openGroupModal);
      $('#spNewGroupCard').addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openGroupModal(); }
      });
      $$('.sp-gcard[data-group]', body).forEach(card => {
        const open = () => { S.groupId = Number(card.dataset.group); renderBody(); };
        card.addEventListener('click', open);
        card.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
        });
      });
    } catch (e) { handleError(e); body.innerHTML = ''; }
  }

  /* ==========================================================================
     GROUP DETAIL
     ========================================================================== */

  async function renderGroupDetail() {
    const body = $('#spBody');
    try {
      const d = await window.api.split.group(S.groupId);
      const g = d.group;
      const s = d.summary;
      const premium = S.entitlements && S.entitlements.is_premium;

      const settleRows = d.settle_suggestions.length
        ? d.settle_suggestions.map(t => `
            <div class="sp-settle">
              <div class="sp-settle__text"><b>${esc(t.from.name)}</b> pays <b>${esc(t.to.name)}</b></div>
              <span class="sp-settle__amt">${esc(money(t.amount))}</span>
              <button class="sp-btn sp-btn--secondary sp-btn--sm" data-settle
                      data-from="${t.from.id}" data-to="${t.to.id}" data-amt="${esc(t.amount.amount)}">
                <span aria-hidden="true">💸</span> Record
              </button>
            </div>`).join('')
        : `<div class="sp-empty" style="padding:30px 20px">
             <span class="sp-empty__emoji" aria-hidden="true">✨</span>
             <div class="sp-empty__text" style="margin-bottom:0">Everyone here is settled up.</div>
           </div>`;

      const maxCat = Math.max(1, ...d.by_category.map(c => c.amount.minor));
      const maxMember = Math.max(1, ...d.members.map(m => m.share.minor));

      body.innerHTML = `
        <button class="sp-back" id="spBack"><span aria-hidden="true">←</span> All groups</button>

        <div class="sp-ghead">
          <span class="sp-ghead__emoji" aria-hidden="true">${esc(groupEmoji(g))}</span>
          <div class="sp-ghead__main">
            <div class="sp-ghead__name">${esc(g.name)}</div>
            <div class="sp-ghead__sub">
              ${d.members.length} member${d.members.length === 1 ? '' : 's'} ·
              ${s.expense_count} expense${s.expense_count === 1 ? '' : 's'} ·
              ${esc(money(s.total_spent))} total
            </div>
          </div>
          <div class="sp-ghead__actions">
            <button class="sp-btn sp-btn--primary sp-btn--sm" id="spAddExp"><span aria-hidden="true">➕</span> Add expense</button>
            <button class="sp-btn sp-btn--secondary sp-btn--sm" id="spInvite"><span aria-hidden="true">📨</span> Invite</button>
            <button class="sp-btn sp-btn--ghost sp-btn--sm" id="spSettings"><span aria-hidden="true">⚙️</span> Settings</button>
            <button class="sp-btn sp-btn--ghost sp-btn--sm" id="spExport">
              <span aria-hidden="true">📤</span> Export${premium ? '' : '<span class="sp-lock">Pro</span>'}
            </button>
          </div>
        </div>

        <div class="sp-summary">
          <div class="sp-stat sp-stat--${s.status === 'settled' ? 'flat' : (s.status === 'owed' ? 'owed' : 'owe')}">
            <div class="sp-stat__label">
              <span aria-hidden="true">${s.status === 'settled' ? '✨' : s.status === 'owed' ? '💚' : '🧡'}</span>
              ${s.status === 'settled' ? 'Settled up here' : s.status === 'owed' ? "You're owed here" : 'You owe here'}
            </div>
            <div class="sp-stat__amount sp-pop">${esc(s.status === 'settled' ? s.net.symbol + '0' : abs(s.net))}</div>
            <div class="sp-stat__sub">${s.status === 'settled' ? 'Nothing outstanding in this group' : 'Across every expense here'}</div>
          </div>
          <div class="sp-stat sp-stat--flat">
            <div class="sp-stat__label"><span aria-hidden="true">📊</span> Group total</div>
            <div class="sp-stat__amount sp-pop">${esc(money(s.total_spent))}</div>
            <div class="sp-stat__sub">Your share: ${esc(money(s.your_total_share))}</div>
          </div>
        </div>

        <div class="sp-two">
          <div class="sp-two__main">
            <div class="sp-sec">
              <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">🧾</span> Expenses</span></div>
              ${d.expenses.length ? `<ul class="sp-list">${d.expenses.map(expenseRow).join('')}</ul>` : `
                <div class="sp-empty">
                  <span class="sp-empty__emoji" aria-hidden="true">🧾</span>
                  <div class="sp-empty__title">No expenses yet</div>
                  <div class="sp-empty__text">Add the first one and MoneyKal will work out who owes what.</div>
                  <button class="sp-btn sp-btn--primary" id="spAddExp2"><span aria-hidden="true">➕</span> Add Expense</button>
                </div>`}
            </div>

            ${d.settlements.length ? `
              <div class="sp-sec">
                <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">💰</span> Settlement history</span></div>
                <ul class="sp-list">
                  ${d.settlements.map(st => `
                    <li class="sp-row sp-row--static">
                      <span class="sp-row__emoji" aria-hidden="true">💸</span>
                      <div class="sp-row__body">
                        <div class="sp-row__title">${esc(st.from ? st.from.name : '?')} paid ${esc(st.to ? st.to.name : '?')}</div>
                        <div class="sp-row__meta">${esc(st.date || '')}${st.method ? ' · ' + esc(st.method) : ''}${st.note ? ' · ' + esc(st.note) : ''}</div>
                      </div>
                      <div class="sp-row__right">
                        <div class="sp-row__amount is-flat">${esc(money(st.amount))}</div>
                        <button class="sp-sec__action" data-unsettle="${st.id}">undo</button>
                      </div>
                    </li>`).join('')}
                </ul>
              </div>` : ''}

            <div class="sp-sec">
              <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">🔔</span> Activity</span></div>
              ${d.activity.length ? `<div class="sp-feed">${d.activity.map(activityRow).join('')}</div>` : `
                <div class="sp-empty" style="padding:30px 20px">
                  <span class="sp-empty__emoji" aria-hidden="true">🔔</span>
                  <div class="sp-empty__text" style="margin-bottom:0">Nothing has happened here yet.</div>
                </div>`}
            </div>
          </div>

          <aside class="sp-two__side">
            <div class="sp-sec">
              <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">💸</span> Settle up</span></div>
              ${settleRows}
              ${g.simplify_debts && d.settle_suggestions.length && d.balances.length > d.settle_suggestions.length
                ? `<div class="sp-hint">✨ Simplified from ${d.balances.length} debts down to ${d.settle_suggestions.length}.</div>` : ''}
            </div>

            <div class="sp-sec">
              <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">⚖️</span> Balances</span></div>
              <div class="sp-bals">
                ${d.members.map(m => {
                  const net = m.net.minor;
                  const tone = net === 0 ? 'flat' : (net > 0 ? 'owed' : 'owe');
                  const text = net === 0
                    ? `<b>${esc(m.name)}</b> is settled up`
                    : (m.is_you
                        ? (net > 0 ? `<b>You</b> are owed` : `<b>You</b> owe the group`)
                        : (net > 0 ? `<b>${esc(m.name)}</b> is owed` : `<b>${esc(m.name)}</b> owes`));
                  return `
                    <div class="sp-bal sp-bal--${tone}">
                      ${avatar(m, 'sm')}
                      <div class="sp-bal__body"><div class="sp-bal__text">${text}</div></div>
                      <span class="sp-bal__amt">${esc(net === 0 ? '—' : abs(m.net))}</span>
                    </div>`;
                }).join('')}
              </div>
            </div>

            <div class="sp-sec">
              <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">📊</span> Totals by member</span></div>
              <div class="sp-bars">
                ${d.members.map(m => `
                  <div class="sp-bar">
                    <div class="sp-bar__top">
                      <span class="sp-bar__label">${esc(m.name)}</span>
                      <span class="sp-bar__value">${esc(money(m.share))}</span>
                    </div>
                    <div class="sp-bar__track">
                      <div class="sp-bar__fill" style="width:${Math.round(m.share.minor / maxMember * 100)}%"></div>
                    </div>
                  </div>`).join('')}
              </div>
            </div>

            ${d.by_category.length ? `
              <div class="sp-sec">
                <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">🍕</span> Where it went</span></div>
                <div class="sp-bars">
                  ${d.by_category.slice(0, 8).map(c => `
                    <div class="sp-bar">
                      <div class="sp-bar__top">
                        <span class="sp-bar__label">${esc(CATEGORY_EMOJI[c.category] || '🧾')} ${esc(c.category)}</span>
                        <span class="sp-bar__value">${esc(money(c.amount))}</span>
                      </div>
                      <div class="sp-bar__track">
                        <div class="sp-bar__fill sp-bar__fill--muted" style="width:${Math.round(c.amount.minor / maxCat * 100)}%"></div>
                      </div>
                    </div>`).join('')}
                </div>
              </div>` : ''}

            <div class="sp-sec">
              <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">👥</span> Members</span></div>
              ${d.members.map(m => `
                <div class="sp-row sp-row--static">
                  ${avatar(m, 'sm')}
                  <div class="sp-row__body">
                    <div class="sp-row__title">${esc(m.name)}</div>
                    <div class="sp-row__meta">${m.is_guest ? '📨 Invited — not on MoneyKal yet' : esc(m.email || '')}</div>
                  </div>
                  ${(g.is_owner && !m.is_you) || m.is_you
                    ? `<button class="sp-sec__action" data-remove="${m.id}">${m.is_you ? 'leave' : 'remove'}</button>` : ''}
                </div>`).join('')}
              <button class="sp-btn sp-btn--ghost sp-btn--sm" id="spAddMember" style="margin-top:12px;width:100%">
                <span aria-hidden="true">➕</span> Add member
              </button>
            </div>
          </aside>
        </div>`;

      $('#spBack').addEventListener('click', () => { S.groupId = null; renderBody(); });
      const addExp = () => openExpenseModal({ groupId: S.groupId, members: d.members, currency: g.currency });
      $('#spAddExp').addEventListener('click', addExp);
      if ($('#spAddExp2')) $('#spAddExp2').addEventListener('click', addExp);
      $('#spInvite').addEventListener('click', () => openInviteModal(S.groupId));
      $('#spSettings').addEventListener('click', () => openGroupSettings(g));
      $('#spExport').addEventListener('click', () => doExport(S.groupId));
      $('#spAddMember').addEventListener('click', () => openInviteModal(S.groupId));

      $$('[data-settle]', body).forEach(btn => btn.addEventListener('click', () => {
        openSettleModal({
          groupId: S.groupId, members: d.members, currency: g.currency,
          from: Number(btn.dataset.from), to: Number(btn.dataset.to), amount: btn.dataset.amt
        });
      }));
      $$('[data-expense]', body).forEach(row => row.addEventListener('click', () => {
        openExpenseModal({ groupId: S.groupId, members: d.members, currency: g.currency,
                           expenseId: Number(row.dataset.expense) });
      }));
      $$('[data-unsettle]', body).forEach(btn => btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(window.t('Undo this settlement? The balance it cleared will come back.'))) return;
        try {
          await window.api.split.deleteSettlement(Number(btn.dataset.unsettle));
          toast('Settlement removed', '↩️');
          await refresh();
        } catch (e) { handleError(e); }
      }));
      $$('[data-remove]', body).forEach(btn => btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const pid = Number(btn.dataset.remove);
        const leaving = pid === S.me.person.id;
        if (!confirm(window.t(leaving ? 'Leave this group?' : 'Remove this member from the group?'))) return;
        try {
          await window.api.split.removeMember(S.groupId, pid);
          toast(leaving ? 'You left the group' : 'Member removed', '👋');
          if (leaving) S.groupId = null;
          await refresh();
        } catch (e) { handleError(e); }
      }));
    } catch (e) {
      handleError(e);
      S.groupId = null;
      body.innerHTML = '';
    }
  }

  function expenseRow(e) {
    const net = e.your_net.minor;
    const payerNames = e.payers.map(p => p.person.name).join(', ');
    return `
      <li class="sp-row" data-expense="${e.id}">
        <span class="sp-row__emoji" aria-hidden="true">${expenseEmoji(e)}</span>
        <div class="sp-row__body">
          <div class="sp-row__title">${esc(e.description)}</div>
          <div class="sp-row__meta">${esc(payerNames)} paid ${esc(money(e.total))}${
            e.category ? ' · ' + esc(e.category) : ''} · ${esc(e.date || '')}</div>
        </div>
        <div class="sp-row__right">
          <div class="sp-row__amount ${toneOf(net)}">${esc(net === 0 ? '—' : abs(e.your_net))}</div>
          <div class="sp-row__note">${net === 0 ? 'not involved' : net > 0 ? 'you lent' : 'you borrowed'}</div>
        </div>
      </li>`;
  }

  /** One entry in the social feed. The server hands over the reader's own net
   *  for the event, so the impact line is per-person rather than a restatement
   *  of the expense. */
  function activityRow(a) {
    const emoji = (a.kind === 'expense_added' || a.kind === 'expense_updated')
      ? expenseEmoji({ category: a.meta && a.meta.category, description: (a.meta && a.meta.description) || '' })
      : (ACTIVITY_EMOJI[a.kind] || '🔔');

    // The server's summary ends with "in <group>"; the group is shown on its
    // own line, so the suffix is trimmed rather than repeated.
    let headline = a.summary || '';
    const where = a.group_name || '';
    if (where && headline.endsWith(' in ' + where)) {
      headline = headline.slice(0, -(' in ' + where).length);
    }

    // A settlement is stored neutrally ("Harshit paid Divij ₹500") because the
    // same row is read by both parties. Rewritten here from whoever is looking
    // at it, which is how a person would actually say it. Falls back to the
    // server's phrasing for rows written before this metadata existed.
    const me = S.me && S.me.person ? S.me.person.id : null;
    if (a.kind === 'settlement_added' && a.meta && a.amount && me) {
      const amt = money(a.amount);
      if (a.meta.to_person_id === me && a.meta.from_name) {
        headline = `${a.meta.from_name} paid you ${amt}`;
      } else if (a.meta.from_person_id === me && a.meta.to_name) {
        headline = `You paid ${a.meta.to_name} ${amt}`;
      }
    }

    let impact = '';
    if (a.your_net && a.your_net.minor !== 0) {
      const positive = a.your_net.minor > 0;
      impact = `<span class="sp-act__impact ${positive ? 'is-owed' : 'is-owe'}">${
        positive ? 'You get back' : 'You owe'} ${esc(abs(a.your_net))}</span>`;
    }

    return `
      <div class="sp-act sp-act--${esc(a.tone)}">
        <span class="sp-act__emoji" aria-hidden="true">${emoji}</span>
        <div class="sp-act__body">
          <div class="sp-act__text">${esc(headline)}</div>
          ${where ? `<div class="sp-act__where">${esc(where)}</div>` : ''}
          ${impact}
        </div>
        <span class="sp-act__time">${esc(timeAgo(a.created_at))}</span>
      </div>`;
  }

  /* ==========================================================================
     FRIENDS
     ========================================================================== */

  async function renderFriends() {
    const body = $('#spBody');
    try {
      const data = await window.api.split.friends();
      S.friends = data.friends;

      if (!S.friends.length) {
        body.innerHTML = `
          <div class="sp-empty">
            <span class="sp-empty__emoji" aria-hidden="true">👥</span>
            <div class="sp-empty__title">No friends yet</div>
            <div class="sp-empty__text">Invite your friends and start splitting. They can owe and be owed before they even sign up.</div>
            <button class="sp-btn sp-btn--secondary" id="spAddFriend2"><span aria-hidden="true">➕</span> Add Friends</button>
          </div>`;
        $('#spAddFriend2').addEventListener('click', openFriendModal);
        return;
      }

      body.innerHTML = `
        <div class="sp-sec">
          <div class="sp-sec__head">
            <span class="sp-sec__title"><span aria-hidden="true">🤝</span> Friends</span>
            <button class="sp-sec__action" id="spAddFriend">+ Add a friend</button>
          </div>
          <div class="sp-bals">
            ${S.friends.map(f => {
              const tone = f.status === 'settled' ? 'flat' : (f.status === 'owes_you' ? 'owed' : 'owe');
              const text = f.status === 'settled'
                ? `<b>${esc(f.display_name)}</b> — all settled up`
                : (f.status === 'owes_you'
                    ? `<b>${esc(f.display_name)}</b> owes you`
                    : `You owe <b>${esc(f.display_name)}</b>`);
              return `
                <div class="sp-bal sp-bal--${tone}" data-friend="${f.id}" role="button" tabindex="0"
                     style="cursor:pointer" aria-label="Open ${esc(f.display_name)}">
                  ${avatar(f)}
                  <div class="sp-bal__body">
                    <div class="sp-bal__text">${text}</div>
                    <div class="sp-row__meta">${f.is_guest ? '📨 Invited — not on MoneyKal yet' : esc(f.email || '')}</div>
                  </div>
                  <span class="sp-bal__amt">${esc(f.status === 'settled' ? '—' : abs(f.balance))}</span>
                </div>`;
            }).join('')}
          </div>
        </div>`;

      $('#spAddFriend').addEventListener('click', openFriendModal);
      $$('[data-friend]', body).forEach(row => {
        const open = () => { S.friendId = Number(row.dataset.friend); renderBody(); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
        });
      });
    } catch (e) { handleError(e); body.innerHTML = ''; }
  }

  async function renderFriendDetail() {
    const body = $('#spBody');
    try {
      const d = await window.api.split.friend(S.friendId);
      const f = d.friend;
      const tone = d.status === 'settled' ? 'flat' : (d.status === 'owes_you' ? 'owed' : 'owe');

      body.innerHTML = `
        <button class="sp-back" id="spBack"><span aria-hidden="true">←</span> All friends</button>

        <div class="sp-ghead">
          ${avatar(f, 'lg')}
          <div class="sp-ghead__main">
            <div class="sp-ghead__name">${esc(f.display_name)}</div>
            <div class="sp-ghead__sub">${f.is_guest ? '📨 Invited — not on MoneyKal yet' : esc(f.email || '')}</div>
          </div>
          <div class="sp-ghead__actions">
            <button class="sp-btn sp-btn--primary sp-btn--sm" id="spAddExp"><span aria-hidden="true">➕</span> Add expense</button>
            ${d.balance.minor !== 0
              ? '<button class="sp-btn sp-btn--ghost sp-btn--sm" id="spSettleUp"><span aria-hidden="true">💸</span> Settle up</button>' : ''}
          </div>
        </div>

        <div class="sp-summary">
          <div class="sp-stat sp-stat--${tone}">
            <div class="sp-stat__label">
              <span aria-hidden="true">${d.status === 'settled' ? '✨' : d.status === 'owes_you' ? '💚' : '🧡'}</span>
              ${d.status === 'settled' ? 'Between you' : d.status === 'owes_you' ? 'They owe you' : 'You owe them'}
            </div>
            <div class="sp-stat__amount sp-pop">${esc(d.balance.minor === 0 ? d.balance.symbol + '0' : abs(d.balance))}</div>
            <div class="sp-stat__sub">${d.status === 'settled' ? 'All settled up' : 'Across every shared expense'}</div>
          </div>
        </div>

        <div class="sp-sec">
          <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">🧾</span> Shared expenses</span></div>
          ${d.expenses.length ? `<ul class="sp-list">${d.expenses.map(expenseRow).join('')}</ul>` : `
            <div class="sp-empty" style="padding:30px 20px">
              <span class="sp-empty__emoji" aria-hidden="true">🧾</span>
              <div class="sp-empty__text" style="margin-bottom:0">Nothing shared yet.</div>
            </div>`}
        </div>

        ${d.settlements.length ? `
          <div class="sp-sec">
            <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">💰</span> Settlements</span></div>
            <ul class="sp-list">
              ${d.settlements.map(st => `
                <li class="sp-row sp-row--static">
                  <span class="sp-row__emoji" aria-hidden="true">💸</span>
                  <div class="sp-row__body">
                    <div class="sp-row__title">${esc(st.from.name)} paid ${esc(st.to.name)}</div>
                    <div class="sp-row__meta">${esc(st.date || '')}${st.method ? ' · ' + esc(st.method) : ''}</div>
                  </div>
                  <div class="sp-row__right"><div class="sp-row__amount is-flat">${esc(money(st.amount))}</div></div>
                </li>`).join('')}
            </ul>
          </div>` : ''}`;

      $('#spBack').addEventListener('click', () => { S.friendId = null; renderBody(); });
      $('#spAddExp').addEventListener('click', () => openExpenseModal({
        members: [{ ...S.me.person, name: 'You' }, { ...f, name: f.display_name }]
      }));
      if ($('#spSettleUp')) $('#spSettleUp').addEventListener('click', () => {
        const owesMe = d.balance.minor > 0;
        openSettleModal({
          members: [{ ...S.me.person, name: 'You' }, { ...f, name: f.display_name }],
          currency: d.balance.currency,
          from: owesMe ? f.id : S.me.person.id,
          to: owesMe ? S.me.person.id : f.id,
          amount: d.balance.amount.replace('-', '')
        });
      });
      $$('[data-expense]', body).forEach(row => row.addEventListener('click', () =>
        openExpenseModal({ expenseId: Number(row.dataset.expense),
                           members: [{ ...S.me.person, name: 'You' }, { ...f, name: f.display_name }] })));
    } catch (e) { handleError(e); S.friendId = null; body.innerHTML = ''; }
  }

  /* ==========================================================================
     ACTIVITY
     ========================================================================== */

  async function renderActivity() {
    const body = $('#spBody');
    try {
      const d = await window.api.split.activity({ limit: 80 });
      body.innerHTML = `
        <div class="sp-sec">
          <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">🔔</span> Recent activity</span></div>
          ${d.activity.length ? `<div class="sp-feed">${d.activity.map(activityRow).join('')}</div>` : `
            <div class="sp-empty">
              <span class="sp-empty__emoji" aria-hidden="true">🔔</span>
              <div class="sp-empty__title">No activity yet</div>
              <div class="sp-empty__text">Once you add an expense or settle up, everything that happens across your groups shows here.</div>
              <button class="sp-btn sp-btn--primary" id="spActAdd"><span aria-hidden="true">➕</span> Add Expense</button>
            </div>`}
        </div>`;
      if ($('#spActAdd')) $('#spActAdd').addEventListener('click', () => openExpenseModal({}));
    } catch (e) { handleError(e); body.innerHTML = ''; }
  }

  /* ==========================================================================
     ACCOUNT
     ========================================================================== */

  const PREMIUM_EMOJI = {
    split_ai_receipt: '🧾', split_advanced_charts: '📊', split_multi_currency: '🌎',
    split_advanced_search: '🔎', split_recurring: '🔄', split_smart_settlement: '🤖',
    split_export: '📤', split_insights: '💡'
  };
  const PREMIUM_TITLE = {
    split_ai_receipt: 'AI Receipt Split', split_advanced_charts: 'Smart Insights',
    split_multi_currency: 'Multi-Currency', split_advanced_search: 'Advanced Search',
    split_recurring: 'Recurring Expenses', split_smart_settlement: 'Smart Settlement',
    split_export: 'Export', split_insights: 'Spending Insights'
  };

  async function renderAccount() {
    const body = $('#spBody');
    try {
      const [prefs, ent] = await Promise.all([
        window.api.notifications.preferences(),
        window.api.split.entitlements()
      ]);
      S.entitlements = ent;
      const p = S.me.person;

      const toggles = [
        ['split_enabled', '🔔', 'All Money Splits notifications', 'The master switch for everything below.'],
        ['split_expense_added', '🧾', 'New expenses', 'When someone adds an expense that involves you.'],
        ['split_expense_updated', '✏️', 'Expense changes', 'When an expense you are on is edited or deleted.'],
        ['split_settlement', '💸', 'Settlements', 'When someone settles up with you.'],
        ['split_group_activity', '👥', 'Group activity', 'Invitations and people joining your groups.'],
        ['split_friend_activity', '🤝', 'Friends', 'When someone adds you as a friend.'],
        ['whatsapp_enabled', '💬', 'Also send on WhatsApp', 'Uses the number on your MoneyKal profile.']
      ];

      body.innerHTML = `
        <div class="sp-sec">
          <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">👤</span> Your Money Splits profile</span></div>
          <div class="sp-bal sp-bal--flat">
            ${avatar(p, 'lg')}
            <div class="sp-bal__body">
              <div class="sp-bal__text"><b>${esc(p.display_name)}</b></div>
              <div class="sp-row__meta">${esc(p.email || '')}</div>
            </div>
          </div>
        </div>

        <div class="sp-sec">
          <div class="sp-premium">
            <span class="sp-premium__tag"><span aria-hidden="true">✨</span> ${ent.is_premium ? 'Premium' : 'MoneyKal Premium'}</span>
            <div class="sp-premium__title">${ent.is_premium
              ? 'Premium is active on your account'
              : 'Make splitting effortless.'}</div>
            <div class="sp-premium__text">${ent.is_premium
              ? 'Every advanced Money Splits feature is unlocked. Groups, expenses, balances and settling up stay free for everyone you split with.'
              : 'Money Splits is completely free — groups, invitations, every split mode, balances and settling up, always. Premium adds the clever bits on top.'}</div>
            <div class="sp-pcards">
              ${ent.premium_features.map(f => `
                <div class="sp-pcard">
                  <div class="sp-pcard__emoji" aria-hidden="true">${PREMIUM_EMOJI[f.key] || '✨'}</div>
                  <div class="sp-pcard__title">${esc(PREMIUM_TITLE[f.key] || f.key)}</div>
                  <div class="sp-pcard__text">${esc(f.description)}</div>
                </div>`).join('')}
            </div>
          </div>

          <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">💚</span> Free for everyone, forever</span></div>
          <ul class="sp-flist">
            ${ent.free_features.map(f => `<li>${esc(f)}</li>`).join('')}
          </ul>
        </div>

        <div class="sp-sec">
          <div class="sp-sec__head"><span class="sp-sec__title"><span aria-hidden="true">🔔</span> Notifications</span></div>
          ${toggles.map(([key, emoji, label, hint]) => `
            <div class="sp-row sp-row--static">
              <span class="sp-row__emoji" aria-hidden="true">${emoji}</span>
              <div class="sp-row__body">
                <div class="sp-row__title">${esc(label)}</div>
                <div class="sp-row__meta">${esc(hint)}</div>
              </div>
              <input type="checkbox" data-pref="${key}" ${prefs[key] ? 'checked' : ''}
                     aria-label="${esc(label)}"
                     style="width:19px;height:19px;accent-color:var(--sp-cyan);cursor:pointer;flex-shrink:0">
            </div>`).join('')}
        </div>`;

      $$('[data-pref]', body).forEach(cb => cb.addEventListener('change', async () => {
        try {
          await window.api.notifications.savePreferences({ [cb.dataset.pref]: cb.checked });
          toast('Notification settings saved', '🔔');
        } catch (e) { handleError(e); cb.checked = !cb.checked; }
      }));
    } catch (e) { handleError(e); body.innerHTML = ''; }
  }

  /* ==========================================================================
     MODAL PLUMBING
     ========================================================================== */

  function modal(title, inner, opts) {
    opts = opts || {};
    closeModal();
    const wrap = document.createElement('div');
    wrap.className = 'sp-modal';
    wrap.id = 'spModal';
    wrap.innerHTML = `
      <div class="sp-modal__card${opts.wide ? ' sp-modal__card--wide' : ''}" role="dialog" aria-modal="true">
        <div class="sp-modal__head">
          <div class="sp-modal__title">${opts.emoji ? `<span aria-hidden="true">${opts.emoji}</span>` : ''}${esc(title)}</div>
          <button class="sp-modal__x" aria-label="Close">&times;</button>
        </div>
        <div id="spModalBody">${inner}</div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('is-open'));
    $('.sp-modal__x', wrap).addEventListener('click', closeModal);
    // Click the backdrop, not the card, to dismiss.
    wrap.addEventListener('click', ev => { if (ev.target === wrap) closeModal(); });
    document.addEventListener('keydown', escClose);
    return wrap;
  }

  function escClose(ev) { if (ev.key === 'Escape') closeModal(); }

  function closeModal() {
    const m = $('#spModal');
    if (m) m.remove();
    document.removeEventListener('keydown', escClose);
  }

  /** The emoji picker shared by group create and group settings. */
  function emojiPicker(selected) {
    return `<div class="sp-emojis" id="gEmojis" role="group" aria-label="Choose an icon">
      ${GROUP_EMOJI_CHOICES.map(e => `
        <button type="button" class="sp-emoji${e === selected ? ' is-on' : ''}" data-emoji="${e}"
                aria-label="${e}">${e}</button>`).join('')}
    </div>`;
  }

  function wireEmojiPicker(onPick) {
    $$('[data-emoji]').forEach(btn => btn.addEventListener('click', () => {
      $$('[data-emoji]').forEach(b => b.classList.toggle('is-on', b === btn));
      onPick(btn.dataset.emoji);
    }));
  }

  /* ==========================================================================
     GROUP CREATE / SETTINGS
     ========================================================================== */

  function openGroupModal() {
    let chosen = '✈️';
    modal('Create a group', `
      <div class="sp-field">
        <label class="sp-field__label" for="gName"><span aria-hidden="true">✏️</span> Group name</label>
        <input class="sp-input" id="gName" placeholder="Goa Trip" autocomplete="off">
      </div>

      <div class="sp-field">
        <label class="sp-field__label"><span aria-hidden="true">🎨</span> Pick an icon</label>
        ${emojiPicker(chosen)}
      </div>

      <div class="sp-row2">
        <div class="sp-field">
          <label class="sp-field__label" for="gType">Type</label>
          <select class="sp-select" id="gType">
            <option value="trip" selected>✈️ Trip</option>
            <option value="home">🏠 Home / Flat</option>
            <option value="couple">💞 Couple</option>
            <option value="friends">👥 Friends</option>
            <option value="other">🎉 Other</option>
          </select>
        </div>
        <div class="sp-field">
          <label class="sp-field__label" for="gCur">Currency</label>
          <select class="sp-select" id="gCur">
            <option value="INR" selected>₹ INR</option>
            <option value="USD">$ USD</option>
            <option value="EUR">€ EUR</option>
            <option value="GBP">£ GBP</option>
            <option value="AED">AED</option>
            <option value="SGD">S$ SGD</option>
          </select>
        </div>
      </div>

      <label class="sp-person sp-person--plain" style="width:100%;border-radius:12px;align-items:flex-start;gap:10px;padding:12px 14px">
        <input type="checkbox" id="gSimplify" checked style="margin-top:2px;accent-color:var(--sp-cyan)">
        <span style="font-weight:500;line-height:1.5;text-align:left">✨ Simplify debts — show the fewest payments that settle the group, instead of every individual debt.</span>
      </label>

      <div class="sp-modal__foot">
        <button class="sp-btn sp-btn--ghost" data-close>Cancel</button>
        <button class="sp-btn sp-btn--secondary" id="gSave"><span aria-hidden="true">✨</span> Create group</button>
      </div>`, { emoji: '👥' });

    $('[data-close]').addEventListener('click', closeModal);
    // Changing the type moves the icon to that type's default, but only until
    // the user picks one deliberately — after that their choice stands.
    let touched = false;
    wireEmojiPicker(e => { chosen = e; touched = true; });
    $('#gType').addEventListener('change', () => {
      if (touched) return;
      chosen = GROUP_TYPE_EMOJI[$('#gType').value] || '🎉';
      $$('[data-emoji]').forEach(b => b.classList.toggle('is-on', b.dataset.emoji === chosen));
    });
    $('#gName').focus();

    $('#gSave').addEventListener('click', async () => {
      const name = $('#gName').value.trim();
      if (!name) { toast('Give the group a name', '✏️'); $('#gName').focus(); return; }
      const btn = $('#gSave'); btn.disabled = true;
      try {
        const g = await window.api.split.createGroup({
          name,
          group_type: $('#gType').value,
          emoji: chosen,
          currency: $('#gCur').value,
          simplify_debts: $('#gSimplify').checked
        });
        closeModal();
        burst(chosen);
        toast(`"${name}" created`, chosen);
        S.groupId = g.id;
        await refresh();
      } catch (e) { handleError(e); btn.disabled = false; }
    });
  }

  function openGroupSettings(g) {
    let chosen = groupEmoji(g);
    modal('Group settings', `
      <div class="sp-field">
        <label class="sp-field__label" for="sName"><span aria-hidden="true">✏️</span> Group name</label>
        <input class="sp-input" id="sName" value="${esc(g.name)}">
      </div>

      <div class="sp-field">
        <label class="sp-field__label"><span aria-hidden="true">🎨</span> Icon</label>
        ${emojiPicker(chosen)}
      </div>

      <label class="sp-person sp-person--plain" style="width:100%;border-radius:12px;align-items:flex-start;gap:10px;padding:12px 14px;margin-bottom:10px">
        <input type="checkbox" id="sSimplify" ${g.simplify_debts ? 'checked' : ''} style="margin-top:2px;accent-color:var(--sp-cyan)">
        <span style="font-weight:500;line-height:1.5;text-align:left">✨ Simplify debts</span>
      </label>
      <label class="sp-person sp-person--plain" style="width:100%;border-radius:12px;align-items:flex-start;gap:10px;padding:12px 14px">
        <input type="checkbox" id="sArchived" ${g.is_archived ? 'checked' : ''} style="margin-top:2px;accent-color:var(--sp-cyan)">
        <span style="font-weight:500;line-height:1.5;text-align:left">📦 Archive this group — it stays readable but drops out of your active list.</span>
      </label>

      ${g.is_owner ? '' : '<div class="sp-hint" style="margin-top:12px">Only the group owner can change these.</div>'}

      <div class="sp-modal__foot">
        <button class="sp-btn sp-btn--ghost" data-close>Cancel</button>
        <button class="sp-btn sp-btn--primary" id="sSave" ${g.is_owner ? '' : 'disabled'}>Save</button>
      </div>`, { emoji: '⚙️' });

    $('[data-close]').addEventListener('click', closeModal);
    wireEmojiPicker(e => { chosen = e; });
    $('#sSave').addEventListener('click', async () => {
      try {
        await window.api.split.updateGroup(g.id, {
          name: $('#sName').value.trim(),
          emoji: chosen,
          simplify_debts: $('#sSimplify').checked,
          is_archived: $('#sArchived').checked
        });
        closeModal(); toast('Settings saved', '⚙️'); await refresh();
      } catch (e) { handleError(e); }
    });
  }

  /* ==========================================================================
     FRIENDS / INVITES
     ========================================================================== */

  function searchResults(rows) {
    if (!rows.length) return '<div class="sp-hint">Nobody found — invite them by email below.</div>';
    return `<div class="sp-bals" style="margin-top:10px">${rows.map(p => `
      <div class="sp-bal sp-bal--flat" data-add="${p.id}" role="button" tabindex="0" style="cursor:pointer">
        ${avatar(p, 'sm')}
        <div class="sp-bal__body">
          <div class="sp-bal__text"><b>${esc(p.display_name)}</b></div>
          <div class="sp-row__meta">${esc(p.email || '')}</div>
        </div>
        <span class="sp-sec__action">Add</span>
      </div>`).join('')}</div>`;
  }

  function openFriendModal() {
    modal('Add a friend', `
      <div class="sp-field">
        <label class="sp-field__label" for="fSearch"><span aria-hidden="true">🔎</span> Search MoneyKal</label>
        <input class="sp-input" id="fSearch" placeholder="Name or email address" autocomplete="off">
        <div class="sp-hint">Type at least two characters. Exact email matches and name prefixes are found.</div>
      </div>
      <div id="fResults"></div>

      <div class="sp-sec__head" style="margin-top:22px">
        <span class="sp-sec__title"><span aria-hidden="true">📨</span> Not on MoneyKal?</span>
      </div>
      <div class="sp-hint" style="margin-bottom:14px">Invite them anyway. They can be on expenses and owe money straight away, and everything carries over when they sign up.</div>
      <div class="sp-row2">
        <div class="sp-field">
          <label class="sp-field__label" for="fName">Their name</label>
          <input class="sp-input" id="fName" placeholder="Rahul">
        </div>
        <div class="sp-field">
          <label class="sp-field__label" for="fEmail">Their email</label>
          <input class="sp-input" id="fEmail" type="email" placeholder="rahul@example.com">
        </div>
      </div>

      <div class="sp-modal__foot">
        <button class="sp-btn sp-btn--ghost" data-close>Cancel</button>
        <button class="sp-btn sp-btn--secondary" id="fInvite"><span aria-hidden="true">📨</span> Send invite</button>
      </div>`, { emoji: '🤝' });

    $('[data-close]').addEventListener('click', closeModal);
    const search = $('#fSearch');
    search.focus();
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) { $('#fResults').innerHTML = ''; return; }
      // Debounced: the endpoint is cheap but a keystroke-per-request would put
      // a search behind every letter of an email address.
      timer = setTimeout(async () => {
        try {
          const r = await window.api.split.searchPeople(q);
          $('#fResults').innerHTML = searchResults(r.results);
          $$('[data-add]').forEach(row => row.addEventListener('click', async () => {
            try {
              await window.api.split.addFriend({ person_id: Number(row.dataset.add) });
              closeModal(); toast('Friend added', '🤝'); await refresh();
            } catch (e) { handleError(e); }
          }));
        } catch (e) { /* a failed search should not raise a toast on every key */ }
      }, 300);
    });

    $('#fInvite').addEventListener('click', async () => {
      const email = $('#fEmail').value.trim();
      const name = $('#fName').value.trim();
      if (!email && !name) { toast('Enter a name or an email address', '✏️'); return; }
      try {
        const inv = await window.api.split.invite({ email: email || null, name: name || null });
        closeModal();
        showInviteLink(inv, name || email);
        await refresh();
      } catch (e) { handleError(e); }
    });
  }

  function openInviteModal(groupId) {
    modal('Invite to this group', `
      <div class="sp-field">
        <label class="sp-field__label" for="iSearch"><span aria-hidden="true">🔎</span> Someone already on MoneyKal</label>
        <input class="sp-input" id="iSearch" placeholder="Name or email address" autocomplete="off">
      </div>
      <div id="iResults"></div>

      <div class="sp-sec__head" style="margin-top:22px">
        <span class="sp-sec__title"><span aria-hidden="true">📨</span> Or invite by email</span>
      </div>
      <div class="sp-hint" style="margin-bottom:14px">They join as a guest immediately — you can put them on expenses right away, and their balance follows them when they create an account.</div>
      <div class="sp-row2">
        <div class="sp-field">
          <label class="sp-field__label" for="iName">Name</label>
          <input class="sp-input" id="iName" placeholder="Rahul">
        </div>
        <div class="sp-field">
          <label class="sp-field__label" for="iEmail">Email</label>
          <input class="sp-input" id="iEmail" type="email" placeholder="rahul@example.com">
        </div>
      </div>

      <div class="sp-modal__foot">
        <button class="sp-btn sp-btn--ghost" data-close>Cancel</button>
        <button class="sp-btn sp-btn--secondary" id="iSend"><span aria-hidden="true">📨</span> Invite to group</button>
      </div>`, { emoji: '👥' });

    $('[data-close]').addEventListener('click', closeModal);
    const search = $('#iSearch');
    search.focus();
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) { $('#iResults').innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const r = await window.api.split.searchPeople(q);
          $('#iResults').innerHTML = searchResults(r.results);
          $$('[data-add]').forEach(row => row.addEventListener('click', async () => {
            try {
              await window.api.split.addMember(groupId, { person_id: Number(row.dataset.add) });
              closeModal(); toast('Added to the group', '🎉'); await refresh();
            } catch (e) { handleError(e); }
          }));
        } catch (e) { /* silent while typing */ }
      }, 300);
    });

    $('#iSend').addEventListener('click', async () => {
      const email = $('#iEmail').value.trim();
      const name = $('#iName').value.trim();
      if (!email && !name) { toast('Enter a name or an email address', '✏️'); return; }
      try {
        const inv = await window.api.split.invite({ email: email || null, name: name || null, group_id: groupId });
        closeModal();
        showInviteLink(inv, name || email);
        await refresh();
      } catch (e) { handleError(e); }
    });
  }

  function showInviteLink(inv, who) {
    const url = window.location.origin + inv.invite_path;
    modal('Invitation ready', `
      <div class="sp-hint" style="margin-bottom:4px;font-size:13.5px">
        <b style="color:var(--sp-ink)">${esc(who)}</b> is now part of your Money Splits — you can add them
        to expenses immediately, even before they open this link.
      </div>
      <div class="sp-field" style="margin-top:18px">
        <label class="sp-field__label"><span aria-hidden="true">🔗</span> Send them this link</label>
        <div class="sp-link">
          <input id="invLink" readonly value="${esc(url)}" aria-label="Invitation link">
          <button class="sp-btn sp-btn--ghost sp-btn--sm" id="invCopy">Copy</button>
        </div>
        <div class="sp-hint">When they sign up through it, their balance and history come with them — no duplicate account.</div>
      </div>
      <div class="sp-modal__foot">
        <button class="sp-btn sp-btn--primary" data-close>Done</button>
      </div>`, { emoji: '🎉' });

    $('[data-close]').addEventListener('click', closeModal);
    $('#invCopy').addEventListener('click', () => {
      const input = $('#invLink');
      input.select();
      // Clipboard API needs a secure context; the LAN/dev setup this app runs
      // on is plain http, so the legacy path is the one that actually fires.
      const done = () => toast('Link copied', '🔗');
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(input.value).then(done, () => { document.execCommand('copy'); done(); });
      } else { document.execCommand('copy'); done(); }
    });
  }

  /* ==========================================================================
     ADD / EDIT EXPENSE
     ========================================================================== */

  /** Mirrors backend/services/split_math.allocate_by_weights so the sheet can
   *  preview the split live. Integer arithmetic only, largest remainder, same
   *  tie-break — the preview must agree with what the server will compute, or
   *  the number the user approved is not the number that gets saved. */
  function allocate(totalMinor, weights) {
    const total = Math.round(totalMinor);
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!sum) return weights.map(() => 0);
    const sign = total < 0 ? -1 : 1;
    const mag = Math.abs(total);
    const exact = weights.map(w => mag * w / sum);
    const floors = exact.map(Math.floor);
    let left = mag - floors.reduce((a, b) => a + b, 0);
    const order = exact
      .map((e, i) => ({ i, frac: e - floors[i] }))
      .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
    for (let k = 0; k < left; k++) floors[order[k % order.length].i]++;
    return floors.map(f => sign * f);
  }

  async function openExpenseModal(ctx) {
    ctx = ctx || {};
    let members = ctx.members;
    let currency = ctx.currency || 'INR';
    let existing = null;

    // Loading before drawing keeps the sheet from flashing an empty state and
    // then repopulating, which reads as a bug on a slow connection.
    if (ctx.expenseId) {
      try { existing = await window.api.split.expense(ctx.expenseId); }
      catch (e) { handleError(e); return; }
      currency = existing.currency;
    }
    if (!members && ctx.groupId) {
      try { members = (await window.api.split.group(ctx.groupId)).members; }
      catch (e) { handleError(e); return; }
    }
    if (!members) {
      // No group context: everyone the user can legitimately split with.
      try {
        const f = await window.api.split.friends();
        members = [{ ...S.me.person, name: 'You' }]
          .concat(f.friends.map(x => ({ ...x, name: x.display_name })));
      } catch (e) { handleError(e); return; }
    }
    if (!members.some(m => m.id === S.me.person.id)) {
      members = [{ ...S.me.person, name: 'You' }].concat(members);
    }

    const state = {
      mode: existing ? existing.split_mode : 'equal',
      selected: new Set(existing ? existing.shares.map(s => s.person.id) : members.map(m => m.id)),
      values: {},
      payers: existing
        ? existing.payers.map(p => ({ id: p.person.id, amount: p.amount.amount }))
        : [{ id: S.me.person.id, amount: '' }],
      items: existing && existing.items.length
        ? existing.items.map(i => ({ name: i.name, amount: i.amount.amount,
                                     people: new Set(i.participant_person_ids) }))
        : [{ name: '', amount: '', people: new Set(members.map(m => m.id)) }],
      // Minted once per sheet so a double-click on Save cannot book twice.
      token: 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
    };
    if (existing) {
      existing.shares.forEach(s => {
        if (existing.split_mode === 'exact') state.values[s.person.id] = s.amount.amount;
        else if (s.weight) state.values[s.person.id] = s.weight;
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const cats = (S.me && S.me.categories) || [];
    const symbol = (S.me && S.me.summary && S.me.summary.net.symbol) || '₹';

    modal(existing ? 'Edit expense' : 'Add Expense', `
      <div id="xErr"></div>

      <div class="sp-field">
        <label class="sp-field__label" for="xAmt"><span aria-hidden="true">💰</span> How much?</label>
        <div class="sp-amount">
          <span class="sp-amount__symbol" aria-hidden="true">${esc(symbol)}</span>
          <input class="sp-input--amount" id="xAmt" inputmode="decimal" placeholder="0"
                 aria-label="Amount"
                 value="${existing ? esc(existing.total.amount) : ''}">
        </div>
        <div class="sp-hint">In ${esc(currency)}.</div>
      </div>

      <div class="sp-field">
        <label class="sp-field__label" for="xDesc"><span aria-hidden="true">🧾</span> What was it for?</label>
        <input class="sp-input" id="xDesc" placeholder="Dinner" autocomplete="off"
               value="${existing ? esc(existing.description) : ''}">
      </div>

      <div class="sp-row2">
        <div class="sp-field">
          <label class="sp-field__label" for="xCat"><span aria-hidden="true">🏷️</span> Category</label>
          <select class="sp-select" id="xCat">
            <option value="">No category</option>
            ${cats.map(c => `<option value="${esc(c)}"${existing && existing.category === c ? ' selected' : ''}>${esc((CATEGORY_EMOJI[c] || '') + ' ' + c)}</option>`).join('')}
          </select>
        </div>
        <div class="sp-field">
          <label class="sp-field__label" for="xDate"><span aria-hidden="true">📅</span> Date</label>
          <input class="sp-input" id="xDate" type="date" value="${existing ? esc(existing.date || today) : today}">
        </div>
      </div>

      <div class="sp-field">
        <label class="sp-field__label"><span aria-hidden="true">👤</span> Who paid?</label>
        <div id="xPayers"></div>
        <button class="sp-sec__action" id="xAddPayer" style="margin-top:10px">+ Add another payer</button>
        <div class="sp-hint" id="xPayerHint"></div>
      </div>

      <div class="sp-field">
        <label class="sp-field__label"><span aria-hidden="true">👥</span> Split between</label>
        <div class="sp-people" id="xPeople"></div>
      </div>

      <div class="sp-field">
        <label class="sp-field__label"><span aria-hidden="true">⚖️</span> How to split</label>
        <div class="sp-modes" id="xModes">
          ${MODES.map(m => `
            <button type="button" class="sp-mode${m.id === state.mode ? ' is-active' : ''}" data-mode="${m.id}">
              <span class="sp-mode__emoji" aria-hidden="true">${m.emoji}</span>${m.label}
            </button>`).join('')}
        </div>
        <div id="xSplit"></div>
      </div>

      <div class="sp-field">
        <label class="sp-field__label" for="xNotes"><span aria-hidden="true">📝</span> Notes <span style="color:var(--sp-ink-3);font-weight:400">(optional)</span></label>
        <textarea class="sp-textarea" id="xNotes" placeholder="Anything worth remembering">${existing ? esc(existing.notes || '') : ''}</textarea>
      </div>
      <div class="sp-field">
        <label class="sp-field__label" for="xReceipt"><span aria-hidden="true">📷</span> Receipt image URL <span style="color:var(--sp-ink-3);font-weight:400">(optional)</span></label>
        <input class="sp-input" id="xReceipt" placeholder="https://…" value="${existing ? esc(existing.receipt_url || '') : ''}">
      </div>

      <div class="sp-modal__foot">
        ${existing ? '<button class="sp-btn sp-btn--ghost" id="xDelete" style="margin-right:auto">🗑️ Delete</button>' : ''}
        <button class="sp-btn sp-btn--ghost" data-close>Cancel</button>
        <button class="sp-btn sp-btn--primary" id="xSave">${existing ? 'Save changes' : '➕ Add Expense'}</button>
      </div>`, { wide: true, emoji: '🧾' });

    const nameOf = id => {
      const m = members.find(x => x.id === id);
      return m ? (m.name || m.display_name) : 'Someone';
    };
    const memberOf = id => members.find(x => x.id === id) || { initials: '?', display_name: 'Someone' };
    const amountMinor = () => {
      const raw = parseFloat($('#xAmt').value);
      if (!isFinite(raw)) return 0;
      // Two-decimal currencies only in this preview; the server is the
      // authority on exponent and will reject anything it cannot represent.
      return Math.round(raw * 100);
    };

    function drawPayers() {
      $('#xPayers').innerHTML = state.payers.map((p, idx) => `
        <div class="sp-split">
          <span class="sp-split__name">
            ${avatar(memberOf(p.id), 'sm')}
            <select class="sp-select" data-payer-who="${idx}" aria-label="Who paid"
                    style="padding:7px 9px;font-size:13px;border-radius:9px">
              ${members.map(m => `<option value="${m.id}"${m.id === p.id ? ' selected' : ''}>${esc(m.name || m.display_name)}</option>`).join('')}
            </select>
          </span>
          ${state.payers.length > 1
            ? `<input class="sp-split__input" data-payer-amt="${idx}" inputmode="decimal" placeholder="0.00" value="${esc(p.amount)}" aria-label="Amount paid">`
            : '<span class="sp-split__computed" id="xSolePayer"></span>'}
          ${state.payers.length > 1 ? `<button type="button" class="sp-item__del" data-payer-del="${idx}" aria-label="Remove payer">&times;</button>` : ''}
        </div>`).join('');

      if (state.payers.length === 1) {
        const el = $('#xSolePayer');
        if (el) el.textContent = $('#xAmt').value ? 'the whole amount' : '';
        $('#xPayerHint').textContent = 'One payer covers the full amount.';
      } else {
        const paid = state.payers.reduce((a, p) => a + (Math.round(parseFloat(p.amount) * 100) || 0), 0);
        const total = amountMinor();
        $('#xPayerHint').textContent = paid === total
          ? '✓ Payer amounts match the total.'
          : `Payers total ${(paid / 100).toFixed(2)} of ${(total / 100).toFixed(2)}.`;
      }

      $$('[data-payer-who]').forEach(sel => sel.addEventListener('change', () => {
        state.payers[Number(sel.dataset.payerWho)].id = Number(sel.value);
        drawPayers();
      }));
      $$('[data-payer-amt]').forEach(inp => inp.addEventListener('input', () => {
        state.payers[Number(inp.dataset.payerAmt)].amount = inp.value;
        const pos = inp.selectionStart;
        const idx = inp.dataset.payerAmt;
        drawPayers();
        const again = $(`[data-payer-amt="${idx}"]`);
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      }));
      $$('[data-payer-del]').forEach(btn => btn.addEventListener('click', () => {
        state.payers.splice(Number(btn.dataset.payerDel), 1);
        drawPayers();
      }));
    }

    function drawPeople() {
      $('#xPeople').innerHTML = members.map(m => `
        <button type="button" class="sp-person${state.selected.has(m.id) ? ' is-on' : ''}" data-person="${m.id}"
                aria-pressed="${state.selected.has(m.id)}">
          ${avatar(m, 'sm')} ${esc(m.name || m.display_name)}
        </button>`).join('');
      $$('[data-person]').forEach(btn => btn.addEventListener('click', () => {
        const id = Number(btn.dataset.person);
        if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
        drawPeople(); drawSplit();
      }));
    }

    function drawSplit() {
      const ids = members.filter(m => state.selected.has(m.id)).map(m => m.id);
      const total = amountMinor();
      const host = $('#xSplit');

      if (!ids.length) {
        host.innerHTML = '<div class="sp-hint">Pick at least one person to split between.</div>';
        return;
      }

      if (state.mode === 'equal') {
        const parts = allocate(total, ids.map(() => 1));
        host.innerHTML = `<div class="sp-splits">
          ${ids.map((id, i) => `
            <div class="sp-split">
              <span class="sp-split__name">${avatar(memberOf(id), 'sm')} ${esc(nameOf(id))}</span>
              <span class="sp-split__computed">${(parts[i] / 100).toFixed(2)}</span>
            </div>`).join('')}
          <div class="sp-tally"><span>⚖️ Split equally between ${ids.length}</span><b>${(total / 100).toFixed(2)}</b></div>
        </div>`;
        return;
      }

      if (state.mode === 'itemized') {
        host.innerHTML = `
          ${state.items.map((it, idx) => `
            <div class="sp-item">
              <div class="sp-item__top">
                <input class="sp-input sp-item__name" data-item-name="${idx}" placeholder="Item name" value="${esc(it.name)}" aria-label="Item name">
                <input class="sp-input sp-item__amt" data-item-amt="${idx}" inputmode="decimal" placeholder="0.00" value="${esc(it.amount)}" aria-label="Item amount">
                ${state.items.length > 1 ? `<button type="button" class="sp-item__del" data-item-del="${idx}" aria-label="Remove item">&times;</button>` : ''}
              </div>
              <div class="sp-people">
                ${ids.map(id => `
                  <button type="button" class="sp-person${it.people.has(id) ? ' is-on' : ''}" data-item-person="${idx}:${id}">
                    ${esc(nameOf(id))}
                  </button>`).join('')}
              </div>
            </div>`).join('')}
          <button type="button" class="sp-sec__action" id="xAddItem">+ Add item</button>
          <div class="sp-tally ${itemsTotal() > total ? 'is-bad' : ''}" style="border-radius:12px;margin-top:12px;border-top:none">
            <span>🧾 Items ${(itemsTotal() / 100).toFixed(2)} of ${(total / 100).toFixed(2)}${
              total > itemsTotal() ? ` — the remaining ${((total - itemsTotal()) / 100).toFixed(2)} (tax, tip) is shared in proportion` : ''
            }</span>
            <b>${(itemsTotal() / 100).toFixed(2)}</b>
          </div>`;

        $$('[data-item-name]').forEach(inp => inp.addEventListener('input', () => {
          state.items[Number(inp.dataset.itemName)].name = inp.value;
        }));
        $$('[data-item-amt]').forEach(inp => inp.addEventListener('input', () => {
          state.items[Number(inp.dataset.itemAmt)].amount = inp.value;
          const pos = inp.selectionStart;
          const idx = inp.dataset.itemAmt;
          drawSplit();
          const again = $(`[data-item-amt="${idx}"]`);
          if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
        }));
        $$('[data-item-del]').forEach(btn => btn.addEventListener('click', () => {
          state.items.splice(Number(btn.dataset.itemDel), 1); drawSplit();
        }));
        $$('[data-item-person]').forEach(btn => btn.addEventListener('click', () => {
          const [idx, id] = btn.dataset.itemPerson.split(':').map(Number);
          const set = state.items[idx].people;
          if (set.has(id)) set.delete(id); else set.add(id);
          drawSplit();
        }));
        $('#xAddItem').addEventListener('click', () => {
          state.items.push({ name: '', amount: '', people: new Set(ids) });
          drawSplit();
        });
        return;
      }

      // exact / percent / shares all render the same row shape.
      const unit = state.mode === 'percent' ? '%' : state.mode === 'shares' ? '×' : '';
      const weights = ids.map(id => parseFloat(state.values[id]) || 0);
      let computed = [];
      if (state.mode === 'percent' || state.mode === 'shares') {
        computed = allocate(total, weights);
      }
      const entered = state.mode === 'exact'
        ? ids.reduce((a, id) => a + (Math.round(parseFloat(state.values[id]) * 100) || 0), 0)
        : weights.reduce((a, b) => a + b, 0);

      const ok = state.mode === 'exact' ? entered === total
        : state.mode === 'percent' ? Math.abs(entered - 100) < 1e-9
          : entered > 0;

      host.innerHTML = `<div class="sp-splits">
        ${ids.map((id, i) => `
          <div class="sp-split">
            <span class="sp-split__name">${avatar(memberOf(id), 'sm')} ${esc(nameOf(id))}</span>
            <input class="sp-split__input" data-val="${id}" inputmode="decimal"
                   placeholder="0" value="${esc(state.values[id] || '')}"
                   aria-label="${esc(nameOf(id))} ${state.mode === 'percent' ? 'percentage' : state.mode === 'shares' ? 'shares' : 'amount'}">
            <span class="sp-split__unit">${unit}</span>
            ${state.mode === 'exact' ? '' : `<span class="sp-split__computed">${((computed[i] || 0) / 100).toFixed(2)}</span>`}
          </div>`).join('')}
        <div class="sp-tally ${ok ? '' : 'is-bad'}">
          <span>${
            state.mode === 'exact' ? `💰 Entered ${(entered / 100).toFixed(2)} of ${(total / 100).toFixed(2)}`
              : state.mode === 'percent' ? `📊 Percentages total ${entered}% — must be 100%`
                : `🔢 Total shares: ${entered}`
          }</span>
          <b>${ok ? '✓' : '—'}</b>
        </div>
      </div>`;

      $$('[data-val]').forEach(inp => inp.addEventListener('input', () => {
        state.values[Number(inp.dataset.val)] = inp.value;
        const pos = inp.selectionStart;
        drawSplit();
        // Redrawing replaces the node, so focus and caret have to be restored
        // or typing a second digit would jump the cursor to the start.
        const again = $(`[data-val="${inp.dataset.val}"]`);
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      }));
    }

    function itemsTotal() {
      return state.items.reduce((a, it) => a + (Math.round(parseFloat(it.amount) * 100) || 0), 0);
    }

    $('[data-close]').addEventListener('click', closeModal);
    $('#xAmt').addEventListener('input', () => { drawPayers(); drawSplit(); });
    $('#xAddPayer').addEventListener('click', () => {
      const taken = new Set(state.payers.map(p => p.id));
      const next = members.find(m => !taken.has(m.id));
      state.payers.push({ id: next ? next.id : members[0].id, amount: '' });
      drawPayers();
    });
    $$('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      $$('[data-mode]').forEach(b => b.classList.toggle('is-active', b.dataset.mode === state.mode));
      drawSplit();
    }));
    if ($('#xDelete')) $('#xDelete').addEventListener('click', async () => {
      if (!confirm(window.t('Delete this expense? Balances will update for everyone.'))) return;
      try {
        await window.api.split.deleteExpense(existing.id);
        closeModal(); toast('Expense deleted', '🗑️'); await refresh();
      } catch (e) { handleError(e); }
    });

    drawPayers(); drawPeople(); drawSplit();
    $('#xAmt').focus();

    $('#xSave').addEventListener('click', async () => {
      const errBox = $('#xErr');
      errBox.innerHTML = '';
      const description = $('#xDesc').value.trim();
      const amount = $('#xAmt').value.trim();
      const ids = members.filter(m => state.selected.has(m.id)).map(m => m.id);

      if (!description) return fail('Give the expense a description.');
      if (!amount || !(parseFloat(amount) > 0)) return fail('Enter an amount greater than zero.');
      if (!ids.length) return fail('Choose at least one person to split between.');

      const payers = state.payers.length === 1
        ? [{ person_id: state.payers[0].id, amount: amount }]
        : state.payers.map(p => ({ person_id: p.id, amount: p.amount }));

      const payload = {
        group_id: ctx.groupId || null,
        description,
        amount,
        currency,
        expense_date: $('#xDate').value || null,
        category: $('#xCat').value || null,
        notes: $('#xNotes').value.trim() || null,
        receipt_url: $('#xReceipt').value.trim() || null,
        split_mode: state.mode,
        participant_person_ids: ids,
        payers,
        client_token: state.token
      };

      if (state.mode === 'exact' || state.mode === 'percent' || state.mode === 'shares') {
        payload.split_values = {};
        ids.forEach(id => { payload.split_values[String(id)] = state.values[id] || '0'; });
      }
      if (state.mode === 'itemized') {
        payload.items = state.items
          .filter(it => it.name.trim() && parseFloat(it.amount) > 0)
          .map(it => ({
            name: it.name.trim(),
            amount: it.amount,
            participant_person_ids: Array.from(it.people).filter(id => ids.includes(id))
          }));
        if (!payload.items.length) return fail('Add at least one item with a name and an amount.');
      }

      const btn = $('#xSave');
      btn.disabled = true;
      try {
        if (existing) {
          delete payload.client_token;
          await window.api.split.updateExpense(existing.id, payload);
          closeModal();
          toast('Expense updated', '✏️');
        } else {
          await window.api.split.createExpense(payload);
          closeModal();
          burst(expenseEmoji({ category: payload.category, description }));
          toast('Expense added', '🎉');
        }
        await refresh();
      } catch (e) {
        btn.disabled = false;
        if (e.status === 402) { handleError(e); return; }
        // Server-side validation messages are the useful ones (they name the
        // exact shortfall), so they are shown inline rather than as a toast
        // that disappears while the user is still fixing the form.
        errBox.innerHTML = `<div class="sp-err"><span aria-hidden="true">⚠️</span><span>${esc(e.message)}</span></div>`;
      }

      function fail(msg) {
        errBox.innerHTML = `<div class="sp-err"><span aria-hidden="true">⚠️</span><span>${esc(msg)}</span></div>`;
        errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  /* ==========================================================================
     SETTLE UP
     ========================================================================== */

  function openSettleModal(ctx) {
    const members = ctx.members || [];
    const nameOf = id => {
      const m = members.find(x => x.id === id);
      return m ? (m.name || m.display_name) : 'Someone';
    };
    const token = 'web-st-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const symbol = (S.me && S.me.summary && S.me.summary.net.symbol) || '₹';

    modal('Settle up', `
      <div id="stErr"></div>
      <div class="sp-hint" style="margin-bottom:20px">
        💡 A settlement records money that actually changed hands. It clears a balance
        without touching what the group spent.
      </div>

      <div class="sp-field">
        <label class="sp-field__label" for="stAmt"><span aria-hidden="true">💸</span> How much changed hands?</label>
        <div class="sp-amount">
          <span class="sp-amount__symbol" aria-hidden="true">${esc(symbol)}</span>
          <input class="sp-input--amount" id="stAmt" inputmode="decimal" aria-label="Settlement amount"
                 value="${esc(ctx.amount || '')}">
        </div>
        <div class="sp-hint">Pay less than the full balance to record a partial settlement — the rest stays outstanding.</div>
      </div>

      <div class="sp-row2">
        <div class="sp-field">
          <label class="sp-field__label" for="stFrom"><span aria-hidden="true">👤</span> Who paid</label>
          <select class="sp-select" id="stFrom">
            ${members.map(m => `<option value="${m.id}"${m.id === ctx.from ? ' selected' : ''}>${esc(m.name || m.display_name)}</option>`).join('')}
          </select>
        </div>
        <div class="sp-field">
          <label class="sp-field__label" for="stTo"><span aria-hidden="true">🙋</span> Who received</label>
          <select class="sp-select" id="stTo">
            ${members.map(m => `<option value="${m.id}"${m.id === ctx.to ? ' selected' : ''}>${esc(m.name || m.display_name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="sp-row2">
        <div class="sp-field">
          <label class="sp-field__label" for="stMethod">How</label>
          <select class="sp-select" id="stMethod">
            <option value="upi">📱 UPI</option>
            <option value="cash">💵 Cash</option>
            <option value="bank">🏦 Bank transfer</option>
            <option value="other">✨ Other</option>
          </select>
        </div>
        <div class="sp-field">
          <label class="sp-field__label" for="stDate">Date</label>
          <input class="sp-input" id="stDate" type="date" value="${new Date().toISOString().slice(0, 10)}">
        </div>
      </div>

      <div class="sp-field">
        <label class="sp-field__label" for="stNote">Note <span style="color:var(--sp-ink-3);font-weight:400">(optional)</span></label>
        <input class="sp-input" id="stNote" placeholder="Paid over UPI">
      </div>

      <div class="sp-modal__foot">
        <button class="sp-btn sp-btn--ghost" data-close>Cancel</button>
        <button class="sp-btn sp-btn--primary" id="stSave"><span aria-hidden="true">💸</span> Record settlement</button>
      </div>`, { emoji: '💰' });

    $('[data-close]').addEventListener('click', closeModal);
    $('#stSave').addEventListener('click', async () => {
      const from = Number($('#stFrom').value);
      const to = Number($('#stTo').value);
      const amount = $('#stAmt').value.trim();
      const errBox = $('#stErr');
      errBox.innerHTML = '';
      const bad = msg => {
        errBox.innerHTML = `<div class="sp-err"><span aria-hidden="true">⚠️</span><span>${esc(msg)}</span></div>`;
      };
      if (from === to) return bad('Pick two different people.');
      if (!amount || !(parseFloat(amount) > 0)) return bad('Enter an amount greater than zero.');

      const btn = $('#stSave'); btn.disabled = true;
      try {
        await window.api.split.settle({
          group_id: ctx.groupId || null,
          from_person_id: from, to_person_id: to,
          amount, currency: ctx.currency || 'INR',
          method: $('#stMethod').value,
          note: $('#stNote').value.trim() || null,
          settled_on: $('#stDate').value || null,
          client_token: token
        });
        closeModal();
        burst('💸');
        toast(`${nameOf(from)} → ${nameOf(to)} recorded`, '💸');
        await refresh();
      } catch (e) {
        btn.disabled = false;
        bad(e.message);
      }
    });
  }

  /* ==========================================================================
     EXPORT
     ========================================================================== */

  async function doExport(groupId) {
    try {
      const r = await window.api.split.exportGroup(groupId);
      const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast('Export downloaded', '📤');
    } catch (e) { handleError(e); }
  }

  /* ==========================================================================
     NOTIFICATION BELL
     ========================================================================== */

  async function refreshBell() {
    const dot = $('#spBellDot');
    if (!dot) return;
    try {
      const r = await window.api.notifications.unreadCount();
      if (r.unread_count > 0) {
        dot.textContent = r.unread_count > 99 ? '99+' : r.unread_count;
        dot.hidden = false;
      } else {
        dot.hidden = true;
      }
    } catch (e) { /* the bell is ambient; a failed poll should stay silent */ }
  }

  async function toggleInbox() {
    const existing = $('#spInbox');
    if (existing) { existing.remove(); S.inboxOpen = false; return; }
    S.inboxOpen = true;
    const box = document.createElement('div');
    box.className = 'sp-inbox';
    box.id = 'spInbox';
    box.innerHTML = '<div class="sp-note"><div class="sp-note__body">Loading…</div></div>';
    document.body.appendChild(box);

    try {
      const d = await window.api.notifications.list({ limit: 40 });
      box.innerHTML = `
        <div class="sp-inbox__head">
          <span class="sp-sec__title"><span aria-hidden="true">🔔</span> Notifications</span>
          ${d.unread_count ? '<button class="sp-sec__action" id="spReadAll">Mark all read</button>' : ''}
        </div>
        ${d.notifications.length ? d.notifications.map(n => `
          <div class="sp-note ${n.is_read ? 'is-read' : 'is-unread'}"
               data-note="${n.id}" data-link="${esc(n.link_type || '')}" data-lid="${esc(n.link_id || '')}">
            <span class="sp-note__emoji" aria-hidden="true">${NOTIFICATION_EMOJI[n.kind] || '🔔'}</span>
            <div class="sp-note__body">
              <div class="sp-note__title">${esc(n.title)}</div>
              ${n.body ? `<div class="sp-note__text">${esc(n.body)}</div>` : ''}
              <div class="sp-note__time">${esc(timeAgo(n.created_at))}</div>
            </div>
          </div>`).join('')
        : `<div class="sp-note"><div class="sp-note__body">
             <div class="sp-note__title">All caught up ✨</div>
             <div class="sp-note__text">Nothing new right now.</div>
           </div></div>`}`;

      if ($('#spReadAll')) $('#spReadAll').addEventListener('click', async () => {
        await window.api.notifications.markRead(null);
        await refreshBell();
        box.remove(); S.inboxOpen = false;
      });

      $$('[data-note]', box).forEach(row => row.addEventListener('click', async () => {
        const id = Number(row.dataset.note);
        try { await window.api.notifications.markRead([id]); } catch (e) { /* navigate anyway */ }
        await refreshBell();
        box.remove(); S.inboxOpen = false;
        // Deep link: the notification says which object it is about, so the
        // click lands on that group/friend rather than a generic Split home.
        const type = row.dataset.link, lid = Number(row.dataset.lid);
        if (typeof window.switchView === 'function') window.switchView('split');
        if (type === 'split_group' && lid) { S.groupId = lid; S.friendId = null; S.tab = 'groups'; }
        else if (type === 'split_friend' && lid) { S.friendId = lid; S.groupId = null; S.tab = 'friends'; }
        else if (type === 'split_expense' && lid) {
          try {
            const e = await window.api.split.expense(lid);
            if (e.group_id) { S.groupId = e.group_id; S.tab = 'groups'; }
          } catch (err) { S.tab = 'activity'; }
        } else { S.tab = 'activity'; }
        await open();
      }));
    } catch (e) {
      box.innerHTML = '<div class="sp-note"><div class="sp-note__body">Could not load notifications.</div></div>';
    }

    // Any click outside dismisses. Registered on the next tick so the click
    // that opened the panel does not immediately close it.
    setTimeout(() => {
      document.addEventListener('click', function away(ev) {
        const bell = $('#spBell');
        if (box.contains(ev.target) || (bell && bell.contains(ev.target))) return;
        box.remove(); S.inboxOpen = false;
        document.removeEventListener('click', away);
      });
    }, 0);
  }

  function mountBell() {
    if ($('#spBell')) return;
    const host = document.querySelector('.topbar__right');
    if (!host) return;
    const btn = document.createElement('button');
    btn.id = 'spBell';
    btn.className = 'sp-bell';
    btn.setAttribute('aria-label', 'Notifications');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
      </svg>
      <span class="sp-bell__dot" id="spBellDot" hidden></span>`;
    btn.addEventListener('click', ev => { ev.stopPropagation(); toggleInbox(); });
    host.insertBefore(btn, host.firstChild);
    refreshBell();
    // Poll while the tab is visible. 60s is frequent enough that a badge is
    // never badly stale, and rare enough not to be a background drain.
    setInterval(() => { if (!document.hidden) refreshBell(); }, 60000);
  }

  /* ==========================================================================
     ENTRY POINTS
     ========================================================================== */

  async function refresh() {
    try {
      S.me = await window.api.split.me();
      S.entitlements = S.me.entitlements;
      renderSummary();
    } catch (e) { /* summary is decoration; the body render surfaces real errors */ }
    renderBody();
    refreshBell();
  }

  async function open() {
    if (S.pendingGroupId) {
      S.tab = 'groups';
      S.groupId = S.pendingGroupId;
      S.friendId = null;
      S.pendingGroupId = null;
    }
    renderShell();
    await refresh();
  }

  /* ---------------------------------------------------------------------
     Deep links from an invitation. Two routes arrive here:

       ?split_group=12   an account that already existed accepted the invite
                         and came straight over.
       the parked id     a brand-new account had to pass through onboarding
                         first — join.html cannot drop a profile-less user on
                         the dashboard, which signs them back out — so the
                         group waits in localStorage across that detour.

     Captured at parse time rather than on DOMContentLoaded, and deliberately
     *not* acted on here. app.js decides the starting view once the profile has
     loaded (`switchView(startView)`), so anything this file switched to would
     be overridden a moment later by that async callback. Instead the target is
     recorded now, app.js asks for it below when picking startView, and open()
     consumes it. Reading the URL and localStorage needs no DOM, so doing it
     during parse guarantees the value is set before app.js's promise resolves.
     --------------------------------------------------------------------- */
  (function captureDeepLink() {
    const params = new URLSearchParams(window.location.search);
    let gid = params.get('split_group');
    const fromQuery = !!gid;
    if (!gid) {
      try { gid = localStorage.getItem('moneykal_split_pending_group'); }
      catch (e) { /* private mode */ }
    }
    if (!gid) return;
    try { localStorage.removeItem('moneykal_split_pending_group'); } catch (e) {}
    S.pendingGroupId = Number(gid);
    // Drop the parameter so a refresh does not re-navigate.
    if (fromQuery) history.replaceState({}, '', window.location.pathname);
  })();

  /** Told to app.js so it can start on Money Splits instead of the Overview. */
  function hasPendingDeepLink() { return !!S.pendingGroupId; }

  function init() {
    mountBell();
    // If app.js is not going to route for us — no session bootstrap ran, or an
    // older build without the startView hook — honour the deep link ourselves.
    if (S.pendingGroupId && typeof window.switchView === 'function'
        && !document.querySelector('#view-split.is-active')) {
      setTimeout(() => {
        if (S.pendingGroupId && !document.querySelector('#view-split.is-active')) {
          window.switchView('split');
        }
      }, 1500);
    }
  }

  window.splitApp = { init, open, refresh, hasPendingDeepLink };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
