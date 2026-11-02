# cyba exemplars

Working websites for [cyba.page](https://cyba.page), each ready for an agent to
copy into a new site and then change.

Each folder is one site in the cyba export layout: `site.json` at its root lists
its sources, what it needs and what to do after copying. `index.json` lists the
folders, each pinned to the commit to copy from.

Inside `run`, with a new site focused and its tab open:

```js
const repo = "bhauman/cyba-exemplars@<commit>", folder = "<folder>";
const m = JSON.parse(await site.github.read(repo, `${folder}/site.json`));
for (const [name, path] of Object.entries(m.sources))
  await site.sources.write(name, await site.github.read(repo, `${folder}/${path}`));
return {settings: m.settings, after_copy: m.after_copy, readme: m.readme};
```

The source changes land together, and only if the whole site loads from scratch.
Nothing reaches visitors until `site.publish`. The loop copies sources alone: apply
`settings` with `website {op: "settings"}` and follow `after_copy` yourself.
