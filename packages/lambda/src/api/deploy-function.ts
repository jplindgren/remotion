import type {LogLevel} from '@remotion/renderer';
import {wrapWithErrorHandling} from '@remotion/renderer/error-handling';
import {NoReactInternals} from 'remotion/no-react';
import {VERSION} from 'remotion/version';
import {getFunctions} from '../api/get-functions';
import type {AwsRegion} from '../regions';
import {
	DEFAULT_CLOUDWATCH_RETENTION_PERIOD,
	DEFAULT_EPHEMERAL_STORAGE_IN_MB,
	RENDER_FN_PREFIX,
} from '../shared/constants';
import {FUNCTION_ZIP_ARM64} from '../shared/function-zip-path';
import {getAccountId} from '../shared/get-account-id';
import {
	validateRuntimePreference,
	type RuntimePreference,
} from '../shared/get-layers';
import {LAMBDA_VERSION_STRING} from '../shared/lambda-version-string';
import {validateAwsRegion} from '../shared/validate-aws-region';
import {validateCustomRoleArn} from '../shared/validate-custom-role-arn';
import {validateDiskSizeInMb} from '../shared/validate-disk-size-in-mb';
import {validateMemorySize} from '../shared/validate-memory-size';
import {validateCloudWatchRetentionPeriod} from '../shared/validate-retention-period';
import {validateTimeout} from '../shared/validate-timeout';
import {createFunction} from './create-function';

type MandatoryParameters = {
	createCloudWatchLogGroup: boolean;
	cloudWatchLogRetentionPeriodInDays?: number;
	region: AwsRegion;
	timeoutInSeconds: number;
	memorySizeInMb: number;
};

type OptionalParameters = {
	diskSizeInMb: number;
	customRoleArn: string | undefined;
	enableLambdaInsights: boolean;
	indent: boolean;
	logLevel: LogLevel;
	enableV5Runtime: boolean;
	vpcSubnetIds: string | undefined;
	vpcSecurityGroupIds: string | undefined;
	runtimePreference: RuntimePreference;
};

export type DeployFunctionInput = MandatoryParameters &
	Partial<OptionalParameters>;

export type DeployFunctionOutput = {
	functionName: string;
	alreadyExisted: boolean;
};

export const internalDeployFunction = async (
	params: MandatoryParameters & OptionalParameters,
): Promise<DeployFunctionOutput> => {
	validateMemorySize(params.memorySizeInMb);
	validateTimeout(params.timeoutInSeconds);
	validateAwsRegion(params.region);
	validateCloudWatchRetentionPeriod(params.cloudWatchLogRetentionPeriodInDays);
	validateDiskSizeInMb(params.diskSizeInMb);
	validateCustomRoleArn(params.customRoleArn);
	validateRuntimePreference(params.runtimePreference);

	const fnNameRender = [
		`${RENDER_FN_PREFIX}${LAMBDA_VERSION_STRING}`,
		`mem${params.memorySizeInMb}mb`,
		`disk${params.diskSizeInMb}mb`,
		`${params.timeoutInSeconds}sec`,
	].join('-');
	const accountId = await getAccountId({region: params.region});

	const fns = await getFunctions({
		compatibleOnly: true,
		region: params.region,
	});

	const alreadyDeployed = fns.find(
		(f) =>
			f.version === VERSION &&
			f.memorySizeInMb === params.memorySizeInMb &&
			f.timeoutInSeconds === params.timeoutInSeconds &&
			f.diskSizeInMb === params.diskSizeInMb,
	);

	const created = await createFunction({
		createCloudWatchLogGroup: params.createCloudWatchLogGroup,
		region: params.region,
		zipFile: FUNCTION_ZIP_ARM64,
		functionName: fnNameRender,
		accountId,
		memorySizeInMb: params.memorySizeInMb,
		timeoutInSeconds: params.timeoutInSeconds,
		retentionInDays:
			params.cloudWatchLogRetentionPeriodInDays ??
			DEFAULT_CLOUDWATCH_RETENTION_PERIOD,
		alreadyCreated: Boolean(alreadyDeployed),
		ephemerealStorageInMb: params.diskSizeInMb,
		customRoleArn: params.customRoleArn as string,
		enableLambdaInsights: params.enableLambdaInsights ?? false,
		enableV5Runtime: params.enableV5Runtime,
		logLevel: params.logLevel,
		vpcSubnetIds: params.vpcSubnetIds as string,
		vpcSecurityGroupIds: params.vpcSecurityGroupIds as string,
		runtimePreference: params.runtimePreference,
	});

	if (!created.FunctionName) {
		throw new Error('Lambda was created but has no name');
	}

	return {
		functionName: created.FunctionName,
		alreadyExisted: Boolean(alreadyDeployed),
	};
};

const errorHandled = wrapWithErrorHandling(internalDeployFunction);

/*
 * @description Creates an AWS Lambda function in your account that will be able to render a video in the cloud.
 * @see [Documentation](https://remotion.dev/docs/lambda/deployfunction)
 */
export const deployFunction = ({
	createCloudWatchLogGroup,
	memorySizeInMb,
	region,
	timeoutInSeconds,
	cloudWatchLogRetentionPeriodInDays,
	customRoleArn,
	enableLambdaInsights,
	indent,
	logLevel,
	enableV5Runtime,
	vpcSubnetIds,
	vpcSecurityGroupIds,
	runtimePreference,
	diskSizeInMb,
}: DeployFunctionInput) => {
	return errorHandled({
		indent: indent ?? false,
		logLevel: logLevel ?? 'info',
		createCloudWatchLogGroup,
		customRoleArn: customRoleArn ?? undefined,
		diskSizeInMb: diskSizeInMb ?? DEFAULT_EPHEMERAL_STORAGE_IN_MB,
		enableLambdaInsights: enableLambdaInsights ?? false,
		memorySizeInMb,
		region,
		timeoutInSeconds,
		cloudWatchLogRetentionPeriodInDays,
		enableV5Runtime:
			enableV5Runtime ?? NoReactInternals.ENABLE_V5_BREAKING_CHANGES,
		vpcSubnetIds,
		vpcSecurityGroupIds,
		runtimePreference: runtimePreference ?? 'default',
	});
};
