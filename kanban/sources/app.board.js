// app.board — the page and the root of the site: the lanes, the cards, dragging
// them, adding them. One entry, one mount. The site is private, so the platform's
// gate has decided who gets this far before anything here runs.
ns.provide('app.board');
ns.require('app.nav');
ns.require('app.client');
ns.require('app.ui');
ns.require('app.item');
ns.require('shared.board');

// One page. Add an entry here and to app.board.page when the board grows
// another; anything else is a real 404.
cyba.routes({"app.board": ["/"]});

// The drag in progress, and the card on its way to the server: drawn where it
// was dropped straight away, rather than jumping back until the answer arrives.
app.board.dragging ??= signals.signal(null);
app.board.target ??= signals.signal(null);    // {lane, before}: where a drop would land
app.board.moving ??= signals.signal(null);    // {id, lane, before}

/** The lanes with the card in `moving` already where it is going. */
app.board.arrange = (lanes, moving) => {
  if (!moving) return lanes;
  const card = lanes.flatMap((l) => l.items).find((i) => i.id === moving.id);
  if (!card) return lanes;
  return lanes.map((l) => {
    const rest = l.items.filter((i) => i.id !== moving.id);
    const total = l.total - (l.items.length - rest.length);
    if (l.id !== moving.lane) return {...l, items: rest, total};
    const before = rest.findIndex((i) => i.id === moving.before);
    const at = before >= 0 ? before : shared.board.lane(l.id).closed ? 0 : rest.length;
    return {...l, items: [...rest.slice(0, at), {...card, lane: l.id, claim: null}, ...rest.slice(at)], total: total + 1};
  });
};

// Which card the pointer is above: the first whose middle is below it. Null
// means the end of the lane.
const beforeAt = (laneEl, y, dragged) => {
  for (const el of laneEl.querySelectorAll(".card")) {
    if (Number(el.dataset.id) === dragged) continue;
    const box = el.getBoundingClientRect();
    if (y < box.top + box.height / 2) return Number(el.dataset.id);
  }
  return null;
};

const drop = async (lane, before) => {
  const id = app.board.dragging.peek();
  app.board.dragging.value = null;
  app.board.target.value = null;
  if (id == null) return;
  app.board.moving.value = {id, lane, before};
  await app.ui.act("page/move", {id, lane, ...(before == null ? {} : {before})});
  app.board.moving.value = null;
};

// A card is a real link, so it opens in a new tab, copies and works with a
// keyboard. Dragging it is the desktop's way to move it; on a phone, where
// nothing drags, the lane menu in its panel does the same job.
app.board.Card = ({item, open}) => {
  const target = app.board.target.value;
  const blocked = item.blocked_by.length > 0;
  const classes = ["card", blocked && "blocked", open && "open", app.board.dragging.value === item.id && "lifted",
                   target?.before === item.id && "drop-above", app.ui.live(item.claim)?.mine && "mine"].filter(Boolean).join(" ");
  return html`
    <a class=${classes} href=${app.ui.href({item: item.id})} data-id=${item.id} draggable="true"
       onDragStart=${(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", `#${item.id}`); app.board.dragging.value = item.id; }}
       onDragEnd=${() => { app.board.dragging.value = null; app.board.target.value = null; }}>
      <span class="card-title">${item.title}</span>
      <span class="card-meta">
        <span class="num">#${item.id}</span>
        ${blocked && html`<span class="blocked-tag">Waits on ${item.blocked_by.map((b) => `#${b}`).join(" ")}</span>`}
        ${item.notes > 0 && html`<span class="note-count" title=${`${item.notes} notes`}>${item.notes} ${item.notes === 1 ? "note" : "notes"}</span>`}
        <${app.ui.Claim} claim=${item.claim} />
      </span>
    </a>`;
};

app.board.Lane = ({lane, openId}) => {
  const about = shared.board.lane(lane.id);
  const target = app.board.target.value;
  const over = (e) => {
    if (app.board.dragging.peek() == null) return;
    e.preventDefault();
    const before = beforeAt(e.currentTarget, e.clientY, app.board.dragging.peek());
    const now = app.board.target.peek();
    if (now?.lane !== lane.id || now?.before !== before) app.board.target.value = {lane: lane.id, before};
  };
  return html`
    <section id=${`lane-${lane.id}`} class=${`lane${target?.lane === lane.id ? " drop-here" : ""}${about.closed ? " closed" : ""}`}
             aria-label=${about.name} onDragOver=${over}
             onDrop=${(e) => { e.preventDefault(); drop(lane.id, target?.before ?? null); }}>
      <header class="lane-top">
        <h2>${about.name}</h2>
        <span class="count">${lane.total}</span>
        <span class="lane-hint">${about.hint}</span>
      </header>
      <div class="cards">
        ${lane.items.map((i) => html`<${app.board.Card} key=${i.id} item=${i} open=${openId === i.id} />`)}
        ${lane.items.length === 0 && html`<p class="empty">Nothing here.</p>`}
        ${target?.lane === lane.id && target.before == null && html`<div class="drop-line"></div>`}
        ${about.closed && lane.total > lane.items.length && html`
          <p class="empty">The latest ${lane.items.length} of ${lane.total}.</p>`}
      </div>
    </section>`;
};

app.board.AddForm = () => {
  const title = signals.useSignal("");
  const submit = async (e) => {
    e.preventDefault();
    const t = title.value;
    title.value = "";
    if (!(await app.ui.act("page/add", {title: t}))) title.value = t;
  };
  return html`
    <form class="add" onSubmit=${submit}>
      <input aria-label="New card" placeholder=${`Add to ${shared.board.lane(shared.board.start).name}…`} maxlength="200"
             value=${title.value} onInput=${(e) => { title.value = e.target.value; }} />
      <button type="submit" class="solid" disabled=${!title.value.trim()}>Add</button>
    </form>`;
};

// On a phone one lane fills the screen, so these say which and jump to the others.
// A #part of the page already open is the browser's to scroll to.
app.board.LaneTabs = ({lanes, active}) => html`
  <nav class="tabs" aria-label="Lanes">
    ${lanes.map((l) => html`
      <a key=${l.id} href=${`#lane-${l.id}`} class=${active === l.id ? "active" : ""}>
        ${shared.board.lane(l.id).name} <span class="count">${l.total}</span>
      </a>`)}
  </nav>`;

// The lanes before the first answer, so the server's paint and a slow load are
// the shape of the board. The server render asks nothing: it has no visitor.
// Before setup has run there are no tables, which is no fault of the reader's,
// and only a refusal asking them to sign in gets the link.
const Waiting = ({error}) => html`
  <div class="lanes">
    ${shared.board.shown().map((l) => html`
      <section key=${l.id} class="lane">
        <header class="lane-top"><h2>${l.name}</h2></header>
        <div class="cards">${error && l.id === shared.board.start
          ? /no such table/.test(error)
            ? html`<p class="empty">Setting up the board…</p>`
            : html`<p class="empty problem">${error}${/sign in/i.test(error) && html` <a href=${cyba.signin.url({next: location.pathname})}>Sign in</a>`}</p>`
          : html`<div class="ghost"></div><div class="ghost"></div>`}</div>
      </section>`)}
  </div>`;

app.board.Board = () => {
  const {value: board, error} = app.client.useQuery("page/board");
  const openId = Number(app.nav.url().searchParams.get("item")) || null;
  const active = signals.useSignal(shared.board.start);

  // Which lane fills a phone's screen, for the tabs. A desktop shows them all,
  // and the tabs are hidden there.
  const ready = !!board;
  preact.useEffect(() => {
    if (!ready) return;
    const root = document.querySelector(".lanes");
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) active.value = e.target.id.replace("lane-", "");
    }, {root, threshold: 0.6});
    root.querySelectorAll(".lane").forEach((el) => seen.observe(el));
    return () => seen.disconnect();
  }, [ready]);

  const lanes = board ? app.board.arrange(board.lanes, app.board.moving.value) : [];
  const cards = lanes.flatMap((l) => l.items);
  return html`
    <div class="app">
      <header class="top">
        <a class="mark" href="/">${shared.board.name}</a>
        <${app.board.AddForm} />
        <div class="people">
          ${board?.people.filter((p) => p.role != null).map((p) => html`<${app.ui.Face} key=${p.member_id} id=${p.member_id} name=${p.name} />`)}
        </div>
      </header>
      ${board && html`<${app.board.LaneTabs} lanes=${lanes} active=${active.value} />`}
      ${app.ui.problem.value && html`
        <p class="problem-bar" role="alert">
          <span>${app.ui.problem.value}</span>
          <button type="button" class="link" onClick=${() => { app.ui.problem.value = null; }}>Dismiss</button>
        </p>`}
      ${!board
        ? html`<${Waiting} error=${error} />`
        : html`<main class="lanes">${lanes.map((l) => html`<${app.board.Lane} key=${l.id} lane=${l} openId=${openId} />`)}</main>`}
      <footer class="foot">Agents work here too. Tell yours: <em>“pick up the next thing on the board.”</em></footer>
      ${board && openId && html`<${app.item.Panel} key=${openId} id=${openId} me=${board.me} cards=${cards} />`}
    </div>`;
};

app.board.NotFound = () => html`
  <main class="nowhere">
    <h1>Nothing here</h1>
    <p><a href="/">Back to the board</a></p>
  </main>`;

app.board.page = (path) => (path === "/" ? app.board.Board : null);

const FONTS = "https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap";

// The root starts the page's three clocks, each an effect that lists its function
// so a save restarts it and there is only ever one: the router, the poll that
// keeps the board current, and the tick that runs leases down.
app.board.App = () => {
  preact.useEffect(() => app.nav.start({page: app.board.page}), [app.nav.start]);
  preact.useEffect(() => app.client.poll("page/stamp"), [app.client.poll]);
  preact.useEffect(() => {
    const timer = setInterval(() => { app.ui.clock.value = Date.now(); }, 30000);
    return () => clearInterval(timer);
  }, []);
  const P = app.board.page(app.nav.url().pathname) ?? app.board.NotFound;
  return html`
    <${preact.Fragment}>
      <${cyba.Head}
        title=${html`<title>${shared.board.name}</title>`}
        description=${html`<meta name="description" content=${shared.board.about} />`}
        css=${html`
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
          <link rel="stylesheet" media="print" onload="this.media='all'" href=${FONTS} />
          <link rel="stylesheet" href=${cyba.sourceUrl("site.css")} />`} />
      <${P} />
    <//>`;
};

cyba.mount(app.board.App);
