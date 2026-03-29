# EvoLeaf Mobile App

There are two mobile options in this repo:

1. Android users can already install the web app from `https://evo-leaf.com/app/` using the browser install prompt.
2. This Capacitor scaffold can be turned into a native Android package that opens `https://evo-leaf.com/` inside a WebView.

The native wrapper still relies on EvoLeaf's normal server-side authentication. Login persistence comes from the app WebView cookie jar until logout.

## Build Android

Install dependencies:

```bash
cd /media/storage/kousis/overleaf-toolkit/mobile-app
npm install
```

Create the Android project:

```bash
npm run android:add
```

Sync config:

```bash
npm run sync
```

Open in Android Studio:

```bash
npm run android:open
```

From Android Studio, build the APK or AAB.
