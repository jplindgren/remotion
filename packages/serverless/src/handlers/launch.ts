/* eslint-disable @typescript-eslint/no-use-before-define */
import type {EmittedArtifact, LogOptions} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';

import {existsSync, mkdirSync, rmSync} from 'fs';
import {type EventEmitter} from 'node:events';
import {join} from 'path';
import {VERSION} from 'remotion/version';
import {
	compressInputProps,
	decompressInputProps,
	getNeedsToUpload,
	serializeOrThrow,
} from '../compress-props';
import type {PostRenderData, ServerlessPayload} from '../constants';
import {
	CONCAT_FOLDER_TOKEN,
	MAX_FUNCTIONS_PER_RENDER,
	ServerlessRoutines,
	artifactName,
} from '../constants';
import {DOCS_URL} from '../docs-url';
import {getExpectedOutName} from '../expected-out-name';
import type {WebhookClient} from '../invoke-webhook';
import {invokeWebhook} from '../invoke-webhook';
import type {OverallProgressHelper} from '../overall-render-progress';
import {makeOverallRenderProgress} from '../overall-render-progress';
import type {
	ProviderSpecifics,
	ServerProviderSpecifics,
} from '../provider-implementation';
import type {RenderMetadata} from '../render-metadata';

import {bestFramesPerFunctionParam} from '../best-frames-per-function-param';
import {cleanupProps} from '../cleanup-props';
import {findOutputFileInBucket} from '../find-output-file-in-bucket';
import {mergeChunksAndFinishRender} from '../merge-chunks';
import {planFrameRanges} from '../plan-frame-ranges';
import {streamRendererFunctionWithRetry} from '../stream-renderer';
import type {CloudProvider} from '../types';
import {
	validateDimension,
	validateDurationInFrames,
	validateFps,
} from '../validate';
import {validateComposition} from '../validate-composition';
import {validateFramesPerFunction} from '../validate-frames-per-function';
import {validateOutname} from '../validate-outname';
import {validatePrivacy} from '../validate-privacy';
import {getTmpDirStateIfENoSp} from '../write-error-to-storage';

type Options = {
	expectedBucketOwner: string;
	getRemainingTimeInMillis: () => number;
};

const innerLaunchHandler = async <Provider extends CloudProvider>({
	functionName,
	params,
	options,
	overallProgress,
	registerCleanupTask,
	providerSpecifics,
	serverProviderSpecifics,
}: {
	functionName: string;
	params: ServerlessPayload<Provider>;
	options: Options;
	overallProgress: OverallProgressHelper<Provider>;
	registerCleanupTask: (cleanupTask: CleanupTask) => void;
	providerSpecifics: ProviderSpecifics<Provider>;
	serverProviderSpecifics: ServerProviderSpecifics;
}): Promise<PostRenderData<Provider>> => {
	if (params.type !== ServerlessRoutines.launch) {
		throw new Error('Expected launch type');
	}

	const startedDate = Date.now();

	const browserInstance = serverProviderSpecifics.getBrowserInstance({
		logLevel: params.logLevel,
		indent: false,
		chromiumOptions: params.chromiumOptions,
		providerSpecifics,
		serverProviderSpecifics,
	});

	const inputPropsPromise = decompressInputProps({
		bucketName: params.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		region: providerSpecifics.getCurrentRegionInFunction(),
		serialized: params.inputProps,
		propsType: 'input-props',
		providerSpecifics,
		forcePathStyle: params.forcePathStyle,
	});

	const logOptions: LogOptions = {
		indent: false,
		logLevel: params.logLevel,
	};
	const serializedInputPropsWithCustomSchema = await inputPropsPromise;

	RenderInternals.Log.info(
		logOptions,
		'Waiting for browser to be ready:',
		serializedInputPropsWithCustomSchema,
	);
	const {instance} = await browserInstance;
	RenderInternals.Log.info(
		logOptions,
		'Validating composition, input props:',
		serializedInputPropsWithCustomSchema,
	);
	const startTime = Date.now();
	const comp = await validateComposition({
		serveUrl: params.serveUrl,
		composition: params.composition,
		browserInstance: instance,
		serializedInputPropsWithCustomSchema,
		envVariables: params.envVariables ?? {},
		timeoutInMilliseconds: params.timeoutInMilliseconds,
		chromiumOptions: params.chromiumOptions,
		port: null,
		forceHeight: params.forceHeight,
		forceWidth: params.forceWidth,
		logLevel: params.logLevel,
		server: undefined,
		offthreadVideoCacheSizeInBytes: params.offthreadVideoCacheSizeInBytes,
		onBrowserDownload: () => {
			throw new Error('Should not download a browser in Lambda');
		},
		onServeUrlVisited: () => {
			overallProgress.setServeUrlOpened(Date.now());
		},
		providerSpecifics,
	});
	overallProgress.setCompositionValidated(Date.now());
	RenderInternals.Log.info(
		logOptions,
		'Composition validated, resolved props',
		comp.props,
	);

	validateDurationInFrames(comp.durationInFrames, {
		component: 'passed to a Lambda render',
		allowFloats: false,
	});
	validateFps(comp.fps, 'passed to a Lambda render', false);
	validateDimension(comp.height, 'height', 'passed to a Lambda render');
	validateDimension(comp.width, 'width', 'passed to a Lambda render');

	RenderInternals.validateBitrate(params.audioBitrate, 'audioBitrate');
	RenderInternals.validateBitrate(params.videoBitrate, 'videoBitrate');

	RenderInternals.validateConcurrency({
		value: params.concurrencyPerFunction,
		setting: 'concurrencyPerLambda',
		checkIfValidForCurrentMachine:
			(params.rendererFunctionName ?? null) === null,
	});

	const realFrameRange = RenderInternals.getRealFrameRange(
		comp.durationInFrames,
		params.frameRange,
	);

	const frameCount = RenderInternals.getFramesToRender(
		realFrameRange,
		params.everyNthFrame,
	);

	const framesPerLambda =
		params.framesPerFunction ?? bestFramesPerFunctionParam(frameCount.length);

	validateFramesPerFunction({
		framesPerLambda,
		durationInFrames: frameCount.length,
	});

	validateOutname({
		outName: params.outName,
		codec: params.codec,
		audioCodecSetting: params.audioCodec,
		separateAudioTo: null,
	});
	validatePrivacy(params.privacy, true);
	RenderInternals.validatePuppeteerTimeout(params.timeoutInMilliseconds);

	const {chunks} = planFrameRanges({
		framesPerFunction: framesPerLambda,
		frameRange: realFrameRange,
		everyNthFrame: params.everyNthFrame,
	});

	if (chunks.length > MAX_FUNCTIONS_PER_RENDER) {
		throw new Error(
			`Too many functions: This render would cause ${chunks.length} functions to spawn. We limit this amount to ${MAX_FUNCTIONS_PER_RENDER} functions as more would result in diminishing returns. Values set: frameCount = ${frameCount.length}, framesPerLambda=${framesPerLambda}. See ${DOCS_URL}/docs/lambda/concurrency#too-many-functions for help.`,
		);
	}

	overallProgress.setExpectedChunks(chunks.length);

	const sortedChunks = chunks.slice().sort((a, b) => a[0] - b[0]);

	const serializedResolved = serializeOrThrow(comp.props, 'resolved-props');

	const needsToUpload = getNeedsToUpload({
		type: 'video-or-audio',
		sizes: [
			serializedResolved.length,
			params.inputProps.type === 'bucket-url'
				? params.inputProps.hash.length
				: params.inputProps.payload.length,
			JSON.stringify(params.envVariables).length,
		],
		providerSpecifics,
	});

	const serializedResolvedProps = await compressInputProps({
		propsType: 'resolved-props',
		region: providerSpecifics.getCurrentRegionInFunction(),
		stringifiedInputProps: serializedResolved,
		userSpecifiedBucketName: params.bucketName,
		needsToUpload,
		providerSpecifics,
		forcePathStyle: params.forcePathStyle,
		skipPutAcl: false,
	});

	registerCleanupTask(() => {
		return cleanupProps({
			serializedResolvedProps,
			inputProps: params.inputProps,
			providerSpecifics,
			forcePathStyle: params.forcePathStyle,
		});
	});

	const fps = comp.fps / params.everyNthFrame;

	// If for 150 functions, we stream every frame, we DDos ourselves.
	// Throttling a bit, allowing more progress if there is lower concurrency.
	const progressEveryNthFrame = Math.ceil(chunks.length / 15);

	const lambdaPayloads = chunks.map((chunkPayload) => {
		const payload: ServerlessPayload<Provider> = {
			type: ServerlessRoutines.renderer,
			frameRange: chunkPayload,
			serveUrl: params.serveUrl,
			chunk: sortedChunks.indexOf(chunkPayload),
			composition: params.composition,
			fps: comp.fps,
			height: comp.height,
			width: comp.width,
			durationInFrames: comp.durationInFrames,
			bucketName: params.bucketName,
			retriesLeft: params.maxRetries,
			inputProps: params.inputProps,
			renderId: params.renderId,
			imageFormat: params.imageFormat,
			codec: params.codec,
			crf: params.crf,
			envVariables: params.envVariables,
			pixelFormat: params.pixelFormat,
			proResProfile: params.proResProfile,
			x264Preset: params.x264Preset,
			jpegQuality: params.jpegQuality,
			privacy: params.privacy,
			logLevel: params.logLevel ?? 'info',
			attempt: 1,
			timeoutInMilliseconds: params.timeoutInMilliseconds,
			chromiumOptions: params.chromiumOptions,
			scale: params.scale,
			everyNthFrame: params.everyNthFrame,
			concurrencyPerLambda: params.concurrencyPerFunction,
			muted: params.muted,
			audioBitrate: params.audioBitrate,
			videoBitrate: params.videoBitrate,
			encodingMaxRate: params.encodingMaxRate,
			encodingBufferSize: params.encodingBufferSize,
			launchFunctionConfig: {
				version: VERSION,
			},
			resolvedProps: serializedResolvedProps,
			offthreadVideoCacheSizeInBytes: params.offthreadVideoCacheSizeInBytes,
			deleteAfter: params.deleteAfter,
			colorSpace: params.colorSpace,
			preferLossless: params.preferLossless,
			compositionStart: realFrameRange[0],
			framesPerLambda,
			progressEveryNthFrame,
			forcePathStyle: params.forcePathStyle,
			metadata: params.metadata,
		};
		return payload;
	});

	RenderInternals.Log.info(
		logOptions,
		'Render plan: ',
		chunks.map((c, i) => `Chunk ${i} (Frames ${c[0]} - ${c[1]})`).join(', '),
	);

	const renderMetadata: RenderMetadata<Provider> = {
		startedDate,
		totalChunks: chunks.length,
		estimatedTotalLambdaInvokations: [
			// Direct invokations
			chunks.length,
			// This function
			1,
		].reduce((a, b) => a + b, 0),
		estimatedRenderLambdaInvokations: chunks.length,
		compositionId: comp.id,
		siteId: params.serveUrl,
		codec: params.codec,
		type: 'video',
		imageFormat: params.imageFormat,
		inputProps: params.inputProps,
		lambdaVersion: VERSION,
		framesPerLambda,
		memorySizeInMb: Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE),
		region: providerSpecifics.getCurrentRegionInFunction(),
		renderId: params.renderId,
		outName: params.outName ?? undefined,
		privacy: params.privacy,
		everyNthFrame: params.everyNthFrame,
		frameRange: realFrameRange,
		audioCodec: params.audioCodec,
		deleteAfter: params.deleteAfter,
		numberOfGifLoops: params.numberOfGifLoops,
		downloadBehavior: params.downloadBehavior,
		audioBitrate: params.audioBitrate,
		muted: params.muted,
		metadata: params.metadata,
		functionName: process.env.AWS_LAMBDA_FUNCTION_NAME as string,
		dimensions: {
			width: comp.width * (params.scale ?? 1),
			height: comp.height * (params.scale ?? 1),
		},
	};

	const {key, renderBucketName, customCredentials} = getExpectedOutName(
		renderMetadata,
		params.bucketName,
		typeof params.outName === 'string' || typeof params.outName === 'undefined'
			? null
			: (params.outName?.s3OutputProvider ?? null),
	);

	if (!params.overwrite) {
		const findOutputFile = serverProviderSpecifics.timer(
			'Checking if output file already exists',
			params.logLevel,
		);
		const output = await findOutputFileInBucket({
			bucketName: params.bucketName,
			customCredentials,
			renderMetadata,
			region: providerSpecifics.getCurrentRegionInFunction(),
			currentRegion: providerSpecifics.getCurrentRegionInFunction(),
			providerSpecifics,
			forcePathStyle: params.forcePathStyle,
		});
		if (output) {
			throw new TypeError(
				`Output file "${key}" in bucket "${renderBucketName}" in region "${providerSpecifics.getCurrentRegionInFunction()}" already exists. Delete it before re-rendering, or set the 'overwrite' option in renderMediaOnLambda() to overwrite it."`,
			);
		}

		findOutputFile.end();
	}

	overallProgress.setRenderMetadata(renderMetadata);

	const outdir = join(RenderInternals.tmpDir(CONCAT_FOLDER_TOKEN), 'bucket');
	if (existsSync(outdir)) {
		rmSync(outdir, {
			recursive: true,
		});
	}

	mkdirSync(outdir);

	const files: string[] = [];

	const onArtifact = (artifact: EmittedArtifact): {alreadyExisted: boolean} => {
		if (
			overallProgress
				.getReceivedArtifacts()
				.find((a) => a.filename === artifact.filename)
		) {
			return {alreadyExisted: true};
		}

		const region = providerSpecifics.getCurrentRegionInFunction();
		const storageKey = artifactName(renderMetadata.renderId, artifact.filename);

		const start = Date.now();
		RenderInternals.Log.info(
			{indent: false, logLevel: params.logLevel},
			'Writing artifact ' + artifact.filename + ' to S3',
		);
		providerSpecifics
			.writeFile({
				bucketName: renderBucketName,
				key: storageKey,
				body: artifact.content,
				region,
				privacy: params.privacy,
				expectedBucketOwner: options.expectedBucketOwner,
				downloadBehavior: params.downloadBehavior,
				customCredentials,
				forcePathStyle: params.forcePathStyle,
			})
			.then(() => {
				RenderInternals.Log.info(
					{indent: false, logLevel: params.logLevel},
					`Wrote artifact to S3 in ${Date.now() - start}ms`,
				);

				overallProgress.addReceivedArtifact(
					providerSpecifics.makeArtifactWithDetails({
						region,
						renderBucketName,
						storageKey,
						artifact,
					}),
				);
			})
			.catch((err) => {
				overallProgress.addErrorWithoutUpload({
					type: 'artifact',
					message: (err as Error).message,
					name: (err as Error).name as string,
					stack: (err as Error).stack as string,
					tmpDir: null,
					frame: artifact.frame,
					chunk: null,
					isFatal: false,
					attempt: 1,
					willRetry: false,
					totalAttempts: 1,
				});
				overallProgress.upload();
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					'Failed to write artifact to S3',
					err,
				);
			});
		return {alreadyExisted: false};
	};

	await Promise.all(
		lambdaPayloads.map(async (payload) => {
			await streamRendererFunctionWithRetry({
				files,
				functionName,
				outdir,
				overallProgress,
				payload,
				logLevel: params.logLevel,
				onArtifact,
				providerSpecifics,
			});
		}),
	);

	const postRenderData = await mergeChunksAndFinishRender({
		bucketName: params.bucketName,
		renderId: params.renderId,
		expectedBucketOwner: options.expectedBucketOwner,
		numberOfFrames: frameCount.length,
		audioCodec: params.audioCodec,
		chunkCount: chunks.length,
		codec: params.codec,
		customCredentials,
		downloadBehavior: params.downloadBehavior,
		fps,
		key,
		numberOfGifLoops: params.numberOfGifLoops,
		privacy: params.privacy,
		renderBucketName,
		inputProps: params.inputProps,
		serializedResolvedProps,
		renderMetadata,
		audioBitrate: params.audioBitrate,
		logLevel: params.logLevel,
		framesPerLambda,
		binariesDirectory: null,
		preferLossless: params.preferLossless,
		compositionStart: realFrameRange[0],
		outdir,
		files: files.sort(),
		overallProgress,
		startTime,
		providerSpecifics,
		forcePathStyle: params.forcePathStyle,
		serverProviderSpecifics,
	});

	return postRenderData;
};

type CleanupTask = () => Promise<unknown>;

export const launchHandler = async <Provider extends CloudProvider>({
	params,
	options,
	providerSpecifics,
	client,
	serverProviderSpecifics,
}: {
	params: ServerlessPayload<Provider>;
	options: Options;
	providerSpecifics: ProviderSpecifics<Provider>;
	serverProviderSpecifics: ServerProviderSpecifics;
	client: WebhookClient;
}): Promise<{
	type: 'success';
}> => {
	if (params.type !== ServerlessRoutines.launch) {
		throw new Error('Expected launch type');
	}

	const functionName =
		params.rendererFunctionName ??
		(process.env.AWS_LAMBDA_FUNCTION_NAME as string);

	const logOptions: LogOptions = {
		indent: false,
		logLevel: params.logLevel,
	};

	const cleanupTasks: CleanupTask[] = [];

	const registerCleanupTask = (task: CleanupTask) => {
		cleanupTasks.push(task);
	};

	const runCleanupTasks = () => {
		const prom = Promise.all(cleanupTasks)
			.then(() => {
				RenderInternals.Log.info(
					{indent: false, logLevel: params.logLevel},
					'Ran cleanup tasks',
				);
			})
			.catch((err) => {
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					'Failed to run cleanup tasks:',
					err,
				);
			});

		cleanupTasks.length = 0;
		return prom;
	};

	const onTimeout = async () => {
		RenderInternals.Log.error(
			{indent: false, logLevel: params.logLevel},
			'Function is about to time out. Can not finish render.',
		);

		// @ts-expect-error - We are adding a listener to a global variable
		if (globalThis._dumpUnreleasedBuffers) {
			// @ts-expect-error - We are adding a listener to a global variable
			(globalThis._dumpUnreleasedBuffers as EventEmitter).emit(
				'dump-unreleased-buffers',
			);
		}

		runCleanupTasks();

		if (!params.webhook) {
			RenderInternals.Log.verbose(
				{
					indent: false,
					logLevel: params.logLevel,
				},
				'No webhook specified.',
			);
			return;
		}

		if (webhookInvoked) {
			RenderInternals.Log.verbose(
				{
					indent: false,
					logLevel: params.logLevel,
				},
				'Webhook already invoked. Not invoking again.',
			);
			return;
		}

		try {
			await invokeWebhook(
				{
					url: params.webhook.url,
					secret: params.webhook.secret,
					payload: {
						type: 'timeout',
						renderId: params.renderId,
						expectedBucketOwner: options.expectedBucketOwner,
						bucketName: params.bucketName,
						customData: params.webhook.customData ?? null,
					},
					redirectsSoFar: 0,
					client,
				},
				params.logLevel,
			);
			RenderInternals.Log.verbose(
				{
					indent: false,
					logLevel: params.logLevel,
				},
				'Successfully invoked timeout webhook.',
				params.webhook.url,
			);
			webhookInvoked = true;
		} catch (err) {
			if (process.env.NODE_ENV === 'test') {
				throw err;
			}

			RenderInternals.Log.error(
				{indent: false, logLevel: params.logLevel},
				'Failed to invoke webhook:',
			);
			RenderInternals.Log.error(
				{indent: false, logLevel: params.logLevel},
				err,
			);

			overallProgress.addErrorWithoutUpload({
				type: 'webhook',
				message: (err as Error).message,
				name: (err as Error).name as string,
				stack: (err as Error).stack as string,
				tmpDir: null,
				frame: 0,
				chunk: 0,
				isFatal: false,
				attempt: 1,
				willRetry: false,
				totalAttempts: 1,
			});
			overallProgress.upload();
		}
	};

	let webhookInvoked = false;
	const webhookDueToTimeout = setTimeout(
		onTimeout,
		Math.max(options.getRemainingTimeInMillis() - 1000, 1000),
	);

	RenderInternals.Log.info(
		logOptions,
		`Function has ${Math.max(
			options.getRemainingTimeInMillis() - 1000,
			1000,
		)} before it times out`,
	);

	const overallProgress = makeOverallRenderProgress({
		renderId: params.renderId,
		bucketName: params.bucketName,
		expectedBucketOwner: options.expectedBucketOwner,
		region: providerSpecifics.getCurrentRegionInFunction(),
		timeoutTimestamp: options.getRemainingTimeInMillis() + Date.now(),
		logLevel: params.logLevel,
		providerSpecifics,
		forcePathStyle: params.forcePathStyle,
	});

	try {
		const postRenderData = await innerLaunchHandler({
			functionName,
			params,
			options,
			overallProgress,
			registerCleanupTask,
			providerSpecifics,
			serverProviderSpecifics,
		});
		clearTimeout(webhookDueToTimeout);

		if (!params.webhook || webhookInvoked) {
			return {
				type: 'success',
			};
		}

		try {
			await invokeWebhook(
				{
					url: params.webhook.url,
					secret: params.webhook.secret,
					payload: {
						type: 'success',
						renderId: params.renderId,
						expectedBucketOwner: options.expectedBucketOwner,
						bucketName: params.bucketName,
						customData: params.webhook.customData ?? null,
						outputUrl: postRenderData.outputFile,
						lambdaErrors: postRenderData.errors,
						outputFile: postRenderData.outputFile,
						timeToFinish: postRenderData.timeToFinish,
						costs: postRenderData.cost,
					},
					redirectsSoFar: 0,
					client,
				},
				params.logLevel,
			);
			webhookInvoked = true;
		} catch (err) {
			if (process.env.NODE_ENV === 'test') {
				throw err;
			}

			overallProgress.addErrorWithoutUpload({
				type: 'webhook',
				message: (err as Error).message,
				name: (err as Error).name as string,
				stack: (err as Error).stack as string,
				tmpDir: null,
				frame: 0,
				chunk: 0,
				isFatal: false,
				attempt: 1,
				willRetry: false,
				totalAttempts: 1,
			});
			overallProgress.upload();

			RenderInternals.Log.error(
				{indent: false, logLevel: params.logLevel},
				'Failed to invoke webhook:',
			);
			RenderInternals.Log.error(
				{indent: false, logLevel: params.logLevel},
				err,
			);
		}

		runCleanupTasks();

		return {
			type: 'success',
		};
	} catch (err) {
		if (process.env.NODE_ENV === 'test') {
			throw err;
		}

		RenderInternals.Log.error(
			{indent: false, logLevel: params.logLevel},
			'Error occurred',
			err,
		);
		overallProgress.addErrorWithoutUpload({
			chunk: null,
			frame: null,
			name: (err as Error).name as string,
			stack: (err as Error).stack as string,
			type: 'stitcher',
			isFatal: true,
			tmpDir: getTmpDirStateIfENoSp(
				(err as Error).stack as string,
				providerSpecifics,
			),
			attempt: 1,
			totalAttempts: 1,
			willRetry: false,
			message: (err as Error).message,
		});
		await overallProgress.upload();

		runCleanupTasks();

		RenderInternals.Log.error(
			{indent: false, logLevel: params.logLevel},
			'Wrote error to S3',
		);
		clearTimeout(webhookDueToTimeout);

		if (params.webhook && !webhookInvoked) {
			try {
				await invokeWebhook(
					{
						url: params.webhook.url,
						secret: params.webhook.secret,
						payload: {
							type: 'error',
							renderId: params.renderId,
							expectedBucketOwner: options.expectedBucketOwner,
							bucketName: params.bucketName,
							customData: params.webhook.customData ?? null,
							errors: [err as Error].map((e) => ({
								message: e.message,
								name: e.name as string,
								stack: e.stack as string,
							})),
						},
						redirectsSoFar: 0,
						client,
					},
					params.logLevel,
				);
				webhookInvoked = true;
			} catch (error) {
				if (process.env.NODE_ENV === 'test') {
					throw error;
				}

				overallProgress.addErrorWithoutUpload({
					type: 'webhook',
					message: (err as Error).message,
					name: (err as Error).name as string,
					stack: (err as Error).stack as string,
					tmpDir: null,
					frame: 0,
					chunk: 0,
					isFatal: false,
					attempt: 1,
					willRetry: false,
					totalAttempts: 1,
				});
				overallProgress.upload();

				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					'Failed to invoke webhook:',
				);
				RenderInternals.Log.error(
					{indent: false, logLevel: params.logLevel},
					error,
				);
			}
		}

		throw err;
	} finally {
		serverProviderSpecifics.forgetBrowserEventLoop(params.logLevel);
	}
};
