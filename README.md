# LearnerBot (web)

A static front end for LearnerBot, hosted on GitHub Pages. It has no server of its own:
every person connects it to **their own** Google Sheet through a small Apps Script web
app, so goals, journal entries and AI keys stay in their own Google account.

- Open the site, then **⚙ Settings** to connect your sheet, or **Try demo data** to look around.
- First-time setup for friends: [`setup.html`](setup.html), or the printable [`LearnerBot-Setup-Guide.pdf`](LearnerBot-Setup-Guide.pdf) (desktop first, then phone).
- No build step. Plain HTML, CSS and JavaScript:
  - `js/api.js` is the only file that talks to the network
  - `js/app.js` is the UI
  - `js/mock.js` is the in-browser demo backend
- Keeping a sheet's script current: a friend's sheet holds one `Code.gs`: a small loader plus the app that came
  with their copy. When the site expects a newer app than the one running (`EXPECTED_BACKEND` in `js/app.js`), it
  shows **Update now**. The sheet's script then downloads `backend-payload.js` from this site (only from that
  one address, only when the owner presses the button), checks it, installs it into its own private properties and
  runs it from the next request. **Go back** returns to the earlier copy or the built-in one, and the sheet menu has
  a "Repair: use the built-in version" item. `backend-payload.js` and `backend-latest.gs` are generated from
  `backend/` and `tools/loader.js` by `tools/build-bundle.js` (the tests fail if they are stale);
  [`update.html`](update.html) is the by-hand fallback.

The URL and access token you paste into Settings live in your browser's local storage and
are only ever sent to the Google Apps Script URL you entered (the URL is validated).

Run it locally with any static server, for example `python -m http.server` in this folder.
