Optional bundled extractor folder.

For maximum archive compatibility on clean Windows installs,
place a 7-Zip command-line extractor here:

- 7za.exe (preferred)
- 7z.exe
- 7zz.exe
- 7zr.exe

At runtime the app checks <install>/tools first.
This folder is included in installer bundles via tauri.conf.json resources.

Official source: https://www.7-zip.org/download.html
