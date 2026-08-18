# Auction Draft Board

A shared draft board for an **in-person fantasy football auction draft**. One person runs it on a
laptop, the laptop is mirrored to a TV, and everyone in the room watches the same screen instead of
their phones.

The operator types in each pick as the room settles it out loud — player, winning team, price. The
board updates instantly: who has money left, what each team owns, and who nominates next. Afterward
you use the exports (or the Google Sheet) to type the results into Sleeper.

> **Sleeper has no write API.** There is no way for any app to set your league's rosters
> automatically — the final entry into Sleeper is manual, by design of their platform. This app
> exists to make that entry quick and accurate.

---

## The 60-second version for draft night

1. Open the board — **double-click `DraftBoard-offline.html`** (works on any computer, nothing to
   install), or open your hosted link if you set one up. See [Three ways to run it](#three-ways-to-run-it).
2. Mirror the screen to the TV.
3. Type each pick as it happens: player name → pick from the list → team → price → Enter.
4. If the status pill goes red or says "Offline": **keep going.** Every pick is saved on the
   computer the instant you enter it. Red only means the spreadsheet copy is behind, and it catches
   up by itself.
5. When the draft is done, click **Export → Rosters (text)** and use it to fill in Sleeper.

---

## Three ways to run it

All three are the same app with the same features, and **all three can back up to the same Google
Sheet**. They differ only in what has to be installed.

| | What you do | Needs installing | Needs internet | Google Sheet backup |
|---|---|---|---|---|
| **Standalone file** | Double-click `DraftBoard-offline.html` | Nothing | No (except to sync) | Yes |
| **Hosted** | Open your `*.vercel.app` link | Nothing | Yes | Yes |
| **Local server** | Double-click `start-windows.bat` | Node.js | No (except to sync) | Yes |

**On Windows, and want it simple: use the standalone file.** It's one self-contained HTML file —
double-click it and the board opens in Edge or Chrome. No Node, no install, no terminal window, and
it keeps working with the wifi off. Everything is saved in the browser and exports normally, and it
copies picks to a Google Sheet just like the hosted version does.

**Want it on the internet as well?** Deploy it once to Vercel (free, ~10 minutes, instructions
below) and open the link on draft night. Keep `DraftBoard-offline.html` on the desktop as a backup
in case the venue's wifi is bad — both can back up to the same spreadsheet.

`start-windows.bat` is rarely worth it now that the standalone file does everything. Its one
advantage is a stable `http://localhost` address, which lets the browser cache the app for an
offline reload. If Node isn't installed, the launcher opens the standalone file instead.

> Rebuild the standalone file after changing anything: `node scripts/build-offline.mjs`

---

## What it does

- **Live board** for the room: remaining budget per team, what each team has bought, and what
  positions they still need.
- **Nomination order** — draw it randomly at setup, then the board shows whose turn it is to open
  the bidding. Rotating or snake, and teams that are full get skipped automatically.
- **Bid rules enforced** (the same ones Sleeper enforces, so your results can actually be entered):
  - minimum bid is $1
  - a team must always keep $1 for every roster spot it still has to fill, so the app caps every
    team's max bid and refuses anything higher
  - a full roster can't bid at all
  - nobody gets drafted twice
- **Fast entry** — type-ahead over the real NFL player list, keyboard-driven, with undo and edit.
- **Never loses picks** — saved to the browser on every keystroke-worth of action, optionally
  mirrored to a Google Sheet, and exportable at any moment.
- **Light and dark mode**, switchable from the top bar to suit the room and the TV.

## What it deliberately doesn't do

- It doesn't track live bidding as the price climbs. You enter the **final** result once the room
  has settled a player. Tracking every incremental bid is more work for the operator than it's
  worth.
- It doesn't talk to your Sleeper draft room. The draft happens in the room, not in Sleeper.

---

## Setup before draft night

### Minimum (nothing to install, works with no internet)

1. Copy **`DraftBoard-offline.html`** onto the computer that'll run the draft — desktop is fine.
   It's one file; nothing else is needed.
2. Double-click it. It opens in your browser on the setup screen.
3. Fill in teams, budget, roster spots, and shuffle the nomination order. Click **Start draft**.

That's genuinely it. Everything below is optional insurance.

> **Use the same browser every time.** The draft is saved inside whichever browser you opened the
> file with, so if you set up in Edge, run the draft in Edge. (Also avoid a private/incognito
> window — those throw the data away when closed.)

<details>
<summary><b>Optional: the local server instead (needs Node.js)</b></summary>

Rarely needed — the standalone file covers the same ground. See the note above.

1. Install **Node.js 20 or newer** from [nodejs.org](https://nodejs.org) — the LTS version.
2. Double-click `start-windows.bat` (Windows) or `start-mac.command` (macOS). On macOS the first
   run needs right-click → Open → Open to get past Gatekeeper — **do that in advance**, not at 7pm.
3. A terminal window opens and stays open; the browser opens at `http://localhost:8787`. Leave the
   terminal window alone until the draft is over.

</details>

### Optional: Google Sheet backup

This copies every pick to a spreadsheet as you go, so the draft survives even if the laptop dies.
It also gives you a per-draft `… Rosters` tab laid out for typing into Sleeper afterward.

Sync is best-effort and never blocks you: picks are written to the browser first, then the whole
draft is pushed to the sheet a second or so later. If the write fails, the pill goes red, the app
retries, and you carry on typing.

Writing to a Google Sheet needs a credential, and a credential can't live in a web page where
anyone could read it. The way around that: a small script that lives **inside your spreadsheet** and
runs as you. There is no Google Cloud project, no key file, and nothing to bill — and because the
browser talks to Google directly, it works from the hosted app, the local server, and the
double-clicked `DraftBoard-offline.html` alike.

Setup is about five minutes, and you only do it once.

<details>
<summary><b>Apps Script setup (~5 minutes, no Google Cloud)</b></summary>

1. Open your Google Sheet → **Extensions → Apps Script**.
2. Delete whatever is in `Code.gs` and paste in the contents of this repo's
   [`apps-script/Code.gs`](apps-script/Code.gs).
3. Make up a long random string and put it in the first line: `var WRITE_TOKEN = 'your-string';`
   Then save (the disk icon).
4. **Deploy → New deployment → ⚙ → Web app.** Set **Execute as: Me** and
   **Who has access: Anyone**. Click Deploy.
   - "Anyone" sounds alarming but is what makes the app able to reach it; the `WRITE_TOKEN` is what
     actually keeps strangers out. Don't leave it blank.
   - Google will ask you to authorize the script, and will warn that it's unverified — **Advanced →
     Go to (project name)** to continue. It's your own script, on your own sheet.
5. Copy the **Web app URL**. It ends in `/exec` — the `/dev` one won't work from the app.
6. In the draft app's setup screen: set *How it reaches the sheet* to **Script in the spreadsheet**,
   paste the URL and the same token, and click **Test connection**. You want "Connected to …".

**A deployment is a frozen snapshot of the code.** Editing `Code.gs` changes nothing about what the
`/exec` URL serves until you publish a new version: **Deploy → Manage deployments → ✏️ → Version:
New version → Deploy**. Use *Manage deployments*, not *New deployment* — the latter mints a
different URL you'd have to re-paste.

If you visit the `/exec` URL in a browser and see **"Script function not found: doGet"**, that's
this exact problem: the published version predates the code. Save the file, then publish a new
version.

</details>

#### How drafts are kept apart

Every draft gets a key when you start it: the date, the name you typed, and a short random
suffix — `2026-08-24 Kurtz League x9a2`. That key names the spreadsheet tabs and the export files.

- **One spreadsheet holds as many drafts as you like.** Each one writes to its own set of tabs
  (`… Picks`, `… Rosters`, `… Budgets`, `… Config`, `… Log`, `… Backup`), so a practice run and the
  real thing cannot touch each other. A shared **`Drafts`** tab lists them all with pick counts and
  when each was last saved.
- **Exports are named the same way**, so `2026-08-24-Kurtz-League-x9a2-rosters.txt` won't quietly
  overwrite yesterday's file in your downloads folder.
- **Restoring picks a draft.** *Backup → List drafts in the sheet* shows everything the spreadsheet
  holds and loads any of them onto this computer.
- **The draft lives in the browser, not on the server.** Two people opening the same hosted URL do
  *not* see the same board — each gets their own empty setup screen. There is no spectator view;
  the room watches the operator's screen on the TV, which is the whole design.
- **The access token is what stops strangers writing** to your sheet if they find the web app
  URL. Set it in both `Code.gs` and the setup screen.

The only remaining way two drafts can collide is if they somehow share a key, and the app refuses
that write rather than replacing anything — taking over is a deliberate click.

<details>
<summary><b>Making a sheet for it</b></summary>

Any Google Sheet you own will do — the script creates the tabs it needs the first time it writes:
six per draft, named after that draft's key, plus a shared `Drafts` index listing them all.

You do **not** need to share the sheet with anyone. The script runs as you, on your own file.

</details>

<details>
<summary><b>Optional: hosting it on Vercel</b></summary>

The nicest setup for a Windows machine: nothing to install, and the Google Sheet backup works. Keep
`DraftBoard-offline.html` on the desktop as the wifi-failure backup.

1. Push this folder to a GitHub repo, then import it at [vercel.com](https://vercel.com).
2. Framework Preset **Other**, Build Command **empty**, Output Directory **`public`**.
3. **Settings → Deployment Protection:** make sure it's **off**, or you'll hit a login wall.

There are no environment variables and no serverless functions — Vercel is only serving static
files here. The sheet backup is configured in the app itself, on the setup screen, so the hosted
copy and the standalone file are set up exactly the same way.

</details>

---

## Running a dress rehearsal (do this, it's worth the 20 minutes)

On the actual laptop, actual browser, actual TV:

- [ ] The board opens the way you plan to open it on the night (and note *which browser*, since
      that's where the draft is saved).
- [ ] Screen mirroring works and you can read the board from where people will be sitting.
- [ ] Enter a dozen fake picks. Try one that's over a team's max bid — it should refuse.
- [ ] Turn the wifi **off** and keep entering picks. Everything should still work.
- [ ] Reload the page mid-draft. It should offer to resume and come back exactly as it was.
- [ ] If you set up the sheet: turn wifi back on and watch the status pill go green.
- [ ] Click Export and check the roster list looks right.
- [ ] Laptop set to never sleep, and plugged in.
- [ ] The week of the draft, refresh the player list and rebuild the standalone file:
      `node scripts/build-players.mjs && node scripts/build-offline.mjs`

---

## During the draft

**Entering a pick:** type part of the player's name, arrow down / click to select, tab or click to
the team, type the price, press Enter. The form clears and focuses back on the player field for the
next one.

**The app will stop you** if a bid breaks a rule. Over-budget, under $1, a full roster, or a
duplicate player are all refused outright — those are Sleeper's rules and a draft that breaks them
can't be entered afterward. The one thing you *can* wave through is which roster slot a player
fills, since that's a judgment call.

**Made a mistake?** *Undo* in the top bar removes the last pick. *Picks* opens the full list where
you can edit or delete anything.

**The status pill:**

| Shows | Means |
|---|---|
| Saved | The spreadsheet is up to date |
| Saving… | Writing now |
| Offline | No connection; picks are safe locally and will sync when it returns |
| Sheet behind | Sync is failing; **picks are still safe locally — keep going** |
| Local only | No sheet configured; everything is saved in this browser |

There is never a reason to stop entering picks because of that pill.

---

## After the draft

Click **Export**:

- **Rosters (text)** — grouped by team, sorted by price. This is the one to read off while typing
  into Sleeper.
- **Rosters (CSV)** / **Pick log (CSV)** — for a spreadsheet.
- **Full backup (JSON)** — reloadable by this app; keep it as an archive.

If you set up the sheet, this draft's `… Rosters` tab has the same thing, already laid out.

---

## If something goes wrong

**Nothing opens / the page is blank.** Fall back to double-clicking `DraftBoard-offline.html` — it
has no moving parts. If you were using the launcher, check the terminal window it opened; if it says
Node isn't installed, either install it from nodejs.org or just use the standalone file.

**Windows warns about the `.bat` file.** SmartScreen flags downloaded scripts. Use the standalone
HTML file instead, or click "More info" → "Run anyway".

**The draft vanished.** Almost always the wrong browser or a private window — the draft is stored in
the specific browser you set it up in. Reopen the same one. Failing that, restore from the Google
Sheet or a JSON backup.

**"Sheet behind" or a red pill.** Keep entering picks — nothing is lost. Afterward, open **Backup →
Check the sheet's copy** to see what happened. The usual cause is a deployment that's older than
the script — see the Apps Script setup section.

**The laptop died.** On another machine, run the app, open **Backup → Check the sheet's copy**, and
restore. This only works if you set up the Google Sheet.

**You accidentally cleared the browser / opened a fresh profile.** Same as above, or import the last
JSON backup you exported.

**Two windows open at once.** The app notices and puts the second one in read-only mode — it
refuses every write, not just warns — so they
can't fight over the same draft. Use the one you've been typing into, or click "Take over".

---

## For developers

```
apps-script/    Code.gs — paste this into the spreadsheet; the only server-side code there is
public/         The whole frontend: plain HTML/CSS/JS, no build step, no dependencies
  js/schema.js  How draft state maps onto spreadsheet rows, both directions
scripts/        Player-list builder and the test suites
server.js       Zero-dependency static file server for an http:// origin
```

There is **no build step, no `npm install`, and no backend of our own.** The browser builds the
finished spreadsheet rows itself and posts them to the operator's own Apps Script deployment, which
is why the standalone HTML file can back up to a sheet with nothing running behind it.

**Design decisions worth knowing before changing things:**

- **localStorage is the source of truth.** Picks commit locally and synchronously before the UI
  acknowledges them; the Sheet is a replica. Never put a network call on the pick-entry path.
- **Sync sends the whole state, debounced,** and the script rewrites the sheet's tabs wholesale.
  That's why undo/edit needs no special handling and why a dropped sync is self-healing. Every
  rewrite is padded to a fixed size so a deleted pick can't leave a stale row behind.
- **A `revision` counter guards against stale writes** clobbering newer data; the append-only `Log`
  tab keeps an audit trail regardless.
- **`Code.gs` knows nothing about auctions.** It writes the rows it is handed and enforces exactly
  two guards — refuse a different draft, refuse an older revision. Everything else lives in
  `public/js/schema.js`, which is testable outside Google; Apps Script code is not.
- **All validation is client-side.** A rejection arriving mid-draft would be unactionable and would
  let the sheet disagree with the screen.
- **Requests to Apps Script must stay "simple".** `Content-Type: text/plain`, no custom headers —
  anything else triggers a CORS preflight that an Apps Script deployment cannot answer, and the
  request dies before Google sees it.

```bash
node scripts/test.mjs                                   # draft rules, budgets, sheet mapping
node scripts/test-restore.mjs                           # the compare/restore recovery paths
node scripts/test-apps-script.mjs                       # runs apps-script/Code.gs against a fake sheet
node server.js &                                        # then, in another shell:
node --experimental-websocket scripts/browser-test.mjs  # drives the real UI in headless Chrome
node --experimental-websocket scripts/offline-test.mjs  # drives the standalone file over file://
node --experimental-websocket scripts/simulate.mjs      # full-draft data-loss simulations

node scripts/build-players.mjs                          # refresh public/data/players.json
node scripts/build-players.mjs --idp                    # ...including individual defensive players
node scripts/build-offline.mjs                          # rebuild DraftBoard-offline.html
```

**The simulations are the important ones.** Each scenario runs a complete 140-pick auction through
the real UI and then reconciles four independent copies of the truth — what was entered, the app's
state, localStorage, and the sheet — plus every export. They cover the standalone file with no
server at all, the local server writing to a sheet, a network outage across a third of the draft, a
crash-and-reload mid-draft, the standalone file backing up to a sheet from `file://`, and a second
window being unable to clobber the draft. Run them after touching state, sync, or persistence; they
found a real sync-starvation bug that none of the unit tests could see.

`test-apps-script.mjs` loads `apps-script/Code.gs` from disk and runs it unmodified against a fake
`SpreadsheetApp`, so a bug in the file the operator pastes into their sheet is a failing test here.
That matters because there is no other way to run that code outside Google.

`build-offline.mjs` inlines every asset into one file. Note it replaces via a function, never a
string — a string replacement would interpret `$$`/`` $` ``/`$'` inside the code being inlined, which
silently corrupts `` `$${...}` `` in utils.js and can splice the document into itself.

**Cross-origin notes** (verified from a `file://` page): the standalone build makes no requests for
its own assets, so nothing can be blocked. Sleeper's read API sends `Access-Control-Allow-Origin: *`,
which covers the `null` origin a `file://` page sends, so the optional league-name prefill still
works there when online.

Apps Script is reachable from `file://` because the request is deliberately kept *simple*: the POST
goes out as `text/plain`, so no CORS preflight is sent, and an Apps Script deployment cannot answer
a preflight. The deployment's own response allows any origin, which includes the `null` origin a
`file://` page sends. Scenario E in the simulations drives this through a real `file://` page for
exactly that reason — it is the one place where a CORS mistake wouldn't show up in Node.
