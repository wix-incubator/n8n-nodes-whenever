# n8n-nodes-whenever

Start [Whenever](https://whenever.dev) workflows from n8n using a webhook URL or your Whenever account.
Webhook URL connections require n8n 1.86 or later. Account connections require n8n 2.41.0 or later.

## Setup

1. Add a generic webhook trigger to your Whenever workflow.
2. Publish and activate the workflow.
3. Copy the webhook URL.
4. In n8n, create a **Whenever Webhook API** credential with that URL.

Keep the webhook URL private. Anyone with the URL can start the workflow.

## Usage

1. Add the **Whenever** node and select your credential.
2. Select **Start Workflow**.
3. Choose **JSON**, **Form Values**, or **Text** and enter your input.
4. Execute the node.

Example JSON input:

```json
{ "message": "Hello from n8n" }
```

The node returns a `runId` for each accepted request:

```json
{ "runId": "example-run-id" }
```

Use `{{ $json.runId }}` in subsequent nodes.
The node starts the workflow but does not wait for completion. Use **Get Run** to read its result.

## Account connection

1. In the **Whenever** node, set **Connection** to **Whenever Account**.
2. Create a **Whenever OAuth2 API** credential and select **Connect my account**.
3. Approve access in Whenever.
4. Select **Get Account** and execute the node to check the connection. It does not start a workflow.

Get Account returns `isLoggedIn`, `email`, `displayName`, and `photoUrl`. Profile fields can be null.

n8n renews the account token automatically. The connection itself ends 7 days after you connect,
or sooner if it goes 3 days unused. Reconnect the credential when it ends.
Webhook URL connections are not affected.

## Start a workflow from your account

1. Set **Connection** to **Whenever Account**.
2. Select **Start Workflow**.
3. Choose a **Workflow** from the list, or enter its ID with **By ID**.
4. Choose one of its enabled generic webhooks in **Webhook Name or ID**.
5. Enter your input and execute the node.

The node looks up the webhook on every run, so a disabled or removed webhook fails before anything is sent.
Your account token is never sent to the webhook.
If a workflow is missing from the list, enter it **By ID**.

## Get a run

1. Set **Connection** to **Whenever Account**.
2. Select **Get Run** and set **Run ID** to `{{ $json.runId }}`.
3. Execute the node.

The node returns the run's `status`: `running`, `succeeded`, `failed`, `timed_out`, or `cancelled`.
`outputState` says what happened to its result:

- `available`: the result is in `output`.
- `omitted`: Whenever did not store it, because it was too large or could not be saved.
- `none`: the run finished without returning anything.
- `not_observed`: the result is not on this page yet.

Get Run reads one page of up to **Event Limit** events and does not wait.
When `hasMoreEvents` is true, set **After Sequence** to `nextSeq` and read again.

## License

[MIT](LICENSE)
