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
- Keeping a sheet's script current: [`update.html`](update.html) has a one-click "Copy the new backend code" button
  and the steps. The code it copies is `backend-latest.gs`, generated from `backend/` by `tools/build-bundle.js`
  (the tests fail if it is stale). The site shows an update note whenever a sheet's script is older than
  `EXPECTED_BACKEND` in `js/app.js`.

The URL and access token you paste into Settings live in your browser's local storage and
are only ever sent to the Google Apps Script URL you entered (the URL is validated).

Run it locally with any static server, for example `python -m http.server` in this folder.
