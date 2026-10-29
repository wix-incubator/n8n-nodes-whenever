import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { arrayOf, callTool, objectValue } from './mcp';

const RUN_STATUSES = ['running', 'succeeded', 'failed', 'timed_out', 'cancelled'];
const FAILURE_FIELDS = ['message', 'kind', 'code', 'detail', 'operation'];
const OMISSION_REASONS = ['too_large', 'unserializable'];

type Run = {
	runId: string;
	workflowId: string;
	version: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	failure?: IDataObject;
};

type RunPage = {
	run: Run;
	events: IDataObject[];
	nextSeq: number;
	truncated: boolean;
	observationComplete?: boolean;
};

function sequence(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFailure(value: unknown): value is IDataObject {
	return (
		objectValue(value) &&
		FAILURE_FIELDS.every((key) => value[key] === undefined || typeof value[key] === 'string')
	);
}

function isRun(value: unknown, runId: string): value is Run {
	return (
		objectValue(value) &&
		value.runId === runId &&
		typeof value.workflowId === 'string' &&
		typeof value.version === 'string' &&
		typeof value.status === 'string' &&
		RUN_STATUSES.includes(value.status) &&
		sequence(value.startedAt) &&
		(value.endedAt === undefined || sequence(value.endedAt)) &&
		(value.failure === undefined || isFailure(value.failure))
	);
}

function readPage(
	data: IDataObject,
	runId: string,
	afterSeq: number,
	limit: number,
): RunPage | undefined {
	const { run, nextSeq, truncated, observationComplete } = data;
	if (
		!isRun(run, runId) ||
		!sequence(nextSeq) ||
		nextSeq < afterSeq ||
		typeof truncated !== 'boolean' ||
		(truncated && nextSeq === afterSeq) ||
		(observationComplete !== undefined && typeof observationComplete !== 'boolean')
	) {
		return undefined;
	}

	const pageEvent = (event: unknown): event is IDataObject =>
		objectValue(event) &&
		event.runId === runId &&
		sequence(event.seq) &&
		(event.seq > afterSeq || (afterSeq === 0 && event.seq === 0)) &&
		event.seq <= nextSeq &&
		typeof event.type === 'string';
	const events = arrayOf(data.events, pageEvent);
	if (!events || events.length > limit) return undefined;

	return { run, events, nextSeq, truncated, observationComplete };
}

function outputOf(success: IDataObject | undefined): IDataObject | undefined {
	if (success === undefined) return { outputState: 'not_observed' };

	const { outputOmitted, outputJson } = success;
	if (outputOmitted !== undefined) {
		if (
			outputJson !== undefined ||
			typeof outputOmitted !== 'string' ||
			!OMISSION_REASONS.includes(outputOmitted)
		) {
			return undefined;
		}
		return { outputState: 'omitted', outputOmitted };
	}
	if (outputJson === undefined) return { outputState: 'none' };
	if (typeof outputJson !== 'string' || outputJson.length > 20000) return undefined;

	try {
		return { outputState: 'available', output: JSON.parse(outputJson) };
	} catch {
		return undefined;
	}
}

function knownFailureFields(failure: IDataObject): IDataObject {
	return Object.fromEntries(
		FAILURE_FIELDS.filter((key) => failure[key] !== undefined).map((key) => [key, failure[key]]),
	);
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

	const requestLimit = afterSeq === 0 ? Math.max(2, limit) : limit;
	const data = await callTool(
		context,
		'get_run',
		{ run_id: runId, after_seq: afterSeq, limit: requestLimit },
		itemIndex,
	);
	const page = readPage(data, runId, afterSeq, requestLimit);
	const successes = page?.events.filter((event) => event.type === 'run_succeeded') ?? [];
	const output = successes.length > 1 ? undefined : outputOf(successes[0]);
	if (!page || !output) {
		throw new NodeOperationError(context.getNode(), 'Whenever returned invalid run evidence.', {
			itemIndex,
		});
	}

	const { run, nextSeq, truncated, observationComplete } = page;
	return {
		runId,
		workflowId: run.workflowId,
		version: run.version,
		status: run.status,
		startedAt: run.startedAt,
		...(run.endedAt !== undefined && { endedAt: run.endedAt }),
		...(run.failure !== undefined && { failure: knownFailureFields(run.failure) }),
		nextSeq,
		hasMoreEvents: truncated,
		...(observationComplete !== undefined && { observationComplete }),
		...output,
	};
}
