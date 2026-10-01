# ChopStiX

Chopsticks, the hand game, built like chess.com. Play it at **https://ishmael07.github.io/ChopStiX/**

- **Play the computer:** five bots, from Pip (400) to Sensei, who plays perfectly (the game is solved)
- **Play a friend:** send a link and play live, peer to peer, no account needed
- **Local:** two players on one device
- **2D and 3D boards** with real rigged hands, camera angles, drag-to-tap and in-place splitting
- **Rules:** Classic, Lunch Table (free swaps), or Custom
- **After the game:** accuracy, graded moves, replay, and a local rating

Your name and rating are saved in your browser on this device.

## Run locally

```bash
npm install
npm run dev
```

`npm run build` outputs a static site in `dist/`. Pushing to `main` deploys to GitHub Pages.

## Credits

Hand models: WebXR Input Profiles "generic-hand" (MIT, © Amazon), see `public/models/LICENSE-webxr-input-profiles.md`.
