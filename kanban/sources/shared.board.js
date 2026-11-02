// shared.board — what the board IS, in the one place the server and the page
// both read. Change the lanes here and nothing else needs telling: the SQL, the
// agent functions' docs and the columns on screen are all built from this list.
ns.provide('shared.board');

shared.board.name = "Kanban";
shared.board.about = "A person and their agents keep work on one board.";

// A lane's id is what the rows hold, so renaming an id means an UPDATE;
// renaming its `name` means nothing at all.
//   closed — work is over: it unblocks whatever waited on it, and nobody claims it.
//   hidden — not drawn and not listed unless asked for by name: how an item
//            goes away without a DELETE, so changes(since) can still say so.
shared.board.lanes = [
  {id: "backlog", name: "Backlog", hint: "Not started"},
  {id: "doing",   name: "Doing",   hint: "Someone is on it"},
  {id: "review",  name: "Review",  hint: "Wants another pair of eyes"},
  {id: "done",    name: "Done",    hint: "Finished", closed: true},
  {id: "dropped", name: "Dropped", hint: "Decided against", closed: true, hidden: true},
];

// Where a new item lands, and where claiming one from there moves it.
shared.board.start = "backlog";
shared.board.working = "doing";

shared.board.lane = (id) => shared.board.lanes.find((l) => l.id === id) ?? null;
shared.board.shown = () => shared.board.lanes.filter((l) => !l.hidden);
