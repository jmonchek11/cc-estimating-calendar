# HANDOFF — CC Estimating Calendar

## Where We Left Off

The last coding session built out the full RFC/COR cleanup system and fixed several bugs along the way. Everything through commit `e137ae6` is pushed and live on Render. The user then asked to compact the conversation to switch back to Sonnet — that's why you're reading this.

---

## The Last Feature Built — RFC/COR Cleanup Tool

### What it does
The estimating team has many change orders (bids with `stage: 'active_co'`) where the `job_number` field contains something like `636031 RFC-20` instead of just the base job number `636031`. The RFC/COR cleanup tool:

1. **Finds** all bids where `job_number` contains "RFC" or "COR" anywhere (not just at start — field looks like `636031 RFC-20` or `636031COR001`)
2. **Extracts** the base job # (`636031`) and the normalized CO # (`RFC-20`)
3. **Prepends** the CO # to the Bid Name: e.g. `"Fire Alarm System"` → `"RFC-20 Fire Alarm System"`
4. **Matches** to a Project by the base job # (looks up projects where `job_number === baseJobNumber`)
5. **Shows** a checkbox diff review table — user checks which bids to fix and clicks "Apply Selected"

### Where the code lives
- **Button**: Data Cleanup page (`#cleanup`), amber "🔧 RFC/COR Job # Cleanup" button
- **Modal open**: `openRfcCleanupModal()` in `public/app.js`
- **Apply**: `applyRfcCleanup()` in `public/app.js`
- **Extract helper**: `extractRfcFromJobNumber(jobNumber)` in `public/app.js`
- **API — find candidates**: `GET /api/bids/rfc-cleanup` → `getRfcJobNumberBids()` in `db.js`
- **API — apply per bid**: `PUT /api/bids/:id` (standard bid update endpoint)

### IMPORTANT route order fix already applied
`/api/bids/rfc-cleanup` is declared BEFORE `/api/bids/:id` in `server.js` — this was a critical bug (404 "Not found") that was already fixed. Do NOT move that route.

---

## One Unresolved Issue — Apply May Be Failing

The user reported that clicking "Apply Selected" in the RFC cleanup modal might be failing, but they never provided the exact error and the session ran out of context before it was confirmed.

### Hypothesis
`project_name` is `required: true` in `models/Bid.js`. The apply function PUTs `{ job_number: baseJobNumber, co_number: coNumber, project_name: newBidName }` for each selected bid. If `newBidName` ends up as an empty string or null (e.g. the bid had no original `project_name`), Mongoose will reject the update with a validation error.

### How to confirm
1. Open the site in browser
2. Open DevTools → Console (F12)
3. Go to Data Cleanup → run RFC/COR cleanup scan
4. Select some rows and click Apply
5. Look for `Failed bid <id>:` console logs — the error message after the colon tells you exactly what Mongoose rejected

### Code location to fix (if needed)
In `public/app.js`, find `async function applyRfcCleanup()`. It loops through `_rfcCleanupData[i]` for each checked index. The PUT payload looks like:

```js
{ 
  job_number: d.baseJobNumber, 
  co_number: d.coNumber, 
  project_name: d.newBidName  // <-- this must never be null/empty
}
```

**Fix**: before calling `api.put(...)`, guard:
```js
const bidName = d.newBidName || d.originalBidName || 'Unnamed Bid';
```

---

## Next Steps (Priority Order)

### 1. Confirm / fix RFC cleanup apply (immediate)
See above. Ask the user if they've tested it since the last fix (checkboxes were re-enabled in the last commit). If it's still failing, apply the guard above.

### 2. Excel sync and Bid Name field
The `project_name` field on Bid is the **Bid Name** — it WILL be overwritten by Excel imports if the spreadsheet has a value for it. The user should be aware. If they want Bid Name to survive imports, sync-excel-lib.js would need to skip that field when a project_id is set (i.e., if a bid is linked to a project, don't overwrite its bid name from Excel). This has NOT been implemented yet — raise it with the user.

### 3. User-reported bugs / new requests
Start fresh — ask the user what they want to work on next. The backlog from the previous session is fully implemented and deployed.

---

## Code Patterns to Know

### Adding a new API endpoint
```js
// server.js — put BEFORE any /:id routes at the same level
app.get('/api/bids/my-new-route', requireAuth, async (req, res) => {
  try {
    const result = await db.myNewFunction(req.session.userId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

### Adding a new Project field
1. Add to `models/Project.js` schema
2. Add to `fmtProject()` in `db.js`
3. Add to `$project` whitelist in `getProjects()` aggregation in `db.js` (CRITICAL — easy to miss)
4. Add to `updateProject()` in `db.js` if it should be editable
5. Add to UI in `public/app.js` and `public/index.html`

### Adding a new Bid field
1. Add to `models/Bid.js` schema
2. Add to `formatBid()` in `db.js`
3. Add `BID_FIELDS` array in `db.js` if the field should be included in updates
4. Add to form in `public/index.html`
5. Add to save logic in `public/app.js` (the `saveBid()` or similar function)

### Frontend API calls
```js
// GET
const data = await api.get('/api/bids/123');

// POST
const result = await api.post('/api/bids', payload);

// PUT
await api.put('/api/bids/123', { field: value });

// DELETE
await api.delete('/api/projects/123');
```

### Toasts / notifications
```js
showToast('Your message here');          // default (info/success)
showToast('Error message', 'error');     // red
```

### Project picker cache bust
After any project create/update/delete, set `_projectPickerCache = null` in the frontend so the dropdown refreshes next time it opens.

---

## Git Workflow Reminder

The `.git` folder is INSIDE `app/` and is hidden in Windows Explorer.

```bash
cd "C:\Users\jmonchek\OneDrive - libertyintegrated.com\Desktop\CC Estimating Calendar\app"
git add public/app.js server.js db.js          # specific files
git commit -m "Fix: description of change"
git push origin main
```

Render auto-deploys. User must reload the page after deploy (~1-2 min).
