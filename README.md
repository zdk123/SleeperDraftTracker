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

1. Double-click **`start-mac.command`** (or `start-windows.bat`).
2. A browser opens at `http://localhost:8787`. That's the board — mirror it to the TV.
3. Type each pick as it happens: player name → pick from the list → team → price → Enter.
4. If the status pill goes red or says "Offline": **keep going.** Every pick is saved on the laptop
   the instant you enter it. The red only means the spreadsheet copy is behind, and it catches up
   by itself.
5. When the draft is done, click **Export → Rosters (text)** and use it to fill in Sleeper.

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

### Minimum (no Google Sheet, works offline)

1. Install **Node.js 20 or newer** from [nodejs.org](https://nodejs.org) — pick the LTS version.
   Check it worked: open Terminal and run `node --version`.
2. Put this folder somewhere you'll find it, like the Desktop.
3. **macOS only, do this in advance:** right-click `start-mac.command` → Open → Open. macOS blocks
   double-clicked scripts the first time, and you don't want to discover that at 7pm.
4. Double-click the launcher. A browser should open with the setup screen.
5. Fill in teams, budget, roster spots, and shuffle the nomination order. Click **Start draft**.

That's genuinely all that's required. Everything below is optional insurance.

### Optional: Google Sheet backup

This copies every pick to a spreadsheet as you go, so the draft survives even if the laptop dies.
It also gives you a `Rosters` tab that's laid out for typing into Sleeper afterward.

<details>
<summary><b>Google Cloud setup (~15 minutes, once)</b></summary>

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project, e.g.
   `draft-tracker`.
2. **APIs & Services → Library →** search "Google Sheets API" → **Enable**. (You do *not* need the
   Drive API.)
3. **IAM & Admin → Service Accounts → Create service account.** Name it `draft-writer`. Skip the
   optional role and permission steps — access comes from sharing the sheet, not from IAM roles.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. It downloads once and
   cannot be downloaded again, so keep it somewhere safe.
5. Copy the service account's email address — it looks like
   `draft-writer@draft-tracker.iam.gserviceaccount.com`.

</details>

<details>
<summary><b>Google Sheet setup (~5 minutes)</b></summary>

1. Create a new Google Sheet and name it something like "2026 Auction Draft".
2. **Share it with the service account email as an Editor.** Untick "Notify people" — that address
   can't receive mail. *Skipping this step is the single most common reason syncing fails.*
3. Copy the spreadsheet ID out of the URL:
   `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
4. The app creates the tabs it needs (`Rosters`, `Picks`, `Budgets`, `Config`, `Log`, `_Backup`) the
   first time it writes.

</details>

<details>
<summary><b>Connecting it up</b></summary>

Copy `.env.example` to `.env.local` and fill in four values:

| Variable | Where it comes from |
|---|---|
| `GOOGLE_SA_EMAIL` | The service account's email address |
| `GOOGLE_SA_PRIVATE_KEY_B64` | The key file's `private_key`, base64-encoded (see below) |
| `SHEETS_SPREADSHEET_ID` | From the sheet's URL |
| `APP_WRITE_TOKEN` | Any long random string you make up |

Encode the private key (run this in the folder where you saved the JSON key):

```bash
node -e "console.log(Buffer.from(require('./your-key.json').private_key).toString('base64'))"
```

Base64 avoids the classic problem of newlines inside the key getting mangled.

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then restart the app, paste the token into the setup screen's **Access token** box, and click
**Test connection**. You want a green "Connected to …". Do this *days* before the draft.

</details>

<details>
<summary><b>Optional: hosting it on Vercel</b></summary>

Useful if you'd rather open a URL than run a launcher — but keep the local launcher working as a
backup for venue wifi trouble.

1. Push this folder to a GitHub repo, then import it at [vercel.com](https://vercel.com).
2. Framework Preset **Other**, Build Command **empty**, Output Directory **`public`**.
3. **Settings → Environment Variables:** add the same four variables, ticked for Production,
   Preview, *and* Development.
4. **Settings → Deployment Protection:** make sure it's **off**, or you'll hit a login wall.
5. Redeploy — Vercel doesn't apply new environment variables to existing deployments.
6. Visit `https://your-app.vercel.app/api/health` and confirm it reports `"ok": true`.

</details>

---

## Running a dress rehearsal (do this, it's worth the 20 minutes)

On the actual laptop, actual browser, actual TV:

- [ ] Launcher opens the board without a Gatekeeper/SmartScreen prompt.
- [ ] Screen mirroring works and you can read the board from where people will be sitting.
- [ ] Enter a dozen fake picks. Try one that's over a team's max bid — it should refuse.
- [ ] Turn the wifi **off** and keep entering picks. Everything should still work.
- [ ] Reload the page mid-draft. It should offer to resume and come back exactly as it was.
- [ ] If you set up the sheet: turn wifi back on and watch the status pill go green.
- [ ] Click Export and check the roster list looks right.
- [ ] Laptop set to never sleep, and plugged in.
- [ ] Re-run `node scripts/build-players.mjs` the week of the draft to refresh the player list.

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

If you set up the sheet, the `Rosters` tab has the same thing, already laid out.

---

## If something goes wrong

**The browser won't open / the page is blank.** Check the terminal window the launcher opened. If it
says Node isn't installed, install it from nodejs.org. Otherwise open `http://localhost:8787`
manually.

**"Sheet behind" or a red pill.** Keep entering picks — nothing is lost. Afterward, open **Backup →
Check the sheet's copy** to see what happened. The usual cause is that the sheet was never shared
with the service account email.

**The laptop died.** On another machine, run the app, open **Backup → Check the sheet's copy**, and
restore. This only works if you set up the Google Sheet.

**You accidentally cleared the browser / opened a fresh profile.** Same as above, or import the last
JSON backup you exported.

**Two windows open at once.** The app notices and puts the second one in read-only mode so they
can't fight over the same draft. Use the one you've been typing into, or click "Take over".

---

## For developers

```
api/            Serverless functions (also served by server.js locally)
  _lib/         Google auth, Sheets REST wrapper, shared state<->rows schema
public/         The whole frontend: plain HTML/CSS/JS, no build step, no dependencies
scripts/        Player-list builder and the test suites
server.js       Zero-dependency local server; runs the same api/ handlers Vercel does
```

There is **no build step and no `npm install`** — not for Vercel, not locally. Google's JWT auth is
~30 lines of `node:crypto` rather than the `googleapis` package, specifically so the local fallback
runs on a laptop with nothing but Node installed.

**Design decisions worth knowing before changing things:**

- **localStorage is the source of truth.** Picks commit locally and synchronously before the UI
  acknowledges them; the Sheet is a replica. Never put a network call on the pick-entry path.
- **Sync sends the whole state, debounced,** and the server rewrites the sheet's tabs wholesale.
  That's why undo/edit needs no special handling and why a dropped sync is self-healing. Every
  rewrite clears a fixed range first so a deleted pick can't leave a stale row behind.
- **A `revision` counter guards against stale writes** clobbering newer data; the append-only `Log`
  tab keeps an audit trail regardless.
- **All validation is client-side.** The server intentionally has no opinion about budgets — a
  rejection arriving mid-draft would be unactionable and would let the sheet disagree with the
  screen.

```bash
node scripts/test.mjs                                  # draft rules, budgets, sheet mapping
node scripts/test-sync.mjs                             # server handlers vs. a stubbed Google API
node server.js &                                       # then, in another shell:
node --experimental-websocket scripts/browser-test.mjs # drives the real UI in headless Chrome
node scripts/build-players.mjs                         # refresh public/data/players.json
```
