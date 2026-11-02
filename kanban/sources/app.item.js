// app.item — one card opened: a drawer on a desktop, the whole screen on a phone.
// It lives at ?item=12, so a card is a link someone can paste, and back closes it.
ns.provide('app.item');
ns.require('app.nav');
ns.require('app.client');
ns.require('app.ui');
ns.require('shared.board');

// The title and body, read or being edited. The revision read goes with the
// edit, so saving over a change made since is refused rather than lost.
app.item.Text = ({item}) => {
  const draft = signals.useSignal(null);
  const save = async (e) => {
    e.preventDefault();
    const saved = await app.ui.act("page/edit", {id: item.id, revision: item.revision, title: draft.value.title, body: draft.value.body});
    if (saved) draft.value = null;
  };
  const set = (key) => (e) => cyba.update(draft, (d) => ({...d, [key]: e.target.value}));
  if (!draft.value) return html`
    <div class="item-text">
      <h2>${item.title}</h2>
      ${item.body ? html`<p class="item-body">${item.body}</p>` : html`<p class="item-body quiet">No description.</p>`}
      <button type="button" class="link" onClick=${() => { draft.value = {title: item.title, body: item.body}; }}>Edit</button>
    </div>`;
  return html`
    <form class="item-text editing" onSubmit=${save}>
      <input aria-label="Title" value=${draft.value.title} onInput=${set("title")} maxlength="200" required />
      <textarea aria-label="Description" rows="6" value=${draft.value.body} onInput=${set("body")}></textarea>
      <div class="row">
        <button type="submit" class="solid">Save</button>
        <button type="button" class="link" onClick=${() => { draft.value = null; }}>Cancel</button>
      </div>
    </form>`;
};

// What a person can do about the lease from here. A blocked or finished card
// says so instead of offering a button the server would only refuse.
app.item.Lease = ({item}) => {
  const id = item.id, c = app.ui.live(item.claim);
  const closed = shared.board.lane(item.lane)?.closed;
  if (c) return html`
    <div class="lease held">
      <${app.ui.Claim} claim=${c} />
      ${c.mine && html`<div class="row">
        <button type="button" onClick=${() => app.ui.act("page/claim", {id})}>Renew</button>
        <button type="button" onClick=${() => app.ui.act("page/release", {id})}>Release</button>
      </div>`}
    </div>`;
  if (closed) return null;
  if (item.blocked_by.length) return html`
    <div class="lease"><span class="blocked-tag">Waiting on ${item.blocked_by.map((b) => `#${b}`).join(", ")}</span></div>`;
  return html`<div class="lease"><button type="button" class="solid" onClick=${() => app.ui.act("page/claim", {id})}>Claim it</button></div>`;
};

// A lead also gets the hidden lanes in the menu: that is how a card is dropped.
app.item.LaneMenu = ({item, me}) => html`
  <label class="lane-menu">
    <span>Lane</span>
    <select value=${item.lane} onChange=${(e) => app.ui.act("page/move", {id: item.id, lane: e.target.value})}>
      ${shared.board.lanes.filter((l) => !l.hidden || me.role === "lead" || l.id === item.lane).map((l) => html`
        <option key=${l.id} value=${l.id}>${l.name}</option>`)}
    </select>
  </label>`;

const Linked = ({item}) => html`
  <a class="linked" href=${app.ui.href({item: item.id})}>
    <span class="num">#${item.id}</span>
    <span class="linked-title">${item.title}</span>
    <span class="lane-tag">${shared.board.lane(item.lane)?.name}</span>
  </a>`;

app.item.Depends = ({item, cards}) => {
  const taken = new Set([item.id, ...item.depends_on.map((d) => d.id)]);
  const others = cards.filter((c) => !taken.has(c.id) && !shared.board.lane(c.lane)?.closed);
  const add = (e) => {
    const on = Number(e.target.value);
    e.target.value = "";
    if (on) app.ui.act("page/depend", {id: item.id, on});
  };
  return html`
    <section class="block">
      <h3>Waits on</h3>
      <ul class="links">${item.depends_on.map((d) => html`
        <li key=${d.id}>
          <${Linked} item=${d} />
          <button type="button" class="link" aria-label=${`Stop waiting on #${d.id}`}
                  onClick=${() => app.ui.act("page/depend", {id: item.id, on: d.id, remove: true})}>Remove</button>
        </li>`)}
      </ul>
      ${others.length > 0 && html`<select aria-label="Add something this waits on" value="" onChange=${add}>
        <option value="">Add something it waits on…</option>
        ${others.map((c) => html`<option key=${c.id} value=${c.id}>#${c.id} ${c.title}</option>`)}
      </select>`}
      ${item.blocks.length > 0 && html`<h3>Holding up</h3>
        <ul class="links">${item.blocks.map((d) => html`<li key=${d.id}><${Linked} item=${d} /></li>`)}</ul>`}
    </section>`;
};

app.item.Thread = ({item}) => {
  const text = signals.useSignal("");
  const send = async (e) => {
    e.preventDefault();
    if (await app.ui.act("page/note", {id: item.id, body: text.value})) text.value = "";
  };
  return html`
    <section class="block">
      <h3>Notes</h3>
      <ol class="thread">${item.thread.map((t) => html`
        <li key=${t.id} class=${t.agent ? "by-agent" : ""}>
          <div class="note-head">
            <${app.ui.Face} id=${t.member_id} name=${t.name} />
            <strong>${t.agent ?? app.ui.nameOf(t.name)}</strong>
            ${t.agent && html`<span class="quiet">for ${app.ui.nameOf(t.name)}</span>`}
            <time class="quiet" datetime=${t.at}>${app.ui.when(t.at)}</time>
          </div>
          <p>${t.body}</p>
        </li>`)}
      </ol>
      <form class="note-form" onSubmit=${send}>
        <textarea aria-label="Add a note" rows="2" placeholder="What did you do, find or decide?"
                  value=${text.value} onInput=${(e) => { text.value = e.target.value; }}></textarea>
        <button type="submit" disabled=${!text.value.trim()}>Add note</button>
      </form>
    </section>`;
};

// Keyed on the id by its parent, so a half-written note never follows you to
// another card. Its answer is forgotten on the way out, or every card ever
// opened here would be asked for again on every refresh.
app.item.Panel = ({id, me, cards}) => {
  const close = app.ui.href({item: null});
  const {value: item, error} = app.client.useQuery("page/item", {id});
  preact.useEffect(() => () => app.client.forget("page/item", {id}), [id]);
  preact.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !e.target.closest?.("form")) app.nav.go(app.ui.href({item: null})); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return html`
    <aside class="panel" aria-label=${`Item ${id}`}>
      <header class="panel-top">
        <span class="num">#${id}</span>
        ${item && html`<${app.item.LaneMenu} item=${item} me=${me} />`}
        <a class="close" href=${close} aria-label="Close">Close</a>
      </header>
      ${!item && html`<p class="quiet panel-wait">${error ?? "Loading…"}</p>`}
      ${item && html`
        <div class="panel-body">
          <${app.item.Text} item=${item} />
          <${app.item.Lease} item=${item} />
          <${app.item.Depends} item=${item} cards=${cards} />
          <${app.item.Thread} item=${item} />
        </div>`}
    </aside>`;
};
