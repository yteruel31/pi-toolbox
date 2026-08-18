# Package releases

Each `packages/*` workspace is an independently versioned public npm package under `@yteruel31`.

For a package change:

```bash
npm run changeset
```

Commit the generated Markdown file with the code. To apply pending versions and changelogs locally:

```bash
npm run version:packages
```

To publish every changed/unpublished workspace version (requires npm authentication with access to the `@yteruel31` scope):

```bash
npm run check:packages
npm run release:packages
```

The root `pi-toolbox` package remains private and Git-installable as the all-in-one bundle. It is intentionally ignored by Changesets because it is not a workspace package.
