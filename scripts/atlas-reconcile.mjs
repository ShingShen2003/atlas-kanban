#!/usr/bin/env node
// template/scripts/atlas-reconcile.mjs
//
// DB-free task-status reconciler. Reads atlas/backlog.json and the GitHub
// Pulls API, maps each PR to a task via T-<n> patterns found in the PR title
// or branch ref, and writes the updated backlog back in-place.
//
// Named exports (pure, no I/O) are importable for unit tests:
//   taskIdFrom(text)                       → 'T-<n>' | null
//   applyPullsToBacklog(backlog, pulls)    → new backlog object (immutable)
//
// main() performs all I/O and is guarded with import.meta.url so it
// does NOT execute on import.

import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Pure named exports — safe to import without side effects
// ---------------------------------------------------------------------------

/**
 * The single human-review gate the hub derives. QA is the ONLY hub
 * `needs_human_review` gate — a post-deploy QA review set when a story is
 * `in_review`. The cockpit splits its "needs review" chips on
 * `needs_human_review.kind`, so this string is a shared contract — exported so
 * the cockpit/contract stay aligned.
 *
 * Code + security review is intentionally NOT a hub gate: it is a dev-loop
 * concern, enforced in the development loop (the G5 stop-after-PR hook + the
 * code-reviewer/security-reviewer agents + GitHub branch protection), not
 * derived here. A `pr_open` story therefore carries no `needs_human_review`.
 */
export const REVIEW_KIND = Object.freeze({
  QA: 'qa',
})

/**
 * States in which a story carries an OPEN human-review gate. Any other
 * (terminal/other) state clears the `needs_human_review` flag.
 *   in_review → qa review pending
 *
 * `pr_open` is deliberately absent: code+security review is a dev-loop concern
 * (see REVIEW_KIND), so a `pr_open` story has its review flag cleared here.
 */
const REVIEW_KIND_BY_STATE = Object.freeze({
  in_review: REVIEW_KIND.QA,
})

/**
 * Stamp or clear `needs_human_review` on a node based on its (already-derived)
 * lifecycle state. Pure — returns a NEW node, never mutates the input.
 *
 *   - state === 'in_review' → needs_human_review = { kind: qa, since }
 *   - any other state (incl. pr_open) → delete needs_human_review (clear stale flag)
 *
 * `since` defaults to now when no timestamp is supplied.
 *
 * @param {object} node  - story/task node carrying a `state`
 * @param {{ since?: string|null }} [opts]
 * @returns {object} new node
 */
function stampReviewKind(node, { since = null } = {}) {
  const kind = REVIEW_KIND_BY_STATE[node.state]
  if (!kind) {
    // Terminal/other state — clear any stale review flag immutably.
    if (node.needs_human_review === undefined) return node
    const next = { ...node }
    delete next.needs_human_review
    return next
  }
  const when = since ?? new Date().toISOString()
  // NB: do not emit `by: null`. The cockpit's strict ingest validator types
  // `by` as a string, so `by: null` fails schema validation (the whole backlog
  // is then rejected on ingest). `by` is optional — omit it when there's no
  // known requester; a real GitHub login can be set later if/when known.
  const review = { kind, since: when }
  return { ...node, needs_human_review: review }
}

/**
 * Extract the first known task identifier from a string.
 *
 * Scheme-agnostic: rather than guessing at one regex, the function matches
 * against the actual task IDs from the backlog (passed as `knownIds`). This
 * means every ID scheme works out of the box:
 *
 *   - `T-42`        (classic ticket-style)
 *   - `T1.1.1`      (Prosci hierarchical)
 *   - `POE-123`     (Jira-style)
 *   - `P1-T01`      (compound)
 *   - anything else the project actually uses
 *
 * Match rules: the ID must appear with word-boundary edges on both sides —
 * so `T1.1.1` matches inside `feat(T1.1.1): something` but won't false-match
 * inside `T1.1.10`. Longer IDs win over shorter ones when both are present,
 * preventing `T1.1.1` from stealing a hit meant for `T1.1.10`.
 *
 * When `knownIds` is empty the legacy `T-<n>` regex is used as a fallback so
 * older test fixtures keep working.
 *
 * @param {string} text        - PR title, branch ref, or any free-form string
 * @param {string[]} [knownIds] - the actual task IDs from the backlog
 * @returns {string|null} e.g. 'T1.1.1', or null if no match
 */
export function taskIdFrom(text, knownIds) {
  if (typeof text !== 'string') return null

  if (Array.isArray(knownIds) && knownIds.length > 0) {
    // Sort by length desc so longer IDs are tried first.
    const sorted = [...knownIds].sort((a, b) => b.length - a.length)
    for (const id of sorted) {
      // Escape regex meta-chars in the id (dots especially).
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Word-boundary on both sides so we don't match T1.1.1 inside T1.1.10.
      const re = new RegExp(`\\b${escaped}\\b`)
      if (re.test(text)) return id
    }
    return null
  }

  // Legacy fallback — only fires when no knownIds were provided.
  const m = text.match(/\bT-(\d+)\b/)
  return m ? `T-${m[1]}` : null
}

/**
 * Find ALL known IDs that appear in a PR title or branch ref. Used for
 * multi-story claims where one PR can ship several story IDs together,
 * e.g. "feat(S1.1, S1.2): foundation bundle".
 *
 * @param {string} text
 * @param {string[]} knownIds
 * @returns {string[]} matched IDs (deduplicated, longer IDs preferred — no
 *   false-match of T1.1.1 inside T1.1.10)
 */
export function taskIdsFrom(text, knownIds) {
  if (typeof text !== 'string') return []
  if (!Array.isArray(knownIds) || knownIds.length === 0) {
    const single = taskIdFrom(text, knownIds)
    return single ? [single] : []
  }
  // Sort by length desc so we match longer IDs first and don't double-count
  // an ID that's a prefix of another (T1.1.1 inside T1.1.10).
  const sorted = [...knownIds].sort((a, b) => b.length - a.length)
  const matched = new Set()
  let remaining = text
  for (const id of sorted) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'g')
    if (re.test(remaining)) {
      matched.add(id)
      // Black out the matched span(s) so a shorter prefix-ID can't match
      // inside the same place again.
      remaining = remaining.replace(re, '#'.repeat(id.length))
    }
  }
  return [...matched]
}

/** PR state derivation shared between story-level and task-level updates.
 *  Populates claimed_by from the PR author (pr.user.login) — this is what
 *  the viewer's People section aggregates on. The merging actor takes
 *  precedence on merged PRs (the person who actually shipped it). */
function deriveFromPr(pr) {
  const author = pr.user?.login ?? null
  const merger = pr.merged_by?.login ?? null
  if (pr.merged_at) {
    return {
      status: 'merged',
      state: 'merged',
      pr_number: pr.number,
      merged_at: pr.merged_at,
      pr_url: pr.html_url,
      claimed_by: merger ?? author,
    }
  }
  if (pr.state === 'open' && !pr.draft) {
    return {
      status: 'in_progress',
      state: 'pr_open',
      pr_number: pr.number,
      pr_url: pr.html_url,
      claimed_by: author,
    }
  }
  if (pr.state === 'closed' && !pr.merged_at) {
    // Closed-without-merge — treat as blocked. Devs / orchestrator can re-open
    // the PR to clear the state.
    return {
      status: 'blocked',
      state: 'blocked',
      pr_number: pr.number,
      pr_url: pr.html_url,
      claimed_by: author,
    }
  }
  // draft PR
  return {
    status: 'in_progress',
    state: 'claimed',
    pr_number: pr.number,
    pr_url: pr.html_url,
    claimed_by: author,
  }
}

/**
 * atlas-update PRs (labeled `atlas:backlog-change`, titled `atlas: <op> — …`)
 * change the PLAN, not the code. Their titles reference story/task ids, so they
 * must be excluded from PR→story state matching — counting one as a story's
 * implementation PR would advance a just-added story past `queued` (to
 * merged / in_review) before any code is written.
 */
export function isBacklogChangePr(pr) {
  const labels = Array.isArray(pr?.labels) ? pr.labels : []
  const hasLabel = labels.some(
    (l) => (typeof l === 'string' ? l : l?.name) === 'atlas:backlog-change'
  )
  const titleIsAtlasOp = /^\s*atlas:\s/i.test(pr?.title ?? '')
  return hasLabel || titleIsAtlasOp
}

/**
 * Apply a list of GitHub pull-request objects to a backlog, returning a new
 * backlog with updated story AND task statuses. Pure — does not mutate input.
 *
 * Matching rules (in order of precedence):
 *   1. A PR title containing one or more story IDs (e.g. `feat(S1.1, S1.2)`)
 *      updates each matched story + propagates state to all child tasks.
 *   2. A PR title containing a `claim_id` (e.g. `feat(C-001)`) updates every
 *      story carrying that claim_id + propagates to their tasks.
 *   3. A PR title containing only task IDs updates those tasks individually
 *      (legacy task-level model; the parent story state is rolled up later
 *      by the viewer).
 *
 * Merged PRs always beat open ones for the same target.
 *
 * @param {object} backlog - source backlog (may include stories[] + tasks[])
 * @param {object[]} pulls - GitHub PR objects
 * @returns {object} new backlog (immutable)
 */
export function applyPullsToBacklog(backlog, pulls) {
  const stories = Array.isArray(backlog.stories) ? backlog.stories : []
  // Retired stories — superseded or deferred — are NOT matchable against PRs.
  // A PR landing for an old superseded id should be a no-op; the work has
  // moved to the successor story / claim.
  const isRetired = (s) =>
    (Array.isArray(s.superseded_by) && s.superseded_by.length > 0) ||
    Boolean(s.deferred_reason)
  const activeStoryIds = stories.filter((s) => !isRetired(s)).map((s) => s.id)
  const taskIds = backlog.tasks.map((t) => t.id)
  const claimIds = [...new Set(stories.filter((s) => !isRetired(s)).map((s) => s.claim_id).filter(Boolean))]
  // Variable kept for clarity below — same value, named so the intent reads.
  const storyIds = activeStoryIds

  // Dictionary the matcher uses — story + claim IDs preferred over task IDs.
  const knownIds = [...storyIds, ...claimIds, ...taskIds]

  // best PR per target ID — prefer merged over open
  const bestPrByStory = new Map() // story_id  → pr
  const bestPrByClaim = new Map() // claim_id  → pr
  const bestPrByTask  = new Map() // task_id   → pr

  const storyIdSet = new Set(storyIds)
  const claimIdSet = new Set(claimIds)

  const promoteBetter = (map, id, pr) => {
    const existing = map.get(id)
    if (!existing || (!existing.merged_at && pr.merged_at)) map.set(id, pr)
  }

  for (const pr of pulls) {
    // Plan-change PRs (atlas-update) reference story/task ids in their title
    // but are NOT implementation work — skip them so a freshly-added story
    // stays `queued` until a real feature PR lands.
    if (isBacklogChangePr(pr)) continue
    const hits = new Set([
      ...taskIdsFrom(pr.title, knownIds),
      ...taskIdsFrom(pr.head?.ref, knownIds),
    ])
    if (hits.size === 0) continue
    for (const id of hits) {
      if (storyIdSet.has(id))      promoteBetter(bestPrByStory, id, pr)
      else if (claimIdSet.has(id)) promoteBetter(bestPrByClaim, id, pr)
      else                         promoteBetter(bestPrByTask,  id, pr)
    }
  }

  // Expand claim matches → stories sharing that claim_id
  for (const [claimId, pr] of bestPrByClaim) {
    for (const s of stories) {
      if (s.claim_id === claimId) promoteBetter(bestPrByStory, s.id, pr)
    }
  }

  // Apply story-level updates.
  // For retired stories (superseded or deferred): CLEAR any stale PR state
  // that may have been recorded before the story was retired. The reconciler
  // never matches new PRs to retired stories, but legacy state lingers
  // otherwise and shows up as a "merged" badge on a deferred card.
  const updatedStories = stories.map((s) => {
    if (isRetired(s)) {
      const retired = {
        ...s,
        // Preserve content + retirement fields; clear PR state.
        pr_number: null,
        pr_url: null,
        merged_at: null,
        // Reset state to the canonical retirement state:
        //   deferred  → keep `blocked` (the canonical deferred state)
        //   superseded → `queued` (no work happens here anymore)
        state: s.deferred_reason ? 'blocked' : 'queued',
        status: s.deferred_reason ? 'deferred' : 'pending',
        // Clear claimed_by (the prior owner moved to the successor).
        claimed_by: null,
      }
      // Retirement states (blocked/queued) carry no open review gate.
      return stampReviewKind(retired)
    }
    const pr = bestPrByStory.get(s.id)
    if (!pr) {
      // No PR for this story — leave state alone, but clear any stale review
      // flag whose state no longer warrants it (e.g. a PR that was just merged
      // out from under a previously-derived pr_open). stampReviewKind is a
      // no-op for states with no open gate when the flag is already absent.
      return stampReviewKind({ ...s })
    }

    const updated = { ...s, ...deriveFromPr(pr) }

    // v1.8.1+ — capture actual AI-hours on merge. Window is pr.created_at
    // → pr.merged_at; this is the cleanest proxy for "AI agent worked on
    // this story" because the PR open is the canonical claim signal.
    // (Earlier signals — branch push, first commit — also work but
    // require extra API calls; PR-open is on the PR object we already
    // have.) Only writes when the PR is merged AND actual_ai_hours
    // isn't already set (don't overwrite a manually-curated value).
    if (
      pr.merged_at &&
      pr.created_at &&
      typeof s.actual_ai_hours !== 'number'
    ) {
      const startMs = Date.parse(pr.created_at)
      const endMs = Date.parse(pr.merged_at)
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        updated.actual_ai_hours = +((endMs - startMs) / 3_600_000).toFixed(2)
      }
    }
    // Derive + write the lifecycle state from the PR (pr_open, merged, …).
    // stampReviewKind only stamps a hub gate for QA (in_review); a pr_open
    // story carries no needs_human_review (code+security review is a dev-loop
    // concern). `since` is passed through for any QA gate this may produce.
    return stampReviewKind(updated, { since: pr.created_at ?? null })
  })

  // Apply task-level updates: story PRs cascade to child tasks; otherwise the
  // task may have its own PR (legacy mode).
  const storyPrById = new Map()
  for (const s of updatedStories) {
    const pr = bestPrByStory.get(s.id)
    if (pr) storyPrById.set(s.id, pr)
  }

  const updatedTasks = backlog.tasks.map((task) => {
    // Story-level PR cascades first.
    if (task.story_id && storyPrById.has(task.story_id)) {
      const pr = storyPrById.get(task.story_id)
      return stampReviewKind({ ...task, ...deriveFromPr(pr) }, { since: pr.created_at ?? null })
    }
    // Otherwise task may have its own PR (legacy task-level model).
    const pr = bestPrByTask.get(task.id)
    if (!pr) return stampReviewKind({ ...task })
    return stampReviewKind({ ...task, ...deriveFromPr(pr) }, { since: pr.created_at ?? null })
  })

  return { ...backlog, stories: updatedStories, tasks: updatedTasks }
}

/**
 * Apply post-deploy QA state transitions to a backlog, returning a new
 * backlog. Pure — does not mutate input.
 *
 * Two transitions in sequence (so a single call can carry a node all the
 * way from merged → verified):
 *   1. merged + REQUIRES QA  → in_review   (deploy inferred from merge; the loop
 *      self-runs — no separate deploy signal needed. deploys[id], if present,
 *      only supplies the QA `since` timestamp.)
 *   2. in_review + signoffs[id].decision === 'approved' && all_pass === true → verified
 *
 * QA POLICY: human QA review gates only stories that need it. The default rule
 * is `ui === true` (visual stories get a human QA gate; pure-backend work is
 * "done" at `merged` — code review already happened in the dev-loop). A node
 * that doesn't require QA never enters `in_review` and rests at `merged`.
 * (Foundation for a future per-story `requires_qa` override + project config /
 * UI toggle: this is the single seam — `requiresQa(node)`.)
 *
 * Applies to both backlog.stories and backlog.tasks by id.
 *
 * @param {object} backlog - source backlog
 * @param {{ deploys?: object, signoffs?: object }} [signals]
 * @returns {object} new backlog (immutable)
 */
// QA gate policy. Default: visual (`ui:true`) stories require human QA sign-off.
// Extend here later for a per-story `requires_qa` override or a project config.
function requiresQa(node) {
  return node.ui === true
}

export function applyQaSignals(backlog, { deploys = {}, signoffs = {} } = {}) {
  const applyToNode = (node) => {
    let state = node.state

    // Step 1: a QA-gated (ui) story enters QA review automatically ON MERGE.
    // The deploy is INFERRED from the merge — most projects deploy-on-merge, so
    // requiring a separate deploy signal would stall the loop (nothing produced
    // one). `deploys.json`, when a real deploy pipeline writes it, supplies the
    // deploy timestamp/url (used for `since` below) but is NOT required to enter
    // QA. Non-QA work (ui:false / backend) stays at `merged` (its done state).
    // (Future seam: a project config could switch this to require an explicit
    // `deploys[id]` gate — branch on that here.)
    if (state === 'merged' && requiresQa(node)) {
      state = 'in_review'
    }

    // Step 2: in_review + approved+all_pass sign-off → verified
    const signoff = signoffs[node.id]
    if (
      state === 'in_review' &&
      signoff?.decision === 'approved' &&
      signoff?.all_pass === true
    ) {
      state = 'verified'
    }

    const withState = state === node.state ? node : { ...node, state }

    // QA is the only hub human-review gate, and it is owned HERE. Code+security
    // review is a dev-loop concern (stop-after-PR hook + agents + branch
    // protection), so a `pr_open` story carries no needs_human_review — fall
    // through to stampReviewKind, which clears any stale flag for non-review
    // states.
    if (state === 'in_review') {
      // Stamp/refresh the qa gate, anchored to deploy time.
      const since = deploys[node.id]?.deployed_at ?? null
      return stampReviewKind(withState, { since })
    }

    // Any other state (verified, merged-without-deploy, blocked, …) — clear a
    // stale qa flag if present. stampReviewKind clears for non-review states.
    return stampReviewKind(withState)
  }

  const stories = Array.isArray(backlog.stories) ? backlog.stories : []
  const tasks = Array.isArray(backlog.tasks) ? backlog.tasks : []

  const updatedStories = stories.map(applyToNode)
  const updatedTasks = tasks.map(applyToNode)

  return { ...backlog, stories: updatedStories, tasks: updatedTasks }
}

// ---------------------------------------------------------------------------
// Network helper — not unit-tested
// ---------------------------------------------------------------------------

/**
 * Fetch all pull requests (open + closed) from the GitHub API.
 *
 * @param {string} repo  - 'owner/repo'
 * @param {string} token - GitHub personal access token or GITHUB_TOKEN
 * @returns {Promise<object[]>}
 */
async function fetchPulls(repo, token) {
  const url = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'atlas',
    },
  })
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`)
  }
  return res.json()
}

/**
 * Fetch all branches (paginated). Used to detect claim state from a pushed
 * feature branch BEFORE a PR exists. Closes the gap where a dev has
 * checked out `feat/S1.2-foo` and pushed it but hasn't opened a PR yet —
 * without this step, the Atlas viewer shows S1.2 as still queued even
 * though work is underway.
 */
async function fetchBranches(repo, token) {
  const out = []
  let page = 1
  // Cap at 5 pages (500 branches) so the reconciler is bounded even on
  // pathological repos with thousands of stale branches.
  for (; page <= 5; page++) {
    const url = `https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'atlas',
      },
    })
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText} — ${url}`)
    }
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/**
 * Resolve a branch's head-commit author.
 *
 * The /repos/{repo}/branches LIST endpoint returns only { commit: { sha,
 * url } } — no author info. To get the author login we have to follow
 * the commit URL (or hit /repos/{repo}/commits/{sha} directly). Cached
 * per-sha so two branches pointing at the same commit only cost one
 * lookup.
 */
const commitAuthorCache = new Map() // sha → { login: string | null } (or null = lookup failed)

async function resolveCommitAuthor(repo, token, sha) {
  if (!sha) return null
  if (commitAuthorCache.has(sha)) return commitAuthorCache.get(sha)
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/${sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'atlas',
        },
      },
    )
    if (!res.ok) {
      commitAuthorCache.set(sha, null)
      return null
    }
    const c = await res.json()
    const login = c?.author?.login ?? c?.committer?.login ?? null
    commitAuthorCache.set(sha, { login })
    return { login }
  } catch {
    commitAuthorCache.set(sha, null)
    return null
  }
}

/**
 * Resolve how many commits a branch is AHEAD of the base branch via the
 * GitHub compare endpoint:
 *   GET /repos/{owner}/{repo}/compare/{base}...{branch} → { ahead_by }
 *
 * `ahead_by > 0` means the branch has real commits beyond base → the story
 * is being actively worked (state 'working'). `ahead_by === 0` means the
 * branch was just created off base with nothing on it yet → keep 'claimed'.
 *
 * Returns the integer ahead-by count, or null on any failure (the caller
 * treats null as "no proof of commits" → conservative 'claimed').
 *
 * @param {string} repo   - 'owner/repo'
 * @param {string} token  - GitHub token
 * @param {string} base   - base branch name (e.g. 'main')
 * @param {string} branch - feature branch name
 * @returns {Promise<number|null>}
 */
async function fetchAheadBy(repo, token, base, branch) {
  try {
    const url = `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'atlas',
      },
    })
    if (!res.ok) return null
    const body = await res.json()
    return typeof body?.ahead_by === 'number' ? body.ahead_by : null
  } catch {
    return null
  }
}

/**
 * Take the PR-reconciled backlog and overlay claim-from-branch state on
 * any story/claim that has a matching pushed branch but no covering PR.
 * Stories already in a state derived from a PR (working / in_review /
 * merged / blocked / closed-without-merge) are NOT downgraded — the PR
 * is always the stronger signal.
 *
 * The branch match closes the gap: dev checks out `feat/S1.2-foo`,
 * pushes it, runs `git push -u origin feat/S1.2-foo` — within ~30s
 * (the push-trigger reconcile), the Atlas viewer flips S1.2 from
 * 'queued' to 'claimed' (branch exists, 0 commits ahead) or 'working'
 * (branch is ahead of base — real commits) with claimed_by +
 * worktree_branch set, even without a draft PR.
 *
 * State derivation from a matched branch:
 *   - ahead_by > 0 (commits exist beyond base) → 'working'
 *   - ahead_by === 0 (branch just created, no commits) → 'claimed'
 *   - ahead_by unknown (no signal for this sha) → 'claimed' (conservative;
 *     we never claim "working" without proof of commits)
 *
 * @param {object} backlog   - backlog already updated by applyPullsToBacklog
 * @param {object[]} branches - GitHub branch objects from fetchBranches
 * @param {Map<string,string>} authorBySha - optional sha → gh-login map.
 *   The List Branches endpoint doesn't return author info; main() resolves
 *   it from /repos/{repo}/commits/{sha} and passes the map here so the
 *   transform stays pure. Tests pass an empty map (or a stubbed one).
 * @param {Map<string,number>} aheadBySha - optional sha → ahead_by count map.
 *   The List Branches endpoint doesn't return how far a branch is ahead of
 *   base; main() resolves it from /repos/{repo}/compare/{base}...{branch}
 *   and passes the map here so the transform stays pure. A positive count
 *   means the branch has real commits → 'working'. Missing/0 → 'claimed'.
 * @returns {object} new backlog (immutable)
 */
export function applyBranchesToBacklog(backlog, branches, authorBySha = new Map(), aheadBySha = new Map()) {
  const stories = Array.isArray(backlog.stories) ? backlog.stories : []
  if (stories.length === 0 || !Array.isArray(branches) || branches.length === 0) {
    return backlog
  }

  const isRetired = (s) =>
    (Array.isArray(s.superseded_by) && s.superseded_by.length > 0) ||
    Boolean(s.deferred_reason)

  // States the branch signal can NOT override — these are derived from a
  // real PR and carry stronger signal. The branch overlay only fires when
  // the story is otherwise in a queued/empty state.
  const PR_DERIVED_STATES = new Set([
    'pr_open',
    'in_review',
    'ci_running',
    'ci_passed',
    'ci_failed',
    'merged',
    'verified',
    'working',
    'blocked',
  ])

  const activeIds = new Set(
    stories.filter((s) => !isRetired(s)).map((s) => s.id),
  )
  const claimIds = new Set(
    stories
      .filter((s) => !isRetired(s))
      .map((s) => s.claim_id)
      .filter(Boolean),
  )
  const knownIds = [...activeIds, ...claimIds]
  if (knownIds.length === 0) return backlog

  // Group matched branches by story/claim id. Most-recent commit wins
  // when multiple branches match the same id (latest claim).
  const bestBranchByStory = new Map() // story_id → { branch, commitTime }
  const bestBranchByClaim = new Map() // claim_id → { branch, commitTime }

  const promote = (map, id, branch) => {
    const time = branch?.commit?.commit?.committer?.date
      ? new Date(branch.commit.commit.committer.date).getTime()
      : 0
    const existing = map.get(id)
    if (!existing || existing.commitTime < time) {
      map.set(id, { branch, commitTime: time })
    }
  }

  for (const branch of branches) {
    const name = branch?.name
    if (!name) continue
    const hits = taskIdsFrom(name, knownIds)
    if (hits.length === 0) continue
    for (const id of hits) {
      if (activeIds.has(id)) promote(bestBranchByStory, id, branch)
      else if (claimIds.has(id)) promote(bestBranchByClaim, id, branch)
    }
  }

  // Expand claim matches → every story sharing that claim_id
  for (const [claimId, hit] of bestBranchByClaim) {
    for (const s of stories) {
      if (s.claim_id === claimId && !bestBranchByStory.has(s.id)) {
        bestBranchByStory.set(s.id, hit)
      }
    }
  }

  if (bestBranchByStory.size === 0) return backlog

  // Derive the branch-overlay state from how far the branch is ahead of base.
  // ahead_by > 0 → real commits exist → 'working'. Otherwise (0 commits, or
  // we have no ahead-by signal for this sha) → 'claimed' (conservative — never
  // assert 'working' without proof of commits).
  const branchState = (branch) => {
    const ahead = aheadBySha.get(branch?.commit?.sha)
    return typeof ahead === 'number' && ahead > 0 ? 'working' : 'claimed'
  }
  // States the branch overlay may produce — used to detect a real flip below.
  const BRANCH_OVERLAY_STATES = new Set(['claimed', 'working'])

  const updatedStories = stories.map((s) => {
    const hit = bestBranchByStory.get(s.id)
    if (!hit) return s
    // Don't downgrade a PR-derived state (merged / pr_open / in_review /
    // verified / blocked / working). `working` is in PR_DERIVED_STATES so a
    // story already working is never re-derived here.
    if (s.state && PR_DERIVED_STATES.has(s.state)) return s
    if (isRetired(s)) return s
    const { branch } = hit
    const author = authorBySha.get(branch?.commit?.sha) ?? null
    return {
      ...s,
      state: branchState(branch),
      status: 'in_progress',
      claimed_by: author ?? s.claimed_by ?? null,
      worktree_branch: branch.name,
    }
  })

  // Cascade to child tasks of stories the branch overlay just updated,
  // matching the PR-cascade semantics in applyPullsToBacklog. Only touch
  // tasks whose parent story flipped to a branch-overlay state (claimed or
  // working) AND whose own state is also not PR-derived.
  const storiesFlippedById = new Map()
  for (const s of updatedStories) {
    const prev = stories.find((x) => x.id === s.id)
    if (prev && prev.state !== s.state && BRANCH_OVERLAY_STATES.has(s.state)) {
      storiesFlippedById.set(s.id, s)
    }
  }

  const updatedTasks = (Array.isArray(backlog.tasks) ? backlog.tasks : []).map((t) => {
    if (!t.story_id || !storiesFlippedById.has(t.story_id)) return t
    if (t.state && PR_DERIVED_STATES.has(t.state)) return t
    const parent = storiesFlippedById.get(t.story_id)
    return {
      ...t,
      // Child task inherits the parent's branch-overlay state (working/claimed).
      state: parent.state,
      status: 'in_progress',
      claimed_by: parent.claimed_by ?? t.claimed_by ?? null,
      worktree_branch: parent.worktree_branch ?? t.worktree_branch ?? null,
    }
  })

  return { ...backlog, stories: updatedStories, tasks: updatedTasks }
}

// ---------------------------------------------------------------------------
// main() — performs all I/O; guarded to not run on import
// ---------------------------------------------------------------------------

async function main() {
  // Config: read github.repo from atlas/atlas.config.json
  let config = {}
  try {
    config = JSON.parse(readFileSync('atlas/atlas.config.json', 'utf8'))
  } catch {
    // file absent or invalid — handled below
  }

  const repo = config?.github?.repo
  const token = process.env.GITHUB_TOKEN ?? process.env.ATLAS_GITHUB_TOKEN

  if (!repo || !token) {
    if (!repo) console.warn('[atlas-reconcile] Warning: github.repo not set in atlas/atlas.config.json — skipping.')
    if (!token) console.warn('[atlas-reconcile] Warning: GITHUB_TOKEN / ATLAS_GITHUB_TOKEN not set — skipping.')
    process.exit(0)
  }

  const backlogPath = config?.github?.backlogPath ?? 'atlas/backlog.json'
  let backlog = { tasks: [] }
  try {
    backlog = JSON.parse(readFileSync(backlogPath, 'utf8'))
  } catch {
    console.warn(`[atlas-reconcile] Warning: could not read ${backlogPath} — starting with empty task list.`)
  }

  const pulls = await fetchPulls(repo, token)
  const fromPulls = applyPullsToBacklog(backlog, pulls)

  // Branch overlay closes the no-PR-yet gap. Fail-soft: if the branches
  // endpoint flakes, we still ship the PR-derived state.
  let branches = []
  try {
    branches = await fetchBranches(repo, token)
  } catch (e) {
    console.warn(`[atlas-reconcile] Branch fetch failed — continuing with PR-only state. ${e.message}`)
  }

  // Pre-resolve commit authors for branches whose names match a known
  // story / claim id. The List Branches endpoint doesn't return author
  // info; each commit requires a follow-up /repos/{repo}/commits/{sha}
  // call. Cap at 30 author lookups per reconcile run so a repo with
  // hundreds of stale feat branches doesn't burn API budget.
  const authorBySha = new Map()
  const activeStoryIds = (fromPulls.stories ?? [])
    .filter((s) => !((Array.isArray(s.superseded_by) && s.superseded_by.length > 0) || s.deferred_reason))
    .map((s) => s.id)
  const activeClaimIds = [
    ...new Set(
      (fromPulls.stories ?? [])
        .filter((s) => !((Array.isArray(s.superseded_by) && s.superseded_by.length > 0) || s.deferred_reason))
        .map((s) => s.claim_id)
        .filter(Boolean),
    ),
  ]
  const knownForBranches = [...activeStoryIds, ...activeClaimIds]
  // Base branch we compare feature branches against (config.github.ref → 'main').
  const baseBranch = config?.github?.ref || 'main'
  // sha → ahead_by count. Drives the 'working' vs 'claimed' branch-overlay
  // decision. Resolved via /repos/{repo}/compare/{base}...{branch}; bounded so
  // a repo with many stale feat branches doesn't burn API budget.
  const aheadBySha = new Map()
  let lookupBudget = 30
  let compareBudget = 30
  for (const branch of branches) {
    // Break only when BOTH budgets are spent (&&, not ||): each call below is
    // independently gated on its OWN budget (`lookupBudget > 0` / `compareBudget
    // > 0`) plus a `has(sha)` dedup, so once one budget runs out we skip just
    // that branch's call and keep serving the other — no correctness is lost
    // (notably the `working` derivation's compare call keeps running while
    // author lookups are exhausted). The only cost after one budget is spent is
    // a cheap no-op iteration (id-match + dedup checks), which is acceptable.
    if (lookupBudget <= 0 && compareBudget <= 0) break
    // Skip atlas-update branches (feat/atlas-update-… / fix/atlas-update-…):
    // they carry a story id in the branch name but are plan changes, not
    // implementation work, so they must not drive the working/claimed overlay.
    if (/^(feat|fix)\/atlas-update-/.test(branch.name)) continue
    if (taskIdsFrom(branch.name, knownForBranches).length === 0) continue
    const sha = branch?.commit?.sha
    if (!sha) continue
    if (lookupBudget > 0 && !authorBySha.has(sha)) {
      const resolved = await resolveCommitAuthor(repo, token, sha)
      authorBySha.set(sha, resolved?.login ?? null)
      lookupBudget--
    }
    if (compareBudget > 0 && !aheadBySha.has(sha)) {
      const ahead = await fetchAheadBy(repo, token, baseBranch, branch.name)
      // null (compare failed / unknown) → omit so the overlay stays conservative
      // (treats the branch as 'claimed', never falsely 'working').
      if (typeof ahead === 'number') aheadBySha.set(sha, ahead)
      compareBudget--
    }
  }

  const updated = applyBranchesToBacklog(fromPulls, branches, authorBySha, aheadBySha)

  // Visibility: log how many stories got working/claimed state from the
  // branch overlay (vs the queued/empty state they were in before).
  const BRANCH_OVERLAY_STATES = new Set(['claimed', 'working'])
  const branchOverlaid = updated.stories?.filter((s) => {
    const prev = fromPulls.stories?.find((x) => x.id === s.id)
    return prev && prev.state !== s.state && BRANCH_OVERLAY_STATES.has(s.state) && s.worktree_branch
  }) ?? []
  if (branchOverlaid.length) {
    console.log(`[atlas-reconcile] Branch overlay: ${branchOverlaid.length} ${branchOverlaid.length === 1 ? 'story' : 'stories'} flipped from a pushed feat branch — ${branchOverlaid.map((s) => `${s.id}@${s.worktree_branch}(${s.state})`).join(', ')}`)
  }

  // Post-deploy QA transitions: merged → in_review (deploy) → verified (QA sign-off)
  const readJsonSafe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} } }
  const deploys = readJsonSafe('atlas/deploys.json')
  const signoffsDoc = readJsonSafe('atlas/uat-signoffs.json')
  const withQa = applyQaSignals(updated, { deploys, signoffs: signoffsDoc.signoffs ?? signoffsDoc })
  withQa.generated_at = new Date().toISOString()

  writeFileSync(backlogPath, JSON.stringify(withQa, null, 2) + '\n')
  console.log(`[atlas-reconcile] Wrote ${backlogPath} (${withQa.tasks.length} tasks, ${pulls.length} PRs, ${branches.length} branches processed)`)
}

// Guard: only run main() when executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
