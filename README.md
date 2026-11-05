# herdr-issues

A mod for the [Herdr](https://herdr.dev) desktop app: a side panel with the GitHub issues or Jira tickets assigned to you for the current project, and one click to start an agent on one.

The mod lives in `mods/issues/`, with a `RECIPE.md` (the brief to build it from
scratch) and a `preview.png`.

## Mods

- **[Issues](RECIPE.md):** GitHub issues or Jira tasks for the current project in a side panel, and ▶ to start an agent on one, on its own branch and folder.

## Develop

```sh
ln -s "$PWD/mods/issues" ~/.config/herdr-app/mods/issues
npm test                                    # node --test, no dependencies
herdr-app check ~/.config/herdr-app/mods/issues
```

Herdr doesn't hot-reload a symlinked mod: after editing, switch layouts away
and back (`herdr-app do layout.switch '{"name":"main"}'`, then your layout).
