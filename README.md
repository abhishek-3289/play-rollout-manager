# Play Rollout Manager 🚀

[![My Skills](https://skillicons.dev/icons?i=githubactions,androidstudio,nodejs&perline=3)](https://skillicons.dev)

## Use 📄

### Example ⌨️

```yaml
    permissions:
      contents: read
      deployments: write

    steps:
      - name: Advance staged rollout
        id: rollout
        uses: appshipkit/play-rollout-manager@v1
        with:
          package-name: com.example.app
          service-account-json: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          steps: '10,25,50,100'
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}

      - name: Print result
        env:
          ACTION_TAKEN: ${{ steps.rollout.outputs.action-taken }}
          REASON: ${{ steps.rollout.outputs.reason }}
          PREVIOUS: ${{ steps.rollout.outputs.previous-percentage }}
          PERCENTAGE: ${{ steps.rollout.outputs.percentage }}
        run: |
          echo "$ACTION_TAKEN: $REASON"
          echo "$PREVIOUS% -> $PERCENTAGE%"
```

### Description 🔖

A zero-dependency JavaScript action (Node 24) that manages the staged rollout of the current release on a
Google Play track through the [Google Play Android Developer API v3](https://developers.google.com/android-publisher).
Google Play is the single source of truth: every run reads the track from Play, decides what to do, and either
commits the change or throws the edit away. Nothing about the rollout state is stored anywhere else.

Every run follows the same flow:

1. Sign an RS256 JWT with the service account key (`node:crypto`) and exchange it at the key's `token_uri`
   for an access token. The token is masked in the log; the key and token are never printed.
2. `POST /edits` to open an edit, then `GET /edits/{id}/tracks/{track}`.
3. Pick the release with status `inProgress` or `halted`. If only a `completed` release exists, the rollout is done.
   `version-name` is that release's `name` and `version-codes` are its `versionCodes`.
4. Decide what to do from `command` and the safety rules below.
5. Apply it with `PUT /edits/{id}/tracks/{track}` and `POST /edits/{id}:commit`, or `DELETE /edits/{id}`
   when there is nothing to change or `dry-run` is on.
6. Record applied changes as GitHub deployments, write outputs and a step summary table, and notify Slack.

Every HTTP response is checked. Failures stop the run with Google's (or GitHub's) error message, the edit is
deleted, and Slack is notified before the step fails.

#### Commands

| command | What it does |
|:--------|:-------------|
| `advance` | Moves an `inProgress` release to the smallest value in `steps` that is strictly greater than the current percentage. Reaching `100` sets the release to `completed` and removes `userFraction`. |
| `set` | Moves an `inProgress` release to `percentage` (1-100, `100` completes it). Lowering the percentage is refused; halt the release instead. |
| `halt` | Sets an `inProgress` release to `halted`, keeping its percentage. |
| `resume` | Sets a `halted` release back to `inProgress`, keeping its percentage. |
| `complete` | Sets an `inProgress` release to `completed`. |
| `status` | Reads the track and reports, changes nothing. |

When a release becomes `completed`, any older `completed` release on the same track is removed from the
`PUT` body, so the track ends with one completed release.

#### Safety rules 🛡️

- `advance` never touches a `halted` release; it reports `skipped: release is halted`.
- Only `resume` un-halts a release. `set` and `complete` on a halted release are skipped with `run resume first`.
- `advance` skips when the last rollout increase for this package and track happened less than
  `min-hours-between-steps` hours ago (see *Where state lives* below).
- `advance` only increases the rollout on `allowed-days` (default Monday to Friday) in `timezone` (default `UTC`).
  On other days it reports `skipped: today is Saturday in UTC; allowed-days is mon-fri`. The crash guard still
  halts on any day, and `set`, `halt`, `resume`, `complete` and `status` always run.
- `set` never lowers the rollout percentage.
- `status` and `dry-run` never change anything in Google Play and never create deployments.
- If the GitHub Deployments API fails, the rollout still proceeds with a warning, unless `require-history: true`.
- If `max-crash-rate` is set and the crash rate of the release is above it, `advance` halts the release instead
  of advancing it (experimental, see below).

### Inputs 📥

| name                        | description                                                                                                                    | required | default                 |
|:----------------------------|:-------------------------------------------------------------------------------------------------------------------------------|:---------|:------------------------|
| package-name                | Application package name, e.g. `com.example.app`.                                                                              | Yes      | ❌                      |
| service-account-json        | Contents of the service account JSON key. Pass it from a secret.                                                               | Yes      | ❌                      |
| track                       | Play track holding the staged release.                                                                                         | No       | `production`            |
| command                     | `advance`, `set`, `halt`, `resume`, `complete` or `status`.                                                                    | No       | `advance`               |
| steps                       | Comma separated rollout percentages used by `advance`. Values must be greater than 0 and at most 100.                         | No       | `10,25,50,100`          |
| percentage                  | Target percentage for `set` (1-100, `100` completes the rollout).                                                              | No       | ❌                      |
| min-hours-between-steps     | `advance` skips when the last recorded increase is newer than this many hours. `0` disables the check.                         | No       | `20`                    |
| allowed-days                | Days on which `advance` may increase the rollout: names (`mon`, `Monday`), ranges (`mon-fri`, wrap-around `fri-mon`), lists (`mon,wed,fri`) or `all`. | No       | `mon-fri`               |
| timezone                    | IANA time zone used to decide today's day for `allowed-days`, e.g. `UTC`, `Europe/London`, `Asia/Kolkata`.                     | No       | `UTC`                   |
| max-crash-rate              | **Experimental.** Crash rate in percent (e.g. `1.5`). When set, `advance` halts the release if its crash rate is higher.        | No       | ❌                      |
| changes-not-sent-for-review | Sends `changesNotSentForReview=true` with the edit commit.                                                                     | No       | `false`                 |
| dry-run                     | Compute and report the decision only. The edit is deleted, nothing is recorded.                                               | No       | `false`                 |
| github-token                | Token used for GitHub deployments. Needs `deployments: write`.                                                                 | No       | `github.token`          |
| deployment-environment      | GitHub environment that holds the rollout history.                                                                             | No       | `play-<track>-rollout`  |
| require-history             | Fail instead of warning when GitHub deployments cannot be read or written.                                                    | No       | `false`                 |
| slack-webhook-url           | Slack incoming webhook URL. Pass it from a secret.                                                                             | No       | ❌                      |
| notify-on-skip              | Also notify Slack when the run skips.                                                                                          | No       | `false`                 |
| notify-on-dry-run           | Send Slack notifications in dry-run mode.                                                                                      | No       | `false`                 |

The inputs `api-base-url`, `token-url-override` and `github-api-url` are **for testing only**. They point the
action at a mock server instead of the Google and GitHub APIs (CI uses them, see *Development* below).
`api-base-url` replaces both `https://androidpublisher.googleapis.com` and
`https://playdeveloperreporting.googleapis.com`. Do not set them in real workflows.

### Outputs 📤

1. **version-name** :- `name` of the release on the track, e.g. `1.2.3`.
2. **version-codes** :- Comma separated version codes of the release, e.g. `123,124`.
3. **status** :- Release status after the run: `inProgress`, `halted` or `completed`.
4. **previous-percentage** :- Rollout percentage before the run (`100` when completed).
5. **percentage** :- Rollout percentage after the run.
6. **action-taken** :- `advanced`, `set`, `halted`, `resumed`, `completed`, `skipped` or `none` (for `status`).
7. **reason** :- Human readable explanation of the decision.

In dry-run the outputs describe what would have happened and `reason` starts with `dry run, not applied:`.
Every run also writes a step summary table with the state before and after.

### Slack notifications 💬

With `slack-webhook-url` set, a message is posted for `advanced`, `completed`, `halted`, `resumed`, `set` and for
failures. Skips are posted only with `notify-on-skip: true`, and nothing is posted in dry-run unless
`notify-on-dry-run: true`. Each message has the package, track, version name, the percentage change, the reason
and the workflow run URL:

```text
:arrow_up: *Rollout advanced*: com.example.app (production) 1.2.3
Rollout: 25% → 50%
Reason: advanced from 25% to 50%
Run: https://github.com/OWNER/REPO/actions/runs/123456789
```

A failing Slack webhook only produces a warning; it never fails the rollout.

## Turning auto-rollout on and off 🔀

[`examples/auto-rollout.yml`](examples/auto-rollout.yml) runs every weekday at 16:00 UTC and on demand. The scheduled
job only runs when the repository variable `AUTO_ROLLOUT_ENABLED` is `true`:

```yaml
    if: github.event_name == 'workflow_dispatch' || vars.AUTO_ROLLOUT_ENABLED == 'true'
```

- **Turn on:** *Settings → Secrets and variables → Actions → Variables*, create `AUTO_ROLLOUT_ENABLED` with value
  `true`, or run `gh variable set AUTO_ROLLOUT_ENABLED --body true`.
- **Turn off:** set it to `false` (`gh variable set AUTO_ROLLOUT_ENABLED --body false`). Scheduled runs are then
  skipped, manual runs still work.
- **Turn everything off:** open the workflow in the *Actions* tab, click **…** and **Disable workflow**
  (or `gh workflow disable auto-rollout.yml`). Re-enable it the same way.
- **Manual commands:** *Actions → Play staged rollout → Run workflow* and pick `advance`, `set` (with
  `percentage`), `halt`, `resume`, `complete` or `status`, optionally with `dry-run`. From the CLI:

```bash
gh workflow run auto-rollout.yml -f command=status
gh workflow run auto-rollout.yml -f command=set -f percentage=20
gh workflow run auto-rollout.yml -f command=halt
gh workflow run auto-rollout.yml -f command=advance -f dry-run=true
```

### Weekdays only 📅

`advance` only increases the rollout on `allowed-days`, which defaults to `mon-fri`, so nothing rolls further over
a weekend even if the workflow is scheduled daily or someone runs `advance` by hand on a Saturday. The day is
taken in `timezone` (default `UTC`); set it to your team's zone so "Friday" means your Friday:

```yaml
          allowed-days: mon-thu
          timezone: Europe/London
```

Use `allowed-days: all` to allow every day. Days outside the list are reported as `skipped` (sent to Slack only
with `notify-on-skip: true`). The crash guard still halts a bad release on any day, and the manual `set`, `halt`,
`resume`, `complete` and `status` commands are never blocked.

Halting a release in Play Console works too: the next scheduled run reads the real status from Play and skips the
halted release until someone runs `resume`.

## Where state lives 🗂️

- **Google Play is the source of truth.** The current release, its status and its percentage are always read from
  the track at the start of the run. There is no state in repository variables, files or caches, so a change made
  in Play Console (halt, new release, manual percentage change) is respected by the next run.
- **History lives in GitHub deployments.** Every applied change creates a deployment in the
  `deployment-environment` environment (default `play-<track>-rollout`) with `task: play-rollout`, `ref` set to
  the workflow commit and this payload:

  ```json
  {"packageName":"com.example.app","track":"production","versionName":"1.2.3","versionCodes":["123"],
   "fromPercent":25,"toPercent":50,"command":"advance","action":"advanced"}
  ```

  followed by a `success` status with a description like `1.2.3 25% → 50%` and a link to the run. Browse it in
  *Code → Environments → play-production-rollout* (or the *Deployments* page).
- `min-hours-between-steps` uses the newest deployment with `task: play-rollout` whose payload matches the package
  and track and whose action increased the rollout (`advanced`, `set`, `completed`). Halts and resumes do not
  reset the clock, and the deployments GitHub creates for a job's own `environment:` are ignored because they use
  a different task.

## Google Play setup 🔑

1. In Google Cloud, create (or pick) a project and enable the **Google Play Android Developer API**. For the
   crash guard also enable the **Google Play Developer Reporting API**.
2. Create a service account in that project and add a JSON key. Store the whole JSON file contents as a GitHub
   secret, e.g. `PLAY_SERVICE_ACCOUNT_JSON` (an environment secret on `play-production-rollout` keeps it scoped
   to rollout jobs).
3. In Play Console open **Users and permissions**, choose **Invite new users** and enter the service account
   email (`...@....iam.gserviceaccount.com`).
4. Under **App permissions** add the app and grant **Release to production, exclude devices, and use Play App
   Signing** (and **Release apps to testing tracks** if you manage testing tracks). For the crash guard also grant
   **View app information and download bulk reports (read-only)**.
5. Invite the user. Permissions can take a while to become active; the first `status` run confirms access.
6. Give the workflow `permissions: deployments: write` so the history can be recorded.

## Crash guard (experimental) 🧪

> **Experimental.** The request below follows the published Play Developer Reporting API reference but has only
> been tested against a mock. Verify the response shape against a real account with `dry-run: true` before
> relying on it.

When `max-crash-rate` is set, the JWT requests both the `androidpublisher` and `playdeveloperreporting` scopes,
and `advance` on an `inProgress` release first:

1. `GET https://playdeveloperreporting.googleapis.com/v1beta1/apps/{packageName}/crashRateMetricSet` and reads
   `freshnessInfo.freshnesses[]` where `aggregationPeriod` is `DAILY` to find the last complete day
   (`latestEndTime`).
2. `POST https://playdeveloperreporting.googleapis.com/v1beta1/apps/{packageName}/crashRateMetricSet:query` with:

   ```json
   {
     "timelineSpec": {
       "aggregationPeriod": "DAILY",
       "startTime": {"year": 2026, "month": 2, "day": 28, "timeZone": {"id": "America/Los_Angeles"}},
       "endTime": {"year": 2026, "month": 3, "day": 1, "timeZone": {"id": "America/Los_Angeles"}}
     },
     "dimensions": ["versionCode"],
     "metrics": ["crashRate", "distinctUsers"],
     "filter": "versionCode = 123 OR versionCode = 124"
   }
   ```

   `endTime` is `latestEndTime` and `startTime` is one day earlier, in the time zone Play returns.
3. Reads `rows[].dimensions[]` (`dimension: "versionCode"`, `stringValue`) and `rows[].metrics[]`
   (`metric: "crashRate"`, `decimalValue.value`, a fraction such as `0.012` for 1.2%). The worst rate across the
   release's version codes is compared with `max-crash-rate`.

- Above the threshold: the release is **halted** instead of advanced and Slack is notified.
- No data for the release's version codes (or no freshness info): the run **skips** without advancing.
- Reporting API errors (API disabled, missing permission): the run **fails** and notifies, so a broken guard is
  noticed instead of silently ignored.

`set`, `complete`, `halt`, `resume` and `status` do not consult the crash guard.

## Examples 🧪

- [`examples/auto-rollout.yml`](examples/auto-rollout.yml) advances the production rollout every weekday at 16:00
  UTC when `AUTO_ROLLOUT_ENABLED` is `true`, and offers every command through `workflow_dispatch`. It uses the
  `play-production-rollout` environment and a concurrency group so two runs never overlap.
- [`examples/halt-on-alert.yml`](examples/halt-on-alert.yml) halts the rollout on a `repository_dispatch` event of
  type `halt-rollout` (or manually), for wiring to an alerting system:

  ```bash
  curl -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/repos/OWNER/REPO/dispatches \
    -d '{"event_type":"halt-rollout","client_payload":{"reason":"Crash rate alert"}}'
  ```

  The token needs `contents: write` on the repository. The halt workflow uses its own concurrency group so a
  queued scheduled run can never cancel a pending halt. If a halt and an advance commit edits at the same moment,
  Play rejects one of them; the failure is reported to Slack and the halt can simply be run again.

Copy one into `.github/workflows/` of your repository and replace `com.example.app`.

## Development 🛠️

```bash
npm test
```

The action has no npm dependencies; it uses only Node 24 built-ins (`fetch`, `node:crypto`, `node:fs`). The tests
use `node:test`, stub `fetch` with recorded request and response pairs, and generate throwaway RSA keys at run
time. They cover the token exchange (JWT header, claims and signature), the edit sequences per command, step
math, the safety rules, deployment history, dry-run, Slack payloads, error surfacing and the crash guard.

[`tests/mock-server.js`](tests/mock-server.js) is a small HTTP server that imitates the token endpoint, the Play
edits API and the GitHub deployments API. Run it with `MOCK_PORT=8787 node tests/mock-server.js` and point the
action at it with the testing inputs; `GET /__requests` lists what it received.

| Workflow | Trigger | What it does |
|:---------|:--------|:-------------|
| [CI](.github/workflows/ci.yml) | push to `main`, pull requests | ShellCheck, actionlint, `node --check`, unit tests on Node 24, and an integration run of the action (`uses: ./`, `dry-run: true`) against the mock server with a throwaway key, asserting outputs and that nothing was written. |
| [Release](.github/workflows/release.yml) | manual (`patch` / `minor` / `major`) | Runs CI, calculates the next version from the highest `vX.Y.Z` tag, publishes a GitHub release with generated notes, and moves the `vMAJOR` tag. |

There is no CI job against the real Google Play API because it needs a real app and service account secret.
