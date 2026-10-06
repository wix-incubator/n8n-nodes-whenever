import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { callTool, objectValue } from './account';

function sequence(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function getRun(context: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const runId = context.getNodeParameter('runId', itemIndex);
	const afterSeq = context.getNodeParameter('afterSeq', itemIndex, 0);
	const limit = context.getNodeParameter('eventLimit', itemIndex, 100);
	if (typeof runId !== 'string' || runId.trim() === '' || runId.length > 200) {
		throw new NodeOperationError(context.getNode(), 'Enter a valid run ID.', { itemIndex });
	}
	if (!sequence(afterSeq) || !sequence(limit) || limit < 1 || limit > 100) {
		throw new NodeOperationError(
			context.getNode(),
			'After Sequence must be a nonnegative integer and the event limit must be between 1 and 100.',
			{ itemIndex },
		);
	}
	const data = await callTool(context, 'get_run', { run_id: runId, after_seq: afterSeq, limit });
	const invalid = () =>
		new NodeOperationError(context.getNode(), 'Whenever returned invalid run evidence.', {
			itemIndex,
		});
	const run = data.run;
	if (
		!objectValue(run) ||
		run.runId !== runId ||
		typeof run.workflowId !== 'string' ||
		typeof run.version !== 'string' ||
		typeof run.status !== 'string' ||
		!['running', 'succeeded', 'failed', 'timed_out', 'cancelled'].includes(run.status) ||
		!sequence(run.startedAt) ||
		(run.endedAt !== undefined && !sequence(run.endedAt)) ||
		!Array.isArray(data.events) ||
		data.events.length > limit ||
		!sequence(data.nextSeq) ||
		data.nextSeq < afterSeq ||
		typeof data.truncated !== 'boolean' ||
		(data.truncated && data.nextSeq === afterSeq) ||
		(data.observationComplete !== undefined && typeof data.observationComplete !== 'boolean')
	)
		throw invalid();
	const events: IDataObject[] = [];
	for (const event of data.events) {
		if (
			!objectValue(event) ||
			event.runId !== runId ||
			!sequence(event.seq) ||
			event.seq <= afterSeq ||
			event.seq > data.nextSeq ||
			typeof event.type !== 'string'
		)
			throw invalid();
		events.push(event);
	}
	const result: IDataObject = {
		runId,
		workflowId: run.workflowId,
		version: run.version,
		status: run.status,
		startedAt: run.startedAt,
		nextSeq: data.nextSeq,
		hasMoreEvents: data.truncated,
		outputState: 'not_observed',
	};
	if (run.endedAt !== undefined) result.endedAt = run.endedAt;
	if (data.observationComplete !== undefined) result.observationComplete = data.observationComplete;
	if (run.failure !== undefined) {
		if (!objectValue(run.failure)) throw invalid();
		const failure: IDataObject = {};
		for (const key of ['message', 'kind', 'code', 'detail', 'operation']) {
			if (run.failure[key] !== undefined) {
				if (typeof run.failure[key] !== 'string') throw invalid();
				failure[key] = run.failure[key];
			}
		}
		result.failure = failure;
	}
	const successes = events.filter((event) => event.type === 'run_succeeded');
	if (successes.length > 1) throw invalid();
	const success = successes[0];
	if (run.status !== 'succeeded' || success === undefined) return result;
	if (success.outputOmitted !== undefined) {
		if (
			typeof success.outputOmitted !== 'string' ||
			!['too_large', 'unserializable'].includes(success.outputOmitted) ||
			success.outputJson !== undefined
		)
			throw invalid();
		result.outputState = 'omitted';
		result.outputOmitted = success.outputOmitted;
	} else if (success.outputJson !== undefined) {
		if (typeof success.outputJson !== 'string' || success.outputJson.length > 20000)
			throw invalid();
		try {
			result.output = JSON.parse(success.outputJson);
		} catch {
			throw invalid();
		}
		result.outputState = 'available';
	} else {
		result.outputState = 'none';
	}
	return result;
}
