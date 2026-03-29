# EvoLeaf Desktop App

This Electron wrapper loads the hosted EvoLeaf instance at:

- `https://evo-leaf.com/`

The app uses a persistent browser partition, so the Overleaf session cookie survives app restarts until the user logs out from EvoLeaf.

## Build

Install dependencies:

```bash
cd /media/storage/kousis/overleaf-toolkit/desktop-app
npm install
```

Run locally:

```bash
npm start
```

Package for Linux:

```bash
npm run dist:linux
```

Package for Windows:

```bash
npm run dist:win
```

Build artifacts are created under:

- `desktop-app/dist/`
