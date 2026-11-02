# Kanban

A board a person and their agents keep together. People drag cards on the page;
agents work the same board through its agent functions, as their person. Both
go through the same verbs, so a claim means the same thing to each.

Items sit in lanes. A claim says someone is on a card, on a lease that lapses by
itself. Notes carry what happened from one worker to the next. Dependencies stop a
card being claimed until what it waits on is closed. The site is private, and the
one who runs setup is its first lead.

## What to change first

- **The lanes and the name:** `shared.board`. Everything else is built
  from that list, the agent functions' docs included.
- **The look:** the tokens at the top of `site.css`.
- **The fields of a card:** add the column to `CREATE TABLE` in `store/setup`
  (on a board already running, `ALTER TABLE ... ADD COLUMN` once in a run), then
  carry it through `ROW` and `viewer` in `server.store` and
  `server.board`, so agents can see and set it.

## Where things are

| Source | What it holds |
|---|---|
| `server.store` | the tables and every rule; the owner's, by `site.fn.call` |
| `server.board` | the agent functions, in the words agents read |
| `server.page` | what the page may call, one line each |
| `app.board` | the page: lanes, cards, dragging, the root |
| `app.item` | one card opened |
| `app.ui`, `app.client`, `app.nav` | small shared pieces, the client and the router |
