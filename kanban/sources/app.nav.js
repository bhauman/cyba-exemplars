// app.nav — the page's URL, and moving around it without a reload. One page has
// little to route, so this is the platform's router cut down to what a single
// page and a ?item= use, with the same names. A board that grows more pages
// takes site.examples("basic-site", "nav") in its place and changes nothing else.
ns.provide('app.nav');

app.nav.changed ??= signals.signal(0);
app.nav.page = () => null;

// A render reads the URL from here. On the server, location is the request's.
app.nav.url = function url() {
  app.nav.changed.value;
  return new URL(location.href);
};

// A URL this entry does not render is the browser's to load.
app.nav.go = function go(to) {
  const next = new URL(to, location.href);
  if (next.origin !== location.origin || !app.nav.page(next.pathname)) return void location.assign(next.href);
  history.pushState(null, "", next.pathname + next.search + next.hash);
  cyba.update(app.nav.changed, (n) => n + 1);
};

// A plain click on a link this entry renders stays in the page. A new tab, a
// download and a #part of the page already open stay the browser's.
app.nav.onClick = function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href]");
  if (!a || a.hasAttribute("download") || a.target) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !app.nav.page(url.pathname)) return;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
  e.preventDefault();
  app.nav.go(url.pathname + url.search + url.hash);
};

// Started by the root's effect with the entry's pages; returns its teardown.
app.nav.start = function start({page}) {
  app.nav.page = page;
  const onPop = () => cyba.update(app.nav.changed, (n) => n + 1);
  const onClick = (e) => app.nav.onClick(e);
  addEventListener("popstate", onPop);
  document.addEventListener("click", onClick);
  return () => {
    removeEventListener("popstate", onPop);
    document.removeEventListener("click", onClick);
  };
};
