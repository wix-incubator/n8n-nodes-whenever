# n8n-nodes-whenever

Start a [Whenever](https://whenever.dev) workflow run from n8n using its generic webhook URL.

The **Start Workflow** operation sends your JSON input and returns the accepted `runId`:

```json
{ "runId": "example-run-id" }
```

An accepted request means Whenever accepted the run for processing. It does not establish that the workflow finished successfully.

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
4. Enter the JSON input expected by your Whenever workflow.
5. Execute the node.

Example input:

```json
{ "source": "n8n", "message": "Hello from n8n" }
```

You can also use an n8n expression such as `{{ $json }}` to supply an object.
The node sends one request per incoming item. It returns one receipt per accepted request.
The next node can access the receipt with `{{ $json.runId }}`.

Whenever returns HTTP 202 for a new accepted delivery and HTTP 200 for a deduplicated delivery.
The node requires a nonempty `runId` in either response.
A rejection, missing `runId`, or invalid response produces an n8n error.
An inactive workflow can return HTTP 200 without a `runId`, which also produces an error.

A transport error leaves acceptance uncertain. Check Whenever before retrying, because a run might already have started.
Enabling n8n's **Retry On Fail** can send the request again and start another run.
With **Continue On Fail**, failed items contain `error` instead of `runId`.

## Development

Use the Node.js version in `.nvmrc`.

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run dev
```

`--ignore-scripts` skips an upstream lint package's install script that requires pnpm.
The build and test scripts run explicitly in the commands above.

`npm run dev` uses the official n8n development tool to load this node into a local n8n instance.
Follow its startup output for the browser address and any local runtime requirements.

The automated tests execute the built node against a local HTTP server.
The test harness implements n8n's execution context and HTTP helper using Node.js `fetch`.
These tests establish request and response behavior, but do not establish an actual Whenever run or n8n Cloud compatibility.

## Scope

Version 0.1.0 starts runs through generic webhooks. It does not wait for completion or retrieve workflow results.
The package has no runtime dependencies beyond the `n8n-workflow` peer supplied by n8n.

The repository is private. npm publication and n8n community verification are separate release steps.
