# Match Arena — Parts 1–9 (Foundation + Coin Wallet + Challenge Board + Match Room + Result/Dispute + Referral/Fee + Profiles/Teams/Tournaments/Leaderboards + Admin Dashboard/Telegram/Notifications/Maintenance/Backups + PWA/Full UI/Language Switch)

A standalone, neutrally branded match-challenge platform. It is a fresh
project: it does not restore or reuse any earlier project files.

## What Part 1 contains

- **Accounts:** Google OAuth 2.0 login (authorization-code flow, plain
  fetch, no extra dependency). No password is ever collected or stored for
  Google users.
- **Local demo login:** `POST /auth/demo` works **only** outside
  production. It is disabled when `NODE_ENV=production` (proved by a test).
  It exists so Part 1 can be tested locally before real Google keys are
  supplied. Never enable it in production.
- **Roles and permissions:** owner, admin, moderator, support, player.
  Permissions live in the database (`roles` / `role_permissions`) and are
  checked on every protected route. Owner-only powers include role changes,
  fee/wallet settings and the legal-approval record. Admin cannot change
  roles or fee/wallet settings; moderator cannot change any setting.
- **Admin two-factor authentication:** TOTP (RFC 6238, 6 digits, 30 s),
  setup → code-verified enable → login challenge → code-verified disable.
  TOTP secrets are AES-256-GCM encrypted at rest, never stored in plaintext.
  Staff accounts with 2FA enabled must complete the challenge step; a
  challenge token cannot be used as an access token.
- **Security:** Helmet headers, CORS, JSON size limit, zod input validation
  on all inputs, rate limiting on `/auth/*`, a honeypot bot hook, JWT
  access tokens backed by revocable session rows (logout really revokes),
  and an error handler that never leaks stack traces.
- **Audit log:** every admin action (setting change, role change, ban/unban,
  2FA enable/disable) is recorded with actor, action, target and
  date/time. Read-only via `GET /admin/audit-log` (owner/admin only).
  There is no edit or delete endpoint for audit entries.
- **Settings store:** key/value settings in the database with defaults.
  The legal-approval setting records **exactly** what the user stated:
  lawyer consulted, contract in progress, permission given by the user.
  No lawyer name, contract name or date was provided, and none is recorded.
- **Money movement:** explicitly **disabled** in Part 1.
  `money_movement_enabled`, `paid_entry_enabled` and `withdrawals_enabled`
  are all `false` by default, and even the owner cannot set any of them to
  `true` through the API in Part 1 (the request is rejected with 400).

## What Part 2 adds: the coin wallet

- **Balances:** every user has `available`, `locked` and `total`
  (`available + locked`). Balances can never go negative — the service
  checks first and the tables enforce it with `CHECK (… >= 0)`.
- **Ledger:** every balance change goes through one atomic,
  append-only ledger (`wallet_ledger`) with a unique transaction id per
  entry, a type, the signed deltas, the balance after, actor,
  reference, reason and timestamp, plus an idempotency key on
  credit/debit operations. A replayed idempotency key returns the
  original entry with `replayed: true` and applies nothing twice. The
  balance row and its ledger row are written in one transaction, so a
  server error can never leave a half-applied transaction. There is
  no edit or delete endpoint for ledger entries.
- **History:** a user lists their own history, paginated, newest
  first, filterable by `type` (`purchase_credit`, `admin_adjustment`,
  `lock`, `unlock`, `consume`, `refund`). Owner/admin may look up any
  user's balance and history; a player may not view another player's.
- **Coin packages:** owner/admin create, edit and activate/deactivate
  packages (name, coins, price amount, price currency label). A player
  lists active packages only. Editing a package never changes a
  completed purchase: purchases store the package name, coins and
  price as a snapshot taken at request time.
- **Purchase flow (buying coins from the platform owner/admin):**
  1. The player creates a request choosing either a preset package
     **or** a custom coin amount — never both, never neither.
  2. A custom amount must be a positive integer within the
     owner-configured `wallet.custom_min_coins` /
     `wallet.custom_max_coins` bounds (defaults 100 / 100,000);
     zero, negative and over-max requests are rejected with a clear
     error. A custom request's price is recorded only if the owner
     has set `wallet.custom_price_per_coin` (default 0 = not set, so
     the price stays empty); approval still credits exactly the
     requested coins.
  3. The request starts as `pending`. An owner or admin approves or
     rejects it. Approval credits the exact snapshot coins atomically
     with the status change to `completed`; rejection touches no
     balance and records the reason (a reason is mandatory for
     rejection). Approving or deciding an already-decided request
     returns 409, never a second credit. Every decision is
     audit-logged.
  4. This is a request-and-approval system, **not a payment gateway**:
     no card, bank or mobile-money integration exists in Part 2.
- **Coin lock (wallet-level, for later match parts):** `lockCoins`
  moves coins available → locked; `unlockCoins` returns them;
  `refundLockedCoins` (used on cancellation) does the same move
  with a distinct `refund` ledger type; `consumeLockedCoins`
  removes locked coins on settlement (a winner is credited
  separately, by the future match module, with its own idempotent
  entry). All four are internal service functions in
  `src/services/wallet.js` — there is deliberately **no** public
  endpoint that lets a player lock or unlock anyone else's coins.
  Locked coins cannot be spent or locked again beyond the available
  balance, and every lock/unlock/refund is in the ledger with its
  reference (for example a match reference supplied by the caller).
  No match system is built in Part 2; the lock lifecycle is tested
  with generic references.
- **Manual adjustment:** owner-only, with a mandatory reason,
  audit-logged, recorded as its own `admin_adjustment` ledger type,
  and it can never take a balance negative. Admins who are not owner
  cannot adjust balances directly; they can only approve/reject
  purchase requests. Moderator/support have no wallet-write powers.
- **Wallet settings (owner-only, via the settings endpoint):**
  `wallet.custom_min_coins`, `wallet.custom_max_coins`,
  `wallet.custom_price_per_coin`. Setting min above max (or max
  below min) is rejected.
- **Money guard, unchanged from Part 1:** `money_movement_enabled`,
  `paid_entry_enabled` and `withdrawals_enabled` remain `false` by
  default and cannot be turned on in Part 2, even by the owner.
  Part 2 is the wallet ledger and purchase-request system, not a
  live cash payout system.

## What Part 3 adds: the challenge board

- **Challenge creation:** an authenticated player creates a challenge
  with arena (`1v1`, `Classic`, `Brawl`), team size (`1v1`–`5v5`),
  coin stake per player (positive integer), hero rule (`any`,
  `fighter_only`, `mage_only`, `assassin_only`, `marksman_only`,
  `tank_only`, `support_only`, `same_hero_only`, `random_hero_only`,
  `no_duplicate_hero`), an optional machine-readable `requiredHero`,
  hero bans (free-text hero names, non-empty, no duplicates), optional
  custom rules text, and a rank restriction. **Arena rule:** arena
  `1v1` forces team size `1v1`; any other combination is rejected.
  The creator is automatically the first participant and the
  challenge starts `open`. Challenges are never edited — they are
  cancelled (while open) or accepted.
- **Rank tiers:** `Warrior`, `Elite`, `Master`, `Grandmaster`, `Epic`,
  `Legend`, `Mythic`, `Mythical Glory`, in that order. A minimal
  profile endpoint (`PUT /profile/rank`) lets a user set or clear
  their own tier; full profiles and teams are Part 7. Rank
  restrictions are `none`, `same_rank_only`, or a `range` with both
  a min and a max tier (min must not be above max). A restricted
  challenge requires the creator's rank to be set at creation.
  At accept time, `same_rank_only` requires the accepter's rank to
  equal the creator's current rank, and `range` requires it to lie
  inside the range; if the accepter's rank is unset, a restricted
  challenge rejects the accept with a clear error. `none` accepts
  any rank, including unset.
- **Admin hero restrictions (owner/admin only):** create, edit and
  activate/deactivate global restrictions — a hero name, `allowed`
  or `banned`, and a mandatory reason. There is at most one active
  restriction per hero (compared case-insensitively); a second
  active rule for the same hero is a 409, and deactivating the old
  rule lifts it. **Conflict rule, exactly:** a challenge may not
  ban a hero an active restriction marks `allowed`, and may not
  require (`requiredHero`) a hero an active restriction marks
  `banned`. Banning a globally banned hero, and requiring a
  globally allowed hero, are consistent and allowed. Player
  custom-rules text is free text, is never parsed as a hero
  requirement, and never overrides an admin restriction — the
  machine-readable `requiredHero` field is the only thing the
  banned-hero check inspects. Restriction changes are audit-logged.
- **Favorite rules:** a player saves their own rule sets (arena,
  team size, hero rule, required hero, bans, custom rules, rank
  restriction) under a name, lists only their own favorites,
  deletes only their own (deleting another player's returns 404),
  and creates a challenge from a favorite in one call, with a
  stake plus optional overrides for any rule field. Favorites are
  validated with the same rules as direct creation, including
  admin conflicts.
- **Challenge board listing:** authenticated users, paginated,
  newest first, filterable by arena, team size, hero rule, exact
  coin stake, coin min/max, and rank tier. The rank-tier filter
  means "open to a player of this tier": it returns unrestricted
  challenges, same-rank challenges created by a player of that
  tier, and range challenges whose range contains that tier.
  A detail endpoint returns the full challenge — creator, all
  rules, custom rules, hero bans, rank restriction, stake, status
  and participants — plus the match-room record once matched, so
  a player can read everything before accepting.
- **Accept flow (atomic):** a player who is not the creator accepts
  an open challenge. In one SQLite transaction the service checks
  the challenge is still open, checks the rank restriction, checks
  both players' available balances cover the stake, locks the
  stake for **both** creator and accepter through the Part 2
  wallet lock service with the reference `challenge:<id>` and
  per-player idempotency keys, flips the status to `matched`,
  adds the accepter as a participant, and creates a minimal
  match-room record (`challengeId`, both players, stake,
  status `created`). Any failure rolls the whole transaction
  back, so a failed accept locks no coins. A second accept sees
  the status already `matched` and fails with 409, so it cannot
  double-lock. Self-accept, accepting a non-open challenge, and
  accepting with insufficient balance all fail with clear errors
  and lock nothing. Accept and cancel are audit-logged.
- **Cancel flow:** only the creator can cancel, and only while
  the challenge is still `open` (no coins are locked yet, so no
  refund is needed). Cancelling a `matched` challenge is rejected
  with 409 — that belongs to match timeout/cancel in a later part.
- **Refresh mechanism (polling, honestly):** the board endpoint
  accepts `since=<ISO timestamp>` and returns only challenges
  with `updated_at >= since`, so a client can poll for new and
  changed challenges. Part 3 has **no** WebSockets or server-sent
  events; polling is the documented refresh mechanism, and a
  real-time push channel is a later part if needed.
- **Minimal match room:** Part 3 creates only the match-room
  record on accept. Chat, voice, ready buttons, timers, reconnect
  and result submission are **not** in Part 3.

## What Part 4 adds: the private match room

- **Room lifecycle (server time only):** `waiting_ready` →
  `countdown` → `started`, or `waiting_ready` → `cancelled`.
  A room is created by Part 3 accept in `waiting_ready` with a
  server-recorded `readyDeadline` (from `match.ready_timeout_seconds`,
  default 300 seconds). There is no background cron in Part 4: every
  read of a room deterministically applies a due ready timeout or a
  due countdown end, so an expired waiting room is always reported
  as cancelled with refunds, and a started room's `startedAt` never
  moves on re-fetch. A scheduled sweeper is a Part 8 addition, not
  a Part 4 correctness requirement. The room id is also the match id
  used later for match history.
- **Privacy:** only room participants can view full detail; owner,
  admin and moderator may view read-only for later dispute work.
  Everyone else gets 403. Staff may not ready, chat or join voice
  as a player. Room participant display fields are display name,
  avatar URL (nullable placeholder for now), MLBB ID, server ID and
  rank tier only — never email or other private fields.
- **Game IDs:** `PUT /profile/game-ids` lets a user set their own
  MLBB ID (digits only, 5–12) and server ID (digits only, 3–6), or
  clear them with `null`. Invalid values are rejected with a clear
  error. The room detail returns every participant's IDs so a
  frontend can offer one-tap copy.
- **Per-room roster:** side A is the creator's side, side B the
  accepter's side. A side leader adds users to their own side only,
  up to that side's team size (for example 5 for 5v5), and removes
  members from their own side only, before start. Adding a roster
  member locks that member's stake (same amount as the leaders),
  and removing one refunds it. A member may leave before start
  (refund included); a leader leaving before start cancels the
  whole room with refunds for everyone. Persistent named teams,
  logos and cross-match invites are Part 7 — Part 4 roster is
  per-room only.
- **Mini chat:** participants only, text 1–1000 characters,
  persisted with sender and timestamp, paginated, oldest-first by
  default (`order=desc` for newest first). Re-entering a room
  returns the full history. There is no edit/delete endpoint in
  Part 4.
- **Voice signalling — honest scope:** Part 4 provides voice
  sessions (join/leave) and signalling relay (offer, answer,
  ICE candidate) between participants of the same room only.
  **No audio is stored or relayed by this backend, and Part 4
  must not be presented as end-to-end voice audio working.**
  Actual peer-to-peer audio in the browser is frontend WebRTC
  work in Part 9.
- **Ready and countdown:** each participant sets their own ready
  flag, and may un-ready, only while `waiting_ready`. The room
  moves to countdown only when the roster is full for that team
  size (side A count == team size AND side B count == team size)
  **and** every participant is ready — two ready players do not
  start a 5v5 room. A ready response on an incomplete roster
  records the ready flag but stays `waiting_ready` and names the
  missing counts per side. Countdown duration is the owner/admin
  setting `match.countdown_seconds` (default 10 seconds); when it
  ends, the room becomes `started` with a server-recorded
  `startedAt`. Every room response carries a timer computed from
  server timestamps (`serverTime`, state, seconds remaining), so
  a browser refresh or phone switch-off and return never restarts
  a timer.
- **Result window hook (Part 5, not Part 4):** the room state
  exposes `resultWindowOpensAt = startedAt + 5 minutes`. No result
  submission, dispute, reputation or report endpoint exists yet,
  and Part 4 must not be presented as having them.
- **Timeout and cancel:** if the ready deadline passes while
  still `waiting_ready`, the room is cancelled on next read and
  both sides' (and any roster members') locked stakes are
  refunded through the Part 2 refund service with per-player
  idempotency keys. Cancelling after start is rejected.
  Timeout/cancel and roster changes are audit-logged.
- **Reconnect:** `GET /match-rooms/:id/reconnect` returns room
  state, participants with ready flags, recent chat, voice
  members, server time and timer state in one call. Because all
  state lives in the database, a participant who disconnects
  and re-fetches sees no loss.
- **Notifications (minimal; full centre is Part 8):** a record is
  created for the other participants on ready, for all
  participants on countdown start and on match start, and for
  all participants on cancel. Part 4 provides only an unread
  list, a full own list and mark-as-read.

## What Part 5 adds: result submission, disputes, reputation, reports, match history

- **Result gate (server time only):** a result may be submitted
  only for a room in `started` (or `result_pending` for the second
  side) **and** at or after its server-recorded
  `resultWindowOpensAt`. That window is `startedAt + 5 minutes` by
  default (`match.result_window_seconds`, default 300; it is a
  setting so tests can shorten it, but production should keep
  300). Submissions before the window are rejected with a clear
  error naming the window; submissions for waiting, countdown,
  cancelled or finished rooms are rejected. A browser refresh
  never moves the window: it is derived from server timestamps.
- **Side-level submissions:** only a side's **leader** submits,
  for their side only, with outcome `win` or `lose` only (there is
  no draw outcome) and an optional reason. One submission per
  side per room, enforced by a `UNIQUE (room_id, side)` constraint
  as well as a check — a second submission by the same side is
  409. Non-leader participants can view submissions but cannot
  submit. The first submission moves the room to
  `result_pending` (no settlement yet) and notifies the other
  side; a single submission never auto-confirms.
- **Matching vs dispute:** when both sides have submitted,
  opposite outcomes agree (A win + B lose, or A lose + B win)
  and the result is confirmed automatically with settlement
  (below). Identical outcomes (both win, or both lose) disagree:
  a dispute record is opened automatically, the room becomes
  `disputed`, and **no** settlement happens — all locked coins
  stay locked, and any referral is left pending for Part 6.
- **Screenshot evidence (real upload, not a URL placeholder):**
  multipart upload of image files only (png/jpeg/webp, max 5 MB
  each, max 3 files per submission, per dispute, or per report),
  stored under `data/evidence/` (gitignored) with unique
  filenames. The database records original name, mime type, size
  and stored path. Non-image and oversize files are rejected
  with a clear error, and rejected uploads delete any files
  already saved, so they never orphan files on disk. Evidence
  is **never** served publicly: `GET /evidence/:id` looks the
  file up by database id only (never by a client-supplied path)
  and allows only room participants or owner/admin/moderator
  (for submission/dispute evidence) or the reporter or staff
  (for report evidence). Evidence can be attached to a result
  submission, to a dispute, or to a report, under the same rules.
- **Settlement math (on confirm):** pot = stake × participants
  (every participant locked one stake). Fee comes from the
  owner-configurable per-arena fee
  (`fee.1v1`, `fee.Classic`, `fee.Brawl`, each
  `{ type: 'percent' | 'fixed', value }`, default percent 0 —
  **no fee rate is invented**; 0 is the default). Percent fee
  is `floor(pot × pct / 100)`; fixed fee is `min(fixed, pot)`.
  The fee is taken from the **snapshot stored at room start**
  (see Part 4), so a fee change after a room starts cannot
  reprice that room; rooms started before Part 5 have no
  snapshot and fall back to the current fee setting at
  settlement time. Distributable = pot − fee, split equally
  among winner-side members: base =
  `floor(distributable / winnerCount)`, and the remainder goes
  to the **first** winner-side member in roster order (leader
  first, then members by joined_at). Loser-side locked coins
  are consumed, never refunded. Winner payouts are credited
  as `match_win` ledger entries (the winner's own locked stake
  is consumed separately, so a payout is not paid on top of a
  refund). The fee is recorded in `platform_fee_ledger` with
  the room reference — never as a player balance. Every
  settlement step runs in one transaction, and a settlement
  record with `UNIQUE (room_id)` makes a second confirm a 409,
  never a second payout. Part 6 will add fee preview and
  per-mode fee history on top of this same service; it does
  not replace it.
- **Admin dispute decisions:** moderator can view disputes,
  add investigation notes and (via the evidence endpoint) add
  evidence; only owner/admin can make the final decision, and
  it requires a mandatory reason and is audit-logged. A winner
  decision settles exactly as above. A cancel decision refunds
  every participant's locked stake and writes cancelled
  history. A decided dispute cannot be re-decided, and while a
  dispute is open the room cannot be settled by any other path.
- **Reputation:** every user starts at 100, floored at 0, with
  an events table (type, points change, reason, room, actor,
  timestamp). Badges: ≥90 Trusted, 70–89 Good, 50–69 Fair,
  below 50 Low. Automatic penalty in Part 5: when an admin
  dispute decision goes against a side, that side's leader
  loses 20 points (`dispute_false_submission`); the winning
  side is not penalised. There is also a manual owner/admin
  penalty endpoint (points 1–100, reason mandatory,
  audit-logged) for cheating, delaying or toxic behaviour found
  via reports. Reputation is viewable by the user themselves
  and by staff. **Reputation never auto-bans in Part 5** — bans
  are explicit, via reports below.
- **Report system:** any authenticated player can report
  another user (categories: `cheating`, `toxic_behaviour`,
  `fake_screenshot`, `intentional_disconnect`, `fake_account`,
  `other`), with a mandatory reason, an optional room
  reference and optional evidence (same upload rules).
  Self-reports are rejected. Each report gets a unique
  human-readable case id (`REP-YYYYMMDD-NNNN`, daily sequence).
  Status flow: `open` → `investigating` → `resolved`
  (with resolution and action taken). Moderator investigates
  and adds notes; only owner/admin can resolve and apply
  actions: `none`, `warning` (recorded and counted per user
  in the reputation view), `temp_ban` (requires a future
  `tempBanUntil`; login is denied while the ban is active and
  allowed again automatically after expiry, with no manual
  unban needed), or `permanent_ban` (existing banned flag).
  All report actions are audit-logged.
- **Match history (immutable):** on confirm, cancel, or dispute
  decision, one history row per participant is written
  (match id = room id, arena, team size, opponent user ids,
  date, result win/lose/cancelled, status, stake, payout where
  applicable). A user lists their own history (paginated,
  filterable by result/status); owner/admin/moderator can look
  a match up by its id. There is no edit/delete endpoint for
  history rows.
- **Permissions:** result submission is side-leader only;
  dispute viewing is participants + staff; dispute decisions
  are owner/admin only; report investigation is moderator+,
  report resolution (including bans) is owner/admin only;
  reputation penalties are owner/admin only. Every
  state-changing Part 5 action is audit-logged.
- **Money guard, unchanged:** `money_movement_enabled`,
  `paid_entry_enabled` and `withdrawals_enabled` remain
  `false` by default. Part 5 settles coin stakes inside the
  platform's coin ledger; it does not add a cash payout path.

## What Part 6 adds: referral system and fee preview/history

- **Referral codes:** every user gets a unique 8-character
  referral code (uppercase, unambiguous characters, no I/O/0/1),
  generated at signup and backfilled for users created before
  Part 6 (seed step on boot, plus lazy backfill on first
  dashboard use). `GET /referrals/me` returns the user's code
  and a link template `/signup?referral=CODE` — the base URL is
  configurable (`PUBLIC_BASE_URL`, falling back to `CORS_ORIGIN`
  or `http://localhost:3000`); Part 6 does **not** host a live
  signup URL, and the link must not be presented as one.
- **Attach once, never change:** a user with no referrer can
  attach one, either at signup (demo login and Google callback
  accept an optional `referralCode`) or via
  `POST /referrals/attach`. Validation: the code must exist,
  cannot be the user's own code (self-referral rejected), cannot
  attach if a referrer is already set (a second attach is 409
  and never overwrites), and cannot attach if referrer and
  invitee share the same MLBB ID when both are set. The
  `referrer_id`, `attached_at` and code used are stored
  immutably — there is no endpoint that changes them.
- **Direct-only, no multi-level:** commission is only for the
  direct referrer of a winning player, looked up from that
  player's `referrer_id` only — the chain is never traversed.
  If a referred player later refers someone else, the original
  referrer gets nothing from that second person's matches.
- **Commission rules, exactly:** calculated only after a match
  result is confirmed (auto-confirm or admin dispute decision),
  only if the referred player is on the winning side, only if
  the platform fee actually received for that match is greater
  than 0, and only from that fee — never as an extra deduction
  from the winner's payout. Amount =
  `floor(fee × referral_rate_percent / 100)`, using the rate
  snapshotted at room start (see below). **Worked example:**
  fee 1000 coins at 1% = 10 coins to the referrer, the admin
  keeps 990, and the winner's payout is unchanged by the
  commission. If the referred player loses, the fee is 0, or
  the match is cancelled, no commission is created.
- **Rate snapshot:** `referral.commission_percent` is
  owner-only (admins who are not owner get 403), default 1,
  validated as a number 0–100 (decimals allowed, e.g. 0.5, 1,
  2), and audit-logged on change. The rate in force when a
  room starts is snapshotted on the room (`referral_rate_snapshot`,
  like the Part 5 fee snapshot), so a rate change affects only
  rooms started after the change — including rooms whose
  dispute is decided later. Rooms started before Part 6 have no
  snapshot and fall back to the current rate at commission time.
- **Statuses and idempotency:** commission records are
  `pending`, `completed` or `cancelled`, with
  `UNIQUE (room_id, referrer_id)` — one referrer gets at most
  one commission per match, even if a result is corrected or
  re-confirmed (a re-confirm is a 409 in Part 5, and the
  commission layer also refuses a second credit). When a
  dispute opens, pending placeholders are created for the
  distinct direct referrers of **all** room participants
  (amount `null`, rate from the room snapshot), so the pending
  state is real. On a winner decision, each placeholder becomes
  completed (fee > 0 and an invitee of that referrer won, with
  a `referral_commission` wallet credit, idempotency key
  `room:<id>:referral:<referrerId>`) or cancelled. On a cancel
  decision, all placeholders cancel. On auto-confirm without a
  dispute, completed commissions are created directly for
  referrers of winner-side players (fee > 0 only). A completed
  commission is never recomputed or double-credited. If the
  computed amount is 0 (fee too small for the rate), the record
  is completed with amount 0 and no wallet credit is made.
  Commission completions/cancellations are audit-logged, and
  the credit goes through the wallet ledger like any other
  credit. Note on the fee: the platform fee ledger still
  records the gross fee; the commission is the part of that fee
  paid out to the referrer, so the platform retains
  fee − commission, and in wallet terms the referrer credit is
  the only payout from the fee (the fee itself is never
  credited to a player balance).
- **Referral dashboard (privacy-respecting):**
  `GET /referrals/me` returns the code, link template, total
  invites, total referral earnings, and a commission history
  (paginated, filterable by status) with room id, amount,
  status and timestamp. `GET /referrals/me/invitees` returns,
  for each directly referred user, **only** display name,
  number of matches won, total platform fee contributed by
  their wins, and total commission earned from them — never
  email, MLBB ID, server ID, wallet balance, or any other
  private field. Fee contributed is the full room fee for each
  room the invitee won (settlements are per room, not per
  player); it is not silently split across a team. A user can
  only view their own dashboard/invitees. The staff aggregate
  endpoint (`GET /referrals/admin/aggregate`, owner/admin
  only) returns counts and totals by status only — no invitee
  private fields at all.
- **Fraud protections:** self-referral rejected; same-MLBB-ID
  attach rejected; a match where a user appears on both sides
  is already impossible via Part 3/4 participant rules, and
  the settlement layer has a defensive guard
  (`participantsShareUser`) that skips all commissions for
  such a room — it is unit-tested with synthetic data.
  Commission records are immutable except for the
  pending → completed/cancelled transition, with no edit
  endpoint, and commission crediting is system-only: there is
  **no** public endpoint that can mint a commission.
- **Fee preview and history (on top of Part 5's per-arena
  fee):** `GET /fees/preview?arena=&stake=&participantCount=`
  (any authenticated user) returns the fee that would be
  charged using the current per-arena fee setting (percent:
  `floor(pot × pct / 100)`; fixed: `min(fixed, pot)` — the
  same math as Part 5 settlement), the distributable pot, and
  a per-winner payout preview. It is computed, never stored,
  and labelled as a preview; the actual settlement still uses
  the fee snapshot taken at room start.
  `GET /fees/history` (owner/admin only) returns
  `platform_fee_ledger` entries paginated, filterable by arena
  and date range (`from`/`to`), with room id, pot (via the
  settlement), fee and timestamp. Fee setting changes remain
  owner-only and audit-logged (Part 5 already enforces this;
  Part 6 verifies it and does not duplicate it in a
  conflicting way).
- **Money guard, unchanged:** `money_movement_enabled`,
  `paid_entry_enabled` and `withdrawals_enabled` remain
  `false` by default. Part 6 credits referral commissions
  inside the platform coin ledger only; it adds no cash payout
  path.
- **Bug fixed while building Part 6:** Part 5 settlement
  crashed (500) when the fee ate the whole pot, because it
  tried to credit a 0-coin winner payout and the wallet credit
  requires a positive amount. Settlement now skips the credit
  for a 0 payout (the 0 is still recorded in the settlement
  and the winner's locked stake is still consumed). This was
  found by the Part 6 "fee 500, pot 200" test case.

## What Part 7 adds: full profiles, friends, teams, tournaments, leaderboards

- **Full profiles:** the minimal profile from Parts 3–4 (display
  name, MLBB ID, server ID, rank) is extended with an avatar
  image upload: images only (png/jpeg/webp), max 2 MB, stored
  under gitignored `data/avatars/` with unique filenames, and
  served only to authenticated users via `GET /avatars/:id` —
  never public static. `GET /profiles/me` and
  `GET /profiles/:userId` return display name, avatar reference,
  MLBB ID, server ID, rank tier, reputation score and badge
  (from Part 5), computed stats and achievements — never email
  or any other private field. A user updates only their own
  display name and avatar (`PUT /profiles/me`,
  `POST /profiles/me/avatar`); staff cannot edit another user's
  profile except for bans (already in Part 5).
- **Profile stats, computed from `match_history`, never
  hand-edited:** total matches = wins + losses + cancelled;
  wins and losses as recorded; win rate = wins / (wins +
  losses), or `null` when wins + losses is 0; current win
  streak (walking backwards through chronological history,
  skipping cancelled rows) and best win streak (walking
  forwards, a loss resets, cancelled rows neither count nor
  break a streak). Tournament wins are counted separately
  (see below), not inside these match stats.
- **Achievements, derived on read, not free-text claims:**
  tournament champion badges (tournament id, name, date);
  win-streak badges for a 5-win and a 10-win streak reached
  (date = the history row where the streak first reached that
  length); and a reputation Trusted badge when the score is
  ≥ 90.
- **Friends:** send a request (`POST /friends/requests`,
  cannot friend yourself, and cannot duplicate a pending or
  accepted friendship in either direction), accept or reject a
  received request, list friends, remove a friend, and list
  incoming/outgoing pending requests. Friendship is mutual
  after accept. Friends' profiles are viewable via the same
  public profile fields as above — no private fields.
- **Teams:** create a team with a unique name, max **5 members
  including the leader** (teams are for 2v2–5v5); logo upload
  with the same image rules as avatars, under
  `data/team-logos/`, served via `GET /team-logos/:id` to
  authenticated users only. Leader invite system: the leader
  invites a user, the invitee accepts or rejects, duplicate
  pending invites are rejected, and a user cannot be in more
  than one team at a time in Part 7 (a documented
  simplification, since multi-team membership is not in the
  spec and would complicate tournament registration). Member
  list with leader/member roles; the leader can remove a
  member; a member can leave; if the leader leaves, the team
  transfers to the earliest-joined remaining member; if no
  members remain, the team (with its members and invites) is
  deleted. Team detail returns name, logo reference, leader,
  members with their profile display fields, and team
  tournament wins.
- **Match-room team add (the only match-room change in
  Part 7):** a side leader in a match room can add their whole
  team to their side in one call
  (`POST /match-rooms/:id/roster/team/:teamId`), respecting the
  Part 4 side limit (side count + new members ≤ team size) and
  lock rules (each added member's stake is locked via Part 2,
  exactly as in a Part 4 roster add). The caller must be both
  the room side leader and the team leader; a second add adds
  nobody and does not double-lock.
- **Tournaments (owner/admin only to create, edit, start or
  cancel):** name, banner image upload (same image rules,
  under `data/tournament-banners/`, served via
  `GET /tournaments/:id/banner` to authenticated users),
  prize description text, prize coins (non-negative integer,
  0 = no coin prize), rules text, registration window
  (`registration_start`, `registration_end`), start time, team
  size mode (solo, or a team size 1v1/2v2/3v3/4v4/5v5), and
  optional max registrants (positive integer). Status flow:
  draft → registration_open → ongoing → completed, plus
  cancelled (admin can cancel only before start, with audit;
  cancelling after start is rejected). Validation:
  `registration_start` < `registration_end` < `start_time`,
  and solo mode requires team size 1v1 while team mode
  requires 2v2–5v5. Edit is draft-only and re-validates the
  merged tournament. Opening registration is a manual
  owner/admin action and does not by itself check the window;
  starting is also manual (it does not enforce that
  `start_time` has been reached — `start_time` is the
  scheduled time) and requires status `registration_open` and
  at least 2 registrants.
- **Tournament registration:** while status is
  `registration_open` **and** server time is inside the
  registration window **and** before `start_time`, a solo
  tournament accepts individual players and a team tournament
  accepts teams (caller must be the team leader, team member
  count must equal the tournament team size exactly — e.g. a
  3v3 tournament requires exactly 3 members — and a player
  already registered via another team cannot register a second
  team). Duplicate registration (same player or same team) is
  409, registration after the window or after start is 409,
  and a player/team can cancel their registration before
  start (only while `registration_open`, by the player or the
  team leader). Max registrants, when set, is enforced
  against registered (not cancelled) registrations. The
  registration list is viewable by authenticated users with
  display fields only.
- **Bracket (honest scope):** on start with at least 2
  registrants, a single-elimination bracket is generated.
  Total rounds = ceil(log2(n)); byes = 2^rounds − n; the first
  `byes` participants (registration order) are placed directly
  into round 2, and the remaining participants play round-1
  (play-in) matches paired sequentially. Later rounds feed by
  slot (ceil(slot/2)) from the previous round's matches. A
  bracket match is `pending` until both participants are
  known, `ongoing` once it can be played, and `completed`
  once a winner is recorded. **Bracket matches are tournament
  records, not regular match rooms in Part 7: tournament
  matches are played in-game and their results are recorded
  by staff; they are not auto-created match rooms. That
  integration is future work, not claimed in Part 7.**
  Owner/admin/moderator records a bracket match winner (with
  a mandatory reason, audit-logged); the winner must be one
  of the match's participants, an already-completed match is
  409, and a match without both participants is 409. The
  winner advances automatically to the next round slot (which
  becomes `ongoing` once both participants are known); the
  final winner completes the tournament. Bracket view returns
  rounds, matches, participants (display fields only), winners
  and current status — the live bracket view from the spec.
- **Tournament prizes and badges:** on completion, the
  champion (solo player or team) receives a tournament
  champion achievement/badge, and if prize coins > 0, the
  prize is credited via the wallet ledger as
  `tournament_prize`: solo — the full amount to the winner;
  team — split equally among team members, integer division
  with the remainder to the leader (the same remainder rule
  as Part 5 settlement). Crediting is atomic and idempotent
  per tournament (idempotency key
  `tournament:<id>:prize:<userId>`; a second winner recording
  for the completed final match is rejected, so there is no
  second payment). Tournament wins count toward the champion's
  profile tournament-wins count and toward team wins. Prize
  crediting is system-only on completion; there is no public
  endpoint that can mint a prize.
- **Leaderboards (`GET /leaderboards?category=&period=&limit=&offset=`,
  authenticated, paginated):** computed from real data, never
  hand-edited. Categories: `top_player` (most wins in the
  period, tie-break win rate then earliest win then user id)
  and `most_wins` (shares the same win-count ranking as
  `top_player` and differs only in label — documented, not
  hidden); `highest_win_streak` (best streak achieved in the
  period, from `match_history` in chronological order, loss
  resets, cancelled skipped, then wins desc, then user id);
  `top_team` (tournament wins desc, then bracket match wins
  desc, then team id); `tournament_champion` (completed
  tournaments in the period, most recent first). Periods are
  computed from server time: daily = current calendar day
  UTC, weekly = last 7 days, monthly = current calendar month
  UTC, all_time = all rows. Entries return display fields
  only (name, avatar reference, wins, win rate, streak,
  tournament wins as applicable) — never email, MLBB ID,
  server ID, or balances.
- **Permissions and audit:** profile/avatar updates are
  self-only; friend/team/tournament actions follow the rules
  above; tournament create/start/cancel are owner/admin, and
  bracket winner recording is owner/admin/moderator; all
  state-changing actions are audit-logged. Teams and
  tournaments cannot be edited by non-leaders/non-staff
  respectively.
- **Money guard, unchanged:** `money_movement_enabled`,
  `paid_entry_enabled` and `withdrawals_enabled` remain
  `false` by default. Part 7 credits tournament prizes inside
  the platform coin ledger only; it adds no cash payout path.

## What is explicitly NOT yet built (Part 9)

Part 8 is built (see "What Part 8 adds" above). Still not built:
PWA installability, mobile/tablet/desktop responsive polish,
full UI polish (including real browser WebRTC voice audio,
neon-glow buttons, smooth animations), the Myanmar/English
language-switch frontend, and push notifications. Part 8 provides
the APIs Part 9 will use (site config, banners, announcements,
notification-centre persistence). Do not treat any Part 9 item as
working.

## Run locally

Requirements: Node.js 20+.

```bash
cd ~/workspace/mlbb-new-platform
npm install
cp .env.example .env   # optional; defaults work locally without Google keys
npm start
# -> http://localhost:3000  (landing page, dark premium theme)
```

Database: SQLite at `./data/app.sqlite` by default (override with
`DB_PATH`). Migrations in `src/db/migrations/` run automatically on
startup and are tracked in `schema_migrations`. Routes use the
repository layer in `src/db/repos/` only — no route contains SQL — so
PostgreSQL can replace SQLite later by replacing the adapter in
`src/db/index.js` without rewriting routes.

Google login (when keys are ready — not required for Part 1 testing):

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback \
npm start
# then visit GET /auth/google
```

Without those variables, `GET /auth/google` returns 503 with a clear
message instead of pretending login works.

## Demo login (local testing only)

```bash
curl -X POST http://localhost:3000/auth/demo \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@test.local","role":"owner"}'
# -> {"token":"...","user":{...},"demo":true,...}
curl http://localhost:3000/auth/me -H 'Authorization: Bearer <token>'
curl http://localhost:3000/admin/settings -H 'Authorization: Bearer <token>'
```

Roles for demo login: `owner`, `admin`, `moderator`, `support`, `player`.
In production this endpoint returns 403.

## Key endpoints

| Method | Path | Who |
| --- | --- | --- |
| GET | `/health` | anyone |
| GET | `/auth/google`, `/auth/google/callback` | anyone (503 if unconfigured) |
| POST | `/auth/demo` | anyone, non-production only |
| POST | `/auth/2fa/verify` | 2FA challenge holder |
| GET | `/auth/me` | authenticated user |
| POST | `/auth/logout` | authenticated user |
| POST | `/auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable` | staff, self only |
| GET | `/admin/settings` | owner, admin |
| PUT | `/admin/settings/:key` | general: owner/admin; fee/wallet/legal: owner only |
| GET | `/admin/users`, `/admin/users/:id` | owner, admin, moderator, support |
| PUT | `/admin/users/:id/role` | owner only |
| POST | `/admin/users/:id/ban`, `/admin/users/:id/unban` | owner, admin, moderator |
| GET | `/admin/audit-log` | owner, admin |
| GET | `/wallet/me`, `/wallet/me/history?type=&limit=&offset=` | own user (self-scoped) |
| GET | `/wallet/me/purchases` | own user (self-scoped) |
| GET | `/wallet/packages` | any authenticated user (active only) |
| POST | `/wallet/purchases` | own user: `{packageId}` or `{customCoins}` |
| GET | `/wallet/users/:id`, `/wallet/users/:id/history` | owner, admin |
| GET | `/wallet/purchases?userId=&status=` | owner, admin |
| POST | `/wallet/users/:id/adjust` | owner only: `{amount, reason, idempotencyKey?}` |
| POST | `/wallet/packages` | owner, admin |
| PUT | `/wallet/packages/:id` | owner, admin |
| POST | `/wallet/purchases/:id/decision` | owner, admin: `{decision: approve\|reject, reason?}` (reason mandatory for reject) |
| PUT | `/admin/settings/wallet.custom_min_coins` etc. | owner only |
| POST | `/challenges` | authenticated player: arena, teamSize, stake, heroRule, requiredHero?, heroBans?, customRules?, rankRestriction? |
| GET | `/challenges?arena=&teamSize=&heroRule=&coin=&coinMin=&coinMax=&rankTier=&since=&limit=&offset=` | authenticated user |
| GET | `/challenges/:id` | authenticated user (full rules, participants, match room once matched) |
| POST | `/challenges/:id/accept` | authenticated player, not the creator (atomic lock of both stakes) |
| POST | `/challenges/:id/cancel` | creator only, while open |
| POST | `/challenges/favorites` | own player |
| GET | `/challenges/favorites` | own player only |
| DELETE | `/challenges/favorites/:id` | own player only |
| POST | `/challenges/from-favorite` | own player: `{favoriteId, stake, overrides?}` |
| GET | `/challenges/hero-restrictions` | authenticated user (active only) |
| POST | `/challenges/hero-restrictions` | owner, admin |
| PUT | `/challenges/hero-restrictions/:id` | owner, admin |
| PUT | `/profile/rank` | self only: `{rankTier}` or `null` |
| PUT | `/profile/game-ids` | self only: `{mlbbId, serverId}` (digits: 5–12 / 3–6, or `null` to clear) |
| GET | `/match-rooms/:id` | participant, or owner/admin/moderator read-only |
| GET | `/match-rooms/:id/reconnect` | participant (room + chat + voice + server timer in one call) |
| POST | `/match-rooms/:id/roster` | side leader only: `{userId}` (locks that member's stake) |
| DELETE | `/match-rooms/:id/roster/:userId` | side leader only, own side, members only (refunds) |
| POST | `/match-rooms/:id/leave` | participant, before start (leader leave cancels with refunds) |
| POST | `/match-rooms/:id/ready` | participant only, while waiting: `{ready: boolean}` |
| POST | `/match-rooms/:id/chat` | participant only: `{text}` (1–1000 chars) |
| GET | `/match-rooms/:id/chat?order=&limit=&offset=` | participant, or staff read-only |
| POST | `/match-rooms/:id/voice/join`, `/voice/leave` | participant only (signalling session, no audio) |
| POST | `/match-rooms/:id/voice/signal` | participant only: `{toUserId?, kind, payload}` |
| GET | `/match-rooms/:id/voice/signals?afterId=` | participant only |
| GET | `/match-rooms/:id/voice` | participant, or staff read-only |
| GET | `/notifications/unread`, `/notifications` | own user only (full centre: category + read filters, see Part 8) |
| GET | `/notifications/unread-count` | own user only |
| POST | `/notifications/read-all`, `/notifications/:id/read` | own user only |
| PUT | `/admin/settings/match.countdown_seconds`, `match.ready_timeout_seconds` | owner/admin (general settings; defaults 10 / 300) |
| POST | `/match-rooms/:id/results` | side leader only, after the 5-minute window: `{outcome: win\|lose, reason?}` + optional `evidence` files |
| GET | `/match-rooms/:id/results` | participant, or staff read-only (with evidence listed) |
| GET | `/match-rooms/:id/dispute` | participant, or staff read-only |
| GET | `/disputes`, `/disputes/:id` | owner/admin/moderator (list filterable by status) |
| POST | `/disputes/:id/notes` | owner/admin/moderator |
| POST | `/disputes/:id/evidence` | participant or staff (max 3 files per dispute) |
| POST | `/disputes/:id/decision` | owner/admin only: `{decision: winner\|cancel, winnerSide?, reason}` (reason mandatory) |
| GET | `/evidence/:id` | participant/staff (room evidence) or reporter/staff (report evidence) — never public |
| GET | `/reputation/me`, `/reputation/:userId`, `/reputation/:userId/events` | self or staff |
| POST | `/reputation/:userId/penalty` | owner/admin only: `{points: 1–100, reason}` |
| POST | `/reports` | any player: `{reportedUserId, category, reason, roomId?}` + optional `evidence` files |
| GET | `/reports`, `/reports/:id` | staff (all) or reporter (own only) |
| POST | `/reports/:id/investigate` | owner/admin/moderator: `{note?}` |
| POST | `/reports/:id/resolve` | owner/admin only: `{resolution, action: none\|warning\|temp_ban\|permanent_ban, tempBanUntil?}` |
| GET | `/match-history/mine` | own user (filterable by result/status) |
| GET | `/match-history/:id` | owner/admin/moderator (lookup by match id) |
| PUT | `/admin/settings/fee.1v1`, `fee.Classic`, `fee.Brawl` | owner only: `{type: percent\|fixed, value}` (default percent 0) |
| PUT | `/admin/settings/match.result_window_seconds` | owner/admin (default 300; production should keep 300) |
| GET | `/referrals/me` | own user only: code, link template, total invites/earnings, commission history (filterable by status) |
| GET | `/referrals/me/invitees` | own user only: display name, matches won, fee contributed, commission earned per invitee — no private fields |
| POST | `/referrals/attach` | self only: `{referralCode}` (attach once, never overwrite) |
| GET | `/referrals/admin/aggregate` | owner/admin only: counts and totals by status, no private fields |
| PUT | `/admin/settings/referral.commission_percent` | owner only: number 0–100, default 1, snapshotted at room start |
| GET | `/fees/preview?arena=&stake=&participantCount=` | any authenticated user: computed preview only, nothing stored |
| GET | `/fees/history?arena=&from=&to=` | owner/admin only: platform fee ledger, paginated |
| GET | `/profiles/me`, `/profiles/:userId` | authenticated user: display fields, reputation, stats, achievements — no private fields |
| PUT | `/profiles/me` | self only: `{displayName}` |
| POST | `/profiles/me/avatar` | self only: image file `avatar` (png/jpeg/webp, max 2 MB) |
| GET | `/avatars/:id` | authenticated user only (never public static) |
| POST | `/friends/requests` | authenticated player: `{userId}` (no self, no duplicate in either direction) |
| GET | `/friends`, `/friends/requests/incoming`, `/friends/requests/outgoing` | own user only |
| POST | `/friends/requests/:id/accept`, `/friends/requests/:id/reject` | recipient only |
| DELETE | `/friends/:userId` | own user only (accepted friendship) |
| POST | `/teams` | authenticated player: `{name}` (unique, max 5 members incl. leader, one team per user) |
| GET | `/teams/:id` | authenticated user: name, logo, leader, members (display fields), team tournament wins |
| POST | `/teams/:id/logo` | team leader only: image file `logo` (png/jpeg/webp, max 2 MB) |
| GET | `/team-logos/:id` | authenticated user only |
| POST | `/teams/:id/invites` | team leader only: `{userId}` (no duplicate pending invite) |
| POST | `/teams/:id/invites/:inviteId/accept`, `/teams/:id/invites/:inviteId/reject` | invitee only |
| DELETE | `/teams/:id/members/:userId` | team leader only (removes a member) |
| POST | `/teams/:id/leave` | member only (leader leave transfers to earliest-joined member; empty team is deleted) |
| POST | `/match-rooms/:id/roster/team/:teamId` | room side leader + team leader only: adds whole team, locks each member's stake |
| POST | `/tournaments` | owner/admin: name, banner?, prizeDescription, prizeCoins, rules, registrationStart/End, startTime, mode, teamSize, maxRegistrants? |
| GET | `/tournaments`, `/tournaments/:id` | authenticated user |
| PUT | `/tournaments/:id` | owner/admin, draft only |
| POST | `/tournaments/:id/banner` | owner/admin: image file `banner` (png/jpeg/webp, max 2 MB) |
| GET | `/tournaments/:id/banner` | authenticated user only |
| POST | `/tournaments/:id/open-registration`, `/tournaments/:id/cancel` | owner/admin (cancel only before start) |
| POST | `/tournaments/:id/start` | owner/admin: registration_open + ≥2 registrants → bracket generated |
| POST | `/tournaments/:id/register` | authenticated player/team leader: `{}` (solo) or `{type: team, teamId}` |
| GET | `/tournaments/:id/registrations` | authenticated user (display fields only) |
| POST | `/tournaments/:id/registrations/:registrationId/cancel` | player or team leader, before start |
| GET | `/tournaments/:id/bracket` | authenticated user: rounds, matches, participants (display fields), winners, status |
| POST | `/tournaments/:id/bracket-matches/:matchId/winner` | owner/admin/moderator: `{winnerType: player\|team, winnerId, reason}` (reason mandatory) |
| GET | `/leaderboards?category=&period=&limit=&offset=` | authenticated user: display fields only, paginated |

## Tests

```bash
npm test
```

Tests use a throwaway SQLite file under `/tmp`, never the real data
directory. Part 1 tests cover: health, demo login, validation, bot
honeypot, unauthenticated denial, player denial of all admin routes,
settings defaults (legal record + money disabled), owner
general-setting change with audit, moderator denial of fee/wallet
settings, owner money-on rejection, unknown-setting rejection,
owner-only role changes with audit, moderator ban/unban with
banned-login rejection, full 2FA setup/enable/challenge/wrong-code/
disable flow, logout revocation, audit visibility, and demo-login
disabled in production. Part 2 tests (`tests/part2.test.js`) cover:
balance never negative, idempotent credit, purchase request →
approve credits once → re-approve rejected, purchase reject leaves
balance unchanged, custom amount validation (zero, negative, over
max), package edit does not change a completed purchase snapshot,
lock → locked rises and available falls → unlock restores → lock
more than available rejected → refund path restores, owner-only
adjustment with reason, player cannot view another player's
wallet/history, admin cannot directly adjust, wallet settings are
owner-only and bound custom amounts, and the Part 1 money guard
still holds. Part 3 tests (`tests/part3.test.js`) cover:
creation validation (1v1 arena with 5v5, invalid hero rule,
invalid stake, duplicate bans), rank restriction (creator-rank
requirement, same-rank pass/fail, unset-rank rejection, range
pass/fail, inverted range), admin restriction conflicts
(ban-allowed rejection, require-banned rejection, duplicate
active rule, deactivation lifting the ban, player cannot manage),
favorites (save/list privately/use with overrides/delete and
another player's favorite), board filters (arena, team size,
hero rule, coin min/max, exact coin, since) and detail view,
accept locking both stakes and creating a match-room record,
double-accept failing with no double lock, self-accept and
insufficient-balance accept failing with no lock, and cancel
(open succeeds, matched rejected, non-creator forbidden). Part 4
tests (`tests/part4.test.js`) cover: room detail ID/rank display
and non-participant blocking with staff read-only limits, game-ID
validation, roster add/remove limits and leader-only rules with
removal refunds, chat history and reconnect preservation, voice
signalling participant-only relay, ready/un-ready, countdown only
when the roster is full and all are ready (including the 5v5
incomplete-roster case naming missing counts), server-timer
stability across re-fetch, ready-timeout cancel with refunds of
both stakes, leader-leave cancel with refunds, member leave,
cancel-after-start rejection, and notification records on
ready/start/cancel. Part 5 tests (`tests/part5.test.js`) cover:
submission before start and before the window (with the window
named in the error), non-leader rejection and double-submission
rejection, matching settlement (pot, fee 0 by default, equal
split, loser consumed, no double settlement), fee snapshot at
start used even after a fee change, with the remainder going to
the first winner, mismatching submissions opening a dispute
with coins still locked, moderator decision forbidden and
owner winner decision settling with a −20 reputation penalty
on the false side, admin cancel decision refunding both stakes
with cancelled history, evidence upload (images accepted,
non-images and oversize rejected, download restricted to
participants/staff, dispute evidence capped at 3 files),
reputation penalties and badge thresholds, reports (case-id
format, self-report rejection, investigate vs resolve
permissions, warning count, temp ban blocking login until
expiry and then allowing it again, permanent ban), and match
history entries on confirm with staff lookup by match id.
Part 7 tests (`tests/part7.test.js`) cover: profile stats
computed from history (including win rate `null` at 0 matches,
current and best streak, and streak-badge dates at 5 and 10
wins), avatar upload validation (non-image and oversize
rejected, self-only update), friend request/accept/duplicate/
self/reject/remove, team create/invite/accept/remove/leave/
leader-transfer/delete-when-empty and the one-team-only rule,
team roster add to a match room respecting side limits and
stake locks (including no double-lock on a second add and
non-leader team member rejection), tournament create
validation (bad windows, solo with 5v5, non-owner rejection),
draft-only edit, registration (solo duplicate, cancel,
future-window rejection, 3v3 team-size mismatch), bracket
even (4 players: round 1 = 2 matches, round 2 = 1 final,
advancement, final completion, solo prize 100, champion badge,
tournament wins = 1, second winner recording rejected) and odd
(3 players: bye seed in round 2, play-in winner fills the
other slot, final completes), team prize split (3v3, prize 100
→ leader 34, others 33, loser 0, no double pay, top_team entry
with tournamentWins = 1), leaderboards (all five categories,
daily/monthly/all_time, privacy — no email in entries,
tie-break ordering, unauthenticated rejection), and
tournament banner upload validation and cancel/start-after-
cancel rules. Part 8 tests (`tests/part8.test.js`) cover:
site-config read/change permissions and banner active filtering
(two active banners returned, an inactive one not, plus logo-style
image serving and colour validation), announcement active-window
filtering (expired announcements excluded, live ones returned,
player creation rejected), terms versioning (version increments,
old version body unchanged, re-accept returns the same agreement
record) and the agreement gate (off by default so accept works,
on blocks accept with 403 until the accepter accepts the current
match_rules version), statistics matching real counts (open
challenges rising by exactly one after a challenge is created),
notification filters/read/mark-all and tap-through targets
(match, tournament and dispute targets), a referral-commission
notification on a fee-bearing win (fee 1000 at 1% = 10 to the
referrer), Telegram test without a token returning 503, the
two-step announce flow (wrong code 400, unconfirmed stays
pending, correct code publishes a site announcement), the
webhook admin-chat-only restriction, maintenance blocking player
challenge creation but not admin routes or a started room,
emergency blocking purchases/accepts/attaches and pausing
referral crediting (pending, not completed) while result flows
continue, backup create/list/download and the absence of a
restore endpoint (404), health returning real counts with
`status: 'ok'`, the sweeper cancelling an expired ready room
with refunds, help articles (unpublished invisible to players)
and ticket thread/status permissions (reporter + staff only,
player reopen 403, staff reopen without a reason 400), and
suspicious groups (two users sharing an MLBB ID listed, both
still `active` — no auto-ban).

## What Part 8 adds: no-code site control, Telegram, notifications, maintenance/emergency, backups, health, sweeper, help, suspicious review

### No-code site control (owner/admin to change, any authenticated user to read)

- `GET /site-config` (any authenticated user) returns the public
  config: `buttonColor`, `backgroundColor`, `homepageText` and
  `logoPath`. `PUT /site-config` (owner/admin, permission
  `site.manage`) changes colours (validated as `#RRGGBB`) and
  homepage text; every change is audit-logged. No code change is
  needed to change any of these.
- Logo: `POST /site-config/logo` uploads an image (owner/admin);
  `GET /site-logo` serves it only when the stored path resolves
  under `data/`, so a client-supplied path can never be served.
- Homepage banners: `POST /site-banners` (image upload, title,
  `sortOrder`), `PUT /site-banners/:id` (activate/deactivate,
  order, title), `GET /site-banners` (staff list),
  `GET /site-banners/active` (public, any authenticated user).
  The active endpoint shuffles the active banners with a
  Fisher-Yates shuffle **per request** — that is per-request
  random order, not a stored slideshow. `GET /site-banners/:id/image`
  serves a banner image to authenticated users.
- Announcements: `POST /site-announcements` and
  `PUT /site-announcements/:id` (owner/admin) take text, language
  `mm` or `en`, an active flag, and optional start/end times.
  `GET /site-announcements/active` returns only announcements
  that are active **and** inside their start/end window at server
  time; `GET /site-announcements` is the staff list.

### Global match rules and terms, versioned, with an agreement gate

- `POST /documents` (owner/admin) creates a document of type
  `terms`, `privacy` or `match_rules` with a title and body. The
  version is auto-incremented per type (first = 1) and an old
  version is never edited in place — a new version is created
  instead. `GET /documents/:type` lists all versions,
  `GET /documents/current/:type` returns the latest.
- `POST /agreements/accept {documentId}` records an immutable
  agreement (one row per user + document, timestamped;
  re-accepting returns the existing record, it does not duplicate
  it). `GET /agreements/me` lists the caller's agreements.
- Setting `agreement_required` (default `false`, owner-only —
  it maps to the fee/wallet permission). When off, existing flows
  are unchanged, which is why Part 1–7 tests keep passing. When
  on, challenge accept requires the accepter to have accepted the
  current `match_rules` version, and otherwise fails with 403 and
  a clear message, before any coin lock. If no `match_rules`
  document exists yet, the gate does not block.

### Website statistics (owner/admin, computed from real data, never fake)

`GET /admin/stats` returns one payload with a timestamp:
`totalUsers`, `activeUsersLast15Min`, `openChallenges`,
`activeRoomsByStatus`, `pendingDisputes`, `pendingReports`,
`totalPlatformFee` (from `platform_fee_ledger`),
`totalReferralCommissions` (completed only), `totalTournaments`,
`tournamentsByStatus`, and `totalWalletBalances` (sum of
available + locked across all wallets).
Definition: "active in the last 15 minutes" means distinct users
with a non-revoked, unexpired session **created** in the last 15
minutes. Sessions carry no heartbeat or last-activity field, so
this is login-based activity, not live presence — documented
here so it is not mistaken for a presence count.

### Full notification centre (persistence, not push)

Notifications from earlier parts plus new ones for tournament
start (`tournament_started`), dispute resolved
(`dispute_decided`), referral commission received
(`referral_commission_received`) and announcements
(`announcement`, `emergency_mode`). Categories are `match`,
`tournament`, `dispute`, `referral` and `announcement`.
- `GET /notifications?category=&read=` — own list, paginated,
  filtered by category and read/unread.
- `GET /notifications/unread-count` — own unread count.
- `POST /notifications/:id/read` and `POST /notifications/read-all`
  — own notifications only (the read-all route is registered
  before the `:id` route so it is not captured as an ID).
- Every notification carries a tap-through `target`:
  `{type: 'match_room'|'tournament'|'dispute', id}` where
  applicable, otherwise `{type: null, id: null}`. Staff cannot
  read another user's notifications.
- Delivery while offline is by persistence + fetch on return:
  notifications live in the database, so a player whose phone was
  off sees them on the next fetch. Push notification is Part 9
  PWA work and is not claimed here.

### Telegram bot link (honest scope — no token is invented)

Setup requires a bot token from BotFather, an admin chat ID and a
webhook secret, supplied by the owner when online. None is
configured in this codebase, and no token has been invented.
- `POST /admin/telegram/config` (owner only) stores the token
  and webhook secret encrypted at rest with the existing crypto
  helper; `GET /admin/telegram/config` returns only
  `configured`, `adminChatId` and `webhookConfigured` — never
  the token.
- `POST /admin/telegram/test` (owner only) sends a test message
  to the configured admin chat via the Telegram Bot API
  (`fetch` to `api.telegram.org`). With no token or no admin chat
  it returns a clear 503, not a fake success; on API failure it
  returns 502 and records the failure.
- `GET /admin/telegram/stats` (owner/admin) returns the same
  statistics payload as `GET /admin/stats` in the shape a bot
  message would use (`formatStatsMessage`); it is testable
  without a token.
- `POST /admin/telegram/announce` (owner/admin) creates a
  **pending** announcement and returns a 6-digit confirmation
  code. `POST /admin/telegram/announce/:id/confirm
  {confirmationCode}` publishes it: a site announcement is
  created (visible via `/site-announcements/active`), and a
  Telegram send is attempted only if a token and admin chat are
  configured, recording `telegramStatus` as `sent`, `failed` or
  `not_configured` per channel. A wrong code returns 400 and the
  announcement stays pending; confirming an already-confirmed
  announcement returns 409.
- `POST /telegram/webhook` is verified by the webhook secret
  (header `x-telegram-bot-api-secret-token` or `?secret=` query);
  a missing or wrong secret returns 403. It handles `/stats`,
  `/matches` and `/reports` using the real statistics, but only
  for the configured admin chat ID — any other chat receives
  only a generic refusal and no counts. With no token configured
  the webhook still accepts and logs the command shape for
  testing but reports `delivery: 'not_configured'` and does not
  claim delivery. The webhook route is defined before
  `authenticate()` inside the Part 8 router, and the Part 8
  router is mounted before the other `/` routers in `app.js`,
  because those routers authenticate every request they see and
  would otherwise 401 the webhook before it could reach Part 8.
- Until a real token is supplied, the bot is **not live**: do not
  claim otherwise.

### Maintenance mode (owner-only)

`POST /admin/maintenance {enabled, message?, reason, confirm?}`.
Enabling requires a mandatory reason and message; disabling
requires a reason. When enabled, non-admin POSTs to new
challenges, challenge accepts, wallet purchases, tournament
registrations and referral attaches return 503 with the
maintenance message. Admin routes and existing started match
rooms remain accessible to their participants, so active matches
are not destroyed. Enabling first returns the count of active
matches (waiting/countdown/started rooms): if active matches
exist and `confirm !== true`, the endpoint returns 409 with
`activeMatchCount` and `requiresConfirm: true` instead of
enabling. Enabling with a message also creates a site
announcement with that message. All changes are audit-logged.

### Emergency mode (owner-only, independent of maintenance)

`POST /admin/emergency {enabled, reason, confirm?}`. Enabling
requires a mandatory reason and `confirm=true` (without it,
409 with `requiresConfirm: true`). When enabled, new challenge
creation, challenge accepts, wallet purchases, wallet
adjustments and referral processing are paused with 503 —
referral attaches are blocked by the app-level guard, and
commission crediting is paused inside the referrals service:
commissions that would have completed during emergency stay
`pending` (their amount is computed but no wallet credit is
made) and there is no automatic retry in Part 8; they remain
pending for owner review. Commissions already completed stay
completed. Existing match rooms and result/dispute flows
continue, so active data is not lost. Enabling creates a site
announcement and a notification to every user. Emergency and
maintenance are independent flags: either flag blocks the
endpoints it covers, and disabling one does not disable the
other. All changes are audit-logged.

### Database backup (owner-only; no API restore by design)

- `POST /admin/backups` creates a timestamped copy of the
  SQLite database under gitignored `data/backups/` using
  `VACUUM INTO`, and records a manifest row: backup file,
  timestamp, and a note that the evidence, avatar, banner,
  team-logo and tournament-banner directories are **not** inside
  the database file and must be backed up as files separately.
- `GET /admin/backups` lists backups; `GET /admin/backups/:id/download`
  downloads one (owner only, path checked to stay under
  `data/backups/`).
- There is **no** restore endpoint, deliberately (too dangerous
  to expose over an API). Manual restore: stop the server,
  replace the database file with the backup file, restart.
  Backups are never created automatically in Part 8; a scheduled
  backup is future work.

### System health monitoring (owner/admin)

`GET /admin/health` returns server uptime, database reachable
status, counts of users/rooms/disputes/reports, pending
disputes/reports, last backup time (or `null` when no backup
exists), and the maintenance/emergency flags. The derived
`status` is `ok` when the database is reachable and `degraded`
when it is not — that is the whole rule; no other metrics are
invented.

### Scheduled sweeper (manual endpoint, not a cron)

`POST /admin/sweep` (owner only) runs the deterministic sweeper
once and returns counts: rooms checked, rooms cancelled by
ready-timeout (with refunds, using Part 4's refresh logic),
rooms started by countdown, and expired result windows flagged.
Expired result windows are flagged only — the sweeper does not
change their state. Part 8 provides this manual endpoint, not an
automatic cron; a cron schedule is a deployment decision, not
Part 8 code.

### Help centre and support tickets

- Help articles: `POST /help-articles` and
  `PUT /help-articles/:id` (owner/admin) take category
  (`match_rules`, `account`, `technical`, `dispute_process`,
  `other`), title, body and a `published` flag.
  `GET /help-articles` returns published articles to players
  and all articles to staff; `GET /help-articles/:id` reads one
  (unpublished articles are staff-only).
- Support tickets: `POST /tickets` (player: subject, category,
  message). `GET /tickets/:id` and `POST /tickets/:id/messages`
  are for the reporter and staff only (support/moderator/admin/
  owner); other players get 403. Messages on a closed ticket are
  rejected. Status flow is open → in_progress → resolved →
  closed: the player can close their own ticket, staff can
  resolve/close, and reopening is staff-only with a mandatory
  reason (player reopen = 403, staff reopen without a reason =
  400). Tickets are private to the reporter and staff.

### Suspicious-account review (no auto-ban)

`GET /admin/suspicious` (owner/admin) lists suspicious groups
computed from real data, each with user display fields only
and the reason:
- `shared_mlbb_id`: two or more users with the same MLBB ID.
- `self_referral`: a user whose own referral code is recorded
  as their referrer (defensive — this should be impossible).
- `high_disputes_or_reports`: a user with 3 or more
  `dispute_false_submission` reputation events and/or resolved
  report actions in the last 30 days (combined per user).
The threshold is 3+ in the last 30 days. Suspicion alone never
bans anyone and the endpoint performs no ban action: staff must
review and act via the existing Part 5 ban endpoints, which are
audit-logged.

### Permissions and audit (Part 8)

Maintenance, emergency, backup and sweep are owner-only.
Statistics, health and suspicious review are owner/admin.
Help articles are owner/admin to write, players to read.
Tickets are reporter + staff. Every state-changing Part 8
action is audit-logged. New permissions seeded in Part 8:
`site.manage`, `stats.view`, `health.view`, `suspicious.view`,
`backups.manage`, `sweep.run`, `help.manage`, `telegram.manage`
(owner; admin gets all except `backups.manage` and
`sweep.run`).

## What Part 9 adds: PWA, full working UI, Myanmar/English switch (final part)

### Run the full app

```bash
cd ~/workspace/mlbb-new-platform
npm install
npm start
# -> http://localhost:3000
```

`npm start` serves the backend and the single-page frontend together;
there is no frontend build step. Log in with Google (when keys are
configured) or, outside production only, the demo login form in the
UI. The demo login is disabled when `NODE_ENV=production`.

### Backend additions (Part 9 only)

- `GET /home` (authenticated): real counts only — open challenges,
  active match rooms, completed (finished) match rooms, the next
  upcoming tournament (id, name, start time, prize, mode, team size,
  status), and top players from the Part 7 leaderboard (display
  fields only). No staff statistics, no email, no wallet balances.
- `GET /search?q=` (authenticated, 1–100 characters): players by
  display name or MLBB ID, challenges by id or arena, tournaments by
  name — display fields only, never email, wallet balances, or
  private IDs beyond the MLBB/server IDs that are already
  room-display fields (Part 4). Unauthenticated search is 401.
- Health now reports `part: 9` with `moneyMovementEnabled: false`.

### PWA

- `public/manifest.json`: name/short name "Match Arena", display
  `standalone`, theme/background `#0b1020`, and two original icons
  (`/icons/icon-192.svg`, `/icons/icon-512.svg`) drawn locally as
  simple "MA" marks — no official logos or art are copied.
- `public/sw.js` (`match-arena-v1`): caches static assets only
  (`/`, `/index.html`, `/styles.css`, `/manifest.json`,
  `/offline.html`, icons), serves `/offline.html` for navigation
  requests when offline, and never caches authenticated API
  responses, tokens, avatars, banners or uploads (those are
  network-only). A new version changes the cache name, so old
  caches are deleted on activation.
- The main page links the manifest and registers the service
  worker on load.
- Installability honest limit: browsers gate PWA install on HTTPS.
  Local `http://localhost:3000` testing works, but production
  install requires HTTPS hosting — Part 9 provides no hosting or
  certificates; that is deployment work (see below).

### Full working single-page frontend (`public/index.html`, `public/styles.css`)

Vanilla HTML/CSS/JS, no CDNs and no build step. Every section calls
the real backend with `fetch` and the user's JWT, shows loading and
API error messages, and handles the not-logged-in and
not-authorized states with a clear message instead of a broken page.
No hardcoded wallet balances, challenges, or leaderboard data exist
in the frontend — every number shown comes from an API response
(Part 9 tests check this by asserting the old demo balance figure
does not appear in the HTML and that the HTML calls the real
endpoints).

Sections: Home (homepage stats, search, site banners in the Part 8
random active order, active announcements, top players), Challenge
board (Part 3 filters, detail, create, accept, cancel, favorites),
Match room (participants with one-tap ID copy, roster, chat with
polling, ready/un-ready, countdown from server timestamps,
reconnect, result submission with evidence upload, dispute view),
Wallet (available/locked balance, transaction and purchase history,
packages, purchase request, referral dashboard and invitees),
Leaderboard (category and period selectors), Tournaments (list,
detail, bracket, register), Profile/Team/Friends (own profile edit,
rank and game IDs, avatar upload, friend requests, team create),
Admin (staff roles only: site config, statistics, health,
suspicious list, backups list, help articles, support tickets,
maintenance/emergency toggles with confirm), and Notifications
centre (category/read filters, mark read, mark all read, tap-through
to the linked match room).

### Voice chat frontend (honest scope)

Match-room voice uses Part 4 signalling only: joining requests
microphone permission, creates a WebRTC `RTCPeerConnection`,
exchanges offer/answer/ICE via the Part 4 signalling endpoints with
polling, and supports mute/unmute and leave. Audio is peer-to-peer,
not server-relayed. If microphone permission is denied or
unavailable, a clear error is shown and text chat keeps working —
the room never crashes, and voice is never claimed to work without
permission.

### Language switch

A Myanmar / English toggle in the header, persisted in
`localStorage` (`ma_lang`), switches all UI chrome strings
(navigation, buttons, section titles, form labels, error headings)
via a dictionary in the frontend. The dictionaries are tested to
have identical key sets in both languages, and every `data-i18n`
attribute and `t('...')` call in the page is checked against them.
User-generated content (custom rules, chat messages, announcements
as authored) is NOT translated — only UI chrome is. Admin
announcements keep their authored language field from Part 8.

### JWT storage trade-off (honest)

The frontend stores the JWT in `localStorage` and sends it as an
`Authorization: Bearer` header. That is simple and works for this
vanilla app, but it means any script running on the page could
read the token (XSS risk). No passwords are ever stored. A future
hardening step would be httpOnly cookies with CSRF protection;
that is deployment/security work, not Part 9 code.

### Push notifications — not claimed

Part 9 deliberately omits push. The service worker handles
offline/install only, and in-app notifications are fetched from
the Part 8 notification centre API on return, which already covers
the phone-off case (records are stored server-side and listed on
return). Push delivery would require VAPID keys and HTTPS, which
are not configured in Part 9; it is future deployment work, and
the UI does not promise push delivery.

### Design and performance

Dark premium esports theme (dark navy, neon cyan/purple accents,
neon-glow hover and click effects on primary buttons), clean
layout, responsive breakpoints (phone width stacks forms and
buttons, no horizontal scroll on the main sections), smooth CSS
transitions, and no external CDNs. Frontend assets are local only:
`public/` totals about 49 KB (index.html about 44 KB including its
inline script, styles.css about 2.4 KB, plus manifest, service
worker, offline page and icons) — the service worker caches them.

### What the full platform now contains (Parts 1–9)

Part 1 foundation/auth/roles/2FA/audit; Part 2 coin wallet and
lock/refund; Part 3 challenge board; Part 4 private match rooms;
Part 5 results, disputes, reputation, reports, match history;
Part 6 referral commission and fee preview/history; Part 7
tournaments, leaderboards, profiles, friends, teams; Part 8
no-code site control, Telegram link, notification centre,
maintenance/emergency, backups, health, sweeper, help, tickets,
suspicious review; Part 9 PWA, full UI, and Myanmar/English switch.

### What still requires deployment / external setup

Real Google OAuth keys (`GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`), a Telegram bot
token for the Part 8 Telegram link, a domain with HTTPS (required
for PWA install in production), and a VPS/host to run the app.
Money guards remain `false` (`money_movement_enabled`,
`paid_entry_enabled`, `withdrawals_enabled`): there is no cash
payout path and no payment gateway in any part, including Part 9.

## Branding

Neutral, standalone branding ("Match Arena"). No official game logos,
hero art or official wording are used. The preserved design sample was
used only for layout/dark-theme/neon-accent direction, not copied.

## Decisions made in Part 1

- SQLite locally, with a repository layer isolating all SQL, so a
  later PostgreSQL move does not rewrite routes.
- Permissions are data (seeded `role_permissions`), not hard-coded in
  routes, so role powers change by data and take effect immediately.
- Role changes are owner-only (an admin cannot promote anyone, which
  would otherwise allow privilege escalation).
- 2FA setup and enable are separate steps, so setup alone never locks
  an account out.
- The legal-approval setting is read-only through the API: it is a
  recorded statement, not a toggle an admin can flip.
- Money flags cannot be turned on in Part 1 at all, even by the owner;
  that is a deliberate Part 1 guard, not a missing feature.
