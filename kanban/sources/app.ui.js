// app.ui — small things the board and the item panel both draw or do. It mounts
// nothing, so both can require it.
ns.provide('app.ui');
ns.require('app.nav');
ns.require('app.client');

// Ticks every half minute while the board is up (its root starts it), so a
// lease counts down, and vanishes when it lapses, without asking the server.
app.ui.clock ??= signals.signal(Date.now());

// The last thing that went wrong, shown until the next thing goes right.
app.ui.problem ??= signals.signal(null);

/** A change from the page: `fn` on `input`, then a refresh. A refusal shows its own words, and the board is asked again so it shows the truth. Resolves to the answer, or undefined when it failed. */
app.ui.act = (fn, input) => app.client.call(fn, input).then(
  (value) => { app.ui.problem.value = null; return value; },
  (e) => { app.ui.problem.value = e.message; return app.client.refresh().then(() => undefined); });

/** The current URL with some query parameters changed; a null removes one. Read in render, so links follow the URL. */
app.ui.href = (changes) => {
  const url = new URL(app.nav.url());
  for (const [k, v] of Object.entries(changes)) { if (v == null) url.searchParams.delete(k); else url.searchParams.set(k, v); }
  return url.pathname + url.search;
};

app.ui.nameOf = (name) => name ?? "Member";

/** The claim if its lease is still running by this tab's clock, else null. */
app.ui.live = (claim) => (claim && Date.parse(claim.until) > app.ui.clock.value ? claim : null);

/** "14m" or "3h 20m": how long a lease has left. */
app.ui.left = (until) => {
  const m = Math.max(1, Math.round((Date.parse(until) - app.ui.clock.value) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

app.ui.when = (iso) => new Date(iso).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});

// A person's colour comes from their id, so it stays theirs when their name changes.
const hue = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

app.ui.Face = ({id, name}) => {
  const shown = app.ui.nameOf(name);
  const letters = shown.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return html`<span class="face" title=${shown} style=${{"--hue": hue(id)}}>${letters}</span>`;
};

// Who holds a card, and for how long. An agent is shown by its own name, marked
// out, since seeing which cards are with agents is half of what the board is for.
app.ui.Claim = ({claim}) => {
  const c = app.ui.live(claim);
  if (!c) return null;
  return html`<span class=${`claim${c.agent ? " by-agent" : ""}${c.mine ? " mine" : ""}`}
                    title=${`${app.ui.nameOf(c.name)}${c.agent ? `'s agent ${c.agent}` : ""}, until ${app.ui.when(c.until)}`}>
    <${app.ui.Face} id=${c.member_id} name=${c.name} />
    <span class="claim-who">${c.agent ?? app.ui.nameOf(c.name)}</span>
    <span class="claim-left">${app.ui.left(c.until)}</span>
  </span>`;
};
