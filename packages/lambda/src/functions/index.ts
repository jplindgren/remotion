import {RenderInternals} from '@remotion/renderer';
import type {LambdaPayload} from '../shared/constants';
import {COMMAND_NOT_FOUND, LambdaRoutines} from '../shared/constants';
import type {OrError} from '../shared/return-values';
import {compositionsHandler} from './compositions';
import {deleteTmpDir} from './helpers/clean-tmpdir';
import {getWarm, setWarm} from './helpers/is-warm';
import {setCurrentRequestId, stopLeakDetection} from './helpers/leak-detection';
import {
	generateRandomHashWithLifeCycleRule,
	validateDeleteAfter,
} from './helpers/lifecycle';
import {printCloudwatchHelper} from './helpers/print-cloudwatch-helper';
import type {RequestContext} from './helpers/request-context';
import type {ResponseStream} from './helpers/streamify-response';
import {streamifyResponse} from './helpers/streamify-response';
import {infoHandler} from './info';
import {launchHandler} from './launch';
import {progressHandler} from './progress';
import {rendererHandler} from './renderer';
import {startHandler} from './start';
import {stillHandler} from './still';
import {
	streamWriter,
	type ResponseStreamWriter,
} from './streaming/stream-writer';
import type {OnStream} from './streaming/streaming';
import {makePayloadMessage} from './streaming/streaming';

const innerHandler = async ({
	params,
	responseWriter,
	context,
	onStream,
}: {
	params: LambdaPayload;
	responseWriter: ResponseStreamWriter;
	onStream: OnStream;
	context: RequestContext;
}): Promise<void> => {
	setCurrentRequestId(context.awsRequestId);
	process.env.__RESERVED_IS_INSIDE_REMOTION_LAMBDA = 'true';
	const timeoutInMilliseconds = context.getRemainingTimeInMillis();

	RenderInternals.Log.verbose(
		{indent: false, logLevel: params.logLevel},
		'AWS Request ID:',
		context.awsRequestId,
	);
	stopLeakDetection();
	if (!context?.invokedFunctionArn) {
		throw new Error(
			'Lambda function unexpectedly does not have context.invokedFunctionArn',
		);
	}

	deleteTmpDir();
	const isWarm = getWarm();
	setWarm();

	const currentUserId = context.invokedFunctionArn.split(':')[4];
	if (params.type === LambdaRoutines.still) {
		validateDeleteAfter(params.deleteAfter);
		const renderId = generateRandomHashWithLifeCycleRule(params.deleteAfter);
		printCloudwatchHelper(
			LambdaRoutines.still,
			{
				renderId,
				inputProps: JSON.stringify(params.inputProps),
				isWarm,
			},
			params.logLevel,
		);

		await onStream({
			type: 'render-id-determined',
			payload: {renderId},
		});

		await stillHandler({
			expectedBucketOwner: currentUserId,
			params,
			renderId,
			onStream,
		});

		return;
	}

	if (params.type === LambdaRoutines.start) {
		printCloudwatchHelper(
			LambdaRoutines.start,
			{
				inputProps: JSON.stringify(params.inputProps),
				isWarm,
			},
			params.logLevel,
		);

		const response = await startHandler(params, {
			expectedBucketOwner: currentUserId,
		});

		await responseWriter.write(Buffer.from(JSON.stringify(response)));
		return;
	}

	if (params.type === LambdaRoutines.launch) {
		printCloudwatchHelper(
			LambdaRoutines.launch,
			{
				renderId: params.renderId,
				inputProps: JSON.stringify(params.inputProps),
				isWarm,
			},
			params.logLevel,
		);

		const response = await launchHandler(params, {
			expectedBucketOwner: currentUserId,
			getRemainingTimeInMillis: context.getRemainingTimeInMillis,
		});

		await responseWriter.write(Buffer.from(JSON.stringify(response)));
		return;
	}

	if (params.type === LambdaRoutines.status) {
		printCloudwatchHelper(
			LambdaRoutines.status,
			{
				renderId: params.renderId,
				isWarm,
			},
			params.logLevel,
		);
		const response = await progressHandler(params, {
			expectedBucketOwner: currentUserId,
			timeoutInMilliseconds,
			retriesRemaining: 2,
		});

		await responseWriter.write(Buffer.from(JSON.stringify(response)));
		return;
	}

	if (params.type === LambdaRoutines.renderer) {
		printCloudwatchHelper(
			LambdaRoutines.renderer,
			{
				renderId: params.renderId,
				chunk: String(params.chunk),
				dumpLogs: String(
					RenderInternals.isEqualOrBelowLogLevel(params.logLevel, 'verbose'),
				),
				resolvedProps: JSON.stringify(params.resolvedProps),
				isWarm,
			},
			params.logLevel,
		);

		await rendererHandler(
			params,
			{
				expectedBucketOwner: currentUserId,
				isWarm,
			},
			(payload) => {
				const message = makePayloadMessage({
					message: payload,
					status: 0,
				});
				responseWriter.write(message);
				// TODO: Error handling?
			},
			context,
		);

		return;
	}

	if (params.type === LambdaRoutines.info) {
		printCloudwatchHelper(
			LambdaRoutines.info,
			{
				isWarm,
			},
			params.logLevel,
		);

		const response = await infoHandler(params);
		responseWriter.write(Buffer.from(JSON.stringify(response)));
		return;
	}

	if (params.type === LambdaRoutines.compositions) {
		printCloudwatchHelper(
			LambdaRoutines.compositions,
			{
				isWarm,
			},
			params.logLevel,
		);

		const response = await compositionsHandler(params, {
			expectedBucketOwner: currentUserId,
		});

		responseWriter.write(Buffer.from(JSON.stringify(response)));
		return;
	}

	throw new Error(COMMAND_NOT_FOUND);
};

const routine = async (
	params: LambdaPayload,
	responseStream: ResponseStream,
	context: RequestContext,
	onStream: OnStream,
): Promise<void> => {
	const responseWriter = streamWriter(responseStream);

	try {
		await innerHandler({
			params,
			responseWriter,
			context,
			onStream,
		});
	} catch (err) {
		const res: OrError<0> = {
			type: 'error',
			message: (err as Error).message,
			stack: (err as Error).stack as string,
		};

		await responseWriter.write(Buffer.from(JSON.stringify(res)));
	}
};

export const handler = streamifyResponse(routine);
