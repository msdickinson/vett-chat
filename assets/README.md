# Marketplace assets

`icon.svg` is the source for the extension icon. **VS Code Marketplace
requires PNG**, so before publishing you need to convert it:

```bash
# 128x128 is the marketplace standard; some galleries use 256x256
npx svgexport assets/icon.svg assets/icon.png 128:128

# Or with ImageMagick / sharp / Inkscape — anything that does SVG → PNG
```

Then add to `package.json`:

```json
"icon": "assets/icon.png",
```

The `.vsix` will package and install fine without an icon (VS Code uses
a generic placeholder). It's only blocking for the public marketplace
listing.

`hero.png` (referenced in `README.md`) is a screenshot of the chat
panel mid-conversation. Take it once the UI feels final, drop it here
at ~640px wide.
