ns.provide('app.client');

// The page's one value: every answer it has asked for, by function and input.
app.client.answers ??= signals.signal({});

const keyOf = (fn, input) => fn + " " + JSON.stringify(input);
const answered = (answers, key, entry) => ({...answers, [key]: {...answers[key], ...entry}});

/** Ask `fn` with `input` and keep the answer, or the error, under that pair. */
app.client.load = async (fn, input = {}) => {
  const key = keyOf(fn, input);
  try {
    const value = await cyba.call(fn, input);
    cyba.update(app.client.answers, (a) => answered(a, key, {fn, input, value, error: null}));
  } catch (e) {
    cyba.update(app.client.answers, (a) => answered(a, key, {fn, input, error: e.message}));
  }
};

/** In a component: {value, error} of `fn` on `input` — value null until it answers. Asked once, then kept fresh. */
app.client.useQuery = (fn, input = {}) => {
  const key = keyOf(fn, input);
  preact.useEffect(() => { if (!(key in app.client.answers.peek())) app.client.load(fn, input); }, [key]);
  return app.client.answers.value[key] ?? {value: null, error: null};
};

/** Stop keeping the answer of `fn` on `input`: a view on its way out, so a refresh no longer asks for it. */
app.client.forget = (fn, input = {}) => {
  const key = keyOf(fn, input);
  cyba.update(app.client.answers, ({[key]: _, ...rest}) => rest);
};

/** Every answer the page holds, asked again. */
app.client.refresh = () => Promise.all(Object.values(app.client.answers.peek()).map((q) => app.client.load(q.fn, q.input)));

/** A change: `fn` on `input`, then a refresh. Rejects with the function's error. */
app.client.call = async (fn, input = {}) => {
  const out = await cyba.call(fn, input);
  await app.client.refresh();
  return out;
};

/** Ask `stampFn` every `ms` while the tab is visible, refreshing when it moves. Returns the stop: an effect's teardown. */
app.client.poll = (stampFn, ms = 4000) => {
  let last = null;   // the first look refreshes too: what loaded before it may already be behind
  const look = async () => {
    if (document.hidden) return;
    const stamp = await cyba.call(stampFn, {}).catch(() => last);
    if (stamp !== last) await app.client.refresh();
    last = stamp;
  };
  look();
  const timer = setInterval(look, ms);
  return () => clearInterval(timer);
};
