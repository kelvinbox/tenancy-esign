# Tenancy e-sign (proof of concept)

Mobile-first electronic signing for New Zealand residential tenancy agreements, built to replace DocHub in the Tenant Management app. The signing page uses plain web forms designed for a phone. Each step a signer takes goes into an audit trail that can show whether anything was changed.

It is a separate project. It doesn't connect to the live Tenant Management app, its Sheets, or DocHub. All people, properties, emails and numbers in it are invented.

## Try it in 2 minutes (demo mode)

Demo mode runs entirely in your browser with fake data and a fake outbox. No server, no emails.

```bash
npm start
```

Open http://localhost:8080/. To try it on your iPhone, keep the phone on the same Wi-Fi and open the "on your phone" address the command prints. (Demo data lives in each browser, so create the agreement on the phone too.)

1. **New** tab: choose the approved group "Mia, Tūi and Jordan", check the pre-filled terms, tap **Preview**, then **Send for signing**.
2. **Outbox** tab: open Mia's "Please sign" email and tap **Open signing link**.
3. Sign as Mia: agree to e-signing → get the code (demo mode shows it on screen) → read to the end → confirm details → draw a signature and type your name.
4. Back in the Outbox, Tūi's invite has appeared (signing is sequential). Repeat for each tenant, then the two landlord signers (Sam, then Pat), who sign last.
5. Open the agreement in **Agreements** to see each signer's progress, the locked terms fingerprint and the full audit trail. Open the signed document and scroll to the **signing certificate**.
6. **Verify** tab: choose the downloaded signed file to check it's an unaltered copy. Change one character in it and check again to see it fail.
7. **Change tenants:** on the completed agreement, tap **Change tenants**. Tick Tūi as leaving, add Riley from the approved applicants, say how the bond is being settled, then send. Riley signs first: they read the variation and then the original agreement exactly as it was signed (marked as not being re-signed). Then Tūi (who gives a forwarding address), Mia, and the landlord signers sign. Afterwards the original shows as **Replaced** and the change as **Current**. The Verify page shows both versions.

## Changing tenants after signing

The signed agreement is never edited. Each change is a short **Variation of Tenancy Agreement: Change of Tenants**. It is an amendment, not a new agreement: it lists the signed documents it amends (the original and any earlier variations) by agreement number, date and SHA-256 fingerprint, and changes only who the tenants are. Each version links to the one before it:

```
v1  Original agreement              fingerprint A
 └─ v2  Change: Riley joins          refers to A    fingerprint B
     └─ v3  Change: Tūi leaves       refers to B    fingerprint C   <- current
```

- **Covers:** filling a room (add only), replacing someone (swap), and someone leaving without a replacement (remove only). The tenancy continues, so the start date, fixed term, rent and the 12-month rent-increase clock are all unchanged.
- **Who signs, in order:** joining tenants → leaving tenants → continuing tenants → the landlord's signer(s). Every person signs with the same link, email code, read-to-the-end step and audit trail as the original.
- **Joining tenants** must come from an approved application, so their application reference is required. They read the variation and then **the signed original (and any earlier variations) exactly as signed**, in a read-only section marked "not being re-signed". They then sign a specific statement, stored with their signature: they have received and read those documents and agree to be bound by them, as amended, "as if I had signed the original agreement". When the variation completes, they are emailed the signed variation **and** the signed original and earlier variations. That is incorporation by reference, which is what binds them to the original.
- **Leaving tenants** give a forwarding address for service. They are responsible for their obligations up to the effective date, and not after it.
- **Bond:** the change records the total bond (still no more than 4 weeks' rent) and how it's being settled between the tenants. It also states that the landlord will notify Tenancy Services through Bond Hub within 10 working days.
- **Only one change at a time:** a change can only be made to the current, fully signed version. While a change is out for signing, no other change can start. If it's declined, cancelled or expires, the previous version simply stays in force.
- **What you get:** a signed variation with its own signing certificate, emailed to everyone involved, including the leaving tenant. Joining tenants also get the earlier signed documents. The previous version is marked **Replaced** in its own audit trail. **Tenancy summary** gives a one-page cover sheet: current tenants, key terms and the list of signed documents with fingerprints. It is clearly labelled as not a signed document and not an agreement. The Verify page says whether a copy is current or replaced and lists every version. If an earlier signed version no longer matches the fingerprint recorded by the change after it, that is flagged.
- *Legal points to check before relying on this:* assignment needs the landlord's written consent, which can't be unreasonably withheld. Also check how far a leaving tenant's liability goes, and the 10-working-day Bond Hub deadline.

## What a signer sees

The signer flow has 5 short steps. Each one is a card with a single large button in the thumb zone. Inputs are 16 px so iOS doesn't zoom, and the page fits the phone width.

| Step | What happens | Recorded as |
|---|---|---|
| 1. Start | Who sent it, the signing order, and a consent to sign electronically | `DOCUMENT_OPENED`, `ELECTRONIC_SIGNING_CONSENT` |
| 2. Check it's you | A 6-digit code is emailed to them (the iPhone offers to fill it in automatically) | `CODE_SENT`, `CODE_FAILED`, `IDENTITY_VERIFIED` |
| 3. Read | The whole agreement in foldable sections. Filled-in values are highlighted. The button unlocks only after they scroll to the end | `DOCUMENT_REVIEWED` (with time on page) |
| 4. Your details | Name, mobile, address for service, ID and "under 18", pre-filled and editable. The email is locked | (hashed into the signature record) |
| 5. Sign | Finger signature, typed full name (must match) and an "I agree" tick | `SIGNED` |

They can **decline** with a reason at any point. That stops the agreement and tells the owner.

## Traceability: what makes it good enough for a tenancy

NZ law lets an electronic signature meet a legal requirement to sign when it:

- adequately identifies the signer and shows they approved the document
- is as reliable as is appropriate in the circumstances

Sections 226 to 228 of the Contract and Commercial Law Act 2017 set this out. Section 228 presumes a signature is reliable when it is linked to the signer alone, is under their control, and any later change is detectable. *Treat these as research notes and check them before relying on them.*

| Requirement | How this meets it |
|---|---|
| **Identifies the signer** | Each signer gets their own random 48-character link, emailed to them. Only a hash of the link is stored. A new link cancels the old one. Before signing they must prove they control the email with a one-time code: 10-minute expiry, 5 attempts, at most 5 codes an hour. The verification lasts 30 minutes, then they must verify again. If the link was texted, the link and the code have arrived by two different routes. |
| **Shows approval** | They give explicit consent to sign electronically, must read to the end, draw a signature, type their full legal name (it must match, ignoring capitals and macrons), and tick "I have read this tenancy agreement… and I agree to be bound by it". The exact wording is stored with the signature. |
| **Everyone signed the same thing** | When the agreement is sent, the terms, the landlord's details and the template wording are frozen and fingerprinted with SHA-256 (the *terms hash*). A signature is accepted only if the signer's page shows that same hash. Editing the template later never changes an agreement already sent. |
| **Signature linked to that signer only** | Each signature gets a *signature record hash* covering the agreement ID, role, email, terms hash, details hash, signature-image hash, typed name and server time. |
| **Changes are detectable** | Every event is appended to an audit log, and each entry includes the hash of the one before (a hash chain). Editing, deleting or reordering any event breaks the chain. The console shows "Audit trail intact" or names the event where it breaks. |
| **Independent evidence** | When everyone has signed, a document is produced: the agreement with signatures, followed by a **signing certificate** listing each signer's verification times, device, reported IP, signature and hashes, and the full audit trail. Its SHA-256 fingerprint and the audit hash are emailed to every party with their copy. Those emails sit in the tenants' own inboxes, outside the owner's control. |
| **Anyone can check a copy** | `verify.html` works out a file's fingerprint on the device and looks it up. A match means it is the exact signed file. |
| **Order and timing** | Signing is sequential (Tenant 1 → … → Landlord 1 → Landlord 2). Each person is emailed automatically when it's their turn. Links expire after 14 days. Server timestamps are in UTC and shown in NZ time. |

### Honest limitations

- **Tamper-evident, not tamper-proof.** The owner controls the Google account that holds the records. The hash chain and the fingerprints emailed to tenants mean a quiet change would be detectable, but they can't prevent one. That is normal for self-hosted signing, and it is why the copies emailed to tenants matter.
- **The IP address is reported by the device.** Apps Script can't see a caller's IP address, so the browser asks api.ipify.org for it, and the record labels it "reported by device". To switch this off, set `captureIp: false` in `docs/js/config.js`.
- **An email code proves control of the email address, not who the person is.** Identity is checked earlier, in the application process (photo ID and so on). Each signer can carry their application reference (`ref`) so the two records link up. Text-message codes would cost money, so they aren't used. Texting the *link* from your own phone, with the code still emailed, gives two routes for free.
- **The agreement wording is a plain-English prototype and hasn't been legally reviewed.** Before using it for a real tenancy, compare it with the Tenancy Services agreement template and get it checked. That matters especially for the insulation, healthy homes and insurance statements, which have prescribed content.
- **In demo mode the signed document is an HTML file** (use Print → Save as PDF). The live backend makes a real PDF in Drive.

## Going live (with a test Google account first)

The backend is Google Apps Script, matching the rest of your tools, so it costs nothing extra.

1. Create a new Apps Script project at script.google.com. Use a **test** Google account, or at least a new project, not the live Tenant Management one.
2. Copy in `apps-script/Code.js`, `Core.js`, `Template.js` and `appsscript.json` (in the editor, Project Settings → show the manifest). With [clasp](https://github.com/google/clasp): `clasp create --rootDir apps-script`, then `clasp push`.
3. Run `setup()` once from the editor and approve the permissions. It creates a records Sheet, a Drive folder and an admin key, and logs all three.
4. Under Project Settings → Script properties, set:
   - `SIGN_URL`: where `docs/sign.html` is hosted (for example your GitHub Pages URL)
   - `VERIFY_URL`: the matching `verify.html`
   - `OWNER_NAME`: the name emails come from
   - optional: `TEST_EMAIL_REDIRECT=you@gmail.com` sends **every** email to you, labelled with who it was for. That lets you test with invented tenants.
   - optional: `WEBHOOK_URL` and `WEBHOOK_KEY` tell Tenant Management about changes. `LINK_DAYS` sets the link expiry (default 14). `NOTIFY_EACH_SIGNATURE=false` stops the owner being emailed after each signature.
5. Deploy → New deployment → Web app. Execute as **Me**, Who has access **Anyone**. Copy the `/exec` URL.
6. Put that URL in `docs/js/config.js` as `apiUrl` and host the `docs/` folder (GitHub Pages: Settings → Pages → branch `main`, folder `/docs`). Open the console's **Setup** tab and paste the admin key.

Each signer gets 3 emails (invite, code and signed copy). The owner gets 1 notice per tenant signature, plus their own copy. With 3 tenants that's 16 emails, well inside the 100-a-day Gmail limit. Resent codes and links add to that.

## Hooking it into Tenant Management (replacing DocHub)

Every action is a `POST` to the web app URL with a JSON body and `Content-Type: text/plain`. From the Tenant Management Apps Script use `UrlFetchApp`; `exampleSendFromTenantManagement_()` in `Code.js` shows how.

| DocHub step today | Replacement |
|---|---|
| Create a sign request from the template, delete unused roles, fill fields, send | `admin.create` with `input: {propertyAddress, landlord, landlordSigners[], terms, tenants[], source}`. Up to 5 tenants and 1–2 landlord signers (e.g. co-owners or two trustees), each with their own link and code; unused slots simply don't exist. A single signer can still be sent the old way, as `landlord.signerName` + `landlord.email`. The validation from the brief is built in: at least one tenant, unique emails, bond ≤ 4 weeks' rent, landlord email and phone, end date after start. |
| "Check status" (n/m signed, per-signer sent / opened / signed) | `admin.get` → `agreement.progress`, `signers[].status`, plus timestamps for sent, opened, verified, read and signed. Or set `WEBHOOK_URL` to be told on sent / signed / completed / declined / cancelled / expired. |
| Cancel / void | `admin.cancel` with a reason. Tenants who were already sent a link are emailed. |
| Resend | `admin.issueLink` with `channel: email`, `sms` (returns the text to open in Messages) or `copy` |
| Signed PDF saved to Drive | `agreement.final` (Drive file and SHA-256). `admin.download` returns it. |
| Tenancy created on full signature | On the `completed` webhook (or by polling), read `agreement.tenants` (confirmed name, mobile, address for service, ID and application `ref`) and `source.groupKey` to create the tenancy record. |
| *(new)* Flatmate changes | `admin.createVariation` with `input: {parentId, effectiveDate, add[] (each with an application ref), remove[] (emails), bondTotal, bondArrangement, reason}`. `admin.previewVariation` shows the document without sending. When it completes, the `completed` webhook has `kind: "variation"`, `tenancyId`, `version`, `change` and the new `tenants`. Use it to update the tenancy's move-in and move-out dates and to start the Bond Hub change-of-tenant task (bond step 3 in the brief). `admin.summary` returns the one-page tenancy summary. |

Field names follow your DocHub data keys (`LandlordName`, `RentPerWeek`, `TenancyStart`, `Tenant1Name`, …). See `ESign.buildFields` in `docs/js/core.js`.

## Project layout

```
docs/                    static site (GitHub Pages root)
  index.html             landlord console: agreements, new, demo outbox, setup
  sign.html              signer page (the mobile experience)
  verify.html            public "is this copy genuine?" check
  js/core.js             shared rules: validation, hashing, audit chain, rendering, engine
  js/agreement-template.js  agreement and change-of-tenants wording (versioned, frozen into each document)
  js/demo-backend.js     in-browser backend for demo mode
  js/config.js           demo vs live switch
apps-script/             live backend (Core.js and Template.js are generated: npm run build)
test/                    Node tests, including the Apps Script code run against fake Google services
tools/                   build and local server
```

The same `core.js` runs in three places: the browser demo, Apps Script and the Node tests. The rules can't drift apart between them. Source files are pure ASCII (non-ASCII is written as `\u` escapes), following the main project's rule, and a test enforces it.

```bash
npm test        # 29 tests: engine, audit chain, tampering, validation, landlord signers, changes of tenants, Apps Script adapter, ASCII
npm run build   # after editing docs/js/core.js or agreement-template.js
```

## Suggested next steps

1. **Legal review** of `agreement-template.js` against the Tenancy Services template.
2. **Attachments** that are part of what's signed (healthy homes compliance statement, ingoing inspection report). Hash each one into the terms fingerprint.
3. A real **PDF in demo mode**, so you can test the final file without deploying.
4. **Drive content restrictions** (read-only lock) on the final PDF, and protection on the records Sheet.
5. Wire up the Tenant Management **send dialog** to call `admin.create`, and the **webhook** to create the tenancy.
