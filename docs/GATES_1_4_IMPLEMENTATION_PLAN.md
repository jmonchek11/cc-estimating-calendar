# Gates 1-4 Implementation Plan

**Status:** Planning only. No schema, route, UI, or state-machine change is authorized by this document.

**Scope:** Gates 1-4 of `LIS-OPS-001 Master Project Life Cycle`, draft original reviewed August 11, 2026. This plan applies to the Estimating Calendar v2 app in `app/`, not to the FA scope workflow. LIS-OPS-001 states that it is draft and not effective; therefore, the initial implementation records evidence and verification without blocking calendar actions.

## Pilot Decisions Recorded August 11, 2026

| Topic | Pilot direction |
|---|---|
| Start now | Yes. Run against the current draft as a pilot to learn how it works before the SOP is published. |
| PC oversight | The Project Coordinator oversees every Gate 1-4 step and keeps the complete record. |
| Evidence | The proof required depends on the task. The task template will give the PC a practical prompt for the appropriate link, document, email, system record, or note. |
| Gate verification | The PC verifies Gates 1-4 during the pilot. This is a documented pilot exception to the current SOP draft, which assigns Gate 4 verification to the Operations Manager. |
| Rollout population | New bids only. Existing bids are added later, selectively, as the pilot is refined. |
| Enforcement | No blanket rule. Whether a missing item is a reminder, warning, hold, or future hard stop depends on that specific task; the pilot starts without hard blocks. |

## 1. Design Position

1. A gate is an auditable record of work, evidence, exceptions, and verification. It is not a replacement for technical judgement.
2. An automatic-evidence item means the calendar already creates a usable system record. It is evidence, not automatic gate approval.
3. A manual-attestation item requires a responsible person to state that the work was completed and attach or link the supporting record. The calendar should not claim that an external system was checked when it was not.
4. A gate-verification item is an explicit verifier decision after reviewing the applicable evidence and any approved exception.
5. Existing Calendar records may be referenced, but historic records are never silently converted into completed task history.
6. The SOP's phrase "all systems" includes systems outside the Calendar. A Calendar field alone is never proof that every external system is current.

### Evidence Terms

| Classification | Meaning in the first release | Examples of existing Calendar evidence |
|---|---|---|
| Automatic evidence | A Calendar field, completed action, or emitted event already records the relevant Calendar-side fact. The task is still awaiting the gate verifier. | `BidSubmission.date_submitted`; `bid.stage_changed`; `bid.awarded`; `Job` created from an award. |
| Manual attestation | A designated role records completion and a reference to the real record. Required when the work occurs in Project HQ, OneDrive, Accubid, a CM platform, email, or professional judgement. | OneDrive/Project HQ URL, CM receipt, quote-review reference, written award notice. |
| Gate verification | The assigned verifier records pass, hold/return, or approved exception after reviewing the task record. | PC for Gates 1-3; Operations Manager for Gate 4. |

## 2. Existing Calendar Evidence Inventory

These are current facts that a later implementation may reference. They are not new requirements and do not prove work performed outside the Calendar.

| Calendar fact | Exact current field, action, or event | Useful gate evidence |
|---|---|---|
| Opportunity decision | `Bid.approved_to_bid`, `Bid.approved_to_bid_at`; `POST /api/v2/bids/:id/approve-to-bid` | Gate 1 decision recorded, subject to a documented reason reference. |
| Decline/close record | `Bid.stage = closed`, `closed_date`, `closed_approved_by`, `close_reason`; `POST /api/v2/bids/:id/close`; `bid.stage_changed` | Gate 1 stop/hold disposition recorded. It does not prove GC notification. |
| Bid setup identity and assignments | `Bid.bid_number`, `date_received`, `due_date`, `due_time`, `estimator_id`, `salesperson_id`, `sub_estimators`, `folder_url`; `POST /api/v2/bids/:id/start` or `POST /api/v2/bids` | Gate 2 Calendar setup, capacity-review inputs, and a link to the bid folder. |
| Walk-through record | `Bid.walkthroughs[]` and `POST /api/v2/bids/:id/walkthroughs` | Phase 1/3 site-visit scheduling or attendance evidence when applicable; it is not proof of a completed site visit. |
| Submitted proposal | `BidSubmission.date_submitted`, `amount`, `approved_by`, `submission_type`, `notes`; `POST /api/v2/bids/:id/submit`; `bid.stage_changed` to `submitted` | Gate 3 Calendar submission record. It has a date, not a receipt timestamp. |
| Bid-date comparison inputs | `Bid.due_date`, `due_time` and the submission's `date_submitted` | Gate 3 date comparison only; written receipt and timestamp remain manual evidence. |
| Award result | `Bid.stage = awarded`, `award_date`, `awarded_company_id`; `POST /api/v2/submissions/:id/award`; `bid.awarded` | Gate 4 Calendar award record. |
| Award-created job | `Job.winning_bid_id`, `Job.award_date`, `Job.awarded_company_id`; `job.created` | Gate 4 confirmation that the award action created the Calendar-side job. |
| Existing audit trail | `ActivityLog` records route actions with actor, timestamp, action, entity, and summary; `/api/v2/activity` is admin-only today | Supporting chronology only. It is not immutable gate evidence because current Activity Log supports selected undo operations and has no task/evidence model. |
| Shared platform history | Append-only `liberty-core.events` types including `bid.created`, `bid.stage_changed`, `bid.awarded`, and `job.created` | Cross-app, read-only timeline evidence. Existing event payloads must not be renamed or removed. |

## 3. Gate Criterion Mapping

The tables preserve each checklist statement from SOP Gates 1-4. "Calendar anchor" is shown for automatic evidence and for the partial Calendar fact that a manual item may cite. `None` means the Calendar currently has no appropriate record.

### Gate 1 - Business Development and Lead Generation

| SOP criterion | Classification | Calendar anchor or required evidence |
|---|---|---|
| Scope aligns with LIS trade capabilities | Manual attestation | Lead Estimator attestation with scope review reference; existing `Project.description` / opportunity notes may be cited, but do not decide capability fit. |
| Union labor confirmed available in jurisdiction | Manual attestation | Superintendent/Operations Manager attestation with union-hall contact reference; `Bid.jurisdiction` is only populated at submission and is not sufficient. |
| Estimating bandwidth confirmed against calendar | Manual attestation | Lead Estimator attestation; cite `due_date`, `due_time`, `estimator_id`, `salesperson_id`, and `sub_estimators` as the Calendar inputs reviewed. |
| Backlog and field capacity available | Manual attestation | Operations Manager/Superintendent attestation with capacity reference; no current Calendar capacity field. |
| Margin potential meets threshold | Manual attestation | Lead Estimator attestation with ROM/estimate reference; no pre-submission margin field. |
| GC/owner relationship and payment history acceptable | Manual attestation | Business Development attestation with relationship/payment-history reference; no current Calendar field. |
| Decision and reason recorded on Estimating Calendar | Automatic evidence | `approved_to_bid`, `approved_to_bid_at`, and `POST /api/v2/bids/:id/approve-to-bid`; the reason must be linked from the task because it is not a dedicated structured field. |
| Out of scope or trade coverage gap | Manual attestation | Lead Estimator records stop/hold rationale and evidence reference; no automatic classification of a scope gap. |
| Union labor unavailable in local | Manual attestation | Superintendent/Operations Manager records union-hall reference. |
| Backlog at capacity | Manual attestation | Operations Manager/Superintendent capacity reference. |
| Excessive travel, OT, or PLA exposure | Manual attestation | Lead Estimator records risk review and decision reference. |
| Margin or risk unacceptable | Manual attestation | Lead Estimator records ROM/risk-review reference. |
| Poor GC/owner payment history | Manual attestation | Business Development records payment-history reference. |
| Decline recorded and GC notified - archive opportunity | Manual attestation | Calendar-side decline is anchored by `stage = closed`, `closed_date`, `closed_approved_by`, `close_reason`, `POST /api/v2/bids/:id/close`, and `bid.stage_changed`; GC notification requires a manual email/CM reference. |

### Gate 2 - Bid Preparation and Setup

| SOP criterion | Classification | Calendar anchor or required evidence |
|---|---|---|
| Bid created in Project HQ with correct numbering | Manual attestation | PC attaches Project HQ record reference; compare its number to `Bid.bid_number`. |
| OneDrive folder populated and complete | Manual attestation | PC attaches folder reference; `Bid.folder_url` is a useful link but does not prove required contents. |
| Accubid job created and linked to A: Drive | Manual attestation | PC attaches Accubid job/path reference; no current Calendar field. |
| All plans, specs, and addenda downloaded and broken out by trade | Manual attestation | PC attaches OneDrive/CM scope-log reference; `Bid.drawings` describes a drawing set but is not an addendum register. |
| JIS started and linked | Manual attestation | PC attaches JIS reference; current JIS import can enrich bid data but no existing field is a JIS-link-of-record. |
| Estimating Calendar updated with no conflicts | Automatic evidence | Calendar setup fields `bid_number`, `due_date`, `due_time`, `estimator_id`, `salesperson_id`, and `sub_estimators` are automatically available after Start Bid/direct creation. A verifier must still assess conflict policy because no persistent conflict-result field exists. |
| Prequalification and compliance documents current | Manual attestation | PC/Executive Assistant attaches compliance/prequalification reference; no current Calendar compliance entity. |
| Action item issued to estimator | Manual attestation | PC attaches Project HQ action reference. `estimator_id` proves assignment, not that a Project HQ action was issued. |
| Incomplete document set from GC - request missing items before release | Manual attestation | PC attaches CM/email request and holds the criterion open; no current Calendar document-completeness state. |
| Prequalification not current - cannot submit | Manual attestation | PC records exception/hold with compliance reference. |
| Estimating bandwidth conflict identified - escalate to Lead Estimator | Manual attestation | PC/Lead Estimator records the conflict and escalation reference; Calendar date/assignee fields are supporting inputs only. |

### Gate 3 - Estimate Takeoff and Submission

| SOP criterion | Classification | Calendar anchor or required evidence |
|---|---|---|
| Takeoff complete and all addenda incorporated | Manual attestation | Estimator attestation with Accubid and addendum-log references; no current takeoff/addendum entity. |
| Labor rates, burden, and wage determination verified | Manual attestation | Lead Estimator attestation with rate/wage reference; Calendar payroll flags do not prove calculation review. |
| Sub quotes leveled and compliant subs selected | Manual attestation | Estimator/PC attestation with quote-leveling and compliance references; no current quote-leveling entity. |
| Internal review complete and markup applied | Manual attestation | Lead Estimator attestation with review/Accubid summary reference. |
| Executive sign-off obtained where required | Manual attestation | Executive sign-off reference and threshold determination; no current sign-off field. |
| Proposal submitted before deadline with written receipt confirmation | Manual attestation | `BidSubmission.date_submitted`, `Bid.due_date`, and `due_time` provide the Calendar comparison. Attach written receipt/timestamp; current submission action has no receipt reference or time-of-submission field. |
| Submission logged in Project HQ and Estimating Calendar | Manual attestation | Calendar portion is automatic from `BidSubmission` and `POST /api/v2/bids/:id/submit`; PC attaches Project HQ submission reference. |
| Scope ambiguity unresolved at bid deadline - qualify the exclusion in writing | Manual attestation | Estimator attaches proposal qualification/RFI reference. |
| Insufficient sub coverage on a required scope - escalate to Lead Estimator | Manual attestation | Estimator attaches escalation and decision reference. |
| Wage determination unavailable - do not submit without qualification | Manual attestation | Lead Estimator attaches qualification and wage-determination reference. |
| Executive sign-off not obtained on a threshold bid | Manual attestation | Record the hold or documented exception; no automatic threshold/sign-off evidence exists. |

### Gate 4 - Sales Follow-Up and Award Decision

| SOP criterion | Classification | Calendar anchor or required evidence |
|---|---|---|
| Gate 4 verified by Operations Manager - PC recused | Gate verification | For the pilot, a PC `gate.verified` event records a documented exception to this draft-SOP criterion. The event must identify that it used the pilot verification rule. |
| Written award notification received | Manual attestation | Business Development/PC attaches written award reference; `POST /api/v2/submissions/:id/award` alone is not proof of written notice. |
| Award value and scope match submitted proposal or a re-priced revision | Manual attestation | Compare award reference to `BidSubmission.amount`, `submission_type`, `notes`, and the awarded company's current submission. Scope comparison requires manual evidence. |
| Estimate package and job folder confirmed complete | Manual attestation | Estimator/PC attaches OneDrive/Accubid package reference; `Bid.folder_url` is supporting link only. |
| All systems updated to Awarded | Manual attestation | Calendar-side evidence is automatic: `Bid.stage`, `award_date`, `awarded_company_id`, `bid.awarded`, created `Job`, and `job.created`. PC must attach Project HQ/CM confirmation because those systems are outside the Calendar. |
| Award communicated verbally only - obtain in writing before proceeding | Manual attestation | Record hold and attach written award when received. |
| Award value does not match the proposal - reconcile before acceptance | Manual attestation | Record comparison, reconciliation, or exception reference. |
| Scope reduced without re-pricing - return to Lead Estimator | Manual attestation | Lead Estimator attaches revised pricing reference and resulting decision. |

## 4. Proposed Immutable Task Model

### 4.1 Two append-only records, not mutable checkboxes

Use a stable task-instance record plus an append-only event stream. A task row never changes its criterion, SOP/template version, role, or original assignee. A current-status projection is derived from events for display and reporting.

#### `bid_gate_tasks` - immutable task-instance snapshot

| Field | Purpose |
|---|---|
| `task_id` | Calendar-owned immutable sequential or UUID identifier. |
| `bid_id` | Required Calendar Bid foreign key. |
| `project_id` | Denormalized join aid for events/read models; Bid remains the ownership boundary. |
| `task_key` | Stable template key, for example `g3.proposal_written_receipt`. |
| `criterion_text` | Exact SOP checklist text copied into the instance; never edited in place. |
| `sop_document_number` | `LIS-OPS-001`. |
| `sop_version` | Published revision when available; for the draft pilot, explicit draft identifier/date, never a blank value. |
| `template_version` | Version of the Calendar gate-task template used to instantiate this task. |
| `gate` / `phase` | Integer `1` through `4` and corresponding phase name. |
| `evidence_class` | `automatic_evidence`, `manual_attestation`, or `gate_verification`. |
| `responsible_role` | SOP task-performing role, such as PC, Lead Estimator, Estimator, BD, OM, or Superintendent. |
| `assignee_id` / `assignee_snapshot` | Assigned Calendar user id plus display-name/role snapshot at creation. Reassignment is an event, not a row update. |
| `created_at`, `created_by` | Creation provenance. |
| `origin` | `new_bid` or `existing_record_adoption`. |

#### `bid_gate_task_events` - immutable evidence, status, verification, and exception history

| Field | Purpose |
|---|---|
| `event_id`, `task_id`, `bid_id`, `at`, `actor_id`, `actor_snapshot` | Append-only chronology and identity. |
| `event_type` | See Section 7. |
| `status` | Status at that event: `not_started`, `evidence_recorded`, `attested`, `verification_requested`, `verified`, `returned`, `on_hold`, `exception_requested`, `exception_approved`, `exception_rejected`, or `superseded_by_template`. |
| `completed_by`, `completed_at` | The person/date claimed for task completion; distinct from the person/date who entered the event. |
| `evidence` | Array of typed references: `calendar_field`, `calendar_action`, `outbox_event`, `project_hq`, `onedrive`, `accubid`, `cm_platform`, `email`, `document`, or `other`; include immutable label, URL/path/id, and captured-at snapshot. |
| `attestation_text` | Required for manual attestation; describes what was checked without copying sensitive source material into the event. |
| `verifier_id`, `verified_at`, `verification_decision`, `verification_notes` | Present only for a verification event. |
| `exception` | Structured object: reason, impact, compensating control, requested_by/date, phase accountable owner id/snapshot, approval decision/date, and written approval reference. |
| `related_calendar_event_id` | Optional reference to the relevant `liberty-core.events` row or Calendar action/activity id; never a mutable live lookup alone. |

**Read model:** `bid_gate_task_status` (or an equivalent query projection) may expose the latest effective status, assignee, evidence summary, and gate roll-up. It is disposable/rebuildable. It is not the source of truth and must not permit edits.

### 4.2 Immutability and correction rules

1. Never update or delete an instance/event to correct history. Append `evidence_corrected`, `attestation_superseded`, `verification_returned`, or `exception_rejected` with a reason and link to the earlier event.
2. Later SOP/template changes create new task instances only for newly eligible bids. They do not rewrite past criterion text or make historical tasks appear to have used a newer SOP.
3. Auto evidence is captured as a snapshot of the relevant Calendar field/action/event at observation time. A later edit to a bid must not silently alter the evidence record.
4. A verifier decision applies to the task instance and its event history, not to a mutable checkbox on the Bid.

## 5. Permissions and Separation of Duties

| Action | Authorized role | Constraint |
|---|---|---|
| Oversee/create/assign/attest Gate 1-4 tasks | Project Coordinator, with input from the role that performed the work | The PC owns follow-through and the record. The knowledgeable role supplies the evidence or attestation where the task requires judgement. |
| Verify Gate 1-4 during the pilot | Project Coordinator | PC records a pass, return/hold, or exception path after records review. Gate 4 is a time-bounded pilot exception to the current draft SOP's Operations Manager recusal rule. |
| Approve a documented exception | Accountable owner for that phase | Gate 1 and Gate 3: Lead Estimator. Gate 2: Project Coordinator. Gate 4: Business Development/Sales Rep. Approval must include a written reference, reason, impact, and compensating control. |
| Enter an exception request | Responsible role or PC | Cannot self-approve unless leadership explicitly changes the accountable-owner rule. |
| View pre-award history in PC Tool | PC Tool user with existing project access | Read-only projection from Calendar events; no PC Tool write-back. |

The Calendar's current legacy `TeamMember.role` / `is_admin` model does not yet express all SOP roles or this separation-of-duties matrix. Role resolution, Operations Manager identity, and backup behavior are implementation decisions listed in Section 9.

## 6. Calendar State Transitions and Gates

### 6.1 Initial behavior while LIS-OPS-001 is a draft

No existing Calendar transition becomes a hard block. The application continues to allow its validated state transitions while it records gate state alongside them:

| Calendar action/transition | Gate interaction in the planning model | Initial enforcement |
|---|---|---|
| Create opportunity / lead | Create or activate the Gate 1 task pack for a new bid, depending on the final instantiation decision. | Informational only. |
| Approve to bid | Observe `approved_to_bid` / `approved_to_bid_at` as Gate 1 automatic evidence. | No block. |
| Start Bid or direct create at `active_bid` | Observe setup fields and `bid.stage_changed` to `active_bid`; prompt for unresolved Gate 1/2 evidence. | No block. |
| Submit Bid / add submission | Capture submission data and `bid.stage_changed` to `submitted` as Gate 3 evidence; prompt for receipt/Project HQ attestation. | No block. |
| Award submission | Capture award/job events as Gate 4 evidence; open Gate 4 verification for the PC under the pilot exception. | No block. |
| Close, reactivate, not-awarded, held/cancelled, or re-bid | Preserve all completed task history; add a transition-observed event and put affected open tasks on hold or return them according to later policy. | No block. |

The later published-SOP rollout may introduce warning, soft-block, or hard-block rules only after leadership approves each transition's policy. This plan makes no assumption that a Gate 1-4 failure should prevent the Calendar's current state machine from operating.

### 6.2 New bid behavior

1. This pilot applies to new Bids only. New task instances are created from a versioned template, with the SOP/template version stamped on every task.
2. The instance set includes all Gate 1-4 criteria in Section 3, including stop/hold conditions, so the history can show why a bid was held, declined, re-priced, or advanced.
3. Direct-created bids (`POST /api/v2/bids`) receive the same new-bid task pack. Gate 1 begins as `not_started` and requires PC review; the system must not infer Gate 1 completion from an already-`active_bid` stage.
4. A re-bid/new drawing-stage bid gets a new task pack because it is a new Bid. Its prior Bid's task history remains attached to the prior Bid and may be linked as contextual history only.
5. A reactivated Bid retains its prior task instances. New evidence is appended to existing tasks or a new task version is instantiated only when the final template-version policy says it is required.

### 6.3 Existing-record adoption

1. Existing Bids are outside the first pilot. Do not bulk-create completed historical tasks and do not bulk-mark any task complete.
2. After the pilot is refined, adoption may be enabled one Bid at a time by the PC or another authorized user.
3. An adopted Bid receives a full task pack with `origin = existing_record_adoption`, the current SOP/template version, and status `not_started` or `evidence_recorded` only where a real Calendar event/field snapshot exists.
4. A user may add a manual attestation for prior work only with a dated source reference and a clear statement that it was recorded after the fact. The event retains both the claimed completion date and the actual entry date.
5. Existing terminal bids remain untouched unless leadership specifically authorizes a curated adoption workflow. They are not a data-cleanup project.

## 7. Append-Only Events for PC Tool History

The Estimating Calendar remains the gate-data owner. Additive events may be emitted to `liberty-core.events` after primary Calendar writes, following the existing non-blocking `safeEmit()` pattern. Event types and payload fields are append-only.

| New event type | Emitted when | Minimum payload for the PC Tool's read-only pre-award history |
|---|---|---|
| `bid.gate_task_created` | Task instance is created | `task_id`, `task_key`, `gate`, `phase`, `criterion_text`, `sop_document_number`, `sop_version`, `template_version`, `responsible_role`, `assignee_snapshot`, `origin`. |
| `bid.gate_automatic_evidence_recorded` | Existing Calendar fact is snapshotted | `task_id`, `gate`, `evidence_type`, `calendar_field_or_action`, `evidence_snapshot`, `observed_at`. |
| `bid.gate_manual_attested` | Responsible role submits manual completion evidence | `task_id`, `gate`, `status`, `completed_by_snapshot`, `completed_at`, `attestation_text`, `evidence_summary`. |
| `bid.gate_evidence_corrected` | Earlier evidence is clarified or superseded | `task_id`, `prior_event_id`, `reason`, `evidence_summary`. |
| `bid.gate_verification_requested` | A task/gate is ready for verifier review | `task_id` or `gate`, `requested_by_snapshot`, `evidence_summary`. |
| `bid.gate_verified` | Authorized verifier passes a gate/task | `task_id` or `gate`, `verifier_snapshot`, `verified_at`, `decision`, `notes`. |
| `bid.gate_returned` | Verifier holds/returns a task or gate | `task_id` or `gate`, `verifier_snapshot`, `reason`, `required_follow_up`. |
| `bid.gate_exception_requested` | An unmet criterion is formally escalated | `task_id`, `gate`, `reason`, `impact`, `compensating_control`, `requested_by_snapshot`, `written_reference`. |
| `bid.gate_exception_decided` | Phase accountable owner approves or rejects an exception | `task_id`, `gate`, `decision`, `approver_snapshot`, `decided_at`, `written_reference`, `reason`. |
| `bid.gate_assignee_changed` | Task responsibility changes | `task_id`, `from_assignee_snapshot`, `to_assignee_snapshot`, `reason`. |
| `bid.gate_calendar_transition_observed` | Relevant bid lifecycle transition occurs | `gate`, `from_stage`, `to_stage`, `calendar_event_type`, `calendar_event_id`, `observed_at`. |
| `bid.gate_adopted` | An existing Bid is intentionally brought into gate tracking | `task_id`, `origin`, `adopted_by_snapshot`, `adopted_at`, `as_of_date`, `evidence_summary`. |

All events include the existing outbox envelope fields needed for joins: `source: estimating`, `project_id`, `bid_id`, optional `job_id`/`submission_id`, `actor_id`, and `at`.

**PC Tool contract:** the PC Tool consumes these as timeline data keyed by Calendar `project_id`/`bid_id`. It must render task/gate history and evidence summaries as read-only. Any PC Tool action that looks like an edit must instead deep-link the user back to the Calendar after that capability exists. The PC Tool must never create, modify, verify, or approve a Calendar task through its own database.

## 8. Delivery Sequence After Approval

1. Use the recorded pilot decisions and a clearly labeled draft-version Gate 1-4 template.
2. Define the data contracts and access controls, including immutable-event retention/correction rules.
3. Add task-instance and event storage plus Calendar-side read projection, with no transition blocking.
4. Add automatic evidence observers for the existing Calendar actions/events in Section 2.
5. Add manual attestation, evidence-reference, exception, and verifier workflows with role checks.
6. Emit the new append-only outbox events and have the PC Tool render them read-only.
7. Pilot with newly created bids. Review evidence quality, PC workload, the Gate 4 exception, and task-specific reminders/holds before considering warnings or enforcement.

## 9. Items to Decide During the Pilot

The pilot does not need twenty up-front answers. The PC can record what evidence actually works for each task, then leadership can make the following practical decisions from real examples:

1. For each task, what simple proof works best: a link, email, Project HQ item, OneDrive file, system record, or note?
2. Which missing items should simply remind the PC, which should place a Bid on hold, and which should eventually prevent advancement?
3. Does PC verification of Gate 4 work well enough in practice, or should the published SOP return Gate 4 to Operations Manager verification?
4. When should the team begin selectively adopting existing live Bids, if at all?
5. What roles need to be named in the Calendar so the PC can route requests reliably?
6. What information is appropriate to show in the PC Tool's read-only history, especially for sensitive evidence?

## 10. Non-Goals for This Plan

- No alteration to current Bid, Job, submission, Activity Log, route, UI, or lifecycle schema.
- No assertion that the Calendar can validate Project HQ, OneDrive, Accubid, CM, email, union, capacity, margin, payment-history, or compliance work automatically.
- No bulk historical completion, synthetic evidence, or retroactive claim that a past SOP/template version was used.
- No PC Tool editing surface for Calendar-owned Gate 1-4 history.
