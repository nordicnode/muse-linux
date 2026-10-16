# Building from source

```sh
npm install
npm start           # run in dev mode
npm run package     # zip layout via electron-packager (dist-packager/)
npm run dist        # AppImage + .deb via electron-builder (dist/)
```

Releases are cut by pushing a `v*` tag; the release workflow
builds the zip, AppImage and .deb for x64 and arm64, generates
checksums, and creates the GitHub release with notes taken from
the matching section of CHANGELOG.md.
