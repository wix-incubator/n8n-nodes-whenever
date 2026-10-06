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
The node starts the workflow but does not wait for completion or return its results.

## Account connection

1. In the **Whenever** node, set **Connection** to **Whenever Account**.
2. Create a **Whenever OAuth2 API** credential and select **Connect my account**.
3. Approve access in Whenever.
4. Select **Get Account** and execute the node to check the connection. It does not start a workflow.

Get Account returns `isLoggedIn`, `email`, `displayName`, and `photoUrl`. Profile fields can be null.

n8n renews the account token automatically. The connection itself ends 7 days after you connect,
or sooner if it goes 3 days unused. Reconnect the credential when it ends.
Webhook URL connections are not affected.

## License

[MIT](LICENSE)
