// server.board — the board's API: what a member's agent calls through api-call,
// as its person. Thin adapters over server.store. The words here are what an
// agent reads instead of this code, so they say what each call is for, what
// comes next, and what each no means. Agents read them fresh each time, so
// change anything here freely.
ns.provide('server.board');
ns.require('server.store');
ns.require('shared.board');

const LANES = shared.board.lanes.map((l) => l.id);

// An agent hears a refusal only if its function declares the code, so each
// lists the ones it can answer, in words that say what to do about it.
const NO = {
  no_such_item: {message: "No item has that id: board/items lists them."},
  no_such_lane: {message: `Lanes are ${LANES.join(", ")}.`},
  held: {message: "Someone holds a live claim on it: its data says who and until when. Pick something else, or wait for the lease."},
  blocked: {message: "It waits on open items, listed in its data. Finish those, or board/depend with remove if the wait is wrong."},
  closed: {message: "It is finished or dropped: board/move it back to an open lane first if it needs more work."},
  not_held: {message: "You hold no live claim on it, perhaps because the lease lapsed. board/claim it again if you are still working."},
  not_lead: {message: "Only a lead may; ask one, or leave a board/note saying what you would do."},
  changed: {message: "It was edited since you read it: board/item again, and redo the edit on what's there."},
  cycle: {message: "That would make two items wait on each other."},
  bad_cursor: {message: "Pass back the next a page answered."},
};
const refusals = (...codes) => Object.fromEntries(codes.map((c) => [c, NO[c]]));

const ID = {type: "integer", minimum: 1, description: "The item's number, the 12 of #12."};
const object = (properties, required = []) => ({type: "object", properties, required, additionalProperties: false});

server.board.overview = cyba.agent({
  describe: "Start here: the lanes, what you hold, and what is ready to pick up.",
  doc: "Answers {you, lanes, holding, ready}. `holding` is what this connection has a live claim on: renew or finish those first. " +
       "`ready` is the top of the backlog with nothing in the way, best first, so the usual loop is: board/claim the first of them, " +
       "board/item to read it, do the work, board/note what you did, board/move it on.",
  input: object({}),
  hints: {after: ["board/claim", "board/item", "board/items"]},
}, (input, cx) => server.store.overview(input, cx));

server.board.items = cyba.agent({
  describe: "List items, filtered by lane or by words.",
  doc: "Each item is {id, title, lane, notes, revision, seq, updated_at, blocked_by, claim}, in board order. `lane` names one lane, and is the only way " +
       "to see a hidden one. `q`: words in the title or body. For what you hold and what's ready, board/overview.",
  input: object({lane: {enum: LANES}, q: {type: "string", minLength: 1, maxLength: 200}}),
  paged: true,
  hints: {after: ["board/item", "board/claim"], narrow: "Pass lane or q.", refusals: refusals("bad_cursor")},
}, (input, cx) => server.store.items(input, cx));

server.board.item = cyba.agent({
  describe: "Read one item whole: its text, notes, and dependencies.",
  doc: "An item as board/items gives it, plus `body`, `thread` (its latest 50 notes, oldest first, each {name, agent, body, at}; `notes` is how many in all), " +
       "`depends_on` and `blocks` (each {id, title, lane}). Read the thread before you start: it's what the last one to work on it left you.",
  input: object({id: ID}, ["id"]),
  max: 262144,
  hints: {after: ["board/claim", "board/note"], refusals: refusals("no_such_item")},
}, (input, cx) => server.store.item(input, cx));

server.board.add = cyba.agent({
  describe: "Add an item to the board.",
  doc: `Adds an item at the end of \`lane\` (default ${shared.board.start}), an open lane, and answers it whole. Write the title so someone who wasn't there knows what done looks like; put the rest in body.`,
  input: object({title: {type: "string", minLength: 1, maxLength: 200}, body: {type: "string", maxLength: 8000}, lane: {enum: LANES}}, ["title"]),
  hints: {after: ["board/depend", "board/claim"], refusals: refusals("no_such_lane")},
}, (input, cx) => server.store.add(input, cx));

server.board.edit = cyba.agent({
  describe: "Change an item's title or body.",
  doc: "Pass title, body or both. Pass the `revision` you read and an edit made since is refused rather than overwritten. To say something happened, board/note is usually what you want instead.",
  input: object({id: ID, title: {type: "string", minLength: 1, maxLength: 200}, body: {type: "string", maxLength: 8000}, revision: {type: "integer"}}, ["id"]),
  hints: {refusals: refusals("no_such_item", "changed")},
}, (input, cx) => server.store.edit(input, cx));

server.board.claim = cyba.agent({
  describe: "Say you're working on an item, on a lease. Claiming what you hold renews it.",
  doc: `Takes the item for \`minutes\` from now and moves it from ${shared.board.start} to ${shared.board.working}; an item already further along stays where it is. ` +
       "Claim before you start, and again before the lease runs out: when it lapses anyone may take the item, with no warning to you. Refused if someone else's claim is live, " +
       "if it waits on open items, or if it is finished.",
  input: object({id: ID, minutes: {type: "integer", minimum: 1, maximum: 240, default: 30, description: "How long the lease lasts."}}, ["id"]),
  hints: {after: ["board/item", "board/note", "board/move", "board/release"], refusals: refusals("no_such_item", "held", "blocked", "closed")},
}, (input, cx) => server.store.claim(input, cx));

server.board.release = cyba.agent({
  describe: "Give up your claim, saying why, so someone else can pick the item up.",
  doc: `Ends your claim; an item in ${shared.board.working} goes back to ${shared.board.start}. Pass \`note\` to leave what you found for the next one. When the work is finished use board/move instead, which ends the claim too.`,
  input: object({id: ID, note: {type: "string", minLength: 1, maxLength: 4000}}, ["id"]),
  hints: {after: ["board/overview"], refusals: refusals("no_such_item", "not_held")},
}, (input, cx) => server.store.release(input, cx));

server.board.move = cyba.agent({
  describe: "Move an item to another lane, or reorder it within one.",
  doc: "Puts the item in `lane`, ahead of the item `before` if given, else at the end. Changing lane ends any claim on it, since whoever works on it next claims it there. " +
       "Refused while someone else holds it. The hidden lane is how an item goes away, and only a lead may move a card in or out of it.",
  input: object({id: ID, lane: {enum: LANES}, before: {type: "integer", minimum: 1, description: "The item in that lane to go ahead of."}}, ["id", "lane"]),
  hints: {after: ["board/overview"], refusals: refusals("no_such_item", "no_such_lane", "held", "not_lead")},
}, (input, cx) => server.store.move(input, cx));

server.board.note = cyba.agent({
  describe: "Leave a note on an item: what you did, found or decided.",
  doc: "Adds to the item's thread under your person's name and your agent's. Notes are how the next one picks up where you stopped, so say what changed and what is left, and any place the work now lives.",
  input: object({id: ID, body: {type: "string", minLength: 1, maxLength: 4000}}, ["id", "body"]),
  hints: {after: ["board/move", "board/release"], refusals: refusals("no_such_item")},
}, (input, cx) => server.store.note(input, cx));

server.board.depend = cyba.agent({
  describe: "Say an item waits on another, or that it no longer does.",
  doc: "`id` waits on `on`: `id` can't be claimed until `on` reaches a closed lane. With remove: true the wait is taken away. Adding one twice is harmless.",
  input: object({id: ID, on: {type: "integer", minimum: 1, description: "The item it waits on."}, remove: {type: "boolean", default: false}}, ["id", "on"]),
  hints: {refusals: refusals("no_such_item", "cycle")},
}, (input, cx) => server.store.depend(input, cx));

server.board.changes = cyba.agent({
  describe: "What changed on the board since you last looked.",
  doc: "Items changed after seq `since` (0: all), oldest first, each as board/items gives it; a new note or dependency counts as a change to its item. Keep the last seq and pass it next time.",
  input: object({since: {type: "integer", minimum: 0, default: 0}}),
  paged: true,
  hints: {after: ["board/item"], refusals: refusals("bad_cursor")},
}, (input, cx) => server.store.changes(input, cx));
