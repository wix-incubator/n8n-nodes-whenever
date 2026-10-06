# n8n-nodes-whenever

Start a [Whenever](https://whenever.dev) workflow run from n8n using its generic webhook URL.

The **Start Workflow** operation sends JSON, form values, or text and returns the accepted `runId`:

```json
{ "runId": "example-run-id" }
```

An accepted request means Whenever accepted the run for processing. It does not establish that the workflow finished successfully.

Requires n8n 1.86 or later.

## Credentials

1. Add a generic webhook trigger to your Whenever workflow.
2. Publish and activate the workflow.
3. Copy the generated webhook URL.
4. Create a **Whenever Webhook API** credential in n8n.
5. Paste the URL into **Webhook URL**.

The URL grants permission to start runs. The credential stores it as a password field.
There is no automatic credential test because calling this endpoint can start a workflow.

## Use

1. Connect a trigger or another node to **Whenever**.
2. Select your **Whenever Webhook API** credential.
3. Select **Start Workflow**.
4. Select **Input Format**: **JSON**, **Form Values**, or **Text**.
5. Enter the input expected by your Whenever workflow.
6. Execute the node.

**JSON** is the default. Enter JSON in **JSON Input**, for example:

```json
{ "source": "n8n", "message": "Hello from n8n" }
```

You can also use an n8n expression such as `{{ $json }}` to supply an object.

For **Form Values**, add names and values in **Form Fields**.
The node sends these as `application/x-www-form-urlencoded`, with special characters encoded.
For example, fields named `source` and `amount` arrive as `{ "source": "n8n", "amount": "25" }`.
Every value arrives as a string. If names repeat, Whenever keeps the last value.

For **Text**, enter text in **Text Input** or use an expression such as `{{ $json.message }}`.
The node sends the text unchanged as `text/plain`.
Plain text, CSV, and XML arrive as one string. The workflow must interpret the format itself.

An expression that supplies a number or boolean to a text or form field is sent as its text.
An expression that supplies an object, array, or nothing produces an error before any request is sent.

Whenever's generic webhooks have a default request limit of 64 KiB.
This node does not upload binary files or send multipart forms.

The node sends one request per incoming item. It returns one receipt per accepted request.
The next node can access the receipt with `{{ $json.runId }}`.

## Errors

Whenever returns HTTP 202 for a new accepted delivery and HTTP 200 for a deduplicated delivery.
The node requires a nonempty `runId` in either response.
An inactive workflow returns HTTP 200 without a `runId`, which produces an error.

| Outcome                     | Error                                  | What to do                                                                                                                             |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 4xx other than 429     | Whenever rejected the request          | Check the webhook URL and input in Whenever.                                                                                           |
| HTTP 429 or 5xx             | Whenever could not process the request | Retry later. The retry reuses the delivery key.                                                                                        |
| No response                 | Whenever could not confirm acceptance  | Check Whenever before retrying. A run may have started. The error names the transport code, such as `ECONNREFUSED`, and never the URL. |
| 2xx without a valid `runId` | Whenever did not return a valid runId  | Check that the workflow is active.                                                                                                     |

With **Continue On Fail**, failed items contain `error` instead of `runId`.

## Duplicate protection

Every request carries an `Idempotency-Key`. Whenever keeps a delivery record under that key for 24 hours.
A repeated key inside that window returns the existing `runId` instead of starting another run.

The key is derived from the n8n instance, workflow, execution, node, loop iteration, and item.
A new execution sends new keys, so identical input can intentionally start separate runs.
Each node, loop iteration, and incoming item has a separate key.

The node retains the original execution identity in n8n's execution context.
**Retry On Fail** and retries from saved failed executions reuse the original keys, including when n8n assigns a new execution ID.
Clicking **Execute workflow** starts a new execution with new keys.

The key does not cover the input. If you edit the input and then retry a saved failed execution within 24 hours,
Whenever returns the run it already started with the original input.
Saved retries require execution data recorded by this version of the node.

## Development

Use the Node.js version in `.nvmrc`.

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run dev
```

`--ignore-scripts` is required. Two development dependencies have install scripts that fail here:
`eslint-plugin-n8n-nodes-base` refuses any package manager other than pnpm,
and `isolated-vm` compiles a native module that does not build on the Node.js version in `.nvmrc`.
Neither is needed to build, test, or lint this package.

`npm run dev` uses the official n8n development tool to load this node into a local n8n instance.
Follow its startup output for the browser address and any local runtime requirements.

The automated tests execute the built node against a local HTTP server.
The test harness implements n8n's execution context and HTTP helper using Node.js `fetch`.
These tests establish request and response behavior, but do not establish an actual Whenever run or n8n Cloud compatibility.

## Publishing

[publish.yml](.github/workflows/publish.yml) publishes version tags to the public npm registry with provenance.
It uses the Node.js version in `.nvmrc`, runs the tests, then runs the n8n release command.
Inside GitHub Actions, that command runs lint and build before publishing.
The tag must match the package version, with an optional `v` prefix.

Configure authentication before pushing a release tag.
For an existing npm package, add a GitHub Actions trusted publisher in the package settings:

| Field | Value |
| --- | --- |
| Organization or user | `wix-incubator` |
| Repository | `n8n-nodes-whenever` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |
| Allowed actions | Enable direct publishing with `npm publish` |

Trusted publishing requires no repository secret.
If the package does not exist yet, use an npm granular access token for the first publication.
The token must permit publishing this package and bypass 2FA for unattended publishing.
Save it as the repository's `NPM_TOKEN` Actions secret. Do not commit the token.
After the first publication, configure the trusted publisher and remove the `NPM_TOKEN` secret.

For later releases, start from a clean, updated `master` checkout containing the workflow:

```sh
git switch master
git pull --ff-only
npm test
npm run lint
npm version patch
git push --atomic origin master --follow-tags
```

Use `minor` or `major` instead of `patch` when appropriate.
For the initial `0.1.0` publication, replace `npm version patch` with `git tag -a v0.1.0 -m "Release 0.1.0"`.
Only publish a version that is not already on npm.

Use these commands instead of running `npm run release` locally.
The pinned n8n CLI requires a branch named `main` for local releases, but this repository uses `master`.
After pushing, check the **Publish** workflow in GitHub Actions and the version's provenance on npm.
A passing local test or package dry run does not establish a successful publication.

References: [n8n publishing requirements](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes)
and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Scope

Version 0.1.0 starts runs through generic webhooks. It does not wait for completion or retrieve workflow results.
The package has no runtime dependencies beyond the `n8n-workflow` peer supplied by n8n.
