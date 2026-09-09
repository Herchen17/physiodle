# Physiodle Apple-style design sandbox

This branch is an isolated preview. It does not deploy or alter the production checkout.

## Run the app

```sh
npm install
PORT=3199 DATABASE_PATH=/tmp/physiodle-apple-design-sandbox.db npm start
```

Open <http://127.0.0.1:3199/>. For the closest iPhone test, open it in Safari and use Responsive Design Mode at 393 × 852, then test both light and dark appearance.

## Run the visual regression checks

```sh
python3 -m pip install -r requirements-CODEX.txt
python3 -m playwright install webkit
python3 -m unittest tests/test_apple_shell.py -v
```

The checks cover iPhone navigation and safe areas, small-tablet layout, desktop navigation, bottom sheets, opaque clinical content, dark appearance, 44-point targets and reduced motion.

## Design boundary

Translucent material is limited to navigation and floating controls. Clinical clue cards remain opaque for legibility. The same responsive web app serves Home Screen and ordinary browser use; this sandbox does not introduce an Expo or native-app dependency.
