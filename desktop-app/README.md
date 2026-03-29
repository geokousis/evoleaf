# EvoLeaf Desktop App

This Electron wrapper loads the hosted EvoLeaf instance at:

- `https://evo-leaf.com/`

The app prompts for the Nginx gateway username and password the first time it reaches the site, stores them per local OS user, and reuses them on later launches. It also uses a persistent browser partition, so the Overleaf session cookie survives app restarts until the user logs out from EvoLeaf.

Available account actions from the app menu:

- open EvoLeaf
- log out of EvoLeaf
- forget saved Nginx gateway credentials

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
