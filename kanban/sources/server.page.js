// server.page — what the board page may call. Each is one line over the verbs in
// server.store, the same ones an agent reaches, so the page can't do anything
// an agent is refused or the other way round. A route protects only the page:
// these are guarded by their own access.
ns.provide('server.page');
ns.require('server.store');

// Each door gets a function of its own over the verb, since a function declared
// for one door cannot be declared for another.
const member = (verb) => cyba.callable({access: "member"}, (input, cx) => verb(input, cx));

server.page.board = member(server.store.board);
server.page.item = member(server.store.item);
server.page.add = member(server.store.add);
server.page.edit = member(server.store.edit);
server.page.move = member(server.store.move);
server.page.release = member(server.store.release);
server.page.note = member(server.store.note);
server.page.depend = member(server.store.depend);

// A person has no loop to renew a lease from, so theirs runs the longest there
// is and the page offers Renew beside it.
server.page.claim = member(({id}, cx) => server.store.claim({id, minutes: 240}, cx));

// Reads one number and seats nobody, so it can say it writes nothing, and the
// platform holds it to that.
server.page.stamp = cyba.callable({access: "member", readonly: true}, (input, cx) => server.store.stamp(input, cx));
