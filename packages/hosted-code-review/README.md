# pi-hosted-code-review

Open a GitHub pull request in a hosted [Plannotator](https://github.com/backnotprop/plannotator) review session from Pi.

## Install

Install the whole toolbox:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

Or install this package directly after publication:

```bash
pi install npm:pi-hosted-code-review
```

## Usage

```text
/review https://github.com/OWNER/REPOSITORY/pull/123
/review 123
/review
```

A full pull request URL doesn't depend on the current working directory. A pull request number uses the current repository. With no argument, `/review` uses the current branch and lets the hosted service resolve its unique open pull request.

The command supports `github.com` HTTPS, SCP-style SSH, and `ssh://` remotes. It follows Git push-destination semantics: the current branch's `pushRemote`, then `remote.pushDefault`, then the branch's tracking remote, `origin`, and finally a sole unambiguous remote. This resolves triangular fork workflows to the fork that receives the branch. It fails instead of guessing when a configured destination is local, unknown, or otherwise ambiguous; pass a full pull request URL in that case.

## Configuration

The hosted origin defaults to `https://review.yoann.gigapay.dev`. Override it with a clean HTTPS origin:

```bash
export PI_HOSTED_REVIEW_URL=https://review.example.com
```

The command opens a browser bootstrap URL. Traefik handles BasicAuth in the browser, then hosted Plannotator creates or reopens the review session and redirects to its opaque session URL.

The extension doesn't call `gh` or GitHub, and it doesn't read or send GitHub tokens, BasicAuth credentials, source code, diffs, local paths, or Pi session data. It only puts the canonical GitHub owner, repository, and pull request number or encoded branch name in the bootstrap URL.

## Development

```bash
npm install
npm run check
npm run pack:dry
```
