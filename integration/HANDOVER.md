# Handover: replace DocHub with built-in signing in Tenant Management

**Audience:** the Claude Code session working in the **Tenant Management** repo.
**Source of this work:** https://github.com/kelvinbox/tenancy-esign (also on this machine at `C:\WF\Document Signing\tenancy-esign`).

## Goal

Add the owner's own e-signing service ("Tenancy e-sign") to Tenant Management as a **second signing provider** next to DocHub, switchable in Settings. DocHub must keep working the whole time. Later, once the owner is happy, DocHub will be removed. The built-in provider is mobile-friendly, keeps a hash-chained audit trail, supports up to 2 landlord signers, and supports **changes of tenants** (signed variations), which DocHub never did.

## Ground rules

1. **Don't break DocHub.** New agreements use whichever provider the Settings sheet says. **Every agreement stores `provider`**, and all later actions use the provider it was sent with. An agreement with no `provider` is a DocHub agreement.
2. **Git safety first** (step 1 below). Work on a branch called `esign-integration`. Don't merge to main or deploy to the live web app until the owner says so.
3. **Keep the project's conventions:**
   - bump the version on every change, and keep the page and backend versions matching
   - files are **pure ASCII**, with non-ASCII written as `\uXXXX` escapes
   - Sheets dates are stored as text `'yyyy-mm-dd`, and `n/m` values are written with a leading apostrophe
   - every error message says what to do
   - Node fake-backed tests
   - a **demo-mode** click-through on a phone-sized screen before any deploy
4. **Don't edit `esign-provider.gs`.** Copy it in as is. It is tested in the e-sign repo (`test/integration.test.js`). If something doesn't fit, wrap it. If it's a genuine bug, tell the owner so it can be fixed in the e-sign repo and copied again.
5. **Keep secrets out of the browser.** `ESIGN_ADMIN_KEY` lives only in Script Properties and is used only server-side through `UrlFetchApp`.

## What you're given

- `esign-provider.gs`: copy into the Apps Script project root. Server-only functions, all ending in `_`:

| Function | Use |
|---|---|
| `esignBuildAgreementInput_(ctx)` | Tenant Management records → e-sign input (the mapping rules from the brief are built in) |
| `esignPreviewAgreement_(ctx, actor)` | `{errors, warnings, html}`, for a Preview button |
| `esignSendAgreement_(ctx, actor)` | Sends. Returns `{agreement, warnings, firstLink}`, where `agreement` is the record to save on the group |
| `esignRefreshAgreement_(stored)` | Check status. Returns `{agreement, full, completed}` |
| `esignCancelAgreement_(stored, reason, actor)` | Cancel / void |
| `esignResendLink_(stored, signerId, channel, actor)` | `channel` is `email`, `sms` (returns `smsBody` and `link`) or `copy` (returns `link`). This works only for the person whose turn it is |
| `esignSignedPdf_(stored)` | The signed PDF as a Blob |
| `esignTenancyDraft_(full, {propertyId, landlordName, applicantsByRef})` | A fully signed agreement → a draft Tenancy record |
| `esignChangeTenants_(currentAgreementId, change, actor, previewOnly)` | Starts a change of tenants (or previews it) |
| `esignApplyChangeToTenancy_(tenancy, fullVariation)` | A signed change → the updated Tenancy, plus the Bond Hub change task details |
| `esignTenancySummaryHtml_(stored)` | One-page tenancy summary HTML |
| `esignRefreshOpenAgreements_(open, onUpdate)` | For the time-driven trigger |

`ctx` for sending:

```js
{
  groupKey: 'KB-20031',
  property,        // Property record, incl. the new fields below
  landlord,        // Landlord record, incl. optional signer2Name/signer2Email/signer2Mobile
  applicants: [ { ref, name, email, mobile, answers } ],  // group members in signing order; answers = application answers record
  details: { rentPerWeek, bond, startDate, endDate, maxOccupants, landlordAddressForService }  // from the send dialog
}
```

The agreement record it returns has the same shape the brief describes for `agreement`, plus extra fields: `{provider:'esign', kind, status (Sent/Signed/Cancelled/Declined/Expired), requestId, documentId, tenancyId, version, sentAt, signed:'n/m', signedAt, pdf, pdfSha256, replacedBy, signers:[{role,name,email,status,sentAt,openedAt,signedAt}], details, changeSummary}`.

## Work plan

Do these in order, and check each acceptance test before moving on.

### 1. Discover and make it safe to roll back
- Find the DocHub code:
  - the send dialog and its prerequisites
  - the data-field filling
  - Check status
  - Cancel
  - saving the signed PDF
  - creating the tenancy automatically on full signature
  - the Settings sheet reader
  - Setup → Properties and Landlords
  - the in-browser demo backend
  - the Node test harness
  - the version constant
- Then:

```bash
git tag dochub-final
git branch dochub
git push origin dochub-final dochub
git checkout -b esign-integration
```
- Ask the owner for the **current live Apps Script deployment version number** (Deploy → Manage deployments) and record it in the PR description as the rollback point.
- **Accept when:** both the tag and the branch are on GitHub, and you're on `esign-integration`.

### 2. Add the provider file and the setting
- Copy `esign-provider.gs` into the project unchanged.
- Settings sheet: add **Agreement signing** = `DocHub` (default) / `Built-in`. Show it in the app's Setup screen, if Settings are editable there.
- Add a helper `agreementProvider_()` that returns `'dochub'` or `'esign'` from that setting.
- **Accept when:** with the setting on DocHub, everything behaves exactly as before, and the existing tests pass.

### 3. Property and landlord fields (Setup)
- **Property**: add these fields, to the editor and the data model, copied by **Clone**:
  - `rentPaymentDetails` (how rent is paid, e.g. the bank account; required for built-in)
  - `chattels`
  - `insulationStatement` (required: where the insulation is, its type and condition)
  - `healthyHomesStatement` (required)
  - `pets` (optional; the default wording is used if blank)
  - `additionalTerms` (optional)
- **Landlord**: add an optional **second signer**: `signer2Name`, `signer2Email`, `signer2Mobile`.
  - Both landlord signers' emails must differ from each other and from every tenant's email.
  - Rename and delete rules stay as they are.
  - Card flag: "2 signers".
- **Accept when:** you can edit and clone the fields, they survive a reload, and the existing property and landlord tests pass.

### 4. Send dialog: dispatch by provider
- Prerequisites when the provider is built-in:
  - same as DocHub, **except no DocHub template is needed**
  - also check the property has `rentPaymentDetails`, `insulationStatement` and `healthyHomesStatement`, and say exactly what's missing, e.g. "Add a healthy homes statement in Setup → Properties → 14 Kowhai Lane"
  - unique emails across tenants and both landlord signers
- The dialog fields stay the same: landlord, address for service, rent, bond (≤ 4 weeks, with the max hint), occupants (warn if the group is bigger), start date and end date.
  - Show the new property statements read-only, with an "Edit in Setup" link.
  - Show the **signing order**: tenants in group order, then landlord signer 1, then signer 2.
- **Preview** → `esignPreviewAgreement_` → show the HTML in a modal (an `<iframe srcdoc>`).
- **Send** → `esignSendAgreement_(ctx, signedInUserEmail)`:
  - save the returned `agreement` on the group, with `provider:'esign'`
  - do the same write-backs as today: rent, bond, occupants and insurance go to the property; the landlord's address and phones go to the landlord
  - if `firstLink` comes back (the email failed), show it with Copy and Text buttons
- Use **in-page confirmation dialogs, never `window.confirm()`**. Some phone and in-app browsers silently block native dialogs, and that has already broken a Send button once.
- **Accept when:** with the setting on Built-in, an agreement sends, the group card shows `0/n signed`, and the first tenant receives the email.

### 5. Status, cancel, resend, PDF: dispatch by `agreement.provider`
- **Check status**: `esignRefreshAgreement_`. Save `agreement`. Show `n/m signed` and per-signer sent → opened → signed with times.
- **Cancel**: `esignCancelAgreement_`. After this a new agreement can be sent, as today.
- **Resend**: Email again / Text link / Copy link.
  - For Text, open `sms:` with `smsBody`, using `target="_blank"`, because Apps Script iframes block `sms:` otherwise.
  - Making a new link cancels the previous one, so warn first, in-page.
- **Signed PDF**: link to `agreement.pdf`. That Drive file belongs to the owner. So family members can open it, **also save a copy** with `esignSignedPdf_` into the Drive folder Tenant Management already uses for signed agreements, and store that copy's URL. Keep `pdfSha256`.
- **Accept when:** all four work for a built-in agreement, and a DocHub agreement still uses DocHub for all four.

### 6. Fully signed → tenancy (once only)
- When a refresh returns `completed: true`, create the tenancy with `esignTenancyDraft_(full, {propertyId, landlordName, applicantsByRef})`.
- **Only once:** skip it if a tenancy with that `agreementRequestId` already exists.
- Save the new per-tenant **`addressForService`**. Tenants now confirm it when they sign; DocHub left it blank.
- **Accept when:** after the last signature, Check status creates exactly one tenancy with the right tenants, dates of birth, start and end, rent and bond. Pressing Check status again creates nothing new.

### 7. Time-driven refresh (no webhook needed)
- The web app runs as the signed-in user, so it can't receive webhook POSTs. Poll instead.
- Add a public function `esignPollTrigger()` that:
  - collects groups whose agreement is `provider:'esign'` and `status:'Sent'`
  - also collects tenancies with a pending change of tenants (step 8)
  - calls `esignRefreshOpenAgreements_(open, onUpdate)`
  - in `onUpdate`, saves the record and does step 6 or step 8 when it completes
- Add `installEsignTrigger()` to create a 15-minute time-driven trigger. Run it once from the editor; the owner will need to approve.
- **Accept when:** after signing finishes, the tenancy appears within 15 minutes without anyone pressing Check status.

### 8. Change tenants (Tenancies screen); delivers bond step 3 from the backlog
- Show it only for tenancies whose current agreement is `provider:'esign'` and fully signed, with no change already pending.
- The form:
  - **Who is leaving**: tick boxes for the current tenants.
  - **Who is joining**: pick from **Approved** applicants for this property who aren't already in a tenancy. Approval is required; there is no free-text entry.
  - Effective date, total bond (blank keeps it the same), **how the bond is being settled** (required), and an optional reason.
  - Preview with `previewOnly = true`, then Send.
- Save the returned variation record on the tenancy as `pendingChange`.
- On refresh `completed`:
  - run `esignApplyChangeToTenancy_(tenancy, full)`
  - save the tenants, `formerTenants` (with `moveOut`) and `agreementVersions`
  - clear `pendingChange`
  - create the **Bond Hub change-of-tenant task**, due 10 working days after the effective date, using the app's existing working-day calendar
- Add a **Tenancy summary** button using `esignTenancySummaryHtml_`.
- **Accept when:** a swap (one leaving, one approved applicant joining) can be sent, and once signed the tenancy shows the new tenants with move-in and move-out dates and a Bond Hub task.

### 9. Demo mode
- In the in-browser demo backend, fake the built-in provider: Send creates an agreement record, and each Check status advances one signer until fully signed. The same goes for changes of tenants.
- The owner tests everything on a phone in demo mode first.
- **Accept when:** a full demo click-through works at phone width: send, check status repeatedly, tenancy created, change tenants, change applied.

### 10. Tests, version, PR
- Add Node tests in the project's existing harness for:
  - provider dispatch: a DocHub record still goes to DocHub
  - the send prerequisites messages
  - creating the tenancy once only
  - the poll trigger skipping DocHub agreements
  - applying a change of tenants
- Bump the version and run the ASCII check.
- Open a PR from `esign-integration` and **don't merge**. In the PR description, include the rollback steps (below) and the owner's go-live checklist.

## Go-live checklist (for the owner; put it in the PR)

1. Deploy the e-sign backend under the owner account, following the e-sign README section "Going live". It's a **separate** Apps Script project with its own records Sheet and Drive folder.
2. In the **Tenant Management** project: Script properties `ESIGN_API_URL` (the e-sign `/exec` URL) and `ESIGN_ADMIN_KEY`.
3. Fill in the new property fields for each property, and the second landlord signer if wanted.
4. Deploy Tenant Management as a **new version** of the existing deployment. The setting is still DocHub, so nothing changes yet.
5. Run `installEsignTrigger()` once.
6. Pilot: set **Agreement signing = Built-in**, send one agreement to family members acting as tenants, then one real one.
7. Have the agreement and variation wording legally reviewed before the first real tenancy.

## Rollback

- **Fast:** set **Agreement signing = DocHub**. New agreements go to DocHub again. Built-in agreements already sent keep working, because they dispatch by `provider`.
- **Full:** redeploy the recorded previous deployment version in Apps Script, or check out the `dochub` branch and `clasp push`.

## e-sign API reference (all `POST`, `Content-Type: text/plain`, JSON body, `adminKey` required for `admin.*`)

| Action | Body | Returns |
|---|---|---|
| `admin.create` | `{input}` | `{agreement, warnings, firstLink}` |
| `admin.preview` | `{input}` | `{errors, warnings, html}` |
| `admin.get` | `{id}` | `{agreement, terms, landlord, signers, events, chain, tenancy}` |
| `admin.list` | `{}` | `[agreement]` |
| `admin.cancel` | `{id, reason}` | `agreement` |
| `admin.issueLink` | `{id, signerId, channel}` | `{link, smsBody}` / `{emailed}` |
| `admin.download` | `{id}` | `{name, mime, base64}` |
| `admin.summary` | `{id}` | `{name, version, html}` |
| `admin.createVariation` | `{input:{parentId, effectiveDate, add[], remove[], bondTotal, bondArrangement, reason}}` | `{agreement, warnings, firstLink}` |
| `admin.previewVariation` | same | `{errors, warnings, html}` |

Errors come back as `{ok:false, error, code}`. The `error` text is written for the user and can be shown as is.

## Known open points

- Google's HTML-to-PDF conversion of the signed document hasn't been tried on a real Google account yet. The owner should do one test signing on the e-sign side first (go-live step 1).
- Gmail quota: both projects send as the owner and share about 100 emails a day. An agreement with 3 tenants uses about 16.
- ID numbers stay in agreements and variations (owner's decision: Tenancy Services uses them).
