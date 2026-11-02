// server.store — the board's tables and every verb on them. Nothing here is
// open to anyone: a function bare on the namespace is the owner's, by
// site.fn.call in a run. server.board opens these to agents and server.page to
// the page, so an agent and a person always go through the same rules.
//
// Each verb is (input, cx), the shape of any server function. A page's input
// arrives unchecked, an agent's checked against its schema; the verbs check
// what matters either way.
ns.provide('server.store');
ns.require('shared.board');

const sqlList = (lanes) => lanes.map((l) => `'${l.id}'`).join(", ") || "''";
const CLOSED = sqlList(shared.board.lanes.filter((l) => l.closed));
const HIDDEN = sqlList(shared.board.lanes.filter((l) => l.hidden));
const LANE_ORDER = `CASE lane ${shared.board.lanes.map((l, i) => `WHEN '${l.id}' THEN ${i}`).join(" ")} END`;

// One counter for every change, people's included: the page's stamp and an
// agent's changes(since) both read it. Nothing that matters is deleted, so a
// note or a dependency moves its item's seq instead of needing a feed of its own.
const NEXT_SEQ = "(SELECT IFNULL(MAX(seq), 0) + 1 FROM (SELECT seq FROM items UNION ALL SELECT seq FROM people))";

// Blocked means something this item depends on is still open. A closed
// blocker stops blocking by itself, with nothing to update.
const HAS_OPEN_BLOCKER = `EXISTS (SELECT 1 FROM deps d JOIN items b ON b.id = d.on_id WHERE d.item_id = items.id AND b.lane NOT IN (${CLOSED}))`;

const ADD_ITEM = "INSERT INTO items (title, body, lane, rank, author, revision, seq, updated_at) VALUES (?, ?, ?," +
                 ` (SELECT IFNULL(MAX(rank), 0) + 1 FROM items WHERE lane = ?), ?, 1, ${NEXT_SEQ}, ?)`;

// Run once with site.fn.call; safe to run again. You, who run it, are the first lead.
//
// claim_until is epoch milliseconds, a number the SQL can compare to now: the
// lease is the only clock here, so no timer has to clear a claim and a holder
// who vanishes simply stops holding it. deps has one primary key, as every table
// must, so the pair is spelled into it and adding one twice is a no-op.
server.store.setup = async (_, {caller, db}) => {
  if (caller.kind !== "member") throw new Error("Run setup as a member of the site: it makes you the first lead.");
  await db.transact([
    ["CREATE TABLE IF NOT EXISTS people (member_id TEXT PRIMARY KEY, name TEXT, role TEXT, seq INTEGER, generation INTEGER)"],
    ["CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT, body TEXT, lane TEXT, rank REAL, author TEXT," +
     " claim_member TEXT, claim_agent TEXT, claim_agent_name TEXT, claim_until INTEGER, revision INTEGER, seq INTEGER, updated_at TEXT)"],
    ["CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, item_id INTEGER, member_id TEXT, agent TEXT, body TEXT, at TEXT)"],
    ["CREATE TABLE IF NOT EXISTS deps (id TEXT PRIMARY KEY, item_id INTEGER, on_id INTEGER)"],
    ["CREATE INDEX IF NOT EXISTS items_lane ON items (lane, rank)"],
    ["CREATE INDEX IF NOT EXISTS items_seq ON items (seq)"],
    ["CREATE INDEX IF NOT EXISTS notes_item ON notes (item_id)"],
    ["CREATE INDEX IF NOT EXISTS deps_item ON deps (item_id)"]], {label: "store/setup"});
  await db.transact([[`INSERT OR IGNORE INTO people VALUES (?, NULL, 'lead', ${NEXT_SEQ}, ?)`,
                      [caller.id, caller.membership.generation]]], {label: "store/seat-first"});
  // Three cards so the first look is a board and not a blank page. Only ever
  // into an empty board, so running setup again adds nothing.
  const [{n}] = await db.query("SELECT COUNT(*) AS n FROM items");
  if (n === 0) {
    const first = (title, body) => [ADD_ITEM, [title, body, shared.board.start, shared.board.start, caller.id, new Date().toISOString()]];
    await db.transact([
      first("Drag me to Doing", "On a phone, open a card and use its lane menu."),
      first("Claim something", "A claim says you are on it, for as long as its lease runs. Claim again to renew; a lease that lapses frees the card by itself."),
      first("Ask your agent to pick up the next card", "It works this board with the agent functions, as you: board/overview, then board/claim.")],
      {label: "store/seed"});
  }
  return {seated: caller.id, role: "lead"};
};

// ---- people ----

// The caller's role as of the stay they are in: their row, written on their
// first call from the invite's data. The data is trusted because only staff
// can make an invite, but it is the invite's input, not the role: once written,
// the row is. Without the generation clause someone who left and came back
// would keep the role they had for good.
const seat = async ({caller, db}) => {
  const {generation, data} = caller.membership;
  const [row] = await db.query("SELECT role, generation FROM people WHERE member_id = ?", [caller.id]);
  if (row && row.generation === generation) return row.role;
  const role = data?.role === "lead" ? "lead" : "member";
  await db.transact([[`INSERT INTO people VALUES (?, NULL, ?, ${NEXT_SEQ}, ?) ON CONFLICT (member_id) DO UPDATE` +
                      " SET name = NULL, role = excluded.role, seq = excluded.seq, generation = excluded.generation" +
                      " WHERE people.generation IS NOT excluded.generation", [caller.id, role, generation]]], {label: "store/seat"});
  return role;
};

// `rows` as the roster has them now. A name is the person's and changes on
// their account page with no event, so it is read fresh and never stored while
// they are here. The platform does not say when someone goes either, so the
// same read notices: a row whose person left, was removed, was deleted or is
// back in a later stay is retired, keeping the name they had, and their old
// notes still have an author to show.
const present = async (rows, {db, members}) => {
  const ids = rows.filter((r) => r.role != null).map((r) => r.member_id);
  const now = {};
  for (let i = 0; i < ids.length; i += 200)
    (await members.get(ids.slice(i, i + 200))).forEach((m, j) => { now[ids[i + j]] = m; });
  const out = [];
  for (const {generation, ...r} of rows) {
    const m = now[r.member_id];
    if (r.role == null) out.push(r);
    else if (["active", "suspended"].includes(m?.status) && m.membership.generation === generation) out.push({...r, name: m.name});
    else {
      const name = m && m.status !== "deleted" ? m.name : null;
      await db.transact([[`UPDATE people SET role = NULL, name = ?, seq = ${NEXT_SEQ} WHERE member_id = ? AND generation = ?`,
                          [name, r.member_id, generation]]], {label: "store/retire"});
      out.push({...r, role: null, name});
    }
  }
  return out;
};

// ---- reading items ----

// Who is acting: a person, or one of their agents. Agents are told apart by
// connection, so two of one person's agents can't both think they hold a card.
const actor = ({caller, request}) => ({member: caller.id, agent: request.agent?.id ?? null, agentName: request.agent?.name ?? null});

// True when `me` is the holder. A person holds what their own agents hold, so
// they can always take a card back from a stuck one; an agent holds only its own.
const holds = (row, me) => row.claim_member === me.member && (me.agent == null || row.claim_agent === me.agent);

// The same test in SQL, for the WHERE that decides a race. MINE alone ends a
// claim; FREE_OR_MINE may start one or move the card.
const MINE = "(claim_member = ? AND (? IS NULL OR claim_agent IS ?))";
const mine = (me) => [me.member, me.agent, me.agent];
const FREE_OR_MINE = `(claim_until IS NULL OR claim_until <= ? OR ${MINE})`;
const freeOrMine = (me, now) => [now, ...mine(me)];

const NO_CLAIM = "claim_member = NULL, claim_agent = NULL, claim_agent_name = NULL, claim_until = NULL";

const ROW = "id, title, lane, claim_member, claim_agent, claim_agent_name, claim_until, revision, seq, updated_at," +
            " (SELECT COUNT(*) FROM notes WHERE notes.item_id = items.id) AS notes";

// A function from a row to what callers see, holding the reads that every row
// in one answer shares: the people, and what is blocked by what.
const viewer = async (cx) => {
  const rows = await cx.db.query("SELECT member_id, name, role, generation FROM people ORDER BY member_id");
  const people = new Map((await present(rows, cx)).map((p) => [p.member_id, p]));
  const blockers = new Map();
  for (const {item_id, on_id} of await cx.db.query(
    `SELECT d.item_id, d.on_id FROM deps d JOIN items b ON b.id = d.on_id WHERE b.lane NOT IN (${CLOSED})`))
    blockers.set(item_id, [...(blockers.get(item_id) ?? []), on_id]);
  const me = actor(cx), now = Date.now();
  return {
    people,
    item: (r) => ({
      id: r.id, title: r.title, lane: r.lane, notes: r.notes, revision: r.revision, seq: r.seq, updated_at: r.updated_at,
      blocked_by: blockers.get(r.id) ?? [],
      // A lapsed claim reads as no claim: nothing has to clear it.
      claim: r.claim_until > now
        ? {member_id: r.claim_member, name: people.get(r.claim_member)?.name ?? null, agent: r.claim_agent_name,
           until: new Date(r.claim_until).toISOString(), mine: holds(r, me)}
        : null}),
  };
};

// Every "no" on a named item starts here: does it exist.
const noItem = (id) => cyba.refuse({code: "no_such_item", message: `There is no item ${id}.`});
const idOf = (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw noItem(id);
  return n;
};
const rowOf = async (id, {db}) => {
  const [r] = await db.query(`SELECT ${ROW} FROM items WHERE id = ?`, [id]);
  if (!r) throw noItem(id);
  return r;
};

const heldRefusal = (r, people) => {
  const who = people.get(r.claim_member)?.name ?? "Someone";
  const until = new Date(r.claim_until).toISOString();
  return cyba.refuse({code: "held", message: `#${r.id} is held by ${who}${r.claim_agent_name ? `'s agent ${r.claim_agent_name}` : ""} until ${until}.`,
                      data: {holder: who, agent: r.claim_agent_name, until}});
};

const textOf = (value, what, max) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Give it ${what}.`);
  if (t.length > max) throw new Error(`Keep ${what} under ${max} characters.`);
  return t;
};
const bodyOf = (value) => (value == null || !String(value).trim() ? "" : textOf(value, "the body", 8000));

// A cursor is one this function answered; anything else is refused, not read as 0.
const after = (cursor, from = 0) => {
  if (cursor == null) return from;
  if (!/^\d+$/.test(cursor)) throw cyba.refuse({code: "bad_cursor", message: "That cursor is not one this function gave: pass back its next."});
  return Number(cursor);
};

const countsOf = ({db}) => db.query("SELECT lane, COUNT(*) AS n FROM items GROUP BY lane");
const countIn = (counts, id) => counts.find((c) => c.lane === id)?.n ?? 0;

// All the page draws: each lane's cards, and of a closed lane only the latest
// few, since a board's Done grows forever.
server.store.board = async (_, cx) => {
  const role = await seat(cx);
  const view = await viewer(cx);
  const counts = await countsOf(cx);
  const lanes = [];
  for (const l of shared.board.shown()) {
    const rows = await cx.db.query(`SELECT ${ROW} FROM items WHERE lane = ? ORDER BY rank, id LIMIT ?`, [l.id, l.closed ? 30 : 300]);
    lanes.push({id: l.id, total: countIn(counts, l.id), items: rows.map(view.item)});
  }
  return {me: {id: cx.caller.id, role}, people: [...view.people.values()], lanes};
};

// What an agent wants on arriving: where things stand, what it holds, what to do next.
server.store.overview = async (_, cx) => {
  const role = await seat(cx);
  const view = await viewer(cx);
  const counts = await countsOf(cx);
  const me = actor(cx), now = Date.now();
  const holding = await cx.db.query(`SELECT ${ROW} FROM items WHERE claim_until > ? AND ${MINE} ORDER BY claim_until LIMIT 50`, [now, ...mine(me)]);
  const ready = await cx.db.query(
    `SELECT ${ROW} FROM items WHERE lane = ? AND (claim_until IS NULL OR claim_until <= ?) AND NOT ${HAS_OPEN_BLOCKER} ORDER BY rank, id LIMIT 5`,
    [shared.board.start, now]);
  return {
    you: {member_id: me.member, name: view.people.get(me.member)?.name ?? null, role, agent: me.agentName},
    lanes: shared.board.lanes.map((l) => ({id: l.id, name: l.name, hint: l.hint, closed: !!l.closed, count: countIn(counts, l.id)})),
    holding: holding.map(view.item),
    ready: ready.map(view.item),
  };
};

// A page of items in board order. The cursor is an offset, since an order by
// rank has no stable key to page on and a board moves slowly.
server.store.items = async ({lane, q, cursor, limit = 50}, cx) => {
  await seat(cx);
  const view = await viewer(cx);
  const offset = after(cursor);
  const rows = await cx.db.query(
    `SELECT ${ROW} FROM items WHERE ((? IS NULL AND lane NOT IN (${HIDDEN})) OR lane = ?)` +
    " AND (? IS NULL OR instr(lower(title || ' ' || body), lower(?)) > 0)" +
    ` ORDER BY ${LANE_ORDER}, rank, id LIMIT ? OFFSET ?`,
    [lane ?? null, lane ?? null,
     q ?? null, q ?? null,
     limit, offset]);
  return {items: rows.map(view.item), next: rows.length === limit ? String(offset + limit) : null};
};

// One item whole: its text, what it waits on and holds up, and its latest notes.
// Fifty at their longest still fit what an agent may be answered, and a long
// thread can't grow an item past reading; `notes` says how many there are in all.
server.store.item = async ({id}, cx) => {
  await seat(cx);
  const n = idOf(id);
  const view = await viewer(cx);
  const r = await rowOf(n, cx);
  const [{body}] = await cx.db.query("SELECT body FROM items WHERE id = ?", [n]);
  const thread = (await cx.db.query("SELECT id, member_id, agent, body, at FROM notes WHERE item_id = ? ORDER BY id DESC LIMIT 50", [n])).reverse();
  return {
    ...view.item(r), body,
    depends_on: await cx.db.query("SELECT i.id, i.title, i.lane FROM deps d JOIN items i ON i.id = d.on_id WHERE d.item_id = ? ORDER BY i.id", [n]),
    blocks: await cx.db.query("SELECT i.id, i.title, i.lane FROM deps d JOIN items i ON i.id = d.item_id WHERE d.on_id = ? ORDER BY i.id", [n]),
    thread: thread.map((t) => ({...t, name: view.people.get(t.member_id)?.name ?? null})),
  };
};

// Oldest first, so an agent keeps the last seq it read and misses nothing.
server.store.changes = async ({since = 0, cursor, limit = 50}, cx) => {
  await seat(cx);
  const view = await viewer(cx);
  const rows = await cx.db.query(`SELECT ${ROW} FROM items WHERE seq > ? ORDER BY seq LIMIT ?`, [after(cursor, since), limit]);
  return {items: rows.map(view.item), next: rows.length === limit ? String(rows.at(-1).seq) : null};
};

// One small value that moves whenever anything changes: the page polls this, not the board.
server.store.stamp = async (_, {db}) => (await db.query(`SELECT ${NEXT_SEQ} - 1 AS seq`))[0].seq;

// ---- changing items ----
//
// The rule throughout: the condition is in the UPDATE, so two callers can't both
// win; only when nothing changed does a verb look why, to say the right no.

// `expect` turns "the UPDATE matched nothing" into a rolled-back batch, the way
// to keep a later statement in the batch from running on a no.
const orRefuse = (batch, label, refusal, {db}) => db.transact(batch, {label}).catch((e) => {
  throw e.code === "expectation" ? refusal() : e;
});

server.store.add = async ({title, body, lane}, cx) => {
  await seat(cx);
  const t = textOf(title, "a title", 200);
  const to = lane ?? shared.board.start;
  const l = shared.board.lane(to);
  if (!l || l.closed) throw cyba.refuse({code: "no_such_lane", message: `Add to an open lane, not ${to}.`});
  const {changes} = await cx.db.transact([[ADD_ITEM, [t, bodyOf(body), to, to, cx.caller.id, new Date().toISOString()]]], {label: "items/add"});
  return server.store.item({id: changes[0].id}, cx);
};

// A revision is optional: pass the one you read and a stale edit is refused
// rather than writing over someone else's words.
server.store.edit = async ({id, title, body, revision}, cx) => {
  await seat(cx);
  const n = idOf(id);
  if (title === undefined && body === undefined) throw new Error("Pass a title, a body, or both.");
  const r = await rowOf(n, cx);
  await orRefuse([[
    `UPDATE items SET title = IFNULL(?, title), body = IFNULL(?, body), revision = revision + 1, seq = ${NEXT_SEQ}, updated_at = ?` +
    " WHERE id = ? AND revision = ?",
    [title === undefined ? null : textOf(title, "a title", 200), body === undefined ? null : bodyOf(body),
     new Date().toISOString(), n, revision ?? r.revision], {expect: 1}]],
    "items/edit", () => cyba.refuse({code: "changed", message: `#${n} changed since you read it: read it again.`}), cx);
  return server.store.item({id: n}, cx);
};

// The rank that puts a card ahead of `before`, or at the end of its lane. A
// closed lane's end is its top, so the newest finished work is what's on show.
// Halfway between neighbours means moving one card rewrites one row; a race
// only ties two ranks, and ORDER BY rank, id still has an answer.
const rankFor = async (lane, before, moving, {db}) => {
  if (before == null) {
    const [{lo, hi}] = await db.query("SELECT MIN(rank) AS lo, MAX(rank) AS hi FROM items WHERE lane = ? AND id != ?", [lane, moving]);
    if (lo == null) return 1;
    return shared.board.lane(lane).closed ? lo - 1 : hi + 1;
  }
  const [b] = await db.query("SELECT rank FROM items WHERE id = ? AND lane = ?", [idOf(before), lane]);
  if (!b) throw cyba.refuse({code: "no_such_item", message: `#${before} is not in ${lane}.`});
  const [{prev}] = await db.query("SELECT MAX(rank) AS prev FROM items WHERE lane = ? AND rank < ? AND id != ?", [lane, b.rank, moving]);
  return prev == null ? b.rank - 1 : (prev + b.rank) / 2;
};

// Changing lane hands the card on, so it ends the claim: whoever picks it up in
// the next lane claims it there. Reordering within a lane is nobody's work, so
// it needs no claim and leaves one alone. Taking a card out of someone's live
// claim is refused; a hidden lane, in or out, is a lead's call.
server.store.move = async ({id, lane, before}, cx) => {
  const role = await seat(cx);
  const n = idOf(id);
  const to = shared.board.lane(lane);
  if (!to) throw cyba.refuse({code: "no_such_lane", message: `There is no lane ${lane}: ${shared.board.lanes.map((l) => l.id).join(", ")}.`});
  const r = await rowOf(n, cx);
  if (r.lane !== lane && (to.hidden || shared.board.lane(r.lane)?.hidden) && role !== "lead")
    throw cyba.refuse({code: "not_lead", message: "Only a lead can drop a card, or bring one back."});
  const rank = await rankFor(lane, before, n, cx);
  const me = actor(cx), now = Date.now(), at = new Date(now).toISOString();
  if (r.lane === lane) {
    await cx.db.transact([[`UPDATE items SET rank = ?, seq = ${NEXT_SEQ}, updated_at = ? WHERE id = ?`, [rank, at, n]]], {label: "items/reorder"});
  } else {
    const {changes} = await cx.db.transact([[
      `UPDATE items SET lane = ?, rank = ?, seq = ${NEXT_SEQ}, updated_at = ?, ${NO_CLAIM} WHERE id = ? AND ${FREE_OR_MINE}`,
      [lane, rank, at, n, ...freeOrMine(me, now)]]], {label: "items/move"});
    if (!changes.length) throw heldRefusal(await rowOf(n, cx), (await viewer(cx)).people);
  }
  return server.store.item({id: n}, cx);
};

// SET fragments that move a card from one lane to the end of another, if it's there.
const relane = (from, to) => ({
  sql: "rank = CASE WHEN lane = ? THEN (SELECT IFNULL(MAX(rank), 0) + 1 FROM items WHERE lane = ?) ELSE rank END, lane = CASE WHEN lane = ? THEN ? ELSE lane END",
  params: [from, to, from, to],
});

// Claiming what you hold renews it; a lapsed claim is simply taken. The whole
// decision is one UPDATE, so of two agents arriving together exactly one wins.
server.store.claim = async ({id, minutes = 30}, cx) => {
  await seat(cx);
  const n = idOf(id);
  const me = actor(cx), now = Date.now();
  const until = now + Math.min(Math.max(Math.trunc(Number(minutes)) || 30, 1), 240) * 60000;
  const to = relane(shared.board.start, shared.board.working);
  const {changes} = await cx.db.transact([[
    `UPDATE items SET claim_member = ?, claim_agent = ?, claim_agent_name = ?, claim_until = ?, seq = ${NEXT_SEQ}, updated_at = ?, ${to.sql}` +
    ` WHERE id = ? AND lane NOT IN (${CLOSED}) AND NOT ${HAS_OPEN_BLOCKER} AND ${FREE_OR_MINE}`,
    [me.member, me.agent, me.agentName, until, new Date(now).toISOString(),
     ...to.params, n, ...freeOrMine(me, now)]]], {label: "items/claim"});
  if (changes.length) return server.store.item({id: n}, cx);
  const r = await rowOf(n, cx);
  const view = await viewer(cx);
  if (shared.board.lane(r.lane).closed) throw cyba.refuse({code: "closed", message: `#${n} is ${r.lane}: there is nothing to claim.`});
  const {blocked_by} = view.item(r);
  if (blocked_by.length) throw cyba.refuse({code: "blocked", message: `#${n} is waiting on ${blocked_by.map((b) => `#${b}`).join(", ")}.`, data: {blocked_by}});
  throw heldRefusal(r, view.people);
};

const addNote = (n, me, body, at) => ["INSERT INTO notes (item_id, member_id, agent, body, at) VALUES (?, ?, ?, ?, ?)", [n, me.member, me.agentName, body, at]];

// Gives a claim up. Work that was in the working lane goes back where it can be
// picked up again; a note says why, for whoever does.
server.store.release = async ({id, note}, cx) => {
  await seat(cx);
  const n = idOf(id);
  const me = actor(cx), now = Date.now(), at = new Date(now).toISOString();
  const said = note == null ? null : textOf(note, "a note", 4000);
  await rowOf(n, cx);
  const to = relane(shared.board.working, shared.board.start);
  await orRefuse([
    [`UPDATE items SET ${NO_CLAIM}, seq = ${NEXT_SEQ}, updated_at = ?, ${to.sql} WHERE id = ? AND claim_until > ? AND ${MINE}`,
     [at, ...to.params, n, now, ...mine(me)], {expect: 1}],
    ...(said ? [addNote(n, me, said, at)] : [])],
    "items/release", () => cyba.refuse({code: "not_held", message: `You hold no claim on #${n}.`}), cx);
  return server.store.item({id: n}, cx);
};

// The item's seq moves in the same batch, and expect makes a note on an item
// that isn't there a refusal rather than an orphan row.
server.store.note = async ({id, body}, cx) => {
  await seat(cx);
  const n = idOf(id);
  const at = new Date().toISOString();
  const text = textOf(body, "some words", 4000);
  await orRefuse([[`UPDATE items SET seq = ${NEXT_SEQ}, updated_at = ? WHERE id = ?`, [at, n], {expect: 1}], addNote(n, actor(cx), text, at)],
                 "items/note", () => noItem(n), cx);
  return server.store.item({id: n}, cx);
};

// `id` waits on `on`. Walking the edges before writing can race another depend,
// and the worst that race does is a loop two people can see and undo, so it isn't
// worth more than this.
server.store.depend = async ({id, on, remove}, cx) => {
  await seat(cx);
  const n = idOf(id), o = idOf(on);
  await rowOf(n, cx);
  await rowOf(o, cx);
  const bump = [`UPDATE items SET seq = ${NEXT_SEQ}, updated_at = ? WHERE id = ?`, [new Date().toISOString(), n]];
  if (remove) {
    await cx.db.transact([["DELETE FROM deps WHERE id = ?", [`${n}>${o}`]], bump], {label: "items/undepend"});
    return server.store.item({id: n}, cx);
  }
  const edges = await cx.db.query("SELECT item_id, on_id FROM deps");
  const seen = new Set();
  const reaches = (from) => from === n || edges.some((e) => e.item_id === from && !seen.has(e.on_id) && (seen.add(e.on_id), reaches(e.on_id)));
  if (reaches(o)) throw cyba.refuse({code: "cycle", message: `#${n} waiting on #${o} would make a loop.`});
  await cx.db.transact([["INSERT OR IGNORE INTO deps VALUES (?, ?, ?)", [`${n}>${o}`, n, o]], bump], {label: "items/depend"});
  return server.store.item({id: n}, cx);
};
